#!/usr/bin/env node
/**
 * run-tests.js — runs every suite and merges the results into
 * docs/executive-test-report.html.
 *
 *   node tools/run-tests.js              # all suites
 *   node tools/run-tests.js --quick      # skip the slow physics suite
 *   node tools/run-tests.js --only=api   # one suite
 *
 * Each suite prints a machine-readable block
 *   __RESULT__{...}__RESULT_END__
 * on stdout; this runner collects them, scores the result and renders the
 * executive report (HTML, self-contained, no external assets).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUITES = [
  {
    key: 'sim',
    file: 'tools/test-sim.js',
    title: 'Plant model & physics',
    slow: true,
    // Each scenario gets its own process: the model is only marginally damped,
    // so plants created after the first one in a Node process follow a
    // different trajectory (V8 optimises the hot loops in between).
    groups: ['props', 'startup', 'base', 'trip', 'fans', 'leak', 'faults', 'ramps', 'numeric'],
  },
  { key: 'api', file: 'tools/test-api.js', title: 'API, protocol & resilience' },
  { key: 'ui', file: 'tools/test-ui.js', title: 'Usability & front end' },
  { key: 'sec', file: 'tools/test-security.js', title: 'Security & vulnerabilities' },
];

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const chosen = only ? SUITES.filter((x) => x.key === only) : SUITES.filter((x) => !(quick && x.slow));

function runOne(suite, group = '') {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [suite.file], {
      cwd: ROOT,
      env: { ...process.env, ...(group ? { TCSIM_GROUP: group } : {}) },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    const kill = setTimeout(() => child.kill('SIGKILL'), suite.key === 'sim' ? 1800000 : 600000);
    child.on('close', (code) => {
      clearTimeout(kill);
      let m = out.match(/__RESULT__([\s\S]*?)__RESULT_END__/);
      if (!m) {
        // fall back to a result block a previous run left behind
        const f = process.env[`TCSIM_${suite.key.toUpperCase()}_RESULT`];
        if (f && fs.existsSync(f)) out = fs.readFileSync(f, 'utf8');
        m = out.match(/__RESULT__([\s\S]*?)__RESULT_END__/);
      }
      if (!m) {
        resolve({ ...suite, ok: false, error: `no result block (exit ${code})`, tail: err.split('\n').slice(-6).join('\n'), wallMs: Date.now() - t0 });
        return;
      }
      resolve({ ...suite, group, ok: true, wallMs: Date.now() - t0, result: JSON.parse(m[1]) });
    });
  });
}

(async () => {
  const runs = [];
  const reuse = (args.find((a) => a.startsWith('--reuse=')) || '').split('=')[1];
  async function runSuite(suite) {
    if (!suite.groups) return runOne(suite);
    process.stderr.write(`\n── ${suite.title} (${suite.groups.length} isolated scenario processes) ────────\n`);
    const out = [];
    const queue = suite.groups.slice();
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) out.push(await runOne(suite, queue.shift()));
    }));
    const tests = out.filter((r) => r.ok).flatMap((r) => r.result.tests);
    const broken = out.filter((r) => !r.ok);
    return {
      ...suite,
      ok: broken.length === 0,
      wallMs: Math.max(...out.map((r) => r.wallMs)),
      result: {
        suite: suite.title,
        category: 'physics',
        durationMs: out.reduce((a, r) => a + (r.ok ? r.result.durationMs : r.wallMs), 0),
        tests,
        passed: tests.filter((t) => t.status === 'pass').length,
        failed: tests.filter((t) => t.status === 'fail').length,
        notes: tests.filter((t) => t.status === 'note').length,
      },
    };
  }

  for (const s of chosen) {
    const cached = reuse && fs.existsSync(path.join('/tmp/sm', `${s.key}-result.json`))
      ? fs.readFileSync(path.join('/tmp/sm', `${s.key}-result.json`), 'utf8') : null;
    if (cached && /__RESULT__/.test(cached)) {
      process.stderr.write(`\n── ${s.title} (reusing ${s.key}-result.json) ──────────\n`);
      runs.push({ ...s, ok: true, wallMs: 0, result: JSON.parse(cached.match(/__RESULT__([\s\S]*?)__RESULT_END__/)[1]) });
      continue;
    }
    process.stderr.write(`\n── ${s.title} ──────────────────────────────\n`);
    runs.push(await runSuite(s));
  }
  const merged = {
    generatedAt: new Date().toISOString(),
    version: require(path.join(ROOT, "package.json")).version,
    head: (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return ''; } })(),
    suites: runs,
  };
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-results.json'), JSON.stringify(merged, null, 2));
  require('./report.js').render(merged, path.join(ROOT, 'docs', 'executive-test-report.html'));
  const p = merged.suites.reduce((a, s) => a + (s.result ? s.result.passed : 0), 0);
  const f = merged.suites.reduce((a, s) => a + (s.result ? s.result.failed : 0), 0);
  const n = merged.suites.reduce((a, s) => a + (s.result ? s.result.notes : 0), 0);
  process.stderr.write(`\n===================================================\n TOTAL  ${p} passed · ${f} failed · ${n} observations\n report  docs/executive-test-report.html\n===================================================\n`);
  process.exit(0);
})();
