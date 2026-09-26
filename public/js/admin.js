/* admin.js — hidden administration console logic. */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let pollTimer = null;
let updateJobPoll = null;
let lastJobState = null;

const api = async (url, opts) => {
  const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
};

const msg = (el, text, kind) => {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
};

function ago(iso) {
  const d = Date.now() - Date.parse(iso);
  if (!isFinite(d)) return '—';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/* --------------------------- auth ----------------------------------- */
async function loadStatus() {
  const st = await api('/api/admin/status');
  if (st.registered) {
    $('#regForm').classList.add('hidden');
    $('#loginForm').classList.remove('hidden');
    $('#authTitle').textContent = 'Administrator sign-in';
  } else {
    $('#authTitle').textContent = 'One-time administrator registration';
  }
  return st;
}

async function register() {
  const username = $('#u').value.trim();
  const password = $('#p').value;
  const email = $('#e').value.trim();
  if (username.length < 3) return msg($('#authMsg'), 'Username must be at least 3 characters.', 'err');
  if (password.length < 8) return msg($('#authMsg'), 'Password must be at least 8 characters.', 'err');
  try {
    await api('/api/admin/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email }),
    });
    msg($('#authMsg'), 'Administrator created — registration is now permanently disabled.', 'ok');
    await enterConsole();
  } catch (e) { msg($('#authMsg'), e.message, 'err'); }
}

async function login() {
  try {
    await api('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#lu').value, password: $('#lp').value }),
    });
    msg($('#authMsg'), '', 'ok');
    await enterConsole();
  } catch (e) { msg($('#authMsg'), e.message, 'err'); }
}

async function logout() {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  if (pollTimer) clearInterval(pollTimer);
  if (updateJobPoll) clearInterval(updateJobPoll);
  $('#console').classList.add('hidden');
  $('#authCard').classList.remove('hidden');
  await loadStatus();
}

async function enterConsole() {
  $('#authCard').classList.add('hidden');
  $('#console').classList.remove('hidden');
  await Promise.all([refreshUpdate(), refreshVisitors(), refreshSystem()]);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { refreshVisitors(); refreshSystem(); }, 5000);
}

/* --------------------------- updates -------------------------------- */
async function refreshUpdate() {
  try {
    const u = await api('/api/admin/update');
    const loc = u.local || {}, rem = u.remote || {};
    $('#updKv').innerHTML = `
      <div>installed <b>${esc(loc.version || '?')}</b></div>
      <div>commit <b>${esc(loc.commit || 'n/a')}</b></div>
      <div>latest <b>${esc(rem.tag || rem.shortSha || 'n/a')}</b></div>
      <div>remote commit <b>${esc(rem.shortSha || 'n/a')}</b></div>
      <div>checked <b>${u.checkedAt ? ago(u.checkedAt) : '—'}</b></div>
      <div>repository <b>${esc((u.repo || '').replace('https://github.com/', ''))}</b></div>`;

    $('#updBtns').innerHTML = '';
    if (u.error) {
      msg($('#updMsg'), `Could not reach GitHub: ${u.error}`, 'warn');
      const b = document.createElement('button');
      b.textContent = 'Retry check';
      b.onclick = () => refreshUpdate();
      $('#updBtns').appendChild(b);
      return;
    }
    if (u.available) {
      msg($('#updMsg'), `An update is available${rem.message ? ': ' + esc(rem.message) : ''}`, 'warn');
      const b = document.createElement('button');
      b.className = 'primary';
      b.id = 'updateNowBtn';
      b.textContent = '⬇ Update Now';
      b.onclick = () => runUpdate();
      $('#updBtns').appendChild(b);
    } else {
      msg($('#updMsg'), 'The simulator is up to date with the GitHub repository.', 'ok');
      const b = document.createElement('button');
      b.textContent = 'Check again';
      b.onclick = () => api('/api/admin/update?force=1').then(refreshUpdate);
      $('#updBtns').appendChild(b);
    }
    if (u.job && u.job.status) showJob(u.job);
  } catch (e) {
    msg($('#updMsg'), e.message, 'err');
  }
}

