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
  let commit = git(['rev-parse', '--short=12', 'HEAD']) || '';
  let branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || BRANCH;
  let source = 'git';
  if (!commit) {
    // A plain install (no .git): the deployed build is recorded in build.json.
    try {
      const stamp = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8'));
      if (stamp && stamp.commit) { commit = String(stamp.commit); branch = stamp.branch || branch; source = 'build.json'; }
    } catch { /* unknown */ }
  }
  return { version: pkg.version, commit, branch, source };
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
  // On a git install the comparison is against the remote-tracking ref, which
  // is only as fresh as the last fetch. An install that was cloned once and
  // never fetched again compared itself against the commit it was cloned from,
  // so `origin/main` and HEAD agreed and it reported "up to date" for ever —
  // measured here: five commits behind GitHub, still saying "Up to date".
  // `git fetch` touches only the remote-tracking refs and never the working
  // copy, so it is safe to do from a read-only status check.
  if (local.source === 'git') git(['fetch', '--quiet', '--prune', 'origin', BRANCH]);

  // Ahead/behind counts, so a build that simply has its own commits (or is
  // newer than the branch) is not reported as "update available".
  let ahead = 0, behind = 0;
  const counts = git(['rev-list', '--left-right', '--count', `origin/${BRANCH}...HEAD`]);
  if (counts) { const m = counts.split(/\s+/); behind = parseInt(m[0], 10) || 0; ahead = parseInt(m[1], 10) || 0; }
  else if (!local.commit) {
    // No idea what is installed: say so rather than reporting "up to date",
    // which is how an out-of-date install went unnoticed for weeks.
    behind = -1;
  } else { behind = !!remote.sha && !remote.sha.startsWith(local.commit.slice(0, 12)) ? 1 : 0; }
  // Backstop, for when the fetch above could not run — no route to the git
  // remote, a single-branch or shallow clone. Compare the installed commit
  // with what the GitHub API just reported; this is what the console's own
  // update check does, and it cannot be fooled by a stale local ref.
  if (behind === 0 && remote.sha && local.commit
    && !remote.sha.startsWith(local.commit.slice(0, 12))) behind = 1;
  const tagBehind = !!remote.tag && remote.tag !== `v${local.version}`;
  const available = behind > 0 || (tagBehind && ahead === 0);

  console.log(`repository : https://github.com/${REPO}  (branch ${BRANCH})`);
  console.log(`installed  : v${local.version}  ${local.commit || '(no git metadata)'}  [${local.branch || '?'}]`);
  console.log(`on GitHub  : ${remote.sha}  ${remote.tag ? `(${remote.tag}) ` : ''}${remote.date || ''}`);
  console.log(`              ${remote.message}`);
  console.log(`              ${remote.author || ''}`);
  console.log(`              ${remote.url}`);
  console.log('');
  if (behind < 0) {
    console.log('UNKNOWN — this installation carries no build stamp, so it cannot be compared with GitHub.');
    const label = remote.tag || `v${pkg.version}`;
    console.log(`Run:  node tools/update.js apply --restart   to deploy the current build (${label})`);
  } else if (available) {
    console.log(`UPDATE AVAILABLE (${behind} commit${behind === 1 ? '' : 's'} behind) — apply with:  node tools/update.js apply --restart`);
    console.log('   (or press "Update Now" on the hidden admin page)');
  } else if (ahead > 0) {
    console.log(`Up to date — this build is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${BRANCH} (nothing to install).`);
  } else {
    console.log('Up to date.');
  }
  process.exit(available ? 1 : 0);   // 1 = update available (handy for cron)
})();
