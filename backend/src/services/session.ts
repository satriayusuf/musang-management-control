// Agent registration, re-attach, and session / VM-replacement transitions
// (CONTRACT.md — "Session / VM replacement logic").
//
// Rules implemented here:
// - Same boot_id as the current session  -> same session (network blip).
// - Different boot_id                     -> close current session at takeover
//   time (now, never the new VM's boot_time), open a new session, and record
//   VM_REPLACED — or REBOOT when the previous session signalled a clean
//   shutdown (AGENT_SHUTDOWN event). replacement_count increments only for
//   VM_REPLACED; session_no always increments.
// - One agent, one identity: re-attach never creates a second agent row.

import type { Agent, PrismaClient, Session } from '@prisma/client';
import { generateAgentToken, isPairingCodeExpired, newId, sha256Hex } from '../lib/crypto';
import { createEvent } from './events';
import { issueRuntimeToken } from './runtime';
import { broadcast } from './ws';

export type BootTransition = 'SAME_BOOT' | 'VM_REPLACED' | 'REBOOT';

/** Pure transition decision (unit-tested). */
export function decideBootTransition(
  currentBootId: string | null | undefined,
  newBootId: string,
  hadCleanShutdown: boolean,
): BootTransition {
  if (currentBootId && currentBootId === newBootId) return 'SAME_BOOT';
  if (!currentBootId) return 'VM_REPLACED'; // no prior session: first attach after pairing handled elsewhere
  return hadCleanShutdown ? 'REBOOT' : 'VM_REPLACED';
}

export interface RegisterBody {
  pairing_code?: string;
  agent_id?: string;
  name?: string;
  worker_name?: string;
  boot_id: string;
  boot_time?: string;
  bridge_version?: string;
  capabilities?: string[];
}

export interface RegisterResult {
  agent: Agent;
  session: Session;
  /** Raw agent token — present ONLY on first registration via pairing code. */
  agentToken?: string;
  /** Raw runtime token (CONTRACT-7) — issued/rotated on EVERY registration. */
  runtimeToken: string;
  isNewAgent: boolean;
  transition: BootTransition | 'FIRST';
}

export async function ensureWorker(
  prisma: PrismaClient,
  agent: Agent,
  workerName: string | null | undefined,
): Promise<void> {
  if (!workerName) return;
  const existing = await prisma.worker.findUnique({ where: { name: workerName } });
  if (existing && existing.agentId !== agent.id) {
    // Worker names are the stable secondary key; never silently merge two
    // agents. The dashboard offers a manual re-link instead (spec S§3).
    throw Object.assign(new Error('WORKER_NAME_TAKEN'), { statusCode: 409 });
  }
  if (!existing) {
    await prisma.worker.create({
      data: { id: newId('wrk'), agentId: agent.id, name: workerName },
    });
  }
  if (agent.workerName !== workerName) {
    await prisma.agent.update({ where: { id: agent.id }, data: { workerName } });
  }
}

/** First registration using a one-time pairing code. */
export async function registerWithPairing(
  prisma: PrismaClient,
  body: RegisterBody,
): Promise<RegisterResult> {
  const codeHash = sha256Hex(body.pairing_code as string);
  const pairing = await prisma.pairingCode.findUnique({ where: { codeHash } });
  if (!pairing || isPairingCodeExpired(pairing.expiresAt, pairing.usedAt)) {
    throw Object.assign(new Error('PAIRING_CODE_INVALID'), { statusCode: 401 });
  }

  const rawToken = generateAgentToken();
  const now = new Date();
  const agent = await prisma.agent.create({
    data: {
      id: newId('agt'),
      name: body.name ?? pairing.plannedName,
      tokenHash: sha256Hex(rawToken),
      workerName: body.worker_name ?? null,
      capabilities: body.capabilities ?? [],
      bridgeVersion: body.bridge_version ?? null,
      status: 'ONLINE',
      lastSeenAt: now,
    },
  });
  const session = await prisma.session.create({
    data: {
      id: newId('ses'),
      agentId: agent.id,
      bootId: body.boot_id,
      bootTime: body.boot_time ? new Date(body.boot_time) : null,
      sessionNo: 1,
    },
  });
  const updated = await prisma.agent.update({
    where: { id: agent.id },
    data: { currentSessionId: session.id },
  });
  await prisma.pairingCode.update({
    where: { id: pairing.id },
    data: { usedAt: now, usedByAgentId: agent.id },
  });
  await ensureWorker(prisma, updated, body.worker_name);
  const runtimeToken = await issueRuntimeToken(prisma, agent.id);

  await createEvent(prisma, {
    agentId: agent.id,
    type: 'AGENT_REGISTERED',
    description: `Agent ${updated.name} terdaftar melalui kode pairing`,
    metadata: { session_id: session.id, session_no: 1 },
  });
  broadcast('agent.registered', { agent_id: agent.id, session_id: session.id });
  broadcast('session.started', { agent_id: agent.id, session_id: session.id, session_no: 1 });

  return { agent: updated, session, agentToken: rawToken, runtimeToken, isNewAgent: true, transition: 'FIRST' };
}

