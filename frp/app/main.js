/**
 * FutureRP Fisher — FiveM fishing macro (Electron main process)
 *  • Key-systeem   : server controleert key + apparaat (1 key = 1 pc), zie config.json -> serverUrl
 *  • Groene balk   : scant een gebied midden op het scherm; zodra groen verschijnt -> direct trekken
 *  • Input         : één persistente PowerShell-worker (snel, geen native deps)
 *  • Hotkeys       : F6 start/stop, F7 noodstop
 */
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, dialog } = require('electron')
const WebSocket = require('ws')
const { autoUpdater } = require('electron-updater')
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto')
const { spawn } = require('child_process')

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const CFG = readJson(path.join(__dirname, 'config.json'), {})
const DEF = { holdS: 4, releaseS: 2, pulls: 6, timeoutS: 40, regionW: 30, regionH: 8, regionY: 50, minPixels: 80, rodSlot: 1, baitSlot: 2 }

let win, running = false, testing = false, licensed = false
let S = { ...DEF }, saved = { key: '', settings: {} }
const storeFile = () => path.join(app.getPath('userData'), 'autofish.json')
const persist = () => { try { fs.writeFileSync(storeFile(), JSON.stringify(saved)) } catch {} }
const emit = (c, d) => { if (win && !win.isDestroyed()) win.webContents.send(c, d) }
const log = (m) => { console.log('[AutoFish]', m); emit('log', m) }
const nap = (ms) => new Promise(r => setTimeout(r, ms))
async function wait(ms) { const end = Date.now() + ms; while (running && Date.now() < end) await nap(Math.max(1, Math.min(50, end - Date.now()))) }

// ─── Key-systeem: server controleert key + 1 apparaat per key ─────────────────
const SERVER = (CFG.serverUrl || 'http://localhost:3000').replace(/\/$/, '')
let HWID = ''
async function getHwid() {
  if (HWID) return HWID
  const raw = await new Promise(r => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { windowsHide: true }, (e, o) => r(e ? '' : String(o).trim())))
  HWID = crypto.createHash('sha256').update(raw + '|' + os.hostname() + '|' + os.cpus()[0].model).digest('hex')
  return HWID
}
const api = async (p, body, tok) => {
  try {
    const r = await fetch(SERVER + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-token': tok || '' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) })
    return await r.json()
  } catch { return { ok: false, offline: true, msg: 'Server niet bereikbaar' } }
}
async function checkKey(key) {
  const r = await api('/api/activate', { key: String(key).trim().toUpperCase(), hwid: await getHwid() })
  return { ...r, online: !r.offline }
}

// ─── PowerShell worker: toetsen, muis, schermscan ────────────────────────────
const PS = `
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Windows.Forms;
public class W {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, int f, int e);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  public static void Ev(byte sc, int f) { keybd_event(0, sc, f, 0); }
  public static void Click(int px, int py) { Rectangle b = Screen.PrimaryScreen.Bounds; SetCursorPos(b.X + b.Width * px / 1000, b.Y + b.Height * py / 1000); System.Threading.Thread.Sleep(40); mouse_event(2, 0, 0, 0, 0); System.Threading.Thread.Sleep(50); mouse_event(4, 0, 0, 0, 0); }
  public static void Init() { SetProcessDPIAware(); }
  public static void Mouse(bool down) { mouse_event(down ? 2 : 4, 0, 0, 0, 0); }
  public static void Key(byte sc) { keybd_event(0, sc, 8, 0); System.Threading.Thread.Sleep(70); keybd_event(0, sc, 10, 0); }
  public static int Scan(int rw, int rh, int cy) {
    Rectangle b = Screen.PrimaryScreen.Bounds;
    int w = Math.Max(4, b.Width * rw / 100), h = Math.Max(2, b.Height * rh / 100);
    int x = b.X + (b.Width - w) / 2, y = b.Y + b.Height * cy / 100 - h / 2;
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      byte[] px = new byte[d.Stride * h]; Marshal.Copy(d.Scan0, px, 0, px.Length); bmp.UnlockBits(d);
      int n = 0;
      for (int i = 0; i + 3 < px.Length; i += 4) { int B = px[i], G = px[i + 1], R = px[i + 2]; if (G > 140 && G > R + 60 && G > B + 60) n++; }
      return n;
    }
  }
}
"@
[W]::Init()
[Console]::Out.WriteLine('R'); [Console]::Out.Flush()
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' ')
  switch ($p[0]) {
    'D' { [W]::Mouse($true) }
    'U' { [W]::Mouse($false) }
    'E' { [W]::Ev([byte]$p[2], [int]$p[1]) }
    'C' { [W]::Click([int]$p[1], [int]$p[2]) }
    'K' { [W]::Key([byte]$p[1]) }
    'S' { [Console]::Out.WriteLine('S ' + [W]::Scan([int]$p[1], [int]$p[2], [int]$p[3])); [Console]::Out.Flush() }
  }
}
`
let worker = null, ready = null, pending = null
function ensureWorker() {
  if (ready) return ready
  ready = new Promise((res, rej) => {
    const f = path.join(os.tmpdir(), 'autofish-worker.ps1')
    fs.writeFileSync(f, PS)
    worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true })
    let buf = ''
    worker.stdout.on('data', (d) => {
      buf += d; let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (l === 'R') res()
        else if (l.startsWith('S ') && pending) { const p = pending; pending = null; p(+l.slice(2)) }
      }
    })
    worker.on('error', rej)
    worker.on('exit', () => { worker = null; ready = null })
  })
  return ready
}
const send = (c) => { if (worker) worker.stdin.write(c + '\n') }
const scan = () => new Promise(r => {
  pending = r; send(`S ${S.regionW} ${S.regionH} ${S.regionY}`)
  setTimeout(() => { if (pending === r) { pending = null; r(0) } }, 2500)
})
const key = (sc) => send('K ' + sc)           // scancode: 1 = 0x02, 2 = 0x03
const click = async () => { send('D'); await nap(80); send('U') }

