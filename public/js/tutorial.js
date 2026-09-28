/**
 * tutorial.js — guided cold start-up walkthrough.
 *
 * The tutorial does not drive the plant for the operator (except where an
 * action is pure console housekeeping, e.g. setting the time acceleration).
 * Each step states what to do, why it is done, the control to use, and a
 * live-readout hint; the step completes when the plant snapshot satisfies the
 * step's predicate, so the operator can only advance by actually achieving the
 * plant condition.
 *
 * Steps, limits and timings follow the sequences implemented in
 * server/sim/engine.js (PRESTART → PURGE → LIGHTOFF → PRESSURISING →
 * TURBINE_ROLL → SYNCHRONISING → LOADING → ONLINE).
 */

const f1 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(1);
const f0 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(0);

export class Tutorial {
  /**
   * @param {object} opts
   * @param {(obj:object)=>void} opts.send      raw WebSocket send
   * @param {(cmd:string,value:any)=>void} opts.cmd  command helper
   * @param {(v:number)=>void} opts.setSpeed   set the time acceleration
   * @param {(mw:number,ramp:number)=>void} opts.setLoad
   * @param {(name:string)=>void} [opts.sfx]   sound effect hook
   */
  constructor({ send, cmd, setSpeed, setLoad, sfx }) {
    this.send = send;
    this.cmd = cmd;
    this.setSpeed = setSpeed;
    this.setLoad = setLoad;
    this.sfx = sfx || (() => {});
    this.active = false;
    this.index = 0;
    this.snap = null;
    this.holdFrom = null;      // sim time at which the step predicate became true
    this.completedAt = null;
    this.el = document.getElementById('tutor');
    this.steps = this.buildSteps();
    this.render();
  }

