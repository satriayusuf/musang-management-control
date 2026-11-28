<script setup lang="ts">
import {
  ArrowLeft,
  Send,
  RotateCcw,
  Play,
  Wrench,
  PauseCircle,
  PlayCircle,
  Ban,
  Trash2,
  Server,
} from 'lucide-vue-next'
import { api, pick, type AgentSummary, type WorkerInfo, type SessionInfo, type EventInfo, type CommandInfo } from '~/lib/api'
import { fmtDateTime, fmtRelative, fmtDuration, fmtHashrate, fmtGiB, fmtNumber } from '~/lib/format'
import { eventTypeLabel, commandTypeLabel, SESSION_END_REASON_LABELS } from '~/lib/labels'
import { newIdempotencyKey } from '~/lib/format'

const route = useRoute()
const agentId = computed(() => String(route.params.id))

const auth = useAuthStore()
/** Pencabutan token hanya ADMIN; tombol aksi perintah butuh peran selain VIEWER (CONTRACT-3 §1). */
const isAdmin = computed(() => auth.isAdmin)
const canOperate = computed(() => auth.canOperate)

const detail = ref<Record<string, unknown> | null>(null)
const loading = ref(true)
const loadError = ref('')
const actionNote = ref('')
const nowTick = ref(Date.now())

async function load() {
  try {
    detail.value = await api.getAgent(agentId.value)
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat detail agent.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  const t = setInterval(() => (nowTick.value = Date.now()), 15000)
  onUnmounted(() => clearInterval(t))
})
useLiveRefresh(load)

const agent = computed<AgentSummary | null>(() => {
  if (!detail.value) return null
  const a = pick<Record<string, unknown>>(detail.value, 'agent') ?? detail.value
  return a as AgentSummary
})

const worker = computed<WorkerInfo | null>(() => {
  if (!detail.value) return null
  const w = pick<WorkerInfo>(detail.value, 'worker') ?? agent.value?.worker ?? null
  return (w as WorkerInfo) ?? null
})

function listFrom<T>(...keys: string[]): T[] {
  if (!detail.value) return []
  for (const k of keys) {
    const v = detail.value[k]
    if (Array.isArray(v)) return v as T[]
    if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).items)) {
      return (v as Record<string, unknown>).items as T[]
    }
  }
  return []
}

const sessions = computed(() => listFrom<SessionInfo>('sessions', 'session_history'))
const events = computed(() => listFrom<EventInfo>('events', 'recent_events'))
const commands = computed(() => listFrom<CommandInfo>('commands', 'recent_commands'))

const currentSession = computed<SessionInfo | null>(() => {
  if (!agent.value) return null
  if (agent.value.current_session) return agent.value.current_session
  return sessions.value.find((s) => !s.ended_at) ?? sessions.value[0] ?? null
})

const sessionUptime = computed(() => {
  const s = currentSession.value
  if (!s?.started_at) return '—'
  const start = new Date(s.started_at).getTime()
  if (Number.isNaN(start)) return '—'
  return fmtDuration((nowTick.value - start) / 1000)
})

const memAvailable = computed<number | null>(() => {
  const fromWorker = worker.value?.mem_available_gib
  if (typeof fromWorker === 'number') return fromWorker
  const hb = pick<Record<string, unknown>>(detail.value ?? {}, 'latest_heartbeat', 'last_heartbeat')
  const v = hb?.mem_available_gib
  return typeof v === 'number' ? v : null
})

const capabilities = computed<string[]>(() => agent.value?.capabilities ?? [])
function can(type: string): boolean {
  return capabilities.value.includes(type)
}

const holdActive = computed(() => {
  // Fase 2: server menyediakan boolean hold_active dari snapshot heartbeat.
  if (typeof worker.value?.hold_active === 'boolean') return worker.value.hold_active
  const h = worker.value?.hold_until
  if (!h) return false
  return new Date(h).getTime() > nowTick.value
})

const runAgainBlocked = computed(() => {
  const st = worker.value?.status
  if (st === 'TAK_TERJANGKAU') return 'Agent tak terjangkau — perintah tidak dapat dikirim sampai bridge kembali online.'
  if (st === 'GAGAL_START') return 'Miner gagal start karena memori di bawah ambang minimum. Run Lagi tidak ditawarkan untuk kondisi ini.'
  return ''
})

// ---------- CONTRACT-7: runtime + status gabungan ----------
const runtime = computed(() => agent.value?.runtime ?? null)
const combinedStatus = computed(() => worker.value?.combined_status ?? agent.value?.combined_status ?? null)
const combinedReason = computed(() => worker.value?.combined_status_reason ?? agent.value?.combined_status_reason ?? null)