// ─── Visserslogica ───────────────────────────────────────────────────────────
async function cycle() {
  log('Aas op de haak (' + S.baitSlot + ')');   key(1 + S.baitSlot); await wait(600)
  log('Hengel pakken (' + S.rodSlot + ')');    key(1 + S.rodSlot); await wait(800)
  log('Uitwerpen');            await click(); await wait(500)
  if (!running) return

  log('Wachten op groene balk…')
  const t0 = Date.now(); let hits = 0
  while (running && Date.now() - t0 < S.timeoutS * 1000) {
    const n = await scan(); emit('meter', n)
    if (n >= S.minPixels) { if (++hits >= 2) break } else hits = 0   // 2x na elkaar = geen vals alarm
    await nap(30)
  }
  if (!running) return
  if (hits < 2) { log('Geen balk gezien, opnieuw proberen'); return }

  log('Groene balk! Trekken…')
  for (let i = 1; i <= S.pulls && running; i++) {
    log(`Trek ${i}/${S.pulls}`); send('D'); await wait(S.holdS * 1000)
    send('U'); if (i < S.pulls) await wait(S.releaseS * 1000)
  }
  if (running) log('Vis gevangen ✔')
}
async function run() {
  try { await ensureWorker() } catch (e) { log('PowerShell fout: ' + e.message); running = false; emit('state', 'stopped'); return }
  emit('state', 'running'); log('Macro gestart')
  while (running) { await cycle(); await wait(300) }
  send('U'); emit('state', 'stopped'); log('Macro gestopt')
}
function start() {
  if (running || testing) return
  if (!licensed) { log('Geen geldige key'); emit('locked', ''); return }
  running = true; run()
}
function stop() { running = false; testing = false; send('U') }
async function test() {
  if (running || !licensed) return
  if (testing) { testing = false; return }
  try { await ensureWorker() } catch { return }
  testing = true; emit('state', 'testing')
  while (testing) { emit('meter', await scan()); await nap(80) }
  emit('meter', 0); emit('state', 'stopped')
}
const toggle = () => (running ? stop() : start())

// ─── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.handle('init', async () => {
  saved = readJson(storeFile(), saved); S = { ...DEF, ...saved.settings }
  let info = null
  if (saved.key) { const r = await checkKey(saved.key); licensed = r.ok; info = r.ok ? r : null }
  return { licensed, info, settings: S }
})
ipcMain.handle('activate', async (_e, k) => {
  const r = await checkKey(k)
  if (r.ok) { licensed = true; saved.key = String(k).trim().toUpperCase(); persist() }
  return r
})
ipcMain.on('set', (_e, s) => { S = { ...S, ...s }; saved.settings = S; persist() })
ipcMain.on('start', start); ipcMain.on('stop', stop); ipcMain.on('test', test)
ipcMain.on('win', (_e, a) => { if (!win) return; a === 'min' ? win.minimize() : win.close() })

// Key opnieuw controleren (ingetrokken key stopt de macro) — alleen als online
setInterval(async () => {
  if (!licensed || !saved.key) return
  const r = await checkKey(saved.key)
  if (!r.ok && r.online) { licensed = false; stop(); emit('locked', r.msg) }
}, 15 * 60 * 1000)

