/**
 * plant.js — Dynamic process model of the twin-boiler coal fired unit.
 *
 * Modelling philosophy
 * --------------------
 *  * Every energy stream is accounted for: the boiler raises steam with the heat
 *    it actually absorbs from the gas cascade, the turbine converts that into
 *    shaft work stage by stage, and the feedwater enthalpy is *derived* from the
 *    overall cycle energy balance so conservation can never be violated.
 *  * The furnace is modelled with a T^4 radiant exchange between the flame and
 *    (a) the water wall and (b) the radiant platen superheater.  That is what
 *    produces the real "flat steam temperature versus load" characteristic:
 *    the radiant section gains and the convective section loses as load falls,
 *    and the two partly cancel.
 *  * Boiler pressure comes from an inventory/energy balance, which reproduces
 *    drum swell and shrink, shrink on a load increase, and the pressure run-away
 *    you get when the fuel stays on after a turbine trip.
 *
 * Time integration is explicit Euler at the engine tick (default 100 ms), which
 * is far smaller than the fastest plant time constant (~1.5 s furnace draft).
 */

'use strict';

const S = require('./steam.js');
const H = require('./heat.js');
const { DESIGN, LIMITS } = require('./constants.js');

const clamp = S.clamp;
const lerp = S.lerp;

// Regenerative extraction fractions (of the main steam flow).  Chosen so that
// the cycle closes at a final feedwater temperature of ~250 degC at MCR.
const EXT_HP = 0.123;    // cold reheat -> HP feedwater heaters
const EXT_LP = 0.180;    // IP exhaust / LP bleeds -> deaerator + LP heaters

/* ------------------------------------------------------------------ *
 *  Small control helpers
 * ------------------------------------------------------------------ */
class PID {
  constructor(kp = 1, ki = 0, kd = 0, outMin = -1e12, outMax = 1e12, iLimit = 0) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.outMin = outMin; this.outMax = outMax;
    this.iLimit = iLimit;            // optional integral authority, output units
    this.i = 0; this.prev = 0; this.out = 0; this.enabled = true;
  }
  step(pv, sp, dt) {
    if (!this.enabled) return this.out;
    const e = sp - pv;
    const d = dt > 0 ? (e - this.prev) / dt : 0;
    this.prev = e;
    // Integral limits are expressed in output units so that the integral term
    // can always drive the output across its full range by itself.
    const ki = Math.abs(this.ki) > 1e-9 ? Math.abs(this.ki) : 1;
    const lim = this.iLimit > 0 ? this.iLimit : this.outMax;
    const iMin = clamp(this.outMin / ki, -1e12, 1e12);
    const iMax = clamp(Math.max(lim, Math.abs(this.outMin)) / ki, -1e12, 1e12);
    const iTry = clamp(this.i + e * dt, iMin, iMax);
    const raw = this.kp * e + this.ki * iTry + this.kd * d;
    // conditional integration (anti-windup): only integrate when the output is
    // not being driven further into a saturation limit
    if ((raw > this.outMax && e > 0) || (raw < this.outMin && e < 0)) {
      this.out = clamp(raw, this.outMin, this.outMax);
    } else {
      this.i = iTry;
      this.out = clamp(raw, this.outMin, this.outMax);
    }
    return this.out;
  }
  reset() { this.i = 0; this.prev = 0; this.out = 0; }
}

function lag(x, target, tau, dt) {
  if (tau <= 1e-6) return target;
  return x + (target - x) * (1 - Math.exp(-dt / tau));
}

/** Rate limiter, value per second. */
function rateLimit(x, target, rate, dt) {
  const d = rate * dt;
  return x + clamp(target - x, -d, d);
}

/* ================================================================== *
 *  BOILER
 * ================================================================== */
class Boiler {
  constructor(id) {
    this.id = id;
    this.name = `Boiler ${id === 0 ? 'A' : 'B'}`;
    this.reset();
  }

  reset() {
    const B = DESIGN.boiler, C = DESIGN.steam;
    this.inService = true;

    // ---- pressure parts -------------------------------------------------
    this.drumPressure = 0.101;      // MPa(a) cold
    this.drumLevel = -180;          // mm (cold, drained down for start-up)
    this.levelSwell = 0;            // mm
    this.drumMetalTemp = 30;
    this.drumMetalTop = 30;
    this.drumMetalBottom = 30;
    this.metalRate = 0;             // K/h
    this.econOutletTemp = 30;
    this.econOutletEnthalpy = 126;
    this.blowdown = 2;              // t/h
    this.tubeLeak = 0;              // 0..1 severity
    this.leakFlow = 0;              // t/h of steam/water lost to the gas side

    // ---- firing ---------------------------------------------------------
    this.mills = [];
    for (let i = 0; i < B.mills; i++) {
      this.mills.push({
        id: i, running: false, feederSpeed: 0, coalFlow: 0, outletTemp: 30,
        current: 0, dp: 0, vibration: 0.8, fire: false, bowlDiff: 2.1,
        pfQuality: 0.72, blocked: false, sealAir: true,
      });
    }
    this.oilFlow = 0;               // t/h light fuel oil
    this.oilGuns = 0;
    this.oilPressure = 0;
    this.ignitorEnergy = 0;
    this.flameIntensity = 0;
    this.flameScanners = 0;         // number of proven flames
    this.lossOfIgnition = false;
    this.furnaceTemp = 30;
    this.bedAsh = 0;
    this.slagging = 0.02;           // 0..1 cleanliness loss
    this.sootblowing = false;
    this.sootblowTimer = 0;

    // ---- air / gas ------------------------------------------------------
    this.fdRunning = false; this.idRunning = false; this.paRunning = false;
    this.fdSpeed = 0; this.idSpeed = 0; this.paSpeed = 0;
    this.fdCurrent = 0; this.idCurrent = 0; this.paCurrent = 0;
    this.fdDamper = 0; this.idDamper = 0;
    this.secAirDamper = 0;
    this.totalAir = 0;              // t/h
    this.totalCoal = 0;             // t/h
    this.mGas = 0;                  // t/h
    this.o2 = 20.9; this.co = 0; this.noX = 0; this.so2 = 0; this.dust = 0;
    this.opacity = 0;
    this.draft = 0;                 // Pa
    this.excessAir = 0.2;
    this.aphAirOut = 30;
    this.aphLeakage = 0.06;
    this.espEnergised = false;
    this.espFields = [false, false, false, false];
    this.espKv = [0, 0, 0, 0];

    // gas temperatures, degC
    this.tAdiabatic = 30; this.tFegt = 30; this.tShOut = 30;
    this.tRhOut = 30; this.tEconOut = 30; this.tAphOut = 30; this.tStack = 30;

    // ---- steam ----------------------------------------------------------
    this.msFlow = 0;                // t/h generated
    this.msTemp = 30; this.msPressure = 0.101; this.msEnthalpy = 0;
    this.msOutlet = 0;              // t/h leaving the superheater outlet header
    this.spray1 = 0; this.spray2 = 0; this.rhSpray = 0;
    this.rhFlow = 0; this.rhInTemp = 30; this.rhOutTemp = 30; this.rhPressure = 0.1;
    this.fwFlow = 0; this.fwTemp = 30; this.fwPressure = 0.2;
    this.ventFlow = 0;              // t/h through the start-up vent / PCV
    this.ventDemand = 0;
    this.mainStopValve = 0;         // % open
    this.msLineIsolated = true;

    // ---- heat duties, MW ------------------------------------------------
    this.qFuel = 0; this.qAbsorbed = 0; this.qWW = 0; this.qShRad = 0;
    this.qShConv = 0; this.qRh = 0; this.qEcon = 0; this.qAph = 0;
    this.efficiency = 0;

    // ---- chemistry ------------------------------------------------------
    this.drumPh = 9.4; this.drumSilica = 0.008; this.drumPhosphate = 2.4;
    this.drumConductivity = 4.2; this.fwDissolvedOxygen = 0.004;
    this.fwPh = 9.3;

    // ---- controls -------------------------------------------------------
    this.fuelDemand = 0;            // t/h commanded
    this.airDemand = 0;             // %
    this.levelCtrl = new PID(2.20, 0.010, 1.0, -300, 300, 70);  // output = t/h bias
    this.tempCtrl1 = new PID(0.35, 0.020, 0.0, 0, 100);
    this.tempCtrl2 = new PID(0.35, 0.020, 0.0, 0, 100);
    this.tempCtrlRh = new PID(0.55, 0.030, 0.0, 0, 100);
    this.rhTempCtrl = new PID(1.4, 0.03, 4, 0, 100);
    this.draftCtrl = new PID(0.020, 0.0035, 0.0, -45, 45);
    this.o2Ctrl = new PID(3.0, 0.06, 4, -30, 30);
    this.levelCtrlAuto = true;
    this.tempCtrlAuto = true;
    this.rhGasDamper = 50;          // % gas through the reheater
    this.auto = true;

    // ---- auxiliaries ----------------------------------------------------
    this.aphRotation = 100;
    this.bottomAshRunning = false;
    this.flyAshRunning = false;
    this.siloLevel = 20;
  }

