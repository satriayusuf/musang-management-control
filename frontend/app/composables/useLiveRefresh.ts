import { watch, onUnmounted } from 'vue'

/**
 * Menjalankan `fn` setiap kali ada event WebSocket baru, dengan debounce
 * agar ledakan event tidak memicu terlalu banyak permintaan ulang.
 * Pemanggilan awal tetap menjadi tanggung jawab halaman.
 */
export function useLiveRefresh(fn: () => void | Promise<void>, debounceMs = 450) {
  const realtime = useRealtimeStore()
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = watch(
    () => realtime.version,
    () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void fn()
      }, debounceMs)
    },
  )

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    stop()
  })
}
