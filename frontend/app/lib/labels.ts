// Label Bahasa Indonesia untuk status & tipe event, dipakai di seluruh halaman.

export const WORKER_STATUS_LABELS: Record<string, string> = {
  SEHAT: 'Sehat',
  WASPADA: 'Waspada',
  MATI: 'Mati',
  GAGAL_START: 'Gagal Start',
  TAK_TERJANGKAU: 'Tak Terjangkau',
  POOL_STALL: 'Pool Stall',
}

export const WORKER_STATUSES = [
  'SEHAT',
  'WASPADA',
  'MATI',
  'GAGAL_START',
  'TAK_TERJANGKAU',
  'POOL_STALL',
] as const

export const AGENT_STATUS_LABELS: Record<string, string> = {
  ONLINE: 'Online',
  UNREACHABLE: 'Tak Terjangkau',
}

export const COMMAND_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'Menunggu',
  SENT: 'Terkirim',
  RUNNING: 'Berjalan',
  SUCCEEDED: 'Berhasil',
  FAILED: 'Gagal',
  TIMED_OUT: 'Kedaluwarsa Waktu',
  EXPIRED: 'Kedaluwarsa',
}

export const COMMAND_STATUSES = [
  'QUEUED',
  'SENT',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'EXPIRED',
] as const

export const COMMAND_TYPES: { value: string; label: string; sensitive: boolean }[] = [
  { value: 'miner.status', label: 'Periksa Status Miner', sensitive: false },
  { value: 'miner.run', label: 'Jalankan Miner (Run Lagi)', sensitive: true },
  { value: 'miner.restart', label: 'Restart Miner', sensitive: true },
  { value: 'miner.reinstall', label: 'Reinstall Miner', sensitive: true },
  { value: 'miner.hold', label: 'Tahan Pemulihan Otomatis', sensitive: true },
  { value: 'miner.unhold', label: 'Lanjutkan Pemulihan Otomatis', sensitive: true },
]

export const SENSITIVE_COMMAND_TYPES = COMMAND_TYPES.filter((t) => t.sensitive).map((t) => t.value)

export const EVENT_TYPE_LABELS: Record<string, string> = {
  AGENT_REGISTERED: 'Agent Terdaftar',
  HEARTBEAT_RECEIVED: 'Heartbeat Diterima',
  AGENT_UNREACHABLE: 'Agent Tak Terjangkau',
  AGENT_RECONNECTED: 'Agent Terhubung Kembali',
  AGENT_SHUTDOWN: 'Agent Mematikan Diri',
  VM_REPLACED: 'VM Diganti',
  REBOOT: 'Reboot',
  COMMAND_CREATED: 'Perintah Dibuat',
  COMMAND_STARTED: 'Perintah Dimulai',
  COMMAND_SUCCEEDED: 'Perintah Berhasil',
  COMMAND_FAILED: 'Perintah Gagal',
  RECOVERY: 'Pemulihan',
  RECOVERY_FAILED: 'Pemulihan Gagal',
  POOL_STALL: 'Pool Stall',
  SESSION_STARTED: 'Sesi Dimulai',
  SESSION_ENDED: 'Sesi Berakhir',
  RULE_FIRED: 'Aturan Otomasi Terpicu',
  RULE_SKIPPED: 'Aturan Otomasi Dilewati',
}

export const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS)

export const SESSION_END_REASON_LABELS: Record<string, string> = {
  TAKEOVER: 'Diambil alih sesi baru',
  SHUTDOWN: 'Shutdown bersih',
  LOST: 'Hilang tanpa kabar',
}

export function workerStatusLabel(status?: string | null): string {
  if (!status) return '—'
  return WORKER_STATUS_LABELS[status] ?? status
}

export function agentStatusLabel(status?: string | null): string {
  if (!status) return '—'
  return AGENT_STATUS_LABELS[status] ?? status
}

export function commandStatusLabel(status?: string | null): string {
  if (!status) return '—'
  return COMMAND_STATUS_LABELS[status] ?? status
}

