<script setup lang="ts">
import { Send, LoaderCircle, Megaphone, LayoutTemplate, Pencil, Trash2, Plus, RefreshCw, ChevronDown, ChevronRight } from 'lucide-vue-next'
import {
  api,
  batchStatusCounts,
  type AgentSummary,
  type BatchInfo,
  type BroadcastResult,
  type CommandInfo,
  type CommandTemplateInfo,
} from '~/lib/api'
import { fmtDateTime, newIdempotencyKey } from '~/lib/format'
import {
  COMMAND_TYPES,
  COMMAND_STATUSES,
  commandStatusLabel,
  commandSourceLabel,
  commandTypeLabel,
} from '~/lib/labels'

const route = useRoute()

const auth = useAuthStore()
/** VIEWER hanya-baca: form perintah, broadcast, dan kelola template disembunyikan (CONTRACT-3 §1). */
const canOperate = computed(() => auth.canOperate)

// ---------- Data referensi ----------
const agents = ref<AgentSummary[]>([])
const templates = ref<CommandTemplateInfo[]>([])

const agentNames = computed(() => {
  const map: Record<string, string> = {}
  for (const a of agents.value) map[a.id] = a.name
  return map
})

function templateName(id?: string | null): string {
  if (!id) return ''
  return templates.value.find((t) => t.id === id)?.name ?? id
}

async function loadAgents() {
  try {
    const res = await api.listAgents({ page: 1, page_size: 200 })
    agents.value = res.items
    const preset = typeof route.query.agent === 'string' ? route.query.agent : ''
    if (preset && agents.value.some((a) => a.id === preset)) {
      formAgentId.value = preset
    } else if (!formAgentId.value && agents.value.length > 0) {
      formAgentId.value = agents.value[0].id
    }
  } catch {
    /* daftar agent gagal dimuat; form tetap dirender */
  }
}

async function loadTemplates() {
  try {
    templates.value = await api.listTemplates()
  } catch {
    /* template gagal dimuat; picker tetap menyediakan mode manual */
  }
}

// ---------- Form buat perintah ----------
const targetMode = ref<'single' | 'broadcast'>('single')
const formAgentId = ref('')
const selectedAgentIds = ref<string[]>([])
const formTemplateId = ref('')
const formType = ref('miner.status')
const formPayload = ref('')
const formConfirm = ref(false)
const formError = ref('')
const formSuccess = ref('')
const submitting = ref(false)

const selectedTemplate = computed(() => templates.value.find((t) => t.id === formTemplateId.value) ?? null)
const effectiveType = computed(() => selectedTemplate.value?.type ?? formType.value)
const selectedTypeMeta = computed(() => COMMAND_TYPES.find((t) => t.value === effectiveType.value))
const isSensitive = computed(() => {
  if (selectedTemplate.value?.sensitive !== undefined) return !!selectedTemplate.value.sensitive
  return !!selectedTypeMeta.value?.sensitive
})

const selectedAgent = computed(() => agents.value.find((a) => a.id === formAgentId.value) ?? null)
const selectedWorker = computed(() => selectedAgent.value?.worker ?? null)
const capabilityOk = computed(() => {
  const caps = selectedAgent.value?.capabilities
  if (!caps || caps.length === 0) return true // kemampuan tidak diketahui → biarkan server memvalidasi
  return caps.includes(effectiveType.value)
})

watch(formTemplateId, () => {
  const t = selectedTemplate.value
  if (!t) return
  formType.value = t.type
  if (targetMode.value === 'single') {
    formPayload.value = t.payload ? JSON.stringify(t.payload, null, 2) : ''
  }
})

function toggleAllAgents(select: boolean) {
  selectedAgentIds.value = select ? agents.value.map((a) => a.id) : []
}

