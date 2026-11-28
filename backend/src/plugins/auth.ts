// Auth guards.
// - requireUser: Fastify preHandler verifying the dashboard JWT.
// - authenticateAgent: verifies an agent Bearer token against the stored
//   sha256 hash for the agent named by the :id route param (or body agent_id).

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Agent, PrismaClient } from '@prisma/client';
import { verifyAgentToken } from '../lib/crypto';

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

// --- Phase 3 (CONTRACT-3 §1): role-based access ---

export const USER_ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Shape of the dashboard JWT payload (Phase 3 adds `role`). */
export interface JwtUserPayload {
  sub: string;
  email: string;
  role: string;
}

/**
 * preHandler factory, used AFTER requireUser:
 *   { preHandler: [requireUser, requireRole('ADMIN')] }
 * Sends 403 when the authenticated user's role is not in the allowed set.
 * VIEWER therefore fails every guarded write route (CONTRACT-3 §1 matrix).
 */
export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return;
    const payload = request.user as JwtUserPayload | undefined;
    const role = payload?.role;
    if (!role || !(roles as string[]).includes(role)) {
      await reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'Peran Anda tidak memiliki akses untuk tindakan ini',
      });
    }
  };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Login diperlukan' });
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Load + authenticate an agent by id. Throws httpError(401) when the token is
 * missing/invalid or the agent is revoked; 404 when the agent does not exist.
 */
export async function authenticateAgent(
  prisma: PrismaClient,
  request: FastifyRequest,
  agentId: string,
): Promise<Agent> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');
  const token = bearerToken(request);
  if (!token || agent.revokedAt || !verifyAgentToken(token, agent.tokenHash)) {
    throw httpError(401, 'AGENT_UNAUTHORIZED');
  }
  return agent;
}

/**
 * Authenticate the Muse RUNTIME (CONTRACT-7) for an agent: the Bearer
 * token must match the agent's runtime token hash. Throws 404 for an
 * unknown agent, 401 for a missing/wrong token or a revoked agent.
 */
export async function authenticateRuntime(
  prisma: PrismaClient,
  request: FastifyRequest,
  agentId: string,
): Promise<Agent> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');
  const token = bearerToken(request);
  const state = await prisma.agentRuntimeState.findUnique({ where: { agentId } });
  if (!token || agent.revokedAt || !verifyAgentToken(token, state?.runtimeTokenHash ?? null)) {
    throw httpError(401, 'RUNTIME_UNAUTHORIZED');
  }
  return agent;
}

/** True when the request's Bearer token is the agent's AGENT (bridge) token. */
export async function isAgentTokenRequest(
  prisma: PrismaClient,
  request: FastifyRequest,
  agent: Agent,
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token || agent.revokedAt) return false;
  return verifyAgentToken(token, agent.tokenHash);
}
