// ============================================================
// app.js - Logika Klien Absensi Perja
// Fitur: WebAuthn, Face Detection, GPS, Image Compression,
//        Role-based UI (Admin & Karyawan)
// ============================================================

const API_BASE = ''  // Sama-origin karena semua di Cloudflare Workers

// ============================================================
// STATE APLIKASI
// ============================================================
const state = {
  token: null,
  user: null,
  stream: null,           // MediaStream kamera
  fotoBlob: null,         // Foto yang sudah diambil & dikompresi
  lokasi: null,           // { latitude, longitude, nama }
  wajahTerdeteksi: false,
  faceApiLoaded: false,
  currentChallenge: null,
}

// ============================================================
// UTILITAS UI
// ============================================================
function tampilkanLoading(teks = 'Memproses...') {
  document.getElementById('loading').classList.remove('hidden')
  document.getElementById('loading-teks').textContent = teks
}
function sembunyikanLoading() {
  document.getElementById('loading').classList.add('hidden')
}

let toastTimer = null
function tampilkanToast(pesan, tipe = 'info') {
  if (toastTimer) clearTimeout(toastTimer)
  const toast = document.getElementById('toast')
  const inner = document.getElementById('toast-inner')
  const warna = {
    success: 'bg-green-700 text-green-100',
    error:   'bg-red-700 text-red-100',
    warn:    'bg-yellow-700 text-yellow-100',
    info:    'bg-slate-700 text-slate-100',
  }[tipe] || 'bg-slate-700 text-slate-100'
  inner.className = `rounded-2xl px-4 py-3 shadow-2xl text-sm font-medium text-center flex items-center gap-2 justify-center ${warna}`
  inner.textContent = pesan
  toast.classList.remove('hidden')
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500)
}

function tampilkanHalaman(id) {
  document.getElementById('page-login').classList.add('hidden')
  document.getElementById('page-karyawan').classList.add('hidden')
  document.getElementById('page-admin').classList.add('hidden')
  document.getElementById(id).classList.remove('hidden')
}

// ============================================================
// JAM REALTIME
// ============================================================
function mulaiJam() {
  function update() {
    const now = new Date()
    const jam = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })
    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jakarta' })
    const elJam = document.getElementById('jam-realtime')
    const elTgl = document.getElementById('tanggal-realtime')
    const elJamAdmin = document.getElementById('jam-admin')
    const elTglAdmin = document.getElementById('admin-tanggal')
    if (elJam) elJam.textContent = jam
    if (elTgl) elTgl.textContent = tgl
    if (elJamAdmin) elJamAdmin.textContent = jam
    if (elTglAdmin) elTglAdmin.textContent = tgl
  }
  update()
  setInterval(update, 1000)
}

// ============================================================
// TOKEN & SESSION
// ============================================================
function simpanSession(token, user) {
  state.token = token
  state.user = user
  localStorage.setItem('absensi_token', token)
  localStorage.setItem('absensi_user', JSON.stringify(user))
}
function muatSession() {
  const token = localStorage.getItem('absensi_token')
  const userStr = localStorage.getItem('absensi_user')
  if (token && userStr) {
    state.token = token
    state.user = JSON.parse(userStr)
    return true
  }
  return false
}
function hapusSession() {
  state.token = null
  state.user = null
  localStorage.removeItem('absensi_token')
  localStorage.removeItem('absensi_user')
}

// ============================================================
// NAVIGASI BERDASARKAN ROLE
// ============================================================
function navigasiKeDashboard() {
  if (!state.user) return
  if (state.user.role === 'admin') {
    tampilkanHalaman('page-admin')
    document.getElementById('admin-nama').textContent = state.user.nama
    document.getElementById('admin-avatar').textContent = state.user.nama.charAt(0).toUpperCase()
    app.muatDataAdmin()
    app.muatDaftarPegawai()
  } else {
    tampilkanHalaman('page-karyawan')
    document.getElementById('karyawan-nama').textContent = state.user.nama
    document.getElementById('karyawan-avatar').textContent = state.user.nama.charAt(0).toUpperCase()
    app.muatRiwayatSaya()
    app.inisialisasiFaceApi()
  }
  mulaiJam()
}

// ============================================================
// API HELPER
// ============================================================
async function apiCall(path, method = 'GET', body = null, isFormData = false) {
  const headers = { Authorization: `Bearer ${state.token}` }
  if (body && !isFormData) headers['Content-Type'] = 'application/json'
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined)
  })
  return res.json()
}

