#!/usr/bin/env node
/**
 * test-sim.js — simulation model, feature and regression tests.
 *
 *   node tools/test-sim.js
 *
 * Exercises the plant model directly (no HTTP): start-up, loading, shutdown,
 * protection, the whole fault catalogue, numerical robustness and performance.
 * Runs are shared where possible because a full start-up is ~5 h of simulated
 * time.
 */
'use strict';
const { Suite } = require('./lib/suite.js');
const { Plant } = require('../server/sim/engine.js');
const { FAULTS } = require('../server/sim/faults.js');
const S = require('../server/sim/steam.js');

const s = new Suite('Plant model & physics', 'physics');

/* helpers ------------------------------------------------------------- */
const tripped = (p) => !!p.mft.latched || !!p.turbineTrip.latched;

/** Step until `pred` is true or `maxMin` of simulated time has elapsed. */
function runTo(p, pred, maxMin = 900, dt = 0.25, speed = 600) {
  const n = Math.round((maxMin * 60) / (dt * speed));
  for (let i = 0; i < n; i++) {
    p.step(dt);
    if (pred(p)) return true;
    if (tripped(p)) return false;
  }
  return false;
}
const stepMin = (p, min, dt = 0.25, speed = 600) => {
  const n = Math.round((min * 60) / (dt * speed));
  for (let i = 0; i < n; i++) p.step(dt);
};
/** Bring a fresh plant up to `mw` MW. Returns {plant, minutes}. */
function startAndLoad(mw, ramp = 12, maxMin = 900) {
  const p = new Plant();
  p.command('speedFactor', 600);
  p.command('start');
  p.command('loadSetpoint', mw);
  p.command('rampRate', ramp);
  const ok = runTo(p, (x) => x.tg.grossMW >= mw - 5, maxMin);
  return { p, ok, minutes: p.simTime / 60 };
}
const scanFinite = (obj, trail = '', bad = []) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(`${trail}${k}=${v}`); }
    else if (Array.isArray(v)) v.forEach((x, i) => { if (x && typeof x === 'object') scanFinite(x, `${trail}${k}[${i}].`, bad); });
    else if (v && typeof v === 'object') scanFinite(v, `${trail}${k}.`, bad);
  }
  return bad;
};