  /* ------------------------------------------------------------------ *
   *  Step definitions
   * ------------------------------------------------------------------ */
  buildSteps() {
    const b0 = (s) => s.boilers[0];
    const lead = (s) => (s.boilers.find((b) => b.inService) || s.boilers[0]);
    const avgP = (s) => {
      const ins = s.boilers.filter((b) => b.inService);
      return ins.reduce((a, b) => a + b.drumPressure, 0) / Math.max(1, ins.length);
    };

    return [
      {
        id: 'welcome',
        title: '1 · Before you start',
        control: null,
        why: 'This unit is a 660 MWe twin-boiler station: two 930 t/h boilers feed one ' +
          'HP–IP–2×LP turbine-generator. A real cold start takes 6–10 hours, so the ' +
          'tutorial runs the simulator at accelerated time. Every step below is the ' +
          'same action a control-room operator takes — nothing is skipped.',
        action: 'Read the step, then press “Begin”.',
        hint: (s) => `Unit is <b>${s.meta.mode.replace(/_/g, ' ')}</b> · drum ${f1(avgP(s))} MPa · ` +
          `${f0(s.plant.grossMW)} MW · ${f0(s.turbine.speed)} rpm`,
        done: () => true,
        manual: true,        // never auto-advance: the operator presses Begin
        cta: 'Begin',
      },
      {
        id: 'speed',
        title: '2 · Set time acceleration',
        control: '#speed',
        why: 'The model integrates the boiler, turbine and balance of plant in real ' +
          'time. At 60× one minute of your time is one hour of plant time — the ' +
          'drum heating rates, rotor soaks and purge credit are all preserved, ' +
          'only the clock runs faster. 600× is useful for long pressure raises but ' +
          'makes drum level harder to watch.',
        action: 'Select <b>60×</b> (or faster) in the “Time” control at the bottom of the screen.',
        hint: (s) => `Time acceleration is <b>${s.meta.speedFactor}×</b> — the tutorial needs 30× or more.`,
        done: (s) => s.meta.speedFactor >= 30,
        assist: () => this.setSpeed(60),
        assistLabel: 'Set 60× for me',
      },
      {
        id: 'start',
        title: '3 · Initiate the start-up sequence',
        control: '#btnStart',
        why: 'Pressing START UNIT arms the automatic start-up sequencer. It performs ' +
          'the pre-start checks, starts the auxiliary plant, purges the furnace, ' +
          'lights off on oil, raises pressure on the start-up envelope, rolls and ' +
          'synchronises the machine, then hands over at about 15 % load.',
        action: 'Press <b>▶ START UNIT</b>.',
        hint: (s) => `Mode: <b>${s.meta.mode.replace(/_/g, ' ')}</b> — the sequencer must leave SHUTDOWN COLD.`,
        done: (s) => s.meta.mode !== 'SHUTDOWN_COLD' && s.meta.mode !== 'POST_PURGE',
        assist: () => this.cmd('start'),
        assistLabel: 'Press START for me',
      },
      {
        id: 'prestart',
        title: '4 · Pre-start checks — auxiliaries and vacuum',
        control: '[data-pane="bop"]',
        why: 'The sequencer starts lube-oil, jacking-oil and turning gear, a ' +
          'circulating-water pump, a condensate pump and the vacuum pumps, puts a ' +
          'boiler feed pump on, energises the ESP fields, starts the FGD and the ' +
          'coal conveyors and seals the turbine glands. It then waits for the drum ' +
          'level to be above −70 mm, condenser vacuum better than 40 kPa and one ' +
          'minute to elapse before it will purge. Jacking oil and turning gear keep ' +
          'the rotor from sagging while it is heated.',
        action: 'Watch the BOP tab — nothing to operate yet. The step clears when the ' +
          'furnace purge begins.',
        hint: (s) => `Condenser vacuum <b>${f1(s.condenser.vacuum)} kPa</b> (need &lt; 40) · ` +
          `drum level <b>${f0(lead(s).drumLevelTotal)} mm</b> (need &gt; −70) · ` +
          `turning gear ${s.turbine.turningGear ? 'ON' : 'off'} · ` +
          `lube oil ${f1(s.turbine.lubeOilPressure)} MPa`,
        done: (s) => s.meta.mode === 'PURGE' || s.meta.mode === 'LIGHTOFF'
          || s.meta.mode === 'PRESSURISING' || s.meta.mode === 'TURBINE_ROLL',
      },
      {
        id: 'purge',
        title: '5 · Furnace purge',
        control: '[data-pane="boiler"]',
        why: 'Before any fuel is admitted the furnace is purged with at least 30 % ' +
          'MCR air flow for five minutes (NFPA 85: five volume changes) to clear ' +
          'any unburned coal or combustible gas. FD, ID and PA fans run and the ' +
          'draft is held slightly negative. Purging is a hard interlock — no ' +
          'ignitor can fire until the purge credit is established.',
        action: 'Wait for the purge credit. Watch furnace draft stay negative and ' +
          'the air flow at 30–45 % on the Boilers tab.',
        hint: (s) => `${s.meta.phaseNote || 'purging'} · draft <b>${f0(lead(s).draft)} Pa</b> · ` +
          `FD/ID ${lead(s).fdRunning ? 'RUN' : 'stop'}/${lead(s).idRunning ? 'RUN' : 'stop'}`,
        done: (s) => ['LIGHTOFF', 'PRESSURISING', 'TURBINE_ROLL', 'SYNCHRONISING', 'LOADING', 'ONLINE']
          .includes(s.meta.mode),
      },
      {
        id: 'lightoff',
        title: '6 · Light-off and flame proving',
        control: '[data-pane="boiler"]',
        why: 'Light fuel-oil ignitors are fired first. Flame scanners must prove ' +
          'stable flame for 30 s before the sequencer moves on; if all flame is ' +
          'lost the boiler trips on “loss of all flame”. Coal mills are only ' +
          'started once the furnace is hot enough to ignite pulverised fuel — ' +
          'about 380 °C furnace temperature.',
        action: 'Confirm flame is proven (scanners > 0) and oil guns are in service.',
        hint: (s) => `Flame scanners <b>${lead(s).flameScanners}/16</b> · oil ${f1(lead(s).oilFlow)} t/h · ` +
          `furnace <b>${f0(lead(s).furnaceTemp)} °C</b> · mills running ${lead(s).millsRunning}`,
        done: (s) => ['PRESSURISING', 'TURBINE_ROLL', 'SYNCHRONISING', 'LOADING', 'ONLINE']
          .includes(s.meta.mode),
      },
      {
        id: 'pressure',
        title: '7 · Pressure raising — respect the start-up envelope',
        control: '[data-pane="boiler"]',
        why: 'Drum thermal stress limits the whole pressure raise. The envelope ' +
          'allows only 0.01 MPa/min below 0.5 MPa rising to 0.18 MPa/min above ' +
          '12 MPa, and the drum top-to-bottom metal differential must stay under ' +
          'about 55 K. The start-up vent is throttled to pull steam through the ' +
          'superheater so the main-steam temperature rises with pressure.',
        action: 'Watch drum pressure climb, the metal differential stay low and the ' +
          'vent flow. Nothing to operate.',
        hint: (s) => `Drum <b>${f1(avgP(s))} MPa</b> · metal ΔT <b>${f1(lead(s).drumMetalDiff)} K</b> · ` +
          `metal rate ${f0(lead(s).metalRate * 3600)} K/h · MS temp ${f0(lead(s).msTemp)} °C · ` +
          `vent ${f0(lead(s).ventFlow)} t/h`,
        done: (s) => avgP(s) >= 4.0,
      },
      {
        id: 'roll',
        title: '8 · Reach rolling conditions (8 MPa and 415 °C)',
        control: '[data-pane="turb"]',
        why: 'The turbine is only rolled when the steam is hot enough that no ' +
          'condensation can form in the machine — the classic water-induction ' +
          'risk. The target is the 8 MPa start-up pressure with at least 415 °C ' +
          'main steam and good superheat margin over saturation. At that point the ' +
          'turning gear and jacking oil come off and the speed controller takes ' +
          'the machine to its first hold.',
        action: 'Wait for the sequencer to hand over to the turbine run-up.',
        hint: (s) => `Drum <b>${f1(avgP(s))} MPa</b> (target 8.0) · MS temp <b>${f0(lead(s).msTemp)} °C</b> ` +
          `(need ≥ 415) · superheat margin ${f0(lead(s).msTemp - sat(avgP(s)))} K`,
        done: (s) => ['TURBINE_ROLL', 'SYNCHRONISING', 'LOADING', 'ONLINE'].includes(s.meta.mode),
      },
      {
        id: 'runup',
        title: '9 · Run up to 3000 rpm through the soak steps',
        control: '[data-pane="turb"]',
        why: 'The run-up programme accelerates the rotor and holds it at 200, 600, ' +
          '1200, 2200 and 3000 rpm. Each hold lets the rotor warm through so the ' +
          'differential expansion stays inside the gland clearances; the critical ' +
          'speeds are passed quickly. Throughout, vibration must stay below 75 µm ' +
          '(trip at 125 µm) and eccentricity must remain low.',
        action: 'Watch speed, vibration, eccentricity and differential expansion on ' +
          'the Turbine tab while the machine runs up.',
        hint: (s) => `${s.meta.phaseNote || 'running up'} · speed <b>${f0(s.turbine.speed)} rpm</b> · ` +
          `vibration ${f0(Math.max(...s.turbine.vibrations))} µm · ecc ${f1(s.turbine.eccentricity)} · ` +
          `diff exp ${f1(s.turbine.differentialExpansion)} mm`,
        done: (s) => s.turbine.speed >= 2990,
      },
      {
        id: 'sync',
        title: '10 · Synchronise the generator',
        control: '[data-pane="plant"]',
        why: 'At rated speed the AVR matches generator voltage to the grid and the ' +
          'governor trims frequency until voltage, frequency and phase agree across ' +
          'the open breaker. The synchroniser then closes the breaker and the unit ' +
          'takes a small block of load immediately so it does not motor.',
        action: 'Wait for the breaker to close — the Plant tab shows the frequency ' +
          'and output.',
        hint: (s) => `Breaker <b>${s.turbine.breakerClosed ? 'CLOSED' : 'OPEN'}</b> · ` +
          `${f0(s.turbine.speed)} rpm · ${f1(s.plant.frequency)} Hz · ${f1(s.generator.kV)} kV · ` +
          `${f0(s.plant.grossMW)} MW`,
        done: (s) => !!s.turbine.breakerClosed,
      },
      {
        id: 'soak',
        title: '11 · Initial load soak and automatic loading',
        control: '[data-pane="alarms"]',
        why: 'The unit holds roughly 5 % load for 30 minutes to warm the boiler ' +
          'circulation, the reheater and the turbine casings, then loads at the ' +
          'ramp rate while drum level and steam temperature stay settled. If the ' +
          'drum level deviates beyond 130 mm the runback logic holds the ramp, and ' +
          'if steam temperature drifts the ramp stops until it recovers.',
        action: 'Watch drum level on the overlay and any alarms. The step clears at ' +
          'about 90 MW.',
        hint: (s) => `${f0(s.plant.grossMW)} MW · drum level <b>${f0(lead(s).drumLevelTotal)} mm</b> · ` +
          `${s.meta.phaseNote || ''}`,
        done: (s) => s.plant.grossMW >= 85,
      },
      {
        id: 'load',
        title: '12 · Load the unit to full output',
        control: '#loadSp',
        why: 'Take the unit up at 6 MW/min (about 1 %/min). Above roughly 500 MW the ' +
          'drum pressure approaches the safety valves at 19.2 MPa, so the last ' +
          '100 MW is a genuine boiler/turbine balancing exercise: watch drum ' +
          'pressure, drum level, main-steam temperature (538 °C design) and ' +
          'condenser vacuum (design 9.5 kPa) together.',
        action: 'Set <b>Load setpoint 500 MW</b>, press <b>set</b>, set <b>Ramp ' +
          '6 MW/min</b>, press <b>set</b>. The automatic runback holds the ramp ' +
          'whenever the drum level or the steam temperature is unsettled, so let ' +
          'it take the load in its own time.',
        hint: (s) => `${f0(s.plant.grossMW)} MW of ${f0(s.meta.targetLoad)} MW set · ` +
          `drum ${f1(avgP(s))} MPa · MS ${f0(lead(s).msTemp)} °C · vacuum ${f1(s.condenser.vacuum)} kPa · ` +
          `coal ${f0(s.plant.totalCoal)} t/h`,
        done: (s) => s.plant.grossMW >= 300,
        assist: () => this.setLoad(150, 6),
        assistLabel: 'Set 150 MW @ 6 MW/min',
      },
      {
        id: 'stabilise',
        title: '13 · Stabilise and monitor',
        control: '[data-pane="plant"]',
        why: 'Hold the unit steady for a while: drum level inside ±100 mm, main ' +
          'steam 528–548 °C, condenser vacuum below 18 kPa, generator and bearing ' +
          'temperatures stable, and no unacknowledged alarms. That is the condition ' +
          'you would hand over to the next shift.',
        action: 'Hold steady for 30 seconds of plant time. Then the tutorial is complete.',
        hint: (s) => `Hold: level <b>${f0(lead(s).drumLevelTotal)} mm</b> (±100) · ` +
          `MS <b>${f0(lead(s).msTemp)} °C</b> (520–550) · vacuum <b>${f1(s.condenser.vacuum)} kPa</b> (&lt;18)`,
        done: (s) => s.plant.grossMW >= 280
          && Math.abs(lead(s).drumLevelTotal) < 110
          && s.condenser.vacuum < 19
          && lead(s).msTemp > 500 && lead(s).msTemp < 570,
        hold: 20,   // seconds of simulated time the condition must persist
      },
    ];
  }

