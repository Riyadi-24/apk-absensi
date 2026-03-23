import { Hono } from 'hono'
import { cors } from 'hono/cors'

// ============================================================
// KONFIGURASI APLIKASI (Cloudflare Pages Functions)
// ============================================================
// Note: Di Pages Functions, 'env' diberikan ke setiap handler,
// bukan global ke 'Bindings'.

const app = new Hono().basePath('/api')

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ===========================================
// UTILITAS (JavaScript)
// ===========================================
function generateId() {
  return crypto.randomUUID()
}

async function generateToken(payload, secret) {
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
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return `${data}.${sigB64}`
}

async function verifyToken(token, secret) {
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
    const sigB64 = sig.replace(/-/g, '+').replace(/_/g, '/')
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data))
    if (!valid) return null
    return JSON.parse(atob(body))
  } catch {
    return null
  }
}

async function hashPassword(password) {
  const enc = new TextEncoder().encode(password)
  const hashArr = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(hashArr)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ============================================================
// MIDDLEWARE AUTENTIKASI
// ============================================================
async function authMiddleware(c, next, requiredRole) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Token tidak ditemukan. Silakan login.' }, 401)
  }
  const token = authHeader.substring(7)
  const payload = await verifyToken(token, c.env.JWT_SECRET || 'default-secret-ganti-ini')
  if (!payload) {
    return c.json({ error: 'Token tidak valid atau sudah kadaluarsa.' }, 401)
  }
  if (requiredRole && payload.role !== requiredRole && payload.role !== 'admin') {
    return c.json({ error: `Akses ditolak. Hanya ${requiredRole} yang dapat mengakses ini.` }, 403)
  }
  c.set('user', payload)
  await next()
}

// ===========================================
// ROUTE: Login Tradisional (NIK + Password)
// ===========================================
app.post('/login', async (c) => {
  try {
    const { nik, password } = await c.req.json()
    if (!nik || !password) return c.json({ error: 'NIK dan Password wajib diisi' }, 400)

    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE nik = ?').bind(nik).first()
    if (!pegawai) return c.json({ error: 'NIK tidak ditemukan' }, 404)

    if (!pegawai.password_hash) {
      return c.json({ error: 'Login biometrik wajib untuk akun ini. Silakan gunakan sidik jari.' }, 400)
    }

    const inputHash = await hashPassword(password)
    if (inputHash !== pegawai.password_hash) {
      return c.json({ error: 'Kata sandi salah' }, 401)
    }

    const token = await generateToken(
      { sub: pegawai.id, nik: pegawai.nik, nama: pegawai.nama, role: pegawai.role },
      c.env.JWT_SECRET || 'default-secret-ganti-ini'
    )

    return c.json({ success: true, token, user: pegawai })
  } catch (err) {
    return c.json({ error: 'Gagal login', detail: String(err) }, 500)
  }
})

