#!/usr/bin/env node
/**
 * server.js — Twin-boiler coal power plant simulator.
 *
 *   * Express static host for the 3D HMI in /public
 *   * WebSocket feed of the live plant snapshot
 *   * REST control / fault-injection API
 *   * Hidden /admin console: one-time registration, live visitor list with
 *     WAN IP + geolocation, and a GitHub-sourced update system.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const express = require('express');
const { WebSocketServer } = require('ws');

const { Plant } = require('./sim/engine.js');
const { FAULTS } = require('./sim/faults.js');
const { DESIGN } = require('./sim/constants.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// DATA_DIR lets the test harness run a throw-away instance (one-time admin
// registration) without touching the real installation's data directory.
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PKG = require('../package.json');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
const REPO_OWNER = 'mikeehendricks';
const REPO_NAME = 'TurbineCoalSimulator';

fs.mkdirSync(DATA, { recursive: true });

/* ================================================================== *
 *  Small helpers
 * ================================================================== */
const nowIso = () => new Date().toISOString();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/** Version of the running code, as reported by git when available. */
function localVersion() {
  let commit = null;
  let source = 'git';
  try {
    commit = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { commit = null; }
  // Installs made by install.sh have no .git, so the deployed build is recorded
  // in build.json by scripts/update.sh instead.
  if (!commit) {
    try {
      const stamp = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'build.json'), 'utf8'));
      if (stamp && stamp.commit) { commit = String(stamp.commit).slice(0, 7); source = 'build.json'; }
    } catch { /* no stamp either */ }
  }
  return {
    version: PKG.version,
    commit,
    source,
    name: PKG.name,
    description: PKG.description || '',
  };
}

/* ================================================================== *
 *  Plant + tick loop
 * ================================================================== */
const plant = new Plant();
const TICK_MS = 200;
let broadcastCount = 0;

function tick() {
  const dt = TICK_MS / 1000;
  try {
    plant.step(dt);
  } catch (err) {
    console.error('[sim] step error:', err && err.message);
  }
  broadcastCount++;
  // Full snapshot at 5 Hz is plenty for the HMI; the heavy catalogue goes once.
  const snap = broadcastCount % 10 === 1 ? plant.snapshot(true) : plant.snapshot(false);
  broadcast({ type: 'snapshot', data: snap });
}
setInterval(tick, TICK_MS).unref?.();

/* ================================================================== *
 *  Visitor tracking (for the admin console)
 * ================================================================== */
const visitors = new Map();       // id -> visitor record
const geoCache = new Map();       // ip -> geo record
let geoBusy = false;

// How many reverse-proxy hops to trust for the client address. 0 (the default)
// means never trust X-Forwarded-For, because any client can set it: a forged
// header used to put an invented "WAN IP" in the admin visitor list, complete
// with a geolocation lookup the attacker chose. Set TRUST_PROXY=1 when the app
// really does sit behind nginx/Apache on the same host.
const TRUST_PROXY = Math.max(0, Number(process.env.TRUST_PROXY || 0) | 0);

function clientIp(req) {
  if (TRUST_PROXY > 0) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      // Right-most entries are appended by our own proxies, so count back.
      const parts = String(fwd).split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - TRUST_PROXY)];
    }
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '';
}
function normaliseIp(ip) {
  if (!ip) return ip;
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('fc') || ip.startsWith('10.')
    || ip.startsWith('192.168.') || ip.match(/^172\.(1[6-9]|2\d|3[01])\./)) {
    return ip;   // private — will be marked as such by the geo lookup
  }
  return ip;
}
function isPrivate(ip) {
  return !ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('10.')
    || ip.startsWith('192.168.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.')
    || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip.startsWith('fc') || ip.startsWith('fd');
}

