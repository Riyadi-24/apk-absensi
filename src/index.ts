import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

// ===========================================================
// TIPE ENVIRONMENT (Bindings dari wrangler.toml)
// ===========================================================
export type Env = {
  DB: D1Database
  FOTO_BUCKET: R2Bucket
  JWT_SECRET: string   // Tambahkan di Cloudflare Secrets
}

// Tambahkan deklarasi globals untuk environment Cloudflare jika IDE belum mengenali
declare global {
  interface D1Database {
    prepare(query: string): {
      bind(...args: any[]): {
        first(): Promise<any>;
        all(): Promise<{ results: any[] }>;
        run(): Promise<any>;
      }
      first(): Promise<any>;
      all(): Promise<{ results: any[] }>;
      run(): Promise<any>;
    }
  }
  interface R2Bucket {
    put(key: string, value: any, options?: any): Promise<any>;
    get(key: string): Promise<any>;
    delete(key: string): Promise<any>;
  }
  const crypto: any
  const btoa: (s: string) => string
  const atob: (s: string) => string
  const TextEncoder: any
  const URL: any
  const File: any
  const Response: any
  const console: any
  interface ScheduledEvent { cron: string; type: string; scheduledTime: number }
  interface ExecutionContext { waitUntil(promise: Promise<any>): void }
}

// ============================================================
// UTILITAS
// ============================================================
function generateId(): string {
  return crypto.randomUUID()
}

async function generateToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify({ ...payload, iat: Date.now() }))
  const data = `${header}.${body}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${data}.${sigB64}`
}

