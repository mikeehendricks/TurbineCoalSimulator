/**
 * calib.js — steady-state boiler calibration harness.
 *
 * Drives ONE boiler with fixed boundary conditions at the MCR design point
 * (coal 155 t/h, drum 18.1 MPa, 1010 t/h steam, 886 t/h reheat) and reports
 * the resulting heat balance so the radiant / convective constants can be
 * tuned against the plant heat balance.
 *
 *   node tools/calib.js [coalTph] [pressureMPa] [steamTph]
 */
'use strict';
const S = require('../server/sim/steam.js');
const { Boiler } = require('../server/sim/plant.js');

const coal = Number(process.argv[2] || 155);
const pDrum = Number(process.argv[3] || 18.1);
const steam = Number(process.argv[4] || 1010);

const b = new Boiler(0);
b.inService = true;
b.drumPressure = pDrum;
b.msFlow = steam;
b.msPressure = pDrum - 1.2;
b.drumLevel = 0;
b.fwFlow = steam + 8;
b.fwTemp = 250;
b.fwPressure = pDrum + 2.4;
b.rhFlow = steam * 0.877;
b.rhPressure = 3.9;
b.rhInTemp = 320;
b.msTemp = 500;
b.rhOutTemp = 500;
b.econOutletTemp = 300;
b.tFegt = 1000; b.tStack = 150; b.aphAirOut = 320; b.furnaceTemp = 1200;
b.fdRunning = b.idRunning = b.paRunning = true;
b.fdSpeed = 82; b.idSpeedBase = 84; b.idSpeed = 84; b.paSpeed = 80;
b.fuelDemand = coal;
b.mills.forEach((m, i) => { m.running = i < 4; m.coalFlow = coal / 4; m.outletTemp = 78; m.feederSpeed = 100; });
b.excessAir = 0.20;
b.tempCtrlAuto = true;
b.draftAuto = false;

const dt = 0.5;
for (let i = 0; i < 40000; i++) {
  b.step({
    dt, ambient: 30, wetBulb: 26, steamDemand: steam, activeBoilers: 2,
    fgdRunning: true, time: i * dt, wetCoal: 0,
  });
  b.drumPressure = pDrum;            // hold the design pressure
  b.msFlow = steam;
  b.fwFlow = steam + 8;
}

const f = (v, n = 1) => v.toFixed(n).padStart(9);
const sat = S.satAtP(b.drumPressure);
console.log('=== MCR steady state (per boiler) ===');
console.log('coal            ', f(b.totalCoal), 't/h      qFuel     ', f(b.qFuel, 1), 'MW');
console.log('air             ', f(b.totalAir), 't/h      flue gas  ', f(b.mGas), 't/h');
console.log('O2              ', f(b.o2, 2), '%        excess air', f(b.excessAir * 100, 1), '%');
console.log('--- heat balance, MW ---');
const mw = (x) => (x / 1000);
console.log('qWW (evap)      ', f(mw(b.qWW), 1));
console.log('qSH radiant     ', f(mw(b.qShRad), 1));
console.log('qSH convective  ', f(mw(b.qShConv), 1));
console.log('qReheat         ', f(mw(b.qRh), 1));
console.log('qEconomiser     ', f(mw(b.qEcon), 1));
console.log('qAPH            ', f(mw(b.qAph), 1));
console.log('qABSORBED       ', f(mw(b.qAbsorbed), 1), '   efficiency', f(b.efficiency * 100, 1), '%');
console.log('loss moisture   ', f(mw(b.lossMoisture), 1), '  unburnt', f(mw(b.lossUnburnt), 1), '  rad', f(mw(b.lossRadiation), 1));
console.log('--- gas temperatures, degC ---');
console.log('T adiabatic     ', f(b.tAdiabatic, 0), '  flame/furnace', f(b.furnaceTemp, 0));
console.log('FEGT            ', f(b.tFegt, 0), '  after SH', f(b.tShOut, 0), '  after RH', f(b.tRhOut, 0));
console.log('after econ      ', f(b.tEconOut, 0), '  after APH', f(b.tAphOut, 0), '  stack', f(b.tStack, 0));
console.log('hot air out     ', f(b.aphAirOut, 0), '   draft', f(b.draft, 0), 'Pa');
console.log('--- steam side ---');
console.log('drum Tsat       ', f(sat.Tsat, 1), '  econ out', f(b.econOutletTemp, 0), 'C  h=', f(b.econOutletEnthalpy, 0));
console.log('MS temp         ', f(b.msTemp, 1), 'C   MS flow', f(b.msOutlet, 0), 't/h');
console.log('RH out temp     ', f(b.rhOutTemp, 1), 'C  RH flow', f(b.rhFlow, 0), 't/h');
console.log('spray 1 / 2     ', f(b.spray1, 1), f(b.spray2, 1), 't/h');
console.log('--- target ---');
console.log('design: MS 538 C, RH 538 C, FEGT 1150-1250, stack 140-170, hot air 300-340, eff 87-90 %');

// ---- internals dump -------------------------------------------------------
const mGasKg = b.mGas / 3.6;
const gr = Math.min(2, Math.max(0.02, mGasKg / 346));
const clean = 0.94 + 0.06 * (1 - b.slagging);
const cp = (t) => S.cpFlue(t);
console.log('--- internals ---');
console.log('gasRatio', gr.toFixed(3), 'clean', clean.toFixed(3), 'slagging', b.slagging.toFixed(3));
console.log('uaSh', (528 * Math.pow(gr, 0.65) * clean).toFixed(0),
  'uaRh', (246 * Math.pow(gr, 0.65) * clean).toFixed(0),
  'uaEc', (469 * Math.pow(gr, 0.65) * clean).toFixed(0),
  'uaAph', (514 * Math.pow(gr, 0.65) * clean).toFixed(0));
console.log('cGas  (kW/K) @FEGT', (mGasKg * cp(b.tFegt)).toFixed(0), ' mGasKg', mGasKg.toFixed(0));
console.log('rhGasDamper', (b.rhGasDamper||0).toFixed(0), 'rhBypass', (0.55 + 0.45 * (b.rhGasDamper||50) / 100).toFixed(3));
console.log('spray1Cmd', (b.spray1Cmd||0).toFixed(1), 'spray2Cmd', (b.spray2Cmd||0).toFixed(1), 'setpoint', (b.msTempSetpoint||0).toFixed(0));
console.log('fwPressure', b.fwPressure.toFixed(1), 'sprayAvail', (b.fwPressure > b.drumPressure + 1).toString());
console.log('econ h', b.econOutletEnthalpy.toFixed(0), 'econ T', b.econOutletTemp.toFixed(0), 'econDuty', (b.qEcon / 1000).toFixed(1));
const hSh = S.hSteam(b.msPressure, b.msTemp);
console.log('hMs', hSh.toFixed(0), 'needed for 538C', S.hSteam(b.msPressure, 538).toFixed(0),
  'SH duty needed MW', ((steam / 3.6) * (S.hSteam(b.msPressure, 538) - sat.hg) / 1000).toFixed(1));
console.log('RH duty needed MW', ((b.rhFlow / 3.6) * (S.hSteam(3.7, 538) - S.hSteam(3.9, 320)) / 1000).toFixed(1));
