#!/usr/bin/env node
/**
 * test-api.js — HTTP and WebSocket API tests.
 *
 *   node tools/test-api.js
 *
 * Starts a throw-away instance of the server on its own port and data
 * directory, then exercises every public endpoint, the WebSocket feed and a
 * set of hostile / malformed inputs.
 */
'use strict';
process.env.PORT = process.env.TEST_PORT || '8099';
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = process.env.TEST_DATA || '/tmp/tcsim-api-test';
process.env.ADMIN_PATH = '/admin';

const fs = require('fs');
const { Suite } = require('./lib/suite.js');
const WebSocket = require('ws');

const app = require('../server/server.js');
const { server, plant } = app;
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const s = new Suite('HTTP & WebSocket API', 'feature');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, opts) => fetch(BASE + p, opts);
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

(async () => {
  await wait(600);   // let the server bind

  /* ---------------- public pages & assets ---------------- */
  await s.test('GET / serves the HMI', async () => {
    const r = await get('/');
    s.eq(r.status, 200, 'status');
    const t = await r.text();
    s.assert(/TWIN-BOILER COAL POWER PLANT/.test(t), 'title missing');
    s.assert(t.includes('importmap'), 'three.js import map missing');
    return { detail: `${(t.length / 1024).toFixed(0)} KB HTML` };
  });

  await s.test('static assets are served (/js/app.js, /vendor/three/three.module.js)', async () => {
    for (const p of ['/js/app.js', '/js/scene.js', '/js/audio.js', '/js/tutorial.js', '/vendor/three/three.module.js']) {
      const r = await get(p);
      s.eq(r.status, 200, `${p} status`);
      const ct = r.headers.get('content-type') || '';
      s.assert(/javascript|text\/plain/.test(ct), `${p} content-type ${ct}`);
    }
    return { detail: 'all modules + vendored Three.js served locally (works offline)' };
  });

  await s.test('unknown paths return a 404 and do not leak files', async () => {
    const r = await get('/does-not-exist');
    s.eq(r.status, 404, 'status');
    const t = await r.text();
    s.assert(/404/.test(t), '404 body');
    return { detail: '404 handler responds with plain text' };
  });

  /* ---------------- REST API ---------------- */
  await s.test('GET /api/snapshot returns a complete plant snapshot', async () => {
    const t0 = Date.now();
    const r = await get('/api/snapshot');
    const j = await r.json();
    s.eq(r.status, 200, 'status');
    for (const k of ['meta', 'plant', 'boilers', 'turbine', 'generator', 'condenser', 'bop', 'alarms', 'protection']) {
      s.assert(j[k] !== undefined, `snapshot missing "${k}"`);
    }
    s.eq(j.boilers.length, 2, 'boiler count');
    return { detail: `${Object.keys(j).length} top-level groups in ${Date.now() - t0} ms` };
  });

  await s.test('GET /api/design, /api/history and /api/faults respond correctly', async () => {
    const d = await (await get('/api/design')).json();
    s.assert(d.design && d.design.plant, 'design missing');
    s.assert(d.version && d.version.version, 'version missing');
    const h = await (await get('/api/history')).json();
    s.assert(Array.isArray(h.history), 'history is not an array');
    const f = await (await get('/api/faults')).json();
    s.assert(Array.isArray(f.faults) && f.faults.length >= 30, `only ${f.faults && f.faults.length} faults`);
    for (const x of f.faults) {
      s.assert(x.id && x.name && x.cause && x.symptoms && x.actions, `fault ${x.id} is incomplete`);
    }
    return { detail: `${f.faults.length} faults with cause, symptoms and operator actions` };
  });

  await s.test('POST /api/command applies operator commands', async () => {
    const r = await post('/api/command', { cmd: 'loadSetpoint', value: 321 });
    const j = await r.json();
    s.assert(j.ok, `command rejected: ${j.error}`);
    s.eq(Math.round(plant.targetLoad), 321, 'target load not applied');
    const r2 = await post('/api/command', { cmd: 'rampRate', value: 7 });
    s.assert((await r2.json()).ok, 'rampRate rejected');
    return { detail: 'loadSetpoint and rampRate applied' };
  });

  await s.test('POST /api/command with unknown or malformed input does not crash the server', async () => {
    const bad = [
      { cmd: 'notACommand', value: 1 },
      { cmd: 'loadSetpoint', value: 'not-a-number' },
      { cmd: 'loadSetpoint', value: null },
      { cmd: 12345, value: {} },
      {},
      { cmd: '__proto__', value: { polluted: true } },
    ];
    for (const body of bad) {
      const r = await post('/api/command', body);
      s.assert(r.status === 200 || r.status === 400, `status ${r.status} for ${JSON.stringify(body)}`);
    }
    s.assert(({}).polluted === undefined, 'prototype pollution!');
    const r = await get('/api/snapshot');
    s.eq(r.status, 200, 'server died after malformed commands');
    return { detail: `${bad.length} malformed payloads handled, no prototype pollution` };
  }, { severity: 'high' });

  await s.test('fault injection and clearing work through the API', async () => {
    const inj = await (await post('/api/fault/inject', { id: 'TUBE_LEAK', magnitude: 1 })).json();
    s.assert(inj.ok, 'inject failed');
    const f = await (await get('/api/faults')).json();
    s.assert(f.active.some((a) => a.id === 'TUBE_LEAK'), 'fault not listed as active');
    const clr = await (await post('/api/fault/clear', { id: 'TUBE_LEAK' })).json();
    s.assert(clr.ok, 'clear failed');
    const f2 = await (await get('/api/faults')).json();
    s.assert(!f2.active.some((a) => a.id === 'TUBE_LEAK'), 'fault still active after clear');
    return { detail: 'inject → listed → clear round trip' };
  });

  await s.test('injecting an unknown fault id is rejected cleanly', async () => {
    const r = await post('/api/fault/inject', { id: 'NO_SUCH_FAULT', magnitude: 5 });
    const j = await r.json();
    s.assert(j.ok === false, 'unknown fault was accepted');
    const r2 = await get('/api/snapshot');
    s.eq(r2.status, 200, 'server unhealthy after bad fault id');
    return { detail: 'rejected with ok:false, server still healthy' };
  });

  await s.test('clearing with "*" clears every active fault', async () => {
    await post('/api/fault/inject', { id: 'MILL_FIRE' });
    await post('/api/fault/inject', { id: 'ID_FAN_TRIP' });
    const j = await (await post('/api/fault/clear', { id: '*' })).json();
    s.assert(j.ok, 'clear all failed');
    const f = await (await get('/api/faults')).json();
    s.eq(f.active.length, 0, `${f.active.length} faults still active`);
    return { detail: 'all faults cleared' };
  });

  await s.test('oversized request bodies are rejected (1 MB JSON limit)', async () => {
    const big = 'x'.repeat(1_500_000);
    const r = await post('/api/command', { cmd: 'loadSetpoint', value: big });
    s.assert(r.status === 413 || r.status === 400, `status ${r.status} for a 1.5 MB body`);
    const r2 = await get('/api/snapshot');
    s.eq(r2.status, 200, 'server unhealthy after oversized body');
    return { detail: `oversized body → HTTP ${r.status}, server healthy` };
  });

  /* ---------------- WebSocket ---------------- */
  await s.test('WebSocket feed delivers welcome + snapshots and answers pings', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
    let welcome = null, snapshots = 0, pong = false;
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('no welcome within 8 s')), 8000);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "welcome") { welcome = m.data; clearTimeout(to); res(); }
      });
      ws.on('error', rej);
    });
    s.assert(welcome && welcome.meta, 'no welcome snapshot');
    s.assert(welcome.version, 'welcome has no version');
    s.assert(Array.isArray(welcome.faultCatalog), 'welcome has no fault catalogue');
    ws.send(JSON.stringify({ type: 'ping' }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'snapshot') snapshots++;
      if (m.type === 'pong') pong = true;
    });
    await wait(2500);
    s.assert(pong, 'no pong');
    s.assert(snapshots >= 5, `only ${snapshots} snapshots in 2.5 s (expected ~12 at 5 Hz)`);
    ws.close();
    return { detail: `${snapshots} snapshots in 2.5 s, ping/pong ok, version ${welcome.version.version}` };
  });

  await s.test('WebSocket accepts commands and rejects garbage without dying', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'command', cmd: 'speedFactor', value: 60 }));
    ws.send('}{ not json at all');
    ws.send(JSON.stringify({ type: 'injectFault', id: 'NOPE', magnitude: 1 }));
    ws.send(JSON.stringify({ type: 'clearFault', id: 'NOPE' }));
    ws.send(JSON.stringify({ nope: true }));
    await wait(800);
    s.eq(plant.speedFactor, 60, 'speedFactor command not applied');
    const r = await get('/api/snapshot');
    s.eq(r.status, 200, 'server died after malformed WebSocket frames');
    ws.close();
    return { detail: 'malformed frames ignored, server still broadcasting' };
  });

  await s.test('50 rapid commands are all handled without error', async () => {
    const t0 = Date.now();
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const j = await (await post('/api/command', { cmd: 'loadSetpoint', value: 100 + i })).json();
      if (j.ok) ok++;
    }
    s.eq(ok, 50, `${50 - ok} commands failed`);
    const r = await get('/api/snapshot');
    s.eq(r.status, 200, 'server unhealthy after a command burst');
    return { detail: `50 commands in ${Date.now() - t0} ms` };
  });

  await s.test('snapshot payload fits a 5 Hz feed', async () => {
    const r = await get('/api/snapshot');
    const txt = await r.text();
    s.assert(txt.length < 200_000, `${(txt.length / 1024).toFixed(0)} KB is too large for 5 Hz`);
    return { detail: `${(txt.length / 1024).toFixed(1)} KB per snapshot` };
  });

  s.done();
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(1); });
