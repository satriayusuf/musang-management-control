<script setup lang="ts">
import { Save, LoaderCircle, ShieldAlert, BellRing, SendHorizontal, RefreshCw, Workflow, DatabaseZap, Download, Eraser, Copy, Check, KeyRound } from 'lucide-vue-next'
import { api, type AgentSummary, type AlertNotificationInfo, type PoolTestResult, type RetentionRunResult, type WorkerInfo } from '~/lib/api'
import { fmtDateTime, fmtRelative } from '~/lib/format'
import {
  SENSITIVE_COMMAND_TYPES,
  commandTypeLabel,
  alertConditionLabel,
  alertChannelLabel,
  alertDeliveryStatusLabel,
  userRoleLabel,
} from '~/lib/labels'

const auth = useAuthStore()
/** Perubahan pengaturan, retensi, dan ekspor hanya untuk ADMIN (CONTRACT-3 §1). */
const isAdmin = computed(() => auth.isAdmin)

interface ThresholdDef {
  key: string
  label: string
  unit: string
  description: string
  step?: string
}

const THRESHOLDS: ThresholdDef[] = [
  { key: 'heartbeat_interval_sec', label: 'Interval Heartbeat', unit: 'detik', description: 'Jeda pengiriman heartbeat dari bridge ke server.' },
  { key: 'unreachable_missed_beats', label: 'Heartbeat Terlewat untuk Tak Terjangkau', unit: 'kali', description: 'Agent ditandai tak terjangkau setelah melewatkan sejumlah heartbeat ini.' },
  { key: 'min_mem_start_gib', label: 'Memori Minimum untuk Start Miner', unit: 'GiB', description: 'Memori tersedia minimum agar miner boleh dijalankan; di bawah ini status Gagal Start.', step: '0.1' },
  { key: 'min_hashrate_hs', label: 'Hashrate Minimum', unit: 'H/s', description: 'Hashrate di bawah nilai ini membuat worker berstatus Waspada.', step: '0.1' },
  { key: 'mem_warn_margin_gib', label: 'Margin Peringatan Memori', unit: 'GiB', description: 'Worker berstatus Waspada bila memori tersedia kurang dari ambang start ditambah margin ini.', step: '0.1' },
  { key: 'no_share_warn_sec', label: 'Peringatan Tanpa Share', unit: 'detik', description: 'Service aktif tanpa share lebih lama dari ini → status Waspada.' },
  { key: 'pool_stall_sec', label: 'Ambang Pool Stall', unit: 'detik', description: 'Worker hilang dari pool lebih lama dari ini (dengan hashing lokal normal) → status Pool Stall.' },
  { key: 'pairing_ttl_sec', label: 'Masa Berlaku Kode Pairing', unit: 'detik', description: 'Kode pairing kedaluwarsa setelah jangka waktu ini.' },
  { key: 'command_ttl_sec', label: 'Masa Berlaku Perintah', unit: 'detik', description: 'Perintah yang belum diambil agent setelah jangka waktu ini menjadi Kedaluwarsa.' },
  { key: 'verify_window_sec', label: 'Jendela Verifikasi Perintah', unit: 'detik', description: 'Waktu maksimum menunggu bukti heartbeat bahwa perintah pengubah status miner benar-benar berhasil.' },
]

const values = ref<Record<string, number | undefined>>({})
const poolProvider = ref('none')
const poolBaseUrl = ref('')
const poolLookupParam = ref('')
const poolApiKey = ref('')
const poolApiKeySet = ref(false)
/** CONTRACT-5 F1: bantuan & placeholder khusus penyedia bntpool. */
const isBntpool = computed(() => poolProvider.value === 'bntpool')
/** Hasil tes fetch pool dari respons simpan terakhir (CONTRACT-5 B5); null bila belum ada. */
const poolTest = ref<PoolTestResult | null>(null)

// ---------- Fase 2: alert multi-kanal ----------
const alertDeadAfterSec = ref<number | undefined>(600)
const webhookUrl = ref('')
const webhookEnabled = ref(false)
const webhookConfigured = ref(false)
const telegramToken = ref('')
const telegramChatId = ref('')
const telegramEnabled = ref(false)
const telegramConfigured = ref(false)
const testingChannel = ref<'webhook' | 'telegram' | ''>('')
const testResults = ref<Record<string, { ok: boolean; text: string }>>({})

const alerts = ref<AlertNotificationInfo[]>([])
const alertsLoading = ref(false)
const workersById = ref<Record<string, WorkerInfo>>({})

// ---------- Fase 3: otomasi, retensi, ekspor ----------
const automationEnabled = ref(true)

interface RetentionDef {
  key: string
  label: string
  description: string
  defaultDays: number
}

