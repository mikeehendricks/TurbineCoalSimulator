/**
 * engine.js — Simulation supervisor.
 *
 * Owns the plant model, the start-up / shut-down sequencer, the protection
 * system (MFT + turbine trip), the fault injector, the alarm system and the
 * production of the JSON snapshot that the HMI renders.
 */

'use strict';

const { DESIGN, LIMITS, STARTUP_ENVELOPE, RUNUP_PROGRAMME } = require('./constants.js');
const { Boiler, TurbineGenerator, BalanceOfPlant, PID, lag, rateLimit, clamp, lerp } = require('./plant.js');
const S = require('./steam.js');
const { FAULTS, FAULT_MAP } = require('./faults.js');

let alarmSeq = 1;

/* ------------------------------------------------------------------ *
 *  Alarm definitions
 * ------------------------------------------------------------------ */
const ALARMS = [
  { id: 'DRUM_LEVEL_LO', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} drum level LOW`, test: (s, b) => b.drumPressure > 0.4 && b.drumLevel < LIMITS.drum.levelLowAlarm },
  { id: 'DRUM_LEVEL_HI', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} drum level HIGH`, test: (s, b) => b.drumPressure > 0.4 && b.drumLevel > LIMITS.drum.levelHighAlarm },
  { id: 'DRUM_LEVEL_LLO', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} drum level LOW LOW — MFT`, test: (s, b) => b.drumPressure > 0.4 && b.drumLevel < LIMITS.drum.levelLowTrip },
  { id: 'DRUM_LEVEL_HHI', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} drum level HIGH HIGH — MFT`, test: (s, b) => b.drumPressure > 0.4 && b.drumLevel > LIMITS.drum.levelHighTrip },
  { id: 'SAFETY_VALVE', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} drum safety valves LIFTED`, test: (s, b) => !!b.safetyValvesLifted },
  { id: 'DRUM_PRESS_HI', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} drum pressure HIGH`, test: (s, b) => b.drumPressure > LIMITS.drum.pressureHighTrip },
  { id: 'FURNACE_DRAFT_HI', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} furnace draft HIGH`, test: (s, b) => b.qFuel > 2 && b.draft > LIMITS.furnace.draftHighAlarm },
  { id: 'FURNACE_DRAFT_LO', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} furnace draft LOW`, test: (s, b) => b.qFuel > 2 && b.draft < LIMITS.furnace.draftLowAlarm },
  { id: 'MS_TEMP_HI', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} main steam temperature HIGH`, test: (s, b) => b.msFlow > 150 && b.msTemp > DESIGN.steam.mainSteamTemp + 10 },
  { id: 'MS_TEMP_LO', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} main steam temperature LOW`, test: (s, b) => b.msTemp < 480 && b.msFlow > 200 },
  { id: 'RH_TEMP_HI', group: 'Boiler', prio: 'HIGH', msg: (s, i) => `Boiler ${tag(i)} reheat steam temperature HIGH`, test: (s, b) => b.rhOutTemp > DESIGN.steam.reheatOutletTemp + 10 },
  { id: 'FEGT_HI', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} furnace exit gas temperature HIGH`, test: (s, b) => b.qFuel > 50 && b.tFegt > LIMITS.furnace.fegtMax },
  { id: 'STACK_TEMP_HI', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} stack temperature HIGH`, test: (s, b) => b.qFuel > 30 && b.tStack > 200 },
  { id: 'O2_LO', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} flue gas O2 LOW`, test: (s, b) => b.qFuel > 50 && b.o2 < 1.6 },
  { id: 'CO_HI', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} CO HIGH — incomplete combustion`, test: (s, b) => b.qFuel > 50 && b.co > 250 },
  { id: 'TUBE_LEAK', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} TUBE LEAK detected`, test: (s, b) => b.tubeLeak > 0.05 },
  { id: 'MILL_TEMP_HI', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} mill outlet temperature HIGH`, test: (s, b) => b.mills.some(m => m.outletTemp > 105) },
  { id: 'MILL_FIRE', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} MILL FIRE`, test: (s, b) => b.mills.some(m => m.fire) || b.millFire },
  { id: 'APH_FIRE', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} AIR PREHEATER FIRE`, test: (s, b) => (b.aphFire || 0) > 0.05 },
  { id: 'FLAME_FAIL', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} LOSS OF FLAME`, test: (s, b) => b.lossOfIgnition },
  { id: 'ID_FAN_STOP', group: 'Boiler', prio: 'CRITICAL', msg: (s, i) => `Boiler ${tag(i)} ID fan NOT RUNNING`, test: (s, b) => !b.idRunning && b.qFuel > 1 },
  { id: 'FW_DEV', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} feedwater / steam flow deviation`, test: (s, b) => b.msFlow > 100 && Math.abs(b.fwFlow - b.msFlow) > 90 },
  { id: 'ECON_STEAMING', group: 'Boiler', prio: 'MEDIUM', msg: (s, i) => `Boiler ${tag(i)} economiser outlet approaching saturation`, test: (s, b) => b.econOutletTemp > S.satAtP(b.drumPressure).Tsat - 12 && b.drumPressure > 1 },

  { id: 'TURB_VIB_HI', group: 'Turbine', prio: 'HIGH', msg: () => 'Turbine vibration HIGH', test: (s) => s.turbine.vibrations.some(v => v > LIMITS.turbine.vibrationAlarm) },
  { id: 'TURB_VIB_TRIP', group: 'Turbine', prio: 'CRITICAL', msg: () => 'Turbine vibration TRIP', test: (s) => s.turbine.vibrations.some(v => v > LIMITS.turbine.vibrationTrip) },
  { id: 'TURB_OVERSPEED', group: 'Turbine', prio: 'CRITICAL', msg: () => 'Turbine OVERSPEED', test: (s) => s.turbine.speed > 3150 },
  { id: 'AXIAL_SHIFT_HI', group: 'Turbine', prio: 'HIGH', msg: () => 'Axial shift HIGH', test: (s) => s.turbine.axialShift > 0.6 },
  { id: 'ECC_HI', group: 'Turbine', prio: 'MEDIUM', msg: () => 'Rotor eccentricity HIGH', test: (s) => s.turbine.eccentricity > LIMITS.turbine.eccentricityAlarm },
  { id: 'LUBE_OIL_LO', group: 'Turbine', prio: 'CRITICAL', msg: () => 'Lubricating oil pressure LOW', test: (s) => s.turbine.speed > 200 && s.turbine.lubeOilPressure < 0.10 },
  { id: 'BRG_METAL_HI', group: 'Turbine', prio: 'HIGH', msg: () => 'Bearing metal temperature HIGH', test: (s) => s.turbine.bearingMetalTemps.some(t => t > 95) },
  { id: 'EXH_TEMP_HI', group: 'Turbine', prio: 'HIGH', msg: () => 'LP exhaust temperature HIGH', test: (s) => s.turbine.exhaustTemp > LIMITS.turbine.exhaustTempHigh },
  { id: 'VACUUM_LO', group: 'Turbine', prio: 'CRITICAL', msg: () => 'Condenser vacuum LOW', test: (s) => s.condenser.vacuum > LIMITS.turbine.vacuumLowTrip },
  { id: 'DIFF_EXP_HI', group: 'Turbine', prio: 'MEDIUM', msg: () => 'Differential expansion HIGH', test: (s) => Math.abs(s.plant.diffExpansion) > 9 },

  { id: 'STATOR_TEMP_HI', group: 'Generator', prio: 'HIGH', msg: () => 'Generator stator winding temperature HIGH', test: (s) => s.generator.statorTemp > 108 },
  { id: 'H2_PRESS_LO', group: 'Generator', prio: 'HIGH', msg: () => 'Hydrogen pressure LOW', test: (s) => s.generator.h2Pressure < LIMITS.generator.hydrogenPressureLow && s.turbine.breakerClosed },
  { id: 'H2_PURITY_LO', group: 'Generator', prio: 'MEDIUM', msg: () => 'Hydrogen purity LOW', test: (s) => s.generator.h2Purity < LIMITS.generator.hydrogenPurityLow },
  { id: 'GEN_OVERCURRENT', group: 'Generator', prio: 'HIGH', msg: () => 'Generator stator current HIGH', test: (s) => s.generator.statorCurrent > DESIGN.generator.current * 1.05 },

  { id: 'COND_LEVEL_HI', group: 'BOP', prio: 'MEDIUM', msg: () => 'Condenser hotwell level HIGH', test: (s) => s.condenser.hotwellLevel > 1500 },
  { id: 'COND_LEVEL_LO', group: 'BOP', prio: 'MEDIUM', msg: () => 'Condenser hotwell level LOW', test: (s) => s.condenser.hotwellLevel < 500 && s.turbine.condFlow > 10 },
  { id: 'COND_COND_HI', group: 'BOP', prio: 'HIGH', msg: () => 'Condensate conductivity HIGH — tube leak', test: (s) => s.condenser.conductivity > 0.3 },
  { id: 'DEA_LEVEL_LO', group: 'BOP', prio: 'MEDIUM', msg: () => 'Deaerator level LOW', test: (s) => s.bop.deaeratorLevel < 1200 },
  { id: 'BFP_TRIPPED', group: 'BOP', prio: 'CRITICAL', msg: () => 'No boiler feed pump running', test: (s) => !s.bop.bfp.some(p => p.running) && s.boilers.some(b => b.msFlow > 5) },
  { id: 'BUNKER_LO', group: 'BOP', prio: 'MEDIUM', msg: () => 'Coal bunker level LOW', test: (s) => s.bop.bunkerLevels.some(l => l < 20) },
  { id: 'IA_LO', group: 'BOP', prio: 'CRITICAL', msg: () => 'Instrument air pressure LOW', test: (s) => s.bop.instrumentAir < 0.45 },
  { id: 'OPACITY_HI', group: 'Emissions', prio: 'HIGH', msg: () => 'Stack opacity HIGH', test: (s) => s.emissions.opacity > 25 },
  { id: 'SO2_HI', group: 'Emissions', prio: 'HIGH', msg: () => 'SO2 emission HIGH', test: (s) => s.emissions.so2 > 400 },
  { id: 'NOX_HI', group: 'Emissions', prio: 'MEDIUM', msg: () => 'NOx emission HIGH', test: (s) => s.emissions.nox > 450 },
  { id: 'DUST_HI', group: 'Emissions', prio: 'HIGH', msg: () => 'Dust emission HIGH', test: (s) => s.emissions.dust > 50 },
  { id: 'GRID_FREQ', group: 'Emissions', prio: 'MEDIUM', msg: () => 'Grid frequency excursion', test: (s) => s.turbine.breakerClosed && Math.abs(s.plant.frequency - DESIGN.gridFrequency) > 0.25 },
];

