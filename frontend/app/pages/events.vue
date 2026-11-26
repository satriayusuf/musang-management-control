<script setup lang="ts">
import { api, type AgentSummary, type WorkerInfo, type EventInfo } from '~/lib/api'
import { fmtDateTime } from '~/lib/format'
import { EVENT_TYPES, eventTypeLabel } from '~/lib/labels'

const events = ref<EventInfo[]>([])
const agents = ref<AgentSummary[]>([])
const workers = ref<WorkerInfo[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 25
const loading = ref(true)
const loadError = ref('')

const filterAgent = ref('')
const filterWorker = ref('')
const filterType = ref('')
const filterOutcome = ref('')
const filterFrom = ref('')
const filterTo = ref('')

function toIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

async function loadRefs() {
  try {
    const [a, w] = await Promise.all([
      api.listAgents({ page: 1, page_size: 200 }),
      api.listWorkers(),
    ])
    agents.value = a.items
    workers.value = w.items
  } catch {
    /* filter tetap bisa dipakai tanpa daftar referensi */
  }
}

async function load() {
  loading.value = true
  try {
    const res = await api.listEvents({
      agent_id: filterAgent.value || undefined,
      worker_id: filterWorker.value || undefined,
      type: filterType.value || undefined,
      outcome: filterOutcome.value || undefined,
      from: toIso(filterFrom.value),
      to: toIso(filterTo.value),
      page: page.value,
      page_size: pageSize,
    })
    events.value = res.items
    total.value = res.total
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat peristiwa.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadRefs()
  await load()
})
useLiveRefresh(load)

watch([filterAgent, filterWorker, filterType, filterOutcome, filterFrom, filterTo], () => {
  page.value = 1
  void load()
})

const agentNames = computed(() => {
  const map: Record<string, string> = {}
  for (const a of agents.value) map[a.id] = a.name
  return map
})
const workerNames = computed(() => {
  const map: Record<string, string> = {}
  for (const w of workers.value) map[w.id] = w.name
  return map
})

function dotColor(type: string): string {
  if (type === 'VM_REPLACED') return 'bg-violet-400'
  if (type === 'RECOVERY' || type === 'COMMAND_SUCCEEDED' || type === 'AGENT_RECONNECTED') return 'bg-emerald-400'
  if (type === 'RECOVERY_FAILED' || type === 'COMMAND_FAILED' || type === 'AGENT_UNREACHABLE' || type === 'POOL_STALL') return 'bg-red-400'
  if (type === 'AGENT_REGISTERED' || type === 'REBOOT') return 'bg-sky-400'
  return 'bg-ink-400'
}

function resetFilters() {
  filterAgent.value = ''
  filterWorker.value = ''
  filterType.value = ''
  filterOutcome.value = ''
  filterFrom.value = ''
  filterTo.value = ''
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Event & Pemulihan</h1>
      <p class="mt-0.5 text-sm text-ink-400">Linimasa kronologis seluruh peristiwa sistem, penggantian VM, dan riwayat pemulihan.</p>
    </div>

    <div class="panel">
      <div class="flex flex-wrap items-end gap-3 border-b border-ink-700 px-4 py-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Agent</label>
          <select v-model="filterAgent" class="field !w-auto !py-1.5 text-xs">
            <option value="">Semua Agent</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Worker</label>
          <select v-model="filterWorker" class="field !w-auto !py-1.5 text-xs">
            <option value="">Semua Worker</option>
            <option v-for="w in workers" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Tipe Event</label>
          <select v-model="filterType" class="field !w-auto !py-1.5 text-xs">
            <option value="">Semua Tipe</option>
            <option v-for="t in EVENT_TYPES" :key="t" :value="t">{{ eventTypeLabel(t) }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Hasil</label>
          <select v-model="filterOutcome" class="field !w-auto !py-1.5 text-xs">
            <option value="">Semua Hasil</option>
            <option value="success">Berhasil</option>
            <option value="failure">Gagal</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Dari Tanggal</label>
          <input v-model="filterFrom" type="datetime-local" class="field !w-auto !py-1.5 text-xs" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-ink-400">Sampai Tanggal</label>
          <input v-model="filterTo" type="datetime-local" class="field !w-auto !py-1.5 text-xs" />
        </div>
        <button class="btn-ghost !py-1.5 text-xs" @click="resetFilters">Atur Ulang</button>
      </div>

      <p v-if="loadError" class="px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

      <div class="px-5 py-4">
        <p v-if="loading && events.length === 0" class="py-8 text-center text-sm text-ink-400">Memuat peristiwa…</p>
        <EmptyState v-else-if="events.length === 0" message="Tidak ada peristiwa yang cocok dengan filter." />
        <ol v-else>
          <li v-for="ev in events" :key="ev.id" class="relative border-l border-ink-700 pb-5 pl-6 last:pb-1">
            <span class="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-ink-900" :class="dotColor(ev.type)" />
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-medium text-white">
                {{ eventTypeLabel(ev.type) }}
                <span class="ml-1 font-mono text-[11px] font-normal text-ink-400">{{ ev.type }}</span>
              </p>
              <p class="text-xs text-ink-400">{{ fmtDateTime(ev.created_at) }}</p>
            </div>
            <p class="mt-0.5 text-sm text-ink-300">{{ ev.description || '—' }}</p>
            <p class="mt-1 flex flex-wrap gap-x-4 text-xs text-ink-400">
              <span v-if="ev.agent_id">
                Agent:
                <NuxtLink :to="`/agents/${ev.agent_id}`" class="text-indigo-300 hover:text-indigo-200">
                  {{ agentNames[ev.agent_id] ?? ev.agent_id }}
                </NuxtLink>
              </span>
              <span v-if="ev.worker_id">Worker: {{ workerNames[ev.worker_id] ?? ev.worker_id }}</span>
            </p>
          </li>
        </ol>
      </div>

      <div class="px-4">
        <Pagination :page="page" :page-size="pageSize" :total="total" @change="(p) => { page = p; load() }" />
      </div>
    </div>
  </div>
</template>
