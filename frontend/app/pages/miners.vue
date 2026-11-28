<script setup lang="ts">
import { Play, Info, PauseCircle, PlayCircle, Search } from 'lucide-vue-next'
import { api, type WorkerInfo, type AgentSummary } from '~/lib/api'
import { fmtDateTime, fmtRelative, fmtHashrate, fmtGiB, fmtNumber, newIdempotencyKey } from '~/lib/format'
import { commandTypeLabel, workerStatusLabel } from '~/lib/labels'

const workers = ref<WorkerInfo[]>([])
const agentsById = ref<Record<string, AgentSummary>>({})

const auth = useAuthStore()
/** VIEWER hanya-baca: tombol Run Lagi / Tahan / Lepas Tahan disembunyikan (CONTRACT-3 §1). */
const canOperate = computed(() => auth.canOperate)
const poolConfigured = ref<boolean | null>(null)
const poolTotals = ref<{ hashrate: number; worker_count: number; fetched_at: string } | null>(null)
const loading = ref(true)
const loadError = ref('')
const nowTick = ref(Date.now())
const statusFilter = ref('')
const sortBy = ref('worker_asc')
const search = ref('')
const searchBy = ref('agent')

async function load() {
  try {
    const [w, a, ov] = await Promise.all([
      api.listWorkers(),
      api.listAgents({ page: 1, page_size: 200 }),
      api.overview().catch(() => null),
    ])
    workers.value = w.items
    poolConfigured.value = w.poolConfigured ?? ov?.pool_configured ?? null
    poolTotals.value = w.poolTotals ?? null
    const map: Record<string, AgentSummary> = {}
    for (const ag of a.items) map[ag.id] = ag
    agentsById.value = map
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat daftar miner.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  const t = setInterval(() => (nowTick.value = Date.now()), 30000)
  onUnmounted(() => clearInterval(t))
})
useLiveRefresh(load)

const filtered = computed(() => {
  let rows = workers.value
  const q = search.value.trim().toLowerCase()
  if (q) {
    rows = rows.filter((w) =>
      searchBy.value === 'worker'
        ? w.name.toLowerCase().includes(q)
        : (w.agent?.name ?? '').toLowerCase().includes(q) || w.agent_id.toLowerCase().includes(q),
    )
  }
  return statusFilter.value ? rows.filter((w) => w.status === statusFilter.value) : rows
})

/** Urutan tampilan: nama worker A–Z/Z–A, nama agent A–Z/Z–A, atau tanggal
 * ditambahkan (tanggal registrasi agent-nya) terbaru/terlama. Bawaan A–Z
 * nama worker seperti urutan server. */
const sorted = computed(() => {
  const rows = [...filtered.value]
  const byName = (a: WorkerInfo, b: WorkerInfo) => a.name.localeCompare(b.name)
  const byAgent = (a: WorkerInfo, b: WorkerInfo) => (a.agent?.name ?? '').localeCompare(b.agent?.name ?? '')
  const byDate = (a: WorkerInfo, b: WorkerInfo) =>
    (a.agent?.created_at ? Date.parse(a.agent.created_at) : 0) -
    (b.agent?.created_at ? Date.parse(b.agent.created_at) : 0)
  switch (sortBy.value) {
    case 'worker_desc':
      return rows.sort((a, b) => byName(b, a))
    case 'agent_asc':
      return rows.sort(byAgent)
    case 'agent_desc':
      return rows.sort((a, b) => byAgent(b, a))
    case 'date_desc':
      return rows.sort((a, b) => byDate(b, a))
    case 'date_asc':
      return rows.sort(byDate)
    default:
      return rows.sort(byName)
  }
})

/** Ringkasan di atas tabel. Total VM & hitungan berjalan dari SEMUA worker
 * (bukan hasil filter); Total Pool datang dari server sebagai total seluruh
 * alamat di pool, bukan penjumlahan worker yang terhubung. */
const totalHashrateVm = computed(() =>
  workers.value.reduce((sum, w) => sum + (typeof w.hashrate_hs === 'number' ? w.hashrate_hs : 0), 0),
)
const runningVmCount = computed(() => workers.value.filter((w) => w.miner_service_state === 'active').length)

function agentOf(w: WorkerInfo): AgentSummary | null {
  if (w.agent) return w.agent
  return w.agent_id ? (agentsById.value[w.agent_id] ?? null) : null
}