// ============================================================
// WEBAUTHN - LOGIN BIOMETRIK
// ============================================================
async function loginBiometrik() {
// ... (tetap ada)
}

// ============================================================
// LOGIN TRADISIONAL (NIK + PASSWORD)
// ============================================================
async function loginTradisional() {
  const nik = document.getElementById('login-nik').value.trim()
  const password = document.getElementById('login-password').value.trim()

  if (!nik || !password) { tampilkanToast('NIK dan Password wajib diisi', 'warn'); return }

  tampilkanLoading('Sedang masuk...')
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nik, password })
    })
    const hasil = await res.json()
    if (hasil.error) { tampilkanToast(hasil.error, 'error'); return }

    simpanSession(hasil.token, hasil.user)
    tampilkanToast(`Selamat datang, ${hasil.user.nama}! 👋`, 'success')
    navigasiKeDashboard()
  } catch (err) {
    tampilkanToast('Error: ' + err.message, 'error')
  } finally {
    sembunyikanLoading()
  }
}

// ============================================================
// FACE-API.JS - DETEKSI WAJAH
// ============================================================
async function inisialisasiFaceApi() {
  const statusEl = document.getElementById('status-wajah')
  try {
    statusEl.textContent = 'Memuat model deteksi wajah...'
    // Model Tiny FaceDetector yang ringan (~190KB)
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights'
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL)
    state.faceApiLoaded = true
    statusEl.textContent = 'Model siap. Tekan "Buka Kamera" untuk memulai.'
  } catch (err) {
    console.warn('Face-api gagal dimuat, mode tanpa deteksi wajah:', err)
    state.wajahTerdeteksi = true // Lewati deteksi jika gagal load
    statusEl.textContent = 'Kamera siap (tanpa deteksi wajah).'
  }
}

async function mulaiKamera() {
  try {
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()) }
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    })
    const video = document.getElementById('video-kamera')
    video.srcObject = state.stream
    document.getElementById('status-wajah').textContent = 'Posisikan wajah di depan kamera...'
    video.addEventListener('playing', () => deteksiWajahLoop(), { once: true })
  } catch (err) {
    tampilkanToast('Tidak bisa mengakses kamera: ' + err.message, 'error')
  }
}

async function deteksiWajahLoop() {
  const video = document.getElementById('video-kamera')
  const overlay = document.getElementById('face-overlay')
  const statusEl = document.getElementById('status-wajah')
  const ctx = overlay.getContext('2d')

  if (!state.faceApiLoaded) {
    state.wajahTerdeteksi = true
    statusEl.textContent = '✅ Kamera aktif. Silakan ambil foto.'
    document.getElementById('btn-ambil-foto').disabled = false
    return
  }

  async function loop() {
    if (!video.srcObject) return
    overlay.width = video.videoWidth
    overlay.height = video.videoHeight
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    const deteksi = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5 }))

    if (deteksi.length > 0) {
      const d = deteksi[0].box
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 3
      ctx.strokeRect(d.x, d.y, d.width, d.height)
      // Label
      ctx.fillStyle = 'rgba(34,197,94,0.7)'
      ctx.fillRect(d.x, d.y - 22, 90, 20)
      ctx.fillStyle = 'white'
      ctx.font = '12px Inter'
      ctx.fillText('Wajah Terdeteksi', d.x + 4, d.y - 7)

      if (!state.wajahTerdeteksi) {
        state.wajahTerdeteksi = true
        statusEl.textContent = '✅ Wajah terdeteksi! Silakan ambil foto.'
        document.getElementById('btn-ambil-foto').disabled = false
      }
    } else {
      state.wajahTerdeteksi = false
      document.getElementById('btn-ambil-foto').disabled = true
      statusEl.textContent = '⚠️ Wajah tidak terdeteksi. Posisikan ulang...'
    }
    requestAnimationFrame(loop)
  }
  loop()
}

