const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET_HEX = process.env.TANGOHOP_SECRET || process.env.FROGMAN_SECRET;
const DB_PATH = process.env.TANGOHOP_DB || process.env.FROGMAN_DB || '/var/lib/frogman/scores.db';
const MS_PER_POINT = 5;

if (!SECRET_HEX || !/^[0-9a-fA-F]{64}$/.test(SECRET_HEX)) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'fatal', event: 'invalid_secret', msg: 'TANGOHOP_SECRET must be 64 hex chars (32 bytes)' }));
  process.exit(1);
}
const SECRET = Buffer.from(SECRET_HEX, 'hex');

const ALLOWED_ORIGINS = new Set(
  (process.env.TANGOHOP_CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

const log = (level, event, fields = {}) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }));
};

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    score INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip TEXT, ua TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_score ON scores(score DESC);
  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`);

const getTop10Stmt = db.prepare(`
  SELECT id, name, score, duration_ms AS durationMs, created_at AS createdAt
  FROM scores ORDER BY score DESC, created_at ASC LIMIT 10
`);
const getRankStmt = db.prepare(`
  SELECT COUNT(*) + 1 AS rank FROM scores
  WHERE score > ? OR (score = ? AND created_at < ?)
`);
const insertScoreStmt = db.prepare(`
  INSERT INTO scores (name, email, score, duration_ms, ip, ua, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertNonceStmt = db.prepare(`INSERT INTO nonces (nonce, created_at) VALUES (?, ?)`);
const checkNonceStmt = db.prepare(`SELECT 1 FROM nonces WHERE nonce = ?`);
const purgeNoncesStmt = db.prepare(`DELETE FROM nonces WHERE created_at < ?`);

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const r = purgeNoncesStmt.run(cutoff);
  if (r.changes > 0) log('info', 'nonce_purge', { count: r.changes });
}, 3600 * 1000).unref();

const top10 = () => getTop10Stmt.all();

const sseClients = new Set();
const broadcastTop10 = () => {
  const payload = JSON.stringify(top10());
  for (const res of sseClients) {
    try { res.write(`event: top10\ndata: ${payload}\n\n`); } catch {}
  }
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  res.setHeader('Vary', 'Origin');
  const allowed = origin && ALLOWED_ORIGINS.has(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(allowed ? 204 : 403);
  }
  next();
});
app.use(express.json({ limit: '4kb' }));

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;

