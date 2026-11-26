import { defineStore } from 'pinia'
import { api, getToken, setToken, clearToken, decodeJwtRole } from '~/lib/api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: null as string | null,
    email: '' as string,
    role: '' as string,
    ready: false,
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    /** ADMIN — termasuk sesi lama tanpa klaim peran (satu admin bawaan Fase 1/2). */
    isAdmin: (s) => s.role === 'ADMIN' || s.role === '',
    /** OPERATOR ke atas: boleh membuat perintah, template, aturan, dan jadwal. */
    canOperate: (s) => s.role !== 'VIEWER',
    /** VIEWER bersifat hanya-baca: semua tombol buat/aksi disembunyikan. */
    isViewer: (s) => s.role === 'VIEWER',
  },
  actions: {
    init() {
      this.token = getToken()
      this.role = decodeJwtRole(this.token)
      this.ready = true
    },
    async login(email: string, password: string) {
      const res = await api.login(email, password)
      setToken(res.token)
      this.token = res.token
      this.role = decodeJwtRole(res.token)
      try {
        const me = await api.me()
        this.email = me.email || email
        if (me.role) this.role = me.role
      } catch {
        this.email = email
      }
      // Mulai koneksi real-time setelah login berhasil.
      const realtime = useRealtimeStore()
      realtime.connect()
    },
    async fetchMe() {
      if (!this.token) return
      try {
        const me = await api.me()
        this.email = me.email
        if (me.role) this.role = me.role
      } catch {
        /* token mungkin kedaluwarsa; apiFetch sudah menangani 401 */
      }
    },
    logout() {
      const realtime = useRealtimeStore()
      realtime.disconnect()
      clearToken()
      this.token = null
      this.email = ''
      this.role = ''
      navigateTo('/login')
    },
  },
})
