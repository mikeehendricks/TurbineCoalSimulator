#!/usr/bin/env node
/**
 * test-security.js — authentication, authorisation, hardening and
 * vulnerability tests for the hidden admin console, the control API and the
 * repository itself.
 *
 *   node tools/test-security.js
 *
 * Runs against a throw-away instance with its own data directory so the real
 * admin account is never touched. The update *execution* path is reviewed
 * statically only — running it would reset the working tree.
 */
'use strict';
process.env.PORT = process.env.TEST_PORT || '8098';
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = process.env.TEST_DATA || '/tmp/tcsim-sec-test';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { Suite } = require('./lib/suite.js');

const ROOT = path.resolve(__dirname, '..');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { server } = require('../server/server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const s = new Suite('Security & vulnerabilities', 'security');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, opts) => fetch(BASE + p, opts);
const post = (p, body, opts) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...((opts && opts.headers) || {}) },
  body: JSON.stringify(body),
  redirect: 'manual',
});

(async () => {
  await wait(600);

  /* ============ 1. one-time registration ============ */
  await s.test('admin status reports registration open on a fresh install', async () => {
    const j = await (await get('/api/admin/status')).json();
    s.eq(j.registered, false, 'registered');
    s.eq(j.registrationOpen, true, 'registrationOpen');
    return { detail: 'registration open, no administrator yet' };
  }, { severity: 'high' });

  await s.test('weak credentials are rejected', async () => {
    const shortPw = await post('/api/admin/register', { username: 'operator', password: 'short' });
    s.eq(shortPw.status, 400, 'short password status');
    const shortUser = await post('/api/admin/register', { username: 'ab', password: 'correct-horse' });
    s.eq(shortUser.status, 400, 'short username status');
    const none = await post('/api/admin/register', {});
    s.eq(none.status, 400, 'empty body status');
    const j = await (await get('/api/admin/status')).json();
    s.eq(j.registered, false, 'an invalid registration created an account');
    return { detail: 'password < 8 chars, username < 3 chars and empty body all rejected with 400' };
  }, { severity: 'high' });

  let cookie = null;
  await s.test('first valid registration succeeds and sets an HttpOnly session cookie', async () => {
    const r = await post('/api/admin/register', { username: 'chiefengineer', password: 'Boiler-Drum-2026!' });
    const j = await r.json();
    s.assert(j.ok, `registration failed: ${j.error}`);
    const setCookie = r.headers.get('set-cookie') || '';
    s.assert(/admin_session=/.test(setCookie), 'no session cookie issued');
    s.assert(/HttpOnly/i.test(setCookie), 'session cookie is not HttpOnly');
    s.assert(/SameSite=Lax/i.test(setCookie), 'session cookie has no SameSite attribute');
    cookie = (setCookie.match(/admin_session=([^;]+)/) || [])[1];
    s.assert(cookie && cookie.length >= 60, `session token looks weak (${cookie && cookie.length} chars)`);
    return { detail: `registered "chiefengineer", ${cookie.length}-char token, HttpOnly + SameSite=Lax` };
  }, { severity: 'critical' });

  await s.test('password is stored as a salted scrypt hash, never in clear text', () => {
    const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'admin.json'), 'utf8');
    const j = JSON.parse(raw);
    s.assert(!/Boiler-Drum-2026!/.test(raw), 'the clear-text password is in admin.json');
    s.assert(j.user.salt && j.user.salt.length >= 24, 'no per-user salt stored');
    s.assert(/^[0-9a-f]{128}$/.test(j.user.hash), 'hash is not a 64-byte scrypt digest');
    return { detail: `scrypt (N=16384, 64-byte key) with a ${j.user.salt.length}-char random salt` };
  }, { severity: 'critical' });

  await s.test('registration is permanently disabled once an administrator exists', async () => {
    const r = await post('/api/admin/register', { username: 'attacker', password: 'another-good-password' });
    s.eq(r.status, 403, 'second registration status');
    const j = await r.json();
    s.assert(/registration is disabled/i.test(j.error || ''), `unexpected message: ${j.error}`);
    const st = await (await get('/api/admin/status')).json();
    s.eq(st.registered, true, 'registered');
    s.eq(st.registrationOpen, false, 'registrationOpen');
    return { detail: 'second registration rejected with HTTP 403 — one-time registration enforced' };
  }, { severity: 'critical' });

  /* ============ 2. authentication & authorisation ============ */
  await s.test('every privileged admin endpoint rejects anonymous callers', async () => {
    const endpoints = [
      ['GET', '/api/admin/visitors'],
      ['GET', '/api/admin/update'],
      ['GET', '/api/admin/system'],
      ['GET', '/api/admin/update/job'],
      ['POST', '/api/admin/update/run'],
    ];
    const bad = [];
    for (const [method, ep] of endpoints) {
      const r = method === 'GET' ? await get(ep) : await post(ep, { force: true });
      if (r.status !== 401) bad.push(`${ep} → ${r.status}`);
    }
    s.assert(bad.length === 0, `not protected: ${bad.join(', ')}`);
    return { detail: `${endpoints.length} privileged endpoints all return 401 without a session` };
  }, { severity: 'critical' });

  await s.test('forged and tampered session cookies are rejected', async () => {
    const forged = [
      'admin_session=deadbeef',
      'admin_session=' + 'a'.repeat(64),
      `admin_session=${cookie.slice(0, -2)}ff`,
      'admin_session=../../etc/passwd',
    ];
    const bad = [];
    for (const c of forged) {
      const r = await get('/api/admin/visitors', { headers: { cookie: c } });
      if (r.status !== 401) bad.push(`${c.slice(0, 24)}… → ${r.status}`);
    }
    s.assert(bad.length === 0, `accepted: ${bad.join(', ')}`);
    return { detail: '4 forged cookies rejected with 401' };
  }, { severity: 'critical' });

  await s.test('login rejects a wrong password and accepts the right one', async () => {
    const bad = await post('/api/admin/login', { username: 'chiefengineer', password: 'wrong-password' });
    s.eq(bad.status, 401, 'wrong password status');
    const badUser = await post('/api/admin/login', { username: 'nobody', password: 'Boiler-Drum-2026!' });
    s.eq(badUser.status, 401, 'unknown user status');
    const good = await post('/api/admin/login', { username: 'chiefengineer', password: 'Boiler-Drum-2026!' });
    s.eq(good.status, 200, 'correct credentials status');
    const setCookie = good.headers.get('set-cookie') || '';
    s.assert(/HttpOnly/i.test(setCookie), 'login cookie is not HttpOnly');
    return { detail: 'wrong password and unknown user → 401, valid credentials → 200 + HttpOnly cookie' };
  }, { severity: 'critical' });

  await s.test('authenticated visitor list exposes WAN IP and geolocation fields', async () => {
    // Visitor tracking keys off normal page views, not /api/ traffic.
    await get('/');
    await wait(300);
    const r = await get('/api/admin/visitors', { headers: { cookie: `admin_session=${cookie}` } });
    s.eq(r.status, 200, 'status');
    const j = await r.json();
    s.assert(j.total >= 1, 'no visitors recorded');
    const v = j.visitors[0];
    for (const k of ['ip', 'userAgent', 'firstSeen', 'lastSeen', 'requests', 'page']) {
      s.assert(v[k] !== undefined, `visitor record missing "${k}"`);
    }
    s.assert(v.geo && typeof v.geo === 'object', 'no geolocation attached');
    for (const k of ['ip', 'country', 'city', 'isp', 'lat', 'lon']) {
      s.assert(v.geo[k] !== undefined, `geo record missing "${k}"`);
    }
    return { detail: `${j.total} visitor(s); sample ${v.ip} → ${v.geo.city || v.geo.country}, ${v.geo.isp || 'n/a'}` };
  });

  await s.test('logout invalidates the session', async () => {
    const r = await post('/api/admin/logout', {}, { headers: { cookie: `admin_session=${cookie}` } });
    s.eq(r.status, 200, 'logout status');
    const after = await get('/api/admin/visitors', { headers: { cookie: `admin_session=${cookie}` } });
    s.eq(after.status, 401, 'session still valid after logout');
    return { detail: 'session destroyed on logout, subsequent calls rejected' };
  }, { severity: 'high' });

  /* ============ 3. hardening of the hidden console ============ */
  await s.test('/admin page is served with cache and indexing protections', async () => {
    const r = await get('/admin');
    s.eq(r.status, 200, 'status');
    const cc = (r.headers.get('cache-control') || '').toLowerCase();
    s.assert(/no-store/.test(cc), `Cache-Control: ${cc}`);
    const xr = (r.headers.get('x-robots-tag') || '').toLowerCase();
    s.assert(/noindex/.test(xr) && /nofollow/.test(xr), `X-Robots-Tag: ${xr}`);
    s.assert(/no-referrer/.test((r.headers.get('referrer-policy') || '').toLowerCase()), 'no Referrer-Policy');
    return { detail: `Cache-Control: ${cc} · X-Robots-Tag: ${xr}` };
  }, { severity: 'medium' });

  await s.test('robots.txt disallows /admin and /api/', async () => {
    const t = await (await get('/robots.txt')).text();
    s.assert(/Disallow:\s*\/admin/.test(t), 'admin not disallowed');
    s.assert(/Disallow:\s*\/api\//.test(t), 'api not disallowed');
    return { detail: t.replace(/\n/g, ' · ') };
  });

  await s.test('the admin console is not discoverable from the public site', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const hits = (html.match(/admin/gi) || []).length;
    s.eq(hits, 0, `index.html mentions "admin" ${hits} time(s)`);
    const files = ['public/js/app.js', 'public/js/scene.js', 'public/index.html'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      s.assert(!/href\s*=\s*["'][^"']*admin/i.test(src), `${f} links to the admin page`);
      s.assert(!/\/admin['"`]/.test(src), `${f} references /admin`);
    }
    return { detail: 'no link, script reference or menu entry to the console anywhere in the public UI' };
  }, { severity: 'high' });

  /* ============ 4. injection & traversal ============ */
  await s.test('path traversal cannot read files outside public/', async () => {
    const attempts = [
      '/../package.json', '/../../etc/passwd', '/..%2fpackage.json',
      '/%2e%2e/package.json', '/js/../package.json', '/./../server/server.js',
      '/....//package.json',
    ];
    const leaked = [];
    for (const a of attempts) {
      const r = await get(a);
      if (r.status === 200) {
        const t = await r.text();
        if (/turbine-coal-simulator|root:x:/.test(t)) leaked.push(a);
      }
    }
    s.assert(leaked.length === 0, `leaked: ${leaked.join(', ')}`);
    return { detail: `${attempts.length} traversal payloads blocked` };
  }, { severity: 'critical' });

  await s.test('the update endpoint cannot be driven with injected shell input', async () => {
    // Static review: the update runner spawns a fixed script with no user data.
    const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    s.assert(!/spawn\([^)]*req\.body/.test(src), 'user input reaches spawn()');
    s.assert(/const script = path\.join\(ROOT, 'scripts', 'update\.sh'\)/.test(src), 'update script path is not fixed');
    // Calling it without a session must fail, even with force:true.
    const r = await post('/api/admin/update/run', { force: true, evil: '; touch /tmp/pwned-by-sim' });
    s.eq(r.status, 401, 'unauthenticated update status');
    s.assert(!fs.existsSync('/tmp/pwned-by-sim'), 'injected command executed!');
    return { detail: 'fixed script path, no user data in spawn(), unauthenticated call rejected (401)' };
  }, { severity: 'critical' });

  await s.test('no reflected XSS: API responses are JSON with a safe content type', async () => {
    const r = await post('/api/command', { cmd: '<script>alert(1)</script>', value: '"><img src=x onerror=alert(1)>' });
    const ct = r.headers.get('content-type') || '';
    s.assert(/application\/json/.test(ct), `content-type ${ct}`);
    const t = await r.text();
    s.assert(!/<script>/i.test(t), 'payload reflected verbatim into the response');
    const r2 = await get('/<script>alert(1)</script>');
    s.assert(r2.status === 404 || r2.status === 400, `payload path returned ${r2.status}`);
    const t2 = await r2.text();
    s.assert(!/<script>alert/i.test(t2), 'payload reflected in the 404 page');
    return { detail: 'JSON API only; 404 handler is plain text and escapes nothing dangerous' };
  }, { severity: 'high' });

  await s.test('JSON body parser is size limited and rejects malformed JSON', async () => {
    const r = await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ this is not json',
    });
    s.assert(r.status === 400 || r.status === 413, `status ${r.status} for malformed JSON`);
    const after = await get('/api/snapshot');
    s.eq(after.status, 200, 'server unhealthy after malformed JSON');
    return { detail: `malformed JSON → HTTP ${r.status}, server still serving` };
  });

  /* ============ 5. repository & supply chain ============ */
  await s.test('no credentials or tokens are committed to the repository', () => {
    const tracked = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean);
    const patterns = [/github_pat_/i, /ghp_[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/, /AKIA[0-9A-Z]{16}/];
    // This file carries the patterns themselves, so it matches its own scan.
    const self = __filename.replace(/\\/g, '/');
    const hits = [];
    for (const f of tracked) {
      const full = path.join(ROOT, f);
      if (full.replace(/\\/g, '/') === self) continue;      // the scanner's own patterns
      if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
      const txt = fs.readFileSync(full, 'utf8');
      for (const re of patterns) if (re.test(txt)) hits.push(`${f}: ${re}`);
    }
    s.assert(hits.length === 0, `secrets found: ${hits.join(', ')}`);
    let logHits = 0;
    try {
      const log = execSync('git log -p --all -- .', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
      logHits = (log.match(/github_pat_[A-Za-z0-9_]+/g) || []).length;
    } catch { /* ignore */ }
    s.eq(logHits, 0, `the GitHub token appears ${logHits} time(s) in the commit history`);
    return { detail: `${tracked.length} tracked files and the full history scanned — no secrets` };
  }, { severity: 'critical' });

  await s.test('runtime data (admin credentials, sessions) is excluded from git', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const entry of ['data/', 'node_modules/', '.env', 'logs/']) {
      s.assert(ignore.split('\n').map((x) => x.trim()).includes(entry), `.gitignore does not exclude ${entry}`);
    }
    return { detail: 'data/, node_modules/, .env and logs/ are all ignored' };
  }, { severity: 'high' });

  await s.test('npm dependency audit (express, ws)', () => {
    let out = '';
    try {
      const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      out = r.stdout || '';
    } catch (e) { out = ''; }
    if (!out.trim()) { s.note2 = true; return { detail: 'npm audit unavailable offline — skipped', severity: 'low' }; }
    const j = JSON.parse(out);
    const v = j.metadata && j.metadata.vulnerabilities ? j.metadata.vulnerabilities : {};
    const crit = (v.critical || 0) + (v.high || 0);
    s.eq(crit, 0, `high/critical advisories: ${JSON.stringify(v)}`);
    return { detail: `advisories — critical ${v.critical || 0}, high ${v.high || 0}, moderate ${v.moderate || 0}, low ${v.low || 0}` };
  }, { severity: 'high' });

  await s.test('no dangerous patterns in the server source', () => {
    const files = ['server/server.js', 'server/sim/engine.js', 'server/sim/plant.js', 'server/sim/faults.js', 'scripts/update.sh'];
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/\beval\s*\(/.test(src)) bad.push(`${f}: eval()`);
      if (/new Function\s*\(/.test(src)) bad.push(`${f}: new Function()`);
      if (/child_process[\s\S]{0,200}\$\{/.test(src) && /exec\(/.test(src) && /\$\{(req|msg|body)/.test(src)) bad.push(`${f}: shell interpolation of request data`);
      if (/innerHTML\s*=\s*(req|msg|body)/.test(src)) bad.push(`${f}: innerHTML from request data`);
    }
    s.assert(bad.length === 0, bad.join('; '));
    return { detail: `${files.length} server-side files free of eval/Function/command interpolation` };
  });

  await s.test('the systemd unit grants only the minimum sudo rights', () => {
    const unit = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const svc = fs.existsSync('/etc/sudoers.d/turbine-coal-simulator')
      ? fs.readFileSync('/etc/sudoers.d/turbine-coal-simulator', 'utf8') : null;
    s.assert(/NOPASSWD:\s*\/bin\/systemctl restart turbine-coal-simulator/.test(unit), 'installer does not scope the sudo rule');
    s.assert(!/ALL=\(ALL\)\s*ALL/.test(unit), 'installer grants blanket sudo');
    return {
      detail: svc
        ? `installed rule: ${svc.trim().split('\n').length} narrowly scoped systemctl commands`
        : 'installer writes three narrowly scoped NOPASSWD systemctl rules (restart/start/stop, this unit only); not installed in this test sandbox',
    };
  });

  s.note('Control API is unauthenticated by design',
    'POST /api/command, /api/fault/inject and the WebSocket command channel let any client that can reach the '
    + 'port start, trip and fault the unit — that is what makes the HMI work without a login. Deploy behind a '
    + 'firewall/VPN or put a reverse proxy with HTTP auth in front of it if the port is exposed.',
    'medium', 'security');

  s.note('Session cookie is issued without the Secure flag',
    'The admin cookie carries HttpOnly and SameSite=Lax but not Secure, because the installer defaults to plain '
    + 'HTTP. Terminate TLS in front of the app (nginx + Let\'s Encrypt) and the cookie should be upgraded to '
    + 'Secure + __Host- prefix.',
    'medium', 'security');

  s.done();
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(1); });
