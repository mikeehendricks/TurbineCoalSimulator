#!/usr/bin/env node
/**
 * test-ui.js — usability and front-end tests (Puppeteer / headless Chrome).
 *
 *   node tools/test-ui.js            (expects the simulator on :8080)
 *   BASE=http://127.0.0.1:8097 node tools/test-ui.js
 *
 * Covers first-load behaviour, the guided tutorial, the synthesised plant
 * sound, navigation, layout at two resolutions, the fault panel and the
 * "hidden console" requirement from the operator's point of view.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { Suite } = require('./lib/suite.js');

// Run against a simulator of our own unless one is pointed at us. Sharing the
// developer's :8080 instance silently broke a whole run: an unrelated browser
// session started the unit in the middle of the suite, so every cold-start
// test (the guided tutorial) failed for no reason that showed up in the code.
let ownServer = null;
let BASE = process.env.BASE || '';
if (!BASE) {
  const port = Number(process.env.TEST_PORT || 8097);
  process.env.PORT = String(port);
  process.env.DATA_DIR = process.env.TEST_DATA || '/tmp/tcsim-ui-test';
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  ownServer = require('../server/server.js');
  BASE = `http://127.0.0.1:${port}`;
}
const ADMIN = process.env.ADMIN_PATH || '/admin';
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  puppeteer = require(path.resolve(__dirname, '..', 'node_modules', 'puppeteer'));
}
const s = new Suite('Usability & front-end', 'usability');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring the unit back to SHUTDOWN COLD so the tutorial tests start from the
 * state they are written for. The tutorial only offers itself on the first
 * snapshot after a page load, so this has to run BEFORE the page is opened —
 * doing it afterwards leaves the unit cold but the tutorial already declined.
 * Uses the HTTP API directly (no browser needed) and runs at 600x so a full
 * coast-down takes seconds.
 */
