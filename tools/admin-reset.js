#!/usr/bin/env node
/**
 * admin-reset.js — recover access to the hidden admin console.
 *
 *   node tools/admin-reset.js                 show the current state and what a reset would do
 *   node tools/admin-reset.js --confirm        clear the administrator and reopen registration
 *   node tools/admin-reset.js --confirm --no-backup
 *
 * Registration is intentionally one-time: once an administrator exists the
 * console never offers the registration form again. That is the point — but it
 * also means a forgotten password, or an account created by an automated test
 * run or a screenshot script, locks the console permanently. This tool is the
 * documented way back in: it backs up data/admin.json and removes the
 * administrator, so the next visit to /admin opens registration again.
 *
 * IMPORTANT: stop (or restart) the server first. A running server keeps the
 * admin state in memory and writes it back on the next session change, which
 * would undo the reset.
 *
 * Environment: APP_DIR (default the repository root / install directory).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.resolve(__dirname, '..');
const ADMIN_FILE = path.join(ROOT, 'data', 'admin.json');
const SERVICE = process.env.UPDATE_SERVICE || 'turbine-coal-simulator';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm') || argv.includes('--yes');
const noBackup = argv.includes('--no-backup');

let state = null;
try {
  state = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
} catch {
  state = null;
}

console.log(`install dir : ${ROOT}`);
console.log(`state file  : ${ADMIN_FILE}`);

if (!state || !state.registered) {
  console.log('\nNo administrator is registered — the next visit to /admin will offer registration.');
  if (state) {
    console.log('(the state file exists but is not registered; nothing to clear)');
  }
  process.exit(0);
}

const u = state.user || {};
console.log(`\nregistered  : yes`);
console.log(`username    : ${u.username || '(unknown)'}`);
console.log(`email       : ${u.email || '(none)'}`);
console.log(`created     : ${u.createdAt || '(unknown)'}`);
console.log(`last login  : ${u.lastLogin || '(never)'}`);
console.log(`sessions    : ${Object.keys(state.sessions || {}).length}`);

if (!confirm) {
  console.log('\nThis is a DRY RUN — nothing was changed.');
  console.log('To clear this administrator and reopen registration:');
  console.log('  sudo systemctl stop ' + SERVICE + '        (or stop the server however you started it)');
  console.log('  node tools/admin-reset.js --confirm');
  console.log('  sudo systemctl start ' + SERVICE);
  process.exit(0);
}

if (fs.existsSync(ADMIN_FILE) && !noBackup) {
  const backup = `${ADMIN_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(ADMIN_FILE, backup);
  console.log(`\nbackup      : ${path.relative(ROOT, backup)}`);
}

const empty = { registered: false, user: null, sessions: {} };
const tmp = `${ADMIN_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(empty, null, 2));
fs.renameSync(tmp, ADMIN_FILE);

console.log('\nAdministrator cleared — registration is open again.');
console.log('\nNext:');
console.log('  1. make sure the server was STOPPED before running this, then');
console.log(`     sudo systemctl restart ${SERVICE}`);
console.log('  2. open /admin and register your own account (it is one-time, so');
console.log('     choose credentials you will keep).');
