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
   *   MFT or turbine trip        refuse to engage, or disengage, and say why
   *
   * `update()` can end the engagement on its own — a trip, a latched MFT. When
   * it does, `onChange` must fire so the button stops claiming to be ON: an
   * earlier build left the label reading AUTOPILOT ON with `active === false`,
   * which made the button look broken and un-clickable.
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
/** Phases in which the unit is coming *down*, so the autopilot must wait. */
const SHUTDOWN_PHASES = new Set(['UNLOADING', 'FIREDOWN', 'COASTDOWN', 'TURNING_GEAR']);

export class Autopilot {
  /**
   * @param {object} opts
   * @param {(cmd:string,value:any)=>void} opts.cmd        command helper
   * @param {(v:number)=>void} opts.setSpeed               time acceleration
   * @param {(mw:number,ramp:number)=>void} opts.setLoad   load setpoint + ramp
   * @param {(name:string)=>void} [opts.sfx]               sound effect hook
   * @param {HTMLElement} [opts.el]                        status readout element
   * @param {()=>void} [opts.onChange]                     fired whenever the
   *        engagement changes, including when the autopilot ends it itself
   */
  constructor({ cmd, setSpeed, setLoad, sfx, el, onChange }) {
    this.cmd = cmd;
    this.setSpeed = setSpeed;
    this.setLoad = setLoad;
    this.sfx = sfx || (() => {});
    this.el = el || null;
    this.onChange = onChange || (() => {});
    this.last = null;      // most recent snapshot, for the engage-time guard

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

  /** Tell the HMI that the engagement changed, so the button cannot lie. */
  changed() { try { this.onChange(); } catch (e) { /* never break the run */ } }

  /**
   * Why the autopilot cannot be engaged right now, or null if it can.
   * Checked before engaging so the operator gets a reason instead of a button
   * that flips on and immediately back off again.
   */
  blockReason(s) {
    if (!s || !s.protection) return null;
    const mft = s.protection.mft || {};
    const tt = s.protection.turbineTrip || {};
    if (mft.latched) return `cannot engage — MFT latched (${mft.cause || 'reset the MFT relays first'})`;
    if (tt.latched) return `cannot engage — turbine trip latched (${tt.cause || 'reset first'})`;
    if (s.meta && s.meta.mode === 'TRIPPED') return 'cannot engage — unit is tripped, reset the MFT relays first';
    return null;
  }

  /** Engage. Returns false, with `note` set, when the plant cannot take it. */
  enable() {
    if (this.active) return false;
    const blocked = this.blockReason(this.last);
    if (blocked) {
      this.state = 'OFF';
      this.note = blocked;
      this.paint();
      this.changed();
      return false;
    }
    this.active = true;
    this.state = 'STARTING';
    this.prevSpeed = null;
    this.lastCmdSimTime = -1e9;
    this.sfx('chime');
    this.paint();
    this.changed();
    return true;
  }

  disable(reason) {
    if (!this.active) return;
    this.active = false;
    this.state = 'OFF';
    // Hand the time acceleration back to whatever the operator had set.
    if (this.prevSpeed !== null) { this.setSpeed(this.prevSpeed); this.prevSpeed = null; }
    this.note = reason || 'disengaged';
    this.paint();
    this.changed();
  }

  /** @param {object} [s] the current snapshot, used to vet the engagement. */
  toggle(s) {
    if (s) this.last = s;
    if (this.active) { this.disable(); return false; }
    return this.enable();
  }

  /** Rate-limit outgoing commands to one every `everySec` seconds of sim time. */
  throttled(fn, simTime, everySec) {
    if (simTime - this.lastCmdSimTime < everySec) return;
    this.lastCmdSimTime = simTime;
    fn();
  }

  update(s) {
    if (!s) return;
    this.last = s;
    if (!this.active) return;

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
      // While the unit is coming down the autopilot must not quietly start it
      // again, and it must not sit there looking inert either — say what it is
      // waiting for.
      if (SHUTDOWN_PHASES.has(mode)) {
        this.state = 'WAITING';
        this.note = `waiting — shutdown in progress (${mode.replace(/_/g, ' ').toLowerCase()}), re-engage when cold`;
      } else {
        this.state = 'RUNNING_UP';
        this.note = `running up — ${mode.replace(/_/g, ' ').toLowerCase()}`;
      }
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
    const text = this.active ? `AUTOPILOT · ${this.note}` : `autopilot ${this.note}`;
    this.el.textContent = text;
    // Keep the readout to one line: a second line pushes the bottom bar onto
    // another row, which is how an operator loses sight of the button itself.
    this.el.style.whiteSpace = 'nowrap';
    this.el.style.overflow = 'hidden';
    this.el.style.textOverflow = 'ellipsis';
    this.el.title = text;
  }

  /** Target and ramp can be adjusted from the console: __tcsim.autopilot.target */
  setTarget(mw, ramp) {
    this.target = clamp(Number(mw) || this.target, 0, 660);
    if (ramp) this.ramp = clamp(Number(ramp) || this.ramp, 0.5, 12);
  }
}
