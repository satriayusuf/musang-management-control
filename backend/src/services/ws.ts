// WebSocket broadcast hub: a process-wide registry of dashboard sockets.
// Services import `broadcast()` from here; the /ws route registers sockets.

export interface WsSocketLike {
  readyState: number;
  send(data: string): void;
  on(event: string, listener: () => void): unknown;
}

const clients = new Set<WsSocketLike>();

export function registerWsClient(socket: WsSocketLike): void {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

export function unregisterWsClient(socket: WsSocketLike): void {
  clients.delete(socket);
}

export function wsClientCount(): number {
  return clients.size;
}

/** Broadcast a JSON event {type, payload, at} to every connected dashboard. */
export function broadcast(type: string, payload: unknown): void {
  if (clients.size === 0) return;
  const message = JSON.stringify({ type, payload, at: new Date().toISOString() });
  for (const socket of clients) {
    try {
      if (socket.readyState === 1 /* OPEN */) socket.send(message);
    } catch {
      clients.delete(socket);
    }
  }
}