/**
 * The operator manual desk.
 *
 * Every item here is a value the automatic controls write on every tick. Taking
 * one to MANUAL discards what the sequencer just decided and writes the
 * operator's number in its place — see applyManual(). Nothing else changes: the
 * protections still trip on what the plant actually does, so the desk is a way
 * to fly the unit badly, which is rather the point of a training simulator.
 *
 *   key          AUTO                              MANUAL (operator value)
 *   fd:<b>       %    sequencer sets FD speed      operator sets it
 *   id:<b>       %    sequencer sets ID speed      operator sets it (draft ctrl trims)
 *   pa:<b>       %    sequencer sets PA speed      operator sets it
 *   vent:<b>     t/h  start-up vent controller     operator sets the demand
 *   level:<b>    mm   3-element level control      operator sets feedwater flow (t/h)
 *   mstemp:<b>   °C   attemperator PID             operator sets stage-2 spray (%)
 *   rhtemp:<b>   °C   gas bypass damper to SP      operator sets the damper (%)
 *
 * `<b>` is the boiler index: 0 = A, 1 = B. The loop items carry a setpoint as
 * well as a manual position — the setpoint applies in AUTO, the position only
 * once the item is taken to MANUAL.
 */
const MANUAL_DESK = new Map([
  ['fd',     { label: 'FD fan speed',      unit: '%',   min: 0,  max: 100, step: 1 }],
  ['id',     { label: 'ID fan speed',      unit: '%',   min: 0,  max: 100, step: 1 }],
  ['pa',     { label: 'PA fan speed',      unit: '%',   min: 0,  max: 100, step: 1 }],
  ['vent',   { label: 'Start-up vent',     unit: 't/h', min: 0,  max: 600, step: 5 }],
  ['level',  { label: 'Drum level',        unit: 'mm',  min: -250, max: 250, step: 5,
               spDefault: 0, manualUnit: 't/h', manualMin: 0, manualMax: 1150 }],
  ['mstemp', { label: 'Main steam temp',   unit: '°C',  min: 470, max: 570, step: 1,
               spDefault: DESIGN.steam.mainSteamTemp, manualUnit: '%', manualMin: 0, manualMax: 100 }],
  ['rhtemp', { label: 'Reheat steam temp', unit: '°C',  min: 470, max: 570, step: 1,
               spDefault: DESIGN.steam.reheatOutletTemp, manualUnit: '%', manualMin: 0, manualMax: 100 }],
]);

function tag(i) { return i === 0 ? 'A' : 'B'; }

/* ------------------------------------------------------------------ *
 *  Sequencer operating procedure (what the operator should be doing)
 * ------------------------------------------------------------------ */
const PROCEDURE = {
  SHUTDOWN_COLD: [
    'Unit cold — all plant stopped, permit to work in force',
    'Press START to begin the cold start-up procedure',
  ],
  PRESTART: [
    'Start the lube-oil pump, jacking oil and turning gear',
    'Start a circulating-water pump and a condensate pump',
    'Start the vacuum pumps and pull vacuum on the condenser',
    'Charge the feedwater system, fill the drums to -50 mm',
    'Energise the ESP fields, start the FGD and the ash plant',
    'Verify all drains, vents and bypasses are in the start-up position',
  ],
  PURGE: [
    'Start an FD and an ID fan, establish >= 30 % air flow',
    'Purge the furnace for 5 minutes (4 furnace-volume changes)',
    'Verify the flame scanners and the MFT relays have reset',
  ],
  LIGHTOFF: [
    'Admit light fuel oil to elevation A ignitors',
    'Prove flame on at least 2 scanners within 10 s',
    'Establish a stable oil firing rate, warm the furnace slowly',
  ],
  PRESSURISING: [
    'Raise drum pressure following the start-up envelope (watch the drum metal differential)',
    'Start a mill when the furnace temperature exceeds 400 C',
    'Control the superheater outlet temperature with the start-up vent',
    'Carry out drum level and gauge-glass checks at 0.5 / 3 / 8 MPa',
    'Expand the turbine drains and warm the main steam lines',
  ],
  TURBINE_ROLL: [
    'Open the main steam stop valves, roll the turbine to 200 rpm',
    'Low-speed soak at 600 rpm — check vibration and eccentricity',
    'Pass the critical speeds without dwelling',
    'Soak at 1 800 rpm — check casing and differential expansion',
    'Raise to 3 000 rpm and hold the rated-speed soak',
  ],
  SYNCHRONISING: [
    'Switch the AVR to auto, match the generator voltage to the bus',
    'Match the frequency and phase angle on the synchroscope',
    'Close the generator circuit breaker',
  ],
  LOADING: [
    'Take 5 % initial load, hold for 30 minutes (soak the turbine)',
    'Close the turbine and boiler drains once the steam is dry',
    'Ramp load at 6.6 MW/min (1 %/min) to the target',
    'Transfer the boiler to coordinated control, put the sprays on auto',
  ],
  ONLINE: [
    'Unit on load — monitor the alarms and the trends',
    'Run the soot-blowing programme as scheduled',
    'Log the water/steam chemistry every shift',
  ],
  UNLOADING: [
    'Reduce load at 6.6 MW/min to 5 %',
    'Start the auxiliary oil pump, check it starts on auto',
    'Open the generator breaker at minimum load',
  ],
  COASTDOWN: [
    'Confirm the turbine has tripped and the stop valves are shut',
    'Monitor the run-down — vibration, eccentricity, oil pressure',
    'Engage the turning gear below 200 rpm',
  ],
  TURNING_GEAR: [
    'Turning gear running — keep the rotor on the gear until the casing is below 150 C',
    'Break the condenser vacuum, stop the gland-seal steam',
  ],
  FIREDOWN: [
    'Stop the mills in sequence, support with oil as required',
    'Reduce drum pressure at no more than 0.15 MPa/min',
    'Stop the oil when the pressure is below 3 MPa',
  ],
  POST_PURGE: [
    'Purge the furnace for 10 minutes after the last fuel is off',
    'Stop the FD and ID fans',
    'Box up the boiler for a cold shutdown or a hot standby',
  ],
  TRIPPED: [
    'MFT — confirm all fuel, mills and ignitors are tripped',
    'Purge the furnace before any re-light attempt',
    'Establish and record the cause before resetting the MFT relays',
    'Press ACKNOWLEDGE then RESET when the cause is cleared',
  ],
};

/* ================================================================== *
 *  PLANT
 * ================================================================== */
class Plant {
  constructor() {
    this.boilers = [new Boiler(0), new Boiler(1)];
    this.tg = new TurbineGenerator();
    this.bop = new BalanceOfPlant();
    this.grid = { frequency: DESIGN.gridFrequency, disturbance: 0, faultTimer: 0, demand: 660 };
    this.time = 0;
    this.simTime = 0;
    this.speedFactor = 1;
    this.faultBoiler = 0;
    this.activeFaults = new Map();
    this.alarms = [];
    this.events = [];
    this.mft = { latched: false, cause: '', time: 0, reasons: [] };
    this.turbineTrip = { latched: false, cause: '', time: 0 };
    this.alarmScan = 0;
    this.protTimers = {};
    this.autoStart = false;
    this.targetLoad = 660;
    this.autoRampLimit = 90;        // MW — where the automatic sequence hands over
    this.operatorMode = 'auto';
    this.manual = {};   // operator manual desk — see applyManual()
    this.loadRampRate = 4.0;       // MW/min (1 %/min of rated)
    this.pressureSetpoint = 0.101;
    this.startupPressureTarget = 8.0;
    this.masterFuel = 0;
    this.lastFuelCmd = null;
    this.boilerFlowCmd = null;
    this.loadHold = null;
    this.ventDemand = 0;
    this.totalCoalBurned = 0;
    this.energySentOut = 0;
    this.startTime = 0;
    this.runHours = 0;
    this.starts = 0;

    this.masterPressCtrl = new PID(20.0, 0.55, 0.0, 0, 560);
    // Boiler-follow pressure trim. The feed-forward does the bulk of the work;
    // this only has to correct the fuel/steam mismatch, so it is deliberately
    // slow — the boiler is an integrating process with minutes of dead time and
    // an aggressive pressure loop just chases the drum level around.
    this.boilerFollowCtrl = new PID(45.0, 0.35, 0.0, -200, 200, 100);
    this.presSeq = 0;
    this.ventCtrl = new PID(0.60, 0.03, 0.0, 0, 600);
    this.runupIndex = 0;
    this.soakTimer = 0;
    this.mode = 'SHUTDOWN_COLD';
    this.phaseTimer = 0;
    this.phaseNote = 'Unit cold and stopped';
    this.ackAlarms = new Set();
    this.history = [];
    this.histTimer = 0;
    this.reset(true);
  }

  /* ------------------------------------------------------------- */
  reset(hard = false) {
    // Everything the operator thinks of as "the run" goes back to zero: the
    // plant clock, the event journal and the trend history, as well as the unit
    // itself. Without the clock reset a cold unit kept an elapsed time from the
    // previous run, which put every soak timer and timestamp out of step.
    this.simTime = 0;
    this.events.length = 0;
    this.history.length = 0;
    this.histTimer = 0;
    for (const b of this.boilers) b.reset();
    this.tg.reset();
    this.bop.reset();
    this.bop.ambient = 29; this.bop.wetBulb = 25;
    this.bop.ambientTarget = 29; this.bop.wetBulbTarget = 25;
    this.activeFaults.clear();
    this.alarms = [];
    this.ackAlarms.clear();
    this.protTimers = {};
    this.mft = { latched: false, cause: '', time: 0, reasons: [] };
    this.turbineTrip = { latched: false, cause: '', time: 0 };
    this.mode = 'SHUTDOWN_COLD';
    this.phaseTimer = 0;
    this.presSeq = 0;
    this.ventCtrl = new PID(0.60, 0.03, 0.0, 0, 600);
    this.runupIndex = 0;
    this.soakTimer = 0;
    this.masterFuel = 0;
    this.lastFuelCmd = null;
    this.boilerFlowCmd = null;
    this.loadHold = null;
    this.ventDemand = 0;
    // A reset is a return to a cold unit, and part of that is handing every
    // loop back to the automatic controls: an operator who left a fan on
    // MANUAL and then reset would otherwise be looking at a plant that
    // ignores its own sequencer and cannot say why.
    this.manual = {};
    this.time = 0;
    this.grid.frequency = DESIGN.gridFrequency;
    this.grid.disturbance = 0;
    this.log('SYSTEM', 'Simulator reset — unit cold, all plant stopped');
  }

  log(cat, msg) {
    const stamp = new Date().toISOString();
    this.events.unshift({ t: this.simTime, wall: stamp, cat, msg });
    if (this.events.length > 400) this.events.length = 400;
  }