// ============================================================
// AMBIL FOTO DAN KOMPRESI (Maks 100KB)
// ============================================================
async function ambilFoto() {
  if (!state.wajahTerdeteksi) { tampilkanToast('Pastikan wajah terdeteksi dulu', 'warn'); return }
  const video = document.getElementById('video-kamera')
  const canvas = document.getElementById('canvas-preview')
  const ctx = canvas.getContext('2d')

  canvas.width = video.videoWidth || 640
  canvas.height = video.videoHeight || 480
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  canvas.classList.remove('hidden')

  // Kompresi iteratif sampai < 100KB
  let quality = 0.85
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  while (blob.size > 100 * 1024 && quality > 0.2) {
    quality -= 0.1
    // Perkecil ukuran jika perlu
    if (quality < 0.5) {
      const scale = Math.sqrt((100 * 1024) / blob.size)
      const newW = Math.floor(canvas.width * scale)
      const newH = Math.floor(canvas.height * scale)
      const tmpCanvas = document.createElement('canvas')
      tmpCanvas.width = newW; tmpCanvas.height = newH
      tmpCanvas.getContext('2d').drawImage(canvas, 0, 0, newW, newH)
      blob = await canvasToBlob(tmpCanvas, 'image/jpeg', quality)
    } else {
      blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    }
  }

  state.fotoBlob = blob
  const ukuranKB = (blob.size / 1024).toFixed(1)
  document.getElementById('status-wajah').textContent = `✅ Foto diambil! Ukuran: ${ukuranKB} KB`
  tampilkanToast(`Foto berhasil diambil (${ukuranKB} KB)`, 'success')

  // Hentikan kamera untuk hemat baterai
  if (state.stream) state.stream.getTracks().forEach(t => t.stop())
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

// ============================================================
// AMBIL LOKASI GPS
// ============================================================
async function ambilLokasi() {
  const el = document.getElementById('lokasi-teks')
  el.textContent = 'Mengambil lokasi...'
  if (!navigator.geolocation) { tampilkanToast('GPS tidak didukung browser ini', 'error'); return }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.lokasi = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }
      const { latitude: lat, longitude: lng } = state.lokasi
      el.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`
      tampilkanToast('Lokasi berhasil diambil ✅', 'success')

      // Coba reverse geocode (opsional)
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=id`)
        const data = await res.json()
        state.lokasi.nama = data.display_name?.split(',').slice(0,3).join(',') || ''
        el.textContent = state.lokasi.nama || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
      } catch { /* Tidak masalah jika gagal */ }
    },
    (err) => {
      el.textContent = 'Gagal ambil lokasi'
      tampilkanToast('Izin GPS ditolak atau error: ' + err.message, 'error')
    },
    { enableHighAccuracy: true, timeout: 10000 }
  )
}

// ============================================================
// KIRIM ABSENSI (Karyawan)
// ============================================================
async function kirimAbsensi(tipe) {
  if (!state.fotoBlob) { tampilkanToast('Ambil foto wajah terlebih dahulu!', 'warn'); return }
  if (!state.lokasi) { tampilkanToast('Ambil lokasi GPS terlebih dahulu!', 'warn'); return }

  tampilkanLoading(`Mengirim absensi ${tipe}...`)
  try {
    const form = new FormData()
    form.append('foto', state.fotoBlob, `absen_${Date.now()}.jpg`)
    form.append('tipe', tipe)
    form.append('latitude', String(state.lokasi.latitude))
    form.append('longitude', String(state.lokasi.longitude))
    form.append('lokasi_nama', state.lokasi.nama || '')

    const res = await fetch('/api/absensi', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: form
    })
    const data = await res.json()
    if (data.error) { tampilkanToast(data.error, 'error'); return }

    const ikon = tipe === 'masuk' ? '🟢' : '🔴'
    tampilkanToast(`${ikon} Absen ${tipe} berhasil! Status: ${data.data.status}`, 'success')
    state.fotoBlob = null
    state.lokasi = null
    document.getElementById('canvas-preview').classList.add('hidden')
    document.getElementById('lokasi-teks').textContent = 'Belum diambil'
    await muatRiwayatSaya()
  } catch (err) {
    tampilkanToast('Gagal mengirim absensi: ' + err.message, 'error')
  } finally {
    sembunyikanLoading()
  }
}