/** Free (no key) IP geolocation, cached to disk. */
async function geolocate(ip) {
  if (isPrivate(ip)) {
    return { ip, private: true, country: 'Private / LAN', city: 'Local network', region: '', isp: 'RFC1918', lat: null, lon: null };
  }
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query`,
      { signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json();
    const rec = {
      ip,
      private: false,
      country: j.country || 'Unknown',
      countryCode: j.countryCode || '',
      region: j.regionName || '',
      city: j.city || '',
      zip: j.zip || '',
      lat: j.lat ?? null,
      lon: j.lon ?? null,
      timezone: j.timezone || '',
      isp: j.isp || j.org || '',
      org: j.org || '',
      as: j.as || '',
      source: 'ip-api.com',
    };
    geoCache.set(ip, rec);
    return rec;
  } catch {
    return { ip, private: false, country: 'Unknown', city: '', region: '', isp: '', lat: null, lon: null };
  }
}

function trackVisitor(info) {
  const id = info.id;
  const prev = visitors.get(id);
  const rec = {
    id,
    ip: info.ip,
    userAgent: info.userAgent || '',
    page: info.page || '/',
    firstSeen: prev ? prev.firstSeen : nowIso(),
    lastSeen: nowIso(),
    requests: (prev ? prev.requests : 0) + 1,
    connected: true,
    geo: prev && prev.geo && prev.geo.ip === info.ip ? prev.geo : null,
    session: info.session || null,
  };
  visitors.set(id, rec);
  if (!rec.geo && !geoBusy) {
    geoBusy = true;
    geolocate(info.ip).then((g) => {
      const r = visitors.get(id);
      if (r) { r.geo = g; visitors.set(id, r); }
      geoBusy = false;
    }).catch(() => { geoBusy = false; });
  }
  return rec;
}

// Expire visitors that have not been seen for 5 minutes.
setInterval(() => {
  const cut = Date.now() - 5 * 60 * 1000;
  for (const [id, v] of visitors) {
    if (Date.parse(v.lastSeen) < cut) visitors.delete(id);
  }
}, 30000).unref?.();

/* ================================================================== *
 *  Admin accounts (one-time registration)
 * ================================================================== */
const ADMIN_FILE = path.join(DATA, 'admin.json');
let adminState = readJson(ADMIN_FILE, { registered: false, user: null, sessions: {} });

function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), s, 64).toString('hex');
  return { salt: s, hash: h };
}
function verifyPassword(pw, rec) {
  const h = crypto.scryptSync(String(pw), rec.salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(rec.hash, 'hex')); }
  catch { return false; }
}
function saveAdmin() { writeJson(ADMIN_FILE, adminState); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function adminFromToken(tok) {
  if (!tok) return null;
  const s = adminState.sessions[tok];
  if (!s) return null;
  if (Date.parse(s.expires) < Date.now()) { delete adminState.sessions[tok]; saveAdmin(); return null; }
  return s;
}
function cookieToken(req) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map(x => x.trim()).find(x => x.startsWith('admin_session='));
  return m ? decodeURIComponent(m.split('=')[1]) : null;
}

/* ================================================================== *
 *  Update system — source of truth is the GitHub repository
 * ================================================================== */
let updateCache = { checkedAt: null, available: false, remote: null, local: localVersion(), error: null };
let updateJob = null;      // { id, status, log, started, finished }

async function checkForUpdate(force = false) {
  if (updateJob && updateJob.status === 'running') return updateCache;
  if (!force && updateCache.checkedAt && Date.now() - Date.parse(updateCache.checkedAt) < 60_000) return updateCache;
  const local = localVersion();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const headers = { 'User-Agent': 'TurbineCoalSimulator', Accept: 'application/vnd.github+json' };
    const branch = process.env.GIT_BRANCH || 'main';
    const [cRes, tRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${branch}`, { headers, signal: ctl.signal }),
      fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tags?per_page=1`, { headers, signal: ctl.signal }),
    ]);
    clearTimeout(t);
    if (!cRes.ok) throw new Error(`GitHub API ${cRes.status}`);
    const cJson = await cRes.json();
    let tag = null;
    if (tRes.ok) { const tj = await tRes.json(); if (Array.isArray(tj) && tj.length) tag = tj[0].name; }
    const remote = {
      sha: (cJson.sha || '').slice(0, 12),
      shortSha: (cJson.sha || '').slice(0, 7),
      message: (cJson.commit && cJson.commit.message || '').split('\n')[0],
      author: cJson.commit && cJson.commit.author && cJson.commit.author.name,
      date: cJson.commit && cJson.commit.author && cJson.commit.author.date,
      url: cJson.html_url,
      tag: tag,
      branch,
    };
    const available = !!(remote.sha && local.commit && !remote.sha.startsWith(local.commit))
      || !!(tag && tag !== `v${local.version}`);
    updateCache = { checkedAt: nowIso(), available, remote, local, error: null, repo: `https://github.com/${REPO_OWNER}/${REPO_NAME}` };
  } catch (err) {
    updateCache = { ...updateCache, checkedAt: nowIso(), error: String(err.message || err) };
  }
  return updateCache;
}