  /* ------------------------------------------------------------- *
   *  Commands from the operator console
   * ------------------------------------------------------------- */
  command(cmd, value) {
    switch (cmd) {
      case 'start':
        if (this.mode === 'SHUTDOWN_COLD' || this.mode === 'POST_PURGE' || this.mode === 'TRIPPED') {
          if (this.mft.latched) { this.log('SEQ', 'Reset the MFT relays before restarting'); break; }
          this.tg.tripped = false;
          this.normalShutdown = false;
          this.turbineTrip = { latched: false, cause: '', time: 0 };
          this.mft = { latched: false, cause: '', time: 0, reasons: [] };
          this.ackAlarms.clear();
          this.mode = 'PRESTART'; this.phaseTimer = 0; this.starts++;
          this.log('SEQ', 'Cold start-up sequence initiated');
        }
        break;
      case 'shutdown':
        if (['ONLINE', 'LOADING', 'SYNCHRONISING', 'TURBINE_ROLL'].includes(this.mode)) {
          this.mode = 'UNLOADING'; this.phaseTimer = 0;
          this.normalShutdown = true;
          this.log('SEQ', 'Normal shutdown sequence initiated');
        }
        break;
      case 'tripTurbine':
        this.tripTurbine('Operator — manual turbine trip');
        break;
      case 'mft':
        this.tripBoiler('Operator — manual master fuel trip');
        break;
      case 'resetMFT':
        if (!this.mft.latched || this.boilers.every(b => b.qFuel < 0.5)) {
          this.mft.latched = false; this.mft.cause = ''; this.mft.reasons = [];
          this.turbineTrip.latched = false; this.turbineTrip.cause = '';
          this.ackAlarms.clear();
          this.log('SEQ', 'MFT and turbine trip relays reset');
        }
        break;
      case 'resetPlant':
        // Full return to the cold, stopped state: the whole point is that it
        // discards everything — faults, trips, load, elapsed time — so it is
        // deliberately not reachable from the sequencer, only from an explicit
        // operator action.
        this.reset();
        break;
      case 'loadSetpoint':
        this.targetLoad = clamp(Number(value) || 0, 0, DESIGN.generator.ratedMW);
        this.log('CTRL', `Load setpoint ${this.targetLoad.toFixed(0)} MW`);
        break;
      case 'rampRate':
        this.loadRampRate = clamp(Number(value) || 4.0, 0.5, 40);
        break;
      case 'speedFactor':
        this.speedFactor = clamp(Number(value) || 1, 1, 600);
        break;
      case 'boilerService': {
        const i = Number(value.i) | 0;
        const b = this.boilers[i];
        if (!b) break;
        if (b.qFuel > 2 || b.msFlow > 5) { this.log('CTRL', `${b.name} cannot be taken out of service while fired`); break; }
        b.inService = !b.inService;
        this.log('CTRL', `${b.name} ${b.inService ? 'in service' : 'out of service'}`);
        break;
      }
      case 'startAux': this.auxCommand(value, true); break;
      case 'stopAux': this.auxCommand(value, false); break;
      case 'sootblow': {
        const b = this.boilers[Number(value) | 0];
        if (b) { b.sootblowing = true; b.sootblowTimer = 900; this.log('CTRL', `${b.name} soot-blowing started`); }
        break;
      }
      case 'syncNow':
        if (this.mode === 'SYNCHRONISING' || (this.mode === 'TURBINE_ROLL' && this.tg.speed > 2985)) {
          this.closeBreaker();
        }
        break;
      case 'injectFault':
        this.injectFault(value.id, Number(value.magnitude) || 1, value.boiler);
        break;
      case 'clearFault':
        this.clearFault(value.id);
        break;
      case 'clearAllFaults':
        for (const id of [...this.activeFaults.keys()]) this.clearFault(id);
        break;
      case 'ackAlarm':
        if (value === 'all') this.alarms.forEach(a => this.ackAlarms.add(a.key));
        else this.ackAlarms.add(value);
        break;
      case 'ackAll':
        this.alarms.forEach(a => this.ackAlarms.add(a.key));
        break;
      case 'ambient':
        this.bop.ambientTarget = clamp(Number(value.temp) ?? 29, 5, 45);
        this.bop.wetBulbTarget = clamp(Number(value.wetBulb) ?? this.bop.ambientTarget - 4, 2, 35);
        break;
      case 'setAuto':
        this.operatorMode = value ? 'auto' : 'manual';
        break;
      case 'manual': {
        // Operator manual desk. value = { key, on, value, sp }.
        const k = value && value.key;
        const grp = typeof k === 'string' ? k.split(':')[0] : '';
        const def = MANUAL_DESK.get(grp);
        if (!def) break;
        // Clamp on receipt, not on use. The loop items carry two numbers with
        // different ranges — a setpoint in °C and a valve position in % — and
        // clamping the position to the setpoint's range put the reheater damper
        // on its 100 % stop the moment the operator asked for 20 %.
        const vLo = def.manualMin !== undefined ? def.manualMin : def.min;
        const vHi = def.manualMax !== undefined ? def.manualMax : def.max;
        const prev = this.manual[k] || {};
        const rawV = Number(value.value);
        const rawSP = Number(value.sp);
        const e = {
          on: value.on === true,
          value: clamp(Number.isFinite(rawV) ? rawV : (Number.isFinite(prev.value) ? prev.value : (def.manualMin || 0)),
            vLo, vHi),
          sp: (value.sp === undefined || value.sp === null || !Number.isFinite(rawSP))
            ? (Number.isFinite(prev.sp) ? prev.sp : undefined)
            : clamp(rawSP, def.min, def.max),
          held: prev.held === true,
        };
        this.manual[k] = e;
        const where = k.includes(':') ? ` boiler ${'AB'[Number(k.split(':')[1]) | 0]}` : '';
        this.log('CTRL', `${def.label}${where} — ${e.on ? `MANUAL at ${e.value} ${def.manualUnit || def.unit}` : 'AUTO'}`
          + `${e.sp !== undefined ? `, setpoint ${e.sp} ${def.unit}` : ''}`);
        break;
      }
      case 'manualClear': {
        // Release everything first, then forget it. Clearing the map outright
        // left the boiler flags stuck on MANUAL with nothing left to turn them
        // off, so the reheater damper stayed under operator control for the
        // rest of the run.
        const n = Object.keys(this.manual || {}).length;
        for (const k of Object.keys(this.manual || {})) {
          const e = this.manual[k];
          if (e) { e.on = false; e.value = 0; }
        }
        this.applyManual();
        this.manual = {};
        this.log('CTRL', `Manual desk cleared — ${n} item${n === 1 ? '' : 's'} back to automatic`);
        break;
      }
      default:
        break;
    }
  }

  auxCommand(key, on) {
    const [grp, idx] = key.split(':');
    const i = Number(idx) | 0;
    switch (grp) {
      case 'bfp': if (this.bop.bfp[i]) this.bop.bfp[i].running = on; break;
      case 'cep': if (this.bop.cep[i]) this.bop.cep[i].running = on; break;
      case 'cwp': if (i === 0) this.tg.cwPump1 = on; else this.tg.cwPump2 = on; break;
      case 'vac': this.tg.vacuumPumpRunning = on; break;
      case 'lop': this.tg.lubeOilPump = on; break;
      case 'jack': this.tg.jackingOil = on; break;
      case 'tg': this.tg.turningGear = on; break;
      case 'fd': if (this.boilers[i]) this.boilers[i].fdRunning = on; break;
      case 'id': if (this.boilers[i]) this.boilers[i].idRunning = on; break;
      case 'pa': if (this.boilers[i]) this.boilers[i].paRunning = on; break;
      case 'mill': if (this.boilers[i] && this.boilers[i].mills[i >= 2 ? (i % 2) : 0]) break; break;
      case 'millA': { const b = this.boilers[0]; if (b.mills[i]) b.mills[i].running = on; break; }
      case 'millB': { const b = this.boilers[1]; if (b.mills[i]) b.mills[i].running = on; break; }
      case 'esp': if (this.boilers[i]) { this.boilers[i].espEnergised = on; this.boilers[i].espFields = [on, on, on, on]; } break;
      case 'fgd': this.bop.fgdRunning = on; break;
      case 'conv': this.bop.conveyorRunning = on; break;
      case 'crush': this.bop.crusherRunning = on; break;
      case 'dm': this.bop.dmMakeUp = on; break;
      case 'makeup': this.tg.makeUpValve = on ? 60 : 0; this.bop.makeUpValve = on ? 60 : 0; break;
      default: break;
    }
    this.log('CTRL', `${key} ${on ? 'STARTED' : 'STOPPED'}`);
  }

  injectFault(id, magnitude = 1, boilerIndex = null) {
    const f = FAULT_MAP.get(id);
    if (!f) return false;
    if (boilerIndex !== null && boilerIndex !== undefined) this.faultBoiler = Number(boilerIndex) | 0;
    const inst = { id, magnitude, t0: this.simTime, def: f };
    this.activeFaults.set(id, inst);
    f.apply(this, magnitude);
    this.log('FAULT', `${f.name} injected (severity ${f.severity})`);
    return true;
  }

  clearFault(id) {
    const inst = this.activeFaults.get(id);
    if (!inst) return false;
    inst.def.clear ? inst.def.clear(this) : null;
    this.activeFaults.delete(id);
    this.log('FAULT', `${inst.def.name} cleared`);
    return true;
  }

  closeBreaker() {
    if (this.tg.breakerClosed) return;
    this.tg.breakerClosed = true;
    this.tg.loadSetpoint = 33;
    this.tg.mode = 'load';
    this.mode = 'LOADING';
    this.phaseTimer = 0;
    this.loadHold = 33;
    this.log('ELEC', `Generator breaker CLOSED — unit synchronised at ${(this.tg.grossMW).toFixed(1)} MW`);
  }

  tripTurbine(cause) {
    if (this.turbineTrip.latched) return;
    this.turbineTrip = { latched: true, cause, time: this.simTime };
    this.tg.tripped = true;
    this.tg.breakerClosed = false;
    this.tg.loadSetpoint = 0;
    this.tg.mode = 'manual';
    this.tg.gvManual = 0;
    this.log('TRIP', `TURBINE TRIP — ${cause}`);
    if (this.mode !== 'TRIPPED') { this.mode = 'COASTDOWN'; this.phaseTimer = 0; }
  }

  /**
   * Planned stop: open the generator breaker and shut the steam valves without
   * latching the protection system.  A normal shutdown used to call
   * tripTurbine(), which latched a turbine trip — the unit then sat in TRIPPED
   * instead of coasting to the turning gear, and the post-trip interlocks
   * (vacuum, steam temperature) kept firing on a machine that was simply
   * stopping.  Overspeed and vibration protection stay live.
   */
  coastDown(cause) {
    this.tg.tripped = true;
    this.tg.breakerClosed = false;
    this.tg.loadSetpoint = 0;
    this.tg.mode = 'manual';
    this.tg.gvManual = 0;
    this.log('ELEC', `Generator breaker OPEN — ${cause}`);
    if (this.mode !== 'TRIPPED') { this.mode = 'COASTDOWN'; this.phaseTimer = 0; }
  }