function memOf(w: WorkerInfo): number | null {
  const v = (w as Record<string, unknown>).mem_available_gib ?? (w as Record<string, unknown>).latest_mem_gib
  return typeof v === 'number' ? v : null
}

function sessionNoOf(w: WorkerInfo): string {
  const a = agentOf(w)
  const no = a?.current_session?.session_no
  if (no !== undefined && no !== null) return `#${no}`
  const direct = (w as Record<string, unknown>).current_session_no ?? (w as Record<string, unknown>).session_no
  return typeof direct === 'number' ? `#${direct}` : '—'
}

function replacementsOf(w: WorkerInfo): number | null {
  const a = agentOf(w)
  if (a?.replacement_count !== undefined) return a.replacement_count
  const direct = (w as Record<string, unknown>).replacement_count
  return typeof direct === 'number' ? direct : null
}

function runBlocked(w: WorkerInfo): string {
  if (w.status === 'TAK_TERJANGKAU') return 'Agent tak terjangkau — perintah tidak dapat dikirim.'
  if (w.status === 'GAGAL_START') return 'Gagal start karena memori di bawah ambang — Run Lagi tidak ditawarkan.'
  return ''
}

// ---------- CONTRACT-7: hashrate snapshot runtime sebagai cadangan ----------

/** Samakan dengan BRIDGE_SILENT_SEC server (300 detik). */
const BRIDGE_SILENT_MS = 300_000

function bridgeSilent(w: WorkerInfo): boolean {
  const ls = agentOf(w)?.last_seen_at
  if (!ls) return true
  const t = Date.parse(ls)
  return Number.isNaN(t) || nowTick.value - t > BRIDGE_SILENT_MS
}

function runtimeSnapshot(w: WorkerInfo) {
  return agentOf(w)?.runtime?.snapshot ?? null
}

/** Hashrate yang ditampilkan: bridge bila segar; bila bridge diam dan ada
 * snapshot runtime, pakai angka snapshot (diberi label + umur di template). */
function useSnapshotHashrate(w: WorkerInfo): boolean {
  const snap = runtimeSnapshot(w)
  return bridgeSilent(w) && snap != null && typeof snap.hashrate_hs === 'number'
}

const runTarget = ref<WorkerInfo | null>(null)

// ---------- Fase 2: tahan / lepas tahan auto-recovery ----------
const actionNote = ref('')
const actionError = ref('')

function holdActiveOf(w: WorkerInfo): boolean {
  if (typeof w.hold_active === 'boolean') return w.hold_active
  if (w.hold_until) return new Date(w.hold_until).getTime() > nowTick.value
  return false
}

function canSend(w: WorkerInfo, type: string): boolean {
  const caps = agentOf(w)?.capabilities
  if (!caps || caps.length === 0) return true // kemampuan tidak diketahui → biarkan server memvalidasi
  return caps.includes(type)
}

type PendingHold = { worker: WorkerInfo; type: 'miner.hold' | 'miner.unhold' }
const pendingHold = ref<PendingHold | null>(null)

const holdDialogTitle = computed(() =>
  pendingHold.value?.type === 'miner.hold' ? 'Tahan Pemulihan Otomatis' : 'Lepas Tahan Pemulihan Otomatis',
)
const holdDialogMessage = computed(() => {
  if (!pendingHold.value) return ''
  const name = pendingHold.value.worker.name
  return pendingHold.value.type === 'miner.hold'
    ? `Pemulihan otomatis untuk worker ${name} akan ditahan. Miner yang mati tidak akan dipulihkan otomatis selama penahanan aktif. Perintah dikirim lewat antrian perintah dan tercatat di audit. Lanjutkan?`
    : `Penahanan pemulihan otomatis untuk worker ${name} akan dicabut. Watchdog kembali memulihkan miner secara otomatis. Lanjutkan?`
})

