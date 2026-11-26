# CONTRACT-6 — Sumber Statistik Miner untuk Bridge (Hashrate VM asli)

Fitur kecil di atas Fase 5. Tujuan: kolom "Hashrate VM" di dashboard terisi
angka asli dari VM, bukan hanya angka pool — tanpa mengubah kontrak Fase 1–5.

## 1. Masalah

Bridge bawaan (mode real) hanya membaca status service systemd; statistik di
dalam proses miner (hashrate, share, job) tidak terbaca, jadi snapshot
mengirim null. Skema heartbeat server mewajibkan angka untuk
`hashrate_hs/shares_local/job_height/difficulty`, sehingga null tidak pernah
bisa terkirim — klien yang berjalan di produksi mengirim 0 untuk "tidak
dilaporkan". Dashboard kini menampilkan dua angka terpisah: Hashrate VM
(laporan bridge) dan Hashrate Pool (adapter Fase 5).

## 2. Perilaku baru bridge

- Pengaturan opsional `MUSE_MINER_STATS_URL` (env, atau `miner_stats_url` di
  config.json bridge): alamat HTTP lokal di VM yang mengembalikan statistik
  program miner sebagai JSON. Tidak diisi → perilaku lama persis.
- Setiap snapshot (mode real), bila URL terisi, bridge mengambil JSON itu
  (timeout 2,5 dtk, batas 256 KB, tanpa header otorisasi) dan mem-parse-nya
  secara defensif:
  - Wadah: objek teratas, atau salah satu kunci `data/result/miner/stats/status`.
  - Alias field: hashrate ← `hashrate_hs|hashrate|hash_rate|speed_hs`;
    shares_local ← `shares_local|shares|accepted|accepted_shares`;
    last_share_at ← `last_share_at|last_share` (epoch detik/milidetik atau
    string ISO); job_height ← `job_height|height`; difficulty ← `difficulty|diff`.
  - Nilai boleh angka atau string numerik.
- Field yang berhasil terbaca mengisi snapshot; yang tidak, tetap kosong.
  Kegagalan ambil/parse apa pun TIDAK menggagalkan heartbeat.
- Koersi kawat: field numerik yang tetap kosong dikirim sebagai 0
  ("tidak dilaporkan"), sesuai skema server dan perilaku klien produksi.
  `last_share_at`/`session_no`/`pid` tetap boleh null.

## 3. agent.md

Template menambah panduan: sebelum menjalankan installer, agent yang
mendaftar mencari alamat statistik lokal program miner-nya (bila ada) dan
mengisi `MUSE_MINER_STATS_URL` di bridge.env. Langkah ini opsional dan tidak
boleh menghalangi pendaftaran; verifikasi akhir: kolom Hashrate VM di
dashboard terisi angka asli.

## 4. Addendum (2026-11-27): accepted/rejected dari VM

Atas permintaan pemilik: kolom Share Diterima/Ditolak harus berisi data
dari VM, bukan pool. Maka:

- Parser statistik menambah `accepted_shares` (alias `accepted`,
  `shares_accepted`) dan `rejected_shares` (alias `rejected`,
  `shares_rejected`); alias `accepted*` dicabut dari `shares_local` agar
  maknanya tidak tercampur.
- Snapshot bridge membawa keduanya sebagai field opsional; bridge lama
  tidak mengirimnya dan tetap valid.
- Skema heartbeat server menerimanya sebagai field opsional
  (`integer|null`, tidak wajib). Bila hadir, nilainya menimpa
  `workers.accepted/rejected` — di jalur bntpool ini satu-satunya penulis
  field tersebut; bila absen, nilai tersimpan tidak berubah.
- Label dashboard: "Share Diterima (VM)" / "Share Ditolak (VM)"; angka
  pool tetap di blok DATA POOL dengan label "(menurut pool)".

## 5. Di luar cakupan

- Tidak ada perubahan backend/skema/dashboard pada fitur ini.
- Bridge yang sudah terpasang di VM tidak memperbarui diri; VM lama mendapat
  fitur ini hanya bila bridge-nya dipasang ulang dari unduhan terbaru.