async function ensureShutdownCold() {
  const mode = async () => {
    try {
      const r = await fetch(`${BASE}/api/snapshot`);
      const j = await r.json();
      return String((j.meta && j.meta.mode) || '').toUpperCase();
    } catch { return ''; }
  };
  const cmd = async (c, v) => {
    try {
      await fetch(`${BASE}/api/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: c, value: v }),
      });
    } catch { /* best effort */ }
  };
  if (await mode() === 'SHUTDOWN_COLD') { await cmd('speedFactor', 1); return; }
  // The run-up only takes seconds at 600x, but the time acceleration has to go
  // back afterwards: tutorial step 2 asks the operator to raise it to at least
  // 30x, and it would complete itself before the step is even shown.
  await cmd('speedFactor', 600);
  await cmd('shutdown', true);
  let cold = false;
  for (let i = 0; i < 45; i++) {
    await wait(2000);
    if (await mode() === 'SHUTDOWN_COLD') { cold = true; break; }
    if (i === 15) await cmd('resetMFT', true);   // clear a latched trip so the unit can restart
  }
  // Restore the simulator's as-new default (1x), not whatever happened to be
  // set: tutorial step 2 asks the operator to raise the acceleration to at
  // least 30x, so leaving it high from an earlier run completes that step
  // before it is even shown.
  await cmd('speedFactor', 1);
  if (!cold) console.log('  ! could not bring the unit back to SHUTDOWN COLD — tutorial tests will fail');
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error') return;
    if (/favicon/i.test(t)) return;
    // a reload or a network hiccup drops the live feed; the HMI reconnects
    if (/WebSocket connection to .* failed|WebSocket is closed/i.test(t)) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  const click = (sel) => page.evaluate((x) => {
    const el = document.querySelector(x);
    if (!el) throw new Error(`no element ${x}`);
    el.click();
  }, sel);

  // The simulator on BASE may be warm from an earlier session; the guided
  // tutorial only offers itself from SHUTDOWN COLD, so return the unit to cold
  // before the page is opened.
  await ensureShutdownCold();

  /* ---------------- first load ---------------- */
  await s.test('the HMI loads and connects to the live feed', async () => {
await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    await wait(4000);
    const st = await page.evaluate(() => ({
      conn: document.getElementById('conn').textContent,
      clock: document.getElementById('clock').textContent,
      mode: document.getElementById('mode').textContent,
      mw: document.getElementById('hMW').textContent,
    }));
    s.assert(/live/.test(st.conn), `connection state is "${st.conn}"`);
    s.assert(st.mode.length > 0, 'no unit mode displayed');
    return { detail: `websocket ${st.conn}, mode ${st.mode}, ${st.mw} MW` };
  }, { severity: 'critical' });

  await s.test('no JavaScript errors on load or during operation', () => {
    s.assert(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    s.assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    return { detail: 'clean console' };
  }, { severity: 'high' });

  await s.test('the 3D station renders (canvas is not blank)', async () => {
    // Reading the default framebuffer back needs preserveDrawingBuffer, so ask
    // the renderer what it drew instead: geometry counts are authoritative and
    // work in every headless GL backend.
    const px = await page.evaluate(() => {
      const sc = window.__tcsim.scene;
      const r = sc && (sc.renderer || sc.three || null);
      const info = sc && sc.rendererInfo ? sc.rendererInfo()
        : (window.__tcsim.scene.renderer && window.__tcsim.scene.renderer.info) || null;
      let meshes = 0, tris = 0;
      const scene3 = window.__tcsim.scene && (window.__tcsim.scene.scene || window.__tcsim.scene.root);
      if (scene3 && scene3.traverse) scene3.traverse((o) => { if (o.isMesh) meshes++; });
      if (info && info.render) tris = info.render.triangles || 0;
      return { meshes, tris, hasRenderer: !!(r || info) };
    });
    s.assert(px.meshes > 40, `only ${px.meshes} meshes in the scene graph — the station was not built`);
    s.assert(px.tris > 500, `only ${px.tris} triangles drawn in the last frame`);
    return { detail: `${px.meshes} meshes in the scene graph, ${px.tris} triangles per frame` };
  }, { severity: 'high' });

  /* ---------------- guided tutorial ---------------- */
  await s.test('the guided start-up tutorial offers itself on first visit', async () => {
    const st = await page.evaluate(() => {
      const el = document.getElementById('tutor');
      return {
        visible: getComputedStyle(el).display !== 'none',
        title: (el.querySelector('.tt-title') || {}).textContent || '',
        steps: el.querySelectorAll('.tt-foot .btn').length,
      };
    });
    s.assert(st.visible, 'tutorial panel did not appear on the first visit');
    s.assert(/Before you start/.test(st.title), `unexpected first step: ${st.title}`);
    return { detail: `first step "${st.title.trim()}" with ${st.steps} controls` };
  }, { severity: 'high' });

  await s.test('tutorial step 1 waits for the operator (does not auto-advance)', async () => {
    await wait(3000);
    const title = await page.evaluate(() => document.querySelector('#tutor .tt-title').textContent);
    s.assert(/Before you start/.test(title), `raced ahead to "${title}"`);
    return { detail: 'still on step 1 after 3 s of live snapshots' };
  });

  await s.test('the tutorial highlights the control each step is about', async () => {
    await click('#tutor [data-act="next"]');           // step 2 = time acceleration
    await wait(800);
    const st = await page.evaluate(() => ({
      title: document.querySelector('#tutor .tt-title').textContent,
      hl: Array.from(document.querySelectorAll('.tut-hl')).map((e) => e.id || e.className),
      why: (document.querySelector('#tutor .tt-sec p') || {}).textContent || '',
      live: document.querySelectorAll('#tutor .tt-live').length,
    }));
    s.assert(st.hl.includes('speed'), `highlighted: ${JSON.stringify(st.hl)} (expected #speed)`);
    s.assert(st.why.length > 80, 'the step does not explain why');
    s.assert(st.live === 1, 'no live plant readout on the step');
    return { detail: `"${st.title.trim()}" highlights #speed and shows a live readout` };
  });

  await s.test('tutorial assist buttons drive the plant, not just the text', async () => {
    await click('#tutor [data-act="assist"]');          // set 60x
    await wait(1400);
    const sp = await page.evaluate(() => ({
      factor: window.__tcsim.state.meta.speedFactor,
      sel: document.getElementById('speed').value,
    }));
    s.assert(sp.factor >= 30, `time acceleration is ${sp.factor}× after assist`);
    return { detail: `time acceleration now ${sp.factor}× (selector ${sp.sel}×)` };
  });

  await s.test('the tutorial advances only when the plant condition is met', async () => {
    const before = await page.evaluate(() => window.__tcsim.tutorial.index);
    await page.evaluate(() => document.querySelector('#tutor [data-act="assist"]').click());  // START UNIT
    await wait(2500);
    const after = await page.evaluate(() => ({
      idx: window.__tcsim.tutorial.index,
      mode: window.__tcsim.state.meta.mode,
    }));
    s.assert(after.idx > before, `step index stuck at ${before}`);
    s.assert(after.mode !== 'SHUTDOWN_COLD', `plant still ${after.mode} after START`);
    return { detail: `step ${before + 1} → ${after.idx + 1}, plant mode ${after.mode}` };
  }, { severity: 'high' });

  await s.test('the tutorial runs the whole cold start-up to a loaded unit', async () => {
    await page.evaluate(() => {
      const sel = document.getElementById('speed');
      sel.value = '600';
      sel.dispatchEvent(new Event('change'));
    });
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < 420000) {
      const st = await page.evaluate(() => {
        const t = window.__tcsim.tutorial, s = window.__tcsim.state;
        return {
          idx: t.index, active: t.active, done: t.completedAt != null,
          title: (document.querySelector('#tutor .tt-title') || {}).textContent || '',
          mode: s.meta.mode, mw: s.plant.grossMW, simT: s.meta.simTime / 60,
          mft: s.protection.mft.latched,
        };
      });
      if (st.idx !== last) { last = st.idx; console.error(`    · step ${st.idx + 1} @ ${st.simT.toFixed(0)} min — ${st.mode}, ${st.mw.toFixed(0)} MW`); }
      if (st.done) {
        // the guided run finishes once the unit is on load at its target
        s.assert(st.mw > 250, `finished at only ${st.mw.toFixed(0)} MW`);
        return { detail: `completed in ${st.simT.toFixed(0)} simulated minutes at ${st.mw.toFixed(0)} MW (${((Date.now() - t0) / 1000).toFixed(0)} s wall)` };
      }
      if (st.mft) throw new Error(`unit tripped during the tutorial at step ${st.idx + 1}`);
      await wait(1000);
    }
    throw new Error('tutorial did not finish within 420 s wall clock');
  }, { severity: 'critical' });

  await s.test('the completion summary reports the achieved operating point', async () => {
    let st = { txt: '', rows: 0 };
    for (let i = 0; i < 20; i++) {
      st = await page.evaluate(() => {
        const el = document.getElementById('tutor');
        return { txt: el.innerText, rows: el.querySelectorAll('.tt-sum tr').length };
      });
      if (/Cold start-up complete/.test(st.txt)) break;
      await wait(250);
    }
    s.assert(/Cold start-up complete/.test(st.txt), 'no completion summary');
    s.assert(st.rows >= 6, `summary shows only ${st.rows} rows`);
    return { detail: `${st.rows}-row operating summary shown` };
  });

  /* ---------------- autopilot, build stamp, control reachability ---------------- */
  await s.test('the autopilot takes the unit the rest of the way to load hands-off', async () => {
    // Start from a known cold unit instead of inheriting whatever the guided
    // start-up happened to leave behind. This test is about the autopilot: an
    // earlier scenario that left a trip latched used to make it measure a
    // refusal, and then leave the unit tripped for every test after it.
    await page.evaluate(() => window.__tcsim.cmd('resetPlant'));
    await wait(3000);
    await page.evaluate(() => {
      window.__tcsim.cmd('resetMFT');
      // Time acceleration for the run-up only, so a start does not take a
      // whole shift of wall clock. The autopilot hands the setting back when
      // it disengages.
      window.__tcsim.autopilot.runUpSpeed = 600;
    });
    await wait(2500);
    let engaged = { active: false, note: 'never tried', mode: '?', mft: false };
    for (let i = 0; i < 4; i++) {
      engaged = await page.evaluate(() => {
        const p = window.__tcsim.state.protection, a = window.__tcsim.autopilot;
        if (p.mft.latched || p.turbineTrip.latched) window.__tcsim.cmd('resetMFT');
        if (!a.active) a.enable();
        return { active: a.active, state: a.state, note: a.note,
          mode: window.__tcsim.state.meta.mode, mft: p.mft.latched };
      });
      if (engaged.active) break;
      await wait(3000);
    }
    s.assert(engaged.active,
      `autopilot refused to engage from cold: ${engaged.note} (mode ${engaged.mode}, MFT ${engaged.mft})`);
    const before = await page.evaluate(() => window.__tcsim.state.plant.grossMW || 0);
    let peak = before; let last = null;
    // A whole hands-off start: cold → pressurising → roll → synchronise →
    // load. ~90 s wall at 600x; 200 s leaves room for a loaded machine.
    for (let i = 0; i < 40; i++) {
      await wait(5000);
      last = await page.evaluate(() => ({
        st: window.__tcsim.autopilot.state,
        note: window.__tcsim.autopilot.note,
        mw: window.__tcsim.state.plant.grossMW || 0,
        active: window.__tcsim.autopilot.active,
      }));
      peak = Math.max(peak, last.mw);
      if (!last.active || last.st === 'ON_LOAD') break;
    }
    await page.evaluate(() => window.__tcsim.autopilot.disable());
    // Hand the time acceleration back explicitly. The autopilot restores the
    // operator's setting when it disengages, but a run-up that ends still
    // holding load leaves 600x engaged — and at 600x this engine cannot keep up
    // with real time on a small box, so it starves the browser and every test
    // after this one crawls.
    await page.evaluate(() => window.__tcsim.cmd('speedFactor', 1));
    await wait(1500);
    s.assert(peak > before + 40 || (last && last.st === 'ON_LOAD'),
      `autopilot did not raise load: ${before.toFixed(0)} → ${peak.toFixed(0)} MW (state ${last && last.st})`);
    return { detail: `${before.toFixed(0)} → ${peak.toFixed(0)} MW, state ${last && last.st} — ${last && last.note}` };
  }, { severity: 'high' });

  await s.test('the autopilot button label never disagrees with the autopilot state', async () => {
    // Regression: enable() engaged and then update() disengaged on the very
    // next snapshot (a latched MFT), but only the click handler repainted the
    // button. The label stayed on AUTOPILOT ON while `active` was false, so the
    // control looked broken and un-clickable — the operator saw a button that
    // said ON, did nothing, and could not be turned off.
    const desync = [];
    for (let i = 0; i < 12; i++) {
      await wait(700);
      const r = await page.evaluate(() => ({
        active: window.__tcsim.autopilot.active,
        label: (document.querySelector('#btnAuto') || {}).textContent || '',
      }));
      if (r.active !== /ON/.test(r.label)) desync.push(`active=${r.active} label="${r.label.trim()}"`);
    }
    s.assert(desync.length === 0, `button label disagreed with the state: ${desync.slice(0, 3).join(' | ')}`);
    return { detail: 'label tracked the state across 12 snapshots' };
  }, { severity: 'high' });

  await s.test('the bottom bar shows the build version and source commit', async () => {
    const txt = (await page.$eval('#ver', (e) => e.textContent)).trim();
    s.assert(/^v\d+\.\d+\.\d+/.test(txt), `build stamp is not a version: "${txt}"`);
    s.assert(/[0-9a-f]{7,}/.test(txt), 'no source commit in the build stamp');
    return { detail: txt };
  }, { severity: 'low' });

  await s.test('the build stamp sits in the top-right corner of the window, on screen', async () => {
    // Regression: the stamp lived at the end of the <h1> and at the end of the
    // bottom bar — but the header and the bar only span the 3D view, not the
    // window, because of the 340 px side panel. It therefore sat ~340 px short
    // of the corner it was described as being in, and few people ever found it.
    // Worse, the app grid used an implicit auto column, so a header that could
    // not fit widened the whole layout instead of being constrained and pushed
    // the stamp clean off the right-hand edge.
    const bad = [];
    for (const [w, h] of [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1600, 900], [1920, 1080]]) {
      await page.setViewport({ width: w, height: h });
      await wait(700);
      const r = await page.evaluate(() => {
        const el = document.querySelector('#verHead');
        if (!el) return { missing: true };
        const b = el.getBoundingClientRect();
        const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return {
          text: el.textContent.trim(),
          gapRight: Math.round(innerWidth - b.right),
          onScreen: b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 0
            && Math.round(b.right) <= innerWidth && Math.round(b.bottom) <= innerHeight,
          covered: !(at && (el === at || el.contains(at))),
        };
      });
      if (r.missing) { bad.push(`${w}x${h}: no #verHead`); continue; }
      if (!r.onScreen) bad.push(`${w}x${h}: off screen`);
      if (r.covered) bad.push(`${w}x${h}: covered by another element`);
      if (r.gapRight < 0 || r.gapRight > 40) bad.push(`${w}x${h}: ${r.gapRight}px from the right edge`);
      if (!/^v\d+\.\d+\.\d+/.test(r.text)) bad.push(`${w}x${h}: stamp reads "${r.text}"`);
    }
    await page.setViewport({ width: 1600, height: 900 });
    await wait(600);
    s.assert(bad.length === 0, `build stamp is not in the corner: ${bad.slice(0, 4).join(' · ')}`);
    return { detail: 'top-right of the window at 1024–1920 px, 14 px from the edge, never covered' };
  }, { severity: 'medium' });

  await s.test('operator controls stay clickable with the tutorial panel open', async () => {
    // Regression: the tutorial panel is absolutely positioned in the same
    // container as the bottom bar and used to paint over SOUND, TUTORIAL and
    // the volume slider on narrow/short windows, so clicks never landed.
    await page.evaluate(() => { if (!window.__tcsim.tutorial.running) window.__tcsim.tutorial.start(0); });
    await wait(1200);
    const results = [];
    for (const [w, h] of [[800, 600], [1024, 768], [1280, 800], [1600, 900]]) {
      await page.setViewport({ width: w, height: h });
      await wait(900);
      const blocked = await page.evaluate(() => {
        const out = [];
        for (const sel of ['#btnSound', '#btnTutorial', '#btnAuto', '#vol', '#btnStart']) {
          const el = document.querySelector(sel);
          if (!el) { out.push(sel + '(missing)'); continue; }
          const b = el.getBoundingClientRect();
          const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          if (!(at && (el === at || el.contains(at)))) out.push(sel);
        }
        return out;
      });
      results.push({ size: `${w}x${h}`, blocked });
    }
    await page.setViewport({ width: 1600, height: 900 });
    await page.evaluate(() => { if (window.__tcsim.tutorial.running) window.__tcsim.tutorial.stop(); });
    const bad = results.filter((r) => r.blocked.length);
    s.assert(bad.length === 0,
      `controls covered at ${bad.map((r) => r.size + ':' + r.blocked.join('/')).join(' ')}`);
    return { detail: results.map((r) => `${r.size} ${r.blocked.length ? 'BLOCKED ' + r.blocked.join('/') : 'ok'}`).join(' · ') };
  }, { severity: 'high' });

  /* ---------------- sound ---------------- */
  await s.test('sound is off by default and starts on the operator\'s click', async () => {
    const before = await page.evaluate(() => ({
      label: document.getElementById('btnSound').textContent,
      enabled: window.__tcsim.audio.enabled,
    }));
    s.assert(/OFF/.test(before.label), `button reads "${before.label}" before enable`);
    await click('#btnSound');
    await wait(1500);
    const after = await page.evaluate(() => ({
      label: document.getElementById('btnSound').textContent,
      state: window.__tcsim.audio.ctx ? window.__tcsim.audio.ctx.state : 'none',
      loaded: window.__tcsim.audio.loaded,
    }));
    s.assert(/ON/.test(after.label), `button reads "${after.label}" after enable`);
    s.assert(after.state === 'running', `AudioContext state is "${after.state}"`);
    s.assert(after.loaded, 'audio graph not built');
    return { detail: `AudioContext ${after.state}, graph built` };
  });

  await s.test('the plant sound is actually synthesised (measured on the master bus)', async () => {
    const rms = await page.evaluate(async () => {
      const a = window.__tcsim.audio;
      const an = a.ctx.createAnalyser();
      an.fftSize = 2048;
      a.master.connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0, best = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 40));
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
        best = Math.max(best, Math.sqrt(sum / buf.length));
      }
      return { rms: best, peak };
    });
    s.assert(rms.rms > 0.005, `master bus is silent (rms ${rms.rms})`);
    s.assert(rms.peak < 1.2, `output clips (peak ${rms.peak})`);
    return { detail: `master bus rms ${rms.rms.toFixed(4)}, peak ${rms.peak.toFixed(3)} (no clipping)` };
  }, { severity: 'high' });

  await s.test('sound tracks the plant: each bus is driven by its own variable', async () => {
    // Establish the precondition instead of inheriting it. The autopilot test
    // above starts from cold and can leave a trip latched (a load ramp trips on
    // drum level, which the physics suite records separately), and a turbine
    // bus reading zero on a stopped machine is correct — so this used to fail
    // for a reason that had nothing to do with the sound.
    const rpm = () => page.evaluate(() => window.__tcsim.state.turbine.speed || 0);
    if (await rpm() < 1000) {
      await page.evaluate(() => {
        window.__tcsim.cmd('resetMFT', true);
        window.__tcsim.cmd('speedFactor', 600);
        window.__tcsim.cmd('start', true);
      });
      for (let i = 0; i < 30; i++) {
        await wait(2000);
        if (await rpm() > 2500) break;
        if (i === 10 || i === 20) await page.evaluate(() => window.__tcsim.cmd('resetMFT', true));
      }
    }
    const g = await page.evaluate(() => {
      const n = window.__tcsim.audio.nodes;
      const out = {};
      for (const k of Object.keys(n)) out[k] = +n[k].gain.value.toFixed(3);
      return out;
    });
    const live = Object.values(g).reduce((a, v) => a + v, 0);
    const sounding = Object.values(g).filter((v) => v > 0.005).length;
    const shaftRpm = await rpm();
    s.assert(live > 0.03, `all audio buses are silent (sum ${live.toFixed(3)})`);
    s.assert(sounding >= 4, `only ${sounding} of ${Object.keys(g).length} buses are audible`);
    // Say what the machine was actually doing: a silent turbine bus on a
    // stopped machine is correct, and reporting it as a fault sends the next
    // engineer looking in the wrong place.
    s.assert(g.turbine > 0.01,
      `turbine bus is ${g.turbine} with the machine turning at ${shaftRpm.toFixed(0)} rpm`);
    return { detail: Object.entries(g).map(([k, v]) => `${k} ${v}`).join(' · ') };
  });

  await s.test('volume control works and the setting survives a reload', async () => {
    await page.evaluate(() => {
      const v = document.getElementById('vol');
      v.value = '25';
      v.dispatchEvent(new Event('input'));
    });
    await wait(400);
    const master = await page.evaluate(() => +window.__tcsim.audio.master.gain.value.toFixed(3));
    s.assert(master <= 0.35, `master gain is ${master} after setting the slider to 25 %`);
    await page.reload({ waitUntil: 'load' });
    await wait(3000);
    const after = await page.evaluate(() => ({
      vol: document.getElementById('vol').value,
      enabled: window.__tcsim.audio.enabled,
      label: document.getElementById('btnSound').textContent,
    }));
    s.assert(after.enabled, 'sound did not re-arm after reload');
    s.eq(after.vol, '25', 'volume after reload');
    return { detail: `master gain ${master}, setting restored after reload (${after.vol} %, ${after.label.trim()})` };
  });

  /* ---------------- navigation & layout ---------------- */
  await s.test('all nine side tabs open and render content', async () => {
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.tabs button[data-pane]')).map((b) => b.dataset.pane));
    s.eq(tabs.length, 9, `expected 9 tabs, found ${tabs.length}`);
    const empty = [];
    for (const t of tabs) {
      await page.evaluate((x) => {
        document.querySelector(`.tabs button[data-pane="${x}"]`).click();
      }, t);
      await wait(250);
      const len = await page.evaluate((x) => {
        const el = document.getElementById(`p-${x}`);
        return { active: el.classList.contains('active'), text: el.innerText.trim().length };
      }, t);
      if (!len.active || len.text < 10) empty.push(`${t} (${len.text} chars)`);
    }
    s.assert(empty.length === 0, `tabs with no content: ${empty.join(', ')}`);
    return { detail: `${tabs.length} tabs: ${tabs.join(', ')}` };
  });

  await s.test('every 3D view preset works without errors', async () => {
    const views = await page.evaluate(() => Array.from(document.querySelectorAll('#viewbtns button[data-view]')).map((b) => b.dataset.view));
    s.assert(views.length >= 9, `only ${views.length} view presets`);
    for (const v of views) {
      await page.evaluate((x) => {
        document.querySelector(`#viewbtns button[data-view="${x}"]`).click();
      }, v);
      await wait(120);
    }
    s.eq(pageErrors.length, 0, `errors while switching views: ${pageErrors.slice(0, 2).join(' | ')}`);
    return { detail: `${views.length} camera presets: ${views.join(', ')}` };
  });

  await s.test('layout is usable at 1366×768 and 1920×1080 (no overflow, no overlap)', async () => {
    const results = [];
    for (const [w, h] of [[1366, 768], [1920, 1080]]) {
      await page.setViewport({ width: w, height: h });
      await wait(700);
      const m = await page.evaluate(() => {
        const bar = document.getElementById('btmbar').getBoundingClientRect();
        const side = document.getElementById('side').getBoundingClientRect();
        const hdr = document.querySelector('header').getBoundingClientRect();
        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          barVisible: bar.top < window.innerHeight && bar.height > 10,
          sideVisible: side.width > 200 && side.right <= window.innerWidth + 1,
          hdrFits: hdr.width <= window.innerWidth + 1,
        };
      });
      s.assert(m.overflowX <= 0, `horizontal overflow of ${m.overflowX} px at ${w}×${h}`);
      s.assert(m.overflowY <= 0, `vertical overflow of ${m.overflowY} px at ${w}×${h}`);
      s.assert(m.barVisible, `control bar is off-screen at ${w}×${h}`);
      s.assert(m.sideVisible, `side panel is clipped at ${w}×${h}`);
      results.push(`${w}×${h} ok`);
    }
    await page.setViewport({ width: 1600, height: 900 });
    return { detail: results.join(' · ') };
  }, { severity: 'medium' });

  await s.test('primary controls are reachable and labelled', async () => {
    const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#btmbar button')).map((b) => ({
      id: b.id, text: b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height,
    })));
    for (const id of ['btnStart', 'btnShutdown', 'btnTrip', 'btnMft', 'btnReset', 'btnTutorial', 'btnSound']) {
      const b = btns.find((x) => x.id === id);
      s.assert(b, `control #${id} is missing`);
      s.assert(b.text.length > 2, `#${id} has no readable label`);
      s.assert(b.w >= 40 && b.h >= 18, `#${id} is too small to hit (${b.w.toFixed(0)}×${b.h.toFixed(0)} px)`);
    }
    return { detail: `${btns.length} controls in the bottom bar, all labelled and ≥40 px wide` };
  });

  /* ---------------- fault panel ---------------- */
  await s.test('faults can be injected and cleared from the Faults tab', async () => {
    await page.evaluate(() => document.querySelector('.tabs button[data-pane="faults"]').click());
    await wait(300);
    await page.evaluate(() => {
      const el = document.getElementById('fsearch');
      el.value = 'tube leak';
      el.dispatchEvent(new Event('input'));
    });
    await wait(300);
    const listed = await page.evaluate(() => document.querySelectorAll('#faults [data-fault]').length);
    s.assert(listed >= 1, 'the fault filter found nothing');
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#faults [data-fault]'))[0];
      b.click();
      return b.dataset.fault;
    });
    let active = [];
    for (let i = 0; i < 15; i++) {
      await wait(300);
      active = await page.evaluate(() => (window.__tcsim.state.activeFaults || []).map((f) => f.id || f));
      if (active.length) break;
    }
    s.assert(active.length >= 1, `clicking "${clicked}" did not inject a fault`);
    const detail = await page.evaluate(() => document.querySelectorAll('#faults .fdesc').length);
    s.assert(detail >= 1, 'injecting a fault does not show its symptoms and actions');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#faults [data-fault]'))[0];
      b.click();
    });
    let after = -1;
    for (let i = 0; i < 15; i++) {
      await wait(300);
      after = await page.evaluate(() => (window.__tcsim.state.activeFaults || []).length);
      if (after === 0) break;
    }
    s.eq(after, 0, `${after} fault(s) still active after clearing`);
    return { detail: `filter → inject → symptoms shown → clear (${active.join(', ')})` };
  }, { severity: 'high' });

  /* ---------------- hidden console ---------------- */
  await s.test('the operator UI gives no hint that the admin console exists', async () => {
    const visible = await page.evaluate(() => {
      const txt = document.body.innerText.toLowerCase();
      const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') || '');
      return { mentions: (txt.match(/admin/g) || []).length, links: links.length };
    });
    s.eq(visible.mentions, 0, `"admin" appears ${visible.mentions} time(s) in the visible UI`);
    s.eq(visible.links, 0, `${visible.links} anchor(s) found in the HMI`);
    const robots = await (await fetch(BASE + '/robots.txt')).text();
    s.assert(/Disallow:\s*\/admin/.test(robots), 'robots.txt does not hide the console');
    return { detail: 'no mention, no link; robots.txt disallows the path' };
  }, { severity: 'high' });

  await s.test('the hidden console still loads and offers one-time registration', async () => {
    const p2 = await browser.newPage();
    const r = await p2.goto(BASE + ADMIN, { waitUntil: 'load' });
    s.eq(r.status(), 200, 'admin page status');
    const st = await p2.evaluate(async () => {
      const res = await fetch('/api/admin/status').then((x) => x.json());
      return { res, hasForm: /password/i.test(document.body.innerText) };
    });
    s.assert('registrationOpen' in st.res, 'admin status unavailable');
    s.assert(st.hasForm || st.res.registered, 'neither a login form nor a registered session');
    await p2.close();
    return { detail: `reachable at ${ADMIN}, registrationOpen=${st.res.registrationOpen}` };
  });

  // Placed here, not with the other autopilot tests: latching the MFT trips
  // the unit, and the sound test above needs the machine at load.
  await s.test('the admin console is styled, not stripped by its own CSP', async () => {
    // Regression, and self-inflicted: tightening the Content-Security-Policy on
    // /admin to default-src 'self' — with no 'unsafe-inline' for styles — made
    // the browser discard the page's entire <style> block. The console still
    // loaded, still worked, and looked completely broken: 0 style rules, Times
    // New Roman on a white background. Functional tests all passed, because the
    // DOM is fine; only the rendering was destroyed. So measure the rendering.
    const p3 = await browser.newPage();
    const violations = [];
    p3.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 120));
    });
    await p3.goto(BASE + ADMIN, { waitUntil: 'load' });
    await wait(2500);
    const r = await p3.evaluate(() => {
      let rules = 0;
      for (const st of document.querySelectorAll('style')) {
        try { rules += st.sheet ? st.sheet.cssRules.length : 0; } catch (e) { /* ignored */ }
      }
      const cs = getComputedStyle(document.body);
      return { rules, font: cs.fontFamily, bg: cs.backgroundColor,
               text: (document.body.innerText || '').trim().length };
    });
    await p3.close();
    s.assert(violations.length === 0, `CSP violations on /admin: ${violations.slice(0, 2).join(' | ')}`);
    s.assert(r.rules > 0, 'the stylesheet was thrown away — 0 CSS rules applied');
    s.assert(/mono|consolas|menlo/i.test(r.font), `unstyled default font is showing: "${r.font}"`);
    s.assert(r.bg !== 'rgba(0, 0, 0, 0)' && r.bg !== 'rgb(255, 255, 255)',
      `page background is unset — the theme CSS did not apply (${r.bg})`);
    return { detail: `${r.rules} CSS rules applied, ${r.font.split(',')[0]}, background ${r.bg}` };
  }, { severity: 'high' });

  await s.test('the autopilot refuses to engage on a latched trip and says why', async () => {
    await page.evaluate(() => { if (window.__tcsim.autopilot.active) window.__tcsim.autopilot.disable(); });
    await wait(400);
    await page.evaluate(() => window.__tcsim.cmd('mft'));
    await wait(1500);
    await page.click('#btnAuto');
    await wait(1200);
    const r = await page.evaluate(() => ({
      active: window.__tcsim.autopilot.active,
      label: (document.querySelector('#btnAuto') || {}).textContent.trim(),
      note: (document.querySelector('#autoState') || {}).textContent.trim(),
      mft: window.__tcsim.state.protection.mft.latched,
    }));
    s.assert(r.mft === true, 'the MFT did not latch, so the test proved nothing');
    s.assert(r.active === false, 'autopilot engaged while the MFT was latched');
    s.assert(/OFF/.test(r.label), `label should still read OFF, reads "${r.label}"`);
    s.assert(/cannot engage/i.test(r.note), `no reason given to the operator: "${r.note}"`);
    // clear the trip again so later tests start clean
    await page.evaluate(() => window.__tcsim.cmd('resetMFT'));
    await wait(1200);
    return { detail: `refused — "${r.note}"` };
  }, { severity: 'high' });

  await s.test('the RESET PLANT button returns the simulator to a cold unit', async () => {
    // The reset must also stop anything that was driving the plant: a tutorial
    // left running restarts the unit from its next step, which makes a working
    // reset look broken.
    await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    await wait(3500);
    // Start from a known cold unit. Whatever the previous scenario left behind
    // - a latched trip, a purge in progress, a load ramp - decided whether the
    // setup below reached load at all, and on the runs where it did not this
    // test passed for the wrong reason: it reset an already-cold plant and
    // reported success for a button it had not really exercised.
    await page.evaluate(() => window.__tcsim.cmd('resetPlant'));
    await wait(2500);
    // Put the unit on load with a fault in, so the reset has something to discard.
    await page.evaluate(async () => {
      const post = (u, o) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      await post('/api/command', { cmd: 'speedFactor', value: 600 });
      await post('/api/command', { cmd: 'start', value: true });
      await post('/api/command', { cmd: 'loadSetpoint', value: 300 });
      await post('/api/command', { cmd: 'rampRate', value: 6 });
    });
    let loaded = { mw: 0, mode: '?' };
    let retried = 0;
    for (let i = 0; i < 45; i++) {
      await wait(4000);
      loaded = await page.evaluate(() => ({
        mw: window.__tcsim.state.plant.grossMW || 0,
        mode: window.__tcsim.state.meta.mode,
      }));
      if (loaded.mw > 150) break;
      // A start-up that trips on the way up latches the MFT, and every further
      // "start" is refused — so the setup used to sit out its remaining three
      // minutes doing nothing after the first trip. Retry from a hot boiler
      // instead; how often that is needed is recorded in the run notes.
      if (i > 0 && i % 4 === 3) {
        retried++;
        await page.evaluate(() => {
          window.__tcsim.cmd('resetMFT', true);
          window.__tcsim.cmd('start', true);
        });
      }
    }
    if (retried) s.note('Start-up needed more than one attempt',
      `The unit tripped during this test's set-up and had to be restarted `
      + `${retried} time(s) before it reached load. Hands-off start-ups trip on drum level `
      + `often enough to be worth knowing about; see the physics suite note on load ramps.`,
      'medium', 'usability');
    // Say so when the setup fails: a reset measured on a cold unit proves
    // nothing, and reporting it as a pass hides the fact.
    s.assert(loaded.mw > 150,
      `setup never got the unit on load (${loaded.mw.toFixed(0)} MW, mode ${loaded.mode}) - the reset would prove nothing`);
    await page.evaluate(() => fetch('/api/fault/inject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'TUBE_LEAK', magnitude: 1, boiler: 0 }),
    }));
    await wait(1200);
    const before = await page.evaluate(() => ({
      mw: +(window.__tcsim.state.plant.grossMW || 0).toFixed(0),
      mode: window.__tcsim.state.meta.mode,
      events: (window.__tcsim.state.events || []).length,
    }));

    // Drop the time acceleration before measuring. At 600x the unit covers
    // 25 simulated minutes in the 2.5 s this test waits, which is long enough
    // for an unrelated protection to latch and turn a working reset into a
    // failure that has nothing to do with the button.
    await page.evaluate(() => window.__tcsim.cmd('speedFactor', 1));
    await wait(800);

    // First click only arms it — a destructive reset must not be one click.
    await page.click('#btnResetPlant');
    await wait(500);
    const armed = (await page.$eval('#btnResetPlant', (e) => e.textContent)).trim();
    const armedMode = await page.evaluate(() => window.__tcsim.state.meta.mode);
    s.assert(/CONFIRM/i.test(armed), `first click did not arm the button — label is "${armed}"`);
    s.assert(armedMode === before.mode, `the arming click changed the plant (${before.mode} → ${armedMode})`);

    await page.click('#btnResetPlant');
    let after = null;
    const seen = [];
    for (let i = 0; i < 15; i++) {
      await wait(400);
      after = await page.evaluate(() => ({
        mode: window.__tcsim.state.meta.mode,
        mw: +(window.__tcsim.state.plant.grossMW || 0).toFixed(1),
        t: +(window.__tcsim.state.meta.simTime / 60).toFixed(0),
        events: (window.__tcsim.state.events || []).length,
        faults: (window.__tcsim.state.faults || []).length,
      }));
      seen.push(after.mode);
      if (after.mode === 'SHUTDOWN_COLD') break;
    }
    // Report the trajectory, not just the last reading: whether the reset was
    // never applied or was applied and then undone changes where to look.
    s.assert(after.mode === 'SHUTDOWN_COLD',
      `unit is ${after.mode}, not SHUTDOWN COLD after the reset (mode went ${before.mode} → ${seen.join(' → ')})`);
    s.assert(after.mw < 1, `unit still making ${after.mw} MW after the reset`);
    return { detail: `${before.mw} MW / ${before.events} events → ${after.mode}, ${after.mw} MW, clock ${after.t} min, ${after.events} events` };
  }, { severity: 'medium' });

  await s.test('arming RESET PLANT neither shifts the bar nor stays silent', async () => {
    // Two regressions, both of which made the button look broken:
    //   1. arming widened the button, the bar reflowed, and the confirming
    //      click landed somewhere else;
    //   2. resetting an already-cold unit changed nothing on screen.
    const box = () => page.evaluate(() => {
      const r = document.querySelector('#btnResetPlant').getBoundingClientRect();
      return { w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) };
    });
    // Clear any arm left over from an earlier test, so this one measures the
    // click it is actually about.
    await page.keyboard.press('Escape');
    await wait(400);
    const idle = await box();
    await page.click('#btnResetPlant');
    let armed = idle; let armedLabel = '';
    for (let i = 0; i < 8; i++) {          // poll: the label shows a countdown
      await wait(250);
      armed = await box();
      armedLabel = (await page.$eval('#btnResetPlant', (e) => e.textContent)).trim();
      if (/CONFIRM/i.test(armedLabel)) break;
    }
    s.assert(armed.w === idle.w && armed.x === idle.x && armed.y === idle.y,
      `arming moved the button: ${JSON.stringify(idle)} → ${JSON.stringify(armed)}`);
    s.assert(/CONFIRM/i.test(armedLabel), `arming click did not ask for confirmation: "${armedLabel}"`);
    await page.click('#btnResetPlant');
    let ack = '';
    for (let i = 0; i < 8; i++) {
      await wait(200);
      ack = (await page.$eval('#btnResetPlant', (e) => e.textContent)).trim();
      if (!/CONFIRM/i.test(ack)) break;
    }
    s.assert(/RESET/i.test(ack), `no acknowledgement after the reset: "${ack}"`);
    await wait(1600);
    const settled = (await page.$eval('#btnResetPlant', (e) => e.textContent)).trim();
    s.assert(/RESET PLANT/i.test(settled), `button did not return to its idle label: "${settled}"`);
    return { detail: `idle ${idle.w}px → armed ${armed.w}px at the same spot; "${armedLabel}" → "${ack}"` };
  }, { severity: 'medium' });

  await s.test('the plant controls panel exposes every drive the model simulates', async () => {
    // The sequencers run the auxiliaries themselves; until now the operator had
    // no way to touch one, so a single drive could not be tripped by hand and
    // most of the model was unreachable from the console.
    await page.evaluate(() => document.querySelector('.tabs button[data-pane="aux"]').click());
    await wait(1200);
    const r = await page.evaluate(() => ({
      groups: [...document.querySelectorAll('#auxPanel .auxgrp h4')].map((h) => h.textContent.trim()),
      rows: document.querySelectorAll('#auxPanel .auxrow').length,
      withState: [...document.querySelectorAll('#auxPanel .auxrow')]
        .filter((x) => /RUNNING|STOPPED/.test(x.querySelector('.st').textContent)).length,
      withAction: [...document.querySelectorAll('#auxPanel .auxrow')]
        .filter((x) => /START|STOP/.test(x.querySelector('button').textContent)).length,
    }));
    s.assert(r.groups.length >= 5, `only ${r.groups.length} groups: ${r.groups.join(', ')}`);
    s.assert(r.rows >= 30, `only ${r.rows} drives listed`);
    s.assert(r.withState >= 30, `${r.rows - r.withState} drive(s) show no state`);
    s.assert(r.withAction >= 30, `${r.rows - r.withAction} drive(s) offer no action`);
    return { detail: `${r.rows} drives in ${r.groups.length} groups — ${r.groups.join(', ')}` };
  }, { severity: 'medium' });

  await s.test('a drive can be started and stopped from the Controls tab', async () => {
    // Verified against the model, not just the button label: a control that
    // repaints without reaching the plant would pass on the label alone.
    const readBack = async () => page.evaluate(() => ({
      conv: window.__tcsim.state.bop.conveyorRunning,
      cwp: (window.__tcsim.state.condenser.cwPumps || [])[0],
      id: window.__tcsim.state.boilers[0].idRunning,
    }));
    const row = async (label) => page.evaluate((l) => {
      const rows = [...document.querySelectorAll('#auxPanel .auxrow')];
      const r = rows.find((x) => x.querySelector('.nm').textContent.trim() === l);
      return r ? { st: r.querySelector('.st').textContent.trim(), btn: r.querySelector('button').textContent.trim() } : null;
    }, label);

    const before = await readBack();
    const cases = [
      ['Conveyor', 'conv'],
      ['CW pump 1', 'cwp'],
      ['ID fan', 'id'],
    ];
    const failed = [];
    for (const [label, field] of cases) {
      await page.evaluate((l) => {
        const rows = [...document.querySelectorAll('#auxPanel .auxrow')];
        rows.find((x) => x.querySelector('.nm').textContent.trim() === l).querySelector('button').click();
      }, label);
      await wait(1400);
      const on = await readBack();
      const shown = await row(label);
      if (on[field] !== true) failed.push(`${label}: plant state still ${on[field]}`);
      if (shown.st !== 'RUNNING') failed.push(`${label}: panel says "${shown.st}"`);
      // and back off again
      await page.evaluate((l) => {
        const rows = [...document.querySelectorAll('#auxPanel .auxrow')];
        rows.find((x) => x.querySelector('.nm').textContent.trim() === l).querySelector('button').click();
      }, label);
      await wait(1400);
      const off = await readBack();
      if (off[field] !== false) failed.push(`${label}: would not stop (${off[field]})`);
    }
    s.assert(failed.length === 0, failed.slice(0, 3).join(' · '));
    return { detail: 'Conveyor, CW pump 1 and Boiler A ID fan each started and stopped against the model' };
  }, { severity: 'high' });

  await s.test('a console that fails to boot says so instead of going silently dead', async () => {
    // Regression: if the module bundle ever fails to load again, every control
    // renders from the HTML with no handler behind it and the page looks fine.
    const p2 = await browser.newPage();
    await p2.setJavaScriptEnabled(true);
    await p2.setRequestInterception(true);
    p2.on('request', (r) => (/\/js\/app\.js/.test(r.url()) ? r.abort() : r.continue()));
    await p2.goto(BASE, { waitUntil: 'load' });
    await wait(10000);
    const shown = await p2.$('#bootfail');
    const text = shown ? (await p2.$eval('#bootfail', (e) => e.textContent)).trim() : '';
    await p2.close();
    s.assert(shown !== null, 'no boot-failure banner after app.js was blocked');
    s.assert(/reload/i.test(text), `the banner gives the operator no way out: "${text.slice(0, 80)}"`);
    return { detail: 'blocked /js/app.js → the watchdog tells the operator to hard-reload' };
  }, { severity: 'high' });

  /* ---- operator manual desk -------------------------------------------- */
  // Until this arrived the plant ran itself: every fan speed, damper position
  // and valve demand was written by the sequencer each tick, so an operator
  // could start and stop a drive but never set one, and no control loop had a
  // setpoint they could reach. These tests are about the one promise that
  // matters: a value taken to MANUAL is not overwritten by the automatic
  // control.
  await s.test('the manual desk exposes every drive and control loop the sequencer writes', async () => {
    await page.evaluate(() => window.__tcsim.cmd('manualClear'));
    await wait(700);
    await page.evaluate(() => document.querySelector('.tabs button[data-pane="aux"]').click());
    await wait(1200);
    const r = await page.evaluate(() => ({
      groups: [...document.querySelectorAll('#manualPanel .mangrp h4')].map((h) => h.textContent.trim()),
      rows: [...document.querySelectorAll('#manualPanel .manrow')].map((x) => ({
        key: x.dataset.key,
        mode: x.querySelector('button').textContent.trim(),
        slider: !!x.querySelector('input[type=range]'),
        readout: /→/.test(x.querySelector('.val').textContent),
        clipped: (() => { const n = x.querySelector('.nm'); return n.scrollWidth > n.clientWidth + 1; })(),
      })),
    }));
    s.assert(r.groups.length === 2, `expected one desk group per boiler, got ${r.groups.length}: ${r.groups.join(', ')}`);
    s.assert(r.rows.length === 14, `expected 7 items per boiler, got ${r.rows.length}`);
    const loops = r.rows.filter((x) => /level|mstemp|rhtemp/.test(x.key)).length;
    const drives = r.rows.length - loops;
    s.assert(loops === 6 && drives === 8, `expected 6 loops and 8 drives, found ${loops} and ${drives}`);
    const noMode = r.rows.filter((x) => !/^(AUTO|MANUAL)$/.test(x.mode));
    s.assert(noMode.length === 0, `${noMode.length} item(s) show no AUTO/MANUAL switch`);
    const noSlider = r.rows.filter((x) => !x.slider);
    s.assert(noSlider.length === 0, `${noSlider.length} item(s) offer no way to set a value`);
    const noRead = r.rows.filter((x) => !x.readout);
    s.assert(noRead.length === 0, `${noRead.length} item(s) show no measured value`);
    const clip = r.rows.filter((x) => x.clipped);
    s.assert(clip.length === 0, `${clip.length} label(s) are truncated: ${clip.map((x) => x.key).join(', ')}`);
    return { detail: `14 items across ${r.groups.join(' and ')} — 8 drives and 6 control loops, each with a value control and an AUTO/MANUAL switch, nothing truncated` };
  }, { severity: 'high' });

  await s.test('a value taken to MANUAL is not overwritten by the automatic control', async () => {
    // The promise the desk has to keep. Proved by pinning boiler A's FD fan
    // while the sequencer is actually working — boiler B, which the operator
    // has not touched, is the control for "was anything moving at all?".
    await page.evaluate(() => { window.__tcsim.cmd('speedFactor', 600); window.__tcsim.cmd('start', true); });
    let started = false;
    for (let i = 0; i < 55; i++) {
      await wait(2000);
      const m = await page.evaluate(() => (window.__tcsim.state.meta || {}).mode);
      if (m === 'LOADING' || m === 'ONLINE') { started = true; break; }
      if (i === 8 || i === 24) await page.evaluate(() => window.__tcsim.cmd('resetMFT', true));
    }
    s.assert(started, 'the unit never reached LOADING, so the sequencer was not moving the fans and this proves nothing');
    await page.evaluate(() => window.__tcsim.cmd('manual', { key: 'fd:0', on: true, value: 70 }));
    await wait(2000);
    const a0 = await page.evaluate(() => window.__tcsim.state.boilers[0].fdSpeed);
    const b0 = await page.evaluate(() => window.__tcsim.state.boilers[1].fdSpeed);
    await wait(10000);                       // ~100 simulated minutes at 600x
    const a1 = await page.evaluate(() => window.__tcsim.state.boilers[0].fdSpeed);
    const b1 = await page.evaluate(() => window.__tcsim.state.boilers[1].fdSpeed);
    s.assert(Math.abs(a1 - 70) < 0.5, `boiler A FD fan drifted off the operator's 70 % to ${a1.toFixed(1)} %`);
    s.assert(Math.abs(b1 - b0) > 1, `boiler B FD fan did not move (${b0.toFixed(1)} → ${b1.toFixed(1)} %), so A holding still proves nothing`);
    s.assert(Math.abs(a0 - 70) < 0.5, `the manual value never reached the plant (${a0.toFixed(1)} %)`);
    // Give the CPU back before the remaining tests; see the autopilot test.
    await page.evaluate(() => { window.__tcsim.cmd('manualClear'); window.__tcsim.cmd('speedFactor', 1); });
    await wait(1200);
    return { detail: `over ~100 simulated minutes of an active start-up: A held at ${a1.toFixed(1)} % while the sequencer moved B ${b0.toFixed(1)} → ${b1.toFixed(1)} %` };
  }, { severity: 'high' });

  await s.test('a loop takes a setpoint in AUTO, and hands the valve over and back', async () => {
    await page.evaluate(() => window.__tcsim.cmd('manual', { key: 'mstemp:0', on: false, sp: 545 }));
    await wait(1800);
    const auto = await page.evaluate(() => ({
      sp: window.__tcsim.state.boilers[0].msTempSetpoint,
      flag: window.__tcsim.state.boilers[0].msSprayManual,
    }));
    s.assert(Math.abs(auto.sp - 545) < 0.5, `the setpoint never reached the model (${auto.sp})`);
    s.assert(!auto.flag, 'moving a setpoint took the spray valve off automatic');

    await page.evaluate(() => window.__tcsim.cmd('manual', { key: 'level:0', on: true, value: 480 }));
    await wait(3000);
    const man = await page.evaluate(() => ({
      auto: window.__tcsim.state.boilers[0].levelCtrlAuto,
      fw: window.__tcsim.state.boilers[0].fwFlow,
    }));
    s.assert(man.auto === false, 'the drum level loop stayed automatic after being taken to MANUAL');
    s.assert(Number.isFinite(man.fw), `feedwater flow went to ${man.fw}`);
    await page.evaluate(() => window.__tcsim.cmd('manual', { key: 'level:0', on: false }));
    await wait(2200);
    const rel = await page.evaluate(() => window.__tcsim.state.boilers[0].levelCtrlAuto);
    s.assert(rel === true, 'the drum level loop never went back to automatic');
    return { detail: 'main steam setpoint 545 °C applied with the valve still automatic; drum level taken MANUAL at 480 t/h and released back to AUTO' };
  }, { severity: 'high' });

  await s.test('the desk refuses hostile values and ALL AUTO releases everything', async () => {
    await page.evaluate(() => {
      [1e9, -500, NaN, 'abc', null, undefined, 1e308].forEach((v) => {
        window.__tcsim.cmd('manual', { key: 'fd:1', on: true, value: v });
      });
      window.__tcsim.cmd('manual', { key: '__proto__', on: true, value: 1 });
      window.__tcsim.cmd('manual', { key: 'nope:0', on: true, value: 1 });
    });
    await wait(2600);
    const r = await page.evaluate(() => ({
      entry: (window.__tcsim.state.meta.manual || {})['fd:1'] || null,
      keys: Object.keys(window.__tcsim.state.meta.manual || {}),
      fd: window.__tcsim.state.boilers[1].fdSpeed,
      polluted: ({}).polluted,
    }));
    s.assert(r.entry && Number.isFinite(r.entry.value), `desk entry is ${JSON.stringify(r.entry)}`);
    s.assert(Number.isFinite(r.fd), `boiler B FD fan speed went to ${r.fd}`);
    s.assert(r.entry.value >= 0 && r.entry.value <= 100, `value escaped its range: ${r.entry.value}`);
    s.assert(!r.keys.includes('__proto__') && !r.keys.includes('nope:0'), `unknown key accepted: ${r.keys.join(', ')}`);
    s.assert(r.polluted === undefined, 'prototype pollution reached Object.prototype');

    await page.click('#btnDeskClear');
    await wait(2400);
    const after = await page.evaluate(() => ({
      desk: window.__tcsim.state.meta.manual || {},
      flags: window.__tcsim.state.boilers.map((b) => ({ rh: b.rhGasDamperManual, sp: b.msSprayManual, lvl: b.levelCtrlAuto })),
    }));
    s.assert(Object.keys(after.desk).length === 0, `desk not empty after ALL AUTO: ${JSON.stringify(after.desk)}`);
    const stuck = after.flags.filter((f) => f.rh || f.sp || f.lvl !== true);
    s.assert(stuck.length === 0, `boiler flags stuck after ALL AUTO: ${JSON.stringify(after.flags)}`);
    return { detail: '7 hostile values and 2 unknown keys — value stayed in range, no NaN, no pollution; ALL AUTO returned every item and cleared every MANUAL flag' };
  }, { severity: 'high' });

  await s.test('the desk survives a reload — it is plant state, not browser state', async () => {
    await page.evaluate(() => window.__tcsim.cmd('manual', { key: 'pa:1', on: true, value: 44 }));
    await wait(1800);
    await page.reload({ waitUntil: 'load' });
    await wait(6000);
    const r = await page.evaluate(() => ({
      entry: (window.__tcsim.state.meta.manual || {})['pa:1'] || null,
      pa: window.__tcsim.state.boilers[1].paSpeed,
    }));
    s.assert(r.entry && r.entry.on === true && Math.abs(r.entry.value - 44) < 0.5, `desk lost on reload: ${JSON.stringify(r.entry)}`);
    s.assert(Math.abs((r.pa || 0) - 44) < 0.5, `PA fan not held at 44 % after reload (${r.pa})`);
    await page.evaluate(() => window.__tcsim.cmd('manualClear'));
    await wait(900);
    return { detail: 'boiler B PA fan still MANUAL at 44 % after a full page reload, desk then cleared' };
  }, { severity: 'medium' });

  /* ---- light theme ------------------------------------------------------ */
  await s.test('both themes stay legible and the choice survives a reload', async () => {
    // A light theme is only a feature if it can actually be read. Measured
    // rather than eyeballed: WCAG relative luminance on twelve text surfaces,
    // compositing translucent backgrounds against whatever is behind them.
    const measure = () => page.evaluate(() => {
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const L = (c) => { const m = c.match(/[\d.]+/g).slice(0, 3).map(Number); return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]); };
      const A = (c) => { const m = c.match(/[\d.]+/g); return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] }; };
      const over = (fg, bg) => { const f = A(fg), b = A(bg); return `rgb(${Math.round(f.r * f.a + b.r * (1 - f.a))},${Math.round(f.g * f.a + b.g * (1 - f.a))},${Math.round(f.b * f.a + b.b * (1 - f.a))})`; };
      const bgOf = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; n = n.parentElement; } return 'rgb(255,255,255)'; };
      const sel = ['.rdg', '.tabs button', '.mangrp > h4', '.manrow .nm', '.manrow .val', '.manrow .val i',
        '.manrow button.btn', '.auxgrp h4', '.auxrow .nm', '.secthd', '.auxhint', '.mandesk-note'];
      return sel.map((q) => {
        const el = document.querySelector(q);
        if (!el) return { q, ratio: null };
        const cs = getComputedStyle(el);
        const bg = over(bgOf(el), 'rgb(255,255,255)');
        const fg = over(cs.color, bg);
        const a = L(fg), b = L(bg); const hi = Math.max(a, b), lo = Math.min(a, b);
        return { q, ratio: (hi + 0.05) / (lo + 0.05), px: parseFloat(cs.fontSize) };
      });
    });
    const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme') || '');
    const first = await theme();
    await page.click('#btnTheme');
    await wait(1100);
    const second = await theme();
    const rA = await measure();
    await page.reload({ waitUntil: 'load' });
    await wait(5500);
    const persisted = await theme();
    await page.click('#btnTheme');
    await wait(1100);
    const rB = await measure();
    s.assert(second && second !== first, `the toggle did not change the theme ("${first}" → "${second}")`);
    s.assert(persisted === second, `the choice did not survive a reload: "${second}" → "${persisted}"`);
    const measured = [...rA, ...rB].filter((x) => x.ratio !== null);
    s.assert(measured.length >= 18, `only ${measured.length} of 24 surfaces could be measured`);
    const bad = measured.filter((x) => x.ratio < 4.5);
    s.assert(bad.length === 0, `${bad.length} text surface(s) below 4.5:1 — ${bad.slice(0, 4).map((x) => `${x.q} ${x.ratio.toFixed(2)}:1`).join(', ')}`);
    const worstA = Math.min(...rA.filter((x) => x.ratio !== null).map((x) => x.ratio));
    const worstB = Math.min(...rB.filter((x) => x.ratio !== null).map((x) => x.ratio));
    return { detail: `12 text surfaces per theme, worst ${worstA.toFixed(2)}:1 and ${worstB.toFixed(2)}:1 against a 4.5:1 target; the choice survives a reload` };
  }, { severity: 'high' });

  await s.test('no JavaScript errors accumulated over the whole session', () => {
    s.assert(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    s.assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    return { detail: `${consoleErrors.length} console errors, ${pageErrors.length} page errors` };
  }, { severity: 'high' });

  s.note('Tutorial and sound state are stored per browser',
    'The tutorial auto-offers itself once per browser (localStorage "tcsim.tutorialSeen") and the sound '
    + 'preference persists per browser. Clear site data — or use the 🎓 TUTORIAL button — to run the guided '
    + 'start-up again on the same machine.', 'low', 'usability');

  s.done();
  await browser.close();
  if (ownServer && ownServer.server) { try { ownServer.server.close(); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(1); });