function parsePayload(): Record<string, unknown> | undefined | null {
  if (!formPayload.value.trim()) return undefined
  try {
    const parsed = JSON.parse(formPayload.value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function submitSingle() {
  if (!selectedAgent.value) {
    formError.value = 'Pilih agent tujuan terlebih dahulu.'
    return
  }
  if (!selectedWorker.value) {
    formError.value = 'Agent ini belum memiliki worker, sehingga perintah miner tidak dapat dibuat.'
    return
  }
  const payload = parsePayload()
  if (payload === null) {
    formError.value = 'Payload harus berupa JSON objek yang valid, atau kosongkan bila tidak diperlukan.'
    return
  }
  if (isSensitive.value && !formConfirm.value) {
    formError.value = 'Perintah ini bersifat sensitif. Centang konfirmasi untuk melanjutkan.'
    return
  }
  submitting.value = true
  try {
    const cmd = await api.createWorkerCommand(selectedWorker.value.id, {
      type: effectiveType.value,
      payload,
      idempotency_key: newIdempotencyKey(),
      confirm: isSensitive.value ? true : undefined,
      template_id: selectedTemplate.value?.id,
    })
    formSuccess.value = `Perintah ${commandTypeLabel(cmd.type)} untuk ${selectedAgent.value.name} berhasil dibuat dengan status ${commandStatusLabel(cmd.status)}.`
    formPayload.value = ''
    formConfirm.value = false
    page.value = 1
    await loadCommands()
  } catch (e) {
    formError.value = e instanceof Error ? e.message : 'Gagal membuat perintah.'
  } finally {
    submitting.value = false
  }
}

// ---------- Broadcast ----------
const lastBroadcast = ref<BroadcastResult | null>(null)
const broadcastConfirmOpen = ref(false)

const broadcastSummaryText = computed(() => {
  const typeLabel = commandTypeLabel(effectiveType.value)
  const tpl = selectedTemplate.value ? ` dari template "${selectedTemplate.value.name}"` : ''
  return `Perintah ${typeLabel}${tpl} akan dikirim ke ${selectedAgentIds.value.length} agent terpilih. Agent yang tidak memenuhi syarat (kemampuan/status) akan dilewati oleh server dan alasannya dilaporkan. Lanjutkan?`
})

async function doBroadcast() {
  submitting.value = true
  try {
    const res = await api.broadcast({
      ...(selectedTemplate.value ? { template_id: selectedTemplate.value.id } : { type: formType.value }),
      agent_ids: [...selectedAgentIds.value],
      confirm: isSensitive.value ? true : undefined,
      idempotency_key: newIdempotencyKey(),
    })
    lastBroadcast.value = res
    formSuccess.value = `Broadcast terkirim: ${res.created.length} perintah dibuat, ${res.skipped.length} agent dilewati.`
    await Promise.all([loadCommands(), loadBatches()])
    if (res.batch_id) void expandBatch(res.batch_id)
  } catch (e) {
    formError.value = e instanceof Error ? e.message : 'Gagal mengirim broadcast.'
  } finally {
    submitting.value = false
  }
}

function submitBroadcast() {
  if (selectedAgentIds.value.length === 0) {
    formError.value = 'Pilih minimal satu agent tujuan broadcast.'
    return
  }
  if (isSensitive.value) {
    broadcastConfirmOpen.value = true
  } else {
    void doBroadcast()
  }
}

function submitCommand() {
  if (submitting.value) return
  formError.value = ''
  formSuccess.value = ''
  if (targetMode.value === 'broadcast') {
    submitBroadcast()
  } else {
    void submitSingle()
  }
}

// ---------- Batch broadcast ----------
const batches = ref<BatchInfo[]>([])
const batchesLoading = ref(false)
const expandedBatchId = ref('')
const batchCommands = ref<CommandInfo[]>([])
const batchDetailLoading = ref(false)

async function loadBatches() {
  batchesLoading.value = true
  try {
    const res = await api.listBatches({ page: 1, page_size: 20 })
    batches.value = res.items
  } catch {
    /* daftar batch gagal dimuat; abaikan agar halaman tetap berguna */
  } finally {
    batchesLoading.value = false
  }
}

async function expandBatch(id: string) {
  if (expandedBatchId.value === id) {
    expandedBatchId.value = ''
    batchCommands.value = []
    return
  }
  expandedBatchId.value = id
  batchDetailLoading.value = true
  try {
    const res = await api.getBatch(id)
    batchCommands.value = res.commands
    const idx = batches.value.findIndex((b) => b.id === id)
    if (idx >= 0) batches.value[idx] = { ...batches.value[idx], ...res.batch }
  } catch {
    batchCommands.value = []
  } finally {
    batchDetailLoading.value = false
  }
}

async function refreshExpandedBatch() {
  if (!expandedBatchId.value) return
  const id = expandedBatchId.value
  try {
    const res = await api.getBatch(id)
    batchCommands.value = res.commands
    const idx = batches.value.findIndex((b) => b.id === id)
    if (idx >= 0) batches.value[idx] = { ...batches.value[idx], ...res.batch }
  } catch {
    /* abaikan */
  }
}

const TERMINAL_COMMAND_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'EXPIRED']
const hasActiveBatch = computed(() =>
  batches.value.some((b) => {
    const counts = batchStatusCounts(b)
    return Object.entries(counts).some(([s, n]) => n > 0 && !TERMINAL_COMMAND_STATUSES.includes(s))
  }),
)

function batchCountChips(b: BatchInfo): { status: string; count: number }[] {
  const counts = batchStatusCounts(b)
  return COMMAND_STATUSES.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({ status: s, count: counts[s] }))
}

// ---------- Kelola template ----------
const tplModalOpen = ref(false)
const tplFormError = ref('')
const tplSaving = ref(false)
const tplForm = ref<{ id: string | null; name: string; type: string; payload: string; description: string }>({
  id: null,
  name: '',
  type: 'miner.status',
  payload: '',
  description: '',
})
const tplDeleteTarget = ref<CommandTemplateInfo | null>(null)

function openCreateTemplate() {
  tplForm.value = { id: null, name: '', type: 'miner.status', payload: '', description: '' }
  tplFormError.value = ''
  tplModalOpen.value = true
}

function openEditTemplate(t: CommandTemplateInfo) {
  tplForm.value = {
    id: t.id,
    name: t.name,
    type: t.type,
    payload: t.payload ? JSON.stringify(t.payload, null, 2) : '',
    description: t.description ?? '',
  }
  tplFormError.value = ''
  tplModalOpen.value = true
}

async function saveTemplate() {
  if (tplSaving.value) return
  tplFormError.value = ''
  if (!tplForm.value.name.trim()) {
    tplFormError.value = 'Nama template wajib diisi.'
    return
  }
  let payload: Record<string, unknown> | undefined
  if (tplForm.value.payload.trim()) {
    try {
      const parsed = JSON.parse(tplForm.value.payload)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bukan objek')
      payload = parsed as Record<string, unknown>
    } catch {
      tplFormError.value = 'Payload harus berupa JSON objek yang valid, atau kosongkan.'
      return
    }
  }
  tplSaving.value = true
  try {
    if (tplForm.value.id) {
      await api.updateTemplate(tplForm.value.id, {
        name: tplForm.value.name.trim(),
        type: tplForm.value.type,
        payload,
        description: tplForm.value.description.trim(),
      })
    } else {
      await api.createTemplate({
        name: tplForm.value.name.trim(),
        type: tplForm.value.type,
        payload,
        description: tplForm.value.description.trim() || undefined,
      })
    }
    tplModalOpen.value = false
    await loadTemplates()
  } catch (e) {
    tplFormError.value = e instanceof Error ? e.message : 'Gagal menyimpan template.'
  } finally {
    tplSaving.value = false
  }
}

async function doDeleteTemplate() {
  if (!tplDeleteTarget.value) return
  const id = tplDeleteTarget.value.id
  await api.deleteTemplate(id)
  if (formTemplateId.value === id) formTemplateId.value = ''
  tplDeleteTarget.value = null
  await loadTemplates()
}

function templateSensitive(t: CommandTemplateInfo): boolean {
  if (t.sensitive !== undefined) return !!t.sensitive
  return !!COMMAND_TYPES.find((x) => x.value === t.type)?.sensitive
}

// ---------- Tabel antrian & riwayat ----------
const commands = ref<CommandInfo[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(true)
const loadError = ref('')
const filterAgent = ref('')
const filterStatus = ref('')
const filterType = ref('')

async function loadCommands() {
  loading.value = true
  try {
    const res = await api.listCommands({
      agent_id: filterAgent.value || undefined,
      status: filterStatus.value || undefined,
      type: filterType.value || undefined,
      page: page.value,
      page_size: pageSize,
    })
    commands.value = res.items
    total.value = res.total
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat daftar perintah.'
  } finally {
    loading.value = false
  }
}

async function refreshAll() {
  await Promise.all([loadCommands(), loadBatches(), refreshExpandedBatch()])
}

onMounted(async () => {
  await Promise.all([loadAgents(), loadTemplates()])
  const preset = typeof route.query.agent === 'string' ? route.query.agent : ''
  if (preset) filterAgent.value = preset
  await Promise.all([loadCommands(), loadBatches()])
  // Polling ringan selama masih ada batch yang berjalan.
  const t = setInterval(() => {
    if (hasActiveBatch.value) void refreshAll()
  }, 10000)
  onUnmounted(() => clearInterval(t))
})
useLiveRefresh(refreshAll)

watch([filterAgent, filterStatus, filterType], () => {
  page.value = 1
  void loadCommands()
})

function resultText(c: CommandInfo): string {
  if (c.error_reason) return c.error_reason
  if (c.status === 'SUCCEEDED') return 'Selesai dan terverifikasi'
  if (c.result && typeof c.result === 'object') {
    const r = c.result as Record<string, unknown>
    if (typeof r.output === 'string' && r.output) return r.output
    if (typeof r.message === 'string' && r.message) return r.message
  }
  if (typeof c.result === 'string' && c.result) return c.result
  return '—'
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Pusat Perintah</h1>
      <p class="mt-0.5 text-sm text-ink-400">
        Semua perintah melewati antrian yang sama dan tercatat di audit. Perintah yang tidak diambil
        agent akan kedaluwarsa sesuai batas waktu (TTL) pada Pengaturan.
      </p>
    </div>

    <div class="grid gap-5 xl:grid-cols-3">
      <!-- Kolom kiri: form + hasil broadcast -->
      <div class="space-y-5">
        <section v-if="!canOperate" class="panel h-fit p-5">
          <h2 class="text-sm font-semibold text-white">Perintah Baru</h2>
          <p class="mt-2 text-xs leading-relaxed text-ink-400">
            Peran Penonton bersifat hanya-baca — membuat perintah, broadcast, dan mengelola template
            membutuhkan peran Operator atau Administrator.
          </p>
        </section>
        <section v-if="canOperate" class="panel h-fit p-5">
          <h2 class="text-sm font-semibold text-white">Perintah Baru</h2>

          <!-- Mode target -->
          <div class="mt-4">
            <span class="mb-1.5 block text-sm font-medium text-ink-300">Mode Target</span>
            <div class="flex overflow-hidden rounded-lg border border-ink-700">
              <button
                type="button"
                class="flex-1 px-3 py-2 text-sm transition-colors"
                :class="targetMode === 'single' ? 'bg-indigo-600 text-white' : 'bg-ink-850 text-ink-300 hover:bg-ink-800'"
                @click="targetMode = 'single'"
              >
                Satu Agent
              </button>
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-sm transition-colors"
                :class="targetMode === 'broadcast' ? 'bg-indigo-600 text-white' : 'bg-ink-850 text-ink-300 hover:bg-ink-800'"
                @click="targetMode = 'broadcast'"
              >
                <Megaphone class="h-3.5 w-3.5" /> Broadcast
              </button>
            </div>
          </div>

          <form class="mt-4 space-y-4" @submit.prevent="submitCommand">
            <!-- Template -->
            <div>
              <label for="cmd-template" class="mb-1.5 block text-sm font-medium text-ink-300">
                Template Perintah <span class="font-normal text-ink-400">(opsional)</span>
              </label>
              <select id="cmd-template" v-model="formTemplateId" class="field">
                <option value="">Tanpa template — atur manual</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">
                  {{ t.name }} — {{ commandTypeLabel(t.type) }}
                </option>
              </select>
              <p v-if="selectedTemplate?.description" class="mt-1.5 text-xs text-ink-400">{{ selectedTemplate.description }}</p>
            </div>

            <!-- Target: satu agent -->
            <div v-if="targetMode === 'single'">
              <label for="cmd-agent" class="mb-1.5 block text-sm font-medium text-ink-300">Agent Tujuan</label>
              <select id="cmd-agent" v-model="formAgentId" class="field" required>
                <option value="" disabled>Pilih agent…</option>
                <option v-for="a in agents" :key="a.id" :value="a.id">
                  {{ a.name }}{{ a.worker_name || a.worker?.name ? ` — worker ${a.worker_name || a.worker?.name}` : '' }}
                </option>
              </select>
              <p v-if="selectedAgent && !selectedWorker" class="mt-1.5 text-xs text-amber-400">
                Agent ini belum memiliki worker; perintah miner belum dapat dibuat.
              </p>
            </div>

            <!-- Target: broadcast multi-pilih -->
            <div v-else>
              <div class="mb-1.5 flex items-center justify-between">
                <span class="text-sm font-medium text-ink-300">Agent Tujuan Broadcast</span>
                <span class="flex gap-2 text-xs">
                  <button type="button" class="text-indigo-400 hover:text-indigo-300" @click="toggleAllAgents(true)">Pilih Semua</button>
                  <button type="button" class="text-ink-400 hover:text-ink-200" @click="toggleAllAgents(false)">Bersihkan</button>
                </span>
              </div>
              <div class="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-ink-700 bg-ink-850 p-2">
                <p v-if="agents.length === 0" class="px-2 py-3 text-xs text-ink-400">Belum ada agent terdaftar.</p>
                <label
                  v-for="a in agents"
                  :key="a.id"
                  class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-ink-800"
                >
                  <input v-model="selectedAgentIds" type="checkbox" :value="a.id" class="h-4 w-4 shrink-0 accent-indigo-500" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-ink-100">{{ a.name }}</span>
                    <span class="block truncate text-[11px] text-ink-400">
                      {{ a.worker?.name || a.worker_name ? `Worker ${a.worker?.name || a.worker_name}` : 'Belum ada worker — akan dilewati server' }}
                    </span>
                  </span>
                  <StatusChip v-if="a.worker?.status" :status="a.worker.status" kind="worker" />
                  <StatusChip v-else :status="a.status" kind="agent" />
                </label>
              </div>
              <p class="mt-1.5 text-xs text-ink-400">{{ selectedAgentIds.length }} agent dipilih.</p>
            </div>

            <div>
              <label for="cmd-type" class="mb-1.5 block text-sm font-medium text-ink-300">Tipe Perintah</label>
              <select id="cmd-type" v-model="formType" class="field" :disabled="!!selectedTemplate">
                <option v-for="t in COMMAND_TYPES" :key="t.value" :value="t.value">
                  {{ t.label }} ({{ t.value }})
                </option>
              </select>
              <p v-if="selectedTemplate" class="mt-1.5 text-xs text-ink-400">Tipe mengikuti template terpilih.</p>
              <p v-if="targetMode === 'single' && !capabilityOk" class="mt-1.5 text-xs text-amber-400">
                Perhatian: tipe ini tidak tercantum dalam kemampuan (capabilities) agent terpilih — bridge kemungkinan akan menolaknya.
              </p>
            </div>

            <div>
              <label for="cmd-payload" class="mb-1.5 block text-sm font-medium text-ink-300">
                Payload JSON <span class="font-normal text-ink-400">(opsional)</span>
              </label>
              <textarea
                id="cmd-payload"
                v-model="formPayload"
                rows="3"
                spellcheck="false"
                placeholder='{"contoh": "nilai"}'
                class="field font-mono text-xs"
                :disabled="targetMode === 'broadcast'"
              />
              <p v-if="targetMode === 'broadcast'" class="mt-1.5 text-xs text-ink-400">
                Payload broadcast diatur lewat template; server menggabungkan payload template ke setiap perintah.
              </p>
            </div>

            <label v-if="isSensitive && targetMode === 'single'" class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-ink-200">
              <input v-model="formConfirm" type="checkbox" class="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500" />
              <span>
                Saya memahami perintah <span class="font-medium text-white">{{ selectedTypeMeta?.label }}</span>
                bersifat sensitif dan mengonfirmasi untuk menjalankannya pada agent terpilih.
              </span>
            </label>
            <p v-if="isSensitive && targetMode === 'broadcast'" class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-ink-200">
              Perintah ini bersifat sensitif — Anda akan diminta konfirmasi sebelum broadcast dikirim.
            </p>

            <p v-if="formError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ formError }}</p>
            <p v-if="formSuccess" class="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{{ formSuccess }}</p>

            <button type="submit" class="btn-primary w-full justify-center" :disabled="submitting">
              <LoaderCircle v-if="submitting" class="h-4 w-4 animate-spin" />
              <Send v-else-if="targetMode === 'single'" class="h-4 w-4" />
              <Megaphone v-else class="h-4 w-4" />
              {{ submitting ? 'Mengirim…' : targetMode === 'single' ? 'Kirim Perintah' : 'Kirim Broadcast' }}
            </button>
            <p class="text-xs leading-relaxed text-ink-400">
              Bila agent sedang tak terjangkau, perintah tetap dibuat dengan status Menunggu dan akan
              kedaluwarsa pada waktu yang ditampilkan di tabel bila agent tidak kembali tepat waktu.
              Pada broadcast, agent yang tidak memenuhi syarat dilewati dengan alasan — batch tidak gagal keseluruhan.
            </p>
          </form>
        </section>

        <!-- Hasil broadcast terakhir -->
        <section v-if="lastBroadcast" class="panel h-fit p-5">
          <h2 class="text-sm font-semibold text-white">Hasil Broadcast Terakhir</h2>
          <p class="mt-1 font-mono text-[11px] text-ink-400">Batch: {{ lastBroadcast.batch_id || '—' }}</p>
          <div class="mt-3">
            <p class="text-xs font-medium text-emerald-300">Dibuat ({{ lastBroadcast.created.length }})</p>
            <ul v-if="lastBroadcast.created.length" class="mt-1.5 space-y-1 text-sm">
              <li v-for="c in lastBroadcast.created" :key="c.command_id" class="flex items-center justify-between gap-2">
                <NuxtLink :to="`/agents/${c.agent_id}`" class="text-indigo-300 hover:text-indigo-200">{{ agentNames[c.agent_id] ?? c.agent_id }}</NuxtLink>
                <span class="font-mono text-[11px] text-ink-400">{{ c.command_id }}</span>
              </li>
            </ul>
            <p v-else class="mt-1 text-xs text-ink-400">Tidak ada perintah yang dibuat.</p>
          </div>
          <div class="mt-3">
            <p class="text-xs font-medium text-amber-300">Dilewati ({{ lastBroadcast.skipped.length }})</p>
            <ul v-if="lastBroadcast.skipped.length" class="mt-1.5 space-y-1.5 text-sm">
              <li v-for="s in lastBroadcast.skipped" :key="s.agent_id">
                <span class="text-ink-100">{{ agentNames[s.agent_id] ?? s.agent_id }}</span>
                <span class="block text-xs text-ink-400">{{ s.reason }}</span>
              </li>
            </ul>
            <p v-else class="mt-1 text-xs text-ink-400">Tidak ada agent yang dilewati.</p>
          </div>
        </section>
      </div>

      <!-- Antrian & riwayat -->
      <section class="panel h-fit xl:col-span-2">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="text-sm font-semibold text-white">Antrian & Riwayat</h2>
          <div class="ml-auto flex flex-wrap items-center gap-2">
            <select v-model="filterAgent" class="field !w-auto !py-1.5 text-xs">
              <option value="">Semua Agent</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
            <select v-model="filterStatus" class="field !w-auto !py-1.5 text-xs">
              <option value="">Semua Status</option>
              <option v-for="s in COMMAND_STATUSES" :key="s" :value="s">{{ commandStatusLabel(s) }}</option>
            </select>
            <select v-model="filterType" class="field !w-auto !py-1.5 text-xs">
              <option value="">Semua Tipe</option>
              <option v-for="t in COMMAND_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </div>
        </div>

        <p v-if="loadError" class="px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

        <div class="overflow-x-auto">
          <table class="table-base min-w-[860px]">
            <thead>
              <tr>
                <th>Waktu Dibuat</th>
                <th>Agent</th>
                <th>Tipe</th>
                <th>Status</th>
                <th>Diminta Oleh</th>
                <th>Kedaluwarsa</th>
                <th>Hasil / Alasan</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading && commands.length === 0">
                <td colspan="7" class="py-10 text-center text-ink-400">Memuat perintah…</td>
              </tr>
              <tr v-else-if="commands.length === 0">
                <td colspan="7"><EmptyState message="Belum ada perintah yang cocok dengan filter." /></td>
              </tr>
              <tr v-for="c in commands" :key="c.id">
                <td class="whitespace-nowrap text-xs">{{ fmtDateTime(c.created_at) }}</td>
                <td>
                  <NuxtLink :to="`/agents/${c.agent_id}`" class="text-indigo-300 hover:text-indigo-200">
                    {{ agentNames[c.agent_id] ?? c.agent_id }}
                  </NuxtLink>
                </td>
                <td>
                  {{ commandTypeLabel(c.type) }}
                  <span class="block font-mono text-[11px] text-ink-400">{{ c.type }}</span>
                  <span v-if="c.source" class="mt-0.5 block text-[11px] text-ink-400">Sumber: {{ commandSourceLabel(c.source) }}</span>
                  <span v-if="c.template_id" class="mt-0.5 block text-[11px] text-ink-400">Template: {{ templateName(c.template_id) }}</span>
                  <span v-if="c.batch_id" class="block font-mono text-[11px] text-ink-400">Batch {{ c.batch_id }}</span>
                </td>
                <td><StatusChip :status="c.status" kind="command" /></td>
                <td class="text-xs">{{ c.requested_by || '—' }}</td>
                <td class="whitespace-nowrap text-xs">{{ c.status === 'QUEUED' || c.status === 'SENT' ? fmtDateTime(c.expires_at) : '—' }}</td>
                <td class="max-w-64 truncate text-xs" :title="resultText(c)">{{ resultText(c) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="px-4">
          <Pagination :page="page" :page-size="pageSize" :total="total" @change="(p) => { page = p; loadCommands() }" />
        </div>
      </section>
    </div>

    <div class="mt-5 grid gap-5 xl:grid-cols-5">
      <!-- Batch broadcast -->
      <section class="panel xl:col-span-3">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="text-sm font-semibold text-white">Batch Broadcast</h2>
          <span v-if="hasActiveBatch" class="inline-flex items-center gap-1.5 text-xs text-amber-300">
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" /> Ada batch berjalan — daftar diperbarui otomatis
          </span>
          <button class="btn-ghost ml-auto !px-2.5 !py-1.5 text-xs" :disabled="batchesLoading" @click="refreshAll">
            <RefreshCw class="h-3.5 w-3.5" :class="batchesLoading ? 'animate-spin' : ''" /> Segarkan
          </button>
        </div>

        <EmptyState v-if="batches.length === 0" message="Belum ada broadcast yang dikirim." />
        <ul v-else class="divide-y divide-ink-800">
          <li v-for="b in batches" :key="b.id">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <button class="flex min-w-0 items-center gap-1.5 text-left" @click="expandBatch(b.id)">
                <ChevronDown v-if="expandedBatchId === b.id" class="h-4 w-4 shrink-0 text-ink-400" />
                <ChevronRight v-else class="h-4 w-4 shrink-0 text-ink-400" />
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-white">
                    {{ commandTypeLabel(b.type) }}
                    <span v-if="b.template_id" class="font-normal text-ink-400">· template {{ templateName(b.template_id) }}</span>
                  </span>
                  <span class="block text-[11px] text-ink-400">
                    {{ fmtDateTime(b.created_at) }} · oleh {{ b.requested_by || '—' }} · <span class="font-mono">{{ b.id }}</span>
                  </span>
                </span>
              </button>
              <span class="text-xs text-ink-300">
                Total {{ b.total_count ?? ((b.created_count ?? 0) + (b.skipped_count ?? 0)) }} ·
                <span class="text-emerald-300">dibuat {{ b.created_count ?? 0 }}</span> ·
                <span class="text-amber-300">dilewati {{ b.skipped_count ?? 0 }}</span>
              </span>
              <span class="ml-auto flex flex-wrap items-center gap-1.5">
                <span
                  v-for="chip in batchCountChips(b)"
                  :key="chip.status"
                  class="inline-flex items-center gap-1.5"
                >
                  <StatusChip :status="chip.status" kind="command" />
                  <span class="text-xs text-ink-300">{{ chip.count }}</span>
                </span>
                <span v-if="batchCountChips(b).length === 0" class="text-xs text-ink-400">Belum ada perintah berjalan</span>
              </span>
            </div>

            <!-- Detail batch -->
            <div v-if="expandedBatchId === b.id" class="border-t border-ink-800 bg-ink-850/50 px-4 py-3">
              <p v-if="batchDetailLoading" class="py-3 text-center text-xs text-ink-400">Memuat detail batch…</p>
              <EmptyState v-else-if="batchCommands.length === 0" message="Batch ini tidak memiliki perintah (semua target dilewati atau data belum tersedia)." />
              <div v-else class="overflow-x-auto">
                <table class="table-base min-w-[560px]">
                  <thead>
                    <tr><th>Agent</th><th>Tipe</th><th>Status</th><th>Dibuat</th><th>Hasil / Alasan</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in batchCommands" :key="c.id">
                      <td>
                        <NuxtLink :to="`/agents/${c.agent_id}`" class="text-indigo-300 hover:text-indigo-200">
                          {{ agentNames[c.agent_id] ?? c.agent_id }}
                        </NuxtLink>
                      </td>
                      <td class="font-mono text-xs">{{ c.type }}</td>
                      <td><StatusChip :status="c.status" kind="command" /></td>
                      <td class="whitespace-nowrap text-xs">{{ fmtDateTime(c.created_at) }}</td>
                      <td class="max-w-56 truncate text-xs" :title="resultText(c)">{{ resultText(c) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <!-- Template perintah -->
      <section class="panel xl:col-span-2">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <LayoutTemplate class="h-4 w-4 text-ink-400" /> Template Perintah
          </h2>
          <button v-if="canOperate" class="btn-ghost ml-auto !px-2.5 !py-1.5 text-xs" @click="openCreateTemplate">
            <Plus class="h-3.5 w-3.5" /> Buat Template
          </button>
        </div>
        <EmptyState v-if="templates.length === 0" message="Belum ada template. Buat template untuk memakai ulang tipe + payload perintah." />
        <ul v-else class="divide-y divide-ink-800">
          <li v-for="t in templates" :key="t.id" class="px-4 py-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-white">{{ t.name }}</p>
                <p class="mt-0.5 text-xs text-ink-400">
                  {{ commandTypeLabel(t.type) }} <span class="font-mono text-[11px]">({{ t.type }})</span>
                </p>
                <p v-if="t.description" class="mt-1 text-xs leading-relaxed text-ink-400">{{ t.description }}</p>
                <p v-if="t.payload && Object.keys(t.payload).length" class="mt-1 truncate font-mono text-[11px] text-ink-400" :title="JSON.stringify(t.payload)">
                  Payload: {{ JSON.stringify(t.payload) }}
                </p>
              </div>
              <span
                v-if="templateSensitive(t)"
                class="shrink-0 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400 ring-1 ring-inset ring-amber-500/30"
              >
                Sensitif
              </span>
            </div>
            <div v-if="canOperate" class="mt-2 flex gap-1.5">
              <button class="btn-ghost !px-2.5 !py-1.5 text-xs" @click="openEditTemplate(t)">
                <Pencil class="h-3.5 w-3.5" /> Ubah
              </button>
              <button class="btn-ghost !px-2.5 !py-1.5 text-xs !text-red-300 hover:!bg-red-500/10" @click="tplDeleteTarget = t">
                <Trash2 class="h-3.5 w-3.5" /> Hapus
              </button>
              <button
                class="btn-ghost ml-auto !px-2.5 !py-1.5 text-xs"
                @click="formTemplateId = t.id"
              >
                Pakai
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <!-- Konfirmasi broadcast sensitif -->
    <ConfirmDialog
      v-if="broadcastConfirmOpen"
      title="Konfirmasi Broadcast"
      :message="broadcastSummaryText"
      confirm-label="Ya, Kirim Broadcast"
      :on-confirm="async () => { await doBroadcast() }"
      @close="broadcastConfirmOpen = false"
    />

    <!-- Modal template -->
    <BaseModal v-if="tplModalOpen" :title="tplForm.id ? 'Ubah Template' : 'Buat Template'" @close="tplModalOpen = false">
      <form class="space-y-4" @submit.prevent="saveTemplate">
        <div>
          <label for="tpl-name" class="mb-1.5 block text-sm font-medium text-ink-300">Nama Template</label>
          <input id="tpl-name" v-model="tplForm.name" type="text" class="field" placeholder="cth. Restart Semua Miner" required />
        </div>
        <div>
          <label for="tpl-type" class="mb-1.5 block text-sm font-medium text-ink-300">Tipe Perintah</label>
          <select id="tpl-type" v-model="tplForm.type" class="field">
            <option v-for="t in COMMAND_TYPES" :key="t.value" :value="t.value">{{ t.label }} ({{ t.value }})</option>
          </select>
        </div>
        <div>
          <label for="tpl-payload" class="mb-1.5 block text-sm font-medium text-ink-300">
            Payload JSON <span class="font-normal text-ink-400">(opsional — parameter bawaan)</span>
          </label>
          <textarea id="tpl-payload" v-model="tplForm.payload" rows="3" spellcheck="false" class="field font-mono text-xs" placeholder='{"contoh": "nilai"}' />
        </div>
        <div>
          <label for="tpl-desc" class="mb-1.5 block text-sm font-medium text-ink-300">
            Deskripsi <span class="font-normal text-ink-400">(opsional)</span>
          </label>
          <textarea id="tpl-desc" v-model="tplForm.description" rows="2" class="field" placeholder="Kegunaan template ini…" />
        </div>
        <p v-if="tplFormError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ tplFormError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" :disabled="tplSaving" @click="tplModalOpen = false">Batal</button>
          <button type="submit" class="btn-primary" :disabled="tplSaving">
            <LoaderCircle v-if="tplSaving" class="h-4 w-4 animate-spin" />
            {{ tplSaving ? 'Menyimpan…' : 'Simpan Template' }}
          </button>
        </div>
      </form>
    </BaseModal>

    <!-- Konfirmasi hapus template -->
    <ConfirmDialog
      v-if="tplDeleteTarget"
      title="Hapus Template"
      :message="`Template '${tplDeleteTarget.name}' akan dihapus permanen. Perintah yang sudah dibuat dari template ini tidak ikut terhapus. Lanjutkan?`"
      confirm-label="Ya, Hapus"
      :danger="true"
      :on-confirm="doDeleteTemplate"
      @close="tplDeleteTarget = null"
    />
  </div>
</template>
