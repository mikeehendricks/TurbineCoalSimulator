/**
 * autopilot.js — hands-off plant operation for the training simulator.
 *
 * The autopilot does what a competent operator would do on a routine run: start
 * the unit from cold, let the sequencer run it up, load to a target at the
 * recommended ramp, and then hold it. It is deliberately conservative — it never
 * pushes load into an alarm, and it hands control straight back to the operator
 * the moment the unit trips.
 *
 *   SHUTDOWN COLD / PRESTART   issue START, raise the time acceleration
 *   PURGE … SYNCHRONISING      hands off, the sequencer drives the run-up
 *   LOADING / ONLINE           load to the target at 6 MW/min
 *   any alarm                  freeze the load where it is and report
 *   MFT or turbine trip        disengage immediately and say why
 *
 * Two numbers come straight out of the physics testing carried out on this
 * build, so they are not arbitrary:
 *
 *   target 500 MW   the unit reaches ~497 MW when it is given a full-load
 *                   target. A part-load *setpoint* settles 20-25 % below the
 *                   number asked for (300 MW → ~242 MW) because the
 *                   sliding-pressure schedule outruns the turbine model, so the
 *                   autopilot asks for full load rather than a part-load figure.
 *   ramp   6 MW/min the qualified loading rate. Anything up to 12 MW/min is
 *                   survivable, but 12 MW/min is where the run-back starts
 *                   holding the load.
 *
 * The autopilot is a training aid, not a protection system: every interlock and
 * trip in server/sim/engine.js stays armed while it is engaged.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Alarm priorities that stop the autopilot from raising load any further. */
const HOLD_PRIORITIES = new Set(['HIGH', 'CRITICAL']);
/** Below this load, economiser steaming is a normal low-load condition. */
const LOW_LOAD_STEAMING_MW = 265;

export class Autopilot {
  /**
   * @param {object} opts
   * @param {(cmd:string,value:any)=>void} opts.cmd        command helper
   * @param {(v:number)=>void} opts.setSpeed               time acceleration
   * @param {(mw:number,ramp:number)=>void} opts.setLoad   load setpoint + ramp
   * @param {(name:string)=>void} [opts.sfx]               sound effect hook
   * @param {HTMLElement} [opts.el]                        status readout element
   */
  constructor({ cmd, setSpeed, setLoad, sfx, el }) {
    this.cmd = cmd;
    this.setSpeed = setSpeed;
    this.setLoad = setLoad;
    this.sfx = sfx || (() => {});
    this.el = el || null;

    this.active = false;
    this.target = 500;      // MW — see the header note
    this.ramp = 6;          // MW/min
    this.runUpSpeed = 60;   // time acceleration used while running up

    this.state = 'OFF';     // OFF | STARTING | RUNNING_UP | LOADING | HOLDING | ON_LOAD
    this.note = 'off';
    this.prevSpeed = null;
    this.lastCmdSimTime = -1e9;
    this.advisory = 0;
  }

  get running() { return this.active; }

  enable() {
    if (this.active) return;
    this.active = true;
    this.state = 'STARTING';
    this.prevSpeed = null;
    this.lastCmdSimTime = -1e9;
    this.sfx('chime');
    this.paint();
  }

  disable(reason) {
    if (!this.active) return;
    this.active = false;
    this.state = 'OFF';
    // Hand the time acceleration back to whatever the operator had set.
    if (this.prevSpeed !== null) { this.setSpeed(this.prevSpeed); this.prevSpeed = null; }
    this.note = reason || 'disengaged';
    this.paint();
  }

  toggle() { this.active ? this.disable() : this.enable(); }

  /** Rate-limit outgoing commands to one every `everySec` seconds of sim time. */
  throttled(fn, simTime, everySec) {
    if (simTime - this.lastCmdSimTime < everySec) return;
    this.lastCmdSimTime = simTime;
    fn();
  }

  update(s) {
    if (!this.active || !s) return;

    const prot = s.protection || {};
    const mft = prot.mft || {};
    const tt = prot.turbineTrip || {};
    if (mft.latched || tt.latched) {
      this.disable(mft.latched ? `disengaged — MFT: ${mft.cause || 'unknown'}`
        : `disengaged — turbine trip: ${tt.cause || 'unknown'}`);
      return;
    }

    const mode = s.meta.mode;
    const mw = s.plant.grossMW || 0;
    const simTime = s.meta.simTime || 0;

    // A cold start needs time acceleration, otherwise the run-up takes a whole
    // shift of real time. Remember the operator's setting and restore it later.
    if (this.prevSpeed === null && (s.meta.speedFactor || 1) < 30) {
      this.prevSpeed = s.meta.speedFactor;
      this.setSpeed(this.runUpSpeed);
    }

    if (mode === 'SHUTDOWN_COLD' || mode === 'PRESTART' || mode === 'POST_PURGE') {
      this.state = 'STARTING';
      this.note = 'starting the unit from cold';
      this.throttled(() => this.cmd('start'), simTime, 30);
      this.paint();
      return;
    }

    if (mode !== 'LOADING' && mode !== 'ONLINE') {
      this.state = 'RUNNING_UP';
      this.note = `running up — ${mode.replace(/_/g, ' ').toLowerCase()}`;
      this.paint();
      return;
    }

    // Never push load into a real alarm: freeze the setpoint where it is.
    // Only HIGH and CRITICAL stop the ramp — MEDIUM and LOW are advisory, and
    // some of them are normal at low load (economiser steaming below ~40 % load,
    // for instance), so holding for every alarm would strand the unit at
    // part load on every start.
    const alarms = s.alarms || [];
    const serious = alarms.filter((a) => HOLD_PRIORITIES.has(a.prio)
      && !(a.id === 'ECON_STEAMING' && mw < LOW_LOAD_STEAMING_MW));
    if (serious.length > 0) {
      this.state = 'HOLDING';
      this.note = `holding ${Math.round(mw)} MW — ${serious[0].msg || serious[0].id}`;
      this.throttled(() => this.setLoad(Math.max(0, Math.round(mw / 10) * 10), this.ramp), simTime, 60);
      this.paint();
      return;
    }
    this.advisory = alarms.length;

    const advisory = this.advisory ? ` (${this.advisory} advisory alarm${this.advisory === 1 ? '' : 's'})` : '';
    if (Math.abs(mw - this.target) <= 10) {
      this.state = 'ON_LOAD';
      this.note = `on load — holding ${Math.round(mw)} MW${advisory}`;
      this.paint();
      return;
    }

    this.state = 'LOADING';
    this.note = `loading to ${this.target} MW — ${Math.round(mw)} MW${advisory}`;
    this.throttled(() => this.setLoad(this.target, this.ramp), simTime, 60);
    this.paint();
  }

  paint() {
    if (!this.el) return;
    this.el.textContent = this.active ? `AUTOPILOT · ${this.note}` : `autopilot ${this.note}`;
  }

  /** Target and ramp can be adjusted from the console: __tcsim.autopilot.target */
  setTarget(mw, ramp) {
    this.target = clamp(Number(mw) || this.target, 0, 660);
    if (ramp) this.ramp = clamp(Number(ramp) || this.ramp, 0.5, 12);
  }
}