// ===========================================
// ROUTE: WebAuthn - Mulai Registrasi
// ===========================================
app.post('/webauthn/register/begin', async (c) => {
  try {
    const { pegawai_id } = await c.req.json()
    if (!pegawai_id) return c.json({ error: 'pegawai_id diperlukan' }, 400)

    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE id = ?').bind(pegawai_id).first()
    if (!pegawai) return c.json({ error: 'Pegawai tidak ditemukan' }, 404)

    const challenge = generateId()
    const expiredAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    await c.env.DB.prepare(
      'INSERT INTO webauthn_challenges (id, pegawai_id, challenge, type, expired_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId(), pegawai_id, challenge, 'registration', expiredAt).run()

    return c.json({
      challenge,
      rp: { name: 'Absensi Perja', id: new URL(c.req.url).hostname },
      user: { id: pegawai.id, name: pegawai.nik, displayName: pegawai.nama },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
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

// ... (Sisa rute dikonversi ke JS ESM untuk Cloudflare Pages) ...

app.post('/webauthn/register/complete', async (c) => {
  try {
    const { pegawai_id, credential_id, public_key, device_name, challenge } = await c.req.json()
    const row = await c.env.DB.prepare(
      'SELECT * FROM webauthn_challenges WHERE pegawai_id = ? AND challenge = ? AND type = ? AND expired_at > ?'
    ).bind(pegawai_id, challenge, 'registration', new Date().toISOString()).first()
    if (!row) return c.json({ error: 'Challenge tidak valid atau sudah kadaluarsa' }, 400)

    await c.env.DB.prepare(
      'INSERT INTO webauthn_credentials (id, pegawai_id, public_key, device_name) VALUES (?, ?, ?, ?)'
    ).bind(credential_id, pegawai_id, public_key, device_name || 'Perangkat Baru').run()

    await c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE pegawai_id = ? AND type = ?')
      .bind(pegawai_id, 'registration').run()

    return c.json({ success: true, message: 'Biometrik berhasil didaftarkan!' })
  } catch (err) {
    return c.json({ error: 'Gagal', detail: String(err) }, 500)
  }
})

app.post('/webauthn/auth/begin', async (c) => {
  try {
    const { nik } = await c.req.json()
    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE nik = ?').bind(nik).first()
    if (!pegawai) return c.json({ error: 'NIK tidak ditemukan' }, 404)

    const creds = await c.env.DB.prepare('SELECT id FROM webauthn_credentials WHERE pegawai_id = ?').bind(pegawai.id).all()
    if (!creds.results || creds.results.length === 0) return c.json({ error: 'Belum ada biometrik.' }, 400)

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
      allowCredentials: creds.results.map(r => ({ type: 'public-key', id: r.id }))
    })
  } catch (err) {
    return c.json({ error: 'Error', detail: String(err) }, 500)
  }
})

app.post('/webauthn/auth/complete', async (c) => {
  try {
    const { nik, credential_id, challenge } = await c.req.json()
    const pegawai = await c.env.DB.prepare('SELECT * FROM pegawai WHERE nik = ?').bind(nik).first()
    const chalRow = await c.env.DB.prepare(
      'SELECT * FROM webauthn_challenges WHERE pegawai_id = ? AND challenge = ? AND type = ? AND expired_at > ?'
    ).bind(pegawai.id, challenge, 'authentication', new Date().toISOString()).first()
    if (!chalRow) return c.json({ error: 'Invalid challenge' }, 400)

    await c.env.DB.prepare('UPDATE webauthn_credentials SET counter = counter+1 WHERE id = ?').bind(credential_id).run()

    const token = await generateToken(
      { sub: pegawai.id, nik: pegawai.nik, nama: pegawai.nama, role: pegawai.role },
      c.env.JWT_SECRET || 'default-secret-ganti-ini'
    )
    return c.json({ success: true, token, user: pegawai })
  } catch (err) {
    return c.json({ error: 'Error', detail: String(err) }, 500)
  }
})

app.post('/absensi', async (c) => {
  return authMiddleware(c, async () => {
    const user = c.get('user')
    const formData = await c.req.formData()
    const fotoFile = formData.get('foto')
    const tipe = formData.get('tipe') || 'masuk'
    
    let foto_url = ''
    let foto_key = ''
    if (fotoFile) {
      foto_key = `absensi/${user.sub}/${new Date().toISOString().substring(0, 10)}_${generateId()}.jpg`
      await c.env.FOTO_BUCKET.put(foto_key, await fotoFile.arrayBuffer())
      foto_url = `/api/foto/${encodeURIComponent(foto_key)}`
    }

    const absensiId = generateId()
    await c.env.DB.prepare(`
      INSERT INTO log_absensi (id, pegawai_id, tipe, latitude, longitude, lokasi_nama, foto_url, foto_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(absensiId, user.sub, tipe, formData.get('latitude'), formData.get('longitude'), formData.get('lokasi_nama'), foto_url, foto_key).run()

    return c.json({ success: true, message: 'Absensi berhasil' })
  })
})

app.get('/foto/:key', async (c) => {
  return authMiddleware(c, async () => {
    const obj = await c.env.FOTO_BUCKET.get(decodeURIComponent(c.req.param('key')))
    if (!obj) return c.json({ error: 'Not found' }, 404)
    return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg' } })
  })
})

app.get('/absensi/saya', async (c) => {
  return authMiddleware(c, async () => {
    const res = await c.env.DB.prepare('SELECT * FROM log_absensi WHERE pegawai_id = ? ORDER BY waktu DESC LIMIT 20').bind(c.get('user').sub).all()
    return c.json({ success: true, data: res.results })
  })
})

// ADMIN ROUTES
app.get('/admin/absensi', (c) => authMiddleware(c, async () => {
    const tgl = c.req.query('tanggal') || new Date().toISOString().substring(0, 10)
    const res = await c.env.DB.prepare('SELECT l.*, p.nama, p.nik FROM log_absensi l JOIN pegawai p ON l.pegawai_id = p.id WHERE date(l.waktu) = ?').bind(tgl).all()
    return c.json({ success: true, data: res.results })
}, 'admin'))

app.get('/admin/pegawai', (c) => authMiddleware(c, async () => {
    const res = await c.env.DB.prepare('SELECT * FROM pegawai').all()
    return c.json({ success: true, data: res.results })
}, 'admin'))

app.post('/admin/pegawai', (c) => authMiddleware(c, async () => {
    const { nama, nik, role, password } = await c.req.json()
    const id = generateId()
    const passHash = password ? await hashPassword(password) : null
    await c.env.DB.prepare('INSERT INTO pegawai (id, nama, nik, role, password_hash) VALUES (?, ?, ?, ?, ?)').bind(id, nama, nik, role || 'karyawan', passHash).run()
    return c.json({ success: true, message: 'Pegawai ditambahkan' })
}, 'admin'))

app.delete('/admin/pegawai/:id', (c) => authMiddleware(c, async () => {
    await c.env.DB.prepare('DELETE FROM pegawai WHERE id = ?').bind(c.req.param('id')).run()
    return c.json({ success: true, message: 'Pegawai dihapus' })
}, 'admin'))

// EXPORT UNTUK CLOUDFLARE PAGES
export const onRequest = (context) => {
  return app.fetch(context.request, context.env, context)
}
