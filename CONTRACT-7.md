# CONTRACT-7 — Perintah Cron Generik (cron.install / cron.list / cron.remove)

Ditambahkan 2026-11-27 atas spesifikasi pemilik: Pusat Perintah dapat memasang,
melihat, dan menghapus cron job generik pada VM agent lewat antrean perintah
yang sudah ada. Tabel `commands` memang generik (type + payload JSON) —
**tidak ada migrasi skema**.

## Tipe perintah baru

| Type           | Payload                          | Sensitif | Verifikasi snapshot |
|----------------|----------------------------------|----------|---------------------|
| `cron.install` | `{ name, schedule, command }`    | ya       | tidak               |
| `cron.list`    | —                                | tidak    | tidak               |
| `cron.remove`  | `{ name }`                       | ya       | tidak               |

Perintah cron selesai berdasarkan hasil yang dilaporkan bridge (seperti
`miner.hold`/`miner.unhold`), BUKAN verifikasi snapshot — tidak ada sinyal
crontab di heartbeat. `cron.install`/`cron.remove` masuk
`SENSITIVE_COMMAND_TYPES` (wajib konfirmasi di dashboard); tidak masuk
`STATE_CHANGING_TYPES`.

## Validasi payload (server `services/cron-payload.ts`, dicerminkan di bridge `src/cron.ts`)

- `name`: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (tanpa spasi — dipakai sebagai penanda).
- `schedule`: ekspresi cron numerik 5 kolom; tiap kolom `*`, angka, rentang,
  daftar, dan langkah divalidasi terhadap rentang posisinya
  (menit 0–59, jam 0–23, tanggal 1–31, bulan 1–12, hari 0–7). Nama bulan/hari
  tidak diterima.
- `command`: teks satu baris, 1–2000 karakter, tanpa newline.

Server menolak payload tidak valid dengan 400 saat pembuatan perintah;
bridge memvalidasi ulang dan menjawab `INVALID_PAYLOAD` bila lolos dari
jalur lain (template/broadcast).

## Semantik di bridge

Job yang dipasang lewat dashboard tinggal di crontab pengguna bridge, satu
baris per job dengan penanda akhir:

```
<schedule> <command> # muse-cron:<name>
```

- `cron.install` idempoten per nama: memasang ulang nama yang sama MENGGANTI
  barisnya, tidak menggandakan. Baris crontab lain (tanpa penanda) tidak
  pernah disentuh.
- `cron.remove` menghapus baris berpenanda nama itu; bila tidak ada, tetap
  sukses (idempoten) dengan catatan tidak ditemukan.
- `cron.list` mengembalikan JSON `{ jobs: [{ name, schedule, command }] }`
  hasil parse baris-baris berpenanda.
- Eksekusi tetap tunduk pada allowlist bridge ∩ capabilities agent.
  `DEFAULT_CAPABILITIES` bridge mencakup ketiga tipe — agent lama hanya
  mendapatkannya setelah bridge-nya dipasang ulang dari unduhan terbaru
  (bridge tidak memperbarui diri sendiri).

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
- Cron job berjalan sebagai pengguna bridge di VM (pengguna yang sama dengan
  layanan `muse-bridge`), bukan root, kecuali bridge sendiri berjalan sebagai root.
