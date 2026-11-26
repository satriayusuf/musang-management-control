// Zero-touch self-enrollment (Phase 3, CONTRACT-3 §8).
//
// A shared enrollment key (32-byte random hex, stored as the `enrollment_key`
// system setting) lets a fresh bridge register itself with NO operator
// action: the owner pastes the public /agent.md URL to the agent, the agent
// installs the bridge, and the bridge calls POST /api/bridge/self-register
// with the key embedded in that document. The key is exposed by
// GET /api/settings to ADMIN only, can be rotated (which immediately
// invalidates previously served agent.md copies because the document is
// rendered live), and failed key attempts are rate-limited per IP.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, PrismaClient, Session } from '@prisma/client';
import { generateAgentToken, hashEquals, newId, sha256Hex } from '../lib/crypto';
import { createAuditLog } from './audit';
import { createEvent } from './events';
import { ensureWorker } from './session';
import { broadcast } from './ws';

export const ENROLLMENT_KEY_SETTING = 'enrollment_key';

function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

/** The current enrollment key, or null when not seeded yet. */
export async function getEnrollmentKey(prisma: PrismaClient): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: ENROLLMENT_KEY_SETTING } });
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Seed the key when absent (boot). Returns the current key. */
export async function ensureEnrollmentKey(prisma: PrismaClient): Promise<string> {
  const existing = await getEnrollmentKey(prisma);
  if (existing) return existing;
  const key = generateEnrollmentKey();
  await prisma.systemSetting.upsert({
    where: { key: ENROLLMENT_KEY_SETTING },
    update: {},
    create: { key: ENROLLMENT_KEY_SETTING, value: key as never },
  });
  return (await getEnrollmentKey(prisma)) ?? key;
}

/** Rotate the key (ADMIN action): the old key stops working immediately. */
export async function rotateEnrollmentKey(prisma: PrismaClient, actorEmail: string): Promise<string> {
  const key = generateEnrollmentKey();
  await prisma.systemSetting.upsert({
    where: { key: ENROLLMENT_KEY_SETTING },
    update: { value: key as never },
    create: { key: ENROLLMENT_KEY_SETTING, value: key as never },
  });
  await createAuditLog(prisma, {
    actor: actorEmail,
    action: 'settings.enrollment_key_rotate',
    target: 'settings',
    metadata: {},
  });
  return key;
}

/** Public base URL of this server, used to render agent.md. */
export function publicBaseUrl(): string {
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '');
  const port = process.env.PORT ?? '3001';
  return `http://127.0.0.1:${port}`;
}

let templateCache: string | null = null;

/** Render the enrollment document with the CURRENT key + public server URL. */
export function renderAgentDocument(enrollmentKey: string, serverUrl: string): string {
  if (templateCache === null) {
    templateCache = readFileSync(join(__dirname, '..', 'assets', 'agent.md.tmpl'), 'utf8');
  }
  return templateCache
    .replaceAll('{{ENROLLMENT_KEY}}', enrollmentKey)
    .replaceAll('{{SERVER_URL}}', serverUrl);
}

// --- Failed-key rate limiting (per IP: 10 failures / 10 minutes -> 429) ---

export class FailedAttemptLimiter {
  private attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  private prune(key: string, now: Date): number[] {
    const cutoff = now.getTime() - this.windowMs;
    const list = (this.attempts.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.attempts.delete(key);
    else this.attempts.set(key, list);
    return list;
  }

  isLimited(key: string, now: Date = new Date()): boolean {
    return this.prune(key, now).length >= this.maxAttempts;
  }

  recordFailure(key: string, now: Date = new Date()): void {
    const list = this.prune(key, now);
    list.push(now.getTime());
    this.attempts.set(key, list);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

export const selfRegisterLimiter = new FailedAttemptLimiter(10, 10 * 60 * 1000);

// --- Self-registration ---

export interface SelfRegisterBody {
  enrollment_key: string;
  agent_name: string;
  name?: string;
  worker_name?: string;
  boot_id: string;
  boot_time?: string;
  bridge_version?: string;
  capabilities?: string[];
}

export interface SelfRegisterResult {
  agent: Agent;
  session: Session;
  agentToken: string;
}

function keysMatch(provided: string, stored: string): boolean {
  return hashEquals(sha256Hex(provided), sha256Hex(stored));
}

/**
 * Register a brand-new agent via the enrollment key. Throws 429 when the
 * caller IP is rate-limited, 401 on a wrong key. On success mirrors the
 * pairing registration (agent + worker + session #1) with
 * enrolled_via = "self" and an audit row with actor "self-enroll".
 */
export async function selfRegister(
  prisma: PrismaClient,
  body: SelfRegisterBody,
  ip: string,
): Promise<SelfRegisterResult> {
  if (selfRegisterLimiter.isLimited(ip)) {
    throw Object.assign(new Error('Terlalu banyak percobaan kunci yang gagal; coba lagi nanti'), {
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
  }
  const stored = await ensureEnrollmentKey(prisma);
  if (!body.enrollment_key || !keysMatch(body.enrollment_key, stored)) {
    selfRegisterLimiter.recordFailure(ip);
    throw Object.assign(new Error('ENROLLMENT_KEY_INVALID'), { statusCode: 401 });
  }
  selfRegisterLimiter.clear(ip);

  const rawToken = generateAgentToken();
  const now = new Date();
  const agent = await prisma.agent.create({
    data: {
      id: newId('agt'),
      name: body.agent_name ?? body.name ?? 'agent',
      tokenHash: sha256Hex(rawToken),
      workerName: body.worker_name ?? null,
      capabilities: body.capabilities ?? [],
      bridgeVersion: body.bridge_version ?? null,
      status: 'ONLINE',
      lastSeenAt: now,
      enrolledVia: 'self',
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
  await ensureWorker(prisma, updated, body.worker_name);

  await createEvent(prisma, {
    agentId: agent.id,
    type: 'AGENT_REGISTERED',
    description: `Agent ${updated.name} terdaftar mandiri (self-enrollment)`,
    metadata: { session_id: session.id, session_no: 1, enrolled_via: 'self' },
  });
  await createAuditLog(prisma, {
    actor: 'self-enroll',
    action: 'agent.self_register',
    target: agent.id,
    metadata: { agent_name: updated.name, enrolled_via: 'self' },
  });
  broadcast('agent.registered', { agent_id: agent.id, session_id: session.id });
  broadcast('session.started', { agent_id: agent.id, session_id: session.id, session_no: 1 });

  return { agent: updated, session, agentToken: rawToken };
}