/** Samakan dengan BRIDGE_SILENT_SEC server (300 detik). */
const bridgeSilent = computed(() => {
  const ls = agent.value?.last_seen_at
  if (!ls) return true
  const t = Date.parse(ls)
  return Number.isNaN(t) || nowTick.value - t > 300_000
})

const useSnapshotHashrate = computed(() => {
  const snap = runtime.value?.snapshot
  return bridgeSilent.value && snap != null && typeof snap.hashrate_hs === 'number'
})

/** Status tampilan perintah (CONTRACT-7 §5): ditolak ≠ gagal; antrean untuk VM mati/pulih = Menunggu VM. */
function isRejectedCommand(c: CommandInfo): boolean {
  if (c.status !== 'FAILED') return false
  const r = c.result as Record<string, unknown> | null
  return r?.reported_status === 'rejected' || c.error_reason === 'LOW_MEMORY'
}
function commandChipStatus(c: CommandInfo): string {
  if (isRejectedCommand(c)) return 'REJECTED'
  if (c.status === 'QUEUED' && (combinedStatus.value === 'PULIH' || combinedStatus.value === 'MATI')) return 'WAITING_VM'
  return c.status
}

// ---------- Aksi perintah ----------
const showRunAgain = ref(false)
type PendingAction = { type: string; title: string; message: string; confirmLabel: string }
const pendingAction = ref<PendingAction | null>(null)

function askAction(type: string, title: string, message: string, confirmLabel: string) {
  pendingAction.value = { type, title, message, confirmLabel }
}

async function runPendingAction() {
  if (!pendingAction.value || !worker.value) return
  await api.createWorkerCommand(worker.value.id, {
    type: pendingAction.value.type,
    idempotency_key: newIdempotencyKey(),
    confirm: true,
  })
  actionNote.value = `Perintah ${commandTypeLabel(pendingAction.value.type)} berhasil dibuat dan masuk antrian.`
  pendingAction.value = null
  await load()
}

const revokeOpen = ref(false)
async function doRevoke() {
  await api.revokeAgent(agentId.value)
  actionNote.value = 'Token agent berhasil dicabut.'
  revokeOpen.value = false
  await load()
}

const deleteOpen = ref(false)
async function doDelete() {
  await api.deleteAgent(agentId.value)
  deleteOpen.value = false
  await navigateTo('/agents')
}
</script>