  tripBoiler(cause, reasons = []) {
    if (this.mft.latched) return;
    this.mft = { latched: true, cause, time: this.simTime, reasons };
    for (const b of this.boilers) {
      b.fuelDemand = 0;
      b.oilFlowCmd = 0;
      for (const m of b.mills) m.running = false;
    }
    this.masterFuel = 0;
    this.log('TRIP', `MASTER FUEL TRIP — ${cause}${reasons.length ? ' [' + reasons.join('; ') + ']' : ''}`);
    this.tripTurbine('Turbine trip following MFT');
    this.mode = 'TRIPPED';
    this.phaseTimer = 0;
  }

  /* ------------------------------------------------------------- *
   *  Start-up / shut-down sequencer
   * ------------------------------------------------------------- */
  sequence(dt) {
    this.phaseTimer += dt;
    const b = this.boilers;
    const tg = this.tg;
    const anyFired = b.some(x => x.qFuel > 1);

    // ---- Protection system ------------------------------------------------
    // Every protection has a pick-up delay, exactly as on a real unit: the
    // condition must persist before the relay drops out.  This stops
    // momentary transients from tripping the machine and lets the operator
    // see the alarm first.
    const prot = (id, cond, delay, action) => {
      if (cond) {
        this.protTimers[id] = (this.protTimers[id] || 0) + dt;
        if (this.protTimers[id] >= delay) { this.protTimers[id] = 0; action(); }
      } else this.protTimers[id] = 0;
    };

    // ---- MFT interlocks -------------------------------------------------
    if (!this.mft.latched) {
      const insvc = b.filter(x => x.inService);
      const fire = (id, cond, delay, reason) => {
        if (!cond) { this.protTimers[id] = 0; return; }
        this.protTimers[id] = (this.protTimers[id] || 0) + dt;
        if (this.protTimers[id] >= delay) this.tripBoiler(reason, [reason]);
      };
      for (let i = 0; i < b.length; i++) {
        const x = b[i];
        if (!x.inService) continue;
        // the drum level trips need a longer pick-up delay: swell and shrink
        // on a large drum can take the indicated level well past the trip for
        // several seconds during a load change
        fire(`lvl${i}L`, x.drumPressure > 0.4 && x.drumLevel < LIMITS.drum.levelLowTrip, 12,
          `Blr ${tag(i)} drum level LLL`);
        fire(`lvl${i}H`, x.drumPressure > 0.4 && x.drumLevel > LIMITS.drum.levelHighTrip, 12,
          `Blr ${tag(i)} drum level HHH`);
        fire(`prs${i}`, x.drumPressure > LIMITS.drum.pressureHighTrip, 8,
          `Blr ${tag(i)} drum pressure HH`);
        fire(`dft${i}H`, x.qFuel > 2 && x.draft > LIMITS.furnace.draftHighTrip, 3,
          `Blr ${tag(i)} furnace pressure HH`);
        fire(`dft${i}L`, x.qFuel > 2 && x.draft < LIMITS.furnace.draftLowTrip, 3,
          `Blr ${tag(i)} furnace pressure LL`);
      }
      const allFlameLost = insvc.length > 0 && insvc.every(x => x.lossOfIgnition);
      fire('flame', allFlameLost && insvc.some(x => x.qFuel > 2), 2, 'Loss of all flame');
      fire('idfan', insvc.length && insvc.every(x => !x.idRunning) && anyFired, 1, 'All ID fans tripped');
      fire('fdfan', insvc.length && insvc.every(x => !x.fdRunning) && anyFired, 1, 'All FD fans tripped');
    }

    // ---- turbine trip interlocks ---------------------------------------
    if (!this.turbineTrip.latched && tg.speed > 200) {
      // A planned shutdown defeats the process interlocks that are a
      // consequence of stopping (vacuum decaying as the gland steam falls
      // away, steam temperature drifting as the fires come down) but never the
      // mechanical ones.
      const stopping = !!this.normalShutdown;
      if (!stopping) {
        prot('vac', tg.condenserVacuum > LIMITS.turbine.vacuumLowTrip, 2, () => this.tripTurbine('Condenser vacuum low'));
        prot('ax', tg.axialShift > LIMITS.turbine.axialShiftTrip, 3, () => this.tripTurbine('Axial shift high'));
        prot('mst', tg.grossMW > 30 && tg.msTemp > LIMITS.steam.msTempHighTrip, 30, () => this.tripTurbine('Main steam temperature high'));
        prot('msl', tg.grossMW > 30 && tg.msTemp < LIMITS.steam.msTempLowTrip, 10, () => this.tripTurbine('Main steam temperature low (water induction)'));
      }
      prot('os', tg.speed > LIMITS.turbine.overspeedTrip, 0.2, () => this.tripTurbine('Overspeed'));
      prot('vib', tg.vibrations.some(v => v > LIMITS.turbine.vibrationTrip), 3, () => this.tripTurbine('Bearing vibration high'));
      prot('lop', tg.lubeOilPressure < LIMITS.turbine.lubeOilTrip, 2, () => this.tripTurbine('Lube oil pressure low'));
    }

    const inservice = b.filter(x => x.inService);
    const lead = inservice[0] || b[0];

    switch (this.mode) {
      /* ---------------------------- PRESTART ---------------------------- */
      case 'PRESTART': {
        this.tg.lubeOilPump = true; this.tg.jackingOil = true; this.tg.turningGear = true;
        this.tg.cwPump1 = true; this.bop.cep[0].running = true;
        this.tg.vacuumPumpRunning = true;
        this.bop.bfp[0].running = true;
        this.bop.fgdRunning = true;
        this.bop.conveyorRunning = true; this.bop.crusherRunning = true;
        for (const x of b) { x.espEnergised = true; x.espFields = [true, true, true, true]; }
        this.tg.sealSteam = 1;
        this.phaseNote = 'Pre-start checks and auxiliary plant start-up';
        if (lead.drumLevel > -70 && this.tg.condenserVacuum < 40 && this.phaseTimer > 60) {
          this.mode = 'PURGE'; this.phaseTimer = 0;
          this.log('SEQ', 'Pre-start complete — beginning furnace purge');
        }
        break;
      }

      /* ---------------------------- PURGE ------------------------------ */
      case 'PURGE': {
        for (const x of inservice) { x.fdRunning = true; x.idRunning = true; x.paRunning = true; }
        const airPct = clamp(30 + this.phaseTimer / 6, 30, 45);
        for (const x of inservice) { x.fdSpeed = airPct; x.idSpeedBase = airPct + 3; x.paSpeed = airPct; }
        this.phaseNote = `Furnace purge — ${Math.max(0, 300 - this.phaseTimer).toFixed(0)} s remaining`;
        if (this.phaseTimer > 300) {
          this.mode = 'LIGHTOFF'; this.phaseTimer = 0;
          this.log('SEQ', 'Furnace purge complete — light-off permitted');
        }
        break;
      }

      /* ---------------------------- LIGHT OFF --------------------------- */
      case 'LIGHTOFF': {
        for (const x of inservice) {
          x.fdSpeed = clamp(32 + this.phaseTimer / 8, 32, 42);
          x.idSpeedBase = x.fdSpeed + 3;
          x.oilFlowCmd = clamp(1.8 + this.phaseTimer / 60, 1.8, 2.6);
          x.oilGuns = 4;
        }
        this.phaseNote = 'Light fuel oil ignitors in service — proving flame';
        if (this.phaseTimer > 30 && inservice.every(x => x.flameScanners > 0)) {
          this.mode = 'PRESSURISING'; this.phaseTimer = 0; this.presSeq = 0;
          this.pressureSetpoint = inservice.reduce((a, x) => a + x.drumPressure, 0) / inservice.length;
          this.log('SEQ', 'Flame proven — beginning pressure raising');
        }
        break;
      }

      /* ------------------------ PRESSURE RAISING ------------------------ */
      case 'PRESSURISING': {
        const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
        const env = STARTUP_ENVELOPE.find(e => P <= e.pMax) || STARTUP_ENVELOPE[STARTUP_ENVELOPE.length - 1];
        this.pressureSetpoint = Math.min(this.startupPressureTarget, this.pressureSetpoint + (env.dpdt / 60) * dt);
        // firing rate is capped by the start-up curve (drum thermal stress)
        const fuelCap = P < 0.5 ? 34 : P < 3.5 ? 55 : P < 8 ? 95 : 150;
        const fuelPerBoiler = this.startupFuel(P, this.pressureSetpoint, fuelCap, inservice, 545);
        for (const x of inservice) {
          x.fuelDemand = fuelPerBoiler;
          x.oilFlowCmd = P < 0.8 ? clamp(2.4 - P * 1.2, 0.5, 2.4) : (x.millsRunning === 0 ? 1.2 : 0);
          x.fdSpeed = clamp(30 + 55 * (fuelPerBoiler / 150), 28, 100);
          x.idSpeedBase = clamp(x.fdSpeed + 4, 30, 100);
          x.paSpeed = clamp(35 + 50 * (fuelPerBoiler / 150), 30, 100);
          // mills may be started once the furnace is hot enough to ignite coal
          const wantMills = x.furnaceTemp > 380 && this.phaseTimer > 120
            ? clamp(Math.ceil(fuelPerBoiler / 34), 0, DESIGN.boiler.mills) : 0;
          for (let i = 0; i < x.mills.length; i++) x.mills[i].running = i < wantMills;
          // Start-up vent: this is how the operator drives the steam
          // temperature up to meet the turbine metal temperature without
          // over-heating the superheater.
          // no venting once the boiler is nearly at rolling pressure
          const vNeed = clamp(this.ventCtrl.step(-x.msTemp, -500, dt), 0, Math.min(700, 50 + 130 * P));
          const nearRoll = clamp((P - (this.startupPressureTarget - 0.6)) / 0.5, 0, 1);
          x.ventDemand = vNeed * clamp(1 - (this.pressureSetpoint - P) / 0.4, 0, 1) * (1 - nearRoll);
          x.rhGasDamper = 55;
        }
        const tSat = S.satAtP(P).Tsat;
        this.phaseNote = `Pressure raising — ${P.toFixed(2)} MPa / ${tSat.toFixed(0)} C (target ${this.startupPressureTarget} MPa)`;
        const msT = inservice.reduce((a, x) => a + x.msTemp, 0) / Math.max(1, inservice.length);
        if (P >= this.startupPressureTarget - 0.12 && msT > 415) {
          this.mode = 'TURBINE_ROLL'; this.phaseTimer = 0; this.runupIndex = 0; this.soakTimer = 0;
          for (const x of inservice) { x.msLineIsolated = false; x.mainStopValve = 100; }
          this.tg.turningGear = false; this.tg.jackingOil = false;
          this.tg.speedCtrl.reset(); this.tg.loadCtrl.reset();
          this.tg.mode = 'speed';
          this.tg.speedSetpoint = 200;
          this.log('SEQ', 'Steam conditions satisfied — rolling the turbine');
        }
        break;
      }

      /* ------------------------ TURBINE RUN-UP -------------------------- */
      case 'TURBINE_ROLL': {
        const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
        // pressure is held while the machine is run up
        const cmd = this.startupFuel(P, this.pressureSetpoint, 60, inservice, 555);
        for (const x of inservice) {
          x.fuelDemand = clamp(cmd, 0, 160);
          x.fdSpeed = clamp(30 + 55 * (x.fuelDemand / 150), 28, 100);
          x.idSpeedBase = clamp(x.fdSpeed + 4, 30, 100);
          x.oilFlowCmd = x.millsRunning < 2 ? 1.2 : 0;
          // the vent only opens once the pressure is at (or above) the ramp,
          // otherwise the boiler can never build pressure for the run-up
          x.ventDemand = clamp(this.ventCtrl.step(-x.msTemp, -500, dt), 0, Math.min(700, 50 + 130 * P))
            * clamp(1 - (this.pressureSetpoint - P) / 0.5, 0, 1);
        }
        const prog = RUNUP_PROGRAMME[this.runupIndex];
        if (prog) {
          const reached = this.tg.speed >= prog.speed - 25 && this.tg.speed <= prog.speed + 60;
          if (!reached) {
            this.tg.speedSetpoint = rateLimit(this.tg.speedSetpoint, prog.speed, prog.speed < 1000 ? 5 : 9, dt);
            this.phaseNote = `Accelerating to ${prog.speed} rpm — ${this.tg.speed.toFixed(0)} rpm`;
          } else {
            this.soakTimer += dt;
            this.phaseNote = `${prog.speed} rpm — ${prog.note} (${Math.max(0, prog.hold * 60 - this.soakTimer).toFixed(0)} s)`;
            if (this.soakTimer >= prog.hold * 60) {
              this.runupIndex++; this.soakTimer = 0; this.tg.speedCtrl.reset();
              if (RUNUP_PROGRAMME[this.runupIndex]) this.tg.speedSetpoint = RUNUP_PROGRAMME[this.runupIndex].speed;
              this.log('SEQ', `Run-up: ${prog.speed} rpm hold complete`);
            }
          }
        } else {
          this.mode = 'SYNCHRONISING'; this.phaseTimer = 0;
          this.tg.avrAuto = true;
          this.log('SEQ', 'Turbine at rated speed — preparing to synchronise');
        }
        break;
      }

      /* ------------------------ SYNCHRONISING --------------------------- */
      case 'SYNCHRONISING': {
        const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
        const cmd = this.startupFuel(P, this.pressureSetpoint, 70, inservice, 545);
        for (const x of inservice) {
          x.fuelDemand = clamp(cmd, 0, 160);
          x.fdSpeed = clamp(30 + 55 * (x.fuelDemand / 150), 28, 100);
          x.idSpeedBase = clamp(x.fdSpeed + 4, 30, 100);
          x.ventDemand = clamp(this.ventCtrl.step(-x.msTemp, -480, dt), 0, Math.min(600, 40 + 90 * P));
        }
        this.phaseNote = 'Synchronising — matching voltage, frequency and phase';
        if (this.phaseTimer > 25) this.closeBreaker();
        break;
      }

      /* --------------------------- LOADING ------------------------------ */
      case 'LOADING':
      case 'ONLINE': {
        // Runback: the load ramp is held (or reversed) whenever the boiler is
        // unsettled — exactly what the operator or the runback system does.
        let maxLvl = 0, maxDev = 0;
        for (const x of inservice) {
          maxLvl = Math.max(maxLvl, Math.abs(x.drumLevel + x.levelSwell));
          maxDev = Math.max(maxDev, Math.abs(x.msTemp - DESIGN.steam.mainSteamTemp));
        }
        const settled = maxLvl < 80 && maxDev < 22;
        if (this.mode === 'LOADING') {
          const holdInitial = this.phaseTimer < 1800;
          if (!holdInitial && settled) this.loadHold = Math.min(this.targetLoad,
            (this.loadHold == null ? 33 : this.loadHold) + (dt / 60) * this.loadRampRate);
          if (!holdInitial && maxLvl > 130) this.loadHold = Math.max(0, (this.loadHold || 33) - (dt / 60) * 12);
          this.tg.loadSetpoint = holdInitial ? 33 : clamp(this.loadHold == null ? 33 : this.loadHold, 0, this.targetLoad);
          if (this.tg.loadSetpoint >= Math.min(this.targetLoad, this.autoRampLimit) - 0.5) {
            this.mode = 'ONLINE'; this.phaseTimer = 0;
            this.log('SEQ', `Automatic loading complete at ${this.tg.grossMW.toFixed(0)} MW — operator to complete loading to ${this.targetLoad} MW`);
          }
          this.phaseNote = holdInitial
            ? `Initial load soak — ${Math.max(0, 1800 - this.phaseTimer).toFixed(0)} s`
            : (settled ? `Loading at ${this.loadRampRate} MW/min` : `Load ramp HELD — drum ${maxLvl.toFixed(0)} mm`);
        } else {
          if (settled) this.loadHold = rateLimit(this.loadHold == null ? this.tg.grossMW : this.loadHold,
            this.targetLoad, this.loadRampRate / 60, dt);
          if (maxLvl > 130) this.loadHold = Math.max(0, (this.loadHold || this.tg.grossMW) - (dt / 60) * 12);
          this.tg.loadSetpoint = clamp(this.loadHold == null ? this.tg.grossMW : this.loadHold, 0, this.targetLoad);
          this.phaseNote = settled
            ? `On load — ${this.tg.grossMW.toFixed(1)} MW (setpoint ${this.targetLoad} MW)`
            : `Runback — load held at ${this.tg.grossMW.toFixed(0)} MW (drum ${maxLvl.toFixed(0)} mm)`;
        }
        this.runBoilerFollow(dt, inservice);
        break;
      }

      /* --------------------------- UNLOADING --------------------------- */
      case 'UNLOADING': {
        this.tg.loadSetpoint = Math.max(0, this.tg.loadSetpoint - (this.loadRampRate / 60) * dt);
        this.runBoilerFollow(dt, inservice);
        this.phaseNote = `Unloading — ${this.tg.grossMW.toFixed(1)} MW`;
        if (this.tg.grossMW < 25 && this.tg.loadSetpoint <= 1) {
          this.coastDown('normal shutdown — machine unloaded');
        }
        break;
      }

      /* --------------------------- COAST DOWN -------------------------- */
      case 'COASTDOWN': {
        const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
        this.pressureSetpoint = Math.max(0.6, this.pressureSetpoint - (0.15 / 60) * dt);
        const cmd = this.startupFuel(P, this.pressureSetpoint, 70, inservice, 545);
        for (const x of inservice) {
          x.fuelDemand = clamp(cmd, 0, 150);
          x.fdSpeed = clamp(30 + 55 * (x.fuelDemand / 150), 28, 100);
          x.idSpeedBase = clamp(x.fdSpeed + 4, 30, 100);
          x.ventDemand = clamp((P - this.pressureSetpoint) * 150, 0, Math.min(600, 40 + 90 * P));
        }
        this.phaseNote = `Turbine coasting down — ${this.tg.speed.toFixed(0)} rpm`;
        if (this.tg.speed < 200) {
          this.tg.turningGear = true;
          this.mode = 'TURNING_GEAR'; this.phaseTimer = 0;
          this.log('SEQ', 'Turning gear engaged');
        }
        break;
      }

      /* ------------------------- TURNING GEAR -------------------------- */
      case 'TURNING_GEAR': {
        this.tg.vacuumPumpRunning = false;
        this.tg.sealSteam = 0;
        this.phaseNote = 'On turning gear — casing cooling';
        if (this.phaseTimer > 300) { this.mode = 'FIREDOWN'; this.phaseTimer = 0; }
        break;
      }

      /* --------------------------- FIRE DOWN --------------------------- */
      case 'FIREDOWN': {
        const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
        this.pressureSetpoint = Math.max(0.15, this.pressureSetpoint - (0.15 / 60) * dt);
        const cmd = this.startupFuel(P, this.pressureSetpoint, 70, inservice, 545);
        // The last mill is taken out as the pressure falls away; below about
        // 1.2 MPa there is no longer enough heat to hold a flame.
        const fuelWanted = (P > 1.2 && this.phaseTimer < 7200) ? cmd : 0;
        const millsWanted = fuelWanted > 4 ? clamp(Math.ceil(fuelWanted / 34), 1, DESIGN.boiler.mills) : 0;
        for (const x of inservice) {
          for (let i = 0; i < x.mills.length; i++) x.mills[i].running = i < millsWanted;
          x.fuelDemand = millsWanted > 0 ? clamp(fuelWanted / inservice.length, 0, 150) : 0;
          x.oilFlowCmd = 0;
          x.ventDemand = clamp((P - this.pressureSetpoint) * 150, 0, Math.min(600, 40 + 90 * P));
          x.fdSpeed = millsWanted > 0 ? clamp(30 + 55 * (x.fuelDemand / 150), 28, 100) : 32;
          x.idSpeedBase = clamp(x.fdSpeed + 4, 25, 100);
          x.rhGasDamper = 50;
        }
        this.phaseNote = millsWanted
          ? `Boiler fire-down — ${P.toFixed(2)} MPa, ${millsWanted} mill(s)`
          : `Fires out — boiler cooling, ${P.toFixed(2)} MPa`;
        if ((P < 0.8 || millsWanted === 0) && this.phaseTimer > 60) {
          for (const x of inservice) { x.fuelDemand = 0; x.oilFlowCmd = 0; x.ventDemand = 0; }
          this.mode = 'POST_PURGE'; this.phaseTimer = 0;
          this.log('SEQ', 'Boiler fired down — post purge');
        }
        break;
      }

      /* --------------------------- POST PURGE -------------------------- */
      case 'POST_PURGE': {
        for (const x of inservice) { x.fdSpeed = 32; x.idSpeedBase = 35; }
        const fuelOff = inservice.every(x => x.qFuel < 0.5);
        this.phaseNote = fuelOff
          ? `Post purge — ${Math.max(0, 600 - this.phaseTimer).toFixed(0)} s`
          : 'Waiting for the fires to go out before post purge';
        if (this.phaseTimer > 600 && fuelOff) {
          for (const x of inservice) { x.fdRunning = false; x.idRunning = false; x.paRunning = false; x.paSpeed = 0; x.fdSpeed = 0; x.idSpeedBase = 0; }
          this.tg.turningGear = false; this.tg.jackingOil = false; this.tg.lubeOilPump = false;
          this.bop.bfp.forEach(p => p.running = false);
          this.tg.cwPump1 = false; this.tg.cwPump2 = false;
          this.bop.cep.forEach(p => p.running = false);
          for (const x of b) { x.espEnergised = false; x.espFields = [false, false, false, false]; }
          this.bop.fgdRunning = false; this.bop.conveyorRunning = false; this.bop.crusherRunning = false;
          this.mode = 'SHUTDOWN_COLD'; this.phaseTimer = 0;
          this.log('SEQ', 'Unit shut down and boxed up');
        }
        break;
      }

      /* ----------------------------- TRIPPED --------------------------- */
      case 'TRIPPED': {
        for (const x of inservice) {
          x.fuelDemand = 0; x.oilFlowCmd = 0;
          for (const m of x.mills) m.running = false;
          x.ventDemand = clamp((x.drumPressure - 17.0) * 90, 0, 180);
          if (x.idRunning) x.idSpeedBase = clamp(35 + (x.drumPressure / 18) * 45, 30, 100);
          if (x.fdRunning) x.fdSpeed = clamp(x.idSpeedBase - 4, 25, 100);
        }
        this.phaseNote = 'MFT latched — fuel off, purge before re-light';
        if (this.phaseTimer > 420 && !this.mft.latched) { this.mode = 'PURGE'; this.phaseTimer = 0; }
        if (this.tg.speed < 200 && this.phaseTimer > 300) {
          this.tg.turningGear = true;
        }
        break;
      }

      /* ------------------------- SHUTDOWN COLD ------------------------- */
      default: {
        this.phaseNote = 'Unit cold and stopped';
        break;
      }
    }

    // The drum level and attemperator controls are only useful when fired.
    for (const x of b) {
      if (x.qFuel < 0.5) { x.levelCtrlAuto = true; }
    }
  }

