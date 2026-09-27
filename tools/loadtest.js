#!/usr/bin/env node
/**
 * loadtest.js — headless load-ramp test.
 *
 *   node tools/loadtest.js [--target=660] [--ramp=4] [--speed=600] [--trace]
 *
 * Runs a cold start-up and ramps the unit to the requested load, reporting
 * whether it arrives, trips, or stalls, plus the stability of the key
 * controlled variables once it is there.
 */
'use strict';
const { Plant } = require('../server/sim/engine.js');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const TARGET = arg('target', 660);
const RAMP = arg('ramp', 4);
const SPEED = arg('speed', 600);
const TRACE = process.argv.includes('--trace');

const p = new Plant();
p.command('speedFactor', SPEED);
p.command('start');
p.command('loadSetpoint', TARGET);
p.command('rampRate', RAMP);

let nextTrace = 0;
let reached = null;
let result = 'STALLED';
const t0 = Date.now();

for (let i = 0; i < 400000; i++) {
  p.step(0.25);
  const b0 = p.boilers[0];
  if (TRACE && p.simTime >= nextTrace) {
    nextTrace += 1800;
    console.log(`t=${(p.simTime / 60).toFixed(0).padStart(4)}min ${p.mode.padEnd(14)}` +
      ` MW=${p.tg.grossMW.toFixed(0).padStart(3)} P=${b0.drumPressure.toFixed(2)}` +
      ` pSp=${p.pressureSetpoint.toFixed(2)} fuel=${(p.lastFuelCmd || 0).toFixed(0)}` +
      ` ms=${b0.msFlow.toFixed(0)} lvl=${(b0.drumLevel + b0.levelSwell).toFixed(0)}` +
      ` msT=${b0.msTemp.toFixed(0)} vac=${p.tg.condenserVacuum.toFixed(1)}`);
  }
  if (p.tg.grossMW >= TARGET - 6 && reached === null) {
    reached = p.simTime;
    // hold for 60 simulated minutes and check stability
    let worst = 0, worstT = 0, worstVac = 0;
    for (let k = 0; k < 60 * 60 * 4 / SPEED * 60; k++) {   // ~60 sim-minutes
      p.step(0.25);
      if (p.simTime - reached > 3600) break;
      worst = Math.max(worst, Math.abs(p.boilers[0].drumLevel + p.boilers[0].levelSwell),
        Math.abs(p.boilers[1].drumLevel + p.boilers[1].levelSwell));
      worstT = Math.max(worstT, Math.max(p.boilers[0].msTemp, p.boilers[1].msTemp));
      worstVac = Math.max(worstVac, p.tg.condenserVacuum);
    }
    result = (p.mft.latched || p.turbineTrip.latched) ? 'TRIPPED-ON-HOLD' : 'REACHED';
    console.log(JSON.stringify({
      result,
      target: TARGET,
      ramp: RAMP,
      minutesToTarget: +(reached / 60).toFixed(1),
      finalMW: +p.tg.grossMW.toFixed(1),
      netMW: +p.snapshot(false).plant.netMW.toFixed(1),
      drumPressure: +p.boilers[0].drumPressure.toFixed(2),
      maxDrumLevel: +worst.toFixed(0),
      maxMsTemp: +worstT.toFixed(0),
      maxVacuum: +worstVac.toFixed(1),
      heatRate: +p.snapshot(false).plant.heatRate.toFixed(0),
      alarms: p.alarms.map((a) => a.msg),
      wallSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    }, null, 2));
    break;
  }
  if (p.mft.latched || p.turbineTrip.latched) {
    result = 'TRIPPED';
    console.log(JSON.stringify({
      result,
      target: TARGET,
      ramp: RAMP,
      tripAtMin: +(p.simTime / 60).toFixed(0),
      peakMW: +p.tg.grossMW.toFixed(0),
      mftCause: p.mft.cause,
      mftReasons: p.mft.reasons,
      turbineTrip: p.turbineTrip.cause,
      events: p.events.slice(0, 10).map((e) => `${(e.t / 60).toFixed(0)}m ${e.cat} ${e.msg}`),
    }, null, 2));
    break;
  }
  if (p.simTime > 3600 * 30) { console.log(JSON.stringify({ result, target: TARGET, peakMW: +p.tg.grossMW.toFixed(0) })); break; }
}