// ============================================================
// RIWAYAT ABSENSI SAYA (Karyawan)
// ============================================================
async function muatRiwayatSaya() {
  const container = document.getElementById('riwayat-saya')
  try {
    const data = await apiCall('/api/absensi/saya?limit=10')
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="text-slate-500 py-6">Belum ada riwayat absensi</p>'
      return
    }
    container.innerHTML = data.data.map(r => `
      <div class="flex items-center justify-between bg-slate-800/50 rounded-xl px-4 py-3 text-left">
        <div>
          <p class="font-medium text-sm text-white">${r.tipe === 'masuk' ? '🟢 Masuk' : '🔴 Pulang'}</p>
          <p class="text-xs text-slate-400 mt-0.5">${new Date(r.waktu).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</p>
          ${r.lokasi_nama ? `<p class="text-xs text-slate-500 truncate max-w-[180px]">${r.lokasi_nama}</p>` : ''}
        </div>
        <span class="px-2 py-1 text-xs rounded-full ${badgeStatus(r.status)}">${r.status}</span>
      </div>
    `).join('')
  } catch {
    container.innerHTML = '<p class="text-red-400">Gagal memuat riwayat</p>'
  }
}

function badgeStatus(s) {
  if (s === 'terlambat') return 'badge-terlambat'
  if (s === 'lembur') return 'badge-lembur'
  return 'badge-hadir'
}

// ============================================================
// ADMIN: TAB NAVIGATION
// ============================================================
function gotoTab(tab, btnEl) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'))
  document.querySelectorAll('.tab-btn').forEach(el => {
    el.classList.remove('active', 'bg-blue-500', 'text-white')
    el.classList.add('text-slate-400')
  })
  document.getElementById(`tab-${tab}`).classList.remove('hidden')
  btnEl.classList.add('active')
  btnEl.classList.remove('text-slate-400')
}

// ============================================================
// ADMIN: MUAT STATISTIK DASHBOARD
// ============================================================
async function muatDataAdmin() {
  try {
    const today = new Date().toISOString().substring(0,10)
    document.getElementById('filter-tanggal').value = today

    // Paralel: muat pegawai dan log hari ini
    const [pegawaiData, logData] = await Promise.all([
      apiCall('/api/admin/pegawai'),
      apiCall(`/api/admin/absensi?tanggal=${today}`)
    ])

    const karyawanList = (pegawaiData.data || []).filter(p => p.role === 'karyawan')
    const logHariIni = logData.data || []
    const hadirIds = new Set(logHariIni.filter(l => l.tipe === 'masuk').map(l => l.pegawai_id))
    const terlambatCount = logHariIni.filter(l => l.status === 'terlambat').length

    document.getElementById('stat-total').textContent = karyawanList.length
    document.getElementById('stat-hadir').textContent = hadirIds.size
    document.getElementById('stat-terlambat').textContent = terlambatCount
    document.getElementById('stat-belum').textContent = Math.max(0, karyawanList.length - hadirIds.size)
  } catch (err) {
    console.error('Gagal muat data admin:', err)
  }
}

// ============================================================
// ADMIN: LOG ABSENSI (Tabel)
// ============================================================
async function muatLogAbsensi() {
  const tanggal = document.getElementById('filter-tanggal').value || new Date().toISOString().substring(0,10)
  const container = document.getElementById('tabel-absensi')
  container.innerHTML = '<div class="text-center text-slate-400 py-8 animate-pulse">Memuat data...</div>'
  try {
    const data = await apiCall(`/api/admin/absensi?tanggal=${tanggal}`)
    if (!data.data || data.data.length === 0) {
      container.innerHTML = `<div class="text-center text-slate-500 py-8">Tidak ada data absensi untuk tanggal ${tanggal}</div>`
      return
    }
    container.innerHTML = data.data.map(r => `
      <div class="card rounded-xl px-4 py-3 flex items-start gap-3">
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-xs font-bold flex-shrink-0">
          ${r.nama?.charAt(0) || '?'}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <p class="font-semibold text-sm text-white">${r.nama}</p>
            <span class="text-xs text-slate-500">${r.nik}</span>
            ${r.departemen ? `<span class="text-xs text-slate-400">${r.departemen}</span>` : ''}
          </div>
          <div class="flex items-center gap-3 mt-1 flex-wrap">
            <span class="text-xs ${r.tipe === 'masuk' ? 'text-green-400' : 'text-orange-400'}">${r.tipe === 'masuk' ? '🟢 Masuk' : '🔴 Pulang'}</span>
            <span class="text-xs text-slate-400">${new Date(r.waktu).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}</span>
            <span class="px-1.5 py-0.5 text-xs rounded-full ${badgeStatus(r.status)}">${r.status}</span>
          </div>
          ${r.lokasi_nama ? `<p class="text-xs text-slate-500 mt-0.5 truncate">${r.lokasi_nama}</p>` : ''}
        </div>
        ${r.foto_url ? `<a href="${r.foto_url}" target="_blank" class="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">📷</a>` : ''}
      </div>
    `).join('')
  } catch (err) {
    container.innerHTML = `<div class="text-center text-red-400 py-8">Gagal memuat data: ${err.message}</div>`
  }
}

