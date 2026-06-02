const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET_HEX = process.env.TANGOHOP_SECRET || process.env.FROGMAN_SECRET;
const DB_PATH = process.env.TANGOHOP_DB || process.env.FROGMAN_DB || '/var/lib/frogman/scores.db';
// Rate cap: a player can't legitimately score faster than 200pt/sec sustained
// (row-progress rule bounds climb-rate; goal bursts are 1000 every few seconds).
// Combined with the row-progress client rule and HMAC, this is the only score
// ceiling — there's no absolute MAX_SCORE because the game now has infinite
// levels and a skilled player can keep climbing.
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

// Profanity matcher (obscenity is dual CJS/ESM; dynamic import works for both).
// Initialized before app.listen so all requests see a ready matcher.
let profanityMatcher = null;
async function initProfanityFilter() {
  const { RegExpMatcher, englishDataset, englishRecommendedTransformers } = await import('obscenity');
  profanityMatcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });
}

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
  CREATE INDEX IF NOT EXISTS idx_email ON scores(email);
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
const findByEmailStmt = db.prepare(`
  SELECT id, score, created_at AS createdAt FROM scores WHERE email = ?
`);
const updateScoreStmt = db.prepare(`
  UPDATE scores SET name = ?, score = ?, duration_ms = ?, ip = ?, ua = ?, created_at = ?
  WHERE id = ?
`);
const insertNonceStmt = db.prepare(`INSERT INTO nonces (nonce, created_at) VALUES (?, ?)`);
const checkNonceStmt = db.prepare(`SELECT 1 FROM nonces WHERE nonce = ?`);
const purgeNoncesStmt = db.prepare(`DELETE FROM nonces WHERE created_at < ?`);

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const r = purgeNoncesStmt.run(cutoff);
  if (r.changes > 0) log('info', 'nonce_purge', { count: r.changes });
}, 3600 * 1000).unref();

// PII retention: null out email/ip/ua on rows older than the retention window
// so a backup leak or stolen disk doesn't expose a forever-growing attendee
// list keyed to IPs. Scores + names stay (those are the leaderboard product).
const PII_RETENTION_MS = 30 * 24 * 3600 * 1000;
const piiPurgeStmt = db.prepare(`
  UPDATE scores SET email = NULL, ip = NULL, ua = NULL
  WHERE created_at < ?
    AND (email IS NOT NULL OR ip IS NOT NULL OR ua IS NOT NULL)
`);
const purgePII = () => {
  const cutoff = Date.now() - PII_RETENTION_MS;
  const r = piiPurgeStmt.run(cutoff);
  if (r.changes > 0) log('info', 'pii_purge', { count: r.changes, retentionDays: 30 });
};
purgePII();
setInterval(purgePII, 24 * 3600 * 1000).unref();

const top10 = () => getTop10Stmt.all();

