<script setup lang="ts">
import { api, type AgentSummary, type WorkerInfo } from '~/lib/api'
import { fmtDuration, fmtNumber, fmtPct } from '~/lib/format'
import type { ChartPoint } from '~/components/LineChart.vue'

interface AgentAnalytics {
  agent_id?: string
  agent_name?: string
  name?: string
  uptime_pct?: number
  session_count?: number
  sessions?: number
  replacement_count?: number
  replacements?: number
  commands?: { total?: number; succeeded?: number; failed?: number; success_rate?: number }
  commands_count?: number
  command_count?: number
  commands_succeeded?: number
  commands_failed?: number
  success_rate?: number
  top_errors?: { reason: string; count: number }[]
  avg_session_lifetime_sec?: number
  [key: string]: unknown
}

interface SessionDurationDist {
  min: number | null
  median: number | null
  max: number | null
}

interface WorkerAnalytics {
  worker_id?: string
  worker_name?: string
  name?: string
  hashrate_series?: Record<string, unknown>[]
  shares?: { accepted?: number; rejected?: number }
  shares_per_session?: number | null
  last_share_intervals?: unknown
  longest_share_gap_sec?: number | null
  recoveries?: { succeeded?: number; failed?: number; failed_low_memory?: number }
  downtime_sec?: number
  mem_at_session_start?: Record<string, unknown>[]
  pool_stall_count?: number
  session_duration?: Record<string, unknown> | null
  session_durations?: Record<string, unknown> | null
  session_duration_distribution?: Record<string, unknown> | null
  [key: string]: unknown
}

const range = ref('7d')
const customFrom = ref('')
const customTo = ref('')
const filterAgent = ref('')
const filterWorker = ref('')

const agents = ref<AgentSummary[]>([])
const workers = ref<WorkerInfo[]>([])
const agentStats = ref<AgentAnalytics[]>([])
const workerStats = ref<WorkerAnalytics[]>([])
const loading = ref(true)
const loadError = ref('')

async function loadRefs() {
  try {
    const [a, w] = await Promise.all([api.listAgents({ page: 1, page_size: 200 }), api.listWorkers()])
    agents.value = a.items
    workers.value = w.items
  } catch {
    /* abaikan */
  }
}

async function load() {
  loading.value = true
  try {
    const params: Parameters<typeof api.analytics>[0] = { range: range.value }
    if (range.value === 'custom') {
      if (customFrom.value) params.from = new Date(customFrom.value).toISOString()
      if (customTo.value) params.to = new Date(customTo.value).toISOString()
    }
    if (filterAgent.value) params.agent_id = filterAgent.value
    if (filterWorker.value) params.worker_id = filterWorker.value
    const res = await api.analytics(params)
    agentStats.value = (res.agents ?? res.per_agent ?? []) as AgentAnalytics[]
    workerStats.value = (res.workers ?? res.per_worker ?? []) as WorkerAnalytics[]
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat analitik.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadRefs()
  await load()
})
useLiveRefresh(load)

watch([range, filterAgent, filterWorker], () => void load())
watch([customFrom, customTo], () => {
  if (range.value === 'custom') void load()
})

// ---------- Akses field per-agent (bentuk bersarang Fase 1 & datar Fase 2) ----------
function agentSessions(s: AgentAnalytics): number | undefined {
  return s.session_count ?? s.sessions
}
function agentReplacements(s: AgentAnalytics): number | undefined {
  return s.replacement_count ?? s.replacements
}
function agentCommandsTotal(s: AgentAnalytics): number | undefined {
  return s.commands?.total ?? s.commands_count ?? s.command_count
}
function agentCommandsSucceeded(s: AgentAnalytics): number | undefined {
  return s.commands?.succeeded ?? s.commands_succeeded
}
function agentCommandsFailed(s: AgentAnalytics): number | undefined {
  return s.commands?.failed ?? s.commands_failed
}
function agentSuccessRatePct(s: AgentAnalytics): number | undefined {
  const raw = s.commands?.success_rate ?? s.success_rate
  if (raw === undefined || raw === null || Number.isNaN(raw)) return undefined
  return raw <= 1 ? raw * 100 : raw
}

// ---------- Akses field per-worker ----------
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

/** Distribusi durasi sesi (menit) dari berbagai bentuk field yang mungkin dikembalikan server. */
function sessionDurationDist(s: WorkerAnalytics): SessionDurationDist {
  const src =
    (s.session_duration as Record<string, unknown> | null) ??
    (s.session_durations as Record<string, unknown> | null) ??
    (s.session_duration_distribution as Record<string, unknown> | null)
  if (src && typeof src === 'object') {
    return {
      min: numOrNull(src.min ?? src.min_minutes ?? src.minimum),
      median: numOrNull(src.median ?? src.median_minutes ?? src.p50),
      max: numOrNull(src.max ?? src.max_minutes ?? src.maximum),
    }
  }
  return {
    min: numOrNull(s.min_session_minutes),
    median: numOrNull(s.median_session_minutes),
    max: numOrNull(s.max_session_minutes),
  }
}