function runUpdate() {
  if (updateJob && updateJob.status === 'running') return updateJob;
  const { spawn } = require('child_process');
  const job = { id: Date.now(), status: 'running', log: [], started: nowIso(), finished: null, ok: false };
  updateJob = job;
  const script = path.join(ROOT, 'scripts', 'update.sh');
  const useScript = fs.existsSync(script);
  const cmd = useScript ? 'bash' : 'git';
  const args = useScript ? [script] : ['pull', '--ff-only'];
  const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
  const push = (s) => { job.log.push(String(s).replace(/\s+$/, '')); if (job.log.length > 400) job.log.shift(); };
  child.stdout.on('data', d => push(d.toString()));
  child.stderr.on('data', d => push(d.toString()));
  child.on('error', e => { push(`error: ${e.message}`); job.status = 'failed'; job.finished = nowIso(); });
  child.on('close', (code) => {
    job.ok = code === 0;
    job.status = code === 0 ? 'completed' : 'failed';
    job.finished = nowIso();
    push(code === 0 ? 'Update completed successfully.' : `Update exited with code ${code}.`);
    if (code === 0) {
      updateCache = { ...updateCache, available: false, local: localVersion(), checkedAt: nowIso() };
      push('Restarting service to apply the update...');
      const svc = process.env.UPDATE_SERVICE || '';
      const how = spawn('bash', ['-lc', svc
        ? `sudo systemctl restart ${svc} || sudo service ${svc} restart || true`
        : 'pm2 restart turbine-coal-simulator 2>/dev/null || sudo systemctl restart turbine-coal-simulator 2>/dev/null || true']);
      how.stdout.on('data', d => push(d.toString()));
      how.stderr.on('data', d => push(d.toString()));
    }
  });
  return job;
}

/* ================================================================== *
 *  Express application
 * ================================================================== */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---- visitor tracking middleware ------------------------------------
