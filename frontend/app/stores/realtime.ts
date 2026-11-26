import { defineStore } from 'pinia'
import { getToken, wsUrl } from '~/lib/api'

export interface RealtimeEvent {
  type: string
  payload?: unknown
  at?: string
}

/**
 * Store WebSocket dashboard.
 * - Terhubung ke /ws dengan JWT sebagai ?token=.
 * - Reconnect otomatis dengan backoff eksponensial (1s → 30s).
 * - Setiap event menaikkan `version`; halaman menonton `version` lalu
 *   mengambil ulang data dari REST API (database tetap sumber kebenaran).
 */
export const useRealtimeStore = defineStore('realtime', {
  state: () => ({
    connected: false,
    version: 0,
    lastEvent: null as RealtimeEvent | null,
    socket: null as WebSocket | null,
    reconnectTimer: null as ReturnType<typeof setTimeout> | null,
    backoffMs: 1000,
    stopped: true,
  }),
  actions: {
    connect() {
      if (import.meta.server) return
      const token = getToken()
      if (!token) return
      this.stopped = false
      if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
        return
      }
      this.openSocket(token)
    },
    openSocket(token: string) {
      try {
        const ws = new WebSocket(wsUrl(token))
        this.socket = ws
        ws.onopen = () => {
          this.connected = true
          this.backoffMs = 1000
          // Picu refetch agar tampilan sinkron dengan keadaan terbaru server.
          this.version++
        }
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data as string) as RealtimeEvent
            this.lastEvent = data
          } catch {
            /* abaikan pesan tidak valid */
          }
          this.version++
        }
        ws.onclose = () => {
          this.connected = false
          this.socket = null
          this.scheduleReconnect()
        }
        ws.onerror = () => {
          try {
            ws.close()
          } catch {
            /* abaikan */
          }
        }
      } catch {
        this.scheduleReconnect()
      }
    },
    scheduleReconnect() {
      if (this.stopped) return
      if (this.reconnectTimer) return
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 30000)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.stopped) this.connect()
      }, delay)
    },
    disconnect() {
      this.stopped = true
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      if (this.socket) {
        try {
          this.socket.close()
        } catch {
          /* abaikan */
        }
        this.socket = null
      }
      this.connected = false
    },
  },
})
