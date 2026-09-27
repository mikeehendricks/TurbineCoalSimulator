/**
 * suite.js — tiny test harness shared by the tools/test-*.js suites.
 *
 *   const s = new Suite('Simulation model', 'feature');
 *   await s.test('cold start reaches ONLINE', () => { ... assert ... });
 *   s.done();          // prints a JSON result block on stdout
 *
 * run-tests.js collects those blocks and turns them into the report.
 */
'use strict';

class Suite {
  constructor(name, category) {
    this.name = name;
    this.category = category;         // usability | feature | bug | security | vulnerability
    this.tests = [];
    this.started = Date.now();
  }

  /** @param {string} name @param {()=>any} fn @param {object} [meta] */
  async test(name, fn, meta = {}) {
    const t0 = Date.now();
    const rec = {
      name,
      category: meta.category || this.category,
      severity: meta.severity || 'info',   // info | low | medium | high | critical
      status: 'pass',
      detail: '',
      ms: 0,
    };
    try {
      const out = await fn();
      if (out && typeof out === 'object') {
        if (out.detail) rec.detail = String(out.detail);
        if (out.severity) rec.severity = out.severity;
      } else if (typeof out === 'string') {
        rec.detail = out;
      }
    } catch (err) {
      rec.status = 'fail';
      rec.detail = String((err && err.message) || err).slice(0, 400);
    }
    rec.ms = Date.now() - t0;
    this.tests.push(rec);
    const mark = rec.status === 'pass' ? '  ✓' : '  ✗';
    console.error(`${mark} ${name}${rec.detail ? ` — ${rec.detail}` : ''}`);
    return rec.status === 'pass';
  }

  /** Record a finding that is not a pass/fail assertion (e.g. an advisory). */
  note(name, detail, severity = 'info', category = null) {
    this.tests.push({
      name, category: category || this.category, severity,
      status: 'note', detail: String(detail).slice(0, 400), ms: 0,
    });
    console.error(`  • ${name} — ${detail}`);
  }

  assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
  near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'not near'}: ${a} vs ${b} (±${tol})`); }

  done() {
    const out = {
      suite: this.name,
      category: this.category,
      durationMs: Date.now() - this.started,
      tests: this.tests,
      passed: this.tests.filter((t) => t.status === 'pass').length,
      failed: this.tests.filter((t) => t.status === 'fail').length,
      notes: this.tests.filter((t) => t.status === 'note').length,
    };
    console.log(`__RESULT__${JSON.stringify(out)}__RESULT_END__`);
    return out;
  }
}

module.exports = { Suite };