// ============================================================
// ADMIN: DAFTAR PEGAWAI
// ============================================================
async function muatDaftarPegawai() {
  const container = document.getElementById('daftar-pegawai')
  try {
    const data = await apiCall('/api/admin/pegawai')
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<div class="text-center text-slate-500 py-6">Belum ada pegawai</div>'
      return
    }
    container.innerHTML = data.data.map(p => `
      <div class="card rounded-xl px-4 py-3 flex items-center gap-3">
        <div class="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-sm ${p.role === 'admin' ? 'bg-gradient-to-br from-purple-500 to-violet-600' : 'bg-gradient-to-br from-blue-500 to-indigo-600'}">
          ${p.nama.charAt(0)}
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm text-white">${p.nama}</p>
          <p class="text-xs text-slate-400">NIK: ${p.nik} ${p.departemen ? '· ' + p.departemen : ''}</p>
        </div>
        <span class="px-2 py-1 text-xs rounded-full flex-shrink-0 ${p.role === 'admin' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'}">${p.role}</span>
        ${p.id !== 'admin-001' ? `<button onclick="app.hapusPegawai('${p.id}','${p.nama}')" class="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition flex-shrink-0">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>` : ''}
      </div>
    `).join('')
  } catch (err) {
    container.innerHTML = `<div class="text-center text-red-400 py-6">Gagal memuat pegawai</div>`
  }
}

async function tambahPegawai() {
  const nama = document.getElementById('input-nama').value.trim()
  const nik = document.getElementById('input-nik').value.trim()
  const password = prompt('Masukkan Password awal untuk ' + nama + ':') || 'password123'
  const departemen = document.getElementById('input-departemen').value.trim()
  const role = document.getElementById('input-role').value

  if (!nama || !nik) { tampilkanToast('Nama dan NIK wajib diisi!', 'warn'); return }
  tampilkanLoading('Menyimpan pegawai...')
  try {
    const res = await apiCall('/api/admin/pegawai', 'POST', { nama, nik, password, role, departemen })
// ...
    if (res.error) { tampilkanToast(res.error, 'error'); return }
    tampilkanToast(`✅ ${res.message}`, 'success')
    document.getElementById('input-nama').value = ''
    document.getElementById('input-nik').value = ''
    document.getElementById('input-departemen').value = ''
    document.getElementById('input-email').value = ''
    await muatDaftarPegawai()
    await muatDataAdmin()
  } catch (err) {
    tampilkanToast('Gagal tambah pegawai: ' + err.message, 'error')
  } finally {
    sembunyikanLoading()
  }
}

async function hapusPegawai(id, nama) {
  if (!confirm(`Yakin hapus pegawai "${nama}"?\nSemua data absensi dan foto akan ikut terhapus!`)) return
  tampilkanLoading('Menghapus pegawai...')
  try {
    const res = await apiCall(`/api/admin/pegawai/${id}`, 'DELETE')
    if (res.error) { tampilkanToast(res.error, 'error'); return }
    tampilkanToast(`✅ ${res.message}`, 'success')
    await muatDaftarPegawai()
    await muatDataAdmin()
  } catch (err) {
    tampilkanToast('Gagal hapus: ' + err.message, 'error')
  } finally {
    sembunyikanLoading()
  }
}