export function commandTypeLabel(type?: string | null): string {
  if (!type) return '—'
  return COMMAND_TYPES.find((t) => t.value === type)?.label ?? type
}

export function eventTypeLabel(type?: string | null): string {
  if (!type) return '—'
  return EVENT_TYPE_LABELS[type] ?? type
}

// ---------- Fase 2: alert multi-kanal ----------

/** Kondisi pemicu alert (CONTRACT-2 §4). Kunci dinormalisasi: huruf besar, pemisah "_". */
export const ALERT_CONDITION_LABELS: Record<string, string> = {
  WORKER_MATI: 'Worker Mati',
  WORKER_DEAD: 'Worker Mati',
  MATI: 'Worker Mati',
  DEAD: 'Worker Mati',
  WORKER_GAGAL_START: 'Worker Gagal Start',
  GAGAL_START: 'Worker Gagal Start',
  AGENT_UNREACHABLE: 'Agent Tak Terjangkau',
  AGENT_TAK_TERJANGKAU: 'Agent Tak Terjangkau',
  UNREACHABLE: 'Agent Tak Terjangkau',
  TAK_TERJANGKAU: 'Agent Tak Terjangkau',
  POOL_STALL: 'Pool Stall',
  WORKER_POOL_STALL: 'Pool Stall',
  TEST: 'Pesan Tes',
}

export function alertConditionLabel(condition?: string | null): string {
  if (!condition) return '—'
  const key = condition.toUpperCase().replace(/[\s-]+/g, '_')
  return ALERT_CONDITION_LABELS[key] ?? condition
}

export const ALERT_CHANNEL_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  telegram: 'Telegram',
}

export function alertChannelLabel(channel?: string | null): string {
  if (!channel) return '—'
  return ALERT_CHANNEL_LABELS[channel.toLowerCase()] ?? channel
}

export const ALERT_DELIVERY_STATUS_LABELS: Record<string, string> = {
  sent: 'Terkirim',
  failed: 'Gagal',
  pending: 'Menunggu',
}

export function alertDeliveryStatusLabel(status?: string | null): string {
  if (!status) return '—'
  return ALERT_DELIVERY_STATUS_LABELS[status.toLowerCase()] ?? status
}

// ---------- Fase 3: peran pengguna, otomasi, jadwal ----------

export const USER_ROLES: { value: string; label: string; description: string }[] = [
  { value: 'ADMIN', label: 'Administrator', description: 'Akses penuh: pengguna, pengaturan, ekspor, retensi, dan semua perintah.' },
  { value: 'OPERATOR', label: 'Operator', description: 'Dapat mengirim perintah, broadcast, template, aturan otomasi, dan jadwal. Tidak dapat mengelola pengguna, pengaturan, atau ekspor.' },
  { value: 'VIEWER', label: 'Penonton', description: 'Hanya dapat melihat data (hanya-baca). Tidak dapat membuat atau mengubah apa pun.' },
]

export function userRoleLabel(role?: string | null): string {
  if (!role) return '—'
  return USER_ROLES.find((r) => r.value === role.toUpperCase())?.label ?? role
}

export const COMMAND_SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual',
  automation: 'Otomasi',
  schedule: 'Jadwal',
}

export function commandSourceLabel(source?: string | null): string {
  if (!source) return 'Manual'
  return COMMAND_SOURCE_LABELS[source.toLowerCase()] ?? source
}

/** Status worker yang dapat menjadi kondisi aturan otomasi (CONTRACT-3 §2). */
export const RULE_WORKER_STATUSES = ['MATI', 'GAGAL_START', 'WASPADA', 'POOL_STALL'] as const

export const RULE_CONDITION_KIND_LABELS: Record<string, string> = {
  worker_status: 'Status Worker',
  agent_unreachable: 'Agent Tak Terjangkau',
}

export function ruleConditionKindLabel(kind?: string | null): string {
  if (!kind) return '—'
  return RULE_CONDITION_KIND_LABELS[kind] ?? kind
}
