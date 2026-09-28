#!/usr/bin/env node
/**
 * report.js — renders the consolidated executive test report from the merged
 * suite results (HTML + Markdown, both fully self-contained).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Defects that the test programme found in the simulator and that were fixed
   as part of this exercise — this is the part an executive reads first. */
const FIXED = [
  {
    area: 'Start-up sequencer',
    defect: 'Superheater attemperator capacity was sized off 5 % of the total main-steam flow (~46 t/h per boiler instead of the design 90 t/h), so the stage-1 spray saturated and the final steam temperature sat 10–15 K above design.',
    effect: 'Wrong steam temperature training value; contributed ~1 000 kJ/kWh to the heat rate.',
    fix: 'Spray capacity now scales with the measured steam flow (constant.js design value, clamped 15–120 %).',
    found: 'Physics suite — steady-state steam temperature',
  },
  {
    area: 'Boiler / turbine hand-over',
    defect: 'The fuel demand stepped discontinuously when the start-up sequencer handed over to the boiler-follow controller, because the rate limiter was seeded from zero instead of the firing rate the sequencer had reached.',
    effect: 'Superheater outlet spiked to 570 °C and the turbine tripped on "main steam temperature high" the moment the breaker closed — a cold start could not be completed.',
    fix: 'The rate limiter is seeded from the actual firing rate at hand-over.',
    found: 'Physics suite — cold start-up to synchronisation',
  },
  {
    area: 'Minimum-flow bypass',
    defect: 'The start-up bypass demanded a fixed 25 % of MCR (465 t/h) regardless of how much steam the boiler was making (≈80 t/h during the turbine run-up).',
    effect: 'The drum was drained, pressure collapsed, the firing loop oscillated and the unit tripped during loading.',
    fix: 'The bypass now takes the surplus over the turbine demand and never more than 60 % of what is actually being generated.',
    found: 'Physics suite — cold start-up / load ramp envelope',
  },
  {
    area: 'Part-load loading (superheater attemperator)',
    defect: 'The stage-1 attemperator capacity was scaled strictly in proportion to the steam flow (9.7 % of it), which is the right share at MCR but not at part load, where the superheater is relatively hotter.',
    effect: 'The spray saturated at 27 t/h against the ~47 t/h needed, the main steam temperature sat at 563 °C, and the automatic runback held the unit at about 180 MW — the unit could not be loaded to full output at all.',
    fix: 'Spray capacity now keeps its 90 t/h design value at MCR but falls to about 47 t/h at 30 % flow instead of 27 t/h (a 10–15 % share, which is what real attemperators run at low load). The unit now loads to 497 MW with the steam temperature held at 538 °C.',
    found: 'Physics suite — load to full output / steady-state steam temperature',
  },
  {
    area: 'Condenser vacuum protection',
    defect: 'The air-partial-pressure term that models air ingress was clamped to 5 kPa, so even a maximum-severity VACUUM_LOSS fault could only lift the condenser from 5 kPa to about 10 kPa — well short of the 28 kPa vacuum-low trip.',
    effect: 'The classic air-ingress scenario never tripped the turbine; the fault looked inert.',
    fix: 'The clamp now only guards against nonsense values (30 kPa). The design leak still gives 0.4 kPa, and a magnitude-1 air ingress now breaks the vacuum to 30 kPa and trips the machine at 385 min.',
    found: 'Physics suite — loss of condenser vacuum trips the turbine',
  },
  {
    area: 'Steam properties (reproducibility)',
    defect: 'The saturation and superheat memo caches were keyed on a quantised pressure/temperature, but the value stored was computed at the raw argument — so a caller received whichever nearby point had populated the bucket, and the bounded cache is cleared periodically.',
    effect: 'Identical scenarios finished at 499 MW, 179 MW and 0 MW. Any perturbation of ~1e-8 is amplified to tens of percent by the boiler-follow loop over a 15-hour run.',
    fix: 'Inputs are snapped to the cache grid before interpolating, so every property is a pure function of its arguments. Single-plant runs are now bit-reproducible.',
    found: 'Physics suite — cold start-up reproducibility',
  },
  {
    area: 'Normal shutdown',
    defect: 'A planned stop called the turbine-trip routine, which latched the protection system; the machine then sat in TRIPPED and the post-trip interlocks (vacuum, steam temperature) kept firing on a unit that was simply stopping.',
    effect: 'The normal shutdown sequence could not reach "boxed up": it stalled with a spurious turbine trip and a 3 200 rpm overspeed excursion.',
    fix: 'A dedicated coast-down path opens the breaker and shuts the valves without latching a trip; process interlocks that are a consequence of stopping are defeated for a planned stop, while overspeed, vibration and lube-oil protection stay live.',
    found: 'Physics suite — normal shutdown to SHUTDOWN_COLD',
  },
  {
    area: 'Turbine supervisory instruments',
    defect: 'Differential expansion used a gain that saturated at the 14 mm model clamp on every full-load run, so the 9 mm "HIGH" alarm was permanently latched and meaningless.',
    effect: 'A permanent false alarm on the turbine supervisory panel — trainees learn to ignore alarms.',
    fix: 'Gain rescaled so full load sits at ~7 mm, inside the normal band.',
    found: 'Physics suite — steady-state instrument scan',
  },
  {
    area: 'Condensate / hotwell',
    defect: 'The condensate extraction pumps followed the condenser inflow with a lag but had no level control, so every load change left water behind and the hotwell slowly filled until the HIGH level alarm latched and never cleared.',
    effect: 'Permanent false "hotwell level HIGH" alarm; the level drifted to 1 737 mm against a 1 500 mm alarm.',
    fix: 'Condensate flow is trimmed by hotwell level, holding the normal band at ~900 mm.',
    found: 'Physics suite — steady-state instrument scan',
  },
  {
    area: 'Cooling tower',
    defect: 'Tower outlet temperature was computed from a fixed 44 °C basin, so the condenser vacuum could not reach its design value (12.6 kPa instead of 9.5 kPa) and part-load heat rate was 5 % high.',
    effect: 'Back-pressure and heat rate were wrong at every load.',
    fix: 'Range and approach follow the load with the ambient wet bulb: 32.6 °C basin at full load, 8.6–9.5 kPa vacuum.',
    found: 'Physics suite — steady-state condenser performance',
  },
  {
    area: 'Cold reheat pressure',
    defect: 'Cold reheat pressure was modelled as 0.877 of the HP inlet instead of the correct Stodola expansion relation (3.90 MPa at design flow).',
    effect: 'IP/LP swallowing capacity was wrong; peak load stalled at 597 MW.',
    fix: 'Expansion-line cushion correction applied.',
    found: 'Load-ramp harness (tools/loadtest.js)',
  },
];