  /* --------------------------------------------------------------- *
   *  Commanded inputs come from the sequencer / operator panel.
   * --------------------------------------------------------------- */
  get millsRunning() { return this.mills.filter(m => m.running).length; }

  millCapacity() { return DESIGN.boiler.millRatedCoal; }

  /* --------------------------------------------------------------- *
   *  One integration step.
   *  ctx = { dt, ambient, wetBulb, headerPressure, steamDemand (t/h),
   *          feedwaterTemp, faults, grid }
   * --------------------------------------------------------------- */
  step(ctx) {
    const dt = ctx.dt;
    const B = DESIGN.boiler, C = DESIGN.coal;

    /* ---------------- 1. Mills & fuel ---------------- */
    let coalCmd = this.fuelDemand;
    let coalAvail = 0;
    let millsRun = 0;
    for (const m of this.mills) if (m.running) millsRun++;

    for (const m of this.mills) {
      if (m.running) {
        const share = millsRun > 0 ? coalCmd / millsRun : 0;
        const target = clamp(share, 6, B.millRatedCoal);   // below ~6 t/h a mill is unstable
        m.feederSpeed = rateLimit(m.feederSpeed, (target / B.millRatedCoal) * 100, 22, dt);
        // coal transport delay through the mill + piping
        m.coalFlow = lag(m.coalFlow, m.blocked ? 0 : (m.feederSpeed / 100) * B.millRatedCoal, m.blocked ? 2 : 9, dt);
        m.current = lag(m.current, 8 + 1.55 * m.coalFlow + (m.blocked ? 22 : 0), 6, dt);
        m.dp = lag(m.dp, 1.4 + 0.055 * m.coalFlow + (m.blocked ? 4.5 : 0), 8, dt);
        m.vibration = lag(m.vibration, 0.7 + 0.05 * m.coalFlow + (m.blocked ? 3.2 : 0), 4, dt);
        m.fire = m.outletTemp > 155 && this.furnaceTemp > 250;
      } else {
        m.feederSpeed = rateLimit(m.feederSpeed, 0, 30, dt);
        m.coalFlow = lag(m.coalFlow, 0, 4, dt);
        m.current = lag(m.current, 0, 4, dt);
        m.dp = lag(m.dp, 0, 6, dt);
        m.vibration = lag(m.vibration, 0.4, 4, dt);
        m.fire = false;
      }
      coalAvail += m.coalFlow;
    }
    this.totalCoal = coalAvail;

    // Mill outlet temperature is held by the hot/cold (tempering) air dampers.
    // It climbs when the mill loses its coal (no evaporative cooling), when the
    // coal is very dry, and — dangerously — during a mill fire.
    const paTemp = this.paRunning ? lerp(ctx.ambient, this.aphAirOut, 0.85) : ctx.ambient;
    const wetCoal = ctx.wetCoal || 0;
    const millSp = 78 - 24 * wetCoal + (this.millFire ? 95 : 0);
    for (const m of this.mills) {
      const flowFactor = m.coalFlow > 1 ? 1 : 0.15;
      let target = ctx.ambient;
      if (m.running) {
        target = millSp + (m.blocked || m.coalFlow < 2 ? 48 : 0);
        target = Math.min(target, Math.max(ctx.ambient + 5, paTemp - 8));
      }
      m.outletTemp = lag(m.outletTemp, clamp(target, ctx.ambient, 230), 150 * flowFactor + 40, dt);
    }

    // Light fuel oil (start-up / support firing)
    this.oilFlow = lag(this.oilFlow, this.oilFlowCmd || 0, 1.5, dt);
    const coalHeat = (this.totalCoal / 3.6) * C.lhv / 1000;      // MW
    const oilHeat = (this.oilFlow / 3.6) * 41_800 / 1000;        // MW
    this.qFuel = coalHeat + oilHeat;

    /* ---------------- 2. Air & flue gas ---------------- */
    // NOTE: every flow in this section is in t/h; converts to kg/s where the
    // physics needs it.
    const fuelAir = this.totalCoal * C.stoichAir * (1 + this.excessAir)
      + this.oilFlow * 14.2 * (1 + this.excessAir);              // t/h
    const fdCapacity = this.fdRunning ? (this.fdSpeed / 100) * 1500 : 0;   // t/h
    const airDemand = fuelAir * 1.02;
    this.totalAir = lag(this.totalAir, Math.min(airDemand, fdCapacity), 3, dt);
    this.airShortfall = clamp(1 - this.totalAir / Math.max(1, airDemand), 0, 1);
    this.fdCurrent = lag(this.fdCurrent, this.fdRunning ? 90 + 110 * (this.fdSpeed / 100) : 0, 4, dt);

    const ashFrac = C.ash / 100;
    const gasFromFuel = this.totalCoal * (1 - ashFrac - 0.012) + this.oilFlow * 15.1;
    this.mGas = this.totalAir + gasFromFuel + this.leakFlow * 0.9;
    const mGasKg = this.mGas / 3.6;
    const mAirKg = this.totalAir / 3.6;

    this.idCurrent = lag(this.idCurrent, this.idRunning ? 95 + 120 * (this.idSpeed / 100)
      + 40 * clamp(this.mGas / 1600, 0, 1.4) : 0, 4, dt);

    // Flue-gas O2 (dry, volume %).  Air shortfall drives it towards zero and
    // pushes CO up.
    const o2FromExcess = this.qFuel > 1
      ? clamp(20.9 * this.excessAir / (1 + 7.6 * this.excessAir / (1 + this.excessAir)) * 1.28, 0.3, 20.9)
      : 20.9;
    this.o2 = lag(this.o2, this.qFuel > 1 ? o2FromExcess * (1 - this.airShortfall) : 20.9, 12, dt);

    /* ---------------- 3. Furnace (well-stirred reactor) ---------------- */
    //
    //   Q_fuel = m_gas*cp*(T_f - T_air)  +  sigma*A_ww*(T_f^4 - T_wall^4)
    //                                    +  sigma*A_sh*(T_f^4 - T_sh_steam^4)
    //
    // Solving this for the flame temperature T_f makes the model behave
    // correctly at low firing: with little fuel and cold walls the flame
    // temperature collapses towards the wall temperature instead of staying at
    // the adiabatic value.  T_f also IS the furnace exit gas temperature.
    const tAir = this.paRunning ? this.aphAirOut : ctx.ambient;
    const tAdIdeal = this.mGas > 1 ? tAir + (this.qFuel * 1000) / (mGasKg * S.cpFlue(1400)) : ctx.ambient;
    const tAd = tAir + (tAdIdeal - tAir) * H.DISSOCIATION;
    this.tAdiabatic = lag(this.tAdiabatic, tAd, 8, dt);

    const K_WW = H.K_WW;   // MW / K^4 — water-wall radiant conductance
    const K_SH = H.K_SH;   // MW / K^4 — radiant platen superheater
    const tSat = S.satAtP(this.drumPressure).Tsat;
    const tWall = Math.max(tSat, 30);
    const tSteamMeanSh = 0.5 * (tSat + Math.max(this.msTemp, tSat));
    const w4 = Math.pow(tWall + 273.15, 4);
    const sh4 = Math.pow(tSteamMeanSh + 273.15, 4);
    const cleanliness = 1 - this.slagging;

    let tF = this.tFegt;
    if (this.qFuel > 0.2 && mGasKg > 0.2) {
      const cpF = S.cpFlue(clamp(0.5 * (tAd + 400), 200, 1600));
      const cGas = mGasKg * cpF;                       // kW/K
      const qFuelKW = this.qFuel * 1000;
      let lo = ctx.ambient, hi = 2600;
      for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        const m4 = Math.pow(mid + 273.15, 4);
        const out = cGas * (mid - tAir) + (K_WW * (m4 - w4) + K_SH * (m4 - sh4)) * 1000 * cleanliness;
        if (out < qFuelKW) lo = mid; else hi = mid;
      }
      tF = 0.5 * (lo + hi);
    } else {
      tF = lag(tF, ctx.ambient, 120, dt);
    }
    this.tFegt = lag(this.tFegt, clamp(tF, ctx.ambient, 2600), 15, dt);
    this.furnaceTemp = lag(this.furnaceTemp, 0.5 * (this.tFegt + Math.max(this.tFegt, tAd)) * 0.5 + this.tFegt * 0.5, 30, dt);
    this.furnaceTemp = lag(this.furnaceTemp, 0.35 * this.tAdiabatic + 0.65 * this.tFegt, 30, dt);