  /**
   * Operator manual desk: write the operator's values over whatever the
   * automatic controls produced this tick.
   *
   * Called from step() between sequence() and the physics, so a manual value
   * takes effect on the same tick rather than one tick late. Where a loop
   * shares its auto/manual flag with a fault — the drum level controller does,
   * because a failed feedwater valve takes it out of automatic — the flag is
   * only given back if this desk is the one that took it, so clearing the desk
   * cannot silently repair a fault.
   */
  applyManual() {
    const m = this.manual;
    if (!m) return;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!e) continue;
      const parts = key.split(':');
      const b = parts.length > 1 ? this.boilers[Number(parts[1]) | 0] : null;
      const v = clamp(Number(e.value) || 0, -1e6, 1e6);
      switch (parts[0]) {
        case 'fd':   if (b && e.on) b.fdSpeed = clamp(v, 0, 100); break;
        case 'id':   if (b && e.on) b.idSpeedBase = clamp(v, 0, 100); break;
        case 'pa':   if (b && e.on) b.paSpeed = clamp(v, 0, 100); break;
        case 'vent': if (b && e.on) b.ventDemand = clamp(v, 0, 600); break;

        case 'rhtemp': {
          if (!b) break;
          if (e.sp !== undefined) b.rhTempSetpoint = clamp(e.sp, 470, 570);
          // Desk-only flag, so it can be given straight back.
          b.rhGasDamperManual = !!e.on;
          if (e.on) b.rhGasDamper = clamp(v, 0, 100);
          break;
        }
        case 'mstemp': {
          if (!b) break;
          if (e.sp !== undefined) b.msTempSetpoint = clamp(e.sp, 470, 570);
          b.msSprayManual = !!e.on;
          if (e.on) b.spray2Manual = clamp(v, 0, 100);
          break;
        }
        case 'level': {
          if (!b) break;
          if (e.sp !== undefined) b.levelSetpoint = clamp(e.sp, -250, 250);
          if (e.on) {
            b.levelCtrlAuto = false; e.held = true;
            b.fwManual = clamp(v, 0, 1150);
          } else if (e.held) {
            // Only hand the loop back if this desk took it: a feedwater valve
            // fault holds levelCtrlAuto false and must not be undone here.
            b.levelCtrlAuto = true; e.held = false;
          }
          break;
        }
        default: break;
      }
    }
  }

  /**
   * Start-up firing-rate law (per boiler, t/h of coal).
   *
   * A real start-up is run off a firing-rate schedule, not a pressure PID: the
   * operator sets a firing rate for the pressure band and backs it off whenever
   * the pressure runs ahead of the start-up envelope or the superheater gets
   * too hot.  That is far more stable than a set of interacting PID loops.
   */
  startupFuel(P, setpoint, cap, inservice, msLimit) {
    // Superheater protection: back the firing off as the outlet temperature
    // runs away above the target.
    let guard = 1;
    for (const x of inservice) {
      const shGuard = clamp(1 - (Math.max(x.msTemp, x.tShOut) - msLimit) / 60, 0, 1);
      guard = Math.min(guard, shGuard);
    }
    // Feed-forward: every tonne of steam that leaves the drum (to the turbine
    // or through the start-up vent) needs about 0.115 t of coal.
    const steamOut = this.tg.msFlow + inservice.reduce((a, x) => a + (x.ventFlow || 0), 0);
    const ff = (steamOut * 0.115) / inservice.length;
    // Pressure term: a modest proportional response to the ramp error, so the
    // firing rate never steps.
    const press = clamp(40 * (setpoint - P) + 4, 0, cap);
    return clamp((ff + press) * guard, 0, cap);
  }

  /** Boiler-follow coordinated control used from synchronisation onwards. */
  runBoilerFollow(dt, inservice) {
    const load = this.tg.grossMW;
    // The HP/LP bypass (start-up vent) keeps the boiler above its minimum
    // stable flow until the turbine can take the steam — without it the
    // superheater has no cooling steam and overheats at low load.
    // The bypass is opened gradually — slamming it open is what upsets the
    // drum level straight after synchronisation.
    const minBoilerFlow = DESIGN.steam.mainSteamFlow * 0.25;         // t/h
    const boilerFlowWant = Math.max(this.tg.msFlow, minBoilerFlow);
    this.boilerFlowCmd = rateLimit(this.boilerFlowCmd == null ? this.tg.msFlow : this.boilerFlowCmd,
      boilerFlowWant, 0.55, dt);
    const boilerFlow = Math.max(this.tg.msFlow, this.boilerFlowCmd || 0);
    // The minimum-flow bypass can only pass steam the boiler is actually
    // making. Demanding a fixed 465 t/h when the boiler is generating 80 t/h
    // simply drains the drum: the pressure collapses, the pressure loop winds
    // up, the firing rate swings and the superheater spikes past the metal
    // limit — the unit tripped on "main steam temperature high" the moment
    // the breaker closed. The bypass therefore takes the surplus over the
    // turbine demand, and never more than 60 % of what is being generated.
    const genTotal = inservice.reduce((a, x) => a + Math.max(0, x.msFlow), 0);
    const surplus = Math.max(0, genTotal - this.tg.msFlow);
    this.bypassDemand = clamp(Math.min(boilerFlow - this.tg.msFlow, surplus * 0.6), 0, minBoilerFlow);
    // Coordinated (boiler-follow) control. The feed-forward and the
    // sliding-pressure schedule are driven by the UNIT DEMAND, never by the
    // measured main-steam flow: feeding measured flow back into the fuel
    // demand closes a positive loop (more steam → more fuel → more steam)
    // that runs away and trips the unit on high drum level above ~250 MW.
    const demandMW = clamp(Math.max(this.tg.loadSetpoint, this.tg.grossMW),
      0, DESIGN.generator.ratedMW);
    const loadF = clamp(demandMW / DESIGN.generator.ratedMW, 0, 1.05);
    // Sliding-pressure curve. This is the DRUM pressure target: the drum runs
    // above the HP inlet by the superheater and pipework pressure drop
    // (~0.9 MPa at MCR), so the curve has to end at drumPressureRated (18.1),
    // not at the 16.7 MPa turbine inlet design figure.
    const pFull = DESIGN.steam.drumPressureRated;
    const pSp = clamp(Math.min(pFull, 8.0 + (pFull - 8.0) * loadF), 7.5, pFull);
    this.pressureSetpoint = lag(this.pressureSetpoint, pSp, 30, dt);
    const P = inservice.reduce((a, x) => a + x.drumPressure, 0) / Math.max(1, inservice.length);
    const feedForward = DESIGN.steam.mainSteamFlow * 0.158 * (0.06 + 0.94 * loadF);  // t/h of coal
    // Hand-over continuity. The start-up sequencer writes the firing rate
    // straight to the boilers, so seed the rate limiter with what they are
    // actually doing: without this the first loading tick steps the fuel by
    // tens of t/h, the superheater outlet spikes past the metal limit and the
    // turbine trips on "main steam temperature high" the moment the breaker
    // closes.
    if (this.lastFuelCmd == null) {
      this.lastFuelCmd = inservice.reduce((a, x) => a + (x.fuelDemand || 0), 0)
        / Math.max(1, inservice.length);
    }
    const trimBefore = this.boilerFollowCtrl.i;
    const rawTrim = this.boilerFollowCtrl.step(P, this.pressureSetpoint, dt);
    // The trim is a correction around the feed-forward, not the main fuel
    // signal: it is clamped to ±110 t/h of coal and the integral is frozen
    // while it is clipped (conditional integration on the output limit).
    // Without this the integral winds up during a load ramp and the boiler
    // keeps over-firing long after the pressure has caught up, which pins the
    // drum against the safety valves and dumps a quarter of the steam.
    const trim = clamp(rawTrim, -110, 110);
    if (trim !== rawTrim) this.boilerFollowCtrl.i = trimBefore;
    // hard run-back if the pressure runs away above the sliding-pressure curve
    const totalFuel = clamp(feedForward + trim, 0, 520);
    this.masterFuel = totalFuel;
    // Rate limit the firing rate: pulverised-fuel mills cannot follow a step
    // change, and slamming the fuel about is what wrecks drum-level control.
    const wantPer = totalFuel / Math.max(1, inservice.length);
    const per = rateLimit(this.lastFuelCmd == null ? wantPer : this.lastFuelCmd, wantPer, 0.22, dt);
    this.lastFuelCmd = per;
    // The firing-rate limiter is a physical constraint of a pulverised-fuel
    // mill, so nothing further is needed here — the trim clamp above is what
    // protects the loop from winding up.
    // the number of mills follows the firing-rate demand, not the load
    // second circulating-water pump comes in as the condenser duty builds
    if (this.tg.grossMW > 80) this.tg.cwPump2 = true;
    else if (this.tg.grossMW < 40) this.tg.cwPump2 = false;
    const millsWanted = clamp(Math.ceil(per / 34), 1, DESIGN.boiler.mills);
    for (const x of inservice) {
      x.fuelDemand = per;
      for (let i = 0; i < x.mills.length; i++) x.mills[i].running = i < millsWanted;
      x.oilFlowCmd = 0;
      const airPct = clamp(28 + 70 * clamp(per / 150, 0, 1), 25, 100);
      x.fdSpeed = airPct; x.idSpeedBase = clamp(airPct + 4, 25, 100); x.paSpeed = clamp(airPct, 25, 100);
      x.ventDemand = this.bypassDemand / Math.max(1, inservice.length);
      // excess air / O2 trim
      x.excessAir = clamp(0.20 + (3.5 - x.o2) * 0.012, 0.02, 0.55);
      // reheater temperature by gas bypass damper
      x.rhGasDamper = clamp(50 + ((x.rhTempSetpoint || DESIGN.steam.reheatOutletTemp) - x.rhOutTemp) * 3.2, 4, 100);
    }
    // turbineside: the load controller drives the governor valves
    this.tg.mode = 'load';
  }

  /* ------------------------------------------------------------- *
   *  Integration
   * ------------------------------------------------------------- */
  step(dtReal) {
    const simDt = dtReal * this.speedFactor;
    if (simDt <= 0) return;
    // sub-step so that fast time constants stay stable under time acceleration
    const nSub = clamp(Math.ceil(simDt / 0.5), 1, 260);
    const dt = simDt / nSub;

    for (let k = 0; k < nSub; k++) {
      this.time += dt;
      this.simTime += dt;

      // ---- fault progression ----
      for (const inst of this.activeFaults.values()) {
        if (inst.def.active) inst.def.active(this, inst, dt);
      }

      // ---- sequencer & control ----
      this.sequence(dt);

      // ---- operator manual desk ----
      // After the sequencer, before the physics: whatever the automatic
      // controls just decided, an operator who has taken an item to MANUAL
      // wins, and the plant has to answer on this same tick.
      this.applyManual();

      // ---- grid frequency ----
      const dist = this.grid.disturbance || 0;
      const target = DESIGN.gridFrequency
        + (dist > 0 ? -0.9 * dist * Math.exp(-Math.max(0, (this.grid.faultTimer || 0)) * 0.02) * Math.sin(this.time * 2.1) - 0.25 * dist : 0)
        + 0.012 * Math.sin(this.time * 0.37) + 0.008 * Math.sin(this.time * 1.13);
      this.grid.frequency = lag(this.grid.frequency, clamp(target, 47.5, 52.5), 0.8, dt);

      // ---- boiler / turbine coupling ----
      const active = this.boilers.filter(b => b.inService);
      const nb = Math.max(1, active.length);
      const headerPressure = active.reduce((a, b) => a + (b.drumPressure - 0.55 * (b.msFlow / 930) ** 2 - 0.35), 0) / nb;
      const msTemp = active.reduce((a, b) => a + b.msTemp, 0) / nb;
      const rhOut = active.reduce((a, b) => a + b.rhOutTemp, 0) / nb;

      // turbine / generator
      this.tg.step({
        dt, headerPressure: Math.max(0.05, headerPressure), boilerMsTemp: msTemp,
        boilerRhOut: rhOut, ambient: this.bop.ambient, gridFrequency: this.grid.frequency,
        fuelHeat: this.boilers.reduce((a, b) => a + b.qFuel, 0), time: this.time,
      });

      // steam demand shared between the boilers
      const demand = this.tg.msFlow;
      // Both boilers discharge into ONE main-steam header, so each boiler
      // takes the share of the demand that its own drum pressure is pushing
      // for. Without this cross-coupling the pair is unconstrained: the
      // pressure with the slightly higher drum has a smaller latent heat,
      // evaporates more, and runs away (A pinned on its safety valves at
      // 19 MPa while B sagged to 14 MPa). Real twin-boiler units hold the
      // two drums within a couple of tenths of a MPa.
      const pMean = active.reduce((a, x) => a + x.drumPressure, 0) / nb;
      const shares = {};
      let shareSum = 0;
      for (const x of active) {
        const s = clamp((1 / nb) + (x.drumPressure - pMean) * 0.35, 0.08, 0.92);
        shares[x.id] = s;
        shareSum += s;
      }
      for (const k of Object.keys(shares)) shares[k] /= Math.max(1e-6, shareSum);
      const ctx = {
        dt, ambient: this.bop.ambient, wetBulb: this.bop.wetBulb,
        steamDemand: demand, activeBoilers: nb, fgdRunning: this.bop.fgdRunning,
        time: this.time, wetCoal: this.coalWet || 0, shares,
      };
      for (const b of this.boilers) {
        if (!b.inService) continue;
        b.msPressure = clamp(b.drumPressure - 0.55 * (b.msFlow / 930) ** 2 - 0.35, 0.05, 25);
        b.rhPressure = clamp(this.tg.crhPressure, 0.1, 6);
        b.rhInTemp = this.tg.crhTemp;
        b.rhFlow = this.tg.rhFlow / nb;
        b.mainStopValve = this.tg.stopValve;
        b.msLineIsolated = this.tg.stopValve < 5;
        b.step(ctx);
      }

      // balance of plant
      this.tg.condensateFlowTarget = this.bop.condensateFlow;
      this.bop.step(dt, this);

      // condenser circulating water inlet comes from the cooling tower
      const towerOut = this.coolingTower(dt);
      this.tg.cwInletTemp = lag(this.tg.cwInletTemp, towerOut, 40, dt);

      // conservation counters
      const coalTons = this.boilers.reduce((a, b) => a + b.totalCoal, 0) * dt / 3600;
      this.totalCoalBurned += coalTons;
      this.energySentOut += this.tg.grossMW * dt / 3600;
      this.runHours += dt / 3600;
    }

    // ---- alarms (1 Hz scan) ----
    this.alarmScan += dtReal;
    if (this.alarmScan >= 0.5) { this.alarmScan = 0; this.scanAlarms(); }

    // ---- trend history (1 sample / 2 s of sim time) ----
    this.histTimer += simDt;
    if (this.histTimer >= 2) {
      this.histTimer = 0;
      this.pushHistory();
    }
  }

  /** Natural-draft cooling tower: outlet water temperature. */
  coolingTower(dt) {
    const loadF = clamp(this.tg.condFlow / (DESIGN.steam.mainSteamFlow * 0.7), 0, 1.2);
    const approach = DESIGN.coolingTower.approach * (0.55 + 0.45 * loadF);
    // The basin is the COLD water: wet bulb + approach. The range is the
    // rise across the condenser (hot return − cold basin), which is set by
    // the duty and the circulating-water flow in the condenser model —
    // adding it here as well double-counted ~12 K and gave the tower a
    // 44 °C cold-water temperature, which pinned the condenser at 17 kPa.
    // Off-design: the tower only holds its approach while the range stays
    // near the design range; beyond that the cold water warms with it.
    const rangeActual = Math.max(0, this.tg.cwOutletTemp - this.tg.cwInletTemp);
    const excess = Math.max(0, rangeActual - DESIGN.coolingTower.rangeDesign);
    const basin = this.bop.wetBulb + approach + 0.35 * excess;
    this.bop.towerBasin = lag(this.bop.towerBasin || basin, basin, 300, dt);
    this.bop.towerPlume = clamp((this.bop.towerBasin - this.bop.ambient) * 0.12 * loadF, 0, 1);
    return this.bop.towerBasin;
  }

  /* ------------------------------------------------------------- *
   *  Alarms
   * ------------------------------------------------------------- */
  scanAlarms() {
    const s = this.snapshot(false);
    const found = [];
    for (const a of ALARMS) {
      if (a.test.length > 1) {
        for (let i = 0; i < this.boilers.length; i++) {
          const b = this.boilers[i];
          if (!b.inService) continue;
          if (a.test(s, b)) found.push({ key: `${a.id}_${i}`, id: a.id, prio: a.prio, group: a.group, msg: a.msg(s, i), boiler: i });
        }
      } else if (a.test(s)) {
        found.push({ key: a.id, id: a.id, prio: a.prio, group: a.group, msg: a.msg(s, 0), boiler: -1 });
      }
    }
    // preserve first-seen time & ack state
    const prev = new Map(this.alarms.map(a => [a.key, a]));
    for (const f of found) {
      const p = prev.get(f.key);
      f.t = p ? p.t : this.simTime;
      f.ack = p ? p.ack : false;
      f.seq = p ? p.seq : alarmSeq++;
      if (p && this.ackAlarms.has(f.key)) f.ack = true;
    }
    // log new alarms
    for (const f of found) if (!prev.has(f.key)) this.log('ALARM', `${f.prio}: ${f.msg}`);
    // log cleared
    for (const p of this.alarms) if (!found.some(f => f.key === p.key)) this.log('ALARM', `CLEARED: ${p.msg}`);
    const prioRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    found.sort((a, b) => prioRank[a.prio] - prioRank[b.prio] || b.seq - a.seq);
    this.alarms = found;
  }

  pushHistory() {
    const s = this.snapshot(false);
    this.history.push({
      t: this.simTime,
      mw: s.plant.grossMW,
      net: s.plant.netMW,
      p: s.boilers[0].drumPressure,
      msT: s.boilers[0].msTemp,
      rhT: s.boilers[0].rhOutTemp,
      lvl: s.boilers[0].drumLevel,
      coal: s.plant.totalCoal,
      vac: s.condenser.vacuum,
      o2: s.boilers[0].o2,
      speed: s.turbine.speed,
      spray: s.boilers[0].spray1 + s.boilers[0].spray2,
    });
    if (this.history.length > 3600) this.history.shift();
  }

  /* ------------------------------------------------------------- *
   *  Snapshot for the HMI
   * ------------------------------------------------------------- */
  snapshot(full = true) {
    const tg = this.tg, bop = this.bop;
    const b0 = this.boilers[0], b1 = this.boilers[1];
    const activeB = this.boilers.filter(b => b.inService);
    const gross = tg.grossMW;
    const net = Math.max(0, gross - bop.auxMW);
    const totalCoal = this.boilers.reduce((a, b) => a + b.totalCoal, 0);
    const fuelHeat = this.boilers.reduce((a, b) => a + b.qFuel, 0);

    const boilerSnap = (b) => ({
      name: b.name, id: b.id, inService: b.inService,
      drumPressure: b.drumPressure, drumLevel: b.drumLevel, levelSwell: b.levelSwell,
      drumLevelTotal: b.drumLevel + b.levelSwell,
      drumMetalTemp: b.drumMetalTemp, drumMetalTop: b.drumMetalTop, drumMetalBottom: b.drumMetalBottom,
      metalRate: b.metalRate, drumMetalDiff: b.drumMetalTop - b.drumMetalBottom,
      drumPh: b.drumPh, drumSilica: b.drumSilica, drumConductivity: b.drumConductivity,
      fwFlow: b.fwFlow, fwTemp: b.fwTemp, fwPressure: b.fwPressure,
      msFlow: b.msFlow, msOutlet: b.msOutlet, msPressure: b.msPressure, msTemp: b.msTemp,
      spray1: b.spray1, spray2: b.spray2, rhSpray: b.rhSpray,
      rhFlow: b.rhFlow, rhInTemp: b.rhInTemp, rhOutTemp: b.rhOutTemp, rhPressure: b.rhPressure,
      econOutletTemp: b.econOutletTemp, blowdown: b.blowdown,
      qFuel: b.qFuel, qAbsorbed: b.qAbsorbed / 1000, efficiency: b.efficiency * 100,
      totalCoal: b.totalCoal, oilFlow: b.oilFlow, oilGuns: b.oilGuns,
      mills: b.mills.map(m => ({
        id: m.id, running: m.running, coal: m.coalFlow, outletTemp: m.outletTemp,
        current: m.current, dp: m.dp, vibration: m.vibration, fire: m.fire, blocked: m.blocked,
      })),
      millsRunning: b.millsRunning,
      fdRunning: b.fdRunning, idRunning: b.idRunning, paRunning: b.paRunning,
      // idSpeedBase is what the sequencer (and the manual desk) commands;
      // idSpeed is that plus the draft-controller trim. The console needs both:
      // showing only idSpeed makes a manual ID fan look like it is ignoring the
      // operator, because the trim moves on top of what was asked for.
      fdSpeed: b.fdSpeed, idSpeed: b.idSpeed, idSpeedBase: b.idSpeedBase || 0, paSpeed: b.paSpeed,
      fdCurrent: b.fdCurrent, idCurrent: b.idCurrent, paCurrent: b.paCurrent,
      totalAir: b.totalAir, mGas: b.mGas, o2: b.o2, co: b.co, draft: b.draft,
      excessAir: b.excessAir * 100,
      tAdiabatic: b.tAdiabatic, tFegt: b.tFegt, furnaceTemp: b.furnaceTemp,
      tShOut: b.tShOut, tRhOut: b.tRhOut, tEconOut: b.tEconOut, tAphOut: b.tAphOut, tStack: b.tStack,
      aphAirOut: b.aphAirOut, stackTemp: b.tStack,
      flameIntensity: b.flameIntensity, flameScanners: b.flameScanners, lossOfIgnition: b.lossOfIgnition,
      espEnergised: b.espEnergised, espFields: b.espFields, opacity: b.opacity,
      slagging: b.slagging * 100, sootblowing: b.sootblowing,
      tubeLeak: b.tubeLeak, leakFlow: b.leakFlow, ventFlow: b.ventFlow,
      mainStopValve: b.mainStopValve, msLineIsolated: b.msLineIsolated,
      fuelDemand: b.fuelDemand, levelCtrlAuto: b.levelCtrlAuto, tempCtrlAuto: b.tempCtrlAuto,
      rhGasDamper: b.rhGasDamper, aphFire: b.aphFire || 0, millFire: b.millFire || false,
      ventFlow: b.ventFlow, ventDemand: b.ventDemand || 0,
      // manual desk: what the operator has taken, and the setpoints the loops
      // are working to, so the console can show the target beside the value
      levelSetpoint: b.levelSetpoint || 0, fwManual: b.fwManual || 0,
      msTempSetpoint: b.msTempSetpoint || 0, spray2Manual: b.spray2Manual || 0,
      spray2Pct: b.spray1Max > 0 ? clamp((b.spray2Cmd || 0) / b.spray1Max * 100, 0, 100) : 0,
      rhTempSetpoint: b.rhTempSetpoint || 0, rhGasDamperManual: !!b.rhGasDamperManual,
      msSprayManual: !!b.msSprayManual,
    });

    const snap = {
      meta: {
        station: DESIGN.plant, unit: DESIGN.unit, designMW: DESIGN.generator.ratedMW,
        simTime: this.simTime, wallClock: Date.now(), speedFactor: this.speedFactor,
        mode: this.mode, phaseNote: this.phaseNote, phaseTimer: this.phaseTimer,
        runHours: this.runHours, starts: this.starts,
        targetLoad: this.targetLoad, operatorMode: this.operatorMode,
        manual: this.manual || {},
        procedure: PROCEDURE[this.mode] || [],
        pressureSetpoint: this.pressureSetpoint, masterFuel: this.masterFuel,
      },
      plant: {
        grossMW: gross, netMW: net, auxMW: bop.auxMW,
        loadFactor: (gross / DESIGN.generator.ratedMW) * 100,
        frequency: this.grid.frequency,
        totalCoal, fuelHeat,
        heatRate: gross > 15 ? (fuelHeat * 3600) / gross : 0,
        netHeatRate: net > 15 ? (fuelHeat * 3600) / net : 0,
        efficiency: fuelHeat > 1 ? (gross / fuelHeat) * 100 : 0,
        coalBurned: this.totalCoalBurned, energySentOut: this.energySentOut,
        ambient: bop.ambient, wetBulb: bop.wetBulb,
        diffExpansion: tg.differentialExpansion,
      },
      boilers: [boilerSnap(b0), boilerSnap(b1)],
      turbine: {
        speed: tg.speed, acceleration: tg.acceleration, tripped: tg.tripped,
        breakerClosed: tg.breakerClosed, turningGear: tg.turningGear,
        mode: tg.mode, loadSetpoint: tg.loadSetpoint,
        governorValve: tg.governorValve, stopValve: tg.stopValve, interceptValve: tg.interceptValve,
        msFlow: tg.msFlow, msPressure: tg.msPressure, msTemp: tg.msTemp,
        hpExhPressure: tg.hpExhPressure, hpExhTemp: tg.hpExhTemp,
        crhPressure: tg.crhPressure, crhTemp: tg.crhTemp,
        hrhPressure: tg.hrhPressure, hrhTemp: tg.hrhTemp,
        ipExhPressure: tg.ipExhPressure, ipExhTemp: tg.ipExhTemp,
        lpExhPressure: tg.lpExhPressure, moisture: tg.moisture * 100,
        rhFlow: tg.rhFlow, condFlow: tg.condFlow, shaftMW: tg.shaftMW,
        vibrations: tg.vibrations, bearingMetalTemps: tg.bearingMetalTemps,
        axialShift: tg.axialShift, eccentricity: tg.eccentricity,
        differentialExpansion: tg.differentialExpansion, casingExpansion: tg.casingExpansion,
        metalTempHP: tg.metalTempHP, metalTempIP: tg.metalTempIP,
        lubeOilPressure: tg.lubeOilPressure, controlOilPressure: tg.controlOilPressure,
        jackingOilPressure: tg.jackingOilPressure, sealSteam: tg.sealSteam,
        lubeOilPump: tg.lubeOilPump, jackingOil: tg.jackingOil,
        exhaustTemp: tg.exhaustTemp, glandSteamPressure: tg.glandSteamPressure,
      },
      generator: {
        mw: tg.grossMW, mvar: tg.mvars, mva: tg.mva, pf: tg.pf,
        kV: tg.terminalKV, amps: tg.statorCurrent,
        fieldVolts: tg.fieldVolts, fieldAmps: tg.fieldCurrent,
        statorTemp: tg.statorTemp, rotorTemp: tg.rotorTemp,
        h2Pressure: tg.h2Pressure, h2Purity: tg.h2Purity,
        breakerClosed: tg.breakerClosed, avrAuto: tg.avrAuto, voltageSetpoint: tg.voltageSetpoint,
        frequency: tg.gridFreq,
      },
      condenser: {
        vacuum: tg.condenserVacuum, exhaustTemp: tg.exhaustTemp,
        hotwellLevel: tg.hotwellLevel, hotwellTemp: tg.hotwellTemp,
        cwInletTemp: tg.cwInletTemp, cwOutletTemp: tg.cwOutletTemp, cwFlow: tg.cwFlow,
        conductivity: tg.condConductivity, dissolvedOxygen: tg.dissolvedOxygen,
        airIngress: tg.airIngress, vacuumPumpRunning: tg.vacuumPumpRunning,
        cwPumps: tg.cwPumpRunning, qCond: tg.qCond, fouling: tg.condenserFouling * 100,
        moisture: tg.moisture * 100,
      },
      bop: {
        bfp: bop.bfp.map(p => ({ ...p })),
        cep: bop.cep.map(p => ({ ...p })),
        deaeratorPressure: bop.deaeratorPressure, deaeratorLevel: bop.deaeratorLevel,
        deaeratorTemp: bop.deaeratorTemp,
        hpHeaterLevels: bop.hpHeaterLevels, lpHeaterLevels: bop.lpHeaterLevels,
        fwFlow: bop.fwFlow, fwTemp: bop.fwTemp, condensateFlow: bop.condensateFlow,
        stockpile: bop.stockpile, bunkerLevels: bop.bunkerLevels,
        conveyorRunning: bop.conveyorRunning, conveyorLoad: bop.conveyorLoad,
        crusherRunning: bop.crusherRunning,
        fgdRunning: bop.fgdRunning, fgdPh: bop.fgdPh, fgdDensity: bop.fgdDensity,
        ashSilo: bop.ashSilo, gypsumSilo: bop.gypsumSilo, dmWaterTank: bop.dmWaterTank,
        towerBasin: bop.towerBasin || bop.wetBulb, towerPlume: bop.towerPlume || 0,
        instrumentAir: bop.instrumentAir, stationAir: bop.stationAir,
        dmMakeUp: bop.dmMakeUp, makeUpValve: bop.makeUpValve > 0,
        auxSteamPressure: bop.auxSteamPressure, serviceWater: bop.serviceWater,
      },
      emissions: {
        so2: (b0.so2 + b1.so2) / 2, nox: (b0.noX + b1.noX) / 2,
        dust: (b0.dust + b1.dust) / 2, co: (b0.co + b1.co) / 2,
        o2: (b0.o2 + b1.o2) / 2, opacity: Math.max(b0.opacity, b1.opacity),
      },
      protection: {
        mft: this.mft, turbineTrip: this.turbineTrip,
      },
      faultCatalog: full ? FAULTS.map(f => ({
        id: f.id, group: f.group, name: f.name, severity: f.severity,
        cause: f.cause, symptoms: f.symptoms, actions: f.actions,
      })) : undefined,
      activeFaults: [...this.activeFaults.values()].map(f => ({
        id: f.id, name: f.def.name, magnitude: f.magnitude, since: f.t0,
        group: f.def.group, severity: f.def.severity,
        symptoms: f.def.symptoms, actions: f.def.actions, cause: f.def.cause,
      })),
      alarms: this.alarms.map(a => ({
        key: a.key, id: a.id, prio: a.prio, group: a.group, msg: a.msg, t: a.t, ack: a.ack || this.ackAlarms.has(a.key),
      })),
      events: full ? this.events.slice(0, 120) : undefined,
    };
    return snap;
  }
}

module.exports = { Plant, ALARMS, PROCEDURE };