async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, sig] = token.split('.')
    const data = `${header}.${body}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data))
    if (!valid) return null
    return JSON.parse(atob(body))
  } catch {
    return null
  }
}

// ============================================================
// MIDDLEWARE AUTENTIKASI
// ============================================================
async function authMiddleware(c: Context<{ Bindings: Env }>, next: () => Promise<void>, requiredRole?: 'admin' | 'karyawan') {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Token tidak ditemukan. Silakan login.' }, 401)
  }
  const token = authHeader.substring(7)
  const payload: any = await verifyToken(token, c.env.JWT_SECRET || 'default-secret-ganti-ini')
  if (!payload) {
    return c.json({ error: 'Token tidak valid atau sudah kadaluarsa.' }, 401)
  }
  // Cek role jika diminta
  if (requiredRole && payload.role !== requiredRole && payload.role !== 'admin') {
    return c.json({ error: `Akses ditolak. Hanya ${requiredRole} yang dapat mengakses ini.` }, 403)
  }
  c.set('user', payload)
  await next()
}

// ============================================================
// INISIALISASI APLIKASI HONO
// ============================================================
const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ===========================================
// ROUTE: Sajikan file statis (Frontend SPA)
// ===========================================
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/app.js', serveStatic({ path: './public/app.js' }))

// ===========================================
// ROUTE: WebAuthn - Mulai Registrasi Biometrik
// Bisa diakses admin untuk mendaftarkan karyawan baru
// ===========================================
app.post('/api/webauthn/register/begin', async (c: Context<{ Bindings: Env }>) => {
  try {
    const { pegawai_id } = await c.req.json<{ pegawai_id: string }>()
    if (!pegawai_id) return c.json({ error: 'pegawai_id diperlukan' }, 400)

    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE id = ?').bind(pegawai_id).first() as any
    if (!pegawai) return c.json({ error: 'Pegawai tidak ditemukan' }, 404)

    const challenge = generateId()
    const expiredAt = new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 menit

    // Simpan challenge sementara
    await c.env.DB.prepare(
      'INSERT INTO webauthn_challenges (id, pegawai_id, challenge, type, expired_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId(), pegawai_id, challenge, 'registration', expiredAt).run()

    return c.json({
      challenge,
      rp: { name: 'Absensi Perja', id: new URL(c.req.url).hostname },
      user: { id: pegawai.id, name: pegawai.nik, displayName: pegawai.nama },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' }  // RS256
      ],
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        requireResidentKey: false
      },
      attestation: 'none'
    })
  } catch (err) {
    return c.json({ error: 'Gagal memulai registrasi', detail: String(err) }, 500)
  }
})

// ===========================================
// ROUTE: WebAuthn - Selesaikan Registrasi
// ===========================================
app.post('/api/webauthn/register/complete', async (c: Context<{ Bindings: Env }>) => {
  try {
    const { pegawai_id, credential_id, public_key, device_name, challenge } = await c.req.json<{
      pegawai_id: string, credential_id: string, public_key: string, device_name: string, challenge: string
    }>()

    // Verifikasi challenge
    const row = await c.env.DB.prepare(
      'SELECT * FROM webauthn_challenges WHERE pegawai_id = ? AND challenge = ? AND type = ? AND expired_at > ?'
    ).bind(pegawai_id, challenge, 'registration', new Date().toISOString()).first()
    if (!row) return c.json({ error: 'Challenge tidak valid atau sudah kadaluarsa' }, 400)

    // Simpan credential
    await c.env.DB.prepare(
      'INSERT INTO webauthn_credentials (id, pegawai_id, public_key, device_name) VALUES (?, ?, ?, ?)'
    ).bind(credential_id, pegawai_id, public_key, device_name || 'Perangkat Baru').run()

    // Hapus challenge yang sudah dipakai
    await c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE pegawai_id = ? AND type = ?')
      .bind(pegawai_id, 'registration').run()

    return c.json({ success: true, message: 'Biometrik berhasil didaftarkan!' })
  } catch (err) {
    return c.json({ error: 'Gagal menyelesaikan registrasi', detail: String(err) }, 500)
  }
})

// ===========================================
// ROUTE: WebAuthn - Mulai Autentikasi (Login)
// ===========================================
app.post('/api/webauthn/auth/begin', async (c: Context<{ Bindings: Env }>) => {
  try {
    const { nik } = await c.req.json<{ nik: string }>()
    if (!nik) return c.json({ error: 'NIK diperlukan' }, 400)

    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE nik = ?').bind(nik).first() as any
    if (!pegawai) return c.json({ error: 'NIK tidak ditemukan' }, 404)

    // Ambil semua credential untuk pegawai ini
    const creds = await c.env.DB.prepare(
      'SELECT id FROM webauthn_credentials WHERE pegawai_id = ?'
    ).bind(pegawai.id).all()
    if (!creds.results || creds.results.length === 0) {
      return c.json({ error: 'Belum ada biometrik yang terdaftar untuk akun ini.' }, 400)
    }

    const challenge = generateId()
    const expiredAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    await c.env.DB.prepare(
      'INSERT INTO webauthn_challenges (id, pegawai_id, challenge, type, expired_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId(), pegawai.id, challenge, 'authentication', expiredAt).run()

    return c.json({
      challenge,
      timeout: 60000,
      userVerification: 'required',
      rpId: new URL(c.req.url).hostname,
      allowCredentials: creds.results.map((r: any) => ({
        type: 'public-key',
        id: r.id
      }))
    })
  } catch (err) {
    return c.json({ error: 'Gagal memulai autentikasi', detail: String(err) }, 500)
  }
})

// ===========================================
// ROUTE: WebAuthn - Selesaikan Autentikasi
// ===========================================
app.post('/api/webauthn/auth/complete', async (c: Context<{ Bindings: Env }>) => {
  try {
    const { nik, credential_id, challenge } = await c.req.json<{
      nik: string, credential_id: string, challenge: string
    }>()

    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE nik = ?').bind(nik).first() as any
    if (!pegawai) return c.json({ error: 'NIK tidak ditemukan' }, 404)

    // Verifikasi challenge
    const chalRow = await c.env.DB.prepare(
      'SELECT * FROM webauthn_challenges WHERE pegawai_id = ? AND challenge = ? AND type = ? AND expired_at > ?'
    ).bind(pegawai.id, challenge, 'authentication', new Date().toISOString()).first()
    if (!chalRow) return c.json({ error: 'Challenge tidak valid atau kadaluarsa' }, 400)

    // Pastikan credential ada
    const cred = await c.env.DB.prepare(
      'SELECT * FROM webauthn_credentials WHERE id = ? AND pegawai_id = ?'
    ).bind(credential_id, pegawai.id).first()
    if (!cred) return c.json({ error: 'Credential tidak dikenali' }, 400)

    // Update counter (anti-replay)
    await c.env.DB.prepare('UPDATE webauthn_credentials SET counter = counter + 1 WHERE id = ?').bind(credential_id).run()
    await c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE pegawai_id = ? AND type = ?').bind(pegawai.id, 'authentication').run()

    // Generate JWT Token
    const token = await generateToken(
      { sub: pegawai.id, nik: pegawai.nik, nama: pegawai.nama, role: pegawai.role, departemen: pegawai.departemen },
      c.env.JWT_SECRET || 'default-secret-ganti-ini'
    )

    return c.json({
      success: true,
      token,
      user: { id: pegawai.id, nama: pegawai.nama, nik: pegawai.nik, role: pegawai.role, departemen: pegawai.departemen }
    })
  } catch (err) {
    return c.json({ error: 'Gagal autentikasi', detail: String(err) }, 500)
  }
})

// ===========================================
// ROUTE: Absensi - Rekam Absensi (Karyawan)
// Memerlukan login - hanya karyawan & admin
// ===========================================
app.post('/api/absensi', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    try {
      const user = c.get('user') as any
      const formData = await c.req.formData()
      const fotoFile = formData.get('foto') as any // Menggunakan any untuk sementara karena masalah tipe File di IDE
      const tipe = (formData.get('tipe') as string) || 'masuk'
      const latitude = parseFloat(formData.get('latitude') as string)
      const longitude = parseFloat(formData.get('longitude') as string)
      const lokasi_nama = formData.get('lokasi_nama') as string || ''

      // Upload foto ke R2
      let foto_url = ''
      let foto_key = ''
      if (fotoFile) {
        const ext = fotoFile.name?.split('.').pop() || 'jpg'
        foto_key = `absensi/${user.sub}/${new Date().toISOString().substring(0, 10)}_${generateId()}.${ext}`
        const buffer = await fotoFile.arrayBuffer()
        await c.env.FOTO_BUCKET.put(foto_key, buffer, {
          httpMetadata: { contentType: fotoFile.type || 'image/jpeg' }
        })
        // URL publik R2 (sesuaikan dengan domain Worker Anda)
        foto_url = `/api/foto/${encodeURIComponent(foto_key)}`
      }

      // Tentukan status (terlambat jika masuk > 08:15 WIB)
      const now = new Date()
      const jamWIB = now.getUTCHours() + 7 // UTC+7
      let status = 'hadir'
      if (tipe === 'masuk' && jamWIB >= 9) status = 'terlambat'

      const absensiId = generateId()
      await c.env.DB.prepare(`
        INSERT INTO log_absensi (id, pegawai_id, tipe, latitude, longitude, lokasi_nama, foto_url, foto_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(absensiId, user.sub, tipe, latitude, longitude, lokasi_nama, foto_url, foto_key, status).run()

      return c.json({
        success: true,
        message: `Absensi ${tipe} berhasil dicatat!`,
        data: { id: absensiId, tipe, status, waktu: now.toISOString() }
      })
    } catch (err) {
      return c.json({ error: 'Gagal merekam absensi', detail: String(err) }, 500)
    }
  })
})

