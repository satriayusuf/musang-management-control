# CONTRACT-5 — Adapter Pool BNTPool (implementasi spek owner 2026-11-26)

Sumber kebenaran: dokumen "Spek Adapter Pool BNTPool — Muse Management Control"
yang ditempel owner di chat utama 2026-11-26. Kontrak ini memetakan spek itu ke
kode yang ada. Bila kontrak ini dan spek bertentangan, SPEK menang dan
penyimpangannya dilaporkan.

Keadaan awal (terverifikasi): `src/services/pool/` berisi types.ts
(PoolProvider.fetchWorkers), placeholder.ts (nonaktif), monitor.ts
(PoolMonitorService env-driven, append pool_snapshots). Settings DB sudah punya
kunci pool_provider / pool_api_base_url / pool_lookup_param / pool_api_key
(write-only). Tabel pool_snapshots KOSONG di produksi dan lokal. API live
bntpool terverifikasi 2026-11-26 dari VM ini: GET
https://bntpool.com/api/miner/<alamat §2 spek> → 200, 62 worker di alamat itu,
czx-utama-7d66 ketemu, last_share_at epoch detik.

## B1. Skema (satu migrasi baru, suffix `phase5_pool_adapter`)

Bentuk ulang `pool_snapshots` menjadi snapshot per-agent (upsert), sesuai
§8.3 spek: id, agentId (FK, UNIQUE), provider, lookupParam, workerName,
found (bool), poolHashrate (Float?), poolAccepted (Int?), poolRejected (Int?),
poolLastShareAt (DateTime?), lastKnownShareAt (DateTime? — share terakhir yang
PERNAH tercatat dari fetch sukses; tidak ditimpa not_found/error),
fetchedAt (fetch sukses terakhir), lastAttemptAt, fetchOk (bool),
fetchError (String?), confirmKind (String? 'stall'|'not_found'),
confirmCount (Int, default 0), confirmLastAt (DateTime?).
Tabel kosong di semua lingkungan → migrasi boleh drop-and-recreate bentuknya.
Retensi: pool_snapshots KELUAR dari set penghapusan retention.ts (baris
per-agent tidak boleh terhapus; counts.pool_snapshots tetap ada, selalu 0) —
pola yang sama seperti heartbeat di CONTRACT-4.

## B2. Adapter — `src/services/pool/bntpool.ts`

- `parsePoolLastShareAt(value): Date | null` — menerima integer epoch detik,
  objek {secs_since_epoch, nanos_since_epoch?}, string ISO 8601; bentuk lain →
  null (bukan error). Nilai masa depan: clamp umur di pemakaian, log warn satu
  baris (skew) di poller/status saat terdeteksi.
- `parseMinerPayload(json): Map<workerName, {hashrate, accepted, rejected,
  lastShareAt}> | null` — defensif: json bukan objek / workers bukan array →
  null (→ hasil error 'invalid_shape'). Field per worker boleh hilang/tipe
  salah → nilai null per field, entri tetap dipakai bila `worker` string.
- `fetchAddressWorkers({baseUrl, lookupParam, signal, fetchImpl?})` → GET
  `{base}/miner/{encodeURIComponent(lookupParam)}`, header User-Agent
  `muse-management-control/<versi package.json>`, TANPA header otorisasi,
  timeout 8 detik via AbortSignal, batas ukuran respons 2 MB (lebih → error).
  Hasil: { kind:'ok', workers } | { kind:'error', reason, retryAfterSec? }.
  HTTP 429 → error dengan retryAfterSec dari header Retry-After (detik).
- Per-agent hasil mengikuti PoolWorkerResult spek §8.3:
  found / not_found / error diturunkan dari hasil fetch alamat + exact match
  case-sensitive nama worker.

## B3. Poller — rombak `PoolMonitorService` (monitor.ts)

- Siklus membaca settings TERKINI dari DB tiap siklus (bukan env, bukan cache
  boot): provider != 'bntpool' → idle total, nol request (A2). Placeholder
  tetap nonaktif persis seperti sebelumnya.
- Satu request per siklus per kombinasi (provider, baseUrl, lookupParam)
  unik; hasil dibagikan ke semua agent ber-workerName (A9). Jadwal dasar
  60 dtk; backoff kegagalan berurutan 60→120→300→600 dtk, reset ke 60 pada
  sukses pertama; 429: jeda = Retry-After bila ada, else ≥300 dtk, dan selama
  itu nol request ke host itu (A10). Tanpa retry dalam siklus yang sama.
- Per agent: upsert pool_snapshots. Fetch error → fetchOk=false, fetchError,
  lastAttemptAt diperbarui; field snapshot sukses (found/hashrate/accepted/
  rejected/poolLastShareAt/fetchedAt/lastKnownShareAt) TIDAK ditimpa (§6.1).
  Fetch sukses → perbarui semua field snapshot; lastKnownShareAt diperbarui
  bila found dan lastShareAt ada.