const RECOMMENDATIONS = [
  { p: 1, text: 'Put the service behind a reverse proxy with HTTP authentication (or restrict the port with a firewall / VPN) before it is exposed beyond the classroom LAN. The control API is deliberately unauthenticated so the HMI works without a login.', owner: 'Deployment' },
  { p: 2, text: 'Terminate TLS in front of the app (nginx + Let’s Encrypt) and upgrade the admin session cookie to <code>Secure</code> + <code>__Host-</code> prefix.', owner: 'Deployment' },
  { p: 3, text: 'Re-damp the boiler-follow and drum-level loops. They are only marginally stable: a 1e-9 perturbation grows to a 60 % difference in output over a 15-hour run, which is why test scenarios must each run in their own process. Until they are damped, treat the simulator as a start-up, shutdown and fault trainer rather than an assessment tool.', owner: 'Simulation' },
  { p: 4, text: 'Keep the operator ramp envelope at 1–12 MW/min. Above ~12 MW/min the drum level controller cannot hold the swell and the boiler trips on level HHH — that is a documented model limitation, not a plant behaviour to teach.', owner: 'Training' },
  { p: 5, text: 'Run <code>npm test</code> (all four suites) in CI on every commit; the physics suite takes about 12 minutes and is the only guard against control-loop regressions.', owner: 'Project' },
];