const scoreLimiter = rateLimit({
  windowMs: 10_000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    log('warn', 'rate_limited', { ip: req.ip });
    res.status(429).json({ error: 'rate_limited' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/leaderboard', (req, res) => res.json(top10()));

app.get('/api/leaderboard/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`event: top10\ndata: ${JSON.stringify(top10())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

app.post('/api/score', scoreLimiter, (req, res) => {
  const { name, email, score, durationMs, nonce, signature } = req.body || {};
  const ip = req.ip;
  const ua = (req.get('user-agent') || '').slice(0, 256);
  const reject = (reason, status = 400) => {
    log('info', 'score_reject', { reason, ip, name: typeof name === 'string' ? name : null });
    return res.status(status).json({ error: reason });
  };

  if (typeof name !== 'string' || !NAME_RE.test(name)) return reject('bad_name');
  if (email !== undefined && email !== null && (typeof email !== 'string' || email.length > 120)) return reject('bad_email');
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000) return reject('bad_score');
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 7_200_000) return reject('bad_duration');
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) return reject('bad_nonce');
  if (typeof signature !== 'string' || !HEX64_RE.test(signature)) return reject('bad_signature');

  if (score > Math.floor(durationMs / MS_PER_POINT)) return reject('implausible_score');

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${name}|${score}|${durationMs}|${nonce}`)
    .digest();
  const sigBuf = Buffer.from(signature, 'hex');
  if (sigBuf.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expected)) {
    return reject('bad_signature');
  }

  if (checkNonceStmt.get(nonce)) return reject('replay');

  const now = Date.now();
  let insertId;
  const tx = db.transaction(() => {
    insertNonceStmt.run(nonce, now);
    insertId = insertScoreStmt.run(name, email || null, score, durationMs, ip, ua, now).lastInsertRowid;
  });
  tx();

  const { rank } = getRankStmt.get(score, score, now);
  const list = top10();
  log('info', 'score_accept', { name, score, durationMs, rank, ip });

  if (list.some(r => r.id === insertId)) broadcastTop10();

  res.json({ rank, top10: list });
});

const LEADERBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TANGO HOP — Leaderboard</title>
<style>
:root { --green: #80c343; --bg: #0a0d0a; --fg: #e8f5d4; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); font-family: 'Courier New', monospace; min-height: 100vh; overflow: hidden; }
body { display: flex; flex-direction: column; padding: 4vh 6vw; }
.hero { display: flex; align-items: center; justify-content: center; gap: 3vw; margin-bottom: 1.5vh; }
.hero img.mascot { height: 14vh; width: auto; image-rendering: pixelated; image-rendering: crisp-edges; }
h1 { font-size: 10vh; color: var(--green); letter-spacing: 0.2em; text-shadow: 0 0 24px rgba(128,195,67,0.6); }
.sub { color: var(--green); opacity: 0.7; text-align: center; font-size: 2vh; margin-bottom: 5vh; letter-spacing: 0.4em; }
table { width: 100%; border-collapse: collapse; font-size: 5vh; }
th, td { padding: 1.2vh 1vw; }
th { color: var(--green); border-bottom: 2px solid var(--green); text-align: left; font-size: 2.4vh; letter-spacing: 0.3em; text-transform: uppercase; }
td.rank { width: 10%; color: var(--green); }
td.name { width: 60%; }
td.score { width: 30%; text-align: right; }
tbody tr { border-bottom: 1px solid rgba(128,195,67,0.18); }
tbody tr.flash { animation: flash 1.8s ease-out; }
@keyframes flash { 0% { background: rgba(128,195,67,0.45); } 100% { background: transparent; } }
.empty { text-align: center; padding: 8vh 0; opacity: 0.4; font-size: 3vh; }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; font-size: 1.8vh; letter-spacing: 0.3em; opacity: 0.6; padding-top: 2vh; }
.foot a.merch { color: #e02020; text-decoration: none; font-weight: 700; padding: 0.8vh 1.2vw; border: 2px solid #e02020; border-radius: 4px; letter-spacing: 0.2em; opacity: 1; }
.foot a.merch:hover { background: #e02020; color: #0a0d0a; }
.dot { display: inline-block; width: 0.8vh; height: 0.8vh; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); margin-right: 0.6vw; vertical-align: middle; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style></head><body>
<div class="hero">
  <img class="mascot" src="https://mwtcmi.github.io/tangohop/images/freepbx/tango8bit.png" alt="Tango — freePBX">
  <h1>TANGO HOP</h1>
</div>
<div class="sub"><span class="dot"></span>TOP 10 // LIVE</div>
<table>
<thead><tr><th>#</th><th>NAME</th><th style="text-align:right">SCORE</th></tr></thead>
<tbody id="rows"><tr><td colspan="3" class="empty">WAITING FOR PLAYERS...</td></tr></tbody>
</table>
<div class="foot">
  <span>FreePBX // Powered by Sangoma</span>
  <a class="merch" href="https://merch.sangoma.com" target="_blank" rel="noopener">merch.sangoma.com →</a>
</div>
<script>
const rows = document.getElementById('rows');
let seen = new Set();
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(top){
  if(!top||!top.length){rows.innerHTML='<tr><td colspan="3" class="empty">WAITING FOR PLAYERS...</td></tr>';seen=new Set();return;}
  rows.innerHTML = top.map((r,i)=>{
    const isNew = !seen.has(r.id);
    return '<tr class="'+(isNew?'flash':'')+'"><td class="rank">'+(i+1)+'</td><td class="name">'+esc(r.name)+'</td><td class="score">'+r.score.toLocaleString()+'</td></tr>';
  }).join('');
  seen = new Set(top.map(r=>r.id));
}
function connect(){
  const es = new EventSource('/api/leaderboard/sse');
  es.addEventListener('top10', e => { try { render(JSON.parse(e.data)); } catch(err){} });
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
connect();
</script>
</body></html>`;

app.get('/leaderboard', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(LEADERBOARD_HTML);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'listen', { port: PORT });
});

const shutdown = (sig) => {
  log('info', 'shutdown', { signal: sig });
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
