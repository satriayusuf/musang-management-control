// Inisialisasi sesi saat aplikasi dimuat: pulihkan token, ambil profil,
// lalu buka koneksi WebSocket bila sudah login.
export default defineNuxtPlugin(async () => {
  const auth = useAuthStore()
  auth.init()
  if (auth.token) {
    await auth.fetchMe()
    const realtime = useRealtimeStore()
    realtime.connect()
  }
})
