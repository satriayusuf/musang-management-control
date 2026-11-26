// Helper pemformatan waktu & angka.
// Semua waktu dari API berbentuk UTC ISO 8601 dan ditampilkan dalam zona Asia/Jakarta.

const dtf = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const dtfShort = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${dtf.format(d)} WIB`
}

export function fmtDateTimeShort(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${dtfShort.format(d)} WIB`
}

/** "5 menit lalu", "2 jam lalu", "3 hari lalu" — relatif terhadap sekarang. */
export function fmtRelative(iso?: string | null, nowMs?: number): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diffSec = Math.floor(((nowMs ?? Date.now()) - d.getTime()) / 1000)
  if (diffSec < 0) return 'baru saja'
  if (diffSec < 10) return 'baru saja'
  if (diffSec < 60) return `${diffSec} detik lalu`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} menit lalu`
  const jam = Math.floor(min / 60)
  if (jam < 24) return `${jam} jam lalu`
  const hari = Math.floor(jam / 24)
  if (hari < 30) return `${hari} hari lalu`
  const bulan = Math.floor(hari / 30)
  if (bulan < 12) return `${bulan} bulan lalu`
  return `${Math.floor(bulan / 12)} tahun lalu`
}

/** Durasi dalam detik → "2 jam 15 menit", "45 detik", dst. */
export function fmtDuration(totalSec?: number | null): string {
  if (totalSec === null || totalSec === undefined || Number.isNaN(totalSec)) return '—'
  const sec = Math.max(0, Math.floor(totalSec))
  if (sec < 60) return `${sec} detik`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} menit`
  const jam = Math.floor(min / 60)
  const sisaMin = min % 60
  if (jam < 24) return sisaMin ? `${jam} jam ${sisaMin} menit` : `${jam} jam`
  const hari = Math.floor(jam / 24)
  const sisaJam = jam % 24
  return sisaJam ? `${hari} hari ${sisaJam} jam` : `${hari} hari`
}

export function fmtNumber(n?: number | null, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n)
}

export function fmtHashrate(hs?: number | null): string {
  if (hs === null || hs === undefined || Number.isNaN(hs)) return '—'
  if (hs >= 1_000_000) return `${fmtNumber(hs / 1_000_000, 2)} MH/s`
  if (hs >= 1_000) return `${fmtNumber(hs / 1_000, 2)} kH/s`
  return `${fmtNumber(hs, 2)} H/s`
}

export function fmtGiB(v?: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${fmtNumber(v, 1)} GiB`
}

export function fmtPct(v?: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${fmtNumber(v, 1)}%`
}

/** UUID untuk idempotency key, dengan fallback bila crypto.randomUUID tidak tersedia. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
