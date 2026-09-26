/**
 * simcheck.js — headless validation harness.
 *   node tools/simcheck.js [minutes]
 * Runs the sequencer and prints a table of key parameters.
 */
'use strict';
const { Plant } = require('../server/sim/engine.js');

const minutes = Number(process.argv[2] || 60);
const plant = new Plant();
plant.speedFactor = 60;

const t0 = Date.now();
let lastLog = -1;
const dtReal = 0.2;                     // 200 ms per engine tick
const steps = Math.ceil((minutes * 60) / (dtReal * plant.speedFactor));

for (let i = 0; i < steps; i++) {
  plant.step(dtReal);
  if (i === 2) plant.command('start');
  const t = plant.simTime;
  if (t - lastLog >= 300) {
    lastLog = t;
    const s = plant.snapshot(false);
    const b = s.boilers[0];
    console.log(
      `${(t / 60).toFixed(0).padStart(5)}min ${s.meta.mode.padEnd(14)}`,
      `MW=${s.plant.grossMW.toFixed(0).padStart(4)}`,
      `rpm=${s.turbine.speed.toFixed(0).padStart(4)}`,
      `P=${b.drumPressure.toFixed(2).padStart(5)}`,
      `Tms=${b.msTemp.toFixed(0).padStart(3)}`,
      `Trh=${b.rhOutTemp.toFixed(0).padStart(3)}`,
      `lvl=${(b.drumLevel + b.levelSwell).toFixed(0).padStart(4)}`,
      `coal=${b.totalCoal.toFixed(0).padStart(3)}t/h`,
      `O2=${b.o2.toFixed(1).padStart(4)}`,
      `FEGT=${b.tFegt.toFixed(0).padStart(4)}`,
      `stack=${b.tStack.toFixed(0).padStart(3)}`,
      `spray=${(b.spray1 + b.spray2).toFixed(1).padStart(5)}`,
      `vac=${s.condenser.vacuum.toFixed(1).padStart(5)}`,
      `alarms=${s.alarms.length}`
    );
  }
}
const wall = (Date.now() - t0) / 1000;
console.log(`\nsimulated ${(plant.simTime / 60).toFixed(0)} min in ${wall.toFixed(1)} s wall (${(plant.simTime / wall).toFixed(0)}x real time)`);
const s = plant.snapshot(true);
console.log('mode', s.meta.mode, 'MW', s.plant.grossMW.toFixed(1), 'net', s.plant.netMW.toFixed(1),
  'heatRate', s.plant.heatRate.toFixed(0), 'eff', s.plant.efficiency.toFixed(1) + '%');
console.log('alarms:', s.alarms.slice(0, 20).map(a => `${a.prio}/${a.msg}`).join(' | ') || 'none');
console.log('events last 12:');
for (const e of s.events.slice(0, 12)) console.log('  ', (e.t / 60).toFixed(1).padStart(7), e.cat, e.msg);