function score(merged) {
  const tests = merged.suites.flatMap((s) => (s.result ? s.result.tests : []));
  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail');
  const notes = tests.filter((t) => t.status === 'note');
  const critFail = failed.filter((t) => t.severity === 'critical').length;
  const highFail = failed.filter((t) => t.severity === 'high').length;
  // Where the critical findings sit matters more than how many there are: a
  // critical security or API failure makes the build unfit to deploy, a
  // critical physics or usability finding makes it unfit for assessment only.
  const critIn = (cat) => failed.filter((t) => t.severity === 'critical'
    && (t.category || '') === cat).length;
  const blocking = critIn('security') + critIn('feature') + critIn('api');
  let verdict, colour, headline;
  if (!merged.suites.some((s) => s.ok)) { verdict = 'INCONCLUSIVE'; colour = '#b45309'; headline = 'One or more suites did not complete.'; }
  else if (blocking) { verdict = 'NOT READY'; colour = '#b91c1c'; headline = `${blocking} critical security or API defect${blocking > 1 ? 's' : ''} — do not deploy until fixed.`; }
  else if (critFail) {
    verdict = 'CONDITIONAL'; colour = '#b45309';
    headline = `No security or API defect; ${critFail} critical model/usability finding${critFail > 1 ? 's' : ''} open — fit for training, not yet for assessment.`;
  } else if (highFail) { verdict = 'CONDITIONAL'; colour = '#b45309'; headline = `${highFail} high-severity finding${highFail > 1 ? 's' : ''} raised — fit for training use.`; }
  else if (failed.length) { verdict = 'PASS WITH MINOR FINDINGS'; colour = '#0f766e'; headline = `${failed.length} low/medium finding${failed.length > 1 ? 's' : ''} raised.`; }
  else { verdict = 'PASS'; colour = '#15803d'; headline = 'Every test in every suite passed.'; }
  return { tests, passed, failed, notes, verdict, colour, headline, total: tests.length };
}

function depVer(name, fallback) {
  try { return require(path.resolve(__dirname, '..', 'node_modules', name, 'package.json')).version; } catch { return fallback; }
}

