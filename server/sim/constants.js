/**
 * constants.js — Plant design data, equipment name-plates and protection limits.
 *
 * Reference unit: a 660 MWe subcritical, tandem-compound, reheat machine fed by
 * TWO identical pulverised-coal drum boilers ("twin boiler" arrangement).
 * Steam conditions follow the classic 16.7 MPa / 538 / 538 degC subcritical
 * cycle described in the reference material, with a natural-draft cooling
 * tower and a 50 Hz grid (Philippine / Mindanao grid practice).
 */

'use strict';

const DESIGN = {
  plant: 'Mindanao Twin-Boiler Coal-Fired Power Station',
  unit: 'Unit 1 — 660 MWe',
  gridFrequency: 50,        // Hz
  generator: {
    ratedMVA: 776,
    ratedMW: 660,
    pf: 0.85,
    voltage: 19,            // kV
    current: 23_580,        // A
    hydrogenPressure: 0.40, // MPa(g)
    excitation: 'Static brushless, 415 V / 2100 A',
  },

  // ---------------- Steam cycle design points ----------------
  steam: {
    mainSteamPressure: 16.7,   // MPa(a) at HP turbine inlet
    mainSteamTemp: 538,        // degC
    reheatInletPressure: 3.90, // MPa(a) cold reheat
    reheatOutletTemp: 538,     // degC hot reheat
    mainSteamFlow: 1860,       // t/h total at MCR (930 t/h per boiler)
    reheatFlow: 1580,          // t/h
    feedwaterTemp: 250,        // degC at economiser inlet
    condenserPressure: 9.5,    // kPa(a)
    drumPressureRated: 18.1,   // MPa(a) drum (slightly above turbine inlet)
    feedwaterPressure: 20.5,   // MPa(a) BFP discharge
    makeupRate: 2.0,           // % of steam flow, design
  },

  // ---------------- Boiler (each of the two) ----------------
  boiler: {
    count: 2,
    type: 'Natural circulation, balanced draft, water-tube drum boiler',
    firing: 'Corner (tangential) fired, 4 elevations, 4 mills',
    mainSteamFlow: 930,        // t/h per boiler
    reheatFlow: 790,           // t/h per boiler
    drumInnerDiameter: 1.78,   // m
    drumLength: 21.0,          // m
    drumNormalLevel: 0,        // mm (centre line reference)
    waterInventory: 118_000,   // kg of water in the evaporator circuit
    steamInventory: 9_500,     // kg of steam in the drum / separators
    metalMass: 1_250_000,      // kg of pressure-part metal
    metalCp: 0.50,             // kJ/(kg*K)
    surfaceArea: {
      waterwall: 4_200,        // m^2
      superheater: 5_100,      // m^2
      reheater: 3_400,         // m^2
      economiser: 3_900,       // m^2
    },
    designEfficiency: 0.895,
    excessAir: 0.20,           // 20 % excess air -> ~3.5 % O2 in flue gas
    mills: 4,
    millRatedCoal: 38,         // t/h per mill
    burners: 16,
    ignitors: 16,
    aph: { gasIn: 355, gasOut: 135, airIn: 30, airOut: 300 },
    esp: { fields: 4, designEff: 0.995, kV: 55 },
    stack: { height: 180, diameter: 7.0 },
  },

  // ---------------- Fuel ----------------
  coal: {
    name: 'Sub-bituminous (Indonesian / Semirara blend)',
    lhv: 20_000,               // kJ/kg as received
    moisture: 18.0,            // %
    ash: 8.5,                  // %
    volatile: 38.0,            // %
    sulphur: 0.55,             // %
    hgi: 52,
    bunkerCapacity: 2_400,     // t (per boiler, 12 h at MCR)
    stockpileCapacity: 180_000,// t
    stoichAir: 6.55,           // kg air / kg coal
  },

  // ---------------- Turbine ----------------
  turbine: {
    type: 'Tandem-compound, 3-casing (HP-IP-LP), axial exhaust',
    ratedSpeed: 3000,          // rpm
    stages: { hp: 9, ip: 12, lp: 2 * 7 },
    lastStageBlade: 1000,      // mm
    efficiency: { hp: 0.855, ip: 0.895, lp: 0.855 },
    mechEfficiency: 0.990,
    genEfficiency: 0.985,
    turningGearSpeed: 3.15,    // rpm
    criticalSpeeds: [1250, 1780, 2320],
    jackingOilPressure: 12.0,  // MPa
    lubeOilPressure: 0.14,     // MPa
    calibration: 1.0,          // tuned so MCR = 660 MW exactly
  },

  // ---------------- Condenser / Circulating water ----------------
  condenser: {
    surfaceArea: 34_000,       // m^2
    uaClean: 92_000,           // kW/K
    cwFlow: 78_000,            // m^3/h
    cwPumps: 2,
    hotwellCapacity: 90,       // m^3
    vacuumPumps: 2,
    airIngressDesign: 0.6,     // kg/h
  },

  coolingTower: {
    type: 'Natural-draft hyperbolic, counter-flow',
    height: 165,
    baseDiameter: 120,
    approach: 7.5,             // K
    rangeDesign: 9.8,          // K
    fans: 0,                   // natural draft -> no fans
    basinLevel: 3.2,           // m
    makeUp: 'Deep well / river make-up',
  },

  // ---------------- BOP ----------------
  bop: {
    bfp: { count: 2, rated: 1050, power: 12_500 }, // t/h, kW
    cep: { count: 2, rated: 1050, power: 1_450 },
    idFans: { count: 2, power: 2_600 },
    fdFans: { count: 2, power: 1_500 },
    pafans: { count: 2, power: 1_050 },
    cwPumps: { count: 2, power: 2_800 },
    esp: { power: 1_100 },
    fgd: { type: 'Wet limestone, in-situ forced oxidation', eff: 0.965 },
    ashRatio: { fly: 0.80, bottom: 0.20 },
    auxiliaryLoad: 42,         // MW at MCR
  },

  // ---------------- Water / steam chemistry ----------------
  chemistry: {
    feedwaterPh: 9.3,
    drumPh: 9.4,
    silica: 0.015,             // mg/kg
    sodium: 0.004,             // mg/kg
    cations: 0.15,             // uS/cm
    phosphate: 2.5,            // mg/kg (coordinated phosphate treatment)
    hydrazine: 0.030,          // mg/kg
    dissolvedOxygen: 0.005,    // mg/kg
  },

  // ---------------- Emissions design ----------------
  emissions: {
    so2: 320,      // mg/Nm3 @ 6 % O2
    nox: 380,      // mg/Nm3
    dust: 35,      // mg/Nm3
    co: 90,        // mg/Nm3
  },
};