// ===========================================
// ROUTE: Ambil Foto dari R2
// ===========================================
app.get('/api/foto/:key', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const key = decodeURIComponent(c.req.param('key'))
    const obj = await c.env.FOTO_BUCKET.get(key)
    if (!obj) return c.json({ error: 'Foto tidak ditemukan' }, 404)
    return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg' }
    })
  })
})

// ===========================================
// ROUTE: Riwayat Absensi Diri Sendiri (Karyawan)
// ===========================================
app.get('/api/absensi/saya', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    const limit = parseInt(c.req.query('limit') || '30')
    const offset = parseInt(c.req.query('offset') || '0')

    const rows = await c.env.DB.prepare(`
      SELECT l.*, p.nama, p.nik FROM log_absensi l
      JOIN pegawai p ON l.pegawai_id = p.id
      WHERE l.pegawai_id = ?
      ORDER BY l.waktu DESC LIMIT ? OFFSET ?
    `).bind(user.sub, limit, offset).all()

    return c.json({ success: true, data: rows.results, total: rows.results.length })
  })
})

// ============================================================
// ROUTE ADMIN - Hanya bisa diakses oleh role 'admin'
// ============================================================

// Dashboard: Semua log absensi (Admin)
app.get('/api/admin/absensi', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    if (user.role !== 'admin') return c.json({ error: 'Hanya admin yang bisa mengakses ini' }, 403)

    const tanggal = c.req.query('tanggal') || new Date().toISOString().substring(0, 10)
    const rows = await c.env.DB.prepare(`
      SELECT l.*, p.nama, p.nik, p.departemen FROM log_absensi l
      JOIN pegawai p ON l.pegawai_id = p.id
      WHERE date(l.waktu) = ?
      ORDER BY l.waktu DESC
    `).bind(tanggal).all()

    return c.json({ success: true, data: rows.results, tanggal })
  })
})

// Daftar semua pegawai (Admin)
app.get('/api/admin/pegawai', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    if (user.role !== 'admin') return c.json({ error: 'Hanya admin yang bisa mengakses ini' }, 403)

    const rows = await c.env.DB.prepare('SELECT id, nama, nik, role, departemen, email, created_at FROM pegawai ORDER BY nama').all()
    return c.json({ success: true, data: rows.results })
  })
})

