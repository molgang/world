/*
 * lab-sim.js — JS-parity van knitengine.labsim (bewezen fysische modellen).
 * Dezelfde vergelijkingen als de Python-kern, zodat gedrag identiek is.
 * Gebruikt door de speelbare lab-/schuurruimte-game (lab.html).
 */
// Reëel hazard van (droog) staalslak vermalen = respirabel slakstof met mangaan +
// kristallijn silica (NIET V2O5, dat is een spoorbestanddeel).
export const OEL = { Mn_dust: 0.2, RCS: 0.1, resp_dust: 3.0,
  V2O5: 0.01, Cr6: 0.001, H2SO4_mist: 0.05, HAc_vapor: 25.0,
  H2S: 7.0, Cl2: 1.5, NH3: 14.0, SO2: 1.3, KOH_aerosol: 2.0 };
export const NOISE_ACTION = 80.0, NOISE_LIMIT = 87.0;

export class Thermo {
  constructor(m = 14, c = 4186, hA = 8, T = 20) { this.m = m; this.c = c; this.hA = hA; this.T = T; this.q = 0; }
  addHeat(w) { this.q += w; }
  step(dt, Tamb = 20) { this.T += (this.q - this.hA * (this.T - Tamb)) / (this.m * this.c) * dt; this.q = 0; return this.T; }
}
export class GasBox {
  constructor(V = 120, ach = 4, C = 0) { this.V = V; this.setVent(ach); this.C = C; this.src = 0; }
  setVent(ach) { this.ach = ach; this.Q = ach * this.V / 3600; }
  release(mgs) { this.src += mgs; }
  step(dt) { const k = this.Q / this.V; this.C = (this.C + this.src / this.V * dt) / (1 + k * dt); this.src = 0; return this.C; }
}
export class Acoustics {
  constructor() { this.sources = []; }
  add(x, z, Lw, hemi = true) { this.sources.push([x, z, Lw, hemi]); }
  levelAt(x, z) { let a = 0; for (const [sx, sz, Lw, hemi] of this.sources) {
    const r = Math.max(Math.hypot(x - sx, z - sz), 0.3); const Lp = Lw - 20 * Math.log10(r) - (hemi ? 8 : 11);
    a += 10 ** (Lp / 10); } return a > 0 ? 10 * Math.log10(a) : 0; }
}
export class PH {
  constructor(pKa = 4.76) { this.pKa = pKa; this.hA = 0; this.hac = 0; this.ac = 0; this.vol = 14; }
  addStrong(m) { this.hA += m; } addAcetic(hac, ac = 0) { this.hac += hac; this.ac += ac; }
  neutralize(m) { this.hA = Math.max(0, this.hA - m); }
  value() {
    if (this.hA > 1e-9) return Math.max(0, -Math.log10(this.hA / Math.max(this.vol, 1e-6)));
    if (this.hac > 1e-9 && this.ac > 1e-9) return this.pKa + Math.log10(this.ac / this.hac);
    if (this.hac > 1e-9) return 0.5 * (this.pKa - Math.log10(this.hac / Math.max(this.vol, 1e-6)));
    return 7.0;
  }
}
export class Weather {
  constructor() { this.base = 12; this.amp = 6; this.state = 'clear'; this.h = 12; }
  step(dt) { this.h = (this.h + dt / 3600) % 24; }
  outdoor() { const t = this.base + this.amp * Math.sin((this.h - 9) / 24 * 2 * Math.PI);
    return t + ({ clear: 0, rain: -3, cold: -8, heat: 9 }[this.state] || 0); }
  windBonus() { return ({ clear: 1, rain: 2, cold: 1.5, heat: 0.5 }[this.state] || 1); }
}
export class PPE {
  constructor() { this.mask = false; this.ears = false; this.arms = false; this.gasDose = 0; this.noiseDose = 0; this.APF = 50; this.NRR = 27; }
  inhaled(C, oel) { const eff = C / (this.mask ? this.APF : 1); return oel > 0 ? eff / oel : 0; }
  step(dt, gfracs, db) {
    this.gasDose += gfracs.reduce((a, b) => a + b, 0) * dt / (8 * 3600);
    const L = db - (this.ears ? this.NRR : 0);
    if (L > 80) { const allowed = 8 * 3600 / (2 ** ((L - 85) / 3)); this.noiseDose += dt / Math.max(allowed, 1); }
  }
  warnings(gfracs, db, hot, corrosive) {
    const w = []; const g = gfracs.reduce((a, b) => a + b, 0);
    if (g > 1 && !this.mask) w.push('☣ Toxisch gas boven grenswaarde — zet een gasmasker op!');
    if (db >= NOISE_ACTION && !this.ears) w.push(`🔊 ${db.toFixed(0)} dB(A) — gehoorbescherming op!`);
    if ((hot || corrosive) && !this.arms) w.push('🧤 Heet/bijtend station — draag armbescherming!');
    return w;
  }
}
export class Robot {
  constructor(x = 0, z = 0) { this.x = x; this.z = z; this.speed = 1.2; this.battC = 25; this.soc = 1; this.loadW = 0; this.task = null; this.queue = []; this.Rint = 0.05; this.HA = 1.2; }
  enqueue(x, z, kind = 'measure') { this.queue.push([x, z, kind]); }
  step(dt, Tamb, onMeasure) {
    if (!this.task && this.queue.length) this.task = this.queue.shift();
    this.loadW = 6;
    if (this.task) { const [tx, tz, kind] = this.task; const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
      if (d > 0.05) { const s = Math.min(this.speed * dt, d); this.x += dx / d * s; this.z += dz / d * s;
        const I = 12; this.loadW = I * I * this.Rint + 20; this.soc = Math.max(0, this.soc - 0.00002 * dt * I); }
      else { if (onMeasure) onMeasure(kind, this.x, this.z); this.task = null; } }
    this.battC += (this.loadW - this.HA * (this.battC - Tamb)) / (2 * 900) * dt;
    return this.battC;
  }
}

