// Alert endpoints (JWT) — Phase 2, CONTRACT-2 §4: recent notifications with
// their deliveries, plus the settings "send test" action.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toAlertDeliveryDto, toAlertNotificationDto } from '../lib/serialize';
import { requireRole, requireUser } from '../plugins/auth';
import { alertTestBodySchema } from '../schemas';
import { sendTestAlert } from '../services/alerts';

export async function alertRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get<{ Querystring: { page?: string; page_size?: string } }>(
    '/api/alerts',
    { preHandler: requireUser },
    async (request) => {
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 50) || 50));
      const [total, rows] = await Promise.all([
        prisma.alertNotification.count(),
        prisma.alertNotification.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { deliveries: { orderBy: { at: 'asc' } } },
        }),
      ]);
      return { items: rows.map(toAlertNotificationDto), total, page, page_size: pageSize };
    },
  );

  app.post<{ Body: { channel: string } }>(
    '/api/settings/alerts/test',
    { preHandler: [requireUser, requireRole('ADMIN')], schema: { body: alertTestBodySchema } },
    async (request) => {
      const { notification, delivery } = await sendTestAlert(prisma, request.body.channel);
      return {
        notification: toAlertNotificationDto(notification),
        delivery: toAlertDeliveryDto(delivery),
      };
    },
  );
}