    const f4 = Math.pow(this.tFegt + 273.15, 4);
    this.qWW = Math.max(0, K_WW * (f4 - w4) * 1000 * cleanliness);      // kW
    this.qShRad = Math.max(0, K_SH * (f4 - sh4) * 1000 * cleanliness);   // kW

    /* ---------------- 4. Convective pass cascade ---------------- */
    // ε-NTU banks, UA scaled with the 0.65 power of the gas flow and derated
    // by fouling / soot blowing.
    const gasRatio = clamp(mGasKg / H.GAS_REF, 0.02, 2.0);
    const clean = 0.94 + 0.06 * cleanliness;
    const tSteamMeanSh2 = 0.5 * (tSat + Math.max(this.msTemp, tSat));
    // Overall conductance falls on BOTH sides as the flows fall: gas-side
    // h ~ m^0.65 in series with fluid-side h ~ m^0.8 (half the resistance each
    // at the design point).
    const uaF = (r) => 1 / (0.5 / Math.pow(gasRatio, H.GAS_EXP) + 0.5 / Math.pow(clamp(r, 0.008, 2), 0.8));
    const uaSh = H.UA_SH * uaF(this.msFlow / H.FLOW_SH) * clean;      // kW/K
    const uaRh = H.UA_RH * uaF(this.rhFlow / H.FLOW_RH) * clean;
    const uaEc = H.UA_EC * uaF(this.fwFlow / H.FLOW_FW) * clean;
    const uaAph = H.UA_APH * uaF(this.totalAir / H.FLOW_AIR) * clean;

    // -- superheater: steam enters saturated from the drum --
    const cGasSh = mGasKg * S.cpFlue(0.5 * (this.tFegt + 700));
    const effSh = cGasSh > 0.01 ? 1 - Math.exp(-uaSh / cGasSh) : 0;
    this.qShConv = Math.max(0, effSh * cGasSh * (this.tFegt - tSteamMeanSh));
    let tGas = this.tFegt - (cGasSh > 0.01 ? this.qShConv / cGasSh : 0);
    this.tShOut = tGas;

    // superheater outlet enthalpy / temperature (before attemperation)
    const mGenKg = Math.max(1e-6, this.msFlow / 3.6);
    const qShTotal = this.qShRad + this.qShConv;
    const hSh = S.satAtP(this.drumPressure).hg + qShTotal / mGenKg;   // kW/(kg/s) = kJ/kg
    let tSh = Math.min(S.tSteam(this.msPressure, hSh), Math.max(tSat, this.tFegt));

    // -- attemperator stages (spray comes from the BFP discharge) --
    const hSpray = S.hWater(this.fwPressure, this.fwTemp);
    const spray1Max = DESIGN.steam.mainSteamFlow * 0.05 / 2;   // t/h per boiler
    const sprayAvailable = this.fwPressure > this.drumPressure + 1.0 && this.msFlow > 30;
    if (this.tempCtrlAuto && sprayAvailable) {
      // Stage 1 only protects the secondary superheater (it should sit shut in
      // normal service); stage 2 trims the final steam temperature.
      this.spray1Cmd = clamp(this.tempCtrl1.step(-tSh, -(DESIGN.steam.mainSteamTemp + 14), dt), 0, 100) / 100 * spray1Max;
      this.spray2Cmd = clamp(this.tempCtrl2.step(-this.msTemp, -DESIGN.steam.mainSteamTemp, dt), 0, 100) / 100 * spray1Max;
    }
    const sprayRate = clamp((this.fwPressure - this.drumPressure - 1.0) * 60, 0, 1);
    // an attemperator can only inject a limited fraction of the steam flow
    const sprayCap = Math.max(0, 0.18 * this.msFlow);
    this.spray1 = Math.min(sprayCap * 0.6, lag(this.spray1, (this.spray1Cmd || 0) * sprayRate, 10, dt));
    this.spray2 = Math.min(sprayCap * 0.6, lag(this.spray2, (this.spray2Cmd || 0) * sprayRate, 10, dt));
    const mAfterSpray1 = mGenKg + this.spray1 / 3.6;
    const hAfterSpray1 = (mGenKg * hSh + (this.spray1 / 3.6) * hSpray) / mAfterSpray1;
    const mOut = mAfterSpray1 + this.spray2 / 3.6;
    const hMsOut = (mAfterSpray1 * hAfterSpray1 + (this.spray2 / 3.6) * hSpray) / mOut;
    this.msEnthalpy = hMsOut;
    this.msTemp = Math.min(S.tSteam(this.msPressure, Math.min(hMsOut, 4200)), Math.max(tSat, this.tFegt));
    this.msOutlet = mOut * 3.6;

    // -- reheater --
    const cGasRh = mGasKg * S.cpFlue(Math.max(200, 0.5 * (tGas + 600)));
    const rhBypass = clamp(this.rhGasDamper / 100, 0.15, 1.0);
    const effRh = cGasRh > 0.01 ? 1 - Math.exp(-(uaRh * rhBypass) / cGasRh) : 0;
    const tSteamMeanRh = 0.5 * (this.rhInTemp + this.rhOutTemp);
    this.qRh = Math.max(0, effRh * cGasRh * (tGas - tSteamMeanRh));
    tGas -= cGasRh > 0.01 ? this.qRh / cGasRh : 0;
    this.tRhOut = tGas;

    const mRhKg = Math.max(1e-6, this.rhFlow / 3.6);
    const hCrh = S.hSteam(this.rhPressure, Math.max(this.rhInTemp, 120));
    if (this.rhFlow > 5) {
      const hRhOut = hCrh + this.qRh / mRhKg;
      this.rhOutTemp = Math.min(S.tSteam(this.rhPressure * 0.94, hRhOut),
        Math.max(this.rhInTemp, tGas));
      // Reheater attemperator.  A real machine trims reheat temperature with
      // the gas bypass damper or burner tilt and only uses the emergency spray
      // as a last resort, because every tonne of spray costs cycle efficiency.
      if (this.tempCtrlAuto && this.rhFlow > 20) {
        this.rhSprayCmd = clamp(this.tempCtrlRh.step(-this.rhOutTemp,
          -(DESIGN.steam.reheatOutletTemp + 8), dt), 0, 100) / 100 * DESIGN.steam.mainSteamFlow * 0.02;
      } else this.rhSprayCmd = 0;
      this.rhSpray = Math.max(this.rhSprayCmd || 0,
        this.rhOutTemp > DESIGN.steam.reheatOutletTemp + 6
          ? clamp((this.rhOutTemp - DESIGN.steam.reheatOutletTemp) * 2.2, 0, 60) : 0);
      if (this.rhSpray > 0) {
        const hMix = (mRhKg * hRhOut + (this.rhSpray / 3.6) * hSpray) / (mRhKg + this.rhSpray / 3.6);
        this.rhOutTemp = S.tSteam(this.rhPressure * 0.94, hMix);
      }
    } else {
      this.rhOutTemp = lag(this.rhOutTemp, Math.max(tGas * 0.55, ctx.ambient), 120, dt);
      this.rhSpray = 0;
    }

    // -- economiser --
    const cGasEc = mGasKg * S.cpFlue(Math.max(150, 0.5 * (tGas + 400)));
    const tWaterMean = 0.5 * (this.fwTemp + this.econOutletTemp);
    const effEc = cGasEc > 0.01 ? 1 - Math.exp(-uaEc / cGasEc) : 0;
    this.qEcon = Math.max(0, effEc * cGasEc * (tGas - tWaterMean));
    tGas -= cGasEc > 0.01 ? this.qEcon / cGasEc : 0;
    this.tEconOut = tGas;
    const mFwKg = Math.max(1e-6, this.fwFlow / 3.6);
    const hFwIn = S.hWater(this.fwPressure, this.fwTemp);
    // never let the economiser steam
    const hEconMax = S.satAtP(this.drumPressure * 0.98).hf - 25;
    this.econOutletEnthalpy = Math.min(hFwIn + this.qEcon / mFwKg, hEconMax);
    this.econOutletTemp = lag(this.econOutletTemp,
      clamp(this.tempFromEnthalpy(this.econOutletEnthalpy), 20, 400), 20, dt);

    // -- air preheater --
    const cGasAph = mGasKg * S.cpFlue(Math.max(120, 0.5 * (tGas + 200)));
    const cAir = mAirKg * S.cpAir(150);
    const cMin = Math.min(cGasAph, cAir);
    const effAph = cMin > 0.01 ? 1 - Math.exp(-uaAph / cMin) : 0;
    this.qAph = Math.max(0, effAph * cMin * (tGas - ctx.ambient));
    this.tAphOut = tGas - (cGasAph > 0.01 ? this.qAph / cGasAph : 0);
    this.aphAirOut = lag(this.aphAirOut,
      ctx.ambient + (cAir > 0.01 ? this.qAph / cAir : 0), 90, dt);
    this.tStack = lag(this.tStack, this.tAphOut, 25, dt);