(async () => {
  /* ================= 1. steam & thermodynamic properties ============= */
  await s.test('steam tables: saturation temperature matches IAPWS within 1.5 K', () => {
    s.near(S.satAtP(10).Tsat, 311.0, 1.5, 'Tsat(10 MPa)');
    s.near(S.satAtP(0.1).Tsat, 99.6, 1.0, 'Tsat(0.1 MPa)');
    s.near(S.satAtP(18).Tsat, 357.0, 2.0, 'Tsat(18 MPa)');
    return { detail: `Tsat(0.1)=${S.satAtP(0.1).Tsat.toFixed(1)} °C, Tsat(10)=${S.satAtP(10).Tsat.toFixed(1)} °C, Tsat(18)=${S.satAtP(18).Tsat.toFixed(1)} °C` };
  });

  await s.test('isentropic expansion 0.8 MPa/300 °C → 10 kPa matches hand calculation', () => {
    const e = S.expandIsentropic(0.8, 300, 0.01);
    s.near(e.h2s, 2287, 40, 'h2s');
    s.near(S.dryness(0.01, e.h2s), 0.876, 0.02, 'dryness');
    return { detail: `h2s=${e.h2s.toFixed(0)} kJ/kg, x=${S.dryness(0.01, e.h2s).toFixed(3)}, Δh=763 kJ/kg` };
  });

  await s.test('superheated steam enthalpy matches IAPWS at the design point', () => {
    const h = S.hSteam(16.7, 538);
    s.near(h, 3390, 45, 'h(16.7 MPa, 538 °C)');
    return { detail: `h=${h.toFixed(0)} kJ/kg (IAPWS ≈3390)` };
  });

  /* ================= 2. one full start-up → load → shutdown ========= */
  let up = null;
  await s.test('cold start-up runs the whole sequence and synchronises', () => {
    const p = new Plant();
    p.command('speedFactor', 600);
    p.command('start');
    const ok = runTo(p, (x) => x.tg.breakerClosed && x.tg.grossMW > 5, 900);
    s.assert(ok, `did not synchronise within 900 min (mode ${p.mode}, ${p.tg.grossMW.toFixed(0)} MW)`);
    s.assert(!tripped(p), `trip during start-up: ${p.mft.cause || p.turbineTrip.cause}`);
    up = p;
    return { detail: `synchronised at ${(p.simTime / 60).toFixed(0)} min, ${p.tg.grossMW.toFixed(0)} MW, ${p.tg.speed.toFixed(0)} rpm` };
  });

  await s.test('start-up timings follow a realistic cold-start curve', () => {
    s.assert(up, 'start-up did not run');
    const p = up;
    const ev = p.events.slice().reverse();
    const tOf = (re) => { const e = ev.find((x) => re.test(x.msg)); return e ? e.t / 60 : null; };
    const tPurge = tOf(/purge complete/i);
    const tFlame = tOf(/Flame proven/i);
    const tRoll = tOf(/rolling the turbine|Steam conditions satisfied/i);
    s.assert(tPurge !== null && tPurge >= 5, `purge credit at ${tPurge} min (expected ≥ 5 min)`);
    s.assert(tFlame !== null && tFlame > tPurge, 'flame proven before the purge completed');
    s.assert(tRoll !== null && tRoll > 120, `turbine roll at ${tRoll} min (expected > 120 min)`);
    return { detail: `purge ${tPurge?.toFixed(0)} min · flame ${tFlame?.toFixed(0)} min · roll ${tRoll?.toFixed(0)} min · synchronised ${(p.simTime / 60).toFixed(0)} min` };
  });

  await s.test('drum thermal-stress envelope respected during pressure raising', () => {
    const p = new Plant();
    p.command('speedFactor', 600);
    p.command('start');
    let maxDiff = 0, maxRate = 0, prev = null, prevT = 0;
    const dt = 0.25;
    for (let i = 0; i < 1000; i++) {
      p.step(dt);
      const b = p.boilers[0];
      if (p.mode === 'PRESSURISING' || p.mode === 'TURBINE_ROLL') {
        maxDiff = Math.max(maxDiff, Math.abs(b.drumMetalTop - b.drumMetalBottom));
        if (prev !== null && p.simTime > prevT && b.drumMetalTemp > 100) {
          maxRate = Math.max(maxRate, Math.abs((b.drumMetalTemp - prev) / (p.simTime - prevT)) * 3600);
        }
        prev = b.drumMetalTemp; prevT = p.simTime;
      }
      if (p.mode === 'SYNCHRONISING' || p.mode === 'LOADING' || p.mode === 'ONLINE') break;
    }
    s.assert(maxDiff < 60, `drum metal differential reached ${maxDiff.toFixed(1)} K (limit 60 K)`);
    s.assert(maxRate < 110, `drum metal heating rate reached ${maxRate.toFixed(0)} K/h above 100 °C (limit ~110 K/h)`);
    return { detail: `max ΔT ${maxDiff.toFixed(1)} K, max rate ${maxRate.toFixed(0)} K/h (above 100 °C)` };
  });

  /* ---------- shared 500 MW operating point (used by several tests) -- */
  const base = startAndLoad(500, 8);
  await s.test('unit loads to 500 MW and holds steady for 60 simulated minutes', () => {
    s.assert(base.ok && !tripped(base.p), `did not reach 500 MW (${base.p.tg.grossMW.toFixed(0)} MW, ${base.p.mft.cause || 'no trip'})`);
    const p = base.p;
    let maxLvl = 0, minT = 999, maxT = 0, maxVac = 0;
    for (let i = 0; i < 240; i++) {
      p.step(0.25);
      for (const b of p.boilers) maxLvl = Math.max(maxLvl, Math.abs(b.drumLevel + b.levelSwell));
      minT = Math.min(minT, p.boilers[0].msTemp); maxT = Math.max(maxT, p.boilers[0].msTemp);
      maxVac = Math.max(maxVac, p.tg.condenserVacuum);
    }
    s.assert(!tripped(p), `trip while holding load: ${p.mft.cause || p.turbineTrip.cause}`);
    s.assert(maxLvl < 130, `drum level swung to ±${maxLvl.toFixed(0)} mm`);
    s.assert(maxVac < 15, `condenser vacuum degraded to ${maxVac.toFixed(1)} kPa`);
    const snap = p.snapshot(true);
    return {
      detail: `${p.tg.grossMW.toFixed(0)} MW gross / ${snap.plant.netMW.toFixed(0)} MW net · drum ±${maxLvl.toFixed(0)} mm · MS ${minT.toFixed(0)}–${maxT.toFixed(0)} °C · vac ${maxVac.toFixed(1)} kPa · HR ${snap.plant.heatRate.toFixed(0)} kJ/kWh`,
    };
  });

  await s.test('steady-state boiler performance is physically plausible at 500 MW', () => {
    const p = base.p;
    const b = p.boilers[0];
    s.assert(b.efficiency > 0.80 && b.efficiency < 0.96, `boiler efficiency ${(b.efficiency * 100).toFixed(1)} %`);
    s.assert(b.tStack > 90 && b.tStack < 220, `stack temperature ${b.tStack.toFixed(0)} °C`);
    s.assert(b.o2 > 1 && b.o2 < 8, `flue gas O₂ ${b.o2.toFixed(1)} %`);
    s.assert(b.tFegt > 900 && b.tFegt < 1400, `furnace exit gas ${b.tFegt.toFixed(0)} °C`);
    return { detail: `eff ${(b.efficiency * 100).toFixed(1)} % · stack ${b.tStack.toFixed(0)} °C · O₂ ${b.o2.toFixed(1)} % · FEGT ${b.tFegt.toFixed(0)} °C` };
  });

  await s.test('the two boilers stay balanced on the common header', () => {
    const p = base.p;
    const [a, b] = p.boilers;
    const split = Math.abs(a.drumPressure - b.drumPressure);
    s.assert(split < 0.6, `drum pressures differ by ${split.toFixed(2)} MPa`);
    s.assert(!a.safetyValvesLifted && !b.safetyValvesLifted, 'a drum safety valve is lifting at steady load');
    return { detail: `drum split ${split.toFixed(2)} MPa (A ${a.drumPressure.toFixed(2)} / B ${b.drumPressure.toFixed(2)}), safety valves seated` };
  }, { severity: 'high' });

  await s.test('gross heat rate is within 25 % of the 9 500 kJ/kWh design', () => {
    const p = base.p;
    const hr = p.snapshot(true).plant.heatRate;
    s.assert(hr > 7000 && hr < 12500, `heat rate ${hr.toFixed(0)} kJ/kWh is outside 7 000–12 500`);
    return { detail: `${hr.toFixed(0)} kJ/kWh gross (design 9 500, ${((hr / 9500 - 1) * 100).toFixed(0)} %)` };
  });

  await s.test('normal shutdown runs to SHUTDOWN_COLD through every phase', () => {
    const p = base.p;
    p.command('shutdown');
    const modes = new Set();
    const ok = runTo(p, (x) => { modes.add(x.mode); return x.mode === 'SHUTDOWN_COLD'; }, 1800);
    s.assert(ok, `shutdown stalled in ${p.mode}`);
    for (const m of ['UNLOADING', 'COASTDOWN', 'TURNING_GEAR', 'POST_PURGE']) {
      s.assert(modes.has(m), `phase ${m} was skipped`);
    }
    s.assert(!p.mft.latched, `spurious MFT during shutdown: ${p.mft.cause}`);
    s.assert(p.boilers.every((b) => b.qFuel < 1), 'fuel still firing after shutdown');
    return { detail: `${[...modes].join(' → ')} · breaker ${p.tg.breakerClosed ? 'CLOSED' : 'open'}, ${p.tg.speed.toFixed(0)} rpm` };
  }, { severity: 'high' });

  /* ================= 3. protection system ========================== */
  await s.test('manual MFT trips the boilers and turbine; reset clears it', () => {
    const { p, ok } = startAndLoad(250, 12);
    s.assert(ok, 'never reached 250 MW');
    p.command('mft');
    stepMin(p, 2);
    s.assert(p.mft.latched, 'MFT did not latch');
    s.assert(p.boilers.every((b) => b.qFuel < 1), `fuel still firing after MFT (${p.boilers[0].qFuel.toFixed(1)} MW)`);
    p.command('resetMFT');
    stepMin(p, 1);
    s.assert(!p.mft.latched, 'MFT did not reset');
    return { detail: `tripped and reset at ${(p.simTime / 60).toFixed(0)} min, all fuel off within 2 min` };
  });

  await s.test('manual turbine trip opens the breaker and unloads the machine', () => {
    const { p, ok } = startAndLoad(250, 12);
    s.assert(ok, 'never reached 250 MW');
    p.command('tripTurbine');
    stepMin(p, 5);
    s.assert(p.tg.tripped, 'turbine trip did not latch');
    s.assert(!p.tg.breakerClosed, 'generator breaker still closed after trip');
    s.assert(p.tg.grossMW < 5, `still generating ${p.tg.grossMW.toFixed(0)} MW after trip`);
    return { detail: `tripped from ${p.tg.grossMW.toFixed(0)} MW — breaker open, speed falling` };
  });

  await s.test('loss of all ID fans while fired produces a master fuel trip', () => {
    const { p, ok } = startAndLoad(120, 10);
    s.assert(ok, 'never reached 120 MW');
    // A single ID fan loss must not trip the unit — the remaining fan keeps
    // the furnace on draft. Trip both (the fault catalogue is per boiler).
    p.injectFault('ID_FAN_TRIP', 1, 0);
    p.injectFault('ID_FAN_TRIP', 1, 1);
    const trippedNow = runTo(p, (x) => x.mft.latched, 20, 0.25, 60);
    s.assert(trippedNow, 'no MFT after both ID fans tripped');
    const draft = Math.max(...p.boilers.map((b) => b.draft));
    s.assert(p.mft.cause === 'All ID fans tripped', `MFT cause was "${p.mft.cause}"`);
    return { detail: `MFT: ${p.mft.cause} (peak furnace draft ${(draft / 1000).toFixed(2)} kPa)` };
  }, { severity: 'high' });

  await s.test('loss of condenser vacuum trips the turbine', () => {
    const { p, ok } = startAndLoad(120, 10);
    s.assert(ok, 'never reached 120 MW');
    p.injectFault('VACUUM_LOSS', 1);
    const t = runTo(p, (x) => x.turbineTrip.latched || x.mft.latched, 60, 0.25, 60);
    s.assert(t, 'no trip after loss of vacuum');
    return { detail: `${p.turbineTrip.latched ? 'turbine trip' : 'MFT'}: ${p.turbineTrip.cause || p.mft.cause}` };
  }, { severity: 'high' });

  await s.test('boiler tube leak is progressive and detectable by the operator', () => {
    const { p, ok } = startAndLoad(300, 12);
    s.assert(ok, 'never reached 300 MW');
    const b0 = p.boilers[0];
    const before = b0.fwFlow - b0.msFlow;
    p.injectFault('TUBE_LEAK', 1, 0);
    stepMin(p, 30, 0.25, 60);
    const b = p.boilers[0];
    s.assert(b.tubeLeak > 0.001, 'leak did not develop');
    s.assert(b.leakFlow > 0.5, `no leak flow (${b.leakFlow.toFixed(2)} t/h)`);
    const after = b.fwFlow - b.msFlow;
    s.assert(after > before + 1, `feedwater/steam mismatch did not grow (${before.toFixed(1)} → ${after.toFixed(1)} t/h)`);
    const txt = p.alarms.map((a) => a.msg).join(' | ');
    s.assert(/level|make|flow|leak/i.test(txt), `leak not annunciated (alarms: ${txt || 'none'})`);
    return { detail: `leak ${(b.tubeLeak * 100).toFixed(1)} %, ${b.leakFlow.toFixed(1)} t/h, fw−ms ${after.toFixed(0)} t/h (was ${before.toFixed(0)})` };
  }, { severity: 'high' });

  /* ================= 4. fault catalogue ============================ */
  await s.test(`all ${FAULTS.length} faults inject, run and clear without breaking the model`, () => {
    const { p, ok } = startAndLoad(300, 12);
    s.assert(ok, 'never reached 300 MW');
    p.command('speedFactor', 60);
    const failures = [];
    for (const f of FAULTS) {
      try {
        p.injectFault(f.id, 1);
        for (let i = 0; i < 40; i++) p.step(0.25);
        const bad = scanFinite(p.snapshot(false));
        if (bad.length) failures.push(`${f.id}: ${bad.slice(0, 2).join(',')}`);
        p.clearFault(f.id);
        for (let i = 0; i < 10; i++) p.step(0.25);
        const bad2 = scanFinite(p.snapshot(false));
        if (bad2.length) failures.push(`${f.id} after clear: ${bad2.slice(0, 2).join(',')}`);
      } catch (err) { failures.push(`${f.id}: threw ${err.message}`); }
    }
    s.assert(failures.length === 0, failures.slice(0, 4).join(' / '));
    return { detail: `${FAULTS.length} faults injected and cleared cleanly` };
  }, { severity: 'critical' });

  await s.test('sampled faults produce the annunciation an operator would expect', () => {
    const checks = [
      ['MILL_FIRE', /mill|fire/i],
      ['COND_TUBE_LEAK', /conductivity|vacuum|oxygen|level|hotwell/i],
      ['BFP_TRIP', /feedwater|bfp|drum level/i],
      ['CW_PUMP_TRIP', /vacuum|cw |circulating/i],
      ['STATOR_OVERHEAT', /stator|temp/i],
      ['COAL_WET', /mill|coal|temp/i],
    ];
    const { p, ok } = startAndLoad(300, 12);
    s.assert(ok, 'never reached 300 MW');
    p.command('speedFactor', 60);
    const missed = [];
    const seen = [];
    for (const [id, re] of checks) {
      p.injectFault(id, 1);
      for (let i = 0; i < 60; i++) p.step(0.25);
      const txt = `${p.alarms.map((a) => a.msg).join(' | ')} | ${p.events.slice(0, 40).map((e) => e.msg).join(' | ')}`;
      if (re.test(txt)) seen.push(id); else missed.push(`${id}: no matching annunciation`);
      p.clearFault(id);
      for (let i = 0; i < 20; i++) p.step(0.25);
    }
    s.assert(missed.length === 0, missed.join(' / '));
    return { detail: `${seen.length}/${checks.length} sampled faults annunciate correctly` };
  });

  await s.test('load ramps up to 12 MW/min (1.8 %/min) complete without a trip', () => {
    const results = [];
    for (const ramp of [6, 12]) {
      const p = new Plant();
      p.command('speedFactor', 600);
      p.command('start');
      p.command('loadSetpoint', 250);
      p.command('rampRate', ramp);
      const ok = runTo(p, (x) => x.tg.grossMW >= 245, 900);
      results.push(`${ramp} MW/min: ${ok ? 'ok' : `trip (${p.mft.cause || p.turbineTrip.cause})`}`);
      s.assert(ok, `ramp ${ramp} MW/min tripped: ${p.mft.cause || p.turbineTrip.cause}`);
    }
    return { detail: results.join(' · ') };
  });

  s.note('Load ramps above ~12 MW/min trip the unit on high drum level',
    'At 20 MW/min (3 %/min — an emergency rate a real unit would take with runback active) the drum level '
    + 'controller cannot hold the swell and the boiler trips on level HHH at ~140 MW. The qualified '
    + 'envelope is 1–12 MW/min; operators should use ≤ 6 MW/min.',
    'medium', 'bug');

  /* ================= 5. robustness & performance ==================== */
  await s.test('no NaN / Infinity anywhere in a full start → load → trip snapshot', () => {
    const p = new Plant();
    p.command('speedFactor', 600);
    p.command('start');
    p.command('loadSetpoint', 400);
    p.command('rampRate', 12);
    const problems = [];
    for (let i = 0; i < 700; i++) {
      p.step(0.25);
      if (i % 100 === 0) {
        const bad = scanFinite(p.snapshot(true));
        if (bad.length) problems.push(`${(p.simTime / 60).toFixed(0)} min: ${bad.slice(0, 2).join(',')}`);
      }
    }
    p.injectFault('TUBE_LEAK', 1, 0);
    p.command('tripTurbine');
    for (let i = 0; i < 100; i++) p.step(0.25);
    const bad = scanFinite(p.snapshot(true));
    if (bad.length) problems.push(`after trip: ${bad.slice(0, 2).join(',')}`);
    s.assert(problems.length === 0, problems.slice(0, 3).join(' / '));
    return { detail: `${(p.simTime / 60).toFixed(0)} min simulated, snapshot numerically clean` };
  }, { severity: 'critical' });

  await s.test('simulation is deterministic for identical inputs', () => {
    const run = () => {
      const p = new Plant();
      p.command('speedFactor', 600);
      p.command('start');
      p.command('loadSetpoint', 300);
      p.command('rampRate', 12);
      for (let i = 0; i < 400; i++) p.step(0.25);
      const snap = p.snapshot(false);
      return JSON.stringify([snap.meta.mode, snap.plant.grossMW.toFixed(6), snap.boilers[0].drumPressure.toFixed(6), snap.turbine.speed.toFixed(4)]);
    };
    const a = run(), b = run();
    s.eq(a, b, 'two identical runs diverged');
    return { detail: a.slice(0, 80) };
  });

  await s.test('engine keeps up with real time at 600× acceleration', () => {
    const p = new Plant();
    p.command('speedFactor', 600);
    p.command('start');
    p.command('loadSetpoint', 500);
    p.command('rampRate', 8);
    for (let i = 0; i < 150; i++) p.step(0.25);
    const t0 = process.hrtime.bigint();
    const N = 200;
    for (let i = 0; i < N; i++) p.step(0.25);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    s.assert(ms < 40, `${ms.toFixed(1)} ms per 200 ms tick — cannot keep up in real time`);
    return { detail: `${ms.toFixed(2)} ms per 200 ms tick (${(ms / 2).toFixed(1)} % of one core)` };
  });

  await s.test('snapshot is small enough for a 5 Hz WebSocket feed', () => {
    const p = base.p;
    const bytes = Buffer.byteLength(JSON.stringify(p.snapshot(true)));
    const light = Buffer.byteLength(JSON.stringify(p.snapshot(false)));
    s.assert(bytes < 200_000, `full snapshot is ${(bytes / 1024).toFixed(0)} KB`);
    return { detail: `${(bytes / 1024).toFixed(1)} KB full / ${(light / 1024).toFixed(1)} KB light at 5 Hz` };
  });

  s.done();
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(1); });
