# CONTRACT-7 — Perintah Cron Generik (cron.install / cron.list / cron.remove)

Ditambahkan 2026-11-27 atas spesifikasi pemilik: Pusat Perintah dapat memasang,
melihat, dan menghapus cron job generik pada VM agent lewat antrean perintah
yang sudah ada. Tabel `commands` memang generik (type + payload JSON) —
**tidak ada migrasi skema**.

**Revisi di hari yang sama (umpan balik dari agent di VM): penjadwalnya adalah
bridge itu sendiri, BUKAN crontab sistem.** VM agent tidak memiliki binary
maupun daemon cron, dan crontab tersimpan di luar ~/workspace sehingga hilang
setiap VM diganti. Implementasi crontab awal diganti seluruhnya; tidak ada
fallback dan tidak ada migrasi otomatis job crontab lama — job lama harus
di-install ulang lewat dashboard.

## Tipe perintah

| Type           | Payload                          | Sensitif | Verifikasi snapshot |
|----------------|----------------------------------|----------|---------------------|
| `cron.install` | `{ name, schedule, command }`    | ya       | tidak               |
| `cron.list`    | —                                | tidak    | tidak               |
| `cron.remove`  | `{ name }`                       | ya       | tidak               |

Perintah cron selesai berdasarkan hasil yang dilaporkan bridge (seperti
`miner.hold`/`miner.unhold`), BUKAN verifikasi snapshot. `cron.install`/
`cron.remove` masuk `SENSITIVE_COMMAND_TYPES` (wajib konfirmasi di dashboard);
tidak masuk `STATE_CHANGING_TYPES`. Hasil sukses `cron.install` adalah JSON
record job yang terpasang; `cron.list` mengembalikan `{ jobs: [...] }` berisi
record lengkap (name, schedule, command + field run di bawah).

## Validasi payload (server `services/cron-payload.ts`, dicerminkan di bridge `src/cron.ts`)

- `name`: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (aman sebagai nama file).
- `schedule`: ekspresi cron numerik 5 kolom; tiap kolom `*`, angka, rentang,
  daftar, dan langkah divalidasi terhadap rentang posisinya
  (menit 0–59, jam 0–23, tanggal 1–31, bulan 1–12, hari 0–7). Nama bulan/hari
  tidak diterima.