async function runPendingHold() {
  if (!pendingHold.value) return
  actionNote.value = ''
  actionError.value = ''
  const { worker, type } = pendingHold.value
  await api.createWorkerCommand(worker.id, {
    type,
    idempotency_key: newIdempotencyKey(),
    confirm: true,
  })
  actionNote.value = `Perintah ${commandTypeLabel(type)} untuk worker ${worker.name} berhasil dibuat dan masuk antrian. Status tahan diperbarui setelah bridge melaporkannya pada heartbeat berikutnya.`
  pendingHold.value = null
  await load()
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Miner</h1>
      <p class="mt-0.5 text-sm text-ink-400">Performa dan status setiap worker. Status utama dihitung server dari laporan runtime Muse, lalu bridge, lalu pool sebagai pembanding.</p>
    </div>

    <div
      v-if="poolConfigured === false"
      class="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <Info class="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        Pemeriksaan silang pool belum dikonfigurasi. Status worker dihitung dari laporan bridge saja;
        status Pool Stall tidak dapat dideteksi. Atur konfigurasi pool di
        <NuxtLink to="/settings" class="font-medium underline">Pengaturan</NuxtLink>.
      </p>
    </div>

    <p v-if="actionNote" class="mb-5 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{{ actionNote }}</p>
    <p v-if="actionError" class="mb-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ actionError }}</p>

    <div class="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div class="panel p-4">
        <p class="text-xs text-ink-400">Total Hashrate Pool</p>
        <p class="mt-1 text-xl font-semibold text-white">{{ poolTotals ? fmtHashrate(poolTotals.hashrate) : '—' }}</p>
        <p v-if="poolTotals" class="mt-0.5 text-[11px] text-ink-400">dari {{ poolTotals.worker_count }} worker di pool</p>
      </div>
      <div class="panel p-4">
        <p class="text-xs text-ink-400">Total Hashrate VM</p>
        <p class="mt-1 text-xl font-semibold text-white">{{ fmtHashrate(totalHashrateVm) }}</p>
      </div>
      <div class="panel p-4">
        <p class="text-xs text-ink-400">VM Menjalankan Miner</p>
        <p class="mt-1 text-xl font-semibold text-white">{{ runningVmCount }} <span class="text-sm font-normal text-ink-400">dari {{ workers.length }} VM</span></p>
      </div>
    </div>

    <div class="panel">
      <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
        <select v-model="searchBy" class="field !w-auto" title="Mode pencarian">
          <option value="agent">Cari: Agent</option>
          <option value="worker">Cari: Worker</option>
        </select>
        <div class="relative min-w-56 flex-1 sm:max-w-xs">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            v-model="search"
            type="text"
            :placeholder="searchBy === 'worker' ? 'Cari nama worker…' : 'Cari nama atau ID agent…'"
            class="field !pl-9"
          />
        </div>
        <select v-model="statusFilter" class="field !w-auto">
          <option value="">Semua Status</option>
          <option value="SEHAT">Sehat</option>
          <option value="WASPADA">Waspada</option>
          <option value="MATI">Mati</option>
          <option value="GAGAL_START">Gagal Start</option>
          <option value="TAK_TERJANGKAU">Tak Terjangkau</option>
          <option value="POOL_STALL">Pool Stall</option>
        </select>
        <select v-model="sortBy" class="field !w-auto" title="Urutan daftar worker">
          <option value="worker_asc">Nama Worker: A ke Z</option>
          <option value="worker_desc">Nama Worker: Z ke A</option>
          <option value="agent_asc">Nama Agent: A ke Z</option>
          <option value="agent_desc">Nama Agent: Z ke A</option>
          <option value="date_desc">Tanggal Ditambahkan: Terbaru</option>
          <option value="date_asc">Tanggal Ditambahkan: Terlama</option>
        </select>
        <p class="ml-auto text-xs text-ink-400">{{ filtered.length }} worker ditampilkan</p>
      </div>

      <p v-if="loadError" class="px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

      <div class="overflow-x-auto">
        <table class="table-base min-w-[1180px]">
          <thead>
            <tr>
              <th>Nama Worker</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Service</th>
              <th>Hashrate VM</th>
              <th>Hashrate Pool</th>
              <th>Share Diterima (VM)</th>
              <th>Share Ditolak (VM)</th>
              <th>Share Terakhir</th>
              <th>Memori Tersedia</th>
              <th>Sesi</th>
              <th>Penggantian VM</th>
              <th>Pemulihan Terakhir</th>
              <th class="text-right">Aksi</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && workers.length === 0">
              <td colspan="14" class="py-10 text-center text-ink-400">Memuat daftar miner…</td>
            </tr>
            <tr v-else-if="filtered.length === 0">
              <td colspan="14">
                <EmptyState message="Tidak ada worker yang cocok dengan filter ini." />
              </td>
            </tr>
            <template v-for="w in sorted" :key="w.id">
            <tr>
              <td class="font-medium text-white">{{ w.name }}</td>
              <td>
                <NuxtLink v-if="agentOf(w)" :to="`/agents/${agentOf(w)!.id}`" class="text-indigo-300 hover:text-indigo-200">
                  {{ agentOf(w)!.name }}
                </NuxtLink>
                <span v-else>—</span>
              </td>
              <td>
                <StatusChip :status="w.combined_status" kind="combined" />
                <span v-if="holdActiveOf(w)" class="mt-1 block"><HoldBadge :active="true" /></span>
                <p v-if="w.combined_status_reason" class="mt-1 max-w-52 text-xs leading-snug text-ink-400">{{ w.combined_status_reason }}</p>
                <p class="mt-1 text-[11px] leading-snug text-ink-500">Bridge/pool: {{ workerStatusLabel(w.status) }}<span v-if="w.status_reason"> — {{ w.status_reason }}</span></p>
              </td>
              <td class="font-mono text-xs">{{ w.miner_service_state || '—' }}</td>
              <td>
                <template v-if="useSnapshotHashrate(w)">
                  {{ fmtHashrate(runtimeSnapshot(w)!.hashrate_hs) }}
                  <span class="block text-[11px] leading-snug text-sky-300" :title="fmtDateTime(runtimeSnapshot(w)!.at)">Snapshot runtime · {{ fmtRelative(runtimeSnapshot(w)!.at, nowTick) }}</span>
                </template>
                <template v-else>{{ fmtHashrate(w.hashrate_hs) }}</template>
              </td>
              <td>{{ w.pool && typeof w.pool.hashrate === 'number' ? fmtHashrate(w.pool.hashrate) : '—' }}</td>
              <td class="text-emerald-400">{{ fmtNumber(w.accepted_shares) }}</td>
              <td class="text-red-400">{{ fmtNumber(w.rejected_shares) }}</td>
              <td :title="fmtDateTime(w.last_share_at)">{{ fmtRelative(w.last_share_at, nowTick) }}</td>
              <td>{{ fmtGiB(memOf(w)) }}</td>
              <td>{{ sessionNoOf(w) }}</td>
              <td>{{ replacementsOf(w) !== null ? `${replacementsOf(w)}×` : '—' }}</td>
              <td :title="fmtDateTime(w.last_recovery_at)">{{ fmtRelative(w.last_recovery_at, nowTick) }}</td>
              <td>
                <div class="flex flex-wrap items-center justify-end gap-1.5">
                  <button
                    v-if="canOperate"
                    class="btn-ghost !px-2.5 !py-1.5 text-xs"
                    :disabled="!!runBlocked(w)"
                    :title="runBlocked(w) || 'Jalankan ulang miner'"
                    @click="runTarget = w"
                  >
                    <Play class="h-3.5 w-3.5" /> Run Lagi
                  </button>
                  <button
                    v-if="canOperate && !holdActiveOf(w) && canSend(w, 'miner.hold')"
                    class="btn-ghost !px-2.5 !py-1.5 text-xs"
                    title="Tahan pemulihan otomatis untuk worker ini"
                    @click="pendingHold = { worker: w, type: 'miner.hold' }"
                  >
                    <PauseCircle class="h-3.5 w-3.5" /> Tahan
                  </button>
                  <button
                    v-if="canOperate && holdActiveOf(w) && canSend(w, 'miner.unhold')"
                    class="btn-ghost !px-2.5 !py-1.5 text-xs"
                    title="Lepas penahanan pemulihan otomatis"
                    @click="pendingHold = { worker: w, type: 'miner.unhold' }"
                  >
                    <PlayCircle class="h-3.5 w-3.5" /> Lepas Tahan
                  </button>
                  <NuxtLink
                    v-if="agentOf(w)"
                    :to="`/agents/${agentOf(w)!.id}`"
                    class="btn-ghost !px-2.5 !py-1.5 text-xs"
                    title="Buka detail agent"
                  >
                    Detail
                  </NuxtLink>
                </div>
                <p v-if="runBlocked(w)" class="mt-1 max-w-44 text-right text-[11px] leading-snug text-amber-400/90">
                  {{ runBlocked(w) }}
                </p>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <RunAgainDialog
      v-if="runTarget"
      :worker="runTarget"
      :agent-name="agentOf(runTarget)?.name"
      @close="runTarget = null"
      @done="load"
    />
    <ConfirmDialog
      v-if="pendingHold"
      :title="holdDialogTitle"
      :message="holdDialogMessage"
      :confirm-label="pendingHold.type === 'miner.hold' ? 'Ya, Tahan' : 'Ya, Lepas Tahan'"
      :on-confirm="runPendingHold"
      @close="pendingHold = null"
    />
  </div>
</template>