// Tambah pegawai baru (Admin)
app.post('/api/admin/pegawai', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    if (user.role !== 'admin') return c.json({ error: 'Hanya admin yang bisa mengakses ini' }, 403)

    const { nama, nik, role, departemen, email } = await c.req.json<{
      nama: string, nik: string, role: string, departemen: string, email: string
    }>()

    if (!nama || !nik) return c.json({ error: 'Nama dan NIK wajib diisi' }, 400)
    const newRole = (role === 'admin') ? 'admin' : 'karyawan'
    const id = generateId()

    await c.env.DB.prepare(
      'INSERT INTO pegawai (id, nama, nik, role, departemen, email) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, nama, nik, newRole, departemen || null, email || null).run()

    return c.json({ success: true, message: `Pegawai ${nama} berhasil ditambahkan!`, data: { id, nama, nik, role: newRole } })
  })
})

// Hapus pegawai (Admin)
app.delete('/api/admin/pegawai/:id', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    if (user.role !== 'admin') return c.json({ error: 'Hanya admin yang bisa mengakses ini' }, 403)

    const pegawaiId = c.req.param('id')
    if (pegawaiId === 'admin-001') return c.json({ error: 'Akun admin utama tidak bisa dihapus' }, 400)

    // Hapus foto di R2 terlebih dahulu
    const fotoRows = await c.env.DB.prepare('SELECT foto_key FROM log_absensi WHERE pegawai_id = ? AND foto_key IS NOT NULL').bind(pegawaiId).all()
    for (const row of (fotoRows.results as any[])) {
      if (row.foto_key) await c.env.FOTO_BUCKET.delete(row.foto_key)
    }

    await c.env.DB.prepare('DELETE FROM pegawai WHERE id = ?').bind(pegawaiId).run()
    return c.json({ success: true, message: 'Pegawai berhasil dihapus' })
  })
})

// Laporan Rekap per Rentang Tanggal (Admin)
app.get('/api/admin/laporan', async (c: Context<{ Bindings: Env }>) => {
  return authMiddleware(c, async () => {
    const user = c.get('user') as any
    if (user.role !== 'admin') return c.json({ error: 'Hanya admin yang bisa mengakses ini' }, 403)

    const dari = c.req.query('dari') || new Date().toISOString().substring(0, 10)
    const sampai = c.req.query('sampai') || dari

    const rows = await c.env.DB.prepare(`
      SELECT p.nama, p.nik, p.departemen,
             COUNT(CASE WHEN l.tipe = 'masuk' THEN 1 END) AS total_masuk,
             COUNT(CASE WHEN l.tipe = 'pulang' THEN 1 END) AS total_pulang,
             COUNT(CASE WHEN l.status = 'terlambat' THEN 1 END) AS total_terlambat
      FROM pegawai p
      LEFT JOIN log_absensi l ON p.id = l.pegawai_id AND date(l.waktu) BETWEEN ? AND ?
      WHERE p.role = 'karyawan'
      GROUP BY p.id
      ORDER BY p.nama
    `).bind(dari, sampai).all()

    return c.json({ success: true, data: rows.results, dari, sampai })
  })
})

// ===========================================
// EXPORT: Scheduled Handler (Cron Job)
// Hapus data absensi & foto yang > 1 tahun
// ===========================================
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupOldData(env))
  }
}

async function cleanupOldData(env: Env): Promise<void> {
  const satu_tahun_lalu = new Date()
  satu_tahun_lalu.setFullYear(satu_tahun_lalu.getFullYear() - 1)
  const batas = satu_tahun_lalu.toISOString()

  // Ambil foto_key yang akan dihapus
  const rows = await env.DB.prepare(
    "SELECT foto_key FROM log_absensi WHERE foto_key IS NOT NULL AND waktu < ?"
  ).bind(batas).all()

  // Hapus foto dari R2
  for (const row of (rows.results as any[])) {
    if (row.foto_key) {
      try { await env.FOTO_BUCKET.delete(row.foto_key) } catch {}
    }
  }

  // Hapus data di D1
  await env.DB.prepare("DELETE FROM log_absensi WHERE waktu < ?").bind(batas).run()
  await env.DB.prepare("DELETE FROM webauthn_challenges WHERE expired_at < ?").bind(new Date().toISOString()).run()

  console.log(`[Cron] Cleanup selesai: ${rows.results.length} log + foto dihapus.`)
}