    this.qAbsorbed = this.qWW + this.qShRad + this.qShConv + this.qRh + this.qEcon;
    // losses that the heat-exchanger cascade does not resolve explicitly
    const moistureLoss = (C.moisture / 100) * 2650 + 0.36 * 2.0 * Math.max(0, this.tStack - ctx.ambient);
    this.lossMoisture = this.qFuel > 1 ? (this.totalCoal / 3.6) * moistureLoss : 0;   // kW
    this.lossUnburnt = this.qFuel * 1000 * 0.012;
    this.lossRadiation = this.qFuel * 1000 * 0.005;
    this.efficiency = this.qFuel > 1
      ? clamp((this.qAbsorbed - this.lossMoisture - this.lossUnburnt - this.lossRadiation)
        / (this.qFuel * 1000), 0, 0.98)
      : 0;

    /* ---------------- 5. Steam generation & drum pressure ---------------- */
    const sat = S.satAtP(this.drumPressure);
    const hEconOut = this.econOutletEnthalpy;
    const dhEvap = Math.max(40, sat.hg - hEconOut);
    const mGen = (this.qWW / dhEvap) * 3.6;   // kg/s -> t/h
    this.msFlow = lag(this.msFlow, mGen, 12, dt);

    // tube leak: high-pressure water/steam flashing into the furnace
    this.leakFlow = this.tubeLeak * 42 * Math.sqrt(Math.max(0.2, this.drumPressure) / 18);   // t/h

    // Start-up vent (superheater vent / PCV) to atmosphere.  The capacity of
    // the vent line is choked-flow limited, so it grows with drum pressure.
    const ventCap = 30 + 95 * this.drumPressure;                       // t/h
    // you cannot vent more steam than the boiler is actually making
    const ventAvail = Math.min(ventCap, Math.max(0, 0.92 * this.msFlow));
    this.ventFlow = lag(this.ventFlow, clamp(this.ventDemand, 0, ventAvail), 5, dt);

    // turbine / vent demand taken from the common header
    const mOutTotal = ctx.steamDemand * (this.inService ? 1 : 0) / Math.max(1, ctx.activeBoilers)
      + this.ventFlow + this.leakFlow + this.blowdown;

    // Energy balance on the pressure parts
    const dhf_dP = (S.satAtP(this.drumPressure + 0.05).hf - S.satAtP(Math.max(0.05, this.drumPressure - 0.05)).hf) / 0.1;
    const dhg_dP = (S.satAtP(this.drumPressure + 0.05).hg - S.satAtP(Math.max(0.05, this.drumPressure - 0.05)).hg) / 0.1;
    const dTs_dP = (S.satAtP(this.drumPressure + 0.05).Tsat - S.satAtP(Math.max(0.05, this.drumPressure - 0.05)).Tsat) / 0.1;
    const Cm = B.metalMass * B.metalCp;
    const cap = Math.max(1e5, B.waterInventory * dhf_dP + B.steamInventory * dhg_dP + Cm * dTs_dP);
    const mOutKg = mOutTotal / 3.6, mFwKgs = this.fwFlow / 3.6, mBdKg = this.blowdown / 3.6;
    const leakKg = this.leakFlow / 3.6;
    const qNet = this.qWW + mFwKgs * hEconOut - mOutKg * sat.hg - mBdKg * sat.hf - leakKg * sat.hf;
    let dPdt = qNet / cap;                                 // MPa/s
    dPdt = clamp(dPdt, -0.9, 0.9);
    const pPrev = this.drumPressure;
    this.drumPressure = clamp(this.drumPressure + dPdt * dt, 0.06, 24.0);
    // heat loss to ambient when the unit is shut down
    if (this.qFuel < 0.5) {
      this.drumPressure = Math.max(0.101, this.drumPressure - 0.000004 * (this.drumPressure - 0.101) * dt * 60);
    }
    this.dPdtFiltered = lag(this.dPdtFiltered || 0, (this.drumPressure - pPrev) / Math.max(dt, 1e-3) * 60, 20, dt);

    // drum metal temperature (lags saturation) -> used for thermal stress
    const tSatNow = S.satAtP(this.drumPressure).Tsat;
    const metalTau = this.qFuel > 1 ? 260 : 900;
    const newMetal = lag(this.drumMetalTemp, tSatNow, metalTau, dt);
    this.metalRate = (newMetal - this.drumMetalTemp) / Math.max(dt, 1e-3) * 3600;
    this.drumMetalTemp = newMetal;
    this.drumMetalTop = lag(this.drumMetalTop, tSatNow + this.metalRate * 0.0006, metalTau * 0.7, dt);
    this.drumMetalBottom = lag(this.drumMetalBottom, tSatNow - this.metalRate * 0.0009, metalTau * 1.4, dt);

    /* ---------------- 6. Drum level ---------------- */
    const rhoW = 1 / S.vfT(Math.min(tSatNow, 365));
    const area = B.drumLength * B.drumInnerDiameter;
    const massImb = (this.fwFlow - mOutTotal) / 3.6;                 // kg/s
    const dLevel = (massImb / rhoW / area) * 1000 * 1000 * 0.02;      // mm/s (tuned)
    this.drumLevel = clamp(this.drumLevel + dLevel * dt, -600, 600);
    // swell & shrink: voidage response to the rate of change of pressure
    const swellTarget = -180 * this.dPdtFiltered;                     // mm per MPa/min
    this.levelSwell = lag(this.levelSwell, clamp(swellTarget, -260, 260), 55, dt);

    /* ---------------- 7. Furnace draft ---------------- */
    //
    //   m_air_in  = FD capability * (1 - (dP+50)/K)
    //   m_gas_out = ID capability * (1 + (dP+50)/K)
    //   d(draft)/dt = C * (m_air_in + m_fuel_gas - m_gas_out)
    //
    // The system therefore self-balances near -50 Pa whenever the FD and ID
    // are roughly in step, but runs away to the trip limits within ~2 s if
    // either fan is lost — which is exactly what happens on a real boiler.
    if (this.idRunning && this.draftAuto !== false) {
      const trim = this.draftCtrl.step(-this.draft, 50, dt);   // too much suction -> slow the ID
      this.idSpeed = clamp((this.idSpeedBase || 0) + trim, 12, 100);
    } else {
      this.idSpeed = this.idSpeedBase || 0;
    }
    const fdCap = this.fdRunning ? (this.fdSpeed / 100) * 1500 : 0;     // t/h
    const idCap = this.idRunning ? (this.idSpeed / 100) * 1600 : 0;     // t/h
    const airIn = this.fdRunning ? fdCap * (1 - (this.draft + 50) / 2000) : 0;
    const gasOut = this.idRunning ? idCap * (1 + (this.draft + 50) / 2000) : 0;
    const fuelGas = this.totalCoal * 0.9 + this.oilFlow * 15.1 + this.leakFlow * 1.6;
    const draftEq = -50 + 4200 * 0 + 0;                                  // (unused, kept for clarity)
    const dDraft = 2.14 * (airIn + fuelGas - gasOut);
    this.draft = clamp(this.draft + clamp(dDraft, -6000, 6000) * dt, -6500, 6500);
    this.airIn = airIn; this.gasOut = gasOut;

    /* ---------------- 8. Emissions ---------------- */
    const load = clamp(this.qFuel / 830, 0, 1.4);
    const espEff = this.espEnergised ? DESIGN.boiler.esp.designEff * (0.4 + 0.15 * this.espFields.filter(Boolean).length) : 0.35;
    const fgdEff = ctx.fgdRunning ? DESIGN.bop.fgd.eff : 0;
    this.dust = lag(this.dust, 18_000 * (1 - espEff) * load * (1 - 0.9 * fgdEff * 0.4), 20, dt);
    this.so2 = lag(this.so2, this.qFuel > 5 ? 2100 * C.sulphur * (1 - fgdEff) / Math.max(0.2, load) * 0.62 : 0, 25, dt);
    this.noX = lag(this.noX, this.qFuel > 5 ? 260 + 420 * load * (1 + 0.06 * (this.o2 - 3.5)) : 0, 30, dt);
    this.co = lag(this.co, this.qFuel > 5 ? 25 + 180 * Math.max(0, 1.6 - this.o2) + 1600 * this.airShortfall : 0, 15, dt);
    this.opacity = lag(this.opacity, clamp(4 + 90 * (1 - espEff) * load * 14, 0, 100), 18, dt);

