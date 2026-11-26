# Catatan Skala & Model Heartbeat — Muse Management Control

Dicatat 2026-11-26 atas permintaan Satria (dia sedang fokus integrasi agent;
ini bahan keputusan nanti, BUKAN pekerjaan yang sudah dijalankan).

## Keadaan produksi sekarang (2026-11-26)

- Interval heartbeat: **60 detik** (diubah dari 30 pada 2026-11-26 ~20:09 WIB).
  Ambang tak terjangkau: 3x heartbeat terlewat → deteksi ±3 menit.
- **Model heartbeat: REPLACE MURNI — LIVE sejak 2026-11-26 ~20:44 WIB**
  (keputusan final Satria hari yang sama; kontrak di CONTRACT-4.md, migrasi
  `20261126133729_phase4_heartbeat_replace`, test backend 147/147).
  Satu baris per agent, ditimpa tiap laporan; migrasi merangkum riwayat lama
  jadi baris terbaru per agent. Retensi heartbeat sekarang no-op (baris
  terakhir agent tidak pernah dihapus retensi). Konsekuensi yang diterima
  Satria: statistik historis Analitik per-worker menyusut ke titik terbaru
  (grafik hashrate 1 titik, downtime 0, interval share kosong) — halaman
  Analitik per-agent, dashboard live, status, alert, otomasi, sesi, event
  tidak terpengaruh. Usulan retensi 7 hari jadi tidak relevan lagi untuk
  heartbeat (tetap berlaku sebagai konsep untuk tabel lain bila perlu).

## Tangga skala (hasil hitungan, bukan janji)

- **±100 agent @ 60 dtk** (±1,7 req/dtk): nyaman di VPS sekarang
  (2 vCPU / 1,9 GB; backend ±91 MB, PG ±197 MB terukur).
- **±600 agent @ 60 dtk** (±10 req/dtk): masih ringan untuk CPU/RAM.
  Titik tekan satu-satunya = disk dari heartbeat: ±864 rb baris/hari →
  retensi 30 hari ±26 jt baris (±13–26 GB, disk VPS 39 GB — mepet);
  retensi 7 hari ±6 jt baris (±3–6 GB — aman).
- **±5.000 agent**: di luar amplop desain. ±167 req/dtk jenuh di kolam
  koneksi DB (Prisma connection_limit=5) dan heartbeat 14,4 jt baris/hari
  menjebol disk dalam hitungan hari. Perlu: VPS lebih besar, pool dinaikkan,
  interval 120 dtk+, dan model heartbeat timpa-terbaru (di bawah).

## Opsi model timpa-terbaru (replace-latest) — kartu simpanan skala ribuan

Heartbeat tidak ditumpuk; satu baris per agent selalu ditimpa laporan terbaru.

- Tetap jalan: status saat ini, deteksi tak terjangkau, alert, aturan
  otomasi, verifikasi perintah (semua membaca laporan terakhir + statusSince
  di baris worker), sesi/event/audit (tabel terpisah).
- Hilang: jejak menit-per-menit historis — tidak bisa lagi melihat pola
  naik-turun/flapping atau rayapan memori dalam sesi setelah kejadian lewat;
  perubahan status besar tetap tercatat sebagai event, detail angkanya tidak.
- Untungnya: penyimpanan heartbeat konstan (N agent = N baris); retensi
  heartbeat tidak relevan lagi.
- Penilaian mikasa 2026-11-26: untuk skala Satria sekarang, append + retensi
  7 hari lebih baik (diagnostik lengkap, biaya beberapa GB). Migrasi ke
  timpa-terbaru mudah dilakukan nanti karena tidak ada fungsi hidup yang
  bergantung pada tumpukan riwayat heartbeat.

## Yang TIDAK pernah dihapus retensi

Agent, sesi/pergantian VM, event, log audit. Retensi hanya menyentuh:
heartbeats, pool_snapshots, alert_notifications (+deliveries), dan commands
yang sudah terminal — masing-masing dengan batas hari sendiri, 0 = mati.