/** Re-attach of an already-registered agent (token already verified by caller). */
export async function reattachAgent(
  prisma: PrismaClient,
  agent: Agent,
  body: RegisterBody,
): Promise<RegisterResult> {
  const now = new Date();
  // CONTRACT-7: every registration rotates the runtime token; the bridge
  // persists the fresh one from this response.
  const runtimeToken = await issueRuntimeToken(prisma, agent.id);
  const wasUnreachable = agent.status !== 'ONLINE';
  const currentSession = agent.currentSessionId
    ? await prisma.session.findUnique({ where: { id: agent.currentSessionId } })
    : null;

  // Did the previous session signal a clean shutdown?
  let hadCleanShutdown = false;
  if (currentSession) {
    const shutdown = await prisma.event.findFirst({
      where: {
        agentId: agent.id,
        type: 'AGENT_SHUTDOWN',
        createdAt: { gte: currentSession.startedAt },
      },
      orderBy: { createdAt: 'desc' },
    });
    hadCleanShutdown = Boolean(
      shutdown && (!shutdown.metadata || (shutdown.metadata as Record<string, unknown>).session_id === currentSession.id || !(shutdown.metadata as Record<string, unknown>).session_id),
    );
  }

  const transition = decideBootTransition(currentSession?.bootId, body.boot_id, hadCleanShutdown);

  const baseUpdate = {
    bridgeVersion: body.bridge_version ?? agent.bridgeVersion,
    capabilities: body.capabilities ?? agent.capabilities,
    workerName: body.worker_name ?? agent.workerName,
    status: 'ONLINE',
    lastSeenAt: now,
    revokedAt: agent.revokedAt, // unchanged; token auth already rejected revoked agents
  };

  if (transition === 'SAME_BOOT' && currentSession) {
    const updated = await prisma.agent.update({ where: { id: agent.id }, data: baseUpdate });
    await ensureWorker(prisma, updated, body.worker_name ?? agent.workerName);
    if (wasUnreachable) {
      await createEvent(prisma, {
        agentId: agent.id,
        type: 'AGENT_RECONNECTED',
        description: `Agent ${agent.name} terhubung kembali (boot sama)`,
        metadata: { session_id: currentSession.id },
      });
      broadcast('agent.reconnected', { agent_id: agent.id, session_id: currentSession.id });
      broadcast('agent.status_changed', { agent_id: agent.id, status: 'ONLINE' });
    }
    return { agent: updated, session: currentSession, runtimeToken, isNewAgent: false, transition };
  }

  // New session: close the previous one at takeover time (now).
  if (currentSession && !currentSession.endedAt) {
    await prisma.session.update({
      where: { id: currentSession.id },
      data: { endedAt: now, endReason: transition === 'REBOOT' ? 'SHUTDOWN' : 'TAKEOVER' },
    });
    broadcast('session.ended', {
      agent_id: agent.id,
      session_id: currentSession.id,
      end_reason: transition === 'REBOOT' ? 'SHUTDOWN' : 'TAKEOVER',
    });
  }

  const sessionNo = (currentSession?.sessionNo ?? 0) + 1;
  const session = await prisma.session.create({
    data: {
      id: newId('ses'),
      agentId: agent.id,
      bootId: body.boot_id,
      bootTime: body.boot_time ? new Date(body.boot_time) : null,
      sessionNo,
    },
  });
  const updated = await prisma.agent.update({
    where: { id: agent.id },
    data: {
      ...baseUpdate,
      currentSessionId: session.id,
      replacementCount: transition === 'VM_REPLACED' && currentSession ? agent.replacementCount + 1 : agent.replacementCount,
    },
  });
  await ensureWorker(prisma, updated, body.worker_name ?? agent.workerName);

  if (currentSession) {
    if (transition === 'REBOOT') {
      await createEvent(prisma, {
        agentId: agent.id,
        type: 'REBOOT',
        description: `Agent ${agent.name} reboot; sesi baru #${sessionNo}`,
        metadata: { session_id: session.id, previous_session_id: currentSession.id },
      });
      broadcast('session.rebooted', { agent_id: agent.id, session_id: session.id, session_no: sessionNo });
    } else {
      await createEvent(prisma, {
        agentId: agent.id,
        type: 'VM_REPLACED',
        description: `VM agent ${agent.name} diganti; sesi baru #${sessionNo}`,
        metadata: { session_id: session.id, previous_session_id: currentSession.id },
      });
      broadcast('session.vm_replaced', { agent_id: agent.id, session_id: session.id, session_no: sessionNo });
    }
  }
  broadcast('session.started', { agent_id: agent.id, session_id: session.id, session_no: sessionNo });
  if (wasUnreachable) {
    await createEvent(prisma, {
      agentId: agent.id,
      type: 'AGENT_RECONNECTED',
      description: `Agent ${agent.name} terhubung kembali`,
      metadata: { session_id: session.id },
    });
    broadcast('agent.reconnected', { agent_id: agent.id, session_id: session.id });
    broadcast('agent.status_changed', { agent_id: agent.id, status: 'ONLINE' });
  }

  return { agent: updated, session, runtimeToken, isNewAgent: false, transition };
}