  /* ------------------------------------------------------------------ *
   *  Public API
   * ------------------------------------------------------------------ */
  start(index = 0) {
    this.active = true;
    this.index = Math.max(0, Math.min(index, this.steps.length - 1));
    this.holdFrom = null;
    this.completedAt = null;
    this.sfx('tutorial');
    this.render();
  }

  stop() {
    this.active = false;
    this.highlight(null);
    this.render();
  }

  toggle() { this.active ? this.stop() : this.start(firstUnfinishedIndex(this)); }

  get running() { return this.active; }

  /** Called with every snapshot from the HMI render loop. */
  update(snap) {
    this.snap = snap;
    if (!this.active) { this.render(); return; }

    const step = this.steps[this.index];
    if (!step) return;

    // Trip handling — offer recovery instead of silently advancing.
    if (snap.protection && (snap.protection.mft.latched || snap.protection.turbineTrip.latched)) {
      this.holdFrom = null;
      this.render(snap.protection.mft.latched ? 'mft' : 'trip');
      return;
    }

    // Manual steps (the welcome screen, for example) wait for the operator to
    // press the button — otherwise the tutorial would race ahead of the reader.
    if (step.manual) { this.render(); return; }

    let ok = false;
    try { ok = !!step.done(snap); } catch { ok = false; }

    if (step.hold) {
      if (ok && this.holdFrom == null) this.holdFrom = snap.meta.simTime;
      const held = ok && this.holdFrom != null && (snap.meta.simTime - this.holdFrom) >= step.hold;
      if (!ok) this.holdFrom = null;
      if (held) this.advance();
      else this.render();
      return;
    }

    if (ok) this.advance();
    else this.render();
  }

