// Settings endpoints (JWT): read effective settings, update with validation.
// The pool API key is write-only: stored in the settings table, never returned.
//
// Phase 3 (CONTRACT-3 §1/§4/§8): writes are ADMIN-only. GET exposes the
// enrollment key ONLY to ADMIN (null for other roles). Adds the enrollment
// key rotation endpoint and the manual retention run endpoint.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requireRole, requireUser, type JwtUserPayload } from '../plugins/auth';
import { settingsPatchSchema } from '../schemas';
import { createAuditLog } from '../services/audit';
import { getEnrollmentKey, rotateEnrollmentKey } from '../services/enrollment';
import { runRetentionCleanup } from '../services/retention';
import { getSettings, updateSettings } from '../services/settings';
import { runPoolTestFetch, type PoolTestResult } from '../services/pool/test-fetch';

export async function settingsRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get('/api/settings', { preHandler: requireUser }, async (request) => {
    const settings = await getSettings(prisma);
    const user = request.user as JwtUserPayload;
    const enrollmentKey = user.role === 'ADMIN' ? await getEnrollmentKey(prisma) : null;
    return { ...settings, enrollment_key: enrollmentKey };
  });

  app.put<{ Body: Record<string, unknown> }>(
    '/api/settings',
    { preHandler: [requireUser, requireRole('ADMIN')], schema: { body: settingsPatchSchema } },
    async (request) => {
      const user = request.user as { email: string };
      let updated: string[];
      try {
        updated = await updateSettings(prisma, request.body);
      } catch (err) {
        throw Object.assign(err as Error, { statusCode: 400 });
      }
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'settings.update',
        target: 'system_settings',
        metadata: { keys: updated },
      });
      const settings = await getSettings(prisma);
      // Phase 5 (CONTRACT-5 B5): one test fetch after saving a bntpool
      // config. A failed fetch never fails the save — it is reported in
      // pool_test.fetch_ok=false as a warning.
      let poolTest: PoolTestResult | undefined;
      if (settings.pool_provider === 'bntpool') {
        poolTest = await runPoolTestFetch(prisma);
      }
      return {
        ...settings,
        enrollment_key: await getEnrollmentKey(prisma),
        ...(poolTest ? { pool_test: poolTest } : {}),
      };
    },
  );

  // Phase 3 §8: rotate the self-enrollment key (ADMIN). Previously served
  // agent.md copies stop working because the document is rendered live.
  app.post(
    '/api/settings/enrollment-key/rotate',
    { preHandler: [requireUser, requireRole('ADMIN')] },
    async (request) => {
      const user = request.user as { email: string };
      const enrollmentKey = await rotateEnrollmentKey(prisma, user.email);
      return { enrollment_key: enrollmentKey };
    },
  );

  // Phase 3 §4: run the retention cleanup on demand (ADMIN).
  app.post(
    '/api/settings/retention/run',
    { preHandler: [requireUser, requireRole('ADMIN')] },
    async (request) => {
      const user = request.user as { email: string };
      const counts = await runRetentionCleanup(prisma, new Date(), user.email);
      return { deleted: counts };
    },
  );
}