app.use((req, res, next) => {
  try {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/vendor/')
      && !/\.(js|css|png|jpg|svg|ico|woff2?)$/.test(req.path)) {
      const ip = normaliseIp(clientIp(req));
      const id = crypto.createHash('sha1').update(`${ip}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 16);
      // TCP-connection identity is too coarse, so the key is IP + user agent.
      const tok = cookieToken(req);
      const sess = tok ? adminFromToken(tok) : null;
      trackVisitor({ id, ip, userAgent: req.headers['user-agent'], page: req.path, session: sess ? sess.username : null });
    }
  } catch { /* tracking must never break the app */ }
  next();
});

/* --------------------------- public API ---------------------------- */
app.get('/api/snapshot', (req, res) => {
  res.json(plant.snapshot(true));
});

app.get('/api/design', (req, res) => {
  res.json({ design: DESIGN, version: localVersion() });
});

app.get('/api/history', (req, res) => {
  res.json({ history: plant.history });
});

app.get('/api/faults', (req, res) => {
  res.json({
    faults: FAULTS.map(f => ({
      id: f.id, group: f.group, name: f.name, severity: f.severity,
      cause: f.cause, symptoms: f.symptoms, actions: f.actions,
    })),
    active: [...plant.activeFaults.values()].map(f => ({ id: f.id, name: f.def.name, since: f.t0, magnitude: f.magnitude })),
  });
});

app.post('/api/command', (req, res) => {
  const { cmd, value } = req.body || {};
  try {
    plant.command(cmd, value);
    res.json({ ok: true, snapshot: plant.snapshot(false) });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/fault/inject', (req, res) => {
  const { id, magnitude = 1, boiler = null } = req.body || {};
  const ok = plant.injectFault(id, Number(magnitude) || 1, boiler);
  res.json({ ok, snapshot: plant.snapshot(false) });
});

app.post('/api/fault/clear', (req, res) => {
  const { id } = req.body || {};
  if (id === '*') for (const k of [...plant.activeFaults.keys()]) plant.clearFault(k);
  else plant.clearFault(id);
  res.json({ ok: true, snapshot: plant.snapshot(false) });
});

/* --------------------------- admin API ----------------------------- */
const adminApi = express.Router();

adminApi.get('/status', (req, res) => {
  res.json({ registered: adminState.registered, registrationOpen: !adminState.registered });
});

adminApi.post('/register', (req, res) => {
  // ONE-TIME registration.  Once an administrator exists registration is
  // permanently disabled on this installation.
  if (adminState.registered) {
    return res.status(403).json({ ok: false, error: 'An administrator already exists — registration is disabled.' });
  }
  const uname = String((req.body || {}).username || '').trim();
  const { password, email } = req.body || {};
  if (uname.length < 3) return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters.' });
  if (!password || String(password).length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const rec = hashPassword(password);
  adminState = {
    registered: true,
    user: {
      username: uname,
      email: email || '',
      salt: rec.salt,
      hash: rec.hash,
      createdAt: nowIso(),
      lastLogin: null,
    },
    sessions: {},
  };
  saveAdmin();
  const token = newToken();
  adminState.sessions[token] = {
    username: adminState.user.username,
    created: nowIso(),
    expires: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
  };
  saveAdmin();
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  console.log(`[admin] administrator '${adminState.user.username}' registered — further registration is now disabled`);
  res.json({ ok: true, username: adminState.user.username });
});

// Brute-force protection. The password is scrypt, which is slow by design, but
// nothing stopped an attacker from trying forever. The lockout is time-boxed —
// it expires on its own — precisely so that it can never become the permanent,
// unrecoverable lockout an operator cannot get past.
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map();     // "user|ip" -> { n, until }

adminApi.post('/login', (req, res) => {
  // Trim the username: a stray space from autofill or a password manager is the
  // classic cause of a lockout that looks like a forgotten password.
  const uname = String((req.body || {}).username || '').trim();
  const { password } = req.body || {};
  if (!adminState.registered) return res.status(403).json({ ok: false, error: 'No administrator registered.' });

  const key = `${uname}|${req.ip || '?'}`;
  const rec = loginFails.get(key);
  if (rec && rec.until > Date.now()) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    return res.status(429).json({
      ok: false,
      error: `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
  }
  if (rec && rec.until <= Date.now()) loginFails.delete(key);

  const knownUser = uname === adminState.user.username;
  if (!knownUser || !verifyPassword(password, adminState.user)) {
    const n = (rec ? rec.n : 0) + 1;
    if (n >= LOGIN_MAX_FAILS) {
      loginFails.set(key, { n, until: Date.now() + LOGIN_LOCK_MS });
      console.log(`[admin] sign-in locked for 15 min after ${n} failures — ${key}`);
    } else {
      loginFails.set(key, { n, until: 0 });
    }
    // Say which half failed, so the journal shows whether to hunt for a typo in
    // the name or the password. The password itself is never logged.
    console.log(`[admin] failed sign-in from ${req.ip || '?'} — username ${JSON.stringify(uname)} `
      + `${knownUser ? 'matches an account, so the password is wrong' : 'does not match any account'}`
      + ` (attempt ${n} of ${LOGIN_MAX_FAILS})`);
    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  }
  loginFails.delete(key);
  const token = newToken();
  adminState.sessions[token] = {
    username: adminState.user.username,
    created: nowIso(),
    expires: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
  };
  adminState.user.lastLogin = nowIso();
  saveAdmin();
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  res.json({ ok: true, username: adminState.user.username });
});

adminApi.post('/logout', (req, res) => {
  const t = cookieToken(req);
  if (t) { delete adminState.sessions[t]; saveAdmin(); }
  res.clearCookie('admin_session');
  res.json({ ok: true });
});

// everything below requires a valid admin session
adminApi.use((req, res, next) => {
  const s = adminFromToken(cookieToken(req));
  if (!s) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  req.admin = s;
  next();
});

adminApi.get('/visitors', async (req, res) => {
  const list = [];
  for (const v of visitors.values()) {
    if (!v.geo) v.geo = await geolocate(v.ip);
    list.push(v);
  }
  list.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  res.json({
    serverTime: nowIso(),
    total: list.length,
    connected: list.filter(v => Date.now() - Date.parse(v.lastSeen) < 30000).length,
    visitors: list,
  });
});

adminApi.get('/update', async (req, res) => {
  const info = await checkForUpdate(req.query.force === '1');
  res.json({ ...info, job: updateJob });
});

adminApi.post('/update/run', (req, res) => {
  if (!updateCache.available && req.body && req.body.force !== true) {
    return res.status(409).json({ ok: false, error: 'No update available.' });
  }
  res.json({ ok: true, job: runUpdate() });
});

adminApi.get('/update/job', (req, res) => res.json({ job: updateJob }));

adminApi.get('/system', (req, res) => {
  res.json({
    uptime: process.uptime(),
    node: process.version,
    platform: process.platform,
    memory: process.memoryUsage(),
    version: localVersion(),
    simTime: plant.simTime,
    mode: plant.mode,
    history: plant.history.length,
    events: plant.events.length,
  });
});

// Baseline response hardening. A Content-Security-Policy is set on pages, not
// on assets, and deliberately omits frame-ancestors so an operator dashboard
// may still embed the HMI — the hidden admin console sets its own, stricter,
// policy above.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  if (/\.html?$/.test(req.path) || req.path === '/' || req.path === ADMIN_PATH) {
    res.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; "
      + "media-src 'self' blob:; object-src 'none'; base-uri 'self'");
  }
  next();
});