// ─── Afstandsbediening: alleen je EIGEN pc, uit tot jij het aanzet, koppelcode ─
const SC = {}
'1234567890'.split('').forEach((c, i) => SC[c] = [2 + i, 0])
;[['qwertyuiop', 0x10], ['asdfghjkl', 0x1E], ['zxcvbnm', 0x2C]].forEach(([r, b]) => r.split('').forEach((c, i) => SC[c] = [b + i, 0]))
for (let i = 1; i <= 10; i++) SC['f' + i] = [0x3A + i, 0]
Object.assign(SC, { f11: [0x57, 0], f12: [0x58, 0], enter: [0x1C, 0], escape: [1, 0], esc: [1, 0], space: [0x39, 0], ' ': [0x39, 0], tab: [0x0F, 0], backspace: [0x0E, 0], shift: [0x2A, 0], ctrl: [0x1D, 0], up: [0x48, 1], left: [0x4B, 1], right: [0x4D, 1], down: [0x50, 1] })
const ev = (n, up) => { const e = SC[String(n).toLowerCase()]; if (e) send(`E ${(up ? 10 : 8) | e[1]} ${e[0]}`) }
const tap = async (n) => { ev(n); await nap(60); ev(n, true); await nap(40) }
const typeText = async (t) => { for (const c of String(t).slice(0, 60)) await tap(c) }
let held = {}, rws = null, rtimer = null
function joy(x, y) {
  const want = { w: y < -.35, s: y > .35, a: x < -.35, d: x > .35 }
  for (const k in want) if (!!held[k] !== want[k]) { ev(k, !want[k]); held[k] = want[k] }
}
async function remoteMsg(m) {
  if (m.t === 'key') await tap(m.k)
  else if (m.t === 'text') await typeText(m.s)
  else if (m.t === 'click') send(`C ${Math.round(m.x * 1000)} ${Math.round(m.y * 1000)}`)
  else if (m.t === 'joy') joy(+m.x || 0, +m.y || 0)
  else if (m.t === 'macro' && m.n === 'quit') { await tap('f8'); await nap(500); await typeText('quit'); await nap(150); await tap('enter') }
}
async function frame() {
  if (!rws || rws.readyState !== 1) return
  const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 960, height: 540 } })
  if (s[0]) rws.send(s[0].thumbnail.toJPEG(45))
}
async function startRemote() {
  if (!licensed) return { on: false }
  await ensureWorker()
  const code = String(crypto.randomInt(100000, 1000000))
  rws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws')
  rws.on('open', async () => rws.send(JSON.stringify({ role: 'host', code, key: saved.key, hwid: await getHwid() })))
  rws.on('message', (d, bin) => {
    if (bin) return
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.t === 'viewer') { clearInterval(rtimer); if (m.on) rtimer = setInterval(frame, 250); else joy(0, 0); emit('remote', { on: true, code, viewer: m.on }) }
    else remoteMsg(m)
  })
  rws.on('close', () => { clearInterval(rtimer); joy(0, 0); rws = null; emit('remote', { on: false }) })
  emit('remote', { on: true, code, viewer: false }); return { on: true, code }
}
ipcMain.handle('remote', async () => (rws ? (rws.close(), { on: false }) : startRemote()))

// ─── Admin (wachtwoord wordt op de SERVER gecontroleerd, niet in de app) ──────
let adminTok = ''
ipcMain.handle('adminLogin', async (_e, pw) => { const r = await api('/api/admin/login', { password: pw }); if (r.ok) adminTok = r.token; return { ok: !!r.ok, msg: r.msg } })
ipcMain.handle('admin', (_e, p, body) => api(p, body, adminTok))

// ─── Automatische updates via GitHub Releases ────────────────────────────────
function configureAutoUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (i) => log(`Update ${i.version} gevonden, downloaden…`))
  autoUpdater.on('error', (e) => log('Update-check mislukt: ' + e.message))
  autoUpdater.on('update-downloaded', async (i) => {
    const r = await dialog.showMessageBox(win, { type: 'info', title: 'Update klaar', message: `FutureRP Fisher ${i.version} is klaar om te installeren.`, detail: 'Herstart nu, of de update wordt geïnstalleerd zodra je de app sluit.', buttons: ['Nu herstarten', 'Later'], defaultId: 0, cancelId: 1 })
    if (r.response === 0) autoUpdater.quitAndInstall()
  })
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000)
}

// ─── Venster & lifecycle ─────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 780, resizable: false, frame: false, backgroundColor: '#0b1220',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'src', 'index.html'))
  win.on('closed', () => { stop(); win = null })
}
app.whenReady().then(() => {
  createWindow()
  configureAutoUpdates()
  globalShortcut.register('F6', toggle)
  globalShortcut.register('F7', () => { log('F7 noodstop'); stop() })
})
app.on('window-all-closed', () => { globalShortcut.unregisterAll(); stop(); if (rws) rws.close(); if (worker) worker.kill(); app.quit() })
