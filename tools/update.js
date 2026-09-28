#!/usr/bin/env node
/**
 * update.js — terminal front end for the update system.
 *
 *   node tools/update.js status            # is there anything newer on GitHub?
 *   node tools/update.js check             # same, but force a fresh check
 *   node tools/update.js apply             # pull it down and reinstall
 *   node tools/update.js apply --restart   # ...and restart the service
 *
 * `status` talks to GitHub read-only and changes nothing.  `apply` runs
 * scripts/update.sh, which is exactly what the "Update Now" button on the
 * hidden admin page spawns — it fetches, resets the working copy to
 * origin/<branch>, reinstalls dependencies and rebuilds the vendored browser
 * libraries.  Local edits to tracked files are discarded by design, so the
 * install always matches the repository.
 *
 * Environment:
 *   GIT_BRANCH       branch to follow                    (default main)
 *   UPDATE_SERVICE   systemd unit to restart             (default turbine-coal-simulator)
 *   APP_DIR          install directory                   (default the repo root)
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.APP_DIR
  ? path.resolve(process.env.APP_DIR)
  : path.resolve(__dirname, '..');
const BRANCH = process.env.GIT_BRANCH || 'main';
const SERVICE = process.env.UPDATE_SERVICE || 'turbine-coal-simulator';
const REPO = 'mikeehendricks/TurbineCoalSimulator';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function localVersion() {
  return { version: pkg.version, commit: git(['rev-parse', '--short=12', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

async function remoteVersion() {
  const headers = { 'User-Agent': 'TurbineCoalSimulator', Accept: 'application/vnd.github+json' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const [cRes, tRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers, signal: ctl.signal }),
      fetch(`https://api.github.com/repos/${REPO}/tags?per_page=1`, { headers, signal: ctl.signal }),
    ]);
    if (!cRes.ok) throw new Error(`GitHub API ${cRes.status} ${cRes.statusText}`);
    const c = await cRes.json();
    let tag = null;
    if (tRes.ok) { const tj = await tRes.json(); if (Array.isArray(tj) && tj.length) tag = tj[0].name; }
    return {
      sha: (c.sha || '').slice(0, 12),
      message: (c.commit && c.commit.message || '').split('\n')[0],
      author: c.commit && c.commit.author && c.commit.author.name,
      date: c.commit && c.commit.author && c.commit.author.date,
      url: c.html_url,
      tag,
    };
  } finally {
    clearTimeout(t);
  }
}

function apply(restart) {
  const script = path.join(ROOT, 'scripts', 'update.sh');
  if (!fs.existsSync(script)) {
    console.error(`!! ${script} not found — is this a full installation?`);
    process.exit(1);
  }
  const before = git(['rev-parse', '--short=12', 'HEAD']);
  console.log(`==> Applying updates to ${ROOT} (branch ${BRANCH})`);
  const r = spawnSync('bash', [script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GIT_BRANCH: BRANCH, UPDATE_SERVICE: SERVICE },
  });
  if (r.status !== 0) {
    console.error(`!! update.sh exited with ${r.status}`);
    process.exit(r.status || 1);
  }
  const after = git(['rev-parse', '--short=12', 'HEAD']);
  console.log(`\n==> ${before || 'unknown'} → ${after || 'unknown'}`);
  if (restart) {
    console.log(`==> Restarting ${SERVICE}`);
    const s = spawnSync('sudo', ['-n', 'systemctl', 'restart', SERVICE], { stdio: 'inherit' });
    if (s.status !== 0) console.error(`!! could not restart ${SERVICE} (sudo systemctl failed)`);
  } else {
    console.log(`==> Restart the service to apply:  sudo systemctl restart ${SERVICE}`);
  }
}

(async () => {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  if (cmd === 'apply') return apply(process.argv.includes('--restart'));

  const local = localVersion();
  let remote;
  try {
    remote = await remoteVersion();
  } catch (err) {
    console.error(`!! Could not reach GitHub: ${err.message}`);
    console.error(`   Local: v${local.version} (${local.commit || 'no git'}) on ${local.branch || '?'}`);
    process.exit(2);
  }
  const behind = !!remote.sha && !!local.commit && !remote.sha.startsWith(local.commit.slice(0, 12));
  const tagBehind = !!remote.tag && remote.tag !== `v${local.version}`;
  const available = behind || tagBehind;

  console.log(`repository : https://github.com/${REPO}  (branch ${BRANCH})`);
  console.log(`installed  : v${local.version}  ${local.commit || '(no git metadata)'}  [${local.branch || '?'}]`);
  console.log(`on GitHub  : ${remote.sha}  ${remote.tag ? `(${remote.tag}) ` : ''}${remote.date || ''}`);
  console.log(`              ${remote.message}`);
  console.log(`              ${remote.author || ''}`);
  console.log(`              ${remote.url}`);
  console.log('');
  if (available) {
    console.log('UPDATE AVAILABLE — run:  node tools/update.js apply --restart');
    console.log('   (or press "Update Now" on the hidden admin page)');
  } else {
    console.log('Up to date.');
  }
  process.exit(available ? 1 : 0);   // 1 = update available (handy for cron)
})();
