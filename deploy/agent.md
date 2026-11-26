# Petunjuk Registrasi Agent — Muse Management Control

Dokumen ini untuk agent yang berjalan di VM agent. Ikuti langkahnya untuk
mendaftarkan VM ini (agent + worker) ke dashboard Muse Management Control.
Server: `https://musang.mikasu.lol`

## Yang kamu butuhkan dari operator (manusia) terlebih dahulu

1. **Kode pairing** — dibuat operator dari dashboard: menu **Agent → Tambah
   Agent**. Formatnya seperti `XXXX-XXXX`, berlaku 15 menit dan hanya bisa
   dipakai satu kali. Tanpa kode ini kamu tidak bisa registrasi pertama kali.
2. **Nama worker** — nama worker di VM ini sesuai penamaan operator
   (contoh: `czx-utama-7d66`). Nama agent boleh mengikuti hostname.

## Langkah 1 — unduh bridge

Bridge adalah satu file Node.js (tanpa dependensi runtime). Syarat: Node.js
20+ dan Linux dengan systemd.

```bash
mkdir -p ~/workspace/muse-bridge-install && cd ~/workspace/muse-bridge-install
curl -fsSLO https://musang.mikasu.lol/bridge.cjs
curl -fsSLO https://musang.mikasu.lol/install.sh
chmod +x install.sh
```

## Langkah 2 — tulis konfigurasi

Buat file `~/workspace/muse-bridge/bridge.env`:

```bash
mkdir -p ~/workspace/muse-bridge
cat > ~/workspace/muse-bridge/bridge.env <<'EOF'
MUSE_SERVER_URL=https://musang.mikasu.lol
MUSE_PAIRING_CODE=<KODE_DARI_OPERATOR>
MUSE_AGENT_NAME=<nama-agent, mis. hostname VM ini>
MUSE_WORKER_NAME=<nama-worker dari operator>
MUSE_BRIDGE_MODE=real
MUSE_MINER_UNIT=<nama unit systemd service worker di VM ini>
EOF
```

Catatan mode:
- `MUSE_BRIDGE_MODE=real` — bridge membaca status service worker dari
  systemd unit di `MUSE_MINER_UNIT`. Pakai mode ini untuk VM produksi.
- `MUSE_BRIDGE_MODE=demo` — hanya untuk uji coba tanpa worker sungguhan.

## Langkah 3 — pasang dan jalankan

```bash
cd ~/workspace/muse-bridge-install
./install.sh
```

Installer bersifat idempoten: menyalin bridge ke `~/workspace/muse-bridge/`,
menulis unit systemd `muse-bridge.service`, mengaktifkan dan menjalankannya.
Jalankan lagi setiap habis ganti konfigurasi.

## Langkah 4 — verifikasi

```bash
systemctl is-active muse-bridge
journalctl -u muse-bridge -n 20 --no-pager
```

Log harus menunjukkan registrasi berhasil (`registered agent=agt_… session=…`).
Setelah heartbeat pertama (±30 detik), agent dan worker kamu muncul di
dashboard operator. Laporkan ke operator bahwa registrasi selesai, sebutkan
nama agent dan nama worker yang kamu pakai.

## Yang perlu kamu tahu

- **Identitas persisten** ada di `~/workspace/muse-bridge/` (identity.json +
  token). Direktori ini yang harus bertahan kalau VM diganti — jangan hapus.
  Setelah registrasi pertama, kode pairing tidak dipakai lagi; bridge
  menyambung kembali otomatis dengan tokennya, termasuk setelah VM diganti
  (server mendeteksi penggantian VM dari boot ID — jangan registrasi ulang
  dengan kode baru untuk VM yang sama).
- Bridge hanya membuat koneksi keluar (HTTPS) ke server. Tidak ada port masuk.
- Perintah dari dashboard yang mungkin kamu terima hanya:
  `miner.status`, `miner.run`, `miner.restart`, `miner.reinstall`,
  `miner.hold`, `miner.unhold`. Di luar itu tidak ada yang dieksekusi.
- `miner.hold` menahan auto-recovery lokal (flag `hold` di direktori bridge);
  `miner.unhold` melepasnya. Hormati flag ini.
- Kalau memori tersedia di bawah ambang minimum dari server, `miner.run`
  akan menolak start dan melaporkan angka memorinya — jangan diakali.
- Kalau registrasi gagal karena kode pairing kedaluwarsa/ditolak: berhenti
  dan minta kode baru ke operator. Jangan membuat agent duplikat.