- Konfirmasi (§5.1/§5.2): kondisi eskalasi per agent dievaluasi pada fetch
  SUKSES: 'stall' (found, umur share ≥ SHARE_STALL_SEC, bridge hashing) atau
  'not_found'. Bila kondisi sama dengan confirmKind dan confirmLastAt ≥
  POOL_CONFIRM_GAP_SEC lalu → confirmCount+1, confirmLastAt=now. Bila kondisi
  muncul pertama kali → confirmKind=kind, confirmCount=1, confirmLastAt=now.
  Fetch sukses TANPA kondisi eskalasi → confirm reset (count 0, kind null).
  Fetch error → konfirmasi tidak berubah.
- Setelah snapshot diperbarui: hitung ulang status gabungan semua agent
  ber-worker lewat B4, simpan + broadcast + event mengikuti pola heartbeat.ts
  (POOL_STALL event saat masuk POOL_STALL; RECOVERY saat kembali SEHAT dari
  status turun — pola yang sama seperti jalur heartbeat).
- Log: satu baris per siklus gagal (waktu, provider, jenis error). Sukses
  tidak dilog per baris. Respons mentah tidak dilog.
- Poller start/stop mengikuti pola yang ada (di-boot dari server bootstrap
  yang sama seperti sebelumnya); interval dasar boleh tetap parameter.

## B4. Status gabungan — service baru `src/services/pool-status.ts`

Konstanta bernama di file ini (§5.1): SHARE_FRESH_SEC=1800,
SHARE_STALL_SEC=9000, POOL_CONFIRM_POLLS=2, POOL_CONFIRM_GAP_SEC=300,
POOL_SNAPSHOT_MAX_AGE_SEC=900.

`computeCombinedStatus(input)` murni (tanpa DB) + `applyPoolStatus(prisma,
agentId)` yang merakit input dari DB, menulis hasil, dan mengembalikan status
akhir:

- Input: agent.status (ONLINE/UNREACHABLE), verdict bridge (dari
  computeWorkerStatus yang ADA dengan poolConfigured=false atas snapshot
  miner terakhir — heartbeat terakhir / field worker), bridgeHashing =
  (miner snapshot terakhir service_state='active' && hashrate_hs > 0),
  snapshot pool per-agent + confirm state + now.
- Bila provider bukan bntpool → kembalikan verdict bridge apa adanya
  (perilaku lama utuh).
- Pool dianggap unknown bila: belum ada snapshot, fetchOk terakhir false DAN
  snapshot sukses sudah lewat POOL_SNAPSHOT_MAX_AGE_SEC, atau fetchedAt lebih
  tua dari POOL_SNAPSHOT_MAX_AGE_SEC. Saat unknown → status akhir = verdict
  bridge; poolState='unknown' (untuk badge §8.2).
- Tabel keputusan §5.2 diterapkan persis, termasuk:
  - found & umur share ≤1800 → SEHAT (dari sisi pool), apa pun bridge —
    KECUALI pemisahan A12: status MINER sehat; status AGENT tetap urusan
    heartbeat (agent.status tidak diubah service ini sama sekali).
    Bila verdict bridge MATI/GAGAL_START karena service mati (bukan share),
    pool tidak menimpanya: baris "found, 30mnt–2,5jam, tidak hashing →
    mengikuti bridge" dan akal sehat yang sama berlaku di pita segar:
    pool hanya membantah verdict yang berbasis share/stall, bukan verdict
    service-mati. Implementasi: SEHAT-dari-pool hanya menimpa verdict bridge
    WASPADA/POOL_STALL yang reason-nya berbasis share, dan verdict
    TAK_TERJANGKAU saat agent online. Bila ragu, ikuti tabel spek secara
    harfiah untuk pita yang tercantum dan dokumentasikan pilihanmu.
  - found & 1800 < umur < 9000 & hashing → WASPADA + teks spek persis:
    "Tidak ada share selama X — miner masih hashing; share bersifat acak"
    (X = umur terbaca manusia, mis. "45 menit").
  - found & umur ≥9000 & hashing & confirmCount('stall') ≥2 → POOL_STALL +
    teks spek persis: "Tidak ada share ≥2,5 jam padahal miner hashing —
    kemungkinan stall di sisi pool".
  - not_found & confirmCount('not_found') ≥2 & agent online & hashing →
    WASPADA "Worker tidak terlihat di pool".
  - not_found terkonfirmasi & lastKnownShareAt berumur ≥9000 & hashing →
    POOL_STALL (teks sama).
  - Sisanya → verdict bridge.
- Integrasi: processHeartbeat — bila provider bntpool, verdict yang ditulis
  jalur heartbeat adalah verdict bridge murni (poolConfigured=false), lalu
  applyPoolStatus dipanggil untuk status akhir. Bila bukan bntpool, jalur
  lama tidak berubah sama sekali (termasuk pembacaan poolSnapshot lama di
  heartbeat.ts dinonaktifkan untuk bntpool karena tabel berubah bentuk —
  sesuaikan compile-nya).
