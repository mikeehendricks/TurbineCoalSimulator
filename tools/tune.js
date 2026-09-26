/**
 * tune.js — automatic calibration of the boiler heat-transfer constants.
 *
 * Coordinate-descent search on the empirical coefficients in server/sim/heat.js
 * so that the steady-state MCR heat balance lands on the plant design figures.
 *
 *   node tools/tune.js [iterations]
 */
'use strict';
const S = require('../server/sim/steam.js');
const { Boiler } = require('../server/sim/plant.js');
const H = require('../server/sim/heat.js');

const COAL = 155, PDRUM = 18.1, STEAM = 1010;

function run(over, steps = 2600) {
  Object.assign(H, over);
  const b = new Boiler(0);
  b.inService = true; b.drumPressure = PDRUM; b.msFlow = STEAM; b.msPressure = PDRUM - 1.2;
  b.drumLevel = 0; b.fwFlow = STEAM + 8; b.fwTemp = 250; b.fwPressure = PDRUM + 2.4;
  b.rhFlow = STEAM * 0.877; b.rhPressure = 3.9; b.rhInTemp = 320;
  b.msTemp = 500; b.rhOutTemp = 500; b.econOutletTemp = 300;
  b.tFegt = 1000; b.tStack = 150; b.aphAirOut = 320; b.furnaceTemp = 1200;
  b.fdRunning = b.idRunning = b.paRunning = true;
  b.fdSpeed = 82; b.idSpeedBase = 84; b.idSpeed = 84; b.paSpeed = 80;
  b.fuelDemand = COAL;
  b.mills.forEach((m, i) => { m.running = i < 4; m.coalFlow = COAL / 4; m.outletTemp = 78; m.feederSpeed = 100; });
  b.excessAir = 0.20; b.tempCtrlAuto = true; b.draftAuto = false; b.rhGasDamper = 50;
  const dt = 1.0;
  for (let i = 0; i < steps; i++) {
    b.step({ dt, ambient: 30, wetBulb: 26, steamDemand: STEAM, activeBoilers: 2, fgdRunning: true, time: i * dt, wetCoal: 0 });
    b.drumPressure = PDRUM; b.msFlow = STEAM; b.fwFlow = STEAM + 8;
  }
  return {
    tSh: S.tSteam(b.msPressure, S.satAtP(b.drumPressure).hg + (b.qShRad + b.qShConv) / (STEAM / 3.6)),
    msT: b.msTemp, rhT: b.rhOutTemp, fegt: b.tFegt, stack: b.tStack, air: b.aphAirOut,
    econT: b.econOutletTemp, qWW: b.qWW / 1000, qSh: (b.qShRad + b.qShConv) / 1000,
    qRh: b.qRh / 1000, qEc: b.qEcon / 1000, eff: b.efficiency * 100,
    spray: b.spray1 + b.spray2, s1: b.spray1, s2: b.spray2,
  };
}

// targets
const T = { tSh: 552,
  msT: 538, rhT: 538, fegt: 1200, stack: 155, air: 325, econT: 332,
  qWW: 257.6, qSh: 245.8, qRh: 134.2, qEc: 138.6, eff: 88.5, spray: 25, s1: 25, s2: 25,
};
const W = { tSh: 0.15, msT: 6.0, rhT: 6.0, fegt: 0.05, stack: 0.12, air: 3.0, econT: 0.20, qWW: 1.2, qSh: 1.2, qRh: 1.2, qEc: 0.8, eff: 0.35, spray: 0.25, s1: 0.0, s2: 0.0 };

function cost(r) {
  let c = 0;
  for (const k of Object.keys(T)) c += W[k] * Math.pow((r[k] - T[k]) / Math.max(1, Math.abs(T[k])) * 100, 2);
  return c;
}

const P = ['K_WW', 'K_SH', 'UA_SH', 'UA_RH', 'UA_EC', 'UA_APH'];
const BASE = {};
for (const k of P) BASE[k] = H[k];
const SCALE = { K_WW: 1e-11, K_SH: 1e-11, UA_SH: 100, UA_RH: 100, UA_EC: 100, UA_APH: 100, DISSOCIATION: 0.05 };
// work in scaled space
const cur = {}; for (const k of P) cur[k] = BASE[k] / SCALE[k];
const apply = () => { const o = {}; for (const k of P) o[k] = cur[k] * SCALE[k]; return o; };

let best = run(apply());
let bestC = cost(best);
console.log('start cost', bestC.toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(best).map(([k, v]) => [k, +v.toFixed(1)]))));

const iters = Number(process.argv[2] || 6);
for (let it = 0; it < iters; it++) {
  for (const k of P) {
    const orig = cur[k];
    for (const dir of [1, -1]) {
      for (let mag = 1; mag <= 4; mag++) {
        cur[k] = orig * (1 + dir * 0.18 * mag);
        if (k === 'DISSOCIATION') { if (cur[k] * SCALE[k] > 0.98 || cur[k] * SCALE[k] < 0.6) { cur[k] = orig; break; } }
        const r = run(apply());
        const c = cost(r);
        if (c < bestC - 1e-6) { bestC = c; best = { ...r }; best._k = k; break; }
        cur[k] = orig;
      }
      if (cur[k] !== orig) break;
    }
  }
  console.log(`iter ${it} cost ${bestC.toFixed(1)}`, JSON.stringify(Object.fromEntries(Object.entries(best).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]))));
}
console.log('\nfitted constants:');
for (const k of P) console.log(`  ${k}: ${(cur[k] * SCALE[k]).toPrecision(4)},`);
console.log('\nfinal metrics:', JSON.stringify(Object.fromEntries(Object.entries(best).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]))));