app.use('/api/admin', adminApi);

/* -------------------- hidden admin console page -------------------- */
// Deliberately NOT linked from the main application, not listed in
// robots.txt and it returns no-store so it never lands in a shared cache.
app.get([ADMIN_PATH, `${ADMIN_PATH}/`], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Referrer-Policy', 'no-referrer');
  // The console is the one page worth clicking: it holds the visitor list and
  // the update control. Set ALLOW_IFRAMING=1 to embed it in a dashboard.
  if (process.env.ALLOW_IFRAMING !== '1') {
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  }
  res.sendFile(path.join(PUBLIC, 'admin.html'));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\n');
});

/* ------------------------------ static ----------------------------- */
// Cache policy per asset class. The HMI used to be served with a flat one-hour
// cache, which meant an updated install could stay invisible for up to an hour:
// the operator reloaded the page and still saw the previous build, with none of
// its new controls. HTML and the application's own scripts are now always
// revalidated (cheap: express sends an ETag, so unchanged files answer 304),
// while the vendored libraries and images - which only change when the build
// does - keep a long cache.
// The build stamp is written into the HTML on the way out, not fetched by
// script and filled in afterwards. Anything that stops the bundle running — a
// stale cached copy, a blocked request, a browser that will not parse the
// module, an extension that kills the fetch — used to leave both stamps blank,
// and a blank stamp looks exactly like a missing one. Rendered here it is in
// the markup the browser receives, so it cannot go missing that way.
function buildLabel() {
  const v = localVersion();
  return `v${v.version || '—'}` + (v.commit ? ` · ${v.commit}` : '');
}

