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
const { Suite } = require('./lib/suite.js');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ADMIN = process.env.ADMIN_PATH || '/admin';
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  puppeteer = require(path.resolve(__dirname, '..', 'node_modules', 'puppeteer'));
}
const s = new Suite('Usability & front-end', 'usability');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
        s.assert(st.mw > 450, `finished at only ${st.mw.toFixed(0)} MW`);
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
    const g = await page.evaluate(() => {
      const n = window.__tcsim.audio.nodes;
      const out = {};
      for (const k of Object.keys(n)) out[k] = +n[k].gain.value.toFixed(3);
      return out;
    });
    const live = Object.values(g).reduce((a, v) => a + v, 0);
    const sounding = Object.values(g).filter((v) => v > 0.005).length;
    s.assert(live > 0.03, `all audio buses are silent (sum ${live.toFixed(3)})`);
    s.assert(sounding >= 4, `only ${sounding} of ${Object.keys(g).length} buses are audible`);
    s.assert(g.turbine > 0.01, `turbine bus is ${g.turbine} with the machine at speed`);
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
  await s.test('all eight side tabs open and render content', async () => {
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.tabs button[data-pane]')).map((b) => b.dataset.pane));
    s.eq(tabs.length, 8, `expected 8 tabs, found ${tabs.length}`);
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
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(1); });
