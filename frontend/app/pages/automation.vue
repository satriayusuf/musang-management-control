<script setup lang="ts">
import {
  Plus,
  Pencil,
  Trash2,
  LoaderCircle,
  RefreshCw,
  Workflow,
  CalendarClock,
  Info,
} from 'lucide-vue-next'
import {
  api,
  denormalizeTarget,
  type AgentSummary,
  type AutomationRuleInfo,
  type CommandTemplateInfo,
  type ScheduleInfo,
  type TargetSelection,
} from '~/lib/api'
import { fmtDateTime, fmtDuration } from '~/lib/format'
import {
  COMMAND_TYPES,
  RULE_WORKER_STATUSES,
  commandTypeLabel,
  ruleConditionKindLabel,
  workerStatusLabel,
} from '~/lib/labels'

const auth = useAuthStore()
const canOperate = computed(() => auth.canOperate)

// ---------- Data referensi ----------
const agents = ref<AgentSummary[]>([])
const templates = ref<CommandTemplateInfo[]>([])
const automationEnabled = ref<boolean | null>(null)

const agentNames = computed(() => {
  const map: Record<string, string> = {}
  for (const a of agents.value) map[a.id] = a.name
  return map
})

function templateName(id?: string | null): string {
  if (!id) return ''
  return templates.value.find((t) => t.id === id)?.name ?? id
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

async function loadRefs() {
  try {
    const [agentPage, tplList, settings] = await Promise.all([
      api.listAgents({ page: 1, page_size: 200 }).catch(() => null),
      api.listTemplates().catch(() => null),
      api.getSettings().catch(() => null),
    ])
    if (agentPage) agents.value = agentPage.items
    if (tplList) templates.value = tplList
    if (settings && settings.automation_enabled !== undefined) {
      automationEnabled.value = asBool(settings.automation_enabled)
    }
  } catch {
    /* referensi gagal dimuat; halaman tetap dirender */
  }
}

// ---------- Ringkasan tampilan ----------
function conditionSummary(r: AutomationRuleInfo): string {
  const dur = fmtDuration(r.condition.for_sec)
  if (r.condition.kind === 'agent_unreachable') return `Agent Tak Terjangkau selama ≥ ${dur}`
  return `Worker ${workerStatusLabel(r.condition.status)} selama ≥ ${dur}`
}

function actionSummary(action: { type?: string; template_id?: string | null }): string {
  if (action.template_id) return `Template: ${templateName(action.template_id)}`
  if (action.type) return commandTypeLabel(action.type)
  return '—'
}

function targetSummary(target: TargetSelection): string {
  if (target.mode === 'all') return 'Semua agent'
  if (target.ids.length === 0) return 'Tidak ada agent dipilih'
  const names = target.ids.map((id) => agentNames.value[id] ?? id)
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} lainnya`
}

// ---------- Aturan otomasi ----------
const rules = ref<AutomationRuleInfo[]>([])
const rulesLoading = ref(true)
const rulesError = ref('')
const togglingId = ref('')

async function loadRules() {
  rulesLoading.value = true
  try {
    rules.value = await api.listRules()
    rulesError.value = ''
  } catch (e) {
    rulesError.value = e instanceof Error ? e.message : 'Gagal memuat aturan otomasi.'
  } finally {
    rulesLoading.value = false
  }
}

async function toggleRule(r: AutomationRuleInfo) {
  if (togglingId.value) return
  togglingId.value = r.id
  try {
    const updated = await api.toggleRule(r.id)
    const idx = rules.value.findIndex((x) => x.id === r.id)
    if (idx >= 0) rules.value[idx] = updated
  } catch (e) {
    rulesError.value = e instanceof Error ? e.message : 'Gagal mengubah status aturan.'
  } finally {
    togglingId.value = ''
  }
}

const ruleDeleteTarget = ref<AutomationRuleInfo | null>(null)
async function doDeleteRule() {
  if (!ruleDeleteTarget.value) return
  await api.deleteRule(ruleDeleteTarget.value.id)
  ruleDeleteTarget.value = null
  await loadRules()
}

// ---------- Editor aturan ----------
interface ActionFormState {
  source: 'type' | 'template'
  type: string
  templateId: string
}
interface TargetFormState {
  mode: 'all' | 'list'
  ids: string[]
}

const ruleModalOpen = ref(false)
const ruleSaving = ref(false)
const ruleFormError = ref('')
const ruleForm = ref<{
  id: string | null
  name: string
  enabled: boolean
  kind: string
  status: string
  forSec: number | undefined
  action: ActionFormState
  target: TargetFormState
  cooldownSec: number | undefined
  maxPerDay: number | undefined
}>({
  id: null,
  name: '',
  enabled: false,
  kind: 'worker_status',
  status: 'MATI',
  forSec: 300,
  action: { source: 'type', type: 'miner.run', templateId: '' },
  target: { mode: 'all', ids: [] },
  cooldownSec: 3600,
  maxPerDay: 5,
})

function openCreateRule() {
  ruleForm.value = {
    id: null,
    name: '',
    enabled: false,
    kind: 'worker_status',
    status: 'MATI',
    forSec: 300,
    action: { source: 'type', type: 'miner.run', templateId: '' },
    target: { mode: 'all', ids: [] },
    cooldownSec: 3600,
    maxPerDay: 5,
  }
  ruleFormError.value = ''
  ruleModalOpen.value = true
}

function openEditRule(r: AutomationRuleInfo) {
  ruleForm.value = {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    kind: r.condition.kind,
    status: r.condition.status ?? 'MATI',
    forSec: r.condition.for_sec,
    action: r.action.template_id
      ? { source: 'template', type: r.action.type ?? 'miner.run', templateId: r.action.template_id }
      : { source: 'type', type: r.action.type ?? 'miner.run', templateId: '' },
    target:
      r.target.mode === 'all' ? { mode: 'all', ids: [] } : { mode: 'list', ids: [...r.target.ids] },
    cooldownSec: r.cooldown_sec,
    maxPerDay: r.max_per_day,
  }
  ruleFormError.value = ''
  ruleModalOpen.value = true
}

function buildActionBody(a: ActionFormState): Record<string, unknown> {
  return a.source === 'template' ? { template_id: a.templateId } : { type: a.type }
}

async function saveRule() {
  if (ruleSaving.value) return
  ruleFormError.value = ''
  const f = ruleForm.value
  if (!f.name.trim()) {
    ruleFormError.value = 'Nama aturan wajib diisi.'
    return
  }
  if (f.forSec === undefined || f.forSec === null || Number.isNaN(f.forSec) || f.forSec < 0) {
    ruleFormError.value = 'Durasi kondisi (detik) wajib diisi dengan angka ≥ 0.'
    return
  }
  if (f.action.source === 'template' && !f.action.templateId) {
    ruleFormError.value = 'Pilih template untuk aksi aturan ini.'
    return
  }
  if (f.target.mode === 'list' && f.target.ids.length === 0) {
    ruleFormError.value = 'Pilih minimal satu agent target, atau gunakan mode Semua Agent.'
    return
  }
  const condition: Record<string, unknown> = { kind: f.kind, for_sec: f.forSec }
  if (f.kind === 'worker_status') condition.status = f.status
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    enabled: f.enabled,
    condition,
    action: buildActionBody(f.action),
    target: denormalizeTarget(f.target.mode === 'all' ? { mode: 'all' } : { mode: 'list', ids: f.target.ids }),
    cooldown_sec: f.cooldownSec ?? 3600,
    max_per_day: f.maxPerDay ?? 5,
  }
  ruleSaving.value = true
  try {
    if (f.id) await api.updateRule(f.id, body)
    else await api.createRule(body)
    ruleModalOpen.value = false
    await loadRules()
  } catch (e) {
    ruleFormError.value = e instanceof Error ? e.message : 'Gagal menyimpan aturan.'
  } finally {
    ruleSaving.value = false
  }
}

// ---------- Jadwal perintah ----------
const schedules = ref<ScheduleInfo[]>([])
const schedulesLoading = ref(true)
const schedulesError = ref('')

async function loadSchedules() {
  schedulesLoading.value = true
  try {
    schedules.value = await api.listSchedules()
    schedulesError.value = ''
  } catch (e) {
    schedulesError.value = e instanceof Error ? e.message : 'Gagal memuat jadwal perintah.'
  } finally {
    schedulesLoading.value = false
  }
}

async function toggleSchedule(s: ScheduleInfo) {
  if (togglingId.value) return
  togglingId.value = s.id
  try {
    const updated = await api.toggleSchedule(s.id)
    const idx = schedules.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) schedules.value[idx] = updated
  } catch (e) {
    schedulesError.value = e instanceof Error ? e.message : 'Gagal mengubah status jadwal.'
  } finally {
    togglingId.value = ''
  }
}

const scheduleDeleteTarget = ref<ScheduleInfo | null>(null)
async function doDeleteSchedule() {
  if (!scheduleDeleteTarget.value) return
  await api.deleteSchedule(scheduleDeleteTarget.value.id)
  scheduleDeleteTarget.value = null
  await loadSchedules()
}

// ---------- Editor jadwal ----------
const scheduleModalOpen = ref(false)
const scheduleSaving = ref(false)
const scheduleFormError = ref('')
const scheduleForm = ref<{
  id: string | null
  name: string
  enabled: boolean
  cron: string
  action: ActionFormState
  target: TargetFormState
  broadcast: boolean
  nextRunAt: string | null
}>({
  id: null,
  name: '',
  enabled: false,
  cron: '0 * * * *',
  action: { source: 'type', type: 'miner.status', templateId: '' },
  target: { mode: 'all', ids: [] },
  broadcast: false,
  nextRunAt: null,
})

function openCreateSchedule() {
  scheduleForm.value = {
    id: null,
    name: '',
    enabled: false,
    cron: '0 * * * *',
    action: { source: 'type', type: 'miner.status', templateId: '' },
    target: { mode: 'all', ids: [] },
    broadcast: false,
    nextRunAt: null,
  }
  scheduleFormError.value = ''
  scheduleModalOpen.value = true
}

function openEditSchedule(s: ScheduleInfo) {
  scheduleForm.value = {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    cron: s.cron,
    action: s.action.template_id
      ? { source: 'template', type: s.action.type ?? 'miner.status', templateId: s.action.template_id }
      : { source: 'type', type: s.action.type ?? 'miner.status', templateId: '' },
    target: s.target.mode === 'all' ? { mode: 'all', ids: [] } : { mode: 'list', ids: [...s.target.ids] },
    broadcast: s.broadcast,
    nextRunAt: s.next_run_at ?? null,
  }
  scheduleFormError.value = ''
  scheduleModalOpen.value = true
}

async function saveSchedule() {
  if (scheduleSaving.value) return
  scheduleFormError.value = ''
  const f = scheduleForm.value
  if (!f.name.trim()) {
    scheduleFormError.value = 'Nama jadwal wajib diisi.'
    return
  }
  if (!f.cron.trim()) {
    scheduleFormError.value = 'Ekspresi cron wajib diisi (5 kolom: menit jam tanggal bulan hari).'
    return
  }
  if (f.action.source === 'template' && !f.action.templateId) {
    scheduleFormError.value = 'Pilih template untuk aksi jadwal ini.'
    return
  }
  if (f.target.mode === 'list' && f.target.ids.length === 0) {
    scheduleFormError.value = 'Pilih minimal satu agent target, atau gunakan mode Semua Agent.'
    return
  }
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    enabled: f.enabled,
    cron: f.cron.trim(),
    action: buildActionBody(f.action),
    target: denormalizeTarget(f.target.mode === 'all' ? { mode: 'all' } : { mode: 'list', ids: f.target.ids }),
    broadcast: f.broadcast,
  }
  scheduleSaving.value = true
  try {
    let saved: ScheduleInfo
    if (f.id) saved = await api.updateSchedule(f.id, body)
    else saved = await api.createSchedule(body)
    // Tampilkan jadwal jalan berikutnya dari respon API sebelum menutup editor.
    f.nextRunAt = saved.next_run_at ?? null
    scheduleModalOpen.value = false
    await loadSchedules()
  } catch (e) {
    scheduleFormError.value = e instanceof Error ? e.message : 'Gagal menyimpan jadwal.'
  } finally {
    scheduleSaving.value = false
  }
}

async function refreshAll() {
  if (!canOperate.value) return
  await Promise.all([loadRules(), loadSchedules()])
}

onMounted(async () => {
  if (!canOperate.value) return
  await loadRefs()
  await refreshAll()
})
useLiveRefresh(refreshAll)
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Otomasi</h1>
      <p class="mt-0.5 text-sm text-ink-400">
        Aturan berbasis kondisi dan jadwal cron yang membuat perintah secara otomatis.
        Setiap perintah yang dibuat otomasi tetap melewati antrian, gerbang kelayakan, dan audit yang sama.
      </p>
    </div>

    <div v-if="!canOperate" class="panel flex items-start gap-3 p-5">
      <Info class="mt-0.5 h-5 w-5 shrink-0 text-ink-400" />
      <p class="text-sm leading-relaxed text-ink-300">
        Halaman ini memerlukan peran <span class="font-medium text-white">Operator</span> atau
        <span class="font-medium text-white">Administrator</span>. Peran Anda saat ini
        ({{ auth.role ? auth.role : '—' }}) bersifat hanya-baca.
      </p>
    </div>

    <template v-else>
      <div
        v-if="automationEnabled === false"
        class="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        <Info class="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Sakelar utama otomasi sedang <span class="font-medium">nonaktif</span> — aturan dan jadwal tidak akan
          berjalan sampai diaktifkan kembali oleh Administrator di
          <NuxtLink to="/settings" class="font-medium underline">Pengaturan</NuxtLink>.
        </p>
      </div>

      <!-- Aturan otomasi -->
      <section class="panel">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <Workflow class="h-4 w-4 text-indigo-400" /> Aturan Otomasi
          </h2>
          <div class="ml-auto flex items-center gap-2">
            <button class="btn-ghost !px-2.5 !py-1.5 text-xs" :disabled="rulesLoading" @click="loadRules">
              <RefreshCw class="h-3.5 w-3.5" :class="rulesLoading ? 'animate-spin' : ''" /> Segarkan
            </button>
            <button class="btn-primary !px-3 !py-1.5 text-xs" @click="openCreateRule">
              <Plus class="h-3.5 w-3.5" /> Buat Aturan
            </button>
          </div>
        </div>

        <p v-if="rulesError" class="px-4 py-3 text-sm text-red-400">{{ rulesError }}</p>

        <div class="overflow-x-auto">
          <table class="table-base min-w-[980px]">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Kondisi</th>
                <th>Aksi</th>
                <th>Target</th>
                <th>Jeda / Batas</th>
                <th>Terakhir Terpicu</th>
                <th>Aktif</th>
                <th class="text-right">Kelola</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="rulesLoading && rules.length === 0">
                <td colspan="8" class="py-10 text-center text-ink-400">Memuat aturan…</td>
              </tr>
              <tr v-else-if="rules.length === 0">
                <td colspan="8">
                  <EmptyState message="Belum ada aturan otomasi. Buat aturan agar perintah dibuat otomatis saat kondisi terpenuhi." />
                </td>
              </tr>
              <tr v-for="r in rules" :key="r.id">
                <td class="font-medium text-white">{{ r.name }}</td>
                <td class="text-xs">{{ conditionSummary(r) }}</td>
                <td class="text-xs">{{ actionSummary(r.action) }}</td>
                <td class="max-w-56 truncate text-xs" :title="targetSummary(r.target)">{{ targetSummary(r.target) }}</td>
                <td class="whitespace-nowrap text-xs">
                  Jeda {{ fmtDuration(r.cooldown_sec) }}<br />
                  Maks {{ r.max_per_day }}×/hari <span class="text-ink-400">(hari ini {{ r.fire_count_today ?? 0 }}×)</span>
                </td>
                <td class="whitespace-nowrap text-xs">{{ fmtDateTime(r.last_fired_at) }}</td>
                <td>
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="r.enabled"
                    class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                    :class="r.enabled ? 'bg-indigo-600' : 'bg-ink-700'"
                    :disabled="togglingId === r.id"
                    :title="r.enabled ? 'Nonaktifkan aturan' : 'Aktifkan aturan'"
                    @click="toggleRule(r)"
                  >
                    <span
                      class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                      :class="r.enabled ? 'left-[22px]' : 'left-0.5'"
                    />
                  </button>
                </td>
                <td>
                  <div class="flex items-center justify-end gap-1.5">
                    <button class="btn-ghost !px-2.5 !py-1.5 text-xs" @click="openEditRule(r)">
                      <Pencil class="h-3.5 w-3.5" /> Ubah
                    </button>
                    <button class="btn-ghost !px-2.5 !py-1.5 text-xs !text-red-300 hover:!bg-red-500/10" @click="ruleDeleteTarget = r">
                      <Trash2 class="h-3.5 w-3.5" /> Hapus
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Jadwal perintah -->
      <section class="panel mt-5">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <CalendarClock class="h-4 w-4 text-indigo-400" /> Jadwal Perintah
          </h2>
          <div class="ml-auto flex items-center gap-2">
            <button class="btn-ghost !px-2.5 !py-1.5 text-xs" :disabled="schedulesLoading" @click="loadSchedules">
              <RefreshCw class="h-3.5 w-3.5" :class="schedulesLoading ? 'animate-spin' : ''" /> Segarkan
            </button>
            <button class="btn-primary !px-3 !py-1.5 text-xs" @click="openCreateSchedule">
              <Plus class="h-3.5 w-3.5" /> Buat Jadwal
            </button>
          </div>
        </div>

        <p v-if="schedulesError" class="px-4 py-3 text-sm text-red-400">{{ schedulesError }}</p>

        <div class="overflow-x-auto">
          <table class="table-base min-w-[980px]">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Cron</th>
                <th>Jalan Berikutnya</th>
                <th>Terakhir Jalan</th>
                <th>Aksi</th>
                <th>Target</th>
                <th>Mode</th>
                <th>Aktif</th>
                <th class="text-right">Kelola</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="schedulesLoading && schedules.length === 0">
                <td colspan="9" class="py-10 text-center text-ink-400">Memuat jadwal…</td>
              </tr>
              <tr v-else-if="schedules.length === 0">
                <td colspan="9">
                  <EmptyState message="Belum ada jadwal perintah. Buat jadwal untuk menjalankan perintah pada waktu tertentu secara berulang." />
                </td>
              </tr>
              <tr v-for="s in schedules" :key="s.id">
                <td class="font-medium text-white">{{ s.name }}</td>
                <td class="font-mono text-xs">{{ s.cron }}</td>
                <td class="whitespace-nowrap text-xs">{{ s.enabled ? fmtDateTime(s.next_run_at) : '— (nonaktif)' }}</td>
                <td class="whitespace-nowrap text-xs">{{ fmtDateTime(s.last_run_at) }}</td>
                <td class="text-xs">{{ actionSummary(s.action) }}</td>
                <td class="max-w-56 truncate text-xs" :title="targetSummary(s.target)">{{ targetSummary(s.target) }}</td>
                <td class="text-xs">{{ s.broadcast ? 'Broadcast (satu batch)' : 'Satu perintah per target' }}</td>
                <td>
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="s.enabled"
                    class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                    :class="s.enabled ? 'bg-indigo-600' : 'bg-ink-700'"
                    :disabled="togglingId === s.id"
                    :title="s.enabled ? 'Nonaktifkan jadwal' : 'Aktifkan jadwal'"
                    @click="toggleSchedule(s)"
                  >
                    <span
                      class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                      :class="s.enabled ? 'left-[22px]' : 'left-0.5'"
                    />
                  </button>
                </td>
                <td>
                  <div class="flex items-center justify-end gap-1.5">
                    <button class="btn-ghost !px-2.5 !py-1.5 text-xs" @click="openEditSchedule(s)">
                      <Pencil class="h-3.5 w-3.5" /> Ubah
                    </button>
                    <button class="btn-ghost !px-2.5 !py-1.5 text-xs !text-red-300 hover:!bg-red-500/10" @click="scheduleDeleteTarget = s">
                      <Trash2 class="h-3.5 w-3.5" /> Hapus
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="px-4 py-3 text-xs leading-relaxed text-ink-400">
          Ekspresi cron memakai 5 kolom standar (menit, jam, tanggal, bulan, hari dalam minggu) dan dievaluasi
          mengikuti zona waktu server.
        </p>
      </section>
    </template>

    <!-- Editor aturan -->
    <BaseModal v-if="ruleModalOpen" wide :title="ruleForm.id ? 'Ubah Aturan Otomasi' : 'Buat Aturan Otomasi'" @close="ruleModalOpen = false">
      <form class="space-y-4" @submit.prevent="saveRule">
        <div>
          <label for="rule-name" class="mb-1.5 block text-sm font-medium text-ink-300">Nama Aturan</label>
          <input id="rule-name" v-model="ruleForm.name" type="text" class="field" placeholder="cth. Pulihkan miner mati" required />
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="rule-kind" class="mb-1.5 block text-sm font-medium text-ink-300">Jenis Kondisi</label>
            <select id="rule-kind" v-model="ruleForm.kind" class="field">
              <option value="worker_status">{{ ruleConditionKindLabel('worker_status') }}</option>
              <option value="agent_unreachable">{{ ruleConditionKindLabel('agent_unreachable') }}</option>
            </select>
          </div>
          <div v-if="ruleForm.kind === 'worker_status'">
            <label for="rule-status" class="mb-1.5 block text-sm font-medium text-ink-300">Status Worker Pemicu</label>
            <select id="rule-status" v-model="ruleForm.status" class="field">
              <option v-for="s in RULE_WORKER_STATUSES" :key="s" :value="s">{{ workerStatusLabel(s) }} ({{ s }})</option>
            </select>
          </div>
          <div>
            <label for="rule-forsec" class="mb-1.5 block text-sm font-medium text-ink-300">
              Durasi Kondisi <span class="font-normal text-ink-400">(detik)</span>
            </label>
            <input id="rule-forsec" v-model.number="ruleForm.forSec" type="number" min="0" step="1" class="field" />
            <p class="mt-1 text-xs text-ink-400">Kondisi harus bertahan terus-menerus selama durasi ini sebelum aturan terpicu.</p>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="rule-action-source" class="mb-1.5 block text-sm font-medium text-ink-300">Sumber Aksi</label>
            <select id="rule-action-source" v-model="ruleForm.action.source" class="field">
              <option value="type">Tipe Perintah</option>
              <option value="template">Template Perintah</option>
            </select>
          </div>
          <div v-if="ruleForm.action.source === 'type'">
            <label for="rule-action-type" class="mb-1.5 block text-sm font-medium text-ink-300">Tipe Perintah</label>
            <select id="rule-action-type" v-model="ruleForm.action.type" class="field">
              <option v-for="t in COMMAND_TYPES" :key="t.value" :value="t.value">{{ t.label }} ({{ t.value }})</option>
            </select>
          </div>
          <div v-else>
            <label for="rule-action-template" class="mb-1.5 block text-sm font-medium text-ink-300">Template Perintah</label>
            <select id="rule-action-template" v-model="ruleForm.action.templateId" class="field">
              <option value="" disabled>Pilih template…</option>
              <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }} — {{ commandTypeLabel(t.type) }}</option>
            </select>
            <p v-if="templates.length === 0" class="mt-1 text-xs text-amber-400">Belum ada template. Buat template terlebih dahulu di Pusat Perintah.</p>
          </div>
        </div>

        <div>
          <span class="mb-1.5 block text-sm font-medium text-ink-300">Target Agent</span>
          <div class="flex gap-4 text-sm text-ink-200">
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="ruleForm.target.mode" type="radio" value="all" class="h-4 w-4 accent-indigo-500" />
              Semua Agent
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="ruleForm.target.mode" type="radio" value="list" class="h-4 w-4 accent-indigo-500" />
              Agent Tertentu
            </label>
          </div>
          <div v-if="ruleForm.target.mode === 'list'" class="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-ink-700 bg-ink-850 p-2">
            <p v-if="agents.length === 0" class="px-2 py-2 text-xs text-ink-400">Belum ada agent terdaftar.</p>
            <label
              v-for="a in agents"
              :key="a.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-ink-800"
            >
              <input v-model="ruleForm.target.ids" type="checkbox" :value="a.id" class="h-4 w-4 shrink-0 accent-indigo-500" />
              <span class="min-w-0 flex-1 truncate text-sm text-ink-100">{{ a.name }}</span>
              <StatusChip v-if="a.worker?.status" :status="a.worker.status" kind="worker" />
              <StatusChip v-else :status="a.status" kind="agent" />
            </label>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div>
            <label for="rule-cooldown" class="mb-1.5 block text-sm font-medium text-ink-300">
              Jeda Antar Pemicu <span class="font-normal text-ink-400">(detik)</span>
            </label>
            <input id="rule-cooldown" v-model.number="ruleForm.cooldownSec" type="number" min="0" step="1" class="field" />
            <p class="mt-1 text-xs text-ink-400">Bawaan 3600 (1 jam).</p>
          </div>
          <div>
            <label for="rule-maxday" class="mb-1.5 block text-sm font-medium text-ink-300">Maks. Pemicu per Hari</label>
            <input id="rule-maxday" v-model.number="ruleForm.maxPerDay" type="number" min="0" step="1" class="field" />
            <p class="mt-1 text-xs text-ink-400">Bawaan 5 kali per target.</p>
          </div>
          <div class="flex items-end pb-1">
            <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
              <input v-model="ruleForm.enabled" type="checkbox" class="h-4 w-4 accent-indigo-500" />
              Aktifkan aturan ini
            </label>
          </div>
        </div>

        <p v-if="ruleFormError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ ruleFormError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" :disabled="ruleSaving" @click="ruleModalOpen = false">Batal</button>
          <button type="submit" class="btn-primary" :disabled="ruleSaving">
            <LoaderCircle v-if="ruleSaving" class="h-4 w-4 animate-spin" />
            {{ ruleSaving ? 'Menyimpan…' : 'Simpan Aturan' }}
          </button>
        </div>
      </form>
    </BaseModal>

    <!-- Editor jadwal -->
    <BaseModal v-if="scheduleModalOpen" wide :title="scheduleForm.id ? 'Ubah Jadwal Perintah' : 'Buat Jadwal Perintah'" @close="scheduleModalOpen = false">
      <form class="space-y-4" @submit.prevent="saveSchedule">
        <div>
          <label for="sch-name" class="mb-1.5 block text-sm font-medium text-ink-300">Nama Jadwal</label>
          <input id="sch-name" v-model="scheduleForm.name" type="text" class="field" placeholder="cth. Cek status tiap jam" required />
        </div>

        <div>
          <label for="sch-cron" class="mb-1.5 block text-sm font-medium text-ink-300">
            Ekspresi Cron <span class="font-normal text-ink-400">(5 kolom: menit jam tanggal bulan hari)</span>
          </label>
          <input id="sch-cron" v-model="scheduleForm.cron" type="text" spellcheck="false" class="field font-mono" placeholder="*/15 * * * *" />
          <p class="mt-1 text-xs leading-relaxed text-ink-400">
            Contoh: <span class="font-mono text-ink-300">*/15 * * * *</span> tiap 15 menit ·
            <span class="font-mono text-ink-300">0 * * * *</span> tiap jam ·
            <span class="font-mono text-ink-300">0 6 * * *</span> tiap hari pukul 06.00 ·
            <span class="font-mono text-ink-300">0 6 * * 1</span> tiap Senin pukul 06.00.
            Dievaluasi mengikuti zona waktu server.
          </p>
          <p v-if="scheduleForm.nextRunAt" class="mt-1.5 text-xs text-emerald-300">
            Jalan berikutnya menurut server: {{ fmtDateTime(scheduleForm.nextRunAt) }}
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="sch-action-source" class="mb-1.5 block text-sm font-medium text-ink-300">Sumber Aksi</label>
            <select id="sch-action-source" v-model="scheduleForm.action.source" class="field">
              <option value="type">Tipe Perintah</option>
              <option value="template">Template Perintah</option>
            </select>
          </div>
          <div v-if="scheduleForm.action.source === 'type'">
            <label for="sch-action-type" class="mb-1.5 block text-sm font-medium text-ink-300">Tipe Perintah</label>
            <select id="sch-action-type" v-model="scheduleForm.action.type" class="field">
              <option v-for="t in COMMAND_TYPES" :key="t.value" :value="t.value">{{ t.label }} ({{ t.value }})</option>
            </select>
          </div>
          <div v-else>
            <label for="sch-action-template" class="mb-1.5 block text-sm font-medium text-ink-300">Template Perintah</label>
            <select id="sch-action-template" v-model="scheduleForm.action.templateId" class="field">
              <option value="" disabled>Pilih template…</option>
              <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }} — {{ commandTypeLabel(t.type) }}</option>
            </select>
            <p v-if="templates.length === 0" class="mt-1 text-xs text-amber-400">Belum ada template. Buat template terlebih dahulu di Pusat Perintah.</p>
          </div>
        </div>

        <div>
          <span class="mb-1.5 block text-sm font-medium text-ink-300">Target Agent</span>
          <div class="flex gap-4 text-sm text-ink-200">
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="scheduleForm.target.mode" type="radio" value="all" class="h-4 w-4 accent-indigo-500" />
              Semua Agent
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="scheduleForm.target.mode" type="radio" value="list" class="h-4 w-4 accent-indigo-500" />
              Agent Tertentu
            </label>
          </div>
          <div v-if="scheduleForm.target.mode === 'list'" class="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-ink-700 bg-ink-850 p-2">
            <p v-if="agents.length === 0" class="px-2 py-2 text-xs text-ink-400">Belum ada agent terdaftar.</p>
            <label
              v-for="a in agents"
              :key="a.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-ink-800"
            >
              <input v-model="scheduleForm.target.ids" type="checkbox" :value="a.id" class="h-4 w-4 shrink-0 accent-indigo-500" />
              <span class="min-w-0 flex-1 truncate text-sm text-ink-100">{{ a.name }}</span>
              <StatusChip v-if="a.worker?.status" :status="a.worker.status" kind="worker" />
              <StatusChip v-else :status="a.status" kind="agent" />
            </label>
          </div>
        </div>

        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
            <input v-model="scheduleForm.broadcast" type="checkbox" class="h-4 w-4 accent-indigo-500" />
            Kirim sebagai broadcast (satu batch)
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
            <input v-model="scheduleForm.enabled" type="checkbox" class="h-4 w-4 accent-indigo-500" />
            Aktifkan jadwal ini
          </label>
        </div>
        <p class="text-xs leading-relaxed text-ink-400">
          Tanpa broadcast, satu perintah terpisah dibuat untuk setiap target. Dengan broadcast, target yang tidak
          memenuhi syarat dilewati dengan alasan di dalam satu batch.
        </p>

        <p v-if="scheduleFormError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ scheduleFormError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" :disabled="scheduleSaving" @click="scheduleModalOpen = false">Batal</button>
          <button type="submit" class="btn-primary" :disabled="scheduleSaving">
            <LoaderCircle v-if="scheduleSaving" class="h-4 w-4 animate-spin" />
            {{ scheduleSaving ? 'Menyimpan…' : 'Simpan Jadwal' }}
          </button>
        </div>
      </form>
    </BaseModal>

    <!-- Konfirmasi hapus -->
    <ConfirmDialog
      v-if="ruleDeleteTarget"
      title="Hapus Aturan Otomasi"
      :message="`Aturan '${ruleDeleteTarget.name}' akan dihapus permanen. Perintah yang sudah dibuat oleh aturan ini tidak ikut terhapus. Lanjutkan?`"
      confirm-label="Ya, Hapus"
      :danger="true"
      :on-confirm="doDeleteRule"
      @close="ruleDeleteTarget = null"
    />
    <ConfirmDialog
      v-if="scheduleDeleteTarget"
      title="Hapus Jadwal Perintah"
      :message="`Jadwal '${scheduleDeleteTarget.name}' akan dihapus permanen. Perintah yang sudah dibuat oleh jadwal ini tidak ikut terhapus. Lanjutkan?`"
      confirm-label="Ya, Hapus"
      :danger="true"
      :on-confirm="doDeleteSchedule"
      @close="scheduleDeleteTarget = null"
    />
  </div>
</template>