  advance() {
    this.holdFrom = null;
    this.sfx('step');
    if (this.index >= this.steps.length - 1) {
      this.completedAt = this.snap ? this.snap.meta.simTime : 0;
      this.active = false;
      this.highlight(null);
      try { localStorage.setItem('tcsim.tutorialDone', '1'); } catch { /* ignore */ }
      this.render();
      this.sfx('done');
      return;
    }
    this.index++;
    this.render();
  }

  next() { if (this.active) this.advance(); }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  highlight(sel) {
    document.querySelectorAll('.tut-hl').forEach((e) => e.classList.remove('tut-hl'));
    if (!sel) return;
    try {
      const el = document.querySelector(sel);
      if (el) el.classList.add('tut-hl');
    } catch { /* ignore */ }
  }

  render(fault) {
    const el = this.el;
    if (!el) return;
    if (!this.active) {
      el.style.display = 'none';
      this.highlight(null);
      if (this.completedAt != null && this.snap) {
        el.style.display = 'block';
        el.innerHTML = this.summaryHtml();
        this.bind(el);
      }
      return;
    }
    const step = this.steps[this.index];
    this.highlight(step.control);

    const pct = Math.round((this.index / (this.steps.length - 1)) * 100);
    const hint = this.snap ? step.hint(this.snap) : '';
    const cta = step.cta || (this.index === this.steps.length - 1 ? 'Finish' : 'Next');

    el.style.display = 'block';
    el.className = 'tutor' + (fault ? ' fault' : '');
    el.innerHTML = `
      <div class="tt-head">
        <span class="tt-kicker">GUIDED START-UP</span>
        <span class="tt-count">step ${this.index + 1} of ${this.steps.length}</span>
        <button class="tt-x" data-act="close" title="Exit tutorial">✕</button>
      </div>
      <div class="tt-bar"><i style="width:${pct}%"></i></div>
      <h4 class="tt-title">${step.title}</h4>
      <div class="tt-sec"><b>Why</b><p>${step.why}</p></div>
      <div class="tt-sec"><b>Do</b><p>${step.action}</p></div>
      <div class="tt-sec tt-live"><b>Plant now</b><p>${hint}</p></div>
      ${fault ? `<div class="tt-trip">
          ${fault === 'mft' ? 'MASTER FUEL TRIP' : 'TURBINE TRIP'} — the unit has tripped.
          Reset the relays, restart the sequence and the tutorial will pick the step up again.
        </div>` : ''}
      <div class="tt-foot">
        ${step.assist ? `<button class="btn" data-act="assist">${step.assistLabel || 'Do it for me'}</button>` : ''}
        ${fault ? '<button class="btn warn" data-act="reset">↺ Reset MFT</button>' : ''}
        <button class="btn" data-act="skip">Skip step ▸</button>
        <span class="spacer"></span>
        <button class="btn primary" data-act="next" ${fault ? 'disabled' : ''}>${cta} ▸</button>
      </div>`;
    this.bind(el);
  }

