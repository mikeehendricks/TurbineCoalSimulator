/**
 * shots.js — capture README screenshots with headless Chrome.
 *   node tools/shots.js [outDir]
 */
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2] || path.join(__dirname, '..', 'docs');
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--window-size=1760,1000',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1760, height: 990, deviceScaleFactor: 1 });
  page.on('console', (m) => { const t = m.text(); if (/error|Error/.test(t)) console.log('  [page]', t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('  saved', name);
  };

  console.log('loading simulator…');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3500);

  // --- 1. cold plant, overview -------------------------------------------
  await shot('01-cold-overview.png');

  // --- drive the start-up ------------------------------------------------
  console.log('running the start-up sequence at 600x…');
  await page.evaluate(() => {
    const w = window.__ws || null;
    return null;
  });
  // The page owns the socket, so drive through its own controls.
  // make sure the shared plant starts from a clean slate
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.tabs button[data-pane]')).find(x => x.dataset.pane === 'faults');
    if (b) b.click();
  });
  await page.evaluate(() => { const b = document.querySelector('#clearAllFaults'); if (b) b.click(); });
  await page.evaluate(() => { const b = document.querySelector('#btnReset'); if (b) b.click(); });
  await page.select('#speed', '600');
  await page.click('#btnStart');

  // wait for loading to progress
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const st = await page.evaluate(() => ({
      mode: document.querySelector('#mode') ? document.querySelector('#mode').textContent : '',
      mw: document.querySelector('#hMW') ? document.querySelector('#hMW').textContent : '0',
      clock: document.querySelector('#clock') ? document.querySelector('#clock').textContent : '',
    }));
    if (i % 10 === 0) console.log(`   ${st.clock} ${st.mode} ${st.mw} MW`);
    if (st.mode === 'ONLINE' && parseFloat(st.mw) > 60) break;
  }
  // operator completes the loading (the automatic sequence hands over at ~15 %)
  console.log('operator loading to ~300 MW…');
  await page.evaluate(() => {
    document.querySelector('#ramp').value = '8';
    document.querySelector('#btnRamp').click();
    document.querySelector('#loadSp').value = '300';
    document.querySelector('#btnLoad').click();
  });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = await page.evaluate(() => ({
      mode: document.querySelector('#mode').textContent,
      mw: parseFloat(document.querySelector('#hMW').textContent || '0'),
    }));
    if (st.mw > 420) break;
    if (st.mode === 'TRIPPED') { console.log('   (unit tripped during loading — keeping the loaded screenshots)'); break; }
  }
  await sleep(2500);

  await shot('02-unit-on-load.png');

  // --- boiler island -----------------------------------------------------
  await page.evaluate(() => document.querySelector('#viewbtns button[data-view="boilers"]').click());
  await sleep(1800);
  await shot('03-boiler-island.png');

  // --- turbine hall ------------------------------------------------------
  await page.evaluate(() => document.querySelector('#viewbtns button[data-view="turbine"]').click());
  await sleep(1800);
  await shot('04-turbine-hall.png');

  // --- cooling tower -----------------------------------------------------
  await page.evaluate(() => document.querySelector('#viewbtns button[data-view="tower"]').click());
  await sleep(1800);
  await shot('05-cooling-tower.png');

  // --- faults panel with a boiler tube leak injected ---------------------
  await page.evaluate(() => {
    document.querySelector('.tabs button[data-pane="faults"]').click();
  });
  await sleep(600);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-fault]'))
      .find(x => x.dataset.fault === 'TUBE_LEAK');
    if (b) b.click();
  });
  await sleep(6000);
  await shot('06-fault-injection.png');

  // --- alarms panel ------------------------------------------------------
  await page.evaluate(() => document.querySelector('.tabs button[data-pane="alarms"]').click());
  await sleep(1200);
  await page.evaluate(() => document.querySelector('#viewbtns button[data-view="furnace"]').click());
  await sleep(1600);
  await shot('07-alarms.png');

  // --- turbine supervisory panel ----------------------------------------
  await page.evaluate(() => document.querySelector('.tabs button[data-pane="turb"]').click());
  await sleep(900);
  await shot('08-turbine-panel.png');

  // --- plan view ---------------------------------------------------------
  await page.evaluate(() => document.querySelector('#viewbtns button[data-view="topDown"]').click());
  await sleep(1800);
  await shot('09-plan-view.png');

  if (process.env.SKIP_ADMIN === '1') { await browser.close(); console.log('done →', OUT); return; }

  // --- admin console -----------------------------------------------------
  const ap = await browser.newPage();
  await ap.setViewport({ width: 1500, height: 1250, deviceScaleFactor: 1 });
  await ap.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await ap.screenshot({ path: path.join(OUT, '10-admin-registration.png') });
  console.log('  saved 10-admin-registration.png');

  if (await ap.$('#regForm.hidden')) {
    // an administrator already exists on this installation — sign in instead
    await ap.type('#lu', 'chiefoperator');
    await ap.type('#lp', 'Simulator2026!');
    await ap.click('#logBtn');
    await sleep(3000);
    await ap.screenshot({ path: path.join(OUT, '11-admin-console.png'), fullPage: true });
    console.log('  saved 11-admin-console.png (signed in)');
    await browser.close();
    console.log('done →', OUT);
    return;
  }
  await ap.type('#u', 'chiefoperator');
  await ap.type('#e', 'ops@plant.local');
  await ap.type('#p', 'Simulator2026!');
  await ap.click('#regBtn');
  await sleep(4000);
  await ap.screenshot({ path: path.join(OUT, '11-admin-console.png'), fullPage: true });
  console.log('  saved 11-admin-console.png');

  await browser.close();
  console.log('done →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