- Sweeper unreachable: tidak diubah; status agent tetap domain heartbeat.

## B5. Settings — validasi + tes fetch (§2 spek)

Di PUT /api/settings (dan jalur update settings yang dipakai UI):
- Normalisasi+validasi saat provider='bntpool': pool_base_url wajib, https,
  tanpa query string; trailing slash dibuang. pool_lookup_param wajib,
  di-trim, tanpa spasi. lookup_param mengandung '/', '?', '#' → tolak 400
  (§9). pool_api_key tidak divalidasi.
- Setelah simpan sukses, bila provider='bntpool': jalankan SATU fetch tes
  (timeout 8 dtk) dan sertakan di respons:
  `pool_test: { fetch_ok: boolean, error?: string, results: Array<{
  agent_id, agent_name, worker_name, outcome: 'found'|'not_found',
  pool_last_share_at?: string, pool_hashrate?: number }> }`
  untuk semua agent ber-workerName. Kegagalan fetch TIDAK menggagalkan
  penyimpanan (respons tetap 200 dengan pool_test.fetch_ok=false).
- GET /api/settings tidak berubah (pool_api_key tetap write-only).

## B6. Paparan API untuk UI (§8.2)

Objek worker di GET /api/dashboard, daftar worker, dan detail agent (payload
yang dipakai kartu worker di frontend — temukan ketiganya) mendapat field
`pool: null | { state: 'ok'|'unknown', found: boolean,
hashrate: number|null, accepted: number|null, rejected: number|null,
last_share_at: string|null, fetched_at: string|null,
fetch_error: string|null }`. pool=null bila provider bukan bntpool atau agent
tanpa worker. state='unknown' mengikuti definisi B4.

## B7. Test (backend, `npm test` hijau; suite lama 147 tidak boleh turun)

Skenario penerimaan spek §10 sebagai test integrasi/unit dengan mock HTTP
server pool (bind 127.0.0.1 port acak) — A2, A3, A4, A5, A6, A7, A8, A9, A10,
A11 wajib sebagai test otomatis; A12 sebagai test computeCombinedStatus/
applyPoolStatus (heartbeat berhenti + share segar → worker SEHAT, agent
tetap UNREACHABLE). A1 live TIDAK di-test otomatis (dikerjakan parent saat
deploy). Test A5/A6 memakai injeksi waktu (parameter now / fake timers /
konstanta yang bisa di-override di test) — rancang poller + status service
agar waktu dan fetch bisa diinjeksi.

## F1. Frontend — halaman Pengaturan (settings.vue, bagian API Pool)

- Dropdown Penyedia Pool: tambah opsi value `bntpool`, label
  `bntpool — BNTPool (Blocknet)`. Opsi none/placeholder tidak berubah.
- Saat bntpool terpilih: placeholder URL Dasar API Pool =
  `https://bntpool.com/api`; teks bantuan di bawah Parameter Pencarian
  Worker: "Alamat wallet (address) di pool. Nama worker diambil otomatis
  dari registrasi agent."; teks bantuan di bawah Kunci API Pool: "Tidak
  diperlukan untuk bntpool — API pool bersifat publik. Kolom ini boleh
  kosong."
- Setelah simpan, bila respons memuat pool_test: tampilkan hasilnya di
  halaman yang sama — per worker: ketemu (+ share terakhir, format relatif
  dan absolut WIB) / tidak ketemu; bila fetch_ok=false tampilkan sebagai
  peringatan berisi error-nya (bukan kegagalan simpan).

## F2. Frontend — blok pool di kartu worker

Di semua tempat kartu worker tampil (dashboard, daftar worker, detail
agent — ikuti payload B6): bila `pool` tidak null, tampilkan blok berisi
share terakhir menurut pool (relatif + absolut WIB), accepted/rejected
dengan label "menurut pool", hashrate menurut pool, dan waktu cek terakhir.
Bila pool.state='unknown': badge "Cek pool tidak tersedia" dan data
terakhir tetap ditampilkan. Format waktu mengikuti helper format yang sudah
ada di frontend (WIB).

## Di luar cakupan

Bridge tidak diubah. Tidak ada notifikasi baru dari status pool. Tidak ada
adapter pool lain. Deploy produksi dikerjakan parent, bukan builder.

## Addendum (2026-11-27): total pool sealamat

Atas permintaan pemilik: kartu "Total Hashrate Pool" di daftar worker harus
sesuai pool-nya sendiri, bukan penjumlahan worker yang terhubung. Maka
poller menyimpan total sealamat dari fetch sukses terakhir: field
`hashrate` tingkat atas payload (total resmi pool untuk alamat itu) — bila
absen, jumlah hashrate SEMUA worker yang dikembalikan pool untuk alamat
itu — plus jumlah worker sealamat. Kegagalan fetch tidak menimpa total
sukses terakhir. Daftar worker mengeksposnya sebagai `pool_totals`
({hashrate, worker_count, fetched_at} | null sebelum fetch sukses pertama).