  summaryHtml() {
    const s = this.snap;
    const hours = (this.completedAt / 3600).toFixed(1);
    return `
      <div class="tt-head">
        <span class="tt-kicker">GUIDED START-UP</span>
        <span class="tt-count">complete</span>
        <button class="tt-x" data-act="close" title="Close">✕</button>
      </div>
      <div class="tt-bar"><i style="width:100%"></i></div>
      <h4 class="tt-title">✔ Cold start-up complete</h4>
      <div class="tt-sec"><p>The unit is on load and stable after
        <b>${hours} h</b> of simulated plant time.</p>
        <table class="tt-sum">
          <tr><td>Gross / net output</td><td>${f0(s.plant.grossMW)} / ${f0(s.plant.netMW)} MW</td></tr>
          <tr><td>Drum pressure</td><td>${f1(s.boilers[0].drumPressure)} MPa</td></tr>
          <tr><td>Main steam / hot reheat</td><td>${f0(s.boilers[0].msTemp)} / ${f0(s.boilers[0].rhOutTemp)} °C</td></tr>
          <tr><td>Condenser vacuum</td><td>${f1(s.condenser.vacuum)} kPa</td></tr>
          <tr><td>Coal fired</td><td>${f0(s.plant.totalCoal)} t/h</td></tr>
          <tr><td>Gross heat rate</td><td>${f0(s.plant.heatRate)} kJ/kWh</td></tr>
          <tr><td>Station auxiliaries</td><td>${f0(s.plant.auxMW)} MW</td></tr>
        </table></div>
      <div class="tt-sec"><b>What to try next</b><p>Finish loading to full output with
        the <b>Load setpoint</b> control. Then inject a
        fault from the <b>Faults</b> tab (a boiler tube leak or an ID fan trip are
        good places to start) and handle it, or press <b>■ SHUT DOWN</b> to run the
        controlled shutdown sequence to turning gear.</p></div>
      <div class="tt-foot">
        <button class="btn" data-act="restart">↺ Run tutorial again</button>
        <span class="spacer"></span>
        <button class="btn primary" data-act="close">Close</button>
      </div>`;
  }

  bind(el) {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') { this.stop(); this.completedAt = null; }
      else if (act === 'next') this.next();
      else if (act === 'skip') this.next();
      else if (act === 'restart') this.start(0);
      else if (act === 'reset') this.cmd('resetMFT');
      else if (act === 'assist') {
        const step = this.steps[this.index];
        if (step && step.assist) step.assist();
        this.render();
      }
    });
  }

  /** Which step the plant state is currently at (used to resume a tutorial). */
  static resumeIndex(snap, steps) {
    for (let i = 0; i < steps.length; i++) {
      try { if (!steps[i].done(snap)) return i; } catch { return i; }
    }
    return 0;
  }
}

function firstUnfinishedIndex(tut) {
  if (!tut.snap) return 0;
  const i = Tutorial.resumeIndex(tut.snap, tut.steps);
  return i;
}

/** Saturation temperature approximation, display only. */
function sat(P) {
  if (P < 0.02) return 60;
  return Math.min(365, 100 * Math.pow(Math.max(0.01, P), 0.2367));
}
