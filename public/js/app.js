/**
 * app.js — HMI wiring: WebSocket feed, 3D scene binding, mimic panels,
 * alarm/event/fault displays and the trends.
 */
import { PlantScene } from '/js/scene.js';
import { Tutorial } from '/js/tutorial.js';
import { PlantAudio } from '/js/audio.js';
import { Autopilot } from '/js/autopilot.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmt = (v, n = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(n);

let scene = null;
let state = null;
let ws = null;
let boilerTab = 0;
let history = [];
let faultCatalog = [];
let audio = null;
let tutorial = null;
let autopilot = null;
let tutOffered = false;

/* ============================ networking ============================ */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { $('#conn').textContent = 'live'; $('#conn').style.color = '#37d67a'; };
  ws.onclose = () => {
    $('#conn').textContent = 'offline — retrying'; $('#conn').style.color = '#ff5b5b';
    setTimeout(connect, 2500);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') { state = msg.data; render(); }
    else if (msg.type === 'welcome') { state = msg.data; if (msg.data.faultCatalog) faultCatalog = msg.data.faultCatalog; render(); }
  };
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function cmd(c, v) { send({ type: 'command', cmd: c, value: v }); }

/* ============================== rendering =========================== */
function row(k, v, cls) {
  return `<tr><td class="k">${k}</td><td class="v ${cls || ''}">${v}</td></tr>`;
}
function lamp(on, fault) { return `<span class="badge ${fault ? 'fault' : (on ? 'on' : 'off')}"></span>`; }
function cls(v, hi, lo) { return v > hi ? 'bad' : v < lo ? 'warn' : ''; }

