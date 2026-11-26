# Instalasi Muse Management Control di VPS Baru

Panduan memasang sistem ini dari nol di satu VPS (target: Ubuntu 24.04/26.04,
2 vCPU / 2 GB RAM sudah cukup untuk ±100 agent). Arsitektur: satu proses
backend (Fastify) + PostgreSQL + frontend statis yang disajikan nginx +
bridge ringan di tiap mesin agent.

Isi paket: `backend/` (API + mesin otomasi), `frontend/` (dashboard Nuxt,
dibangun jadi statis), `bridge/` (program di mesin agent), `deploy/`
(unit systemd, contoh nginx, tuning PostgreSQL), `spec/` (dokumen spek),
`CONTRACT*.md` (kontrak implementasi per fase), `SCALING-NOTES.md`
(catatan kapasitas).

## 1. Prasyarat

```bash
# Node.js 22 (NodeSource) + PostgreSQL + nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql nginx
node --version   # v22.x
```

## 2. Database

```bash
sudo -u postgres psql -c "CREATE USER muse WITH PASSWORD '<password-db>';"
sudo -u postgres psql -c "CREATE DATABASE muse_control OWNER muse;"
# Tuning ringan (opsional, file contoh di deploy/postgres-tuning.conf):
sudo -u postgres psql -c "ALTER SYSTEM SET shared_buffers='256MB';"
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections=30;"
sudo -u postgres psql -c "ALTER SYSTEM SET work_mem='4MB';"
sudo systemctl restart postgresql
```

## 3. Backend

```bash
sudo mkdir -p /opt/muse-control
sudo cp -r backend /opt/muse-control/backend
cd /opt/muse-control/backend
cp .env.example .env
nano .env
```

Isi `.env` yang wajib diganti:

- `DATABASE_URL=postgresql://muse:<password-db>@127.0.0.1:5432/muse_control?connection_limit=5`
- `JWT_SECRET=` — string acak panjang, mis. hasil `openssl rand -hex 32`
- `ADMIN_EMAIL=` + `ADMIN_PASSWORD=` — akun admin pertama, dibuat otomatis
  saat server pertama kali menyala. Ganti password-nya lagi dari dashboard
  setelah login pertama.
- `PUBLIC_BASE_URL=https://<domain-kamu>` — WAJIB untuk produksi; dokumen
  enrollment di `/agent.md` dirender dengan alamat ini.

Lalu:

```bash
npm install --omit=dev --workspaces=false
npx prisma migrate deploy
npm run build
```

Jalankan sebagai service — contoh unit ada di `deploy/systemd/muse-control.service`
(sesuaikan path/user), lalu:

```bash
sudo cp deploy/systemd/muse-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now muse-control
curl http://127.0.0.1:3001/healthz   # {"status":"ok","db":true}
```

## 4. Frontend + nginx + TLS

```bash
cd frontend
npm install --workspaces=false
NODE_OPTIONS=--max-old-space-size=2048 npm run generate
sudo mkdir -p /var/www/musang
sudo cp -r .output/public/* /var/www/musang/
sudo chmod -R a+rX /var/www/musang
```

nginx: pakai contoh `deploy/nginx/musang.mikasu.lol.conf` — ganti nama domain,
path sertifikat, dan root-nya. Konfig contoh itu mem-proxy `/api/` dan `/ws`
ke backend (127.0.0.1:3001), menyajikan frontend statis, DAN mem-proxy
`/agent.md` ke backend (dokumen enrollment dirender live dari server supaya
kunci enrollment di dalamnya selalu yang terbaru — jangan sajikan sebagai
file statis).

TLS: contoh memakai sertifikat Cloudflare Origin CA dengan mode SSL "Full
(Strict)" yang di-scope ke hostname ini lewat Configuration Rule Cloudflare.
Alternatif bebas: Let's Encrypt (certbot) juga bisa.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5. File unduhan untuk agent

Dokumen `/agent.md` menyuruh agent mengunduh bridge dari root domain, jadi
bangun bridge sekali lalu taruh hasilnya di web root:

```bash
cd bridge
npm install --workspaces=false
npm run build            # menghasilkan dist/bridge.cjs (satu file, tanpa dependensi)
sudo cp dist/bridge.cjs install.sh /var/www/musang/
sudo chmod a+rX /var/www/musang/bridge.cjs /var/www/musang/install.sh
```

## 6. Cara agent bergabung

Dua jalur, dua-duanya dari dashboard:

1. **Daftar mandiri (tanpa operator):** beri agent tautan
   `https://<domain-kamu>/agent.md` — dokumen itu berisi kunci enrollment
   dan langkah instalasi bridge sampai teregistrasi sendiri. Kunci bisa
   diputar kapan saja dari dashboard (Pengaturan → Enrollment); memutarnya
   mematikan semua salinan dokumen lama.
2. **Kode pairing:** dari menu Agent → Tambah Agent, buat kode pairing
   (berlaku 15 menit), lalu di mesin agent tulis `bridge.env` berisi
   `MUSE_PAIRING_CODE=<kode>` dan jalankan `install.sh` dari paket bridge.
   Detail semua variabel ada di `bridge/README.md`.

## 7. Verifikasi akhir

- `https://<domain-kamu>/` → dashboard tampil; login dengan ADMIN_EMAIL/
  ADMIN_PASSWORD dari `.env`.
- `https://<domain-kamu>/agent.md` → dokumen Markdown berisi
  `MUSE_SERVER_URL=https://<domain-kamu>` dan baris `MUSE_ENROLLMENT_KEY=`.
- Daftarkan satu agent uji → muncul di daftar Agent (yang daftar mandiri
  berbadge "Daftar Mandiri"), heartbeat masuk tiap 60 detik (default server).

## Catatan operasional

- Semua pengaturan runtime (interval heartbeat, ambang status, retensi,
  alert webhook, saklar otomasi) ada di dashboard menu Pengaturan — bukan
  di file konfigurasi.
- Retensi default: heartbeat 30 hari, snapshot pool 30 hari, alert &
  perintah selesai 90 hari. Untuk ratusan agent, pendekkan retensi
  heartbeat (lihat `SCALING-NOTES.md`).
- Cross-check pool saat ini masih adapter placeholder (`POOL_PROVIDER=none`)
  — status pool di UI akan menyatakan belum dikonfigurasi sampai adapter
  API pool asli ditulis mengikuti dokumentasi API pool yang dipakai.
- Backup yang penting: database PostgreSQL + file `.env` backend.