    /* ---------------- 9. Flame supervision ---------------- */
    const ignitionEnergy = this.oilFlow * 2.4 + this.flameIntensity * 6;
    let proven = 0;
    const oilSupport = this.oilFlow > 0.8;
    for (const m of this.mills) {
      if (!m.running || m.coalFlow < 3) continue;
      // coal will only stay alight in a hot furnace, or with support oil
      if (this.furnaceTemp > 430 || oilSupport) proven += 4;
    }
    if (oilSupport) proven += Math.min(16, Math.round(this.oilFlow * 4));
    this.flameScanners = Math.min(16, proven);
    const wantFlame = this.totalCoal > 3 || this.oilFlow > 0.35;
    const haveFlame = this.flameScanners > 0;
    // a 12 s flame-proving delay is allowed before a loss-of-ignition is declared
    this.flameFailTimer = (wantFlame && !haveFlame) ? (this.flameFailTimer || 0) + dt : 0;
    this.lossOfIgnition = this.flameFailTimer > 12;
    const targetIntensity = haveFlame
      ? clamp(this.totalCoal / 150 + this.oilFlow / 12 + (this.furnaceTemp > 500 ? 0.25 : 0), 0, 1.2) : 0;
    this.flameIntensity = lag(this.flameIntensity, clamp(targetIntensity, 0, 1.2), 6, dt);
    this.oilPressure = lag(this.oilPressure, this.oilFlow > 0.2 ? 2.6 : 0, 2, dt);

    /* ---------------- 10. Soot blowing / slagging ---------------- */
    this.slagging = clamp(this.slagging + (this.qFuel > 50 ? 0.0000045 * load : 0) * dt
      - (this.sootblowing ? 0.00006 * dt : 0), 0, 0.35);
    if (this.sootblowing) {
      this.sootblowTimer -= dt;
      if (this.sootblowTimer <= 0) this.sootblowing = false;
    }