<template>
  <div>
    <NuxtLink to="/agents" class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-white">
      <ArrowLeft class="h-4 w-4" /> Kembali ke daftar agent
    </NuxtLink>

    <p v-if="loadError" class="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ loadError }}</p>
    <div v-if="loading && !detail" class="py-16 text-center text-sm text-ink-400">Memuat detail agent…</div>

    <template v-else-if="agent">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-xl font-semibold text-white">{{ agent.name }}</h1>
            <span
              v-if="agent.enrolled_via === 'self'"
              class="rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300"
              title="Agent ini mendaftar sendiri lewat dokumen agent.md"
            >Daftar Mandiri</span>
            <StatusChip :status="agent.status" kind="agent" />
            <StatusChip v-if="combinedStatus" :status="combinedStatus" kind="combined" />
            <StatusChip v-if="worker" :status="worker.status" kind="worker" />
            <HoldBadge v-if="worker" :active="holdActive" />
          </div>
          <p class="mt-1 font-mono text-xs text-ink-400">{{ agent.id }}</p>
          <p v-if="combinedReason" class="mt-1 text-sm text-ink-300">Status gabungan: {{ combinedReason }}</p>
          <p v-if="worker?.status_reason" class="mt-1 text-sm text-ink-400">{{ worker.status_reason }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button v-if="!agent.revoked_at && isAdmin" class="btn-ghost !text-red-300 hover:!bg-red-500/10" @click="revokeOpen = true">
            <Ban class="h-4 w-4" /> Cabut Token
          </button>
          <button v-if="isAdmin" class="btn-ghost !text-red-300 hover:!bg-red-500/10" @click="deleteOpen = true">
            <Trash2 class="h-4 w-4" /> Hapus Agent
          </button>
        </div>
      </div>

      <p v-if="actionNote" class="mb-5 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{{ actionNote }}</p>

      <div class="grid gap-5 xl:grid-cols-3">
        <!-- Informasi Agent -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Informasi Agent</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div class="flex justify-between gap-3"><dt class="text-ink-400">ID Agent</dt><dd class="break-all text-right font-mono text-xs">{{ agent.id }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Nama Worker</dt><dd class="text-right font-medium">{{ agent.worker_name || worker?.name || '—' }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Sesi Saat Ini</dt><dd class="text-right">{{ currentSession ? `#${currentSession.session_no ?? '—'}` : '—' }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Boot ID</dt><dd class="max-w-44 truncate text-right font-mono text-xs" :title="currentSession?.boot_id">{{ currentSession?.boot_id || '—' }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Versi Bridge</dt><dd class="text-right">{{ agent.bridge_version || '—' }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Terdaftar Pertama Kali</dt><dd class="text-right">{{ fmtDateTime(agent.first_registered_at) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Terakhir Terlihat</dt><dd class="text-right">{{ fmtDateTime(agent.last_seen_at) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Jumlah Penggantian VM</dt><dd class="text-right">{{ agent.replacement_count ?? 0 }}×</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Status Token</dt><dd class="text-right">{{ agent.revoked_at ? `Dicabut (${fmtDateTime(agent.revoked_at)})` : 'Aktif' }}</dd></div>
            <div v-if="agent.enrolled_via" class="flex justify-between gap-3"><dt class="text-ink-400">Asal Pendaftaran</dt><dd class="text-right">{{ agent.enrolled_via === 'self' ? 'Daftar Mandiri (agent.md)' : 'Kode Pairing' }}</dd></div>
            <div>
              <dt class="mb-1.5 text-ink-400">Kemampuan (Capabilities)</dt>
              <dd class="flex flex-wrap gap-1.5">
                <span v-for="c in capabilities" :key="c" class="rounded bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-ink-200">{{ c }}</span>
                <span v-if="capabilities.length === 0" class="text-ink-400">—</span>
              </dd>
            </div>
          </dl>
        </section>

        <!-- Kesehatan Saat Ini -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Kesehatan Saat Ini</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div class="flex items-center justify-between gap-3"><dt class="text-ink-400">Status Agent</dt><dd><StatusChip :status="agent.status" kind="agent" /></dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Heartbeat Terakhir</dt><dd class="text-right">{{ fmtRelative(agent.last_seen_at, nowTick) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Uptime Sesi</dt><dd class="text-right">{{ sessionUptime }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Memori Tersedia</dt><dd class="text-right">{{ fmtGiB(memAvailable) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Status Service Miner</dt><dd class="text-right font-mono text-xs">{{ worker?.miner_service_state || '—' }}</dd></div>
            <div class="flex items-center justify-between gap-3"><dt class="text-ink-400">Status Worker</dt><dd><StatusChip v-if="worker" :status="worker.status" kind="worker" /><span v-else>—</span></dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Status Sejak</dt><dd class="text-right">{{ fmtDateTime(worker?.status_since) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Pemulihan Terakhir</dt><dd class="text-right">{{ fmtDateTime(worker?.last_recovery_at) }}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-ink-400">Tahan Pemulihan</dt><dd class="text-right">{{ holdActive ? (worker?.hold_until ? `Aktif s.d. ${fmtDateTime(worker?.hold_until)}` : 'Aktif (ditahan)') : 'Tidak aktif' }}</dd></div>
          </dl>
        </section>

        <!-- Aksi -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Aksi</h2>
          <p v-if="!canOperate" class="mt-4 rounded-lg bg-ink-850 px-3 py-2 text-xs leading-relaxed text-ink-400">
            Peran Penonton bersifat hanya-baca — tombol aksi perintah tidak tersedia.
          </p>
          <div v-else-if="worker" class="mt-4 flex flex-col gap-2">
            <NuxtLink :to="`/commands?agent=${agent.id}`" class="btn-ghost justify-start">
              <Send class="h-4 w-4" /> Kirim Perintah
            </NuxtLink>
            <button
              v-if="can('miner.run')"
              class="btn-ghost justify-start"
              :disabled="!!runAgainBlocked"
              :title="runAgainBlocked || undefined"
              @click="showRunAgain = true"
            >
              <Play class="h-4 w-4" /> Run Lagi
            </button>
            <p v-if="can('miner.run') && runAgainBlocked" class="rounded-lg bg-ink-850 px-3 py-2 text-xs leading-relaxed text-amber-300">
              Run Lagi dinonaktifkan: {{ runAgainBlocked }}
            </p>
            <button
              v-if="can('miner.restart')"
              class="btn-ghost justify-start"
              @click="askAction('miner.restart', 'Restart Miner', `Service miner pada worker ${worker.name} akan direstart. Proses mining berhenti sesaat lalu dimulai kembali. Lanjutkan?`, 'Ya, Restart')"
            >
              <RotateCcw class="h-4 w-4" /> Restart Miner
            </button>
            <button
              v-if="can('miner.reinstall')"
              class="btn-ghost justify-start"
              @click="askAction('miner.reinstall', 'Reinstall Miner', `Miner pada worker ${worker.name} akan dipasang ulang oleh bridge, lalu dijalankan kembali. Gunakan bila unit/service rusak. Lanjutkan?`, 'Ya, Reinstall')"
            >
              <Wrench class="h-4 w-4" /> Reinstall Miner
            </button>
            <button
              v-if="can('miner.hold') && !holdActive"
              class="btn-ghost justify-start"
              @click="askAction('miner.hold', 'Tahan Pemulihan Otomatis', `Pemulihan otomatis untuk worker ${worker.name} akan ditahan. Miner yang mati tidak akan dipulihkan otomatis selama penahanan aktif. Lanjutkan?`, 'Ya, Tahan')"
            >
              <PauseCircle class="h-4 w-4" /> Tahan Pemulihan Otomatis
            </button>
            <button
              v-if="can('miner.unhold') && holdActive"
              class="btn-ghost justify-start"
              @click="askAction('miner.unhold', 'Lanjutkan Pemulihan Otomatis', `Penahanan pemulihan otomatis untuk worker ${worker.name} akan dicabut. Watchdog kembali memulihkan miner secara otomatis. Lanjutkan?`, 'Ya, Lanjutkan')"
            >
              <PlayCircle class="h-4 w-4" /> Lanjutkan Pemulihan Otomatis
            </button>
            <p class="pt-1 text-xs leading-relaxed text-ink-400">
              Tombol yang tampil dibatasi oleh kemampuan (capabilities) yang didaftarkan bridge agent ini.
            </p>
          </div>
          <EmptyState v-else message="Agent ini belum memiliki worker. Aksi miner akan tersedia setelah bridge melaporkan worker." />
          <div class="mt-4 border-t border-ink-700 pt-3">
            <button class="btn-ghost w-full justify-start" disabled title="Menunggu API platform pengelola VM">
              <Server class="h-4 w-4" /> Trigger VM (Ganti / Reboot VM)
            </button>
            <p class="mt-1.5 text-xs leading-relaxed text-ink-400">
              Menunggu API platform pengelola VM. Mengganti atau me-reboot VM adalah kewenangan
              platform, jadi kontrol ini sengaja nonaktif dan belum terhubung ke aksi apa pun.
            </p>
          </div>
        </section>
      </div>

      <!-- Runtime Muse (CONTRACT-7) -->
      <section class="panel mt-5 p-5">
        <h2 class="text-sm font-semibold text-white">Runtime Muse</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-400">
          Runtime tinggal di VM dan selamat dari penggantian VM; laporannya adalah sumber status
          paling dipercaya. Token runtime diterbitkan server saat registrasi dan disimpan bridge —
          nilainya tidak pernah ditampilkan.
        </p>
        <dl v-if="runtime" class="mt-4 grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Status Token Runtime</dt><dd class="text-right">{{ runtime.token_issued ? `Diterbitkan (${fmtDateTime(runtime.token_issued_at)})` : 'Belum diterbitkan' }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Kontak Runtime Terakhir</dt><dd class="text-right">{{ runtime.last_contact_at ? `${fmtRelative(runtime.last_contact_at, nowTick)} (${fmtDateTime(runtime.last_contact_at)})` : 'Belum pernah' }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Transisi Terakhir</dt><dd class="text-right">{{ runtime.last_transition_type ? `${runtime.last_transition_type} · ${fmtDateTime(runtime.last_transition_at)}` : '—' }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Alasan Transisi</dt><dd class="max-w-64 text-right">{{ runtime.transition_reason || '—' }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Waktu Boot (Runtime)</dt><dd class="text-right">{{ fmtDateTime(runtime.boot_time) }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-400">Snapshot Terakhir</dt><dd class="text-right">{{ runtime.snapshot?.at ? `${fmtRelative(runtime.snapshot.at, nowTick)} (${fmtDateTime(runtime.snapshot.at)})` : '—' }}</dd></div>
          <div v-if="runtime.snapshot" class="flex justify-between gap-3"><dt class="text-ink-400">Hashrate Snapshot</dt><dd class="text-right">{{ fmtHashrate(runtime.snapshot.hashrate_hs) }}</dd></div>
          <div v-if="runtime.snapshot" class="flex justify-between gap-3"><dt class="text-ink-400">Share Lokal Snapshot</dt><dd class="text-right">{{ fmtNumber(runtime.snapshot.shares_local) }}</dd></div>
          <div v-if="runtime.snapshot" class="flex justify-between gap-3"><dt class="text-ink-400">Share Pool Diterima (Snapshot)</dt><dd class="text-right">{{ fmtNumber(runtime.snapshot.pool_accepted) }}</dd></div>
          <div v-if="runtime.snapshot" class="flex justify-between gap-3"><dt class="text-ink-400">Memori Tersedia (Snapshot)</dt><dd class="text-right">{{ fmtGiB(runtime.snapshot.mem_available_gib) }}</dd></div>
        </dl>
        <p v-else class="mt-4 rounded-lg bg-ink-850 px-3 py-2 text-xs leading-relaxed text-ink-400">
          Agent ini belum memiliki data runtime. Token runtime diterbitkan otomatis saat bridge
          mendaftar ulang; laporan pertama tiba dari runtime di VM.
        </p>
      </section>

      <!-- Metrik Worker -->
      <section v-if="worker" class="panel mt-5 p-5">
        <h2 class="text-sm font-semibold text-white">Metrik Worker</h2>
        <div class="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <p class="text-xs text-ink-400">Hashrate VM</p>
            <template v-if="useSnapshotHashrate">
              <p class="mt-1 text-lg font-semibold text-white">{{ fmtHashrate(runtime!.snapshot!.hashrate_hs) }}</p>
              <p class="text-xs text-sky-300">Snapshot runtime · {{ fmtRelative(runtime!.snapshot!.at, nowTick) }} (bridge diam)</p>
            </template>
            <p v-else class="mt-1 text-lg font-semibold text-white">{{ fmtHashrate(worker.hashrate_hs) }}</p>
          </div>
          <div><p class="text-xs text-ink-400">Hashrate Pool</p><p class="mt-1 text-lg font-semibold text-white">{{ worker.pool && typeof worker.pool.hashrate === 'number' ? fmtHashrate(worker.pool.hashrate) : '—' }}</p></div>
          <div><p class="text-xs text-ink-400">Share Terakhir</p><p class="mt-1 text-lg font-semibold text-white">{{ fmtRelative(worker.last_share_at, nowTick) }}</p><p class="text-xs text-ink-400">{{ fmtDateTime(worker.last_share_at) }}</p></div>
          <div><p class="text-xs text-ink-400">Share Lokal (Sesi Ini)</p><p class="mt-1 text-lg font-semibold text-white">{{ fmtNumber(worker.shares_local) }}</p></div>
          <div><p class="text-xs text-ink-400">Share Diterima (VM)</p><p class="mt-1 text-lg font-semibold text-emerald-400">{{ fmtNumber(worker.accepted_shares) }}</p></div>
          <div><p class="text-xs text-ink-400">Share Ditolak (VM)</p><p class="mt-1 text-lg font-semibold text-red-400">{{ fmtNumber(worker.rejected_shares) }}</p></div>
          <div><p class="text-xs text-ink-400">Tinggi Job</p><p class="mt-1 text-lg font-semibold text-white">{{ fmtNumber(worker.job_height) }}</p></div>
          <div><p class="text-xs text-ink-400">Difficulty</p><p class="mt-1 text-lg font-semibold text-white">{{ fmtNumber(worker.difficulty, 2) }}</p></div>
          <div><p class="text-xs text-ink-400">Alamat Pool</p><p class="mt-1 break-all font-mono text-xs text-ink-200">{{ worker.pool_address || '—' }}</p></div>
        </div>
      </section>

      <div class="mt-5 grid gap-5 xl:grid-cols-2">
        <!-- Riwayat Sesi -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Riwayat Sesi</h2>
          <EmptyState v-if="sessions.length === 0" message="Belum ada riwayat sesi." />
          <div v-else class="mt-3 overflow-x-auto">
            <table class="table-base">
              <thead><tr><th>Sesi</th><th>Boot ID</th><th>Mulai</th><th>Berakhir</th><th>Keterangan</th></tr></thead>
              <tbody>
                <tr v-for="s in sessions" :key="s.id">
                  <td class="font-medium">#{{ s.session_no ?? '—' }}</td>
                  <td class="max-w-28 truncate font-mono text-xs" :title="s.boot_id">{{ s.boot_id || '—' }}</td>
                  <td class="whitespace-nowrap text-xs">{{ fmtDateTime(s.started_at) }}</td>
                  <td class="whitespace-nowrap text-xs">{{ s.ended_at ? fmtDateTime(s.ended_at) : 'Aktif' }}</td>
                  <td class="text-xs">{{ s.end_reason ? (SESSION_END_REASON_LABELS[s.end_reason] ?? s.end_reason) : (s.ended_at ? '—' : 'Sedang berjalan') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Linimasa Peristiwa -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Linimasa Peristiwa & Penggantian VM</h2>
          <EmptyState v-if="events.length === 0" message="Belum ada peristiwa untuk agent ini." />
          <ol v-else class="mt-4 space-y-0">
            <li v-for="ev in events" :key="ev.id" class="relative border-l border-ink-700 pb-4 pl-5 last:pb-0">
              <span
                class="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-ink-900"
                :class="ev.type === 'VM_REPLACED' ? 'bg-violet-400' : ev.type === 'RECOVERY_FAILED' || ev.type === 'COMMAND_FAILED' ? 'bg-red-400' : ev.type === 'RECOVERY' ? 'bg-emerald-400' : 'bg-ink-400'"
              />
              <p class="text-sm font-medium text-ink-100">{{ eventTypeLabel(ev.type) }}</p>
              <p class="text-sm text-ink-400">{{ ev.description || '—' }}</p>
              <p class="mt-0.5 text-xs text-ink-400">{{ fmtDateTime(ev.created_at) }}</p>
            </li>
          </ol>
        </section>
      </div>

      <!-- Riwayat Perintah -->
      <section class="panel mt-5 p-5">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-white">Riwayat Perintah</h2>
          <NuxtLink :to="`/commands?agent=${agent.id}`" class="text-xs font-medium text-indigo-400 hover:text-indigo-300">Buka di Pusat Perintah</NuxtLink>
        </div>
        <EmptyState v-if="commands.length === 0" message="Belum ada perintah untuk agent ini." />
        <div v-else class="mt-3 overflow-x-auto">
          <table class="table-base">
            <thead><tr><th>Waktu</th><th>Tipe Perintah</th><th>Status</th><th>Diminta Oleh</th><th>Hasil / Alasan Gagal</th></tr></thead>
            <tbody>
              <tr v-for="c in commands" :key="c.id">
                <td class="whitespace-nowrap text-xs">{{ fmtDateTime(c.created_at) }}</td>
                <td>{{ commandTypeLabel(c.type) }} <span class="font-mono text-[11px] text-ink-400">{{ c.type }}</span></td>
                <td><StatusChip :status="commandChipStatus(c)" kind="command" /></td>
                <td class="text-xs">{{ c.requested_by || '—' }}</td>
                <td class="max-w-72 truncate text-xs" :title="c.error_reason || undefined">{{ c.error_reason || (c.status === 'SUCCEEDED' ? 'Selesai dan terverifikasi' : '—') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Dialog aksi generik -->
    <ConfirmDialog
      v-if="pendingAction"
      :title="pendingAction.title"
      :message="pendingAction.message"
      :confirm-label="pendingAction.confirmLabel"
      :on-confirm="runPendingAction"
      @close="pendingAction = null"
    />
    <ConfirmDialog
      v-if="revokeOpen"
      title="Cabut Token Agent"
      message="Token agent ini akan dicabut. Bridge pada VM tidak akan bisa lagi terhubung sampai agent dipasangkan ulang. Riwayat agent tidak dihapus. Lanjutkan?"
      confirm-label="Ya, Cabut Token"
      :danger="true"
      :on-confirm="doRevoke"
      @close="revokeOpen = false"
    />
    <ConfirmDialog
      v-if="deleteOpen"
      title="Hapus Agent Permanen"
      message="Agent ini beserta SELURUH datanya — sesi, event, perintah, heartbeat, dan snapshot pool — akan dihapus permanen dan tidak bisa dikembalikan. Catatan penghapusan tetap tersimpan di log audit. Lanjutkan?"
      confirm-label="Ya, Hapus Permanen"
      :danger="true"
      :on-confirm="doDelete"
      @close="deleteOpen = false"
    />
    <RunAgainDialog
      v-if="showRunAgain && worker"
      :worker="worker"
      :agent-name="agent?.name"
      @close="showRunAgain = false"
      @done="load"
    />
  </div>
</template>