const RETENTION_DEFS: RetentionDef[] = [
  { key: 'retention_heartbeats_days', label: 'Heartbeat', description: 'Baris heartbeat mentah dari bridge.', defaultDays: 30 },
  { key: 'retention_terminal_commands_days', label: 'Perintah Selesai', description: 'Perintah yang sudah berstatus akhir (berhasil/gagal/kedaluwarsa). Perintah yang masih berjalan tidak pernah dihapus.', defaultDays: 90 },
  { key: 'retention_alerts_days', label: 'Alert & Pengiriman', description: 'Notifikasi alert beserta catatan pengirimannya.', defaultDays: 90 },
  { key: 'retention_pool_snapshots_days', label: 'Snapshot Pool', description: 'Hasil pemeriksaan berkala ke API pool.', defaultDays: 30 },
]

const retentionDays = ref<Record<string, number | undefined>>({})
const retentionRunning = ref(false)
const retentionResult = ref<RetentionRunResult | null>(null)
const retentionError = ref('')

async function runRetentionNow() {
  if (retentionRunning.value) return
  retentionRunning.value = true
  retentionError.value = ''
  retentionResult.value = null
  try {
    retentionResult.value = await api.runRetention()
  } catch (e) {
    retentionError.value = e instanceof Error ? e.message : 'Pembersihan retensi gagal dijalankan.'
  } finally {
    retentionRunning.value = false
  }
}

const EXPORT_KINDS: { kind: 'agents' | 'commands' | 'events' | 'audit'; label: string; description: string }[] = [
  { kind: 'agents', label: 'Agent (CSV)', description: 'Daftar agent beserta status worker saat ini.' },
  { kind: 'commands', label: 'Perintah (CSV)', description: 'Perintah pada rentang terpilih, termasuk sumber dan hasilnya.' },
  { kind: 'events', label: 'Event (CSV)', description: 'Peristiwa dan linimasa pemulihan pada rentang terpilih.' },
  { kind: 'audit', label: 'Log Audit (CSV)', description: 'Jejak audit tindakan pengguna dan sistem pada rentang terpilih.' },
]

const exportRange = ref('30d')
const exportingKind = ref('')
const exportError = ref('')
const exportNote = ref('')

async function doExport(kind: 'agents' | 'commands' | 'events' | 'audit') {
  if (exportingKind.value) return
  exportingKind.value = kind
  exportError.value = ''
  exportNote.value = ''
  try {
    await api.downloadExport(kind, exportRange.value)
    exportNote.value = `Berkas ${kind}.csv berhasil diunduh.`
  } catch (e) {
    exportError.value = e instanceof Error ? e.message : 'Ekspor gagal.'
  } finally {
    exportingKind.value = ''
  }
}

// ---------- Fase 3 (§8): enrollment mandiri agent ----------
const AGENT_MD_URL = 'https://musang.mikasu.lol/agent.md'
const enrollmentKey = ref('')
const enrollmentCopied = ref<'url' | 'key' | ''>('')
const rotateDialogOpen = ref(false)

async function copyText(text: string, which: 'url' | 'key') {
  try {
    await navigator.clipboard.writeText(text)
    enrollmentCopied.value = which
    setTimeout(() => (enrollmentCopied.value = ''), 2000)
  } catch {
    /* clipboard tidak tersedia */
  }
}

