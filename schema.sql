-- ============================================
-- Schema DB Absensi Perja
-- Jalankan: wrangler d1 execute absensi-db --file=./schema.sql
-- ============================================

-- Tabel Pegawai
-- Kolom 'role' membedakan antara 'admin' dan 'karyawan'
CREATE TABLE IF NOT EXISTS pegawai (
  id            TEXT PRIMARY KEY,          -- UUID
  nama          TEXT NOT NULL,
  nik           TEXT NOT NULL UNIQUE,      -- Nomor Induk Karyawan
  role          TEXT NOT NULL DEFAULT 'karyawan' CHECK(role IN ('admin', 'karyawan')),
  departemen    TEXT,
  email         TEXT UNIQUE,
  -- WebAuthn: credential_id dan public_key disimpan terpisah di tabel webauthn_credentials
  -- agar satu pegawai bisa punya lebih dari 1 perangkat
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tabel WebAuthn Credentials (Sidik Jari / Biometrik)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             TEXT PRIMARY KEY,          -- credential_id dari WebAuthn (base64url)
  pegawai_id     TEXT NOT NULL,
  public_key     TEXT NOT NULL,             -- COSE public key (base64)
  counter        INTEGER NOT NULL DEFAULT 0,
  device_name    TEXT,                      -- Nama perangkat (contoh: "HP Samsung A54")
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pegawai_id) REFERENCES pegawai(id) ON DELETE CASCADE
);

-- Tabel Log Absensi
CREATE TABLE IF NOT EXISTS log_absensi (
  id           TEXT PRIMARY KEY,            -- UUID
  pegawai_id   TEXT NOT NULL,
  waktu        TEXT NOT NULL DEFAULT (datetime('now')),
  tipe         TEXT NOT NULL DEFAULT 'masuk' CHECK(tipe IN ('masuk', 'pulang')),
  latitude     REAL,
  longitude    REAL,
  lokasi_nama  TEXT,
  foto_url     TEXT,                        -- URL dari R2
  foto_key     TEXT,                        -- Key di R2 untuk keperluan hapus
  status       TEXT NOT NULL DEFAULT 'hadir' CHECK(status IN ('hadir', 'terlambat', 'lembur')),
  keterangan   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pegawai_id) REFERENCES pegawai(id) ON DELETE CASCADE
);

-- Tabel WebAuthn Challenges (Sementara, dibersihkan secara berkala)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id           TEXT PRIMARY KEY,
  pegawai_id   TEXT,                        -- NULL saat registrasi awal
  challenge    TEXT NOT NULL,
  type         TEXT NOT NULL CHECK(type IN ('registration', 'authentication')),
  expired_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indeks untuk performa query
CREATE INDEX IF NOT EXISTS idx_log_absensi_pegawai ON log_absensi(pegawai_id);
CREATE INDEX IF NOT EXISTS idx_log_absensi_waktu   ON log_absensi(waktu);
CREATE INDEX IF NOT EXISTS idx_webauthn_cred_pegawai ON webauthn_credentials(pegawai_id);

-- =====================================================
-- Seed Data: Akun Admin Default
-- Password: admin (di aplikasi nyata, gunakan mekanisme lebih aman)
-- =====================================================
INSERT OR IGNORE INTO pegawai (id, nama, nik, role, departemen, email)
VALUES ('admin-001', 'Administrator', 'ADM001', 'admin', 'IT', 'admin@perusahaan.com');