function fmtMinutes(min?: number | null): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—'
  return fmtDuration(min * 60)
}

/** Normalisasi titik deret waktu: terima {t,v} (Fase 1) maupun {at, mem_available_gib} (Fase 2). */
function seriesPoints(raw?: Record<string, unknown>[]): ChartPoint[] {
  if (!Array.isArray(raw)) return []
  const out: ChartPoint[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const t = (p.t ?? p.at) as string | undefined
    const v = numOrNull(p.v ?? p.mem_available_gib ?? p.value)
    if (t && v !== null) out.push({ t, v })
  }
  return out
}

function shareIntervalText(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return fmtDuration(v)
  if (Array.isArray(v)) {
    const nums = v.filter((x): x is number => typeof x === 'number')
    if (nums.length === 0) return '—'
    const max = Math.max(...nums)
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length
    return `Rata-rata ${fmtDuration(avg)} · terpanjang ${fmtDuration(max)}`
  }
  return String(v)
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Analitik</h1>
      <p class="mt-0.5 text-sm text-ink-400">Kinerja agent dan worker dihitung dari data nyata di basis data.</p>
    </div>

    <div class="panel mb-5 flex flex-wrap items-end gap-3 px-4 py-3">
      <div>
        <label class="mb-1 block text-xs font-medium text-ink-400">Rentang Waktu</label>
        <div class="flex overflow-hidden rounded-lg border border-ink-700">
          <button
            v-for="r in [{ v: '24h', l: '24 Jam' }, { v: '7d', l: '7 Hari' }, { v: '30d', l: '30 Hari' }, { v: 'custom', l: 'Kustom' }]"
            :key="r.v"
            class="px-3 py-2 text-sm transition-colors"
            :class="range === r.v ? 'bg-indigo-600 text-white' : 'bg-ink-850 text-ink-300 hover:bg-ink-800'"
            @click="range = r.v"
          >
            {{ r.l }}
          </button>
        </div>
      </div>
      <div v-if="range === 'custom'">
        <label class="mb-1 block text-xs font-medium text-ink-400">Dari</label>
        <input v-model="customFrom" type="datetime-local" class="field !w-auto" />
      </div>
      <div v-if="range === 'custom'">
        <label class="mb-1 block text-xs font-medium text-ink-400">Sampai</label>
        <input v-model="customTo" type="datetime-local" class="field !w-auto" />
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-ink-400">Agent</label>
        <select v-model="filterAgent" class="field !w-auto">
          <option value="">Semua Agent</option>
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-ink-400">Worker</label>
        <select v-model="filterWorker" class="field !w-auto">
          <option value="">Semua Worker</option>
          <option v-for="w in workers" :key="w.id" :value="w.id">{{ w.name }}</option>
        </select>
      </div>
    </div>

    <p v-if="loadError" class="mb-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ loadError }}</p>
    <div v-if="loading && agentStats.length === 0 && workerStats.length === 0" class="py-14 text-center text-sm text-ink-400">
      Memuat analitik…
    </div>

    <template v-else>
      <!-- Analitik Agent -->
      <h2 class="mb-3 text-sm font-semibold text-white">Analitik per Agent</h2>
      <div class="panel mb-6">
        <EmptyState v-if="agentStats.length === 0" message="Tidak ada data agent pada rentang ini." />
        <div v-else class="overflow-x-auto">
          <table class="table-base min-w-[880px]">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Uptime</th>
                <th>Jumlah Sesi</th>
                <th>Penggantian VM</th>
                <th>Rata-rata Umur Sesi</th>
                <th>Perintah (Total/Berhasil/Gagal)</th>
                <th>Tingkat Keberhasilan</th>
                <th>Error Terbanyak</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in agentStats" :key="s.agent_id ?? i">
                <td class="font-medium text-white">{{ s.agent_name ?? s.name ?? s.agent_id ?? '—' }}</td>
                <td>{{ fmtPct(s.uptime_pct) }}</td>
                <td>{{ fmtNumber(agentSessions(s)) }}</td>
                <td>{{ fmtNumber(agentReplacements(s)) }}×</td>
                <td>{{ fmtDuration(s.avg_session_lifetime_sec) }}</td>
                <td>
                  {{ fmtNumber(agentCommandsTotal(s)) }} /
                  <span class="text-emerald-400">{{ fmtNumber(agentCommandsSucceeded(s)) }}</span> /
                  <span class="text-red-400">{{ fmtNumber(agentCommandsFailed(s)) }}</span>
                </td>
                <td>{{ fmtPct(agentSuccessRatePct(s)) }}</td>
                <td>
                  <ul v-if="s.top_errors && s.top_errors.length" class="space-y-0.5 text-xs">
                    <li v-for="(e, j) in s.top_errors.slice(0, 3)" :key="j" class="max-w-56 truncate" :title="e.reason">
                      {{ e.reason }} <span class="text-ink-400">({{ e.count }}×)</span>
                    </li>
                  </ul>
                  <span v-else class="text-ink-400">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Analitik Worker -->
      <h2 class="mb-3 text-sm font-semibold text-white">Analitik per Worker</h2>
      <div class="panel mb-6">
        <EmptyState v-if="workerStats.length === 0" message="Tidak ada data worker pada rentang ini." />
        <div v-else class="overflow-x-auto">
          <table class="table-base min-w-[980px]">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Durasi Sesi — Min</th>
                <th>Durasi Sesi — Median</th>
                <th>Durasi Sesi — Maks</th>
                <th>Share per Sesi (Rata-rata)</th>
                <th>Jeda Share Terpanjang</th>
                <th>Recovery Berhasil</th>
                <th>Recovery Gagal</th>
                <th>di antaranya Gagal Memori Rendah</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in workerStats" :key="s.worker_id ?? i">
                <td class="font-medium text-white">{{ s.worker_name ?? s.name ?? s.worker_id ?? '—' }}</td>
                <td>{{ fmtMinutes(sessionDurationDist(s).min) }}</td>
                <td>{{ fmtMinutes(sessionDurationDist(s).median) }}</td>
                <td>{{ fmtMinutes(sessionDurationDist(s).max) }}</td>
                <td>{{ s.shares_per_session === null || s.shares_per_session === undefined ? '—' : fmtNumber(s.shares_per_session, 1) }}</td>
                <td>{{ fmtDuration(s.longest_share_gap_sec) }}</td>
                <td class="text-emerald-400">{{ fmtNumber(s.recoveries?.succeeded) }}</td>
                <td class="text-red-400">{{ fmtNumber(s.recoveries?.failed) }}</td>
                <td class="text-orange-300">{{ fmtNumber(s.recoveries?.failed_low_memory) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Grafik per Worker -->
      <h2 class="mb-3 text-sm font-semibold text-white">Grafik per Worker</h2>
      <EmptyState v-if="workerStats.length === 0" message="Tidak ada data worker pada rentang ini." />
      <div v-else class="grid gap-5 lg:grid-cols-2">
        <section v-for="(s, i) in workerStats" :key="s.worker_id ?? i" class="panel p-5">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-white">{{ s.worker_name ?? s.name ?? s.worker_id ?? 'Worker' }}</h3>
            <span class="text-xs text-ink-400">Pool stall: {{ fmtNumber(s.pool_stall_count) }}×</span>
          </div>

          <p class="mb-1 mt-4 text-xs font-medium text-ink-400">Tren Hashrate (H/s)</p>
          <LineChart :points="seriesPoints(s.hashrate_series)" color="#818cf8" unit=" H/s" />

          <p class="mb-1 mt-4 text-xs font-medium text-ink-400">Tren Memori Tersedia Saat Sesi Dimulai (GiB)</p>
          <LineChart :points="seriesPoints(s.mem_at_session_start)" color="#34d399" :height="90" unit=" GiB" />

          <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
            <div>
              <p class="text-xs text-ink-400">Share Diterima / Ditolak</p>
              <p class="mt-1 font-medium">
                <span class="text-emerald-400">{{ fmtNumber(s.shares?.accepted) }}</span>
                <span class="text-ink-400"> / </span>
                <span class="text-red-400">{{ fmtNumber(s.shares?.rejected) }}</span>
              </p>
            </div>
            <div>
              <p class="text-xs text-ink-400">Pemulihan Berhasil / Gagal</p>
              <p class="mt-1 font-medium">
                <span class="text-emerald-400">{{ fmtNumber(s.recoveries?.succeeded) }}</span>
                <span class="text-ink-400"> / </span>
                <span class="text-red-400">{{ fmtNumber(s.recoveries?.failed) }}</span>
                <span v-if="s.recoveries?.failed_low_memory" class="block text-xs font-normal text-orange-300">
                  {{ fmtNumber(s.recoveries.failed_low_memory) }}× gagal karena memori rendah
                </span>
              </p>
            </div>
            <div>
              <p class="text-xs text-ink-400">Total Waktu Mati (Downtime)</p>
              <p class="mt-1 font-medium text-white">{{ fmtDuration(s.downtime_sec) }}</p>
            </div>
            <div>
              <p class="text-xs text-ink-400">Jeda Share</p>
              <p class="mt-1 font-medium text-white">{{ shareIntervalText(s.last_share_intervals) }}</p>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