async function doRotateEnrollment() {
  // Kegagalan dibiarkan terlempar agar ditampilkan ConfirmDialog.
  const key = await api.rotateEnrollmentKey()
  if (key) enrollmentKey.value = key
  rotateDialogOpen.value = false
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

async function loadAlerts() {
  alertsLoading.value = true
  try {
    const res = await api.listAlerts({ page: 1, page_size: 20 })
    alerts.value = res.items
  } catch {
    /* daftar alert gagal dimuat; abaikan */
  } finally {
    alertsLoading.value = false
  }
}

async function sendTest(channel: 'webhook' | 'telegram') {
  if (testingChannel.value) return
  testingChannel.value = channel
  try {
    const res = await api.testAlert(channel)
    const errText =
      typeof res.error === 'string' ? res.error : typeof res.message === 'string' && res.ok === false ? res.message : ''
    const failed = res.ok === false || res.success === false || res.status === 'failed' || !!errText
    testResults.value = {
      ...testResults.value,
      [channel]: failed
        ? { ok: false, text: errText || `Pengiriman tes via ${alertChannelLabel(channel)} gagal.` }
        : { ok: true, text: `Pesan tes berhasil dikirim via ${alertChannelLabel(channel)}.` },
    }
    void loadAlerts()
  } catch (e) {
    testResults.value = {
      ...testResults.value,
      [channel]: { ok: false, text: e instanceof Error ? e.message : `Pengiriman tes via ${alertChannelLabel(channel)} gagal.` },
    }
  } finally {
    testingChannel.value = ''
  }
}

function alertAgentName(n: AlertNotificationInfo): string {
  if (n.agent_name) return n.agent_name
  if (n.agent_id) return agents.value.find((a) => a.id === n.agent_id)?.name ?? n.agent_id
  return '—'
}

function alertWorkerName(n: AlertNotificationInfo): string {
  if (n.worker_name) return n.worker_name
  if (n.worker_id) return workersById.value[n.worker_id]?.name ?? n.worker_id
  return '—'
}

const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const saveSuccess = ref('')

const agents = ref<AgentSummary[]>([])

async function load() {
  loading.value = true
  try {
    const [settings, agentPage, workerRes] = await Promise.all([
      api.getSettings(),
      api.listAgents({ page: 1, page_size: 200 }).catch(() => null),
      api.listWorkers().catch(() => null),
    ])
    const v: Record<string, number | undefined> = {}
    for (const def of THRESHOLDS) {
      const raw = settings[def.key]
      v[def.key] = typeof raw === 'number' ? raw : raw !== undefined ? Number(raw) : undefined
    }
    values.value = v
    poolProvider.value = typeof settings.pool_provider === 'string' ? settings.pool_provider : 'none'
    poolBaseUrl.value = typeof settings.pool_api_base_url === 'string' ? settings.pool_api_base_url : ''
    poolLookupParam.value = typeof settings.pool_lookup_param === 'string' ? settings.pool_lookup_param : ''
    poolApiKeySet.value = settings.pool_api_key_set === true
    // Alert multi-kanal (Fase 2)
    const deadRaw = settings.alert_dead_after_sec
    alertDeadAfterSec.value = typeof deadRaw === 'number' ? deadRaw : deadRaw !== undefined ? Number(deadRaw) : 600
    webhookUrl.value = typeof settings.alert_webhook_url === 'string' ? settings.alert_webhook_url : ''
    webhookEnabled.value = asBool(settings.alert_webhook_enabled)
    webhookConfigured.value = asBool(settings.alert_webhook_configured)
    telegramChatId.value = typeof settings.alert_telegram_chat_id === 'string' ? settings.alert_telegram_chat_id : ''
    telegramEnabled.value = asBool(settings.alert_telegram_enabled)
    telegramConfigured.value = asBool(settings.alert_telegram_configured)
    // Otomasi & retensi (Fase 3)
    automationEnabled.value =
      settings.automation_enabled === undefined ? true : asBool(settings.automation_enabled)
    const rd: Record<string, number | undefined> = {}
    for (const def of RETENTION_DEFS) {
      const raw = settings[def.key]
      rd[def.key] = typeof raw === 'number' ? raw : raw !== undefined ? Number(raw) : def.defaultDays
    }
    retentionDays.value = rd
    // Kunci enrollment hanya dikirim server untuk ADMIN (CONTRACT-3 §8).
    enrollmentKey.value = typeof settings.enrollment_key === 'string' ? settings.enrollment_key : ''
    if (agentPage) agents.value = agentPage.items
    if (workerRes) {
      const map: Record<string, WorkerInfo> = {}
      for (const w of workerRes.items) map[w.id] = w
      workersById.value = map
    }
    poolTest.value = null
    loadError.value = ''
    void loadAlerts()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat pengaturan.'
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

async function save() {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  saveSuccess.value = ''
  poolTest.value = null
  try {
    const body: Record<string, unknown> = {}
    for (const def of THRESHOLDS) {
      const v = values.value[def.key]
      if (v !== undefined && v !== null && !Number.isNaN(v)) body[def.key] = v
    }
    body.pool_provider = poolProvider.value
    body.pool_api_base_url = poolBaseUrl.value
    body.pool_lookup_param = poolLookupParam.value
    if (poolApiKey.value.trim()) {
      body.pool_api_key = poolApiKey.value.trim()
    }
    // Alert multi-kanal (Fase 2) — token bot hanya dikirim bila diisi (write-only).
    if (alertDeadAfterSec.value !== undefined && alertDeadAfterSec.value !== null && !Number.isNaN(alertDeadAfterSec.value)) {
      body.alert_dead_after_sec = alertDeadAfterSec.value
    }
    body.alert_webhook_url = webhookUrl.value.trim()
    body.alert_webhook_enabled = webhookEnabled.value
    body.alert_telegram_chat_id = telegramChatId.value.trim()
    body.alert_telegram_enabled = telegramEnabled.value
    if (telegramToken.value.trim()) {
      body.alert_telegram_bot_token = telegramToken.value.trim()
    }
    // Otomasi & retensi (Fase 3)
    body.automation_enabled = automationEnabled.value
    for (const def of RETENTION_DEFS) {
      const v = retentionDays.value[def.key]
      if (v !== undefined && v !== null && !Number.isNaN(v)) body[def.key] = v
    }
    const saveRes = await api.updateSettings(body)
    // CONTRACT-5 B5: respons simpan dapat menyertai hasil tes fetch pool.
    poolTest.value = saveRes?.pool_test ?? null
    if (poolApiKey.value.trim()) {
      poolApiKeySet.value = true
      poolApiKey.value = ''
    }
    if (telegramToken.value.trim()) {
      telegramConfigured.value = true
      telegramToken.value = ''
    }
    if (webhookUrl.value.trim()) webhookConfigured.value = true
    saveSuccess.value = 'Pengaturan berhasil disimpan.'
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Gagal menyimpan pengaturan.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-xl font-semibold text-white">Pengaturan</h1>
      <p class="mt-0.5 text-sm text-ink-400">Ambang pemantauan, konfigurasi pool, dan izin agent. Perubahan berlaku tanpa perlu memulai ulang server.</p>
    </div>

    <p v-if="loadError" class="mb-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ loadError }}</p>
    <div v-if="loading" class="py-14 text-center text-sm text-ink-400">Memuat pengaturan…</div>

    <form v-else class="space-y-5" @submit.prevent="save">
      <!-- Ambang pemantauan -->
      <section class="panel p-5">
        <h2 class="text-sm font-semibold text-white">Ambang Pemantauan</h2>
        <p class="mt-0.5 text-xs text-ink-400">Nilai-nilai ini dipakai mesin aturan status di server dan dibagikan ke bridge saat registrasi.</p>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div v-for="def in THRESHOLDS" :key="def.key">
            <label :for="`set-${def.key}`" class="mb-1 block text-sm font-medium text-ink-300">
              {{ def.label }} <span class="font-normal text-ink-400">({{ def.unit }})</span>
            </label>
            <input
              :id="`set-${def.key}`"
              v-model.number="values[def.key]"
              type="number"
              min="0"
              :step="def.step ?? '1'"
              class="field"
            />
            <p class="mt-1 text-xs leading-relaxed text-ink-400">{{ def.description }}</p>
          </div>
        </div>
      </section>

      <!-- Konfigurasi Pool -->
      <section class="panel p-5">
        <h2 class="text-sm font-semibold text-white">Konfigurasi API Pool</h2>
        <p class="mt-0.5 text-xs text-ink-400">
          Server memeriksa data worker ke API pool secara terpusat untuk mendeteksi Pool Stall.
          Bila penyedia disetel ke
          <span class="font-medium text-ink-200">none</span>, status worker dihitung dari laporan bridge saja.
        </p>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label for="pool-provider" class="mb-1 block text-sm font-medium text-ink-300">Penyedia Pool</label>
            <select id="pool-provider" v-model="poolProvider" class="field">
              <option value="none">none — pemeriksaan pool nonaktif</option>
              <option value="placeholder">placeholder — adapter contoh (nonaktif)</option>
              <option value="bntpool">bntpool — BNTPool (Blocknet)</option>
            </select>
          </div>
          <div>
            <label for="pool-base" class="mb-1 block text-sm font-medium text-ink-300">URL Dasar API Pool</label>
            <input
              id="pool-base"
              v-model="poolBaseUrl"
              type="url"
              :placeholder="isBntpool ? 'https://bntpool.com/api' : 'https://pool.contoh.id/api'"
              class="field"
            />
          </div>
          <div>
            <label for="pool-lookup" class="mb-1 block text-sm font-medium text-ink-300">Parameter Pencarian Worker</label>
            <input
              id="pool-lookup"
              v-model="poolLookupParam"
              type="text"
              :placeholder="isBntpool ? 'Alamat wallet (address) di pool' : 'cth. nama worker / alamat wallet'"
              class="field"
            />
            <p v-if="isBntpool" class="mt-1 text-xs text-ink-400">
              Alamat wallet (address) di pool. Nama worker diambil otomatis dari registrasi agent.
            </p>
          </div>
          <div>
            <label for="pool-key" class="mb-1 block text-sm font-medium text-ink-300">
              Kunci API Pool <span class="font-normal text-ink-400">(hanya tulis)</span>
            </label>
            <input
              id="pool-key"
              v-model="poolApiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="poolApiKeySet ? '•••••••• (sudah diatur — isi untuk mengganti)' : 'Belum diatur'"
              class="field"
            />
            <p v-if="isBntpool" class="mt-1 text-xs text-ink-400">
              Tidak diperlukan untuk bntpool — API pool bersifat publik. Kolom ini boleh kosong.
            </p>
            <p v-else class="mt-1 text-xs text-ink-400">
              Kunci tidak pernah ditampilkan kembali setelah disimpan. Untuk produksi, mengatur lewat
              variabel lingkungan server lebih dianjurkan.
            </p>
          </div>
        </div>

        <!-- Hasil tes fetch pool (CONTRACT-5 B5/F1) -->
        <div
          v-if="poolTest"
          class="mt-4 rounded-xl border px-4 py-3"
          :class="poolTest.fetch_ok ? 'border-ink-700 bg-ink-850/60' : 'border-amber-500/30 bg-amber-500/10'"
        >
          <p class="text-sm font-medium" :class="poolTest.fetch_ok ? 'text-white' : 'text-amber-200'">Hasil Tes Fetch Pool</p>
          <template v-if="!poolTest.fetch_ok">
            <p class="mt-1 text-sm leading-relaxed text-amber-200">
              Pengaturan tetap tersimpan, tetapi tes fetch ke pool gagal{{
                poolTest.error ? `: ${poolTest.error}` : '.'
              }}
              Kegagalan bisa bersifat sesaat — pemeriksaan berkala akan mencoba lagi sesuai jadwalnya.
            </p>
          </template>
          <template v-else>
            <ul v-if="poolTest.results && poolTest.results.length" class="mt-2 space-y-1.5">
              <li v-for="r in poolTest.results" :key="r.agent_id" class="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span class="font-medium text-ink-100">{{ r.worker_name }}</span>
                <span class="text-xs text-ink-400">{{ r.agent_name }}</span>
                <span v-if="r.outcome === 'found'" class="text-emerald-300">
                  Ketemu — share terakhir {{ fmtRelative(r.pool_last_share_at) }} ·
                  {{ fmtDateTime(r.pool_last_share_at) }}
                </span>
                <span v-else class="text-amber-300">Tidak ketemu di pool</span>
              </li>
            </ul>
            <p v-else class="mt-1 text-sm text-ink-400">
              Fetch berhasil, tetapi belum ada agent dengan nama worker terdaftar untuk dites.
            </p>
          </template>
        </div>
      </section>

      <!-- Alert Multi-Kanal (Fase 2) -->
      <section class="panel p-5">
        <div class="flex items-center gap-2">
          <BellRing class="h-4 w-4 text-indigo-400" />
          <h2 class="text-sm font-semibold text-white">Alert Multi-Kanal</h2>
        </div>
        <p class="mt-0.5 text-xs leading-relaxed text-ink-400">
          Notifikasi dikirim sekali per kejadian: worker Mati atau Gagal Start terus-menerus melewati ambang
          di bawah, agent menjadi Tak Terjangkau, atau worker Pool Stall (bila pool dikonfigurasi).
          Kegagalan pengiriman dicatat dan tidak menghentikan pemantauan.
        </p>

        <div class="mt-4 max-w-sm">
          <label for="alert-dead" class="mb-1 block text-sm font-medium text-ink-300">
            Ambang Alert Worker Mati / Gagal Start <span class="font-normal text-ink-400">(detik)</span>
          </label>
          <input id="alert-dead" v-model.number="alertDeadAfterSec" type="number" min="0" step="1" class="field" />
          <p class="mt-1 text-xs text-ink-400">Alert dibuat bila worker Mati/Gagal Start terus-menerus selama ini (bawaan 600 detik).</p>
        </div>

        <div class="mt-5 grid gap-5 lg:grid-cols-2">
          <!-- Kanal Webhook -->
          <div class="rounded-xl border border-ink-700 bg-ink-850/60 p-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-medium text-white">Webhook</h3>
              <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
                <input v-model="webhookEnabled" type="checkbox" class="h-4 w-4 accent-indigo-500" />
                Aktif
              </label>
            </div>
            <p class="mt-0.5 text-xs text-ink-400">
              Status konfigurasi: {{ webhookConfigured ? 'URL sudah diatur' : 'URL belum diatur' }}
            </p>
            <div class="mt-3">
              <label for="alert-webhook-url" class="mb-1 block text-sm font-medium text-ink-300">URL Webhook</label>
              <input
                id="alert-webhook-url"
                v-model="webhookUrl"
                type="url"
                placeholder="https://contoh.id/hook/alert"
                class="field"
              />
              <p class="mt-1 text-xs text-ink-400">Server mengirim POST JSON {title, body, condition, agent_id, worker_id, at} dengan batas waktu 5 detik.</p>
            </div>
            <div v-if="isAdmin" class="mt-3 flex items-center gap-3">
              <button type="button" class="btn-ghost !px-3 !py-2 text-xs" :disabled="testingChannel !== ''" @click="sendTest('webhook')">
                <LoaderCircle v-if="testingChannel === 'webhook'" class="h-3.5 w-3.5 animate-spin" />
                <SendHorizontal v-else class="h-3.5 w-3.5" />
                Kirim Tes
              </button>
              <p v-if="testResults.webhook" class="text-xs" :class="testResults.webhook.ok ? 'text-emerald-300' : 'text-red-400'">
                {{ testResults.webhook.text }}
              </p>
            </div>
          </div>

          <!-- Kanal Telegram -->
          <div class="rounded-xl border border-ink-700 bg-ink-850/60 p-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-medium text-white">Telegram</h3>
              <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
                <input v-model="telegramEnabled" type="checkbox" class="h-4 w-4 accent-indigo-500" />
                Aktif
              </label>
            </div>
            <p class="mt-0.5 text-xs text-ink-400">
              Status konfigurasi: {{ telegramConfigured ? 'Token bot sudah diatur' : 'Token bot belum diatur' }}
            </p>
            <div class="mt-3 space-y-3">
              <div>
                <label for="alert-tg-token" class="mb-1 block text-sm font-medium text-ink-300">
                  Token Bot Telegram <span class="font-normal text-ink-400">(hanya tulis)</span>
                </label>
                <input
                  id="alert-tg-token"
                  v-model="telegramToken"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="telegramConfigured ? '•••••••• (sudah diatur — isi untuk mengganti)' : 'Belum diatur'"
                  class="field"
                />
                <p class="mt-1 text-xs text-ink-400">Token tidak pernah ditampilkan kembali setelah disimpan.</p>
              </div>
              <div>
                <label for="alert-tg-chat" class="mb-1 block text-sm font-medium text-ink-300">Chat ID Telegram</label>
                <input id="alert-tg-chat" v-model="telegramChatId" type="text" placeholder="cth. -1001234567890" class="field" />
              </div>
            </div>
            <div v-if="isAdmin" class="mt-3 flex items-center gap-3">
              <button type="button" class="btn-ghost !px-3 !py-2 text-xs" :disabled="testingChannel !== ''" @click="sendTest('telegram')">
                <LoaderCircle v-if="testingChannel === 'telegram'" class="h-3.5 w-3.5 animate-spin" />
                <SendHorizontal v-else class="h-3.5 w-3.5" />
                Kirim Tes
              </button>
              <p v-if="testResults.telegram" class="text-xs" :class="testResults.telegram.ok ? 'text-emerald-300' : 'text-red-400'">
                {{ testResults.telegram.text }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div class="grid gap-5 xl:grid-cols-2">
        <!-- Perintah sensitif -->
        <section class="panel p-5">
          <div class="flex items-center gap-2">
            <ShieldAlert class="h-4 w-4 text-amber-400" />
            <h2 class="text-sm font-semibold text-white">Tipe Perintah Sensitif</h2>
          </div>
          <p class="mt-1 text-xs leading-relaxed text-ink-400">
            Tipe berikut selalu memerlukan konfirmasi eksplisit sebelum dibuat, dan setiap
            pembuatannya dicatat di log audit. Daftar ini bersifat tetap pada Fase 1.
          </p>
          <ul class="mt-3 space-y-2">
            <li v-for="t in SENSITIVE_COMMAND_TYPES" :key="t" class="flex items-center justify-between rounded-lg bg-ink-850 px-3 py-2 text-sm">
              <span>{{ commandTypeLabel(t) }}</span>
              <span class="font-mono text-xs text-ink-400">{{ t }}</span>
            </li>
          </ul>
        </section>

        <!-- Izin agent -->
        <section class="panel p-5">
          <h2 class="text-sm font-semibold text-white">Izin Agent (Capabilities)</h2>
          <p class="mt-1 text-xs leading-relaxed text-ink-400">
            Kemampuan yang didaftarkan setiap bridge saat registrasi. Bridge menolak perintah di luar
            daftar kemampuannya. Pada Fase 1 daftar ini bersifat hanya-baca.
          </p>
          <EmptyState v-if="agents.length === 0" message="Belum ada agent terdaftar." />
          <ul v-else class="mt-3 max-h-72 space-y-2.5 overflow-y-auto pr-1">
            <li v-for="a in agents" :key="a.id" class="rounded-lg bg-ink-850 px-3 py-2">
              <p class="text-sm font-medium text-white">{{ a.name }}</p>
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                <span
                  v-for="c in a.capabilities ?? []"
                  :key="c"
                  class="rounded bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-ink-200"
                >
                  {{ c }}
                </span>
                <span v-if="!a.capabilities || a.capabilities.length === 0" class="text-xs text-ink-400">Tidak ada kemampuan terdaftar</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- Otomasi (Fase 3) -->
      <section class="panel p-5">
        <div class="flex items-center gap-2">
          <Workflow class="h-4 w-4 text-indigo-400" />
          <h2 class="text-sm font-semibold text-white">Otomasi</h2>
        </div>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p class="max-w-xl text-xs leading-relaxed text-ink-400">
            Sakelar utama untuk aturan otomasi dan jadwal perintah di halaman
            <NuxtLink to="/automation" class="font-medium text-indigo-300 hover:text-indigo-200">Otomasi</NuxtLink>.
            Bila nonaktif, tidak ada aturan atau jadwal yang berjalan — perintah manual tidak terpengaruh.
          </p>
          <label class="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
            <input v-model="automationEnabled" type="checkbox" class="h-4 w-4 accent-indigo-500" />
            Otomasi Aktif
          </label>
        </div>
      </section>

      <!-- Enrollment mandiri agent (Fase 3 §8, ADMIN) -->
      <section v-if="isAdmin" class="panel p-5">
        <div class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-indigo-400" />
          <h2 class="text-sm font-semibold text-white">Enrollment Mandiri Agent</h2>
        </div>
        <p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-400">
          Berikan URL dokumen enrollment berikut kepada agent baru — agent akan memasang bridge dan
          mendaftar sendiri tanpa kode pairing manual. Dokumen dirender langsung oleh server dengan
          kunci enrollment yang berlaku saat ini, jadi memutar kunci akan langsung menonaktifkan
          salinan yang pernah ditempel sebelumnya.
        </p>
        <div class="mt-4 space-y-4">
          <div>
            <span class="mb-1 block text-sm font-medium text-ink-300">URL Dokumen Enrollment</span>
            <div class="flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-2.5">
              <code class="flex-1 break-all font-mono text-sm text-emerald-300">{{ AGENT_MD_URL }}</code>
              <button type="button" class="btn-ghost shrink-0 !px-2 !py-1.5 text-xs" @click="copyText(AGENT_MD_URL, 'url')">
                <Check v-if="enrollmentCopied === 'url'" class="h-3.5 w-3.5 text-emerald-400" />
                <Copy v-else class="h-3.5 w-3.5" />
                {{ enrollmentCopied === 'url' ? 'Tersalin' : 'Salin' }}
              </button>
            </div>
          </div>
          <div>
            <span class="mb-1 block text-sm font-medium text-ink-300">Kunci Enrollment Saat Ini</span>
            <div class="flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-2.5">
              <code class="flex-1 break-all font-mono text-xs text-ink-200">{{ enrollmentKey || '— (tidak tersedia)' }}</code>
              <button
                v-if="enrollmentKey"
                type="button"
                class="btn-ghost shrink-0 !px-2 !py-1.5 text-xs"
                @click="copyText(enrollmentKey, 'key')"
              >
                <Check v-if="enrollmentCopied === 'key'" class="h-3.5 w-3.5 text-emerald-400" />
                <Copy v-else class="h-3.5 w-3.5" />
                {{ enrollmentCopied === 'key' ? 'Tersalin' : 'Salin' }}
              </button>
            </div>
            <p class="mt-1 text-xs text-ink-400">
              Kunci ini bersifat rahasia dan hanya ditampilkan kepada Administrator. Agent yang mendaftar
              dengan kunci ini tercatat dengan lencana “Daftar Mandiri”.
            </p>
          </div>
          <div class="flex items-center gap-3">
            <button type="button" class="btn-ghost !px-3 !py-2 text-xs !text-red-300 hover:!bg-red-500/10" @click="rotateDialogOpen = true">
              <KeyRound class="h-3.5 w-3.5" />
              Putar Kunci
            </button>
            <p class="text-xs text-ink-400">Kunci baru berlaku segera setelah diputar.</p>
          </div>
        </div>
      </section>

      <!-- Retensi data (Fase 3) -->
      <section class="panel p-5">
        <div class="flex items-center gap-2">
          <DatabaseZap class="h-4 w-4 text-indigo-400" />
          <h2 class="text-sm font-semibold text-white">Retensi Data</h2>
        </div>
        <p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-400">
          Data lama dihapus otomatis paling sering satu jam sekali sesuai jendela di bawah. Nilai 0 menonaktifkan
          pembersihan untuk kelompok data tersebut. Agent, pengguna, log audit, event, dan sesi tidak pernah dihapus.
        </p>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div v-for="def in RETENTION_DEFS" :key="def.key">
            <label :for="`ret-${def.key}`" class="mb-1 block text-sm font-medium text-ink-300">
              {{ def.label }} <span class="font-normal text-ink-400">(hari)</span>
            </label>
            <input :id="`ret-${def.key}`" v-model.number="retentionDays[def.key]" type="number" min="0" step="1" class="field" />
            <p class="mt-1 text-xs leading-relaxed text-ink-400">{{ def.description }}</p>
          </div>
        </div>
        <div v-if="isAdmin" class="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" class="btn-ghost !px-3 !py-2 text-xs" :disabled="retentionRunning" @click="runRetentionNow">
            <LoaderCircle v-if="retentionRunning" class="h-3.5 w-3.5 animate-spin" />
            <Eraser v-else class="h-3.5 w-3.5" />
            {{ retentionRunning ? 'Membersihkan…' : 'Jalankan Pembersihan' }}
          </button>
          <p v-if="retentionResult" class="text-xs text-emerald-300">
            Terhapus — heartbeat: {{ retentionResult.heartbeats }}, perintah selesai: {{ retentionResult.commands }},
            alert: {{ retentionResult.alerts }}, snapshot pool: {{ retentionResult.pool_snapshots }}.
          </p>
          <p v-if="retentionError" class="text-xs text-red-400">{{ retentionError }}</p>
        </div>
      </section>

      <!-- Ekspor data (Fase 3, ADMIN) -->
      <section v-if="isAdmin" class="panel p-5">
        <div class="flex items-center gap-2">
          <Download class="h-4 w-4 text-indigo-400" />
          <h2 class="text-sm font-semibold text-white">Ekspor Data</h2>
        </div>
        <p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-400">
          Unduh data sebagai berkas CSV. Rentang berlaku untuk data yang memiliki kolom waktu
          (perintah, event, log audit); ekspor agent berisi kondisi terkini.
        </p>
        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label for="export-range" class="mb-1 block text-sm font-medium text-ink-300">Rentang Waktu</label>
            <select id="export-range" v-model="exportRange" class="field !w-auto">
              <option value="24h">24 Jam Terakhir</option>
              <option value="7d">7 Hari Terakhir</option>
              <option value="30d">30 Hari Terakhir</option>
              <option value="all">Semua Data</option>
            </select>
          </div>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div v-for="item in EXPORT_KINDS" :key="item.kind" class="rounded-xl border border-ink-700 bg-ink-850/60 p-3.5">
            <p class="text-sm font-medium text-white">{{ item.label }}</p>
            <p class="mt-0.5 text-xs leading-relaxed text-ink-400">{{ item.description }}</p>
            <button
              type="button"
              class="btn-ghost mt-3 !px-3 !py-1.5 text-xs"
              :disabled="exportingKind !== ''"
              @click="doExport(item.kind)"
            >
              <LoaderCircle v-if="exportingKind === item.kind" class="h-3.5 w-3.5 animate-spin" />
              <Download v-else class="h-3.5 w-3.5" />
              Unduh
            </button>
          </div>
        </div>
        <p v-if="exportNote" class="mt-3 text-xs text-emerald-300">{{ exportNote }}</p>
        <p v-if="exportError" class="mt-3 text-xs text-red-400">{{ exportError }}</p>
      </section>

      <p v-if="saveError" class="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ saveError }}</p>
      <p v-if="saveSuccess" class="rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{{ saveSuccess }}</p>

      <div v-if="isAdmin" class="flex justify-end">
        <button type="submit" class="btn-primary" :disabled="saving">
          <LoaderCircle v-if="saving" class="h-4 w-4 animate-spin" />
          <Save v-else class="h-4 w-4" />
          {{ saving ? 'Menyimpan…' : 'Simpan Pengaturan' }}
        </button>
      </div>
      <p v-else class="rounded-xl bg-ink-850 px-4 py-3 text-sm text-ink-400">
        Anda masuk dengan peran {{ userRoleLabel(auth.role) }}. Perubahan pengaturan hanya dapat
        disimpan oleh Administrator; nilai di halaman ini ditampilkan sebagai hanya-baca.
      </p>
    </form>

    <!-- Konfirmasi putar kunci enrollment -->
    <ConfirmDialog
      v-if="rotateDialogOpen"
      title="Putar Kunci Enrollment"
      message="Kunci enrollment baru akan dibuat dan kunci lama langsung berhenti berlaku. Salinan dokumen agent.md yang pernah ditempel ke agent lain akan berhenti bekerja — agent yang sudah terdaftar tidak terpengaruh. Lanjutkan?"
      confirm-label="Ya, Putar Kunci"
      :danger="true"
      :on-confirm="doRotateEnrollment"
      @close="rotateDialogOpen = false"
    />

    <!-- Alert terbaru & status pengiriman -->
    <section class="panel mt-5">
      <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
        <h2 class="text-sm font-semibold text-white">Alert Terbaru</h2>
        <button class="btn-ghost ml-auto !px-2.5 !py-1.5 text-xs" :disabled="alertsLoading" @click="loadAlerts">
          <RefreshCw class="h-3.5 w-3.5" :class="alertsLoading ? 'animate-spin' : ''" /> Segarkan
        </button>
      </div>
      <EmptyState v-if="!alertsLoading && alerts.length === 0" message="Belum ada alert yang tercatat." />
      <div v-else class="overflow-x-auto">
        <table class="table-base min-w-[820px]">
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Kondisi</th>
              <th>Judul</th>
              <th>Agent / Worker</th>
              <th>Pengiriman per Kanal</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="alertsLoading && alerts.length === 0">
              <td colspan="5" class="py-8 text-center text-ink-400">Memuat alert…</td>
            </tr>
            <tr v-for="n in alerts" :key="n.id">
              <td class="whitespace-nowrap text-xs">{{ fmtDateTime(n.created_at) }}</td>
              <td>
                <span class="inline-flex whitespace-nowrap rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-400 ring-1 ring-inset ring-red-500/30">
                  {{ alertConditionLabel(n.condition) }}
                </span>
              </td>
              <td>
                <span class="font-medium text-ink-100">{{ n.title }}</span>
                <span v-if="n.body" class="block max-w-72 truncate text-xs font-normal text-ink-400" :title="n.body">{{ n.body }}</span>
              </td>
              <td class="text-xs">
                {{ alertAgentName(n) }}
                <span class="block text-ink-400">{{ alertWorkerName(n) }}</span>
              </td>
              <td>
                <ul v-if="n.deliveries && n.deliveries.length" class="space-y-1">
                  <li v-for="(d, i) in n.deliveries" :key="d.id ?? i" class="flex items-center gap-2 text-xs">
                    <span class="font-medium text-ink-200">{{ alertChannelLabel(d.channel) }}</span>
                    <span
                      class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset"
                      :class="d.status === 'sent' ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30' : d.status === 'failed' ? 'bg-red-500/10 text-red-400 ring-red-500/30' : 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'"
                    >
                      {{ alertDeliveryStatusLabel(d.status) }}
                    </span>
                    <span v-if="d.error" class="max-w-44 truncate text-red-400/80" :title="d.error">{{ d.error }}</span>
                    <span v-if="d.at" class="text-ink-400">{{ fmtDateTime(d.at) }}</span>
                  </li>
                </ul>
                <span v-else class="text-xs text-ink-400">Tidak ada pengiriman (semua kanal nonaktif)</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
