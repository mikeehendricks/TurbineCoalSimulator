/**
 * faults.js — Fault catalogue for the twin-boiler simulator.
 *
 * Every fault has:
 *   id        unique key used by the operator panel and the REST/WebSocket API
 *   group     where it shows up in the fault injector
 *   name      HMI label
 *   severity  1 = nuisance, 2 = serious, 3 = plant threatening
 *   cause     what the operator will see first
 *   symptoms  the propagation chain (shown as the "diagnosis" pane)
 *   actions   the standard operating response
 *   apply()   mutates the plant state when injected
 *   active()  called every tick while the fault is in force
 *   clear()   restores the plant when the operator clears it
 *
 * The protection system (MFT / turbine trip) is evaluated centrally in
 * engine.js so that faults only ever *cause* symptoms; the interlocks decide
 * whether the unit survives them.
 */

'use strict';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const FAULTS = [
  /* ------------------------------ BOILER ------------------------------ */
  {
    id: 'TUBE_LEAK',
    group: 'Boiler',
    name: 'Boiler tube leak (water wall)',
    severity: 3,
    cause: 'Erosion / corrosion / thermal fatigue crack in a water-wall tube.',
    symptoms: [
      'Acoustic leak-detection level rising on the affected wall',
      'Make-up water flow and feedwater flow exceed steam flow',
      'Drum level falling despite feedwater control valve opening',
      'Furnace draft drifting positive, ID fan current rising',
      'Flue-gas temperature downstream of the leak falling',
      'Hissing noise, steam/ash plume from the casing around the leak',
    ],
    actions: [
      'Confirm the leak on the acoustic monitors and the water balance',
      'Transfer feedwater control to manual and hold drum level',
      'Reduce unit load and drum pressure to lower the leak rate',
      'Monitor drum metal differential temperature',
      'Prepare for a controlled shutdown — a leaking tube cuts neighbouring tubes',
      'Never attempt to isolate the furnace while the leak is at pressure',
    ],
    apply(p, m = 1) { p.boilers[p.faultBoiler].tubeLeak = 0.18 * m; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      b.tubeLeak = clamp(b.tubeLeak + 0.0045 * f.magnitude * dt / 60, 0, 0.9);
      b.slagging = clamp(b.slagging + 0.00002 * dt, 0, 0.35);
    },
    clear(p) { p.boilers[p.faultBoiler].tubeLeak = 0; },
  },
  {
    id: 'SH_TUBE_LEAK',
    group: 'Boiler',
    name: 'Superheater tube leak',
    severity: 3,
    cause: 'Overheating / creep rupture in the final superheater.',
    symptoms: [
      'Superheater outlet steam flow > feedwater flow',
      'Main-steam temperature rising, attemperator spray fully open',
      'Localised high flue-gas temperature drop across the SH',
      'Abnormal noise in the penthouse, steam escaping the casing',
    ],
    actions: [
      'Reduce load and main-steam temperature',
      'Do not force the attemperator above its design flow',
      'Shutdown within 4 h — an SH leak escalates very quickly',
    ],
    apply(p, m = 1) { p.boilers[p.faultBoiler].tubeLeak = 0.14 * m; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      b.tubeLeak = clamp(b.tubeLeak + 0.006 * f.magnitude * dt / 60, 0, 0.9);
      b.slagging = clamp(b.slagging + 0.00003 * dt, 0, 0.35);
    },
    clear(p) { p.boilers[p.faultBoiler].tubeLeak = 0; },
  },
  {
    id: 'MILL_BLOCKAGE',
    group: 'Boiler',
    name: 'Pulveriser / coal-pipe blockage',
    severity: 2,
    cause: 'Wet coal, tramp metal or a worn classifier blocking a mill.',
    symptoms: [
      'Mill differential pressure rising, mill current rising then falling',
      'Coal flow from the mill to zero, furnace flame unstable',
      'Mill outlet temperature rising (loss of coal = loss of evaporative cooling)',
      'Furnace draft swinging, O2 rising, load dropping',
    ],
    actions: [
      'Reduce the mill feeder to minimum and clear the blockage',
      'Keep the mill outlet temperature below 95 C (fire risk)',
      'Start a standby mill and re-establish the flame envelope',
      'If two mills are lost, reduce load to the remaining mills capacity',
    ],
    apply(p) { p.boilers[p.faultBoiler].mills[0].blocked = true; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      if (f.magnitude > 1.4) b.mills[1].blocked = true;
    },
    clear(p) {
      for (const b of p.boilers) for (const m of b.mills) m.blocked = false;
    },
  },
  {
    id: 'MILL_FIRE',
    group: 'Boiler',
    name: 'Pulveriser fire',
    severity: 3,
    cause: 'Spontaneous combustion of coal deposits in a stopped mill.',
    symptoms: [
      'Mill outlet temperature rising rapidly above 120 C',
      'CO rising at the mill outlet, smoke from the mill casing',
      'Mill casing metal temperature high',
    ],
    actions: [
      'Stop the mill feeder, keep the mill running to clear the coal',
      'Inject inerting steam / CO2 into the mill',
      'Do NOT stop the mill with coal in it',
      'Isolate the mill only once the temperature is falling',
    ],
    apply(p) { p.boilers[p.faultBoiler].millFire = true; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      const m = b.mills[0];
      m.outletTemp += 0.9 * f.magnitude * dt;
      m.fire = true;
      b.co = b.co + 0; // handled through the boiler model
    },
    clear(p) { for (const b of p.boilers) b.millFire = false; },
  },
  {
    id: 'LOSS_OF_FLAME',
    group: 'Boiler',
    name: 'Loss of ignition / flame failure',
    severity: 3,
    cause: 'Wet coal, low furnace temperature or a mill trip with no support oil.',
    symptoms: [
      'Flame scanners lost on all elevations',
      'Furnace temperature falling, drum pressure falling',
      'Fuel in the furnace with no ignition — explosion risk',
    ],
    actions: [
      'Confirm MFT, all fuel tripped',
      'Purge the furnace for at least 5 minutes before re-lighting',
      'Check coal quality and mill outlet temperature',
    ],
    apply(p) { p.boilers[p.faultBoiler].flameOut = true; },
    active(p) { p.boilers[p.faultBoiler].flameOut = true; },
    clear(p) { for (const b of p.boilers) b.flameOut = false; },
  },
  {
    id: 'APH_FIRE',
    group: 'Boiler',
    name: 'Air preheater fire',
    severity: 3,
    cause: 'Unburnt carbon deposits igniting on the APH baskets.',
    symptoms: [
      'APH gas outlet temperature rising above normal',
      'Hot air temperature rising, APH drive current high / rotor stalled',
      'Sparks and smoke at the APH, CO rising',
    ],
    actions: [
      'Reduce load and firing rate',
      'Keep the APH rotating, activate the APH fire-fighting water/steam',
      'Never stop the APH rotor while it is hot',
      'Be ready for an MFT and an APH isolation',
    ],
    apply(p) { p.boilers[p.faultBoiler].aphFire = 0.15; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      b.aphFire = clamp((b.aphFire || 0) + 0.0008 * f.magnitude * dt, 0, 1);
      b.slagging = clamp(b.slagging + 0.00004 * dt, 0, 0.5);
    },
    clear(p) { for (const b of p.boilers) b.aphFire = 0; },
  },
  {
    id: 'SLAGGING',
    group: 'Boiler',
    name: 'Heavy slagging / ash deposition',
    severity: 1,
    cause: 'Low ash-fusion coal or a soot-blowing programme failure.',
    symptoms: [
      'Furnace exit gas temperature rising',
      'Superheater and reheater spray flows rising',
      'Draught losses increasing, ID fan current rising',
    ],
    actions: [
      'Run the soot-blowing programme for the affected zone',
      'Check coal blending and ash-fusion temperature',
      'Consider a load reduction to bring gas temperatures back',
    ],
    apply(p) { p.boilers[p.faultBoiler].slagging = 0.20; },
    active(p) { /* grows slowly through the normal slagging model */ },
    clear(p) { p.boilers[p.faultBoiler].slagging = 0.02; },
  },
  {
    id: 'DRUM_LEVEL_HIGH',
    group: 'Boiler',
    name: 'Drum level high (feedwater valve failure)',
    severity: 3,
    cause: 'Feedwater control valve failing open or a level transmitter fault.',
    symptoms: [
      'Drum level rising, feedwater flow >> steam flow',
      'Main steam temperature falling rapidly',
      'Carry-over of water into the superheater and turbine',
    ],
    actions: [
      'Take feedwater control to manual and close in',
      'Open the emergency blowdown if the level keeps rising',
      'Trip the turbine before water induction if the level cannot be held',
    ],
    apply(p) { p.boilers[p.faultBoiler].fwValveFail = 1; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      if (b.levelCtrlAuto === false) return;
      b.levelCtrlAuto = false;
      b.fwManual = 1200;
    },
    clear(p) {
      for (const b of p.boilers) { b.fwValveFail = 0; b.levelCtrlAuto = true; }
    },
  },

  /* ------------------------------ FANS / AIR ------------------------------ */
  {
    id: 'ID_FAN_TRIP',
    group: 'Air & Gas',
    name: 'ID fan trip',
    severity: 3,
    cause: 'Motor protection, bearing failure or a damper fault.',
    symptoms: [
      'Furnace draft going sharply positive (+ kPa)',
      'Flame and hot gas issuing from the furnace casing / penthouse',
      'ID fan current to zero, remaining fan overloaded',
    ],
    actions: [
      'MFT will occur on high furnace pressure — confirm all fuel is off',
      'Do not restart the fan against a positive-pressure furnace',
      'Purge before re-lighting, inspect the casing for damage',
    ],
    apply(p) { p.boilers[p.faultBoiler].idRunning = false; },
    active(p) { p.boilers[p.faultBoiler].idRunning = false; },
    clear(p) { /* operator restarts from the panel */ },
  },
  {
    id: 'FD_FAN_TRIP',
    group: 'Air & Gas',
    name: 'FD fan trip',
    severity: 3,
    cause: 'Motor protection or a damper fault.',
    symptoms: [
      'Furnace draft going sharply negative',
      'Total air flow and O2 collapsing, flame unstable',
      'Mills trip on low PA, MFT on loss of air',
    ],
    actions: [
      'Confirm MFT, all mills and oil tripped',
      'Purge the furnace, restore air before re-lighting',
    ],
    apply(p) { p.boilers[p.faultBoiler].fdRunning = false; },
    active(p) { p.boilers[p.faultBoiler].fdRunning = false; },
    clear(p) { },
  },
  {
    id: 'PA_FAN_TRIP',
    group: 'Air & Gas',
    name: 'Primary air fan trip',
    severity: 2,
    cause: 'Motor protection or a PA damper fault.',
    symptoms: [
      'Mill differential pressure dropping, coal transport lost',
      'All mills tripping on low PA flow',
      'Firing rate collapsing, load falling',
    ],
    actions: [
      'Mills will trip — confirm MFT if flame is lost',
      'Restart the PA fan and purge before re-lighting',
    ],
    apply(p) { p.boilers[p.faultBoiler].paRunning = false; },
    active(p) { p.boilers[p.faultBoiler].paRunning = false; },
    clear(p) { },
  },
  {
    id: 'ESP_FAIL',
    group: 'Air & Gas',
    name: 'Electrostatic precipitator failure',
    severity: 2,
    cause: 'Field flash-over, rapping fault or a transformer trip.',
    symptoms: [
      'ESP field kV/ mA collapsing, spark rate high',
      'Stack opacity rising sharply, dust loading high',
    ],
    actions: [
      'Energise the standby fields, check the rapping programme',
      'Reduce load, notify environmental monitoring',
      'Check the FGD is still capturing dust',
    ],
    apply(p) { p.boilers[p.faultBoiler].espEnergised = false; },
    active(p) { p.boilers[p.faultBoiler].espEnergised = false; },
    clear(p) { },
  },
  {
    id: 'FGD_TRIP',
    group: 'Air & Gas',
    name: 'FGD absorber trip',
    severity: 2,
    cause: 'Slurry pump failure, pH control loss or a booster fan trip.',
    symptoms: [
      'SO2 at the stack rising above the limit',
      'Absorber level rising, slurry density falling',
    ],
    actions: [
      'Restart a slurry pump, check limestone dosing',
      'Reduce load if SO2 cannot be held below the permit limit',
    ],
    apply(p) { p.bop.fgdRunning = false; },
    active(p) { p.bop.fgdRunning = false; },
    clear(p) { },
  },

  /* ------------------------------ FEEDWATER ------------------------------ */
  {
    id: 'BFP_TRIP',
    group: 'Feedwater',
    name: 'Boiler feed pump trip',
    severity: 3,
    cause: 'Motor protection, cavitation or a lube-oil failure.',
    symptoms: [
      'Feedwater flow to zero, BFP discharge pressure collapsing',
      'Drum level falling fast, drum pressure falling',
      'Standby pump auto-start (if available)',
    ],
    actions: [
      'Confirm the standby BFP has started',
      'Reduce load to match the available feedwater',
      'Trip the unit if drum level cannot be maintained',
    ],
    apply(p) { p.bop.bfp[0].running = false; },
    active(p) { p.bop.bfp[0].running = false; },
    clear(p) { },
  },
  {
    id: 'BFP_CAVITATION',
    group: 'Feedwater',
    name: 'BFP cavitation / low NPSH',
    severity: 2,
    cause: 'Low deaerator level or pressure, high feedwater temperature.',
    symptoms: [
      'BFP suction pressure low, discharge pressure swinging',
      'Pump vibration high, characteristic gravel noise',
    ],
    actions: [
      'Raise the deaerator level and pressure',
      'Reduce the pump speed, start the standby pump',
    ],
    apply(p) { p.bop.bfp[0].cavitation = true; },
    active(p, f, dt) {
      p.bop.deaeratorLevel -= 1.2 * dt;
      p.bop.bfp[0].cavitation = true;
    },
    clear(p) { for (const q of p.bop.bfp) q.cavitation = false; },
  },
  {
    id: 'COND_TUBE_LEAK',
    group: 'Feedwater',
    name: 'Condenser tube leak',
    severity: 2,
    cause: 'Tube erosion or a failed tube-to-tubesheet joint.',
    symptoms: [
      'Condensate conductivity and sodium rising',
      'Hotwell level rising, make-up water demand falling',
      'Cation conductivity alarm, chemistry excursion in the cycle',
    ],
    actions: [
      'Identify the leak by isolating half the condenser',
      'Put the condensate polisher in service, increase blowdown',
      'Control the leak with sawdust / leak-seal if permitted',
    ],
    apply(p) { p.tg.condTubeLeak = 0.4; },
    active(p, f, dt) {
      p.tg.condConductivity = Math.min(9.9, p.tg.condConductivity + 0.00035 * f.magnitude * dt);
      p.tg.hotwellLevel += 0.35 * dt * f.magnitude;
    },
    clear(p) { p.tg.condTubeLeak = 0; p.tg.condConductivity = 0.08; },
  },
  {
    id: 'ECON_LEAK',
    group: 'Feedwater',
    name: 'Economiser tube leak',
    severity: 2,
    cause: 'External corrosion / fly-ash erosion of the economiser.',
    symptoms: [
      'Feedwater flow > steam flow, stack temperature falling',
      'Water in the ash hoppers, gas-side differential rising',
    ],
    actions: [
      'Monitor the water balance, plan a shutdown',
      'Reduce oxygen ingress to limit corrosion',
    ],
    apply(p) { p.boilers[p.faultBoiler].tubeLeak = 0.10; },
    active(p, f, dt) {
      const b = p.boilers[p.faultBoiler];
      b.tubeLeak = clamp(b.tubeLeak + 0.002 * dt / 60, 0, 0.8);
    },
    clear(p) { p.boilers[p.faultBoiler].tubeLeak = 0; },
  },

  /* ------------------------------ TURBINE ------------------------------ */
  {
    id: 'TURB_VIBRATION',
    group: 'Turbine',
    name: 'Turbine high vibration (blade deposit / unbalance)',
    severity: 3,
    cause: 'Blade deposits, a thrown blade or a rotor thermal bend.',
    symptoms: [
      'Bearing vibration rising, shaft eccentricity rising',
      'Axial shift and differential expansion moving',
      'Bearing metal temperature increasing',
    ],
    actions: [
      'Reduce load and observe the vibration trend',
      'Check the lube-oil temperature and the seal-steam supply',
      'If vibration continues to rise, trip the machine and run down on turning gear',
    ],
    apply(p) { p.tg.bladeFault = 0.35; },
    active(p, f, dt) {
      p.tg.bladeFault = clamp((p.tg.bladeFault || 0) + 0.00045 * f.magnitude * dt, 0, 1.4);
    },
    clear(p) { p.tg.bladeFault = 0; },
  },
  {
    id: 'LUBE_OIL_LEAK',
    group: 'Turbine',
    name: 'Lube oil system leak / pump failure',
    severity: 3,
    cause: 'Pipe joint failure or the standby pump failing to start.',
    symptoms: [
      'Lube-oil pressure falling, tank level falling',
      'Bearing metal temperatures rising',
      'Control-oil pressure falling, governor unstable',
    ],
    actions: [
      'Start the emergency DC oil pump immediately',
      'Trip the turbine if pressure cannot be restored above the trip value',
      'Never allow the rotor to stop without turning-gear oil',
    ],
    apply(p) { p.tg.oilLeak = 0.5; },
    active(p, f, dt) {
      p.tg.oilLeak = clamp((p.tg.oilLeak || 0) + 0.0008 * f.magnitude * dt, 0, 1);
    },
    clear(p) { p.tg.oilLeak = 0; },
  },
  {
    id: 'VACUUM_LOSS',
    group: 'Turbine',
    name: 'Condenser vacuum deterioration (air ingress)',
    severity: 3,
    cause: 'Failed expansion joint, a leaking valve stem or a vacuum-pump fault.',
    symptoms: [
      'Condenser pressure rising, exhaust temperature rising',
      'Vacuum-pump load rising, air/steam mixture temperature high',
      'Load falling for the same steam flow — heat rate worsening',
    ],
    actions: [
      'Start the standby vacuum pump',
      'Check the gland-seal steam pressure and the vacuum breaker water seal',
      'Reduce load; trip the turbine at the vacuum trip point',
    ],
    apply(p) { p.tg.airIngress = 2.6; },
    active(p, f, dt) {
      p.tg.airIngress = clamp(p.tg.airIngress + 0.0012 * f.magnitude * dt, 0.6, 9);
    },
    clear(p) { p.tg.airIngress = 0.6; },
  },
  {
    id: 'CW_PUMP_TRIP',
    group: 'Turbine',
    name: 'Circulating-water pump trip',
    severity: 3,
    cause: 'Motor protection, trash-rack blockage or a low basin level.',
    symptoms: [
      'CW flow halved, CW outlet temperature rising',
      'Condenser vacuum deteriorating, exhaust temperature rising',
    ],
    actions: [
      'Start the standby CW pump',
      'Reduce the turbine load to keep the vacuum above the trip point',
      'Check the basin level and the trash racks',
    ],
    apply(p) { p.tg.cwPump2 = false; },
    active(p) { p.tg.cwPump2 = false; },
    clear(p) { },
  },
  {
    id: 'GLAND_SEAL_LOSS',
    group: 'Turbine',
    name: 'Gland-seal steam failure',
    severity: 2,
    cause: 'Seal-steam regulator fault or an auxiliary steam supply loss.',
    symptoms: [
      'Air leaking into the LP cylinders, vacuum deteriorating',
      'Steam blowing from the shaft ends',
    ],
    actions: [
      'Restore the seal-steam supply, switch to the auxiliary source',
      'Monitor the vacuum closely',
    ],
    apply(p) { p.tg.sealSteam = 0; },
    active(p) { p.tg.sealSteam = 0; },
    clear(p) { p.tg.sealSteam = 1; },
  },
  {
    id: 'OVERSPEED_TEST_FAIL',
    group: 'Turbine',
    name: 'Governor failure / turbine overspeed',
    severity: 3,
    cause: 'Governor valve sticking open, load rejection or a failed overspeed test.',
    symptoms: [
      'Speed rising above 3 090 rpm, governor valve not responding',
      'Frequency rising when islanded, violent vibration',
    ],
    actions: [
      'Confirm the mechanical and electrical overspeed trips have operated',
      'Close the main steam stop valves manually',
      'Do not re-synchronise until the governor is proven',
    ],
    apply(p) { p.tg.governorFault = true; },
    active(p, f, dt) {
      if (p.tg.mode === 'speed' || p.tg.mode === 'manual') p.tg.gvManual = 100;
      else p.tg.gvManual = 100;
      p.tg.governorFault = true;
    },
    clear(p) { p.tg.governorFault = false; p.tg.gvManual = 0; },
  },
  {
    id: 'THRUST_BEARING',
    group: 'Turbine',
    name: 'Thrust-bearing wear / high axial shift',
    severity: 3,
    cause: 'Loss of a blade stage, water induction or a failed thrust face.',
    symptoms: [
      'Axial shift rising towards the trip value',
      'Thrust-bearing metal temperature high',
      'Differential expansion abnormal',
    ],
    actions: [
      'Reduce load immediately and monitor the axial shift',
      'Trip if the axial shift approaches the trip value',
    ],
    apply(p) { p.tg.thrustFault = 0.4; },
    active(p, f, dt) {
      p.tg.thrustFault = clamp((p.tg.thrustFault || 0) + 0.0006 * f.magnitude * dt, 0, 1.1);
    },
    clear(p) { p.tg.thrustFault = 0; },
  },
  {
    id: 'BEARING_WEAR',
    group: 'Turbine',
    name: 'Journal-bearing metal high temperature',
    severity: 2,
    cause: 'Oil starvation, a wiped bearing or a misaligned coupling.',
    symptoms: [
      'Bearing metal temperature rising above 90 C',
      'Bearing drain oil temperature high, vibration rising',
    ],
    actions: [
      'Check the lube-oil pressure, temperature and flow',
      'Reduce load, if the trend continues trip the machine',
    ],
    apply(p) { p.tg.bearingFault = 0.4; },
    active(p, f, dt) {
      p.tg.bearingFault = clamp((p.tg.bearingFault || 0) + 0.0005 * f.magnitude * dt, 0, 1.2);
    },
    clear(p) { p.tg.bearingFault = 0; },
  },

  /* ------------------------------ GENERATOR ------------------------------ */
  {
    id: 'STATOR_OVERHEAT',
    group: 'Generator',
    name: 'Generator stator winding over-temperature',
    severity: 3,
    cause: 'Loss of hydrogen cooling, an overload or a blocked cooler.',
    symptoms: [
      'Stator winding temperature rising above 105 C',
      'Hydrogen pressure / purity falling',
      'Stator current above the rating for the MVAr being run',
    ],
    actions: [
      'Reduce MVAr / MW, raise the power factor',
      'Check the hydrogen pressure, purity and the cooler water flow',
      'Trip if the temperature approaches 120 C',
    ],
    apply(p) { p.tg.coolerFault = 0.5; },
    active(p, f, dt) {
      p.tg.coolerFault = clamp((p.tg.coolerFault || 0) + 0.0006 * f.magnitude * dt, 0, 1.2);
      p.tg.h2Purity = Math.max(78, p.tg.h2Purity - 0.0012 * dt * f.magnitude);
    },
    clear(p) { p.tg.coolerFault = 0; p.tg.h2Purity = 98.4; },
  },
  {
    id: 'H2_LEAK',
    group: 'Generator',
    name: 'Hydrogen leak',
    severity: 3,
    cause: 'Seal-oil system failure or a failed hydrogen cooler joint.',
    symptoms: [
      'Hydrogen pressure falling, make-up consumption rising',
      'Hydrogen purity falling, detector alarms in the enclosure',
    ],
    actions: [
      'Restore the seal-oil pressure differential',
      'Reduce load, prepare to unload and trip if the pressure falls below 0.30 MPa',
      'Ventilate the enclosure, no naked flames',
    ],
    apply(p) { p.tg.h2Leak = 0.5; },
    active(p, f, dt) {
      p.tg.h2Leak = clamp((p.tg.h2Leak || 0) + 0.0006 * dt, 0, 1);
      p.tg.h2Pressure = Math.max(0.06, p.tg.h2Pressure - 0.0022 * dt * f.magnitude);
    },
    clear(p) { p.tg.h2Leak = 0; },
  },
  {
    id: 'GRID_FAULT',
    group: 'Generator',
    name: 'Grid disturbance / load rejection',
    severity: 3,
    cause: 'Network fault, line trip or a sudden loss of the receiving end.',
    symptoms: [
      'Frequency excursion, voltage dip, MW swinging',
      'Turbine speed rising if the unit is islanded, governor valves slamming',
      'Possible over-voltage and pole slip',
    ],
    actions: [
      'Confirm the governor has responded to hold 3 000 rpm',
      'Check the turbine has not tripped on overspeed',
      'Be ready for house-load operation or a full shutdown',
    ],
    apply(p) { p.grid.faultTimer = 12; p.grid.disturbance = 0.9; },
    active(p, f, dt) {
      p.grid.disturbance = clamp((p.grid.disturbance || 0), 0, 1);
      p.grid.faultTimer -= dt;
      if (p.grid.faultTimer <= 0) p.grid.disturbance = 0;
    },
    clear(p) { p.grid.disturbance = 0; p.grid.faultTimer = 0; },
  },
  {
    id: 'AVR_FAULT',
    group: 'Generator',
    name: 'AVR / excitation fault',
    severity: 2,
    cause: 'AVR channel failure or a field-winding earth fault.',
    symptoms: [
      'Terminal voltage and MVAr swinging, possible pole slip',
      'Field current abnormal, rotor temperature rising',
    ],
    actions: [
      'Transfer to the standby AVR channel / manual excitation',
      'Reduce MVAr to keep the stator current within limits',
    ],
    apply(p) { p.tg.avrFault = true; },
    active(p) { p.tg.avrFault = true; },
    clear(p) { p.tg.avrFault = false; },
  },

  /* ------------------------------ BOP / COAL ------------------------------ */
  {
    id: 'COAL_FEEDER_TRIP',
    group: 'Coal & Ash',
    name: 'Coal feeder trip / bunker emptying',
    severity: 2,
    cause: 'Feeder motor trip, a bunker arch (hang-up) or an empty bunker.',
    symptoms: [
      'Coal flow from the feeder to zero, mill current falling',
      'Firing rate and load falling, O2 rising',
    ],
    actions: [
      'Restart the feeder, free the hang-up with the bunker vibrators/air cannons',
      'Start a standby mill to hold load',
    ],
    apply(p) { p.boilers[p.faultBoiler].mills[1].running = false; },
    active(p) { p.boilers[p.faultBoiler].mills[1].running = false; },
    clear(p) { },
  },
  {
    id: 'COAL_WET',
    group: 'Coal & Ash',
    name: 'Wet coal / poor coal quality',
    severity: 1,
    cause: 'Rain-wetted stockpile or a change of blend.',
    symptoms: [
      'Mill outlet temperature falling, mill differential pressure rising',
      'Furnace temperature falling, flame instability, CO rising',
      'Boiler efficiency falling, stack temperature rising',
    ],
    actions: [
      'Raise the hot-primary-air temperature, reduce the feeder slightly',
      'Blend with a drier coal, check the stockpile drainage',
    ],
    apply(p) { p.coalWet = 0.5; },
    active(p, f, dt) {
      p.coalWet = clamp((p.coalWet || 0) + 0.0004 * dt, 0, 1);
      for (const b of p.boilers) b.slagging = clamp(b.slagging + 0.00001 * dt, 0, 0.35);
    },
    clear(p) { p.coalWet = 0; },
  },
  {
    id: 'ASH_BLOCKAGE',
    group: 'Coal & Ash',
    name: 'Ash-handling blockage',
    severity: 2,
    cause: 'Hopper bridging, a failed conveyor or a wet-ash build-up.',
    symptoms: [
      'Hopper level rising, ESP hopper high-level alarms',
      'Opacity rising if the hoppers fill into the gas stream',
    ],
    actions: [
      'Start the standby ash conveyor, use the hopper vibrators',
      'Reduce load if the hoppers cannot be cleared',
    ],
    apply(p) { p.bop.ashBlockage = true; },
    active(p, f, dt) { p.bop.ashBlockage = true; },
    clear(p) { p.bop.ashBlockage = false; },
  },
  {
    id: 'INSTRUMENT_AIR_LOSS',
    group: 'Coal & Ash',
    name: 'Instrument air supply loss',
    severity: 3,
    cause: 'Compressor trip, dryer failure or a header rupture.',
    symptoms: [
      'Instrument air pressure falling, control valves going to their fail position',
      'Dampers drifting, feedwater control lost',
    ],
    actions: [
      'Start the standby compressor, isolate non-essential users',
      'Go to manual control and be ready to trip if control is lost',
    ],
    apply(p) { p.bop.iaLoss = true; },
    active(p, f, dt) {
      p.bop.iaLoss = true;
      p.bop.instrumentAir = Math.max(0.16, p.bop.instrumentAir - 0.010 * dt);
    },
    clear(p) { p.bop.iaLoss = false; p.bop.instrumentAir = 0.72; },
  },
  {
    id: 'CONVEYOR_TRIP',
    group: 'Coal & Ash',
    name: 'Coal conveyor trip',
    severity: 2,
    cause: 'Belt misalignment, a rip or a motor protection trip.',
    symptoms: [
      'Bunker levels falling, no coal to the bunker bay',
      'Conveyor load to zero, stockpile reclaim stopped',
    ],
    actions: [
      'Restart the conveyor, check the trip switches along the gallery',
      'Plan the shutdown if the bunkers reach 20 %',
    ],
    apply(p) { p.bop.conveyorRunning = false; },
    active(p) { p.bop.conveyorRunning = false; },
    clear(p) { },
  },
];

const FAULT_MAP = new Map(FAULTS.map(f => [f.id, f]));

module.exports = { FAULTS, FAULT_MAP, clamp };