// ============================================================
// ADMIN: LAPORAN
// ============================================================
async function muatLaporan() {
  const dari = document.getElementById('laporan-dari').value
  const sampai = document.getElementById('laporan-sampai').value
  if (!dari || !sampai) { tampilkanToast('Pilih rentang tanggal terlebih dahulu!', 'warn'); return }

  const container = document.getElementById('hasil-laporan')
  container.innerHTML = '<div class="text-center text-slate-400 py-8 animate-pulse">Memuat laporan...</div>'
  try {
    const data = await apiCall(`/api/admin/laporan?dari=${dari}&sampai=${sampai}`)
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<div class="text-center text-slate-500 py-8">Tidak ada data laporan</div>'
      return
    }
    container.innerHTML = `
      <div class="card rounded-xl overflow-hidden">
        <div class="grid grid-cols-5 gap-0 px-4 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-white/10">
          <div class="col-span-2">Nama</div><div class="text-center">Masuk</div><div class="text-center">Pulang</div><div class="text-center">Terlambat</div>
        </div>
        ${data.data.map(r => `
          <div class="grid grid-cols-5 gap-0 px-4 py-3 border-b border-white/5 hover:bg-white/5">
            <div class="col-span-2">
              <p class="text-sm font-medium text-white">${r.nama}</p>
              <p class="text-xs text-slate-400">${r.departemen || '-'}</p>
            </div>
            <div class="text-center text-sm text-green-400 font-semibold">${r.total_masuk || 0}</div>
            <div class="text-center text-sm text-orange-400 font-semibold">${r.total_pulang || 0}</div>
            <div class="text-center text-sm ${r.total_terlambat > 0 ? 'text-red-400' : 'text-slate-500'} font-semibold">${r.total_terlambat || 0}</div>
          </div>
        `).join('')}
      </div>
    `
  } catch (err) {
    container.innerHTML = `<div class="text-center text-red-400 py-8">Gagal memuat laporan</div>`
  }
}

// ============================================================
// ADMIN: EXPORT CSV
// ============================================================
async function exportCSV() {
  const tanggal = document.getElementById('filter-tanggal').value
  if (!tanggal) { tampilkanToast('Pilih tanggal dulu', 'warn'); return }
  try {
    const data = await apiCall(`/api/admin/absensi?tanggal=${tanggal}`)
    if (!data.data || data.data.length === 0) { tampilkanToast('Tidak ada data untuk diekspor', 'warn'); return }
    const header = 'Nama,NIK,Departemen,Tipe,Waktu,Status,Lokasi'
    const rows = data.data.map(r =>
      `"${r.nama}","${r.nik}","${r.departemen || ''}","${r.tipe}","${new Date(r.waktu).toLocaleString('id-ID')}","${r.status}","${r.lokasi_nama || ''}"`
    )
    const csvContent = [header, ...rows].join('\n')
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `absensi_${tanggal}.csv`; a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    tampilkanToast('Gagal export CSV', 'error')
  }
}

// ============================================================
// LOGOUT
// ============================================================
function logout() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop())
  hapusSession()
  tampilkanHalaman('page-login')
  tampilkanToast('Anda telah keluar', 'info')
}

// ============================================================
// INFO REGISTRASI (untuk karyawan yang belum terdaftar)
// ============================================================
function tampilkanRegistrasi() {
  tampilkanToast('Hubungi admin untuk mendaftarkan sidik jari Anda.', 'info')
}

// ============================================================
// HELPER: Base64 <-> Uint8Array (untuk WebAuthn)
// ============================================================
function _base64ToUint8Array(base64) {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}
function _uint8ArrayToBase64(uint8Array) {
  return btoa(String.fromCharCode(...uint8Array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ============================================================
// EKSPOR FUNGSI KE `app` NAMESPACE (dipanggil dari HTML onclick)
// ============================================================
const app = {
  loginBiometrik,
  tampilkanRegistrasi,
  logout,
  mulaiKamera,
  ambilFoto,
  ambilLokasi,
  kirimAbsensi,
  muatRiwayatSaya,
  inisialisasiFaceApi,
  // Admin
  gotoTab,
  muatDataAdmin,
  muatLogAbsensi,
  muatDaftarPegawai,
  tambahPegawai,
  hapusPegawai,
  muatLaporan,
  exportCSV,
}

// ============================================================
// INISIALISASI SAAT HALAMAN DIBUKA
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Atur tanggal default untuk filter laporan
  const today = new Date().toISOString().substring(0, 10)
  const elDari = document.getElementById('laporan-dari')
  const elSampai = document.getElementById('laporan-sampai')
  if (elDari) elDari.value = today
  if (elSampai) elSampai.value = today

  // Cek apakah ada session yang tersimpan
  if (muatSession()) {
    navigasiKeDashboard()
  } else {
    tampilkanHalaman('page-login')
  }
})