function showJob(job) {
  const pre = $('#updLog');
  pre.classList.remove('hidden');
  pre.textContent = (job.log || []).slice(-120).join('\n')
    + `\n\nstatus: ${job.status}${job.finished ? ' at ' + job.finished : ''}`;
  if (job.status === 'running') {
    msg($('#updMsg'), 'Update running — please wait…', 'warn').classList.add('blink');
    const b = $('#updateNowBtn');
    if (b) { b.disabled = true; b.textContent = 'Updating…'; }
  }
}

async function runUpdate() {
  const btn = $('#updateNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try {
    await api('/api/admin/update/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) { msg($('#updMsg'), e.message, 'err'); return; }
  if (updateJobPoll) clearInterval(updateJobPoll);
  let reloaded = false;
  updateJobPoll = setInterval(async () => {
    let j;
    try { j = (await api('/api/admin/update/job')).job; } catch { return; }
    if (!j) return;
    showJob(j);
    // Requirement: when the update-completed message appears, refresh the page.
    if (!reloaded && (j.status === 'completed' || j.status === 'failed')) {
      reloaded = true;
      clearInterval(updateJobPoll);
      msg($('#updMsg'), j.status === 'completed'
        ? 'Update completed — reloading the page…'
        : 'Update reported a failure — reloading the page…', j.status === 'completed' ? 'ok' : 'err');
      setTimeout(() => location.reload(), 1600);
    }
  }, 1500);
}

/* --------------------------- visitors ------------------------------- */
async function refreshVisitors() {
  try {
    const r = await api('/api/admin/visitors');
    const tb = $('#vTable').querySelector('tbody');
    $('#vCount').textContent = `— ${r.total} total, ${r.connected} active now`;
    tb.innerHTML = r.visitors.map(v => {
      const g = v.geo || {};
      const live = (Date.now() - Date.parse(v.lastSeen)) < 25000;
      const priv = g.private;
      const place = priv
        ? '<span class="pill lan">private / LAN</span>'
        : esc([g.city, g.country].filter(Boolean).join(', ') || 'unknown');
      return `<tr>
        <td>${live ? '<span class="pill live">● online</span>' : '<span class="pill">idle</span>'}</td>
        <td><b>${esc(v.ip)}</b>${priv ? '' : ` <span class="pill">${esc(g.countryCode || '')}</span>`}</td>
        <td>${place}</td>
        <td>${esc([g.region, g.zip].filter(Boolean).join(' ')) || '—'}</td>
        <td>${esc(g.isp || g.org || '—')}</td>
        <td>${g.lat != null ? `${Number(g.lat).toFixed(3)}, ${Number(g.lon).toFixed(3)}` : '—'}</td>
        <td>${ago(v.firstSeen)}</td>
        <td>${ago(v.lastSeen)}</td>
        <td style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(v.userAgent || '')}">${esc((v.userAgent || '').slice(0, 64))}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="9">Nobody has connected yet.</td></tr>';
  } catch (e) { msg($('#vMsg'), e.message, 'err'); }
}

/* ---------------------------- system -------------------------------- */
async function refreshSystem() {
  try {
    const s = await api('/api/admin/system');
    const up = Math.floor(s.uptime);
    $('#sysKv').innerHTML = `
      <div>version <b>${esc(s.version.version)}</b></div>
      <div>commit <b>${esc(s.version.commit || 'n/a')}</b></div>
      <div>node <b>${esc(s.node)}</b></div>
      <div>uptime <b>${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m</b></div>
      <div>RSS <b>${(s.memory.rss / 1048576).toFixed(0)} MB</b></div>
      <div>sim time <b>${(s.simTime / 60).toFixed(0)} min</b></div>
      <div>unit mode <b>${esc(s.mode)}</b></div>`;
  } catch (e) { /* ignore */ }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ----------------------------- init --------------------------------- */
document.addEventListener('DOMContentLoaded', async () => {
  try { await loadStatus(); } catch (e) { msg($('#authMsg'), e.message, 'err'); }
  $('#regBtn').addEventListener('click', register);
  $('#logBtn').addEventListener('click', login);
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', () => { refreshVisitors(); refreshSystem(); });
  $('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') register(); });
  $('#lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
});