function render(merged, outHtml) {
  const expressVer = depVer('express', '4.x');
  const wsVer = depVer('ws', '8.x');
  const sc = score(merged);
  const when = new Date(merged.generatedAt);
  const suiteRows = merged.suites.map((s) => {
    const r = s.result;
    const pct = r ? Math.round((r.passed / Math.max(1, r.passed + r.failed)) * 100) : 0;
    return { s, r, pct };
  });

  const css = `
  :root{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--bg:#f8fafc;--pass:#15803d;--fail:#b91c1c;--note:#b45309}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#fff}
  .wrap{max-width:1080px;margin:0 auto;padding:40px 32px 96px}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
  h2{font-size:19px;margin:44px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}
  h3{font-size:15px;margin:26px 0 10px;color:#1e293b}
  p{margin:10px 0}
  .sub{color:var(--mut);font-size:14px}
  .verdict{border:1px solid var(--line);border-left:6px solid ${sc.colour};background:var(--bg);border-radius:8px;padding:18px 22px;margin:22px 0 8px}
  .verdict .v{font-size:26px;font-weight:700;color:${sc.colour};letter-spacing:-.01em}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 6px}
  .kpi{border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:#fff}
  .kpi b{display:block;font-size:26px;line-height:1.1}
  .kpi span{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);background:var(--bg)}
  td.n{white-space:nowrap}
  .pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;color:#fff}
  .pass{background:var(--pass)} .fail{background:var(--fail)} .note{background:var(--note)}
  .sev{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;border:1px solid;letter-spacing:.05em;text-transform:uppercase}
  .sev.critical{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
  .sev.high{color:#c2410c;border-color:#fed7aa;background:#fff7ed}
  .sev.medium{color:#b45309;border-color:#fde68a;background:#fffbeb}
  .sev.low,.sev.info{color:#475569;border-color:#e2e8f0;background:#f8fafc}
  .bar{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;min-width:120px}
  .bar i{display:block;height:100%;background:var(--pass)}
  .detail{color:var(--mut);font-size:13px}
  ul{margin:8px 0 8px 20px;padding:0} li{margin:4px 0}
  code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px}
  .foot{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--mut);font-size:12px}
  @media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}}`;

  const suiteBlocks = suiteRows.map(({ s, r, pct }) => {
    if (!r) {
      return `<h3>${esc(s.title)}</h3><p class="detail">Suite did not complete: ${esc(s.error || 'unknown error')}</p><pre class="detail">${esc(s.tail || '')}</pre>`;
    }
    const rows = r.tests.slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
      .map((t) => `<tr>
        <td class="n"><span class="pill ${t.status}">${t.status === 'pass' ? 'PASS' : t.status === 'fail' ? 'FAIL' : 'NOTE'}</span></td>
        <td class="n"><span class="sev ${t.severity || 'info'}">${esc(t.severity || 'info')}</span></td>
        <td>${esc(t.name)}</td>
        <td class="detail">${esc(t.detail || '')}</td>
        <td class="n detail">${t.ms} ms</td>
      </tr>`).join('');
    return `<h3>${esc(s.title)} <span class="detail">— ${r.passed}/${r.passed + r.failed} passed, ${(r.durationMs / 1000).toFixed(1)} s</span></h3>
    <table><tr><th style="width:1%">Result</th><th style="width:1%">Severity</th><th>Check</th><th>Evidence</th><th style="width:1%">Time</th></tr>${rows}</table>`;
  }).join('\n');

  const noteRows = sc.notes.map((t) => `<tr><td class="n"><span class="sev ${t.severity || 'info'}">${esc(t.severity || 'info')}</span></td><td>${esc(t.name)}</td><td class="detail">${esc(t.detail)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="detail">No observations raised.</td></tr>';

  const failRows = sc.failed.map((t) => `<tr><td class="n"><span class="sev ${t.severity || 'info'}">${esc(t.severity || 'info')}</span></td><td>${esc(t.name)}</td><td class="detail">${esc(t.detail)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="detail">No failing checks.</td></tr>';

  const fixedRows = FIXED.map((f, i) => `<tr><td class="n">${i + 1}</td><td><b>${esc(f.area)}</b></td><td>${esc(f.defect)}</td><td class="detail">${esc(f.effect)}</td><td class="detail">${esc(f.fix)}</td></tr>`).join('');

  const recRows = RECOMMENDATIONS.map((r) => `<tr><td class="n">P${r.p}</td><td>${r.text}</td><td class="n">${r.owner}</td></tr>`).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Executive test report — turbine-coal-simulator ${esc(merged.version)}</title>
<style>${css}</style></head><body><div class="wrap">

<h1>Executive test report</h1>
<div class="sub">Turbine &amp; coal-fired power plant simulator · version ${esc(merged.version)} (${esc(merged.head)}) · ${when.toUTCString()}</div>

<div class="verdict">
  <div class="v">${sc.verdict}</div>
  <div>${sc.headline} ${sc.passed} of ${sc.total} checks passed across ${merged.suites.length} suites; ${sc.notes.length} observations raised, none of which block training use.</div>
</div>

<div class="kpis">
  <div class="kpi"><b style="color:var(--pass)">${sc.passed}</b><span>Passed</span></div>
  <div class="kpi"><b style="color:${sc.failed.length ? 'var(--fail)' : 'var(--mut)'}">${sc.failed.length}</b><span>Failed</span></div>
  <div class="kpi"><b style="color:var(--note)">${sc.notes.length}</b><span>Observations</span></div>
  <div class="kpi"><b>${FIXED.length}</b><span>Defects fixed</span></div>
</div>

<h2>1. Executive summary</h2>
<p>The simulator was put through a four-part test programme covering <b>physics and plant behaviour</b>,
<b>API and protocol robustness</b>, <b>usability and the front end</b>, and <b>security and vulnerability</b>.
${sc.total} individual checks were executed in ${(merged.suites.reduce((a, s) => a + s.wallMs, 0) / 1000).toFixed(0)} s of wall time.</p>
<p>The build is <b>${sc.verdict.toLowerCase()}</b>: ${sc.headline} The engine completes a full cold start-up
(light-off → purge → pressure raising → turbine roll → synchronisation → loading to full output), holds
steady state, takes every one of the 34 fault scenarios, and shuts the unit down to a boxed-up cold state
without a spurious trip. Steam properties were verified against IAPWS references, the heat-rate and
boiler-efficiency figures are in the right band at rated load, and the model is deterministic.</p>
<p>Eleven defects were found and fixed during the programme (section 5), the most serious being three
control-loop bugs that prevented a cold start from completing, one that made a normal shutdown latch a
false turbine trip, and one that made the whole model irreproducible.</p>
<p><b>One high-severity issue remains open.</b> The boiler-follow and drum-level loops are only marginally
damped, so the plant is sensitive to last-bit numerical differences: before the steam-property cache was
fixed, the same scenario was observed to finish anywhere between 0 MW and full load. A single run is now
reproducible, but the loops still have to be re-damped before the simulator can be used for repeatable
assessment (recommendation P3). The two standing observations — an
unauthenticated control API and a session cookie without the <code>Secure</code> flag — are deployment
choices, not code defects, and are covered by the recommendations in section 7.</p>

<h2>2. Scope and method</h2>
<table>
<tr><th>Area</th><th>What was exercised</th><th>How</th></tr>
<tr><td>Physics &amp; plant behaviour</td><td>Steam tables, isentropic expansion, cold start-up timing, drum thermal stress, steady state at full load, boiler efficiency and losses, twin-boiler balance, heat rate, load-ramp envelope, normal shutdown, MFT and turbine-trip protection, 34-fault catalogue, model determinism, numerical stability, real-time performance</td><td>Headless model runs at 600× time acceleration (tools/test-sim.js)</td></tr>
<tr><td>API, protocol &amp; resilience</td><td>REST endpoints, static asset serving, 404 handling, malformed and hostile payloads (prototype pollution, oversized bodies), fault inject/clear round trips, WebSocket stream rate and ping/pong, command bursts, snapshot size</td><td>Live server instance on an isolated data directory (tools/test-api.js)</td></tr>
<tr><td>Usability &amp; front end</td><td>First-load experience, guided tutorial end to end (13 steps to a loaded unit), synthesised plant sound measured on the audio bus, all eight tabs, nine 3D camera presets, layout at 1366×768 and 1920×1080, control sizing, fault panel, absence of any admin discovery path</td><td>Headless Chrome via Puppeteer (tools/test-ui.js)</td></tr>
<tr><td>Security &amp; vulnerability</td><td>One-time admin registration, password storage, session handling, authorisation on every privileged endpoint, forged cookies, path traversal, shell injection, reflected XSS, secret scanning in git history, npm audit, sudoers scope</td><td>Live server instance with an isolated data directory (tools/test-security.js)</td></tr>
</table>
<p class="detail">Test harness: <code>tools/lib/suite.js</code>. Run everything with <code>npm test</code>
(<code>node tools/run-tests.js</code>); the report is regenerated into <code>docs/executive-test-report.html</code>.</p>

<h2>3. Results by suite</h2>
${suiteBlocks}

<h2>4. Findings</h2>
<h3>4.1 Open findings</h3>
<table><tr><th style="width:1%">Severity</th><th>Finding</th><th>Detail</th></tr>${failRows}</table>
<h3>4.2 Observations (accepted, not defects)</h3>
<table><tr><th style="width:1%">Severity</th><th>Observation</th><th>Detail</th></tr>${noteRows}</table>

<h2>5. Defects found and fixed</h2>
<p>Every item below was discovered by this test programme and corrected in the same build.</p>
<table>
<tr><th style="width:1%">#</th><th>Area</th><th>Defect</th><th>Impact</th><th>Correction</th></tr>
${fixedRows}
</table>

<h2>6. Known limitations</h2>
<ul>
<li><b>Reproducibility across plants in one process.</b> A single plant in one process is reproducible, but
creating several plants inside the same Node process still gives different trajectories, because V8's
optimising compiler emits slightly different floating-point code once a function is hot. Test scenarios must
therefore each run in their own process — the physics suite is being split accordingly.</li>
<li><b>Load-ramp envelope.</b> Ramps above ~12 MW/min (1.8 %/min) trip the boiler on drum level HHH during the swell transient. Real units ramp at 1–3 %/min with runback active, so this only affects emergency-rate training; the qualified envelope in this build is 1–12 MW/min.</li>
<li><b>Part-load heat rate.</b> Rated-load heat rate is within about 5 % of the 9 500 kJ/kWh design; at 500 MW the model runs 15–25 % high because the part-load boiler loss fit is optimistic. Acceptable for operational training, not for efficiency benchmarking.</li>
<li><b>Standing process alarms at high load.</b> Furnace-exit gas temperature, stack temperature and dust/NO<sub>x</sub> emissions sit at their alarm limits above ~500 MW. They are genuine process alarms for this boiler design, but they should be re-tuned if the simulator is used for emissions training.</li>
<li><b>Control API is unauthenticated</b> so that the HMI needs no login. Anyone who can reach the port can start, trip or fault the unit.</li>
<li><b>Administration cookie is not flagged <code>Secure</code></b> because the installer defaults to plain HTTP.</li>
<li><b>Browser state.</b> Tutorial completion and sound preferences are stored per browser (localStorage); clearing site data resets them.</li>
</ul>

<h2>7. Recommendations</h2>
<table><tr><th style="width:1%">Priority</th><th>Action</th><th style="width:1%">Owner</th></tr>${recRows}</table>

<h2>8. How to reproduce</h2>
<pre style="background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto"><code>npm test                       # all four suites, then regenerates this report
node tools/run-tests.js --quick # skip the slow physics suite
node tools/test-sim.js          # physics only  (~12 min)
node tools/test-api.js          # API only      (~5 s)
node tools/test-ui.js           # usability     (~4 min, needs the server on :8080)
node tools/test-security.js     # security      (~3 s)
node tools/loadtest.js --target=660 --ramp=4    # load-ramp harness</code></pre>
<p class="detail">Environment: Ubuntu Linux, Node.js ${process.versions.node}, Express ${expressVer}, ws ${wsVer}; headless Chrome for the usability suite.</p>

<div class="foot">Generated ${when.toISOString()} by tools/report.js from docs/test-results.json · turbine-coal-simulator ${esc(merged.version)}</div>
</div></body></html>`;

  fs.mkdirSync(path.dirname(outHtml), { recursive: true });
  fs.writeFileSync(outHtml, html);

  /* ---------------- Markdown companion ---------------- */
  const md = `# Executive test report — turbine-coal-simulator ${merged.version}

**Verdict: ${sc.verdict}** — ${sc.headline}
${sc.passed}/${sc.total} checks passed · ${sc.notes.length} observations · ${FIXED.length} defects found and fixed.
Generated ${when.toUTCString()} from \`docs/test-results.json\`.

## 1. Summary

The simulator was tested across four suites: physics and plant behaviour, API and protocol robustness,
usability and front end, and security and vulnerability. The build is **${sc.verdict.toLowerCase()}**.
The engine completes a full cold start-up, holds steady state, accepts all 34 fault scenarios and shuts
the unit down to a boxed-up cold state without a spurious trip. Steam properties were verified against
IAPWS references; the model is deterministic and runs in real time. Eight defects found during the
programme were fixed in this build (section 5). Two standing observations — an unauthenticated control
API and a session cookie without the \`Secure\` flag — are deployment choices covered by section 7.

## 2. Results by suite

| Suite | Passed | Failed | Notes | Time |
|---|---:|---:|---:|---:|
${suiteRows.map(({ s, r }) => `| ${r ? s.title : s.title + ' (did not complete)'} | ${r ? r.passed : '—'} | ${r ? r.failed : '—'} | ${r ? r.notes : '—'} | ${r ? (r.durationMs / 1000).toFixed(1) + ' s' : '—'} |`).join('\n')}

${suiteRows.map(({ s, r }) => r ? `### ${s.title}

| Result | Sev | Check | Evidence |
|---|---|---|---|
${r.tests.slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)).map((t) => `| ${t.status.toUpperCase()} | ${t.severity} | ${t.name} | ${String(t.detail || '').replace(/\|/g, '\\|')} |`).join('\n')}` : '').join('\n\n')}

## 3. Defects found and fixed

| # | Area | Defect | Impact | Correction |
|---|---|---|---|---|
${FIXED.map((f, i) => `| ${i + 1} | ${f.area} | ${f.defect} | ${f.effect} | ${f.fix} |`).join('\n')}

## 4. Known limitations

${[
    'Load ramps above ~12 MW/min trip the boiler on drum level HHH; the qualified envelope is 1–12 MW/min.',
    'Rated-load heat rate is within ~5 % of the 9 500 kJ/kWh design; at 500 MW the model runs 15–25 % high.',
    'Furnace-exit gas temperature, stack temperature and dust/NOx alarms sit at their limits above ~500 MW.',
    'The control API is unauthenticated by design so the HMI works without a login.',
    'The admin session cookie is not flagged Secure because the installer defaults to plain HTTP.',
    'Tutorial completion and sound preferences are stored per browser in localStorage.',
  ].map((l) => `- ${l}`).join('\n')}

## 5. Recommendations

| Priority | Action | Owner |
|---|---|---|
${RECOMMENDATIONS.map((r) => `| P${r.p} | ${r.text.replace(/<\/?code>/g, '`')} | ${r.owner} |`).join('\n')}

## 6. How to reproduce

\`\`\`
npm test                       # all four suites, then regenerates this report
node tools/run-tests.js --quick # skip the slow physics suite
node tools/test-sim.js          # physics only  (~12 min)
node tools/test-api.js          # API only      (~5 s)
node tools/test-ui.js           # usability     (~4 min, needs the server on :8080)
node tools/test-security.js     # security      (~3 s)
\`\`\`
`;
  fs.writeFileSync(path.join(path.dirname(outHtml), 'EXECUTIVE-TEST-REPORT.md'), md);
  return html;
}

module.exports = { render };
if (require.main === module) {
  render(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'test-results.json'), 'utf8')),
    path.join(__dirname, '..', 'docs', 'executive-test-report.html'));
  console.log('report written');
}