    return { mOutTotal };
  }

  /** Cheap inverse of the compressed-liquid enthalpy (display / controls). */
  tempFromEnthalpy(h) {
    let lo = 20, hi = 370;
    for (let i = 0; i < 22; i++) {
      const mid = 0.5 * (lo + hi);
      if (S.hfT(mid) < h) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
}

/* ================================================================== *
 *  STEAM TURBINE / GENERATOR / CONDENSER
 * ================================================================== */
class TurbineGenerator {
  constructor() { this.reset(); }

  reset() {
    const T = DESIGN.turbine, G = DESIGN.generator;
    this.speed = 0;
    this.acceleration = 0;
    this.tripped = true;
    this.breakerClosed = false;
    this.turningGear = false;
    this.jackingOil = false;
    this.lubeOilPressure = 0;
    this.controlOilPressure = 0;
    this.governorValve = 0;         // %
    this.stopValve = 0;
    this.interceptValve = 0;
    this.loadSetpoint = 0;          // MW
    this.rampRate = 6;              // MW/min
    this.speedSetpoint = 0;
    this.metalTempHP = 30;
    this.metalTempIP = 30;
    this.casingExpansion = 0;
    this.differentialExpansion = 0;
    this.axialShift = 0.02;
    this.eccentricity = 0.012;
    this.vibrations = [1.2, 1.4, 1.1, 1.6, 1.3, 1.5, 1.2, 1.8];
    this.bearingMetalTemps = [45, 46, 44, 47, 45, 48, 43, 46];
    this.sealSteam = 0;
    this.vacuum = 101.3;            // kPa(a)
    this.exhaustTemp = 30;
    this.moisture = 0;
    this.glandSteamPressure = 0;

    // thermal / flow
    this.msFlow = 0; this.msPressure = 0.101; this.msTemp = 30;
    this.hpExhPressure = 0.101; this.hpExhTemp = 30;
    this.crhPressure = 0.101; this.crhTemp = 30;
    this.hrhPressure = 0.101; this.hrhTemp = 30;
    this.ipExhPressure = 0.101; this.ipExhTemp = 30;
    this.lpExhPressure = 101.3; this.lpExhTemp = 30;
    this.rhFlow = 0; this.condFlow = 0;
    this.grossMW = 0; this.shaftMW = 0;
    this.heatRate = 0;

    // generator
    this.mvars = 0; this.mva = 0; this.pf = 0; this.terminalKV = 0;
    this.statorCurrent = 0; this.fieldCurrent = 0; this.fieldVolts = 0;
    this.statorTemp = 32; this.rotorTemp = 34;
    this.h2Pressure = 0; this.h2Purity = 98.5;
    this.gridFreq = DESIGN.gridFrequency;
    this.avrAuto = true; this.voltageSetpoint = 100;

    // condenser / CW
    this.condenserVacuum = 101.3;
    this.hotwellLevel = 900;
    this.hotwellTemp = 30;
    this.cwInletTemp = 30; this.cwOutletTemp = 30; this.cwFlow = 0;
    this.condConductivity = 0.08; this.dissolvedOxygen = 0.012;
    this.airIngress = DESIGN.condenser.airIngressDesign;
    this.vacuumPumpRunning = false;
    this.cwPumpRunning = [false, false];
    this.condenserFouling = 0.05;
    this.qCond = 0;

    // controls
    this.speedCtrl = new PID(0.250, 0.002, 0.80, 0, 100);  // % governor per rpm of error
    this.loadCtrl = new PID(0.85, 0.006, 0.0, 0, 100);
    this.vacuumCtrl = new PID(0.5, 0.02, 0, 0, 100);
    this.mode = 'manual';           // manual | speed | load | initial-pressure
    this.gvManual = 0;
    this.condensateFlowTarget = 0;
    this.rotorBow = 0; this.bladeFault = 0; this.thrustFault = 0;
    this.bearingFault = 0; this.oilLeak = 0;
    this.lubeOilPump = false; this.cwPump1 = false; this.cwPump2 = false;
    this.makeUpValve = 0; this.hLpExh = 2500;
  }

  /**
   * ctx = { dt, boilerPressure, boilerMsTemp, boilerRhOut (degC), ambient,
   *         wetBulb, gridFrequency, faults }
   */
  step(ctx) {
    const dt = ctx.dt;
    const T = DESIGN.turbine, G = DESIGN.generator;
    const St = DESIGN.steam;

    /* ---------------- governor / speed control ---------------- */
    if (this.tripped) {
      this.stopValve = rateLimit(this.stopValve, 0, 300, dt);
      this.governorValve = rateLimit(this.governorValve, 0, 400, dt);
      this.interceptValve = rateLimit(this.interceptValve, 0, 300, dt);
    } else {
      this.stopValve = rateLimit(this.stopValve, 100, 200, dt);
      this.interceptValve = rateLimit(this.interceptValve, 100, 200, dt);
      if (this.mode === 'speed' && !this.breakerClosed) {
        // run-up: hold the programmed ramp, then soak
        const err = this.speedSetpoint - this.speed;
        const cmd = this.speedCtrl.step(this.speed, this.speedSetpoint, dt);
        this.governorValve = rateLimit(this.governorValve, clamp(cmd, 0, 100), 30, dt);
      } else if (this.mode === 'load' && this.breakerClosed) {
        const cmd = this.loadCtrl.step(this.grossMW, this.loadSetpoint, dt);
        this.governorValve = rateLimit(this.governorValve, clamp(cmd, 0, 100), 120, dt);
      } else {
        this.governorValve = rateLimit(this.governorValve, this.gvManual || 0, 120, dt);
      }
    }

    /* ---------------- steam flow network ---------------- */
    // Iterative solve: HP flow <-> cold reheat pressure <-> IP/LP flows.
    let mms = this.msFlow, mrh = this.rhFlow;
    let pCrh = this.crhPressure;
    const pCond = clamp(this.condenserVacuum, 2.5, 101.3);
    const gv = (this.stopValve / 100) * (this.governorValve / 100);
    const pHeader = Math.max(0.05, ctx.headerPressure);
    // first stage pressure sits just below the header, throttled by the governor
    const pHpIn = pHeader * (0.20 + 0.78 * gv);
    for (let it = 0; it < 4; it++) {
      mrh = Math.max(0, mms) * (1 - EXT_HP);
      const tHrhK = (this.hrhTemp + 273.15);
      pCrh = clamp(0.35 + 3.55 * (mrh / (St.reheatFlow * 0.877)) * Math.sqrt(tHrhK / 811), 0.12, 6.5);
      const tMsK = Math.max(300, this.msTemp + 273.15);
      const denom = Math.sqrt(Math.max(0.01, St.mainSteamPressure ** 2 - St.reheatInletPressure ** 2));
      const num = Math.sqrt(Math.max(0, pHpIn ** 2 - pCrh ** 2));
      mms = Math.max(0, St.mainSteamFlow * gv * (num / denom) * Math.sqrt(811 / tMsK));
    }
    this.msPressure = lag(this.msPressure, pHpIn, 1.5, dt);
    // lag the flows so the network cannot algebraically oscillate
    this.msFlow = lag(this.msFlow, mms, 1.2, dt);
    this.rhFlow = lag(this.rhFlow, mrh, 1.5, dt);
    this.crhPressure = lag(this.crhPressure, pCrh, 2.5, dt);

    this.msTemp = lag(this.msTemp, ctx.boilerMsTemp, 6.0, dt);
    this.hrhTemp = lag(this.hrhTemp, ctx.boilerRhOut, 9.0, dt);
    this.hrhPressure = this.crhPressure * 0.92;
    this.ipExhPressure = clamp(0.90 * (this.rhFlow / St.reheatFlow) + 0.03, 0.02, 2.5);

    /* ---------------- expansion & work ---------------- */
    let shaft = 0;
    const mmsKg = this.msFlow / 3.6, mrhKg = this.rhFlow / 3.6;
    if (this.msFlow > 2 && this.msTemp > 200) {
      const hMs = S.hSteam(this.msPressure, this.msTemp);
      // HP
      const eHp = S.expandIsentropic(this.msPressure, this.msTemp, this.crhPressure);
      const dhHp = T.efficiency.hp * (hMs - eHp.h2s);
      const hCrh = hMs - dhHp;
      this.hpExhTemp = S.tSteam(this.crhPressure, hCrh);
      this.crhTemp = this.hpExhTemp;
      this.hpExhPressure = this.crhPressure;
      shaft += mmsKg * dhHp;

      // IP (reheated)
      const hHrh = S.hSteam(this.hrhPressure, this.hrhTemp);
      const eIp = S.expandIsentropic(this.hrhPressure, this.hrhTemp, this.ipExhPressure);
      const dhIp = T.efficiency.ip * (hHrh - eIp.h2s);
      const hIpExh = hHrh - dhIp;
      this.ipExhTemp = S.tSteam(this.ipExhPressure, hIpExh);
      shaft += mrhKg * dhIp;

      // LP (extractions removed)
      const extLp = EXT_LP * mmsKg;
      const mLp = Math.max(0.5, mrhKg - extLp);
      const eLp = S.expandIsentropic(this.ipExhPressure, this.ipExhTemp, pCond);
      const dhLp = T.efficiency.lp * (hIpExh - eLp.h2s);
      const hLpExh = hIpExh - dhLp;
      this.lpExhTemp = Math.max(S.satAtP(pCond).Tsat, S.satAtP(pCond).Tsat + (eLp.wet ? 0 : this.ipExhTemp - 200));
      this.moisture = 1 - S.dryness(pCond, hLpExh);
      shaft += mLp * dhLp;
      this.condFlow = mLp * 3.6;
      this.hLpExh = hLpExh;
      this.qCond = mLp * (hLpExh - S.hfT(Math.min(this.hotwellTemp, 90)));   // kW
    } else {
      this.qCond = 0;
      this.condFlow = 0;
      this.moisture = 0;
      this.hpExhTemp = lag(this.hpExhTemp, ctx.ambient, 200, dt);
      this.ipExhTemp = lag(this.ipExhTemp, ctx.ambient, 200, dt);
      this.lpExhTemp = lag(this.lpExhTemp, ctx.ambient, 200, dt);
      this.hLpExh = 2500;
    }

    shaft *= T.calibration;
    this.shaftMW = shaft / 1000 * T.mechEfficiency;

    // windage / churning when the machine is at speed with little steam
    const windage = this.speed > 200 ? 0.55 * Math.pow(this.speed / 3000, 3) : 0;
    const netTorque = this.shaftMW - windage - (this.breakerClosed ? 0 : 0.15);
    this.grossMW = Math.max(0, this.shaftMW * T.genEfficiency) * (this.breakerClosed ? 1 : 0);

    /* ---------------- rotor dynamics ---------------- */
    if (this.breakerClosed) {
      // locked to the grid
      this.speed = lag(this.speed, 3000 * (ctx.gridFrequency / DESIGN.gridFrequency), 0.35, dt);
      this.acceleration = 0;
      this.wheelEfficiency = 1;
    } else {
      const J = 38_000;                          // kg*m^2 rotor inertia
      const omega = this.speed * 2 * Math.PI / 60;
      // Part-speed (velocity-ratio) efficiency.  Blade speed / steam speed is
      // nu = nuD * (N/3000); the turbomachine characteristic 4*nu*(1-nu) is
      // normalised so that it is 1.0 at rated speed.  Dividing by omega gives a
      // torque coefficient that stays finite at standstill (stall torque).
      const nuD = 0.45, wRated = 2 * Math.PI * 3000 / 60;
      const kNu = nuD / wRated;
      const nu = nuD * clamp(this.speed / 3000, 0, 1.3);
      const tCoef = 4 * kNu * (1 - nu) / (4 * nuD * (1 - nuD));   // N*m per watt
      this.wheelEfficiency = clamp(4 * nu * (1 - nu) / (4 * nuD * (1 - nuD)), 0, 1.02);
      const torqueDev = this.shaftMW * 1e6 * tCoef;               // N*m
      const torqueWind = omega > 1 ? (windage * 1e6) / omega : 0;
      const torqueFric = (this.breakerClosed ? 0 : 0.15e6 / Math.max(6, omega))
        + (this.speed > 5 ? 0.00018 * this.speed * 1e3 : 0) + 900;
      const domega = (torqueDev - torqueWind - torqueFric) / J;
      let speed = Math.max(0, omega + domega * dt) * 60 / (2 * Math.PI);
      if (this.turningGear) speed = lag(speed, T.turningGearSpeed, 6, dt);
      if (!this.turningGear && speed < 1 && torqueDev < torqueFric) speed = 0;
      this.acceleration = (speed - this.speed) / Math.max(dt, 1e-3);
      this.speed = speed;
    }
    // never exceed the mechanical overspeed limit without tripping
    this.speed = clamp(this.speed, 0, 3600);

    /* ---------------- condenser & circulating water ---------------- */
    this.cwPumpRunning[0] = this.cwPump1; this.cwPumpRunning[1] = this.cwPump2;
    const cwFlowRated = DESIGN.condenser.cwFlow;
    let cwFlow = 0;
    if (this.cwPumpRunning[0]) cwFlow += cwFlowRated * 0.55;
    if (this.cwPumpRunning[1]) cwFlow += cwFlowRated * 0.55;
    this.cwFlow = lag(this.cwFlow, cwFlow, 6, dt);

    const cwKg = this.cwFlow / 3.6;
    const cwCp = 4.18;
    // Solve the condenser: Q = UA*(Tsat(vac) - Tcw_mean)
    let vac = this.condenserVacuum;
    const UA = DESIGN.condenser.uaClean * (1 - this.condenserFouling) * (this.cwFlow > 100 ? 1 : 0.05);
    if (this.qCond > 100 && cwKg > 1) {
      let lo = 2.0, hi = 60.0;
      for (let i = 0; i < 30; i++) {
        const p = 0.5 * (lo + hi);
        const tSat = S.satAtP(p / 1000).Tsat;
        const qRej = this.qCond / (cwKg * cwCp);
        const tMean = this.cwInletTemp + qRej / 2;
        const q = (UA / 1000) * (tSat - tMean);       // MW
        if (q > this.qCond / 1000) hi = p; else lo = p;
      }
      vac = 0.5 * (lo + hi);
    } else {
      vac = lag(vac, this.vacuumPumpRunning ? Math.max(12, ctx.ambient * 0.45) : 101.3, 40, dt);
    }
    // Air ingress raises the total pressure above the saturation pressure.
    const airPartial = this.vacuumPumpRunning
      ? clamp(this.airIngress / Math.max(0.35, 1.6 - this.airIngress * 0.4), 0, 5)
      : 12.0;
    let vacTarget, vacTau;
    if (this.qCond > 100 && cwKg > 1) {
      vacTarget = vac + airPartial;
      vacTau = 8;
    } else if (this.vacuumPumpRunning) {
      // hogging / holding pumps pulling the condenser down from atmospheric
      vacTarget = Math.max(10, ctx.ambient * 0.42) + airPartial;
      vacTau = 260;
    } else {
      vacTarget = 101.3; vacTau = 90;
    }
    // no gland seals => air pours in through the shaft-end packings
    if (this.sealSteam < 0.3 && !this.breakerClosed) vacTarget = Math.max(vacTarget, 62);
    this.condenserVacuum = lag(this.condenserVacuum, clamp(vacTarget, 1.5, 101.3), vacTau, dt);
    this.lpExhPressure = this.condenserVacuum;
    const tCondSat = S.satAtP(this.condenserVacuum / 1000).Tsat;
    // exhaust temperature: saturation + windage heating at low flow
    const loadFrac = clamp(this.condFlow / (DESIGN.steam.mainSteamFlow * 0.70), 0, 1.2);
    const windageRise = this.speed > 500 ? 55 * Math.pow(1 - clamp(loadFrac, 0, 1), 2.2) : 0;
    this.exhaustTemp = lag(this.exhaustTemp, tCondSat + windageRise, 25, dt);
    this.hotwellTemp = lag(this.hotwellTemp, tCondSat - 1.5, 60, dt);

    // cooling water temperatures
    const range = cwKg > 1 ? (this.qCond / 1000) * 1000 / (cwKg * cwCp) : 0;
    this.cwOutletTemp = lag(this.cwOutletTemp, this.cwInletTemp + range, 30, dt);

    // hotwell inventory
    const makeUpFlow = this.makeUpValve || 0;
    const imb = this.condFlow - (this.condensateFlowTarget || this.condFlow) + makeUpFlow;
    this.hotwellLevel = clamp(this.hotwellLevel + (imb / 3.6) * 1000 / 90 * 1000 * 0.00045, 0, 2000);

    /* ---------------- generator ---------------- */
    if (this.breakerClosed) {
      this.gridFreq = ctx.gridFrequency;
      this.terminalKV = G.voltage * (this.voltageSetpoint / 100);
      const mva = Math.sqrt(this.grossMW ** 2 + this.mvars ** 2);
      this.mva = mva;
      this.pf = mva > 1 ? this.grossMW / mva : 1;
      this.statorCurrent = clamp((mva * 1e6) / (Math.sqrt(3) * this.terminalKV * 1000), 0, 30_000);
      if (this.avrAuto) {
        const target = (this.voltageSetpoint / 100) * 0.85;
        this.mvars = lag(this.mvars, Math.max(-120, this.grossMW * Math.tan(Math.acos(clamp(target, 0.5, 0.98)))), 8, dt);
      }
    } else {
      this.mvars = 0; this.mva = 0; this.pf = 0; this.statorCurrent = 0;
      this.terminalKV = this.speed > 2400 ? G.voltage * (this.voltageSetpoint / 100) : 0;
      this.gridFreq = this.speed / 60;
    }
    const iFrac = clamp(this.statorCurrent / G.current, 0, 1.6);
    this.statorTemp = lag(this.statorTemp, 32 + 74 * iFrac ** 2 * (1 + 0.05 * (1 - this.h2Purity / 100) * 10), 90, dt);
    this.rotorTemp = lag(this.rotorTemp, 34 + 78 * (this.fieldCurrent / 2100) ** 2 * 0.9 + 4, 120, dt);
    this.fieldCurrent = lag(this.fieldCurrent, this.breakerClosed ? 900 + 1150 * clamp(this.mvars / 300 + 0.35, 0, 1.2) : 0, 20, dt);
    this.fieldVolts = lag(this.fieldVolts, this.breakerClosed ? 210 + 195 * clamp(this.fieldCurrent / 2100, 0, 1.2) : 0, 15, dt);
    this.h2Pressure = lag(this.h2Pressure, this.breakerClosed || this.speed > 2500 ? 0.38 : 0.05, 120, dt);
    this.h2Purity = lag(this.h2Purity, 98.4 - (this.h2Pressure > 0.2 ? 0 : 3.5), 300, dt);

    /* ---------------- mechanical condition ---------------- */
    const spd = this.speed;
    const unbalance = 0.9 + 2.4 * clamp(Math.abs(spd - 1250) < 180 ? 1 - Math.abs(spd - 1250) / 180 : 0, 0, 1)
      + 1.8 * clamp(Math.abs(spd - 1780) < 200 ? 1 - Math.abs(spd - 1780) / 200 : 0, 0, 1)
      + 1.3 * clamp(Math.abs(spd - 2320) < 220 ? 1 - Math.abs(spd - 2320) / 220 : 0, 0, 1);
    const loadVib = 1 + 0.6 * clamp(this.grossMW / DESIGN.generator.ratedMW, 0, 1.2);
    const vacVib = 1 + 0.35 * clamp((this.condenserVacuum - 10) / 20, 0, 1.5);
    const base = 1.1 * unbalance * loadVib * vacVib + (this.moisture - 0.08) * 60 * (this.moisture > 0.08 ? 1 : 0);
    for (let i = 0; i < this.vibrations.length; i++) {
      const noise = 1 + 0.05 * Math.sin(ctx.time * (1.3 + i * 0.21) + i);
      const tgt = clamp(base * (0.7 + 0.12 * i) * noise + (i === 3 ? (this.bladeFault || 0) * 90 : 0), 0.4, 400);
      this.vibrations[i] = lag(this.vibrations[i], tgt, 3, dt);
    }
    this.eccentricity = lag(this.eccentricity,
      this.speed < 10 && !this.turningGear ? clamp(0.012 + this.rotorBow * 0.09, 0, 0.2) : 0.012 + 0.004 * Math.sin(ctx.time * 0.7), 30, dt);
    this.axialShift = lag(this.axialShift, 0.02 + 0.02 * clamp(this.grossMW / 660, 0, 1) + (this.thrustFault || 0) * 0.9, 20, dt);
    this.differentialExpansion = lag(this.differentialExpansion,
      clamp((this.metalTempHP - 30) * 0.045 - (this.speed / 3000) * 1.4, -3, 14), 200, dt);
    this.casingExpansion = lag(this.casingExpansion, clamp((this.metalTempHP - 30) * 0.075, 0, 40), 250, dt);

    // metal temperatures follow the steam
    this.metalTempHP = lag(this.metalTempHP, lerp(ctx.ambient, this.msTemp, clamp(this.msFlow / 400, 0, 1) * 0.9 + 0.05), 420, dt);
    this.metalTempIP = lag(this.metalTempIP, lerp(ctx.ambient, this.hrhTemp, clamp(this.rhFlow / 400, 0, 1) * 0.9 + 0.05), 480, dt);
    for (let i = 0; i < this.bearingMetalTemps.length; i++) {
      const tgt = 38 + 22 * clamp(this.speed / 3000, 0, 1.1) + 14 * clamp(this.grossMW / 660, 0, 1)
        + (this.lubeOilPressure < 0.09 ? 22 : 0) + (i === 2 ? (this.bearingFault || 0) * 35 : 0);
      this.bearingMetalTemps[i] = lag(this.bearingMetalTemps[i], tgt, 90, dt);
    }

    // lube oil
    const oilTarget = (this.lubeOilPump || this.turningGear) ? 0.16 : (this.speed > 200 ? 0.155 : 0.02);
    this.lubeOilPressure = lag(this.lubeOilPressure, oilTarget * (1 - (this.oilLeak || 0) * 0.7), 8, dt);
    this.controlOilPressure = lag(this.controlOilPressure, this.lubeOilPressure * 8.5, 6, dt);
    this.jackingOilPressure = this.jackingOil ? 12 : 0;

    this.heatRate = this.grossMW > 20 ? (ctx.fuelHeat * 3600) / this.grossMW : 0;
    return null;
  }
}

/* ================================================================== *
 *  BALANCE OF PLANT
 * ================================================================== */
class BalanceOfPlant {
  constructor() { this.reset(); }

  reset() {
    this.bfp = [
      { running: false, speed: 0, flow: 0, current: 0, discharge: 0.2, suction: 0.6, vibration: 1.0 },
      { running: false, speed: 0, flow: 0, current: 0, discharge: 0.2, suction: 0.6, vibration: 1.0 },
    ];
    this.cep = [
      { running: false, flow: 0, current: 0, discharge: 1.2 },
      { running: false, flow: 0, current: 0, discharge: 1.2 },
    ];
    this.deaeratorPressure = 0.101;
    this.deaeratorLevel = 1600;
    this.deaeratorTemp = 30;
    this.hpHeaterLevels = [0, 0, 0];
    this.lpHeaterLevels = [0, 0, 0, 0];
    this.fwFlow = 0; this.fwTemp = 30; this.fwPressure = 0.2;
    this.condensateFlow = 0;
    this.auxMW = 0;
    this.stockpile = DESIGN.coal.stockpileCapacity * 0.72;
    this.conveyorRunning = false;
    this.conveyorLoad = 0;
    this.crusherRunning = false;
    this.bunkerLevels = [72, 72];          // % per boiler
    this.fgdRunning = false;
    this.fgdPh = 5.6;
    this.fgdDensity = 1.12;
    this.gypsumSilo = 30;
    this.ashSilo = 22;
    this.dmWaterTank = 68;
    this.ambient = 29;
    this.wetBulb = 25;
    this.auxSteamPressure = 0.9;
    this.auxSteamSource = 'Auxiliary boiler / CRH';
    this.ambientTarget = 29; this.wetBulbTarget = 25; this.dmMakeUp = false;
    this.makeUpValve = 0;
    this.serviceWater = 82;
    this.instrumentAir = 0.72;
    this.stationAir = 0.68;
  }

  step(dt, plant) {
    const boilers = plant.boilers;
    const active = boilers.filter(b => b.inService).length || 1;
    const steamDemand = plant.tg.msFlow;
    const perBoiler = steamDemand / active;

    /* ---- feedwater: 3-element drum level control ---- */
    for (let i = 0; i < boilers.length; i++) {
      const b = boilers[i];
      if (!b.inService) { b.fwFlow = lag(b.fwFlow, 0, 8, dt); continue; }
      if (b.levelCtrlAuto) {
        // three-element control: drum level trim + steam-flow feed-forward
        const level = b.drumLevel + b.levelSwell;
        const bias = b.levelCtrl.step(level, b.levelSetpoint || 0, dt);
        // Three-element control: the filtered measured steam flow is the lead
        // element (it is what actually leaves the drum), with the demand as a
        // floor so the level cannot be starved during a load increase.
        b.fwFF = lag(b.fwFF || 0, Math.max(perBoiler * 0.55, b.msFlow || 0), 18, dt);
        const ff = b.fwFF + (b.ventFlow || 0) + b.blowdown + b.leakFlow + b.spray1 + b.spray2;
        b.fwFlow = lag(b.fwFlow, clamp(ff + bias, 0, 1150), 8, dt);
      } else {
        b.fwFlow = lag(b.fwFlow, b.fwManual || 0, 3.5, dt);
      }
    }
    this.fwFlow = boilers.reduce((a, b) => a + b.fwFlow, 0);

    /* ---- BFP ---- */
    const bfpRunning = this.bfp.filter(p => p.running).length;
    const bfpCap = bfpRunning * 1050;
    const bfpAvail = clamp(bfpCap / Math.max(1, this.fwFlow), 0, 3);
    let delivered = this.fwFlow * Math.min(1, bfpAvail);
    for (const p of this.bfp) {
      if (p.running) {
        p.flow = lag(p.flow, delivered / Math.max(1, bfpRunning), 3, dt);
        p.speed = lag(p.speed, clamp(62 + 30 * (p.flow / 1050), 40, 100), 10, dt);
        p.current = lag(p.current, 120 + 280 * (p.flow / 1050), 6, dt);
        p.discharge = lag(p.discharge, 12.5 + 8.5 * clamp(this.fwFlow / 2000, 0, 1.1)
          + (plant.boilers[0]?.drumPressure || 0.2) * 0.55, 6, dt);
        p.vibration = lag(p.vibration, 1.2 + 1.4 * (p.flow / 1050) + (p.cavitation ? 6 : 0), 5, dt);
      } else {
        p.flow = lag(p.flow, 0, 3, dt); p.speed = lag(p.speed, 0, 8, dt);
        p.current = lag(p.current, 0, 5, dt); p.discharge = lag(p.discharge, 0.3, 6, dt);
        p.vibration = lag(p.vibration, 0.5, 5, dt);
      }
    }
    const fwSet = delivered;
    for (const b of boilers) {
      if (!b.inService) continue;
      // BFP discharge = drum pressure + feed-regulating valve / heater / pipe
      // differential (1.8 MPa light-off rising with flow), limited by the pump
      // shut-off head.  The differential is what makes attemperation possible.
      const head = b.drumPressure + 1.8 + 1.4 * clamp(fwSet / 1900, 0, 1.2);
      b.fwPressure = lag(b.fwPressure, Math.max(0.3, (this.bfp[0].running || this.bfp[1].running)
        ? Math.min(DESIGN.bop.bfpShutoff || 22.5, Math.max(2, head)) : 0.3), 6, dt);
    }

    /* ---- condensate / deaerator / heaters ---- */
    const condDemand = plant.tg.condFlow;
    this.condensateFlow = lag(this.condensateFlow, condDemand * (this.cep.some(c => c.running) ? 1 : 0), 4, dt);
    for (const c of this.cep) {
      if (c.running) {
        c.flow = lag(c.flow, this.condensateFlow / (this.cep.filter(x => x.running).length || 1), 4, dt);
        c.current = lag(c.current, 60 + 95 * (c.flow / 1050), 6, dt);
        c.discharge = lag(c.discharge, 1.4 + 1.1 * clamp(c.flow / 1050, 0, 1.2), 5, dt);
      } else {
        c.flow = lag(c.flow, 0, 4, dt); c.current = lag(c.current, 0, 5, dt);
        c.discharge = lag(c.discharge, 0.2, 5, dt);
      }
    }
    const loadF = clamp(plant.tg.msFlow / DESIGN.steam.mainSteamFlow, 0, 1.15);
    this.deaeratorPressure = lag(this.deaeratorPressure, 0.12 + 0.62 * loadF, 40, dt);
    this.deaeratorTemp = lag(this.deaeratorTemp, S.satAtP(Math.max(0.1, this.deaeratorPressure)).Tsat, 60, dt);
    this.deaeratorLevel = lag(this.deaeratorLevel, 1600 + 320 * Math.sin(plant.time / 320) * loadF
      - (this.makeUpValve || 0) * 6, 40, dt);
    for (let i = 0; i < 3; i++) this.hpHeaterLevels[i] = lag(this.hpHeaterLevels[i], 30 + 55 * loadF + 12 * i, 60, dt);
    for (let i = 0; i < 4; i++) this.lpHeaterLevels[i] = lag(this.lpHeaterLevels[i], 25 + 48 * loadF + 9 * i, 60, dt);

    // final feedwater temperature out of the HP heater train
    const hFw = S.hWater(Math.max(0.3, this.bfp[0].discharge), 40) + (1086 - 168) * clamp(loadF, 0.12, 1.1) ** 0.85;
    const tFw = (() => { let lo = 30, hi = 300; for (let i = 0; i < 20; i++) { const m = 0.5 * (lo + hi); if (S.hfT(m) < hFw) lo = m; else hi = m; } return 0.5 * (lo + hi); })();
    this.fwTemp = lag(this.fwTemp, clamp(tFw, 30, 285), 120, dt);
    for (const b of boilers) b.fwTemp = this.fwTemp;

    /* ---- coal handling ---- */
    const coalBurn = boilers.reduce((a, b) => a + b.totalCoal, 0) / 3600 * dt;   // t
    this.stockpile = clamp(this.stockpile - coalBurn * (this.conveyorRunning ? 0 : 1), 0, DESIGN.coal.stockpileCapacity);
    this.conveyorLoad = this.conveyorRunning ? clamp(420 + 380 * loadF, 0, 900) : 0;
    for (let i = 0; i < 2; i++) {
      const b = boilers[i];
      const burn = b.totalCoal / 3600 * dt;
      const fill = this.conveyorRunning && this.crusherRunning ? (this.conveyorLoad / 3600) * dt * 0.5 : 0;
      this.bunkerLevels[i] = clamp(this.bunkerLevels[i] - (burn / DESIGN.coal.bunkerCapacity) * 100
        + (fill / DESIGN.coal.bunkerCapacity) * 100, 0, 100);
    }

    /* ---- FGD / ash ---- */
    const ashProd = boilers.reduce((a, b) => a + b.totalCoal, 0) * DESIGN.coal.ash / 100;   // t/h
    this.fgdPh = lag(this.fgdPh, this.fgdRunning ? 5.5 + 0.25 * Math.sin(plant.time / 900) : 6.4, 200, dt);
    this.fgdDensity = lag(this.fgdDensity, this.fgdRunning ? 1.13 : 1.02, 300, dt);
    this.gypsumSilo = clamp(this.gypsumSilo + (this.fgdRunning ? ashProd * 0.0004 : 0) * dt, 0, 100);
    this.ashSilo = clamp(this.ashSilo + ashProd * 0.0009 * dt, 0, 100);
    this.dmWaterTank = clamp(this.dmWaterTank - (plant.tg.grossMW / 660) * 0.00035 * dt + (this.dmMakeUp ? 0.0009 * dt : 0), 0, 100);

    /* ---- auxiliary power ---- */
    let aux = 2.5;
    for (const p of this.bfp) if (p.running) aux += 12.5 * (0.35 + 0.65 * (p.flow / 1050));
    for (const c of this.cep) if (c.running) aux += 1.45 * (0.4 + 0.6 * (c.flow / 1050));
    for (const b of boilers) {
      if (b.idRunning) aux += 2.6 * (b.idSpeed / 100);
      if (b.fdRunning) aux += 1.5 * (b.fdSpeed / 100);
      if (b.paRunning) aux += 1.05 * (b.paSpeed / 100);
      for (const m of b.mills) if (m.running) aux += 0.42 + 0.008 * m.coalFlow;
      if (b.espEnergised) aux += 1.1;
    }
    if (this.fgdRunning) aux += 6.5;
    if (plant.tg.cwPumpRunning[0]) aux += 2.8;
    if (plant.tg.cwPumpRunning[1]) aux += 2.8;
    if (plant.tg.vacuumPumpRunning) aux += 0.22;
    if (this.conveyorRunning) aux += 0.9;
    aux += 1.4 + 2.2 * loadF;
    this.auxMW = lag(this.auxMW, aux, 5, dt);

    this.ambient = lag(this.ambient, this.ambientTarget, 600, dt);
    this.wetBulb = lag(this.wetBulb, this.wetBulbTarget, 600, dt);
  }
}

module.exports = { Boiler, TurbineGenerator, BalanceOfPlant, PID, lag, rateLimit, clamp, lerp };