function render() {
  if (!state) return;
  const s = state, p = s.plant, b0 = s.boilers[0], b1 = s.boilers[1], t = s.turbine, g = s.generator, cd = s.condenser, bop = s.bop;

  /* ---- header ---- */
  $('#hMW').textContent = fmt(p.grossMW, 1);
  $('#hNET').textContent = fmt(p.netMW, 1);
  $('#hRPM').textContent = fmt(t.speed, 0);
  $('#hP').textContent = fmt(b0.drumPressure, 2);
  $('#hT').textContent = fmt(b0.msTemp, 0);
  $('#hT').className = cls(b0.msTemp, 552, 520);
  $('#hTRH').textContent = fmt(b0.rhOutTemp, 0);
  $('#hVAC').textContent = fmt(cd.vacuum, 1);
  $('#hVAC').className = cls(cd.vacuum, 20, 99);
  $('#hHR').textContent = p.grossMW > 20 ? fmt(p.heatRate, 0) : '—';
  const hh = Math.floor(s.meta.simTime / 3600), mm = Math.floor((s.meta.simTime % 3600) / 60);
  $('#clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  /* ---- unit status ---- */
  $('#mode').textContent = s.meta.mode.replace(/_/g, ' ');
  $('#phase').textContent = s.meta.phaseNote || '';
  $('#phase2').textContent = s.meta.phaseNote || '';

  /* ---- boiler strip ---- */
  $('#oP').textContent = `${fmt(b0.drumPressure, 2)} / ${fmt(b1.drumPressure, 2)}`;
  $('#oL').textContent = `${fmt(b0.drumLevelTotal, 0)} / ${fmt(b1.drumLevelTotal, 0)}`;
  $('#oC').textContent = `${fmt(b0.totalCoal, 0)} / ${fmt(b1.totalCoal, 0)}`;
  $('#oM').textContent = `${b0.millsRunning} / ${b1.millsRunning}`;
  $('#oO2').textContent = `${fmt(b0.o2, 1)} / ${fmt(b1.o2, 1)}`;
  $('#oEFF').textContent = `${fmt(b0.efficiency, 1)} / ${fmt(b1.efficiency, 1)}`;

  /* ---- protection banners ---- */
  const mft = s.protection.mft, tt = s.protection.turbineTrip;
  $('#bMft').classList.toggle('show', !!mft.latched);
  if (mft.latched) $('#mftWhy').textContent = mft.cause + (mft.reasons && mft.reasons.length ? ' — ' + mft.reasons.join('; ') : '');
  $('#bTrip').classList.toggle('show', !!tt.latched && !mft.latched);
  if (tt.latched) $('#tripWhy').textContent = tt.cause;

  /* ---- alarms ---- */
  const al = s.alarms || [];
  $('#alCount').textContent = al.length ? `(${al.length})` : '0';
  $('#alarms').innerHTML = al.length ? al.slice(0, 60).map(a => `
      <div class="al ${a.prio} ${a.ack ? 'ack' : ''}" data-key="${a.key}">
        <span class="t">${a.prio[0]}${a.prio === 'CRITICAL' ? '!' : ''}</span>
        <span style="flex:1">${a.msg}</span>
        <span class="t">${Math.floor(a.t / 60)}m</span>
      </div>`).join('') : '<div class="hint">No active alarms.</div>';

  /* ---- events ---- */
  if (s.events) {
    $('#events').innerHTML = s.events.slice(0, 120).map(e =>
      `<div class="ev ${e.cat}"><span class="t">${Math.floor(e.t / 60)}m</span><span class="c">${e.cat}</span><span style="flex:1">${e.msg}</span></div>`
    ).join('');
  }

  /* ---- procedure ---- */
  $('#procreq').innerHTML = (s.meta.procedure || []).map(x => `<li>${x}</li>`).join('');

  /* ---- plant table ---- */
  $('#t-plant').innerHTML = [
    row('Mode', s.meta.mode.replace(/_/g, ' ')),
    row('Gross output', `${fmt(p.grossMW, 1)} MW`),
    row('Net output', `${fmt(p.netMW, 1)} MW`),
    row('Station auxiliaries', `${fmt(p.auxMW, 1)} MW`),
    row('Load factor', `${fmt(p.loadFactor, 1)} %`),
    row('Gross heat rate', p.heatRate ? `${fmt(p.heatRate, 0)} kJ/kWh` : '—'),
    row('Net heat rate', p.netHeatRate ? `${fmt(p.netHeatRate, 0)} kJ/kWh` : '—'),
    row('Cycle efficiency', p.efficiency ? `${fmt(p.efficiency, 1)} %` : '—'),
    row('Frequency', `${fmt(p.frequency, 3)} Hz`, cls(p.frequency, 50.5, 49.5)),
    row('Total coal', `${fmt(p.totalCoal, 0)} t/h`),
    row('Fuel heat input', `${fmt(p.fuelHeat, 0)} MW`),
    row('Coal burned', `${fmt(p.coalBurned, 0)} t`),
    row('Energy sent out', `${fmt(p.energySentOut, 0)} MWh`),
    row('Running hours', `${fmt(p.runHours, 1)} h`),
    row('Unit starts', `${s.meta.starts}`),
    row('Ambient / wet bulb', `${fmt(p.ambient, 1)} / ${fmt(p.wetBulb, 1)} °C`),
  ].join('');

  /* ---- boiler tables ---- */
  const b = boilerTab === 0 ? b0 : b1;
  $('#t-boiler').innerHTML = [
    row('In service', b.inService ? 'YES' : 'OUT', b.inService ? 'ok' : 'warn'),
    row('Drum pressure', `${fmt(b.drumPressure, 2)} MPa`, cls(b.drumPressure, 19.0, 0)),
    row('Drum level', `${fmt(b.drumLevelTotal, 0)} mm`, cls(Math.abs(b.drumLevelTotal), 125, -99)),
    row('Swell / shrink', `${fmt(b.levelSwell, 0)} mm`),
    row('Metal top / bottom', `${fmt(b.drumMetalTop, 0)} / ${fmt(b.drumMetalBottom, 0)} °C`),
    row('Metal differential', `${fmt(b.drumMetalDiff, 1)} K`, cls(b.drumMetalDiff, 55, -99)),
    row('Metal rate', `${fmt(b.metalRate * 3600, 0)} K/h`),
    row('Saturation temp', `${fmt(b.econOutletTemp > 0 ? b.tFegt * 0 + satApprox(b.drumPressure) : 0, 0)} °C`),
    row('Feedwater flow', `${fmt(b.fwFlow, 0)} t/h`),
    row('Feedwater temp', `${fmt(b.fwTemp, 1)} °C`),
    row('Economiser outlet', `${fmt(b.econOutletTemp, 1)} °C`),
    row('Main steam flow', `${fmt(b.msOutlet, 0)} t/h`),
    row('Main steam pressure', `${fmt(b.msPressure, 2)} MPa`),
    row('Main steam temp', `${fmt(b.msTemp, 1)} °C`, cls(b.msTemp, 548, 528)),
    row('Spray 1 / 2', `${fmt(b.spray1, 1)} / ${fmt(b.spray2, 1)} t/h`),
    row('Reheat flow', `${fmt(b.rhFlow, 0)} t/h`),
    row('Reheat in / out', `${fmt(b.rhInTemp, 0)} / ${fmt(b.rhOutTemp, 0)} °C`, cls(b.rhOutTemp, 548, 520)),
    row('RH spray', `${fmt(b.rhSpray, 1)} t/h`),
    row('Start-up vent', `${fmt(b.ventFlow, 0)} t/h`),
    row('Blowdown', `${fmt(b.blowdown, 1)} t/h`),
    row('Heat to steam', `${fmt(b.qAbsorbed, 0)} MW`),
    row('Boiler efficiency', `${fmt(b.efficiency, 1)} %`),
    row('Fuel heat', `${fmt(b.qFuel, 0)} MW`),
    row('Coal', `${fmt(b.totalCoal, 1)} t/h`),
    row('Support oil', `${fmt(b.oilFlow, 1)} t/h`),
    row('Slagging', `${fmt(b.slagging, 0)} %`),
    row('Tube leak', b.tubeLeak > 0.02 ? `${fmt(b.tubeLeak * 100, 0)} %` : 'none', b.tubeLeak > 0.02 ? 'bad' : ''),
    row('Flame scanners', `${b.flameScanners} / 16`, b.flameScanners > 0 ? 'ok' : ''),
  ].join('');

  $('#millLamps').innerHTML = b.mills.map(m => lamp(m.running, m.fire)).join(' ');
  $('#t-mills').innerHTML = b.mills.map((m, i) => row(
    `Mill ${i + 1}`,
    `${m.running ? 'RUN' : 'stop'} · ${fmt(m.coalFlow, 1)} t/h · ${fmt(m.outletTemp, 0)}°C · ${fmt(m.current, 0)} A${m.fire ? ' · FIRE' : ''}${m.blocked ? ' · BLOCKED' : ''}`,
    m.fire ? 'bad' : (m.blocked ? 'warn' : (m.running ? 'ok' : ''))
  )).join('');

  $('#t-gas').innerHTML = [
    row('FD fan', `${b.fdRunning ? 'RUN' : 'stop'} @ ${fmt(b.fdSpeed, 0)}% · ${fmt(b.fdCurrent, 0)} A`, b.fdRunning ? 'ok' : 'bad'),
    row('ID fan', `${b.idRunning ? 'RUN' : 'stop'} @ ${fmt(b.idSpeed, 0)}% · ${fmt(b.idCurrent, 0)} A`, b.idRunning ? 'ok' : 'bad'),
    row('PA fan', `${b.paRunning ? 'RUN' : 'stop'} @ ${fmt(b.paSpeed, 0)}%`, b.paRunning ? 'ok' : 'warn'),
    row('Total air', `${fmt(b.totalAir, 0)} t/h`),
    row('Flue gas', `${fmt(b.mGas, 0)} t/h`),
    row('Excess air', `${fmt(b.excessAir, 1)} %`),
    row('O₂ (dry)', `${fmt(b.o2, 2)} %`, cls(6, 99, b.qFuel > 20 ? 1.6 : 0)),
    row('CO', `${fmt(b.co, 0)} mg/Nm³`, cls(b.co, 250, -1)),
    row('Furnace draft', `${fmt(b.draft, 0)} Pa`, cls(Math.abs(b.draft), 900, -99)),
    row('Flame temperature', `${fmt(b.furnaceTemp, 0)} °C`),
    row('Furnace exit gas', `${fmt(b.tFegt, 0)} °C`, cls(b.tFegt, 1250, -99)),
    row('Adiabatic flame', `${fmt(b.tAdiabatic, 0)} °C`),
    row('Stack temp', `${fmt(b.tStack, 0)} °C`, cls(b.tStack, 200, -99)),
    row('APH air out', `${fmt(b.aphAirOut, 0)} °C`),
    row('RH gas damper', `${fmt(b.rhGasDamper, 0)} %`),
    row('Soot blowing', b.sootblowing ? 'IN PROGRESS' : 'off'),
    row('ESP', b.espEnergised ? `energised (${b.espFields.filter(Boolean).length}/4)` : 'OFF', b.espEnergised ? 'ok' : 'bad'),
  ].join('');

  $('#t-emis').innerHTML = [
    row('SO₂', `${fmt(s.emissions.so2, 0)} mg/Nm³`, cls(s.emissions.so2, 400, -1)),
    row('NOₓ', `${fmt(s.emissions.nox, 0)} mg/Nm³`, cls(s.emissions.nox, 450, -1)),
    row('Dust', `${fmt(s.emissions.dust, 0)} mg/Nm³`, cls(s.emissions.dust, 50, -1)),
    row('CO', `${fmt(s.emissions.co, 0)} mg/Nm³`),
    row('O₂', `${fmt(s.emissions.o2, 2)} %`),
    row('Opacity', `${fmt(s.emissions.opacity, 0)} %`, cls(s.emissions.opacity, 25, -1)),
  ].join('');

  /* ---- turbine ---- */
  $('#t-turb').innerHTML = [
    row('Speed', `${fmt(t.speed, 0)} rpm`, cls(t.speed, 3150, -99)),
    row('Acceleration', `${fmt(t.acceleration * 60, 1)} rpm/s`),
    row('Governor valve', `${fmt(t.governorValve, 1)} %`),
    row('Stop valve', `${fmt(t.stopValve, 0)} %`, t.stopValve > 90 ? 'ok' : ''),
    row('Intercept valve', `${fmt(t.interceptValve, 0)} %`),
    row('Breaker', t.breakerClosed ? 'CLOSED' : 'OPEN', t.breakerClosed ? 'ok' : ''),
    row('Turning gear', t.turningGear ? 'ENGAGED' : 'off'),
    row('Control mode', t.mode),
    row('Load setpoint', `${fmt(t.loadSetpoint, 0)} MW`),
    row('Main steam', `${fmt(t.msFlow, 0)} t/h @ ${fmt(t.msPressure, 2)} MPa / ${fmt(t.msTemp, 0)}°C`),
    row('HP exhaust', `${fmt(t.hpExhPressure, 2)} MPa / ${fmt(t.hpExhTemp, 0)} °C`),
    row('Cold reheat', `${fmt(t.crhPressure, 2)} MPa / ${fmt(t.crhTemp, 0)} °C`),
    row('Hot reheat', `${fmt(t.hrhPressure, 2)} MPa / ${fmt(t.hrhTemp, 0)} °C`),
    row('IP exhaust', `${fmt(t.ipExhPressure, 3)} MPa / ${fmt(t.ipExhTemp, 0)} °C`),
    row('LP exhaust', `${fmt(t.lpExhPressure * 1000, 1)} kPa / ${fmt(t.exhaustTemp, 0)} °C`),
    row('LP moisture', `${fmt(t.moisture, 1)} %`, cls(t.moisture, 12, -99)),
    row('Condenser flow', `${fmt(t.condFlow, 0)} t/h`),
    row('Shaft power', `${fmt(t.shaftMW, 1)} MW`),
  ].join('');

  $('#t-gen').innerHTML = [
    row('Active power', `${fmt(g.mw, 1)} MW`),
    row('Reactive power', `${fmt(g.mvar, 1)} MVAr`),
    row('Apparent power', `${fmt(g.mva, 1)} MVA`),
    row('Power factor', `${fmt(g.pf, 3)}`),
    row('Terminal voltage', `${fmt(g.kV, 1)} kV`),
    row('Stator current', `${fmt(g.amps, 0)} A`, cls(g.amps, 19200, -1)),
    row('Field volts / amps', `${fmt(g.fieldVolts, 0)} V / ${fmt(g.fieldAmps, 0)} A`),
    row('Stator temp', `${fmt(g.statorTemp, 0)} °C`, cls(g.statorTemp, 105, -99)),
    row('Rotor temp', `${fmt(g.rotorTemp, 0)} °C`, cls(g.rotorTemp, 105, -99)),
    row('H₂ pressure', `${fmt(g.h2Pressure, 3)} MPa`, cls(0.4 - g.h2Pressure, 0.001, -9)),
    row('H₂ purity', `${fmt(g.h2Purity, 1)} %`, cls(96 - g.h2Purity, 0.1, -9)),
    row('AVR', g.avrAuto ? 'AUTO' : 'manual'),
  ].join('');

  $('#t-cond').innerHTML = [
    row('Vacuum', `${fmt(cd.vacuum, 2)} kPa(a)`, cls(cd.vacuum, 20, -99)),
    row('LP exhaust temp', `${fmt(cd.exhaustTemp, 1)} °C`, cls(cd.exhaustTemp, 80, -99)),
    row('Hotwell level', `${fmt(cd.hotwellLevel, 0)} mm`),
    row('Hotwell temp', `${fmt(cd.hotwellTemp, 1)} °C`),
    row('CW in / out', `${fmt(cd.cwInletTemp, 1)} / ${fmt(cd.cwOutletTemp, 1)} °C`),
    row('CW flow', `${fmt(cd.cwFlow, 0)} m³/h`),
    row('CW pumps', `${cd.cwPumps.filter(Boolean).length} / 2 running`),
    row('Vacuum pumps', cd.vacuumPumpRunning ? 'RUNNING' : 'stopped', cd.vacuumPumpRunning ? 'ok' : ''),
    row('Conductivity', `${fmt(cd.conductivity, 3)} µS/cm`, cls(cd.conductivity, 0.3, -99)),
    row('Dissolved O₂', `${fmt(cd.dissolvedOxygen, 1)} ppb`, cls(cd.dissolvedOxygen, 20, -99)),
    row('Air ingress', `${fmt(cd.airIngress, 2)} kg/h`),
    row('Duty', `${fmt(cd.qCond / 1000, 0)} MW`),
    row('Fouling', `${fmt(cd.fouling, 1)} %`),
  ].join('');

  const vibMax = Math.max(...(t.vibrations || [0]));
  $('#t-sup').innerHTML = [
    row('Bearing vibration (max)', `${fmt(vibMax, 1)} mm/s`, cls(vibMax, 8.6, -99)),
    row('Vibrations', (t.vibrations || []).map(v => fmt(v, 1)).join(' · ')),
    row('Bearing metal (max)', `${fmt(Math.max(...(t.bearingMetalTemps || [0])), 0)} °C`, cls(Math.max(...(t.bearingMetalTemps || [0])), 95, -99)),
    row('Axial shift', `${fmt(t.axialShift, 2)} mm`, cls(Math.abs(t.axialShift), 0.6, -99)),
    row('Eccentricity', `${fmt(t.eccentricity, 1)} µm`, cls(t.eccentricity, 30, -99)),
    row('Differential expansion', `${fmt(t.differentialExpansion, 1)} mm`, cls(Math.abs(t.differentialExpansion), 9, -99)),
    row('Casing expansion', `${fmt(t.casingExpansion, 1)} mm`),
    row('HP / IP metal temp', `${fmt(t.metalTempHP, 0)} / ${fmt(t.metalTempIP, 0)} °C`),
    row('Lube oil pressure', `${fmt(t.lubeOilPressure, 2)} MPa`, cls(0.10 - t.lubeOilPressure, 0.001, -9)),
    row('Control oil', `${fmt(t.controlOilPressure, 2)} MPa`),
    row('Jacking oil', `${fmt(t.jackingOilPressure, 2)} MPa`),
    row('Gland steam', `${fmt(t.glandSteamPressure, 1)} kPa`),
  ].join('');

  /* ---- BOP ---- */
  $('#t-fw').innerHTML = [
    row('Feedwater flow', `${fmt(bop.fwFlow, 0)} t/h`),
    row('Feedwater temp', `${fmt(bop.fwTemp, 1)} °C`),
    row('Condensate flow', `${fmt(bop.condensateFlow, 0)} t/h`),
    row('Deaerator pressure', `${fmt(bop.deaeratorPressure, 3)} MPa`),
    row('Deaerator level', `${fmt(bop.deaeratorLevel, 0)} mm`),
    row('Deaerator temp', `${fmt(bop.deaeratorTemp, 0)} °C`),
    row('HP heater levels', bop.hpHeaterLevels.map(v => fmt(v, 0)).join(' / ')),
    row('LP heater levels', bop.lpHeaterLevels.map(v => fmt(v, 0)).join(' / ')),
  ].join('') + bop.bfp.map((p2, i) => row(`BFP ${i + 1}`,
    `${p2.running ? 'RUN' : 'stop'} · ${fmt(p2.flow, 0)} t/h · ${fmt(p2.discharge, 1)} MPa · ${fmt(p2.current, 0)} A${p2.cavitating ? ' · CAVITATING' : ''}`,
    p2.cavitating ? 'bad' : (p2.running ? 'ok' : ''))).join('')
    + bop.cep.map((p2, i) => row(`CEP ${i + 1}`, `${p2.running ? 'RUN' : 'stop'} · ${fmt(p2.flow, 0)} t/h`, p2.running ? 'ok' : '')).join('');

  $('#t-coal').innerHTML = [
    row('Stockpile', `${fmt(bop.stockpile, 0)} t`),
    row('Conveyor', `${bop.conveyorRunning ? 'RUNNING' : 'stopped'} · ${fmt(bop.conveyorLoad, 0)} %`, bop.conveyorRunning ? 'ok' : ''),
    row('Crusher', bop.crusherRunning ? 'RUNNING' : 'stopped', bop.crusherRunning ? 'ok' : ''),
    row('Bunker levels', bop.bunkerLevels.map(v => fmt(v, 0) + '%').join(' / ')),
    row('Ash silo', `${fmt(bop.ashSilo, 0)} %`),
    row('Gypsum silo', `${fmt(bop.gypsumSilo, 0)} %`),
    row('FGD', `${bop.fgdRunning ? 'IN SERVICE' : 'BYPASSED'} · pH ${fmt(bop.fgdPh, 2)}`, bop.fgdRunning ? 'ok' : 'warn'),
    row('DM water tank', `${fmt(bop.dmWaterTank, 0)} %`),
    row('Tower basin', `${fmt(bop.towerBasin, 1)} °C`),
  ].join('');

  $('#t-aux').innerHTML = [
    row('Instrument air', `${fmt(bop.instrumentAir, 2)} MPa`, cls(0.45 - bop.instrumentAir, 0.001, -9)),
    row('Station air', `${fmt(bop.stationAir, 2)} MPa`),
    row('Auxiliary steam', `${fmt(bop.auxSteamPressure, 2)} MPa`),
    row('Service water', `${fmt(bop.serviceWater, 2)} MPa`),
    row('Auxiliary load', `${fmt(p.auxMW, 1)} MW`),
  ].join('');

  if (!$('#auxbtns').dataset.built) {
    const items = [
      ['bfp:0', 'BFP 1'], ['bfp:1', 'BFP 2'], ['cep:0', 'CEP 1'], ['cep:1', 'CEP 2'],
      ['cwp:0', 'CW pump 1'], ['cwp:1', 'CW pump 2'], ['vac:0', 'Vacuum pumps'],
      ['lop:0', 'Lube oil pump'], ['jack:0', 'Jacking oil'], ['tg:0', 'Turning gear'],
      ['fd:0', 'FD fan A'], ['id:0', 'ID fan A'], ['pa:0', 'PA fan A'],
      ['fd:1', 'FD fan B'], ['id:1', 'ID fan B'], ['pa:1', 'PA fan B'],
      ['millA:0', 'Mill A1'], ['millA:1', 'Mill A2'], ['millA:2', 'Mill A3'], ['millA:3', 'Mill A4'],
      ['millB:0', 'Mill B1'], ['millB:1', 'Mill B2'], ['millB:2', 'Mill B3'], ['millB:3', 'Mill B4'],
      ['esp:0', 'ESP A'], ['esp:1', 'ESP B'], ['fgd:0', 'FGD'],
      ['conv:0', 'Conveyors'], ['crush:0', 'Crushers'], ['dm:0', 'DM make-up'],
    ];
    $('#auxbtns').innerHTML = items.map(([k, n]) =>
      `<button class="btn" style="padding:3px 7px;font-size:11px" data-start="${k}">${n}</button>`).join('');
    $('#auxbtns').addEventListener('click', (e) => {
      const k = e.target && e.target.dataset && e.target.dataset.start;
      if (!k) return;
      send({ type: 'command', cmd: 'startAux', value: k });
      setTimeout(() => send({ type: 'command', cmd: 'stopAux', value: k }), 1);
    });
    $('#auxbtns').dataset.built = '1';
  }

  /* ---- faults ---- */
  if (s.faultCatalog) faultCatalog = s.faultCatalog;
  renderFaults(s.activeFaults || []);

  /* ---- charts ---- */
  history = s.meta ? null : history;
  if (scene) scene.bind(s);
  drawCharts(s);

  /* ---- tutorial, sound and autopilot (driven from the live snapshot) ---- */
  if (audio) audio.update(s);
  if (autopilot) autopilot.update(s);
  if (tutorial) {
    tutorial.update(s);
    if (!tutOffered && s.meta) {
      tutOffered = true;
      let seen = '1';
      try { seen = localStorage.getItem('tcsim.tutorialSeen') || ''; } catch { /* ignore */ }
      if (!seen) {
        try { localStorage.setItem('tcsim.tutorialSeen', '1'); } catch { /* ignore */ }
        if (s.meta.mode === 'SHUTDOWN_COLD') tutorial.start(0);
      }
    }
  }
}

function satApprox(P) {
  // quick approximation for display only
  if (P < 0.02) return 60;
  const t = 100 * Math.pow(Math.max(0.01, P), 0.2367);
  return Math.min(365, t);
}

function renderFaults(active) {
  const filter = ($('#fsearch').value || '').toLowerCase();
  const byId = new Map(active.map(a => [a.id, a]));
  const groups = {};
  for (const f of faultCatalog) {
    if (filter && !(f.name.toLowerCase().includes(filter) || f.id.toLowerCase().includes(filter)
      || f.group.toLowerCase().includes(filter))) continue;
    (groups[f.group] = groups[f.group] || []).push(f);
  }
  let html = '';
  for (const g of Object.keys(groups)) {
    html += `<div class="fgroup"><div class="h">${g}</div>`;
    for (const f of groups[g]) {
      const on = byId.has(f.id);
      html += `<div class="fitem">
        <span class="sev ${f.severity}">${f.severity}</span>
        <span class="nm">${f.name}</span>
        <button class="btn ${on ? 'danger' : ''}" style="padding:2px 7px;font-size:10.5px"
          data-fault="${f.id}" data-on="${on ? 1 : 0}">${on ? 'clear' : 'inject'}</button>
      </div>`;
      if (on) {
        html += `<div class="fdesc"><b>${f.cause}</b><br>
          <i>Symptoms:</i><ul class="flist">${f.symptoms.map(x => `<li>${x}</li>`).join('')}</ul>
          <i>Operator actions:</i><ul class="flist">${f.actions.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
      }
    }
    html += '</div>';
  }
  $('#faults').innerHTML = html || '<div class="hint">No faults match.</div>';
}

/* ============================== charts ============================== */
function drawCharts(s) {
  // The server keeps a 2-second trend history; request it once and then
  // append the live point locally between refreshes.
  if (!window._hist) window._hist = [];
  const last = window._hist[window._hist.length - 1];
  if (!last || s.meta.simTime > last.t + 1.5) {
    window._hist.push({
      t: s.meta.simTime, mw: s.plant.grossMW, p: s.boilers[0].drumPressure,
      msT: s.boilers[0].msTemp, vac: s.condenser.vacuum, coal: s.plant.totalCoal,
    });
    if (window._hist.length > 900) window._hist.shift();
  }
  const H = window._hist;
  chart($('#c-mw'), H, ['mw'], ['#38bdf8'], [0, 700]);
  chart($('#c-pt'), H, ['p', 'msT'], ['#f0b429', '#ff8a5b'], null, [0, 20], [0, 600]);
  chart($('#c-vac'), H, ['vac'], ['#37d67a'], null, [0, 30]);
  chart($('#c-coal'), H, ['coal'], ['#c9a227'], [0, 340]);
}

function chart(cv, data, keys, colors, fixedRange, r1, r2) {
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#1b2836'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  if (data.length < 2) return;
  keys.forEach((k, ki) => {
    const r = ki === 0 ? (fixedRange || r1) : (r2 || r1);
    let lo, hi;
    if (r) { lo = r[0]; hi = r[1]; } else {
      lo = Infinity; hi = -Infinity;
      for (const d of data) { const v = d[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
    }
    ctx.strokeStyle = colors[ki]; ctx.lineWidth = 1.6;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((d[k] - lo) / (hi - lo)) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

/* ============================== wiring ============================== */
function init() {
  scene = new PlantScene($('#gl'));

  /* ---- sound ---- */
  audio = new PlantAudio();
  const soundBtn = $('#btnSound');
  const volEl = $('#vol');
  const paintSound = () => {
    soundBtn.textContent = audio.enabled ? '🔊 SOUND ON' : '🔇 SOUND OFF';
    soundBtn.classList.toggle('on', !!audio.enabled);
    volEl.value = String(Math.round(audio.volume * 100));
  };
  volEl.value = String(Math.round(audio.volume * 100));
  soundBtn.addEventListener('click', async () => {
    if (audio.enabled) audio.disable();
    else {
      const ok = await audio.enable();
      if (!ok) { soundBtn.textContent = '🔇 NO AUDIO DEVICE'; return; }
    }
    paintSound();
  });
  volEl.addEventListener('input', () => audio.setVolume(Number(volEl.value) / 100));
  paintSound();

  /* ---- shared control helpers used by the tutorial and the autopilot ---- */
  const setSpeed = (v) => {
    const sel = $('#speed');
    if (sel) sel.value = String(v);
    send({ type: 'speed', value: v });
  };
  const setLoad = (mw, ramp) => {
    $('#loadSp').value = String(mw);
    $('#ramp').value = String(ramp);
    cmd('loadSetpoint', mw);
    cmd('rampRate', ramp);
  };

  /* ---- guided start-up tutorial ---- */
  tutorial = new Tutorial({
    send,
    cmd,
    setSpeed,
    setLoad,
    sfx: (name) => audio && audio.event(name),
  });

  /* ---- autopilot: start, run up and load the unit hands-off ---- */
  autopilot = new Autopilot({
    cmd,
    setSpeed,
    setLoad,
    sfx: (name) => audio && audio.event(name),
    el: $('#autoState'),
  });
  const autoBtn = $('#btnAuto');
  const paintAuto = () => {
    autoBtn.textContent = autopilot.active ? '🤖 AUTOPILOT ON' : '🤖 AUTOPILOT OFF';
    autoBtn.classList.toggle('primary', autopilot.active);
  };
  autoBtn.addEventListener('click', () => { autopilot.toggle(); paintAuto(); });
  paintAuto();
  autopilot.paint();

  /* ---- reset plant: two clicks, because it discards the whole run ---- */
  const resetBtn = $('#btnResetPlant');
  let resetArmedAt = 0;
  const paintReset = () => {
    resetBtn.textContent = resetArmedAt ? '⟲ CONFIRM RESET' : '⟲ RESET PLANT';
    resetBtn.classList.toggle('warn', !!resetArmedAt);
  };
  resetBtn.addEventListener('click', () => {
    if (!resetArmedAt) {
      resetArmedAt = Date.now();
      paintReset();
      setTimeout(() => { resetArmedAt = 0; paintReset(); }, 10000);   // 10 s to confirm
      return;
    }
    resetArmedAt = 0;
    paintReset();
    if (autopilot && autopilot.active) { autopilot.disable('disengaged — plant reset'); paintAuto(); }
    cmd('resetPlant');
  });
  paintReset();

  /* ---- build stamp, bottom right ---- */
  fetch('/api/design').then((r) => r.json()).then((d) => {
    const v = d && d.version ? d.version : {};
    const label = `v${v.version || '—'}` + (v.commit ? ` · ${v.commit}` : '');
    // shown in two places: the header survives, and it is the quickest way to
    // tell which build an operator is actually looking at
    $('#ver').textContent = label;
    const head = $('#verHead');
    if (head) head.textContent = label;
  }).catch(() => { $('#ver').textContent = 'v—'; });
  $('#btnTutorial').addEventListener('click', () => {
    tutorial.toggle();
    $('#btnTutorial').classList.toggle('primary', tutorial.running);
  });
  $('#btnTutorial2').addEventListener('click', () => {
    tutorial.start(0);
    $$('.tabs button[data-pane]').forEach((x) => x.classList.remove('active'));
    $$('.tabs button[data-pane]').forEach((x) => { if (x.dataset.pane === 'proc') x.classList.add('active'); });
  });

  $$('.tabs button[data-pane]').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button[data-pane]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $$('.pane').forEach(p => p.classList.remove('active'));
    $(`#p-${b.dataset.pane}`).classList.add('active');
  }));
  $$('.bTab').forEach(b => b.addEventListener('click', () => {
    $$('.bTab').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); boilerTab = Number(b.dataset.boiler); render();
  }));
  $$('#viewbtns button[data-view]').forEach(b =>
    b.addEventListener('click', () => scene.view(b.dataset.view)));
  $('#lblBtn').addEventListener('click', () => {
    const v = !scene.labels.visible; scene.setLabelsVisible(v);
  });

  $('#btnStart').addEventListener('click', () => cmd('start'));
  $('#btnShutdown').addEventListener('click', () => cmd('shutdown'));
  $('#btnTrip').addEventListener('click', () => cmd('tripTurbine'));
  $('#btnMft').addEventListener('click', () => cmd('mft'));
  $('#btnReset').addEventListener('click', () => cmd('resetMFT'));
  $('#btnLoad').addEventListener('click', () => cmd('loadSetpoint', Number($('#loadSp').value)));
  $('#btnRamp').addEventListener('click', () => cmd('rampRate', Number($('#ramp').value)));
  $('#btnAmb').addEventListener('click', () =>
    cmd('ambient', { temp: Number($('#amb').value), wetBulb: Number($('#amb').value) - 4 }));
  $('#speed').addEventListener('change', () => send({ type: 'speed', value: Number($('#speed').value) }));
  $('#ackAll').addEventListener('click', () => cmd('ackAll'));
  $('#clearAllFaults').addEventListener('click', () => cmd('clearAllFaults'));
  $('#fsearch').addEventListener('input', () => renderFaults(state ? (state.activeFaults || []) : []));
  $('#alarms').addEventListener('click', (e) => {
    const el = e.target.closest('.al');
    if (el) cmd('ackAlarm', el.dataset.key);
  });
  $('#faults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fault]');
    if (!b) return;
    if (b.dataset.on === '1') send({ type: 'clearFault', id: b.dataset.fault });
    else send({ type: 'injectFault', id: b.dataset.fault, magnitude: 1 });
  });

  // Exposed for the automated UI tests and for console debugging.
  window.__tcsim = {
    get state() { return state; }, get scene() { return scene; },
    get audio() { return audio; }, get tutorial() { return tutorial; },
    get autopilot() { return autopilot; },
    send, cmd,
  };

  connect();
  setInterval(() => { if (ws && ws.readyState === 1) send({ type: 'ping' }); }, 20000);
}

window.addEventListener('DOMContentLoaded', init);
