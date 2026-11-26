// Dashboard WebSocket: GET /ws?token=<jwt> (or Authorization header).
// Server broadcasts {type, payload, at}; the DB remains the source of truth.

import type { FastifyInstance } from 'fastify';
import { registerWsClient } from '../services/ws';

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { token?: string } }>(
    '/ws',
    { websocket: true },
    async (socket, request) => {
      const token =
        request.query.token ??
        (request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice('Bearer '.length)
          : null);
      if (!token) {
        socket.close(4401, 'UNAUTHORIZED');
        return;
      }
      try {
        app.jwt.verify(token);
      } catch {
        socket.close(4401, 'UNAUTHORIZED');
        return;
      }
      registerWsClient(socket);
    },
  );
}