/* Kogel-/schuurmolen. Nat/droog volgt uit het WATERPEIL dat de speler fysiek
   toevoegt (kraan+slang of emmer). Droog: Mn-stof + ~118 dB. Nat: stofvrij, ~108 dB,
   water -> pompbare slurry (moet bijgevuld worden). */
export class Mill {
  constructor() { this.on = false; this.species = 'Mn_dust'; this.dryRelease = 0.20;
    this.capacity = 30; this.minWet = 3; this.slurryRate = 0.05; this.water = 0; this.slurry = 0; }
  addWater(l) { const a = Math.max(0, Math.min(l, this.capacity - this.water)); this.water += a; return a; }
  isWet() { return this.water >= this.minWet; }
  Lw() { return !this.on ? 0 : (this.isWet() ? 108 : 118); }
  step(dt, room) {
    const s = room.ac.sources[0]; s[2] = this.on ? this.Lw() : 60;
    if (this.on) { if (this.isWet()) { const use = Math.min(this.water, this.slurryRate * dt); this.water -= use; this.slurry += use; }
      else room.gas.release(this.dryRelease); }
  }
}
const grindRoom = () => { const ac = new Acoustics(); ac.add(0, 0, 60);
  return { thermo: new Thermo(200, 500, 25, 18), gas: new GasBox(90, 8), ac, ph: new PH() }; };
const wetLab = () => { const ac = new Acoustics(); ac.add(1.5, 0, 92);
  return { thermo: new Thermo(14, 4186, 8, 20), gas: new GasBox(150, 10), ac, ph: new PH() }; };

export class LabWorld {
  constructor() { this.time = 0; this.weather = new Weather(); this.rooms = { grind: grindRoom(), lab: wetLab() };
    this.robot = new Robot(-2, 1); this.ppe = new PPE(); this.player = { x: 0, z: 0, room: 'lab' };
    this.mill = new Mill(); this.speciesByRoom = { grind: 'Mn_dust', lab: 'HAc_vapor' }; }
  species() { return this.speciesByRoom[this.player.room] || 'HAc_vapor'; }
  setPlayer(x, z, room) { this.player.x = x; this.player.z = z; if (room) this.player.room = room; }
  step(dt, onMeasure) {
    this.time += dt; this.weather.step(dt); const Tamb = this.weather.outdoor();
    this.mill.step(dt, this.rooms.grind);                 // molen drijft geluid + (droog) stof
    const r = this.rooms[this.player.room];
    r.thermo.step(dt, Tamb); r.gas.step(dt);
    this.robot.step(dt, Tamb, onMeasure); r.thermo.addHeat(this.robot.loadW * 0.5);
    const db = r.ac.levelAt(this.player.x, this.player.z);
    const gfr = [this.ppe.inhaled(r.gas.C, OEL[this.species()] || 1)];
    this.ppe.step(dt, gfr, db);
    return this.snapshot();
  }
  snapshot() {
    const r = this.rooms[this.player.room];
    const db = r.ac.levelAt(this.player.x, this.player.z);
    const gfr = [this.ppe.inhaled(r.gas.C, OEL[this.species()] || 1)];
    const hot = r.thermo.T > 45, corr = r.ph.value() < 4;
    return { time: this.time, room: this.player.room,
      weather: { state: this.weather.state, hour: this.weather.h, outdoor: this.weather.outdoor() },
      temp: r.thermo.T, ph: r.ph.value(), gas: r.gas.C, species: this.species(),
      mill: { on: this.mill.on, wet: this.mill.isWet(), water: this.mill.water, slurry: this.mill.slurry },
      gasFrac: gfr.reduce((a, b) => a + b, 0), db,
      robot: { x: this.robot.x, z: this.robot.z, battC: this.robot.battC, soc: this.robot.soc,
        busy: !!(this.robot.task || this.robot.queue.length) },
      ppe: { mask: this.ppe.mask, ears: this.ppe.ears, arms: this.ppe.arms, gasDose: this.ppe.gasDose, noiseDose: this.ppe.noiseDose },
      warnings: this.ppe.warnings(gfr, db, hot, corr) };
  }
}