app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
      .replace(/__TCSIM_BUILD__/g, buildLabel());
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).type('text/plain').send('index.html could not be read');
  }
});

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    const rel = path.relative(PUBLIC, filePath).replace(/\\/g, '/');
    if (/\.html$/i.test(rel) || rel === '' || rel === 'index.html') {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    } else if (rel.startsWith('vendor/')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (/\.(js|css)$/i.test(rel)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (/\.(png|jpe?g|svg|woff2?|ico|webp)$/i.test(rel)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use((req, res) => {
  res.status(404).type('text/plain').send('404 Not Found');
});

/* ================================================================== *
 *  WebSocket
 * ================================================================== */
const server = http.createServer(app);
// Cross-site WebSocket hijacking: the plant control channel is deliberately
// unauthenticated, so without an origin check ANY page the operator happens to
// visit could open a socket to this port and trip the unit. Browsers always
// send Origin; non-browser clients (the test harness, wscat, curl) do not, and
// are still allowed.
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // not a browser
  let o;
  try { o = new URL(origin); } catch { return false; }
  const host = String(req.headers.host || '').toLowerCase();
  if (o.host === host) return true;               // same origin
  // localhost / 127.0.0.1 on any port: the console is often opened that way
  if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
  return ALLOWED_ORIGINS.includes(o.origin.toLowerCase());
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, done) => {
    if (originAllowed(info.req)) return done(true);
    console.log(`[ws] rejected cross-origin connection from Origin: ${info.req.headers.origin}`);
    done(false, 403, 'Forbidden origin');
  },
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { /* ignore */ }
    }
  }
}

wss.on('connection', (ws, req) => {
  const ip = normaliseIp(clientIp(req));
  const ua = req.headers['user-agent'] || '';
  const id = crypto.createHash('sha1').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
  ws.visitorId = id;
  trackVisitor({ id, ip, userAgent: ua, page: '/ws' });
  try {
    ws.send(JSON.stringify({ type: 'welcome', data: { ...plant.snapshot(true), version: localVersion() } }));
  } catch { /* ignore */ }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
    if (msg.type === 'command') plant.command(msg.cmd, msg.value);
    else if (msg.type === 'injectFault') plant.injectFault(msg.id, msg.magnitude, msg.boiler);
    else if (msg.type === 'clearFault') plant.clearFault(msg.id);
    else if (msg.type === 'speed') plant.command('speedFactor', msg.value);
    else if (msg.type === 'visitorsPing') {
      const v = visitors.get(id);
      if (v) { v.lastSeen = nowIso(); v.connected = true; visitors.set(id, v); }
    }
  });

  ws.on('close', () => {
    const v = visitors.get(id);
    if (v) { v.connected = false; v.lastSeen = nowIso(); visitors.set(id, v); }
  });
  ws.on('error', () => { /* ignore */ });
});

server.listen(PORT, HOST, () => {
  console.log('=================================================================');
  console.log(` ${PKG.name} ${PKG.version} — twin-boiler coal power plant simulator`);
  console.log(` listening on http://${HOST}:${PORT}`);
  console.log(` admin console (hidden): http://localhost:${PORT}${ADMIN_PATH}`);
  console.log('=================================================================');
  checkForUpdate(true).then(u => {
    console.log(`[update] local ${u.local.version} ${u.local.commit || '(no git)'} | remote ${u.remote ? u.remote.shortSha : 'n/a'} | ${u.available ? 'UPDATE AVAILABLE' : 'up to date'}`);
  });
});

module.exports = { app, server, plant };
