#!/usr/bin/env node
/**
 * merge-results.js — fold one suite's freshly-run result into an existing
 * docs/test-results.json and re-render the executive report.
 *
 *   node tools/merge-results.js ui /home/user/ui7.log
 *
 * Running the whole programme takes about forty minutes, almost all of it the
 * physics suite. When only one suite's checks have changed — a new test added,
 * a flaky set-up fixed — re-running everything to refresh one block is wasteful,
 * and the other three suites did not change in between.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const key = process.argv[2];
const log = process.argv[3];
if (!key || !log) { console.error('usage: merge-results.js <suite-key> <log-file>'); process.exit(2); }

const text = fs.readFileSync(log, 'utf8');
const m = text.match(/__RESULT__([\s\S]*?)__RESULT_END__/);
if (!m) { console.error(`no result block in ${log}`); process.exit(2); }
const fresh = JSON.parse(m[1]);

const mergedPath = path.join(ROOT, 'docs', 'test-results.json');
const merged = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
const suite = merged.suites.find((s) => s.key === key);
if (!suite) { console.error(`no suite "${key}" in ${mergedPath}`); process.exit(2); }

console.log(`merging ${key}: ${suite.result.passed}/${suite.result.tests.length} -> ${fresh.passed}/${fresh.tests.length}`);
suite.result = fresh;
suite.ok = true;
merged.generatedAt = new Date().toISOString();

fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
require('./report.js').render(merged, path.join(ROOT, 'docs', 'executive-test-report.html'));

const p = merged.suites.reduce((a, s) => a + (s.result ? s.result.passed : 0), 0);
const f = merged.suites.reduce((a, s) => a + (s.result ? s.result.failed : 0), 0);
const n = merged.suites.reduce((a, s) => a + (s.result ? s.result.notes : 0), 0);
console.log(` TOTAL  ${p} passed · ${f} failed · ${n} observations`);
console.log(' report  docs/executive-test-report.html');
