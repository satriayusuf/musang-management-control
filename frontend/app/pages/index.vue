<script setup lang="ts">
import {
  Bot,
  Wifi,
  Hammer,
  Moon,
  TriangleAlert,
  WifiOff,
  Pickaxe,
  HeartPulse,
  Skull,
  TerminalSquare,
  Info,
  ArrowRight,
} from 'lucide-vue-next'
import { api, type OverviewData, type AlertInfo } from '~/lib/api'
import { fmtDateTime, fmtRelative } from '~/lib/format'
import { WORKER_STATUSES, workerStatusLabel, eventTypeLabel } from '~/lib/labels'

const overview = ref<OverviewData | null>(null)
const loading = ref(true)
const loadError = ref('')
const nowTick = ref(Date.now())

async function load() {
  try {
    overview.value = await api.overview()
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat ringkasan.'
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

const distTotal = computed(() => {
  const d = overview.value?.worker_status_distribution ?? {}
  return WORKER_STATUSES.reduce((acc, s) => acc + (d[s] ?? 0), 0)
})

function distPct(status: string): number {
  const total = distTotal.value
  if (!total) return 0
  return Math.round(((overview.value?.worker_status_distribution?.[status] ?? 0) / total) * 100)
}

const DIST_COLORS: Record<string, string> = {
  SEHAT: 'bg-emerald-400',
  WASPADA: 'bg-amber-400',
  MATI: 'bg-red-400',
  GAGAL_START: 'bg-orange-400',
  TAK_TERJANGKAU: 'bg-zinc-400',
  POOL_STALL: 'bg-violet-400',
}

const AGENT_HEALTH_COLORS: Record<string, string> = {
  online: 'bg-emerald-400',
  working: 'bg-indigo-400',
  idle: 'bg-sky-400',
  warning: 'bg-amber-400',
  unreachable: 'bg-red-400',
}

function alertLink(alert: AlertInfo): string {
  if (alert.action && alert.action.startsWith('/')) return alert.action
  if (alert.agent_id) return `/agents/${alert.agent_id}`
  return '/miners'
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-white">Ringkasan</h1>
        <p class="mt-0.5 text-sm text-ink-400">Kondisi seluruh agent, miner, dan perintah dalam satu pandangan.</p>
      </div>
      <p v-if="overview" class="text-xs text-ink-400">Data diperbarui secara real-time dari server.</p>
    </div>

    <div
      v-if="overview && overview.pool_configured === false"
      class="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <Info class="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        Pemeriksaan silang pool belum dikonfigurasi. Status worker saat ini dihitung hanya dari
        laporan bridge, tanpa verifikasi data pool. Atur di
        <NuxtLink to="/settings" class="font-medium underline">Pengaturan</NuxtLink>.
      </p>
    </div>

    <p v-if="loadError" class="mb-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

    <div v-if="loading && !overview" class="py-16 text-center text-sm text-ink-400">Memuat ringkasan…</div>

    <template v-else-if="overview">
      <!-- Kartu metrik -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard title="Total Agent" :value="overview.agents.total" :icon="Bot" accent="bg-ink-800 text-ink-200" />
        <MetricCard title="Agent Online" :value="overview.agents.online" :icon="Wifi" accent="bg-emerald-500/10 text-emerald-400" />
        <MetricCard title="Agent Bekerja" :value="overview.agents.working" :icon="Hammer" accent="bg-indigo-500/10 text-indigo-400" />
        <MetricCard title="Agent Idle" :value="overview.agents.idle" :icon="Moon" accent="bg-sky-500/10 text-sky-400" />
        <MetricCard title="Agent Waspada" :value="overview.agents.warning" :icon="TriangleAlert" accent="bg-amber-500/10 text-amber-400" />
        <MetricCard title="Agent Tak Terjangkau" :value="overview.agents.unreachable" :icon="WifiOff" accent="bg-red-500/10 text-red-400" />
        <MetricCard title="Total Miner" :value="overview.miners.total" :icon="Pickaxe" accent="bg-ink-800 text-ink-200" />
        <MetricCard title="Miner Sehat" :value="overview.miners.healthy" :icon="HeartPulse" accent="bg-emerald-500/10 text-emerald-400" />
        <MetricCard title="Miner Mati" :value="overview.miners.dead" :icon="Skull" accent="bg-red-500/10 text-red-400" />
        <MetricCard title="Perintah Aktif" :value="overview.active_commands" :icon="TerminalSquare" accent="bg-violet-500/10 text-violet-400" />
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <!-- Kesehatan Agent -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Kesehatan Agent</h2>
          <p class="mt-0.5 text-xs text-ink-400">Distribusi kondisi agent berdasarkan heartbeat dan status worker.</p>
          <div class="mt-4 space-y-3">
            <div v-for="key in (['online', 'working', 'idle', 'warning', 'unreachable'] as const)" :key="key">
              <div class="flex items-center justify-between text-sm">
                <span class="text-ink-300">
                  {{ { online: 'Online', working: 'Bekerja', idle: 'Idle', warning: 'Waspada', unreachable: 'Tak Terjangkau' }[key] }}
                </span>
                <span class="font-medium text-white">{{ overview.agents[key] }}</span>
              </div>
              <div class="mt-1 h-2 overflow-hidden rounded-full bg-ink-800">
                <div
                  class="h-full rounded-full transition-all"
                  :class="AGENT_HEALTH_COLORS[key]"
                  :style="{ width: overview.agents.total ? `${(overview.agents[key] / overview.agents.total) * 100}%` : '0%' }"
                />
              </div>
            </div>
          </div>
        </section>

        <!-- Kesehatan Worker -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Kesehatan Worker</h2>
          <p class="mt-0.5 text-xs text-ink-400">Distribusi enam status worker dari mesin aturan status server.</p>
          <div class="mt-4 space-y-3">
            <div v-for="status in WORKER_STATUSES" :key="status">
              <div class="flex items-center justify-between text-sm">
                <span class="flex items-center gap-2 text-ink-300">
                  <span class="h-2 w-2 rounded-full" :class="DIST_COLORS[status]" />
                  {{ workerStatusLabel(status) }}
                </span>
                <span class="font-medium text-white">
                  {{ overview.worker_status_distribution?.[status] ?? 0 }}
                  <span class="text-xs font-normal text-ink-400">({{ distPct(status) }}%)</span>
                </span>
              </div>
              <div class="mt-1 h-2 overflow-hidden rounded-full bg-ink-800">
                <div
                  class="h-full rounded-full transition-all"
                  :class="DIST_COLORS[status]"
                  :style="{ width: `${distPct(status)}%` }"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <!-- Peringatan Aktif -->
        <section class="panel p-5">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-white">Peringatan Aktif</h2>
            <span class="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-400">
              {{ overview.active_alerts.length }} peringatan
            </span>
          </div>
          <EmptyState
            v-if="overview.active_alerts.length === 0"
            message="Tidak ada peringatan aktif. Semua sistem berjalan normal."
          />
          <ul v-else class="mt-3 divide-y divide-ink-800">
            <li v-for="(alert, i) in overview.active_alerts" :key="i" class="py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-white">
                    {{ alert.worker_name || alert.agent_name || 'Sistem' }}
                    <span class="ml-1 text-xs font-normal text-ink-400">{{ eventTypeLabel(alert.type) }}</span>
                  </p>
                  <p v-if="alert.agent_name && alert.worker_name" class="text-xs text-ink-400">Agent: {{ alert.agent_name }}</p>
                  <p class="mt-1 text-sm text-ink-300">{{ alert.reason || '—' }}</p>
                  <p class="mt-1 text-xs text-ink-400">{{ alert.at ? `${fmtRelative(alert.at, nowTick)} · ${fmtDateTime(alert.at)}` : '' }}</p>
                </div>
                <NuxtLink :to="alertLink(alert)" class="btn-ghost shrink-0 !px-2.5 !py-1.5 text-xs">
                  Tindak Lanjut
                  <ArrowRight class="h-3.5 w-3.5" />
                </NuxtLink>
              </div>
            </li>
          </ul>
        </section>

        <!-- Peristiwa Terbaru -->
        <section class="panel p-5">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-white">Peristiwa Terbaru</h2>
            <NuxtLink to="/events" class="text-xs font-medium text-indigo-400 hover:text-indigo-300">Lihat Semua</NuxtLink>
          </div>
          <EmptyState v-if="overview.recent_events.length === 0" message="Belum ada peristiwa tercatat." />
          <ul v-else class="mt-3 divide-y divide-ink-800">
            <li v-for="ev in overview.recent_events" :key="ev.id" class="py-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-ink-100">{{ eventTypeLabel(ev.type) }}</p>
                  <p class="truncate text-sm text-ink-400">{{ ev.description || '—' }}</p>
                </div>
                <p class="shrink-0 text-xs text-ink-400" :title="fmtDateTime(ev.created_at)">
                  {{ fmtRelative(ev.created_at, nowTick) }}
                </p>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
