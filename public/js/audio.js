/**
 * audio.js — procedural plant sound.
 *
 * Every sound is synthesised with the Web Audio API; there are no audio files
 * to download, so the simulator stays fully offline and the soundtrack tracks
 * the model continuously instead of looping a recording:
 *
 *   furnace      low combustion rumble + crackle          ∝ fuel heat input
 *   fans         FD / ID / PA broadband + blade-pass tone ∝ fan speed
 *   mills        grinding noise, amplitude modulated      ∝ coal flow
 *   steam        hiss through the pipework and vent       ∝ steam / vent flow
 *   turbine      shaft frequency + harmonics + whistle    ∝ speed and load
 *   generator    100 Hz / 150 Hz hum + cooling hiss       ∝ load, after sync
 *   pumps        BFP whine, CEP / CW rumble               ∝ pumps running
 *   water        cooling tower and circulating water      ∝ CW flow
 *   coal         conveyor / crusher                       ∝ coal handling
 *   leak         high pressure steam jet                  ∝ tube leak
 *
 * One-shot events: alarm klaxon, trip horn, MFT steam dump, breaker close,
 * soot-blower jet, safety-valve lift and the tutorial chimes.
 *
 * Browsers only allow audio after a user gesture, so nothing is created until
 * enable() is called from a click.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;

export class PlantAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.7;
    this.nodes = {};
    this.prev = null;
    this.lastKlaxon = 0;
    this.lastSoot = { 0: 0, 1: 0 };
    this.safetyLifted = { 0: false, 1: false };
    this.loaded = false;
    try {
      const saved = JSON.parse(localStorage.getItem('tcsim.audio') || '{}');
      if (typeof saved.volume === 'number') this.volume = clamp(saved.volume, 0, 1);
      this.enabled = !!saved.enabled;      // re-arm after a page reload
    } catch { /* ignore */ }
    if (this.enabled) this.enable().catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   *  Lifecycle
   * ------------------------------------------------------------------ */
  async enable() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.enabled = true;
      this.persist();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.build();
    this.enabled = true;
    this.persist();
    return true;
  }

  disable() {
    this.enabled = false;
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    this.persist();
  }

  toggle() { return this.enabled ? (this.disable(), false) : (this.enable(), true); }

  setVolume(v) {
    this.volume = clamp(num(v, 0.7), 0, 1);
    if (this.master) this.ramp(this.master.gain, this.volume, 0.1);
    this.persist();
  }

  persist() {
    try {
      localStorage.setItem('tcsim.audio', JSON.stringify({ enabled: this.enabled, volume: this.volume }));
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   *  Graph construction
   * ------------------------------------------------------------------ */
  build() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 8;
    comp.attack.value = 0.005; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);
    this.master = master;

    // shared white-noise source
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // a little brown tilt
      d[i] = w * 0.7 + last * 3.2;
    }
    this.noiseBuf = buf;

    const bus = (name, level = 0) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(master);
      this.nodes[name] = g;
      return g;
    };

    const noise = (dest, type, freq, q, level) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = level;
      src.connect(f); f.connect(g); g.connect(dest);
      src.start();
      return { src, filter: f, gain: g };
    };
    this._noise = noise;

    const osc = (dest, type, freq, level) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = level;
      o.connect(g); g.connect(dest);
      o.start();
      return { osc: o, gain: g };
    };

    /* ---- furnace / combustion --------------------------------------- */
    const furnace = bus('furnace', 0);
    this.f1 = noise(furnace, 'lowpass', 110, 0.8, 0.9);         // rumble
    this.f2 = noise(furnace, 'bandpass', 320, 0.9, 0.25);       // roar
    this.f3 = noise(furnace, 'bandpass', 1500, 1.5, 0.05);      // crackle
    this.crackleLfo = osc(ctx.createGain(), 'sine', 5.5, 1);    // LFO (own gain)
    this.crackleLfo.gain.gain.value = 0.6;
    this.crackleLfo.osc.frequency.value = 5.5;
    const crackleDepth = ctx.createGain();
    crackleDepth.gain.value = 0.04;
    this.crackleLfo.gain.connect(crackleDepth);
    crackleDepth.connect(this.f3.gain.gain);

    /* ---- fans -------------------------------------------------------- */
    const fans = bus('fans', 0);
    this.fanAir = noise(fans, 'bandpass', 380, 0.55, 0.5);
    this.fanTone = osc(fans, 'sawtooth', 45, 0.05);
    this.fanToneFilt = ctx.createBiquadFilter();
    this.fanToneFilt.type = 'lowpass'; this.fanToneFilt.frequency.value = 260;
    this.fanTone.gain.disconnect(); this.fanTone.gain.connect(this.fanToneFilt);
    this.fanToneFilt.connect(fans);
    this.fanBlade = osc(fans, 'sine', 300, 0.02);

    /* ---- mills ------------------------------------------------------- */
    const mills = bus('mills', 0);
    this.millLow = noise(mills, 'bandpass', 190, 2.2, 0.5);
    this.millHigh = noise(mills, 'bandpass', 1300, 1.2, 0.18);
    this.millLfo = osc(ctx.createGain(), 'sine', 6.8, 1);
    this.millLfo.gain.gain.value = 0.35;
    const millDepth = ctx.createGain(); millDepth.gain.value = 0.25;
    this.millLfo.gain.connect(millDepth);
    millDepth.connect(this.millLow.gain.gain);

    /* ---- steam flow -------------------------------------------------- */
    const steam = bus('steam', 0);
    this.steamHiss = noise(steam, 'bandpass', 2600, 0.6, 0.35);
    this.steamRush = noise(steam, 'lowpass', 700, 0.7, 0.2);
    const vent = bus('vent', 0);
    this.ventJet = noise(vent, 'bandpass', 1700, 0.5, 0.55);
    this.ventRumble = noise(vent, 'lowpass', 260, 0.7, 0.5);
    const leak = bus('leak', 0);
    this.leakJet = noise(leak, 'bandpass', 3400, 0.8, 0.5);
    this.leakBody = noise(leak, 'lowpass', 900, 0.7, 0.3);

    /* ---- turbine ----------------------------------------------------- */
    const turb = bus('turbine', 0);
    this.t1 = osc(turb, 'sine', 50, 0.35);
    this.t2 = osc(turb, 'sine', 100, 0.16);
    this.t3 = osc(turb, 'sine', 150, 0.07);
    this.tBlade = osc(turb, 'triangle', 600, 0.035);
    this.tWind = noise(turb, 'bandpass', 900, 3.0, 0.12);

    /* ---- generator --------------------------------------------------- */
    const gen = bus('generator', 0);
    this.g1 = osc(gen, 'sine', 100, 0.28);
    this.g2 = osc(gen, 'sine', 150, 0.12);
    this.g3 = osc(gen, 'sine', 300, 0.04);
    this.genHiss = noise(gen, 'highpass', 4000, 0.7, 0.05);

    /* ---- pumps -------------------------------------------------------- */
    const pumps = bus('pumps', 0);
    this.bfpWhine = osc(pumps, 'sawtooth', 145, 0.02);
    this.bfpFilt = ctx.createBiquadFilter();
    this.bfpFilt.type = 'bandpass'; this.bfpFilt.frequency.value = 800; this.bfpFilt.Q.value = 1.2;
    this.bfpWhine.gain.disconnect(); this.bfpWhine.gain.connect(this.bfpFilt);
    this.bfpFilt.connect(pumps);
    this.pumpRumble = noise(pumps, 'lowpass', 180, 0.8, 0.5);

    /* ---- water / cooling tower --------------------------------------- */
    const water = bus('water', 0);
    this.tower = noise(water, 'lowpass', 520, 0.6, 0.5);
    this.cwHiss = noise(water, 'bandpass', 1600, 0.5, 0.12);

    /* ---- coal handling ------------------------------------------------ */
    const coal = bus('coal', 0);
    this.conveyor = noise(coal, 'lowpass', 220, 0.9, 0.5);
    this.crusher = noise(coal, 'bandpass', 150, 1.6, 0.4);

    this.loaded = true;
  }

  /* ------------------------------------------------------------------ *
   *  Helpers
   * ------------------------------------------------------------------ */
  ramp(param, v, tau = 0.3) {
    if (!this.ctx || !param) return;
    try { param.setTargetAtTime(v, this.ctx.currentTime, tau); } catch { param.value = v; }
  }

  sum(list, fn) { let a = 0; for (const x of list) a += num(fn(x), 0); return a; }

  /* ------------------------------------------------------------------ *
   *  Continuous update (called on every snapshot, ~5 Hz)
   * ------------------------------------------------------------------ */
  update(s) {
    if (!this.enabled || !this.ctx || !this.loaded || this.ctx.state !== 'running') {
      this.prev = s;
      return;
    }
    const ctx = this.ctx;
    const bs = s.boilers || [];
    const ins = bs.filter((b) => b.inService);
    const anyFired = bs.some((b) => b.qFuel > 2);

    /* ---- furnace: fuel heat input ------------------------------------ */
    const qFuel = this.sum(bs, (b) => b.qFuel);              // MW, ~1000 at MCR
    const firing = clamp(qFuel / 900, 0, 1.4);
    this.ramp(this.nodes.furnace.gain, anyFired ? 0.10 + 0.30 * firing : 0, 0.4);
    this.ramp(this.f3.gain.gain, 0.02 + 0.05 * firing, 0.4);
    this.ramp(this.f2.filter.frequency, 260 + 220 * firing, 0.5);

    /* ---- fans --------------------------------------------------------- */
    let fanLvl = 0;
    for (const b of bs) {
      const n = (b.fdRunning ? 1 : 0) + (b.idRunning ? 1 : 0) + (b.paRunning ? 1 : 0);
      if (!n) continue;
      const spd = ((b.fdRunning ? b.fdSpeed : 0) + (b.idRunning ? b.idSpeed : 0)
        + (b.paRunning ? b.paSpeed : 0)) / n;
      fanLvl += (spd / 100) / Math.max(1, bs.length);
    }
    fanLvl = clamp(fanLvl / Math.max(1, bs.length), 0, 1);
    this.ramp(this.nodes.fans.gain, 0.05 + 0.16 * fanLvl, 0.4);
    this.ramp(this.fanTone.osc.frequency, 34 + 46 * fanLvl, 0.5);
    this.ramp(this.fanBlade.osc.frequency, 180 + 260 * fanLvl, 0.5);
    this.ramp(this.fanAir.filter.frequency, 300 + 320 * fanLvl, 0.5);

    /* ---- mills -------------------------------------------------------- */
    const coal = this.sum(bs, (b) => b.totalCoal);            // t/h, ~300 at MCR
    const millFrac = clamp(coal / 300, 0, 1.2);
    this.ramp(this.nodes.mills.gain, 0.03 + 0.13 * millFrac, 0.4);
    this.ramp(this.millHigh.gain.gain, 0.05 + 0.16 * millFrac, 0.4);

    /* ---- steam flow --------------------------------------------------- */
    const msFlow = this.sum(bs, (b) => b.msFlow);             // t/h, ~2000 at MCR
    const flow = clamp(msFlow / 1900, 0, 1.3);
    this.ramp(this.nodes.steam.gain, 0.03 + 0.11 * flow, 0.5);
    this.ramp(this.steamHiss.filter.frequency, 1800 + 2200 * flow, 0.6);
    const ventFlow = this.sum(bs, (b) => b.ventFlow);
    this.ramp(this.nodes.vent.gain, clamp(ventFlow / 400, 0, 1) * 0.5, 0.4);
    const leak = this.sum(bs, (b) => b.tubeLeak);
    this.ramp(this.nodes.leak.gain, clamp(leak * 6, 0, 1) * 0.35, 0.5);

    /* ---- turbine ------------------------------------------------------ */
    const rpm = num(s.turbine && s.turbine.speed, 0);
    const f = Math.max(0.001, rpm / 60);                      // 50 Hz at 3000 rpm
    const loadFrac = clamp(num(s.plant && s.plant.grossMW, 0) / 660, 0, 1);
    const spinning = rpm > 5;
    const turbLvl = spinning ? 0.05 + 0.20 * Math.max(loadFrac, 0.25) : 0;
    this.ramp(this.nodes.turbine.gain, turbLvl, 0.5);
    this.ramp(this.t1.osc.frequency, f, 0.25);
    this.ramp(this.t2.osc.frequency, f * 2, 0.25);
    this.ramp(this.t3.osc.frequency, f * 3, 0.25);
    this.ramp(this.tBlade.osc.frequency, clamp(f * 12, 20, 4000), 0.3);
    this.ramp(this.tWind.filter.frequency, clamp(f * 18, 60, 6000), 0.4);

    /* ---- generator ---------------------------------------------------- */
    const sync = !!(s.turbine && s.turbine.breakerClosed);
    this.ramp(this.nodes.generator.gain, sync ? 0.035 + 0.075 * loadFrac : 0, 0.6);
    this.ramp(this.g1.osc.frequency, 100, 0.2);
    this.ramp(this.g2.osc.frequency, 150, 0.2);

    /* ---- pumps -------------------------------------------------------- */
    const bfpOn = (s.bop && s.bop.bfp || []).filter((p) => p.running).length;
    const cepOn = (s.bop && s.bop.cep || []).filter((p) => p.running).length;
    const cwOn = num(s.condenser && s.condenser.cwPumps, 0);
    const pumpLvl = clamp((bfpOn + cepOn + cwOn) / 6, 0, 1);
    this.ramp(this.nodes.pumps.gain, 0.02 + 0.10 * pumpLvl, 0.5);
    this.ramp(this.bfpWhine.osc.frequency, bfpOn ? 120 + 40 * pumpLvl : 120, 0.5);

    /* ---- water -------------------------------------------------------- */
    const cwFlow = num(s.condenser && s.condenser.cwFlow, 0);
    const cwFrac = clamp(cwFlow / 60000, 0, 1);
    this.ramp(this.nodes.water.gain, 0.015 + 0.06 * cwFrac, 0.6);

    /* ---- coal handling ------------------------------------------------ */
    const conv = s.bop && s.bop.conveyorRunning ? 1 : 0;
    const crush = s.bop && s.bop.crusherRunning ? 1 : 0;
    this.ramp(this.nodes.coal.gain, conv ? 0.05 : 0, 0.5);
    this.ramp(this.crusher.gain.gain, crush ? 0.35 : 0, 0.5);

    /* ---- event detection --------------------------------------------- */
    this.detectEvents(s, ctx);

    this.prev = s;
  }

  detectEvents(s, ctx) {
    const p = this.prev;
    if (!p) return;
    const now = ctx.currentTime;

    // new alarms → klaxon (rate limited)
    if (s.alarms && p.alarms) {
      const seen = new Set(p.alarms.map((a) => a.key));
      const fresh = s.alarms.filter((a) => !seen.has(a.key));
      const loud = fresh.filter((a) => a.prio === 'CRITICAL' || a.prio === 'HIGH');
      if (loud.length && now - this.lastKlaxon > 5) { this.lastKlaxon = now; this.klaxon(loud.length > 2 ? 3 : 2); }
      else if (fresh.length && now - this.lastKlaxon > 12) { this.lastKlaxon = now; this.blip(); }
    }

    // master fuel trip
    const mftNow = !!(s.protection && s.protection.mft && s.protection.mft.latched);
    const mftWas = !!(p.protection && p.protection.mft && p.protection.mft.latched);
    if (mftNow && !mftWas) this.horn(110, 1.6, 0.5);

    // turbine trip
    const ttNow = !!(s.protection && s.protection.turbineTrip && s.protection.turbineTrip.latched);
    const ttWas = !!(p.protection && p.protection.turbineTrip && p.protection.turbineTrip.latched);
    if (ttNow && !ttWas) this.horn(146, 1.2, 0.35);

    // generator breaker close
    if (s.turbine && s.turbine.breakerClosed && p.turbine && !p.turbine.breakerClosed) this.breaker();

    // soot blowing / safety valves
    (s.boilers || []).forEach((b, i) => {
      const was = p.boilers && p.boilers[i];
      if (b.sootblowing && was && !was.sootblowing && now - (this.lastSoot[i] || 0) > 8) {
        this.lastSoot[i] = now; this.jet(2.6, 0.35);
      }
      const lifted = b.drumPressure > 19.2 && b.msFlow > 5;
      if (lifted && !this.safetyLifted[i]) { this.jet(2.2, 0.45); }
      this.safetyLifted[i] = lifted;
      // mill fire → short harsh burst
      if (b.millFire && was && !was.millFire) this.horn(196, 0.8, 0.3);
    });
  }

  /* ------------------------------------------------------------------ *
   *  One-shot events
   * ------------------------------------------------------------------ */
  env(node, peak, attack, decay, when = 0) {
    const t = this.ctx.currentTime + when;
    const g = node.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return t + attack + decay;
  }

  /** Two-tone alarm klaxon, n cycles. */
  klaxon(cycles = 2) {
    if (!this.ready()) return;
    const ctx = this.ctx;
    for (let i = 0; i < cycles; i++) {
      const when = i * 0.62;
      [622, 830].forEach((f, k) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2200;
        o.connect(lp); lp.connect(g); g.connect(this.master);
        const t0 = ctx.currentTime + when + k * 0.28;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.10, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
        o.start(t0); o.stop(t0 + 0.3);
      });
    }
  }

  /** Short single acknowledgement blip. */
  blip() {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    o.connect(g); g.connect(this.master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.start(t); o.stop(t + 0.2);
  }

  /** Trip horn with a slow beat. */
  horn(freq = 110, dur = 1.4, level = 0.4) {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    const o2 = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    o2.type = 'sine'; o2.frequency.value = freq * 1.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(this.master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level * 0.28, t + 0.08);
    g.gain.setValueAtTime(level * 0.28, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }

  /** Steam jet: soot blowing, safety valve lift, blowdown. */
  jet(dur = 2, level = 0.3) {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.45;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 700;
    const g = ctx.createGain();
    src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(this.master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.12);
    g.gain.setValueAtTime(level, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t); src.stop(t + dur + 0.05);
  }

  /** Generator breaker closing: mechanical thunk plus transformer inrush. */
  breaker() {
    if (!this.ready()) return;
    const ctx = this.ctx;
    // thunk
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const g = ctx.createGain();
    src.connect(lp); lp.connect(g); g.connect(this.master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.start(t); src.stop(t + 0.55);
    // inrush hum
    const o = ctx.createOscillator(); const og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(48, t);
    o.frequency.exponentialRampToValueAtTime(100, t + 1.6);
    o.connect(og); og.connect(this.master);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.13, t + 0.25);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.start(t); o.stop(t + 2.3);
  }

  /** Named one-shot effects used by the UI (tutorial, buttons). */
  event(name) {
    if (!this.ready()) return;
    switch (name) {
      case 'step': this.chime([784, 1047]); break;
      case 'tutorial': this.chime([523, 659]); break;
      case 'done': this.chime([523, 659, 784, 1047], 0.11); break;
      case 'fault': this.blip(); break;
      case 'click': this.blip(); break;
      default: break;
    }
  }

  chime(freqs, step = 0.09) {
    const ctx = this.ctx;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      o.connect(g); g.connect(this.master);
      const t = ctx.currentTime + i * step;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.4);
    });
  }

  ready() {
    return !!(this.enabled && this.ctx && this.master && this.ctx.state === 'running');
  }
}