- `command`: teks satu baris, 1–2000 karakter, dan **tanpa karakter shell**
  (`; | & ` $ > <`, baris baru, NUL) — karena job dijalankan tanpa shell,
  karakter itu tidak akan pernah berarti apa yang dimaksud penulisnya.

Server menolak payload tidak valid dengan 400 saat pembuatan perintah;
bridge memvalidasi ulang dan menjawab `INVALID_PAYLOAD` bila lolos dari
jalur lain (template/broadcast).

## Penyimpanan & penjadwalan di bridge

Satu file JSON per job: `<bridgeDir>/jobs/<name>.json` (bridgeDir sama dengan
lokasi identity bridge, di ~/workspace — selamat dari ganti VM). Isi record:
`name, schedule, command, created_at, updated_at, last_run_at, last_status,
last_exit_code, last_duration_ms, next_run_at`. Penulisan atomik (file
sementara + rename). File yang korup dilewati dengan satu baris log saat
dimuat, tidak pernah dijalankan, dan tidak menghentikan bridge. Direktori
`jobs/` dibuat otomatis saat bridge start.

- Penghitung waktu berikutnya (`nextRunAfter`) ditulis sendiri di bridge —
  tanpa binary eksternal, tanpa dependensi baru. Semantik hari mengikuti
  cron klasik: bila kolom tanggal DAN hari sama-sama dibatasi, hari cocok
  bila salah satu cocok (OR). Jadwal dievaluasi dalam waktu lokal VM.
  Jadwal yang tidak pernah cocok dalam 366 hari (mis. 30 Februari) tidak
  pernah dijalankan.
- Penjadwal menumpang loop utama bridge: satu `tick()` per siklus loop
  (siklus mengikuti interval heartbeat dari server). Saat start, job yang
  belum jatuh tempo dihitung ulang `next_run_at`-nya dari waktu start;
  job yang sudah jatuh tempo dibiarkan lewat agar tick pertama
  menjalankannya.
- **Ketinggalan: jalan sekali.** Job yang jadwalnya terlewat selama bridge
  mati / VM diganti dijalankan tepat satu kali, lalu jadwal berikutnya
  dihitung dari waktu selesai — tidak pernah sekali per slot terlewat.
- **Tumpang tindih: lewati.** Bila run sebelumnya masih berjalan saat slot
  berikutnya tiba, slot itu dilewati dan dilaporkan sebagai
  `skipped_overlap`; tidak ada instance kedua dan tidak ada antrean.
- **Timeout:** konstanta `CRON_JOB_TIMEOUT_MS` = 600.000 (10 menit) —
  SIGTERM, lalu SIGKILL setelah 5 detik bila belum mati; tercatat `timeout`.
- Satu job yang gagal/timeout/crash tidak menghentikan loop dan tidak
  menghalangi job lain. Menghapus job yang sedang berjalan tidak membunuh
  run-nya; penghapusan hanya mencegah jadwal berikutnya.

## Eksekusi — tanpa shell

Job dijalankan bridge dengan spawn langsung (`shell: false`): command
dipecah pada spasi menjadi program + argumen (bukan parsing shell — tanda
kutip adalah karakter biasa, tidak ada ekspansi `~`, variabel, pipa, atau
pengalihan). Untuk langkah kompleks, command menunjuk ke satu berkas skrip.
Working directory = direktori induk bridgeDir (workspace pengguna);
environment diwarisi dari proses bridge tanpa tambahan; output gabungan
stdout/stderr ditangkap paling banyak 64 KB per run. Job berjalan sebagai
pengguna bridge, tanpa sudo. Satu-satunya jalur eksekusi adalah job yang
terdaftar lewat `cron.install` yang sah, pada jadwalnya.

## Pelaporan eksekusi

Setiap hasil run — `succeeded`, `failed`, `timeout`, dan `skipped_overlap` —
dilaporkan bridge ke server lewat jalur event yang sudah ada
(`POST /api/agents/:id/events`, tipe event `CRON_RUN`, label dashboard
"Cron Job Berjalan") dengan metadata laporan:

```json
{ "name": "laporan-pagi", "scheduled_at": "…", "started_at": "…",
  "finished_at": "…", "duration_ms": 12000, "status": "succeeded",
  "exit_code": 0, "output_tail": "…maks 2 KB…" }
```

Pelaporan bersifat best-effort: gagal terkirim tidak menghentikan
penjadwal dan tidak di-retry tanpa batas; keadaan terakhir selalu tersimpan
di file job. Laporan tampil di linimasa event agent; daftar cron khusus per
agent di dashboard adalah pekerjaan lanjutan (data sudah tersedia dari
metadata event dan hasil `cron.list`).

## Idempotensi pembuatan (dashboard)

Form Pusat Perintah memakai kunci idempotensi yang STABIL selama satu sesi
form (diganti hanya setelah pembuatan berhasil), jadi klik dua kali atau
kirim ulang setelah galat jaringan mengembalikan perintah yang sudah ada.
Untuk tipe cron, form menampilkan kolom terstruktur (nama job, preset jadwal
+ ekspresi kustom, perintah) dan menyusun payload-nya sendiri; mode broadcast
tidak membawa payload cron — perintah cron dibuat per agent.

## Batasan yang disengaja

- Tidak ada tipe perintah shell bebas; permukaan eksekusi bridge tetap
  allowlist tertutup (6 tipe miner + 3 tipe cron ini).
- Bridge lama tidak memperbarui diri sendiri: kapabilitas cron dan
  penjadwal baru hanya didapat setelah bridge dipasang ulang dari unduhan
  terbaru (misalnya saat installer dijalankan ulang pada pemulihan VM).
- Tidak ada aturan interval minimum — tidak ada yang berlaku sebelumnya,
  dan perubahan ini tidak menambah maupun melonggarkannya.