// SSE client tracking with global + per-IP caps so one peer can't open
// thousands of EventSource connections and pin RAM / stall broadcasts.
const SSE_MAX_CLIENTS = 200;
const SSE_MAX_PER_IP = 3;
const sseClients = new Set();
const sseByIp = new Map();
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const ip = req.ip;
  const ipCount = sseByIp.get(ip) || 0;
  if (sseClients.size >= SSE_MAX_CLIENTS || ipCount >= SSE_MAX_PER_IP) {
    log('warn', 'sse_rejected', { ip, total: sseClients.size, perIp: ipCount });
    return res.status(503).json({ error: 'sse_capacity' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`event: top10\ndata: ${JSON.stringify(top10())}\n\n`);
  sseClients.add(res);
  sseByIp.set(ip, ipCount + 1);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25_000);
  const cleanup = () => {
    clearInterval(ping);
    if (sseClients.delete(res)) {
      const remaining = (sseByIp.get(ip) || 1) - 1;
      if (remaining <= 0) sseByIp.delete(ip);
      else sseByIp.set(ip, remaining);
    }
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
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
  if (typeof email !== 'string' || email.length > 120 || !EMAIL_RE.test(email.trim())) return reject('bad_email');
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000) return reject('bad_score');
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 7_200_000) return reject('bad_duration');
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) return reject('bad_nonce');
  if (typeof signature !== 'string' || !HEX64_RE.test(signature)) return reject('bad_signature');

  // Strip allowed-but-evasive separators ('_' and '-') before profanity check —
  // otherwise `f_u_c_k` and `sh-it` pass through. The original `name` is what
  // gets stored; we only normalize for the match.
  const nameForFilter = name.replace(/[_-]/g, '');
  if (profanityMatcher && profanityMatcher.hasMatch(nameForFilter)) {
    log('info', 'score_reject', { reason: 'profanity', ip, name });
    return res.status(400).json({
      error: 'profanity',
      message: "Nice try — no froggin' around. Let's keep it clean."
    });
  }

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

  // One row per email (case-insensitive, trimmed). New submission replaces the
  // existing row only if it beats the player's previous best; otherwise the
  // older/higher row stands and we return its rank.
  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();
  let insertId;
  let effectiveScore = score;
  let effectiveTime = now;
  let outcome = 'inserted';
  const tx = db.transaction(() => {
    insertNonceStmt.run(nonce, now);
    const existing = findByEmailStmt.get(normalizedEmail);
    if (existing) {
      if (score > existing.score) {
        updateScoreStmt.run(name, score, durationMs, ip, ua, now, existing.id);
        insertId = existing.id;
        outcome = 'updated';
      } else {
        insertId = existing.id;
        effectiveScore = existing.score;
        effectiveTime = existing.createdAt;
        outcome = 'kept_existing';
      }
    } else {
      insertId = insertScoreStmt.run(name, normalizedEmail, score, durationMs, ip, ua, now).lastInsertRowid;
    }
  });
  tx();

  const { rank } = getRankStmt.get(effectiveScore, effectiveScore, effectiveTime);
  const list = top10();
  log('info', 'score_accept', { name, score, durationMs, rank, ip, outcome, effectiveScore });

  if (list.some(r => r.id === insertId)) broadcastTop10();

  res.json({ rank, top10: list });
});

const LEADERBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TANGO HOP — Leaderboard</title>
<style>
@font-face {
  font-family: "Arcade Classic";
  src: url("https://mwtcmi.github.io/tangohop/fonts/arcadeclassic.woff") format("woff"),
       url("https://mwtcmi.github.io/tangohop/fonts/arcadeclassic.ttf") format("truetype");
  font-display: block;
}
:root {
  --bg: #0a0f1a;
  --panel: #11182a;
  --ink: #e7eefc;
  --muted: #8aa0c6;
  --freepbx: #80c343;
  --sangoma: #e02020;
  --accent: #00d1ff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; min-height: 100vh; overflow: hidden; }
body { display: flex; flex-direction: column; }
header.brand {
  display: flex; align-items: center; gap: 16px; padding: 18px 24px;
  background: linear-gradient(90deg, #0a0f1a 0%, #11182a 60%, #1a2647 100%);
  border-bottom: 2px solid var(--freepbx);
  box-shadow: 0 2px 12px rgba(0,0,0,0.5);
}
header.brand img.mascot {
  height: 96px; width: auto;
}
header.brand h1 {
  margin: 0;
  font: 700 32px/1 "Arcade Classic", system-ui, sans-serif;
  letter-spacing: 2px; color: var(--ink);
}
header.brand h1 .sub {
  display: block; margin-top: 8px;
  font: 500 13px/1 system-ui, sans-serif;
  letter-spacing: 2px; color: var(--muted); text-transform: uppercase;
}
header.brand .spacer { flex: 1; }
header.brand a.cta {
  font: 700 14px/1 "Arcade Classic", system-ui, sans-serif;
  letter-spacing: 2px; text-transform: uppercase;
  padding: 10px 16px; border-radius: 4px;
  text-decoration: none; margin-left: 10px;
  transition: background 0.15s, color 0.15s;
}
header.brand a.cta.play { color: var(--freepbx); border: 2px solid var(--freepbx); }
header.brand a.cta.play:hover { background: var(--freepbx); color: #0a2010; }
header.brand a.cta.merch { color: #0a2010; background: var(--sangoma); border: 2px solid var(--sangoma); }
header.brand a.cta.merch:hover { background: #b51717; border-color: #b51717; color: #fff; }
main { flex: 1; display: flex; flex-direction: column; padding: 4vh 6vw 2vh; }
.live { display: flex; align-items: center; justify-content: center; gap: 12px;
  margin-bottom: 3vh;
  color: var(--freepbx); font: 700 2vh/1 "Arcade Classic", ui-monospace, monospace;
  letter-spacing: 0.4em; }
.dot { display: inline-block; width: 1.2vh; height: 1.2vh; border-radius: 50%;
  background: var(--freepbx); box-shadow: 0 0 12px var(--freepbx);
  animation: pulse 1.5s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
table { width: 100%; border-collapse: collapse; font-size: 5vh; font-family: ui-monospace, Menlo, monospace; }
th, td { padding: 1.2vh 1.2vw; }
th { color: var(--accent); border-bottom: 2px solid var(--freepbx);
  text-align: left; font: 600 1.8vh/1 system-ui, sans-serif;
  letter-spacing: 0.3em; text-transform: uppercase; }
td.rank { width: 10%; color: var(--freepbx); }
td.name { width: 60%; color: var(--ink); }
td.score { width: 30%; text-align: right; color: var(--ink); }
tbody tr { border-bottom: 1px solid rgba(128,195,67,0.18); }
tbody tr.flash { animation: flash 1.8s ease-out; }
@keyframes flash { 0% { background: rgba(128,195,67,0.35); } 100% { background: transparent; } }
.empty { text-align: center; padding: 8vh 0; opacity: 0.4; font-size: 3vh; color: var(--muted); }
footer.brand { padding: 14px 24px; border-top: 1px solid #1a2342;
  text-align: center; font: 500 11px/1.4 system-ui, sans-serif;
  color: var(--muted); letter-spacing: 1px; }
footer.brand .sangoma { color: var(--sangoma); font-weight: 700; }
footer.brand a { color: var(--freepbx); text-decoration: none; }
footer.brand a:hover { text-decoration: underline; }
</style></head><body>
<header class="brand">
  <img class="mascot" src="https://mwtcmi.github.io/tangohop/images/freepbx/freepbx-logo.png" alt="FreePBX">
  <h1>
    TANGO HOP
    <span class="sub">Connect or Croak</span>
  </h1>
  <div class="spacer"></div>
  <a class="cta play" href="https://mwtcmi.github.io/tangohop/" target="_blank" rel="noopener">Play</a>
  <a class="cta merch" href="https://merch.sangoma.com/unisex-men-s-t-shirts" target="_blank" rel="noopener">Merch</a>
</header>
<main>
  <div class="live"><span class="dot"></span>TOP 10 // LIVE</div>
  <table>
    <thead><tr><th>#</th><th>Name</th><th style="text-align:right">Score</th></tr></thead>
    <tbody id="rows"><tr><td colspan="3" class="empty">WAITING FOR PLAYERS...</td></tr></tbody>
  </table>
</main>
<footer class="brand">
  Built on <a href="https://github.com/denodell/frogger" target="_blank" rel="noopener"><em>denodell/frogger</em></a> &nbsp;·&nbsp; <span class="sangoma">© Sangoma</span> · FreePBX is a registered trademark of Sangoma Technologies
</footer>
<script nonce="__CSP_NONCE__">
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

// Defense-in-depth on top of the in-page `esc()` escaper: per-request nonce CSP
// so even if a stored XSS slipped past escaping, the injected <script> couldn't
// run (no matching nonce) and any external exfil channel would be blocked.
const LEADERBOARD_CSP_BASE = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src https://mwtcmi.github.io",
  "font-src https://mwtcmi.github.io",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ');

app.get('/leaderboard', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${LEADERBOARD_CSP_BASE}; script-src 'nonce-${nonce}'`
  }).send(LEADERBOARD_HTML.replace('__CSP_NONCE__', nonce));
});

let server;
const shutdown = (sig) => {
  log('info', 'shutdown', { signal: sig });
  if (server) server.close(() => { db.close(); process.exit(0); });
  else { db.close(); process.exit(0); }
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initProfanityFilter().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    log('info', 'listen', { port: PORT });
  });
}).catch((err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'fatal', event: 'profanity_init_failed', msg: err && err.message }));
  process.exit(1);
});
