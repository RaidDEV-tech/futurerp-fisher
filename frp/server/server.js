// FutureRP Fisher — server: keys (1 apparaat per key), admin API, remote-relay, website
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const { WebSocketServer } = require('ws')
const CFG = fs.existsSync(path.join(__dirname, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) : {}
CFG.port = process.env.PORT || CFG.port || 3000
CFG.adminPassword = process.env.ADMIN_PASSWORD || CFG.adminPassword
if (!CFG.adminPassword) { console.error('Zet ADMIN_PASSWORD als omgevingsvariabele'); process.exit(1) }
const DBF = process.env.DATA_FILE || path.join(__dirname, 'data.json')
let db = fs.existsSync(DBF) ? JSON.parse(fs.readFileSync(DBF, 'utf8')) : { keys: [] }
const save = () => fs.writeFileSync(DBF, JSON.stringify(db, null, 2))
const app = express(); app.set('trust proxy', 1); app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'website')))
app.get('/remote', (q, r) => r.sendFile(path.join(__dirname, 'remote.html')))

const find = (k) => db.keys.find(x => x.key === String(k || '').trim().toUpperCase())
function verify(key, hwid) {
  const e = find(key)
  if (!e) return { ok: false, msg: 'Ongeldige key' }
  if (e.banned) return { ok: false, msg: 'Deze key is geblokkeerd' }
  if (e.expires && Date.parse(e.expires) < Date.now()) return { ok: false, msg: 'Key is verlopen' }
  if (!hwid || String(hwid).length < 32) return { ok: false, msg: 'Ongeldig apparaat' }
  if (!e.hwid) { e.hwid = hwid; e.activated = new Date().toISOString(); save() }
  else if (e.hwid !== hwid) return { ok: false, msg: 'Key is al in gebruik op een ander apparaat' }
  return { ok: true, plan: e.plan, expires: e.expires }
}
app.post('/api/activate', (q, r) => r.json(verify(q.body.key, q.body.hwid)))

// ── Admin ──
const tokens = new Map(), fails = {}
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
app.post('/api/admin/login', (q, r) => {
  const ip = q.ip
  if ((fails[ip] || 0) >= 5) return r.status(429).json({ ok: false, msg: 'Te veel pogingen, probeer het later opnieuw' })
  if (!eq(q.body.password, CFG.adminPassword)) { fails[ip] = (fails[ip] || 0) + 1; setTimeout(() => delete fails[ip], 6e5); return r.status(401).json({ ok: false, msg: 'Fout wachtwoord' }) }
  const t = crypto.randomBytes(24).toString('hex'); tokens.set(t, Date.now() + 12 * 36e5); r.json({ ok: true, token: t })
})
const auth = (q, r, n) => (tokens.get(q.headers['x-token']) > Date.now() ? n() : r.status(401).json({ ok: false, msg: 'Niet ingelogd' }))
app.get('/api/admin/keys', auth, (q, r) => r.json(db.keys))
app.post('/api/admin/keys', auth, (q, r) => {
  const { count = 1, plan = 'lifetime', days = 0, note = '' } = q.body, out = []
  for (let i = 0; i < Math.min(+count || 1, 100); i++) {
    const key = [1, 2, 3, 4].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-')
    const e = { key, plan: String(plan).slice(0, 20), note: String(note).slice(0, 60), hwid: null, banned: false, created: new Date().toISOString(), expires: days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null }
    db.keys.push(e); out.push(e)
  }
  save(); r.json(out)
})
app.post('/api/admin/keys/:k/:act', auth, (q, r) => {
  const e = find(q.params.k); if (!e) return r.status(404).json({ ok: false })
  const a = q.params.act
  if (a === 'reset') e.hwid = null; else if (a === 'ban') e.banned = !e.banned; else if (a === 'delete') db.keys = db.keys.filter(x => x !== e)
  save(); r.json({ ok: true })
})

// ── Remote relay: PC (host) <-> telefoon (viewer), gekoppeld met 6-cijferige code ──
const server = http.createServer(app), wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4e6 })
const rooms = new Map(), tries = {}
wss.on('connection', (ws, req) => {
  let room = null, role = null
  ws.on('message', (d, bin) => {
    if (!room) {
      let m; try { m = JSON.parse(d) } catch { return ws.close() }
      if (m.role === 'host') {
        if (!verify(m.key, m.hwid).ok || !/^\d{6}$/.test(m.code)) return ws.close()
        room = { host: ws, viewer: null }; rooms.set(m.code, room); role = 'host'; ws.code = m.code
      } else if (m.role === 'viewer') {
        const ip = req.socket.remoteAddress; tries[ip] = (tries[ip] || 0) + 1; setTimeout(() => tries[ip]--, 6e4)
        const rm = tries[ip] <= 8 && rooms.get(String(m.code))
        if (!rm || rm.viewer) { ws.send(JSON.stringify({ t: 'err', msg: 'Code onbekend, pc offline of al verbonden' })); return ws.close() }
        room = rm; role = 'viewer'; rm.viewer = ws; rm.host.send(JSON.stringify({ t: 'viewer', on: true }))
      } else return ws.close()
      return ws.send(JSON.stringify({ t: 'ok' }))
    }
    const peer = role === 'host' ? room.viewer : room.host
    if (peer && peer.readyState === 1) peer.send(d, { binary: bin })
  })
  ws.on('close', () => {
    if (!room) return
    if (role === 'host') { if (room.viewer) room.viewer.close(); rooms.delete(ws.code) }
    else { room.viewer = null; if (room.host.readyState === 1) room.host.send(JSON.stringify({ t: 'viewer', on: false })) }
  })
})
server.listen(CFG.port, () => console.log('FutureRP Fisher server draait op http://localhost:' + CFG.port))