/**
 * Protection thresholds. When a limit is violated the corresponding
 * Master Fuel Trip (MFT) / turbine trip is latched by the sequencer.
 */
const LIMITS = {
  drum: {
    levelLowTrip: -340,        // mm
    levelHighTrip: 340,
    levelLowAlarm: -125,
    levelHighAlarm: 125,
    pressureHighTrip: 19.6,    // MPa(a)  (safety valves lift at 19.2)
    safetyValveSet: 19.2,
    metalDiffMax: 55,          // K, drum metal differential during start-up
  },
  furnace: {
    draftHighTrip: 3200,       // Pa
    draftLowTrip: -3200,
    draftHighAlarm: 900,
    draftLowAlarm: -900,
    fegtMax: 1180,             // degC furnace exit gas temperature
    lossOfFlameTime: 2.0,      // s
  },
  steam: {
    msTempHighTrip: 566,       // degC
    msTempLowTrip: 470,
    rhTempHighTrip: 552,
    msPressureHighTrip: 18.6,
    superheatAttempMax: 90,    // t/h per boiler at MCR
  },
  turbine: {
    overspeedTrip: 3300,       // rpm (110 %)
    vibrationTrip: 125,        // um peak-to-peak
    vibrationAlarm: 75,
    axialShiftTrip: 1.0,       // mm
    eccentricityAlarm: 0.076,  // mm
    exhaustTempHigh: 90,       // degC
    lubeOilTrip: 0.07,         // MPa
    vacuumLowTrip: 28.0,       // kPa(a)
    differentialExpansion: 12, // mm
  },
  generator: {
    statorTempTrip: 120,       // degC
    rotorTempTrip: 115,
    hydrogenPurityLow: 92,     // %
    hydrogenPressureLow: 0.30, // MPa(g)
  },
  condenser: {
    levelHighAlarm: 1200,      // mm
    levelLowAlarm: 400,
    vacuumLowAlarm: 16.0,      // kPa(a)
  },
};

/** Standard start-up pressure / temperature ramp envelope (cold start). */
const STARTUP_ENVELOPE = [
  // up to P (MPa) | max dP/dt (MPa/min) | max drum metal rate (K/h)
  { pMax: 0.5,  dpdt: 0.010, metalRate: 28 },
  { pMax: 3.5,  dpdt: 0.040, metalRate: 40 },
  { pMax: 8.0,  dpdt: 0.080, metalRate: 60 },
  { pMax: 14.0, dpdt: 0.130, metalRate: 80 },
  { pMax: 20.0, dpdt: 0.180, metalRate: 110 },
];

/** Turbine run-up / soak programme (speed, hold time in minutes). */
const RUNUP_PROGRAMME = [
  { speed: 200,  hold: 2,  note: 'Break-away / turning gear disengaged' },
  { speed: 600,  hold: 22, note: 'Low-speed soak — check vibration & eccentricity' },
  { speed: 1250, hold: 0,  note: 'Pass 1st critical speed' },
  { speed: 1800, hold: 8,  note: 'Intermediate soak — casing expansion check' },
  { speed: 2320, hold: 0,  note: 'Pass 2nd critical speed' },
  { speed: 3000, hold: 25, note: 'Rated speed soak before synchronising' },
];

module.exports = { DESIGN, LIMITS, STARTUP_ENVELOPE, RUNUP_PROGRAMME };
