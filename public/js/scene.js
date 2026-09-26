/**
 * scene.js — 3D model of the twin-boiler coal-fired power station.
 *
 * Everything is generated procedurally so the whole plant ships as a few
 * hundred kilobytes and needs no external assets.  The scene exposes a
 * `bind(snapshot)` method which drives the animation from the live plant data.
 */
import * as THREE from '/vendor/three/three.module.js';
import { OrbitControls } from '/vendor/three/addons/controls/OrbitControls.js';

const C = {
  sky: 0x0b1220,
  ground: 0x1a1f26,
  concrete: 0x6b7075,
  steel: 0x8b9198,
  boiler: 0x9aa3ab,
  boilerDark: 0x4a525a,
  cladding: 0xb9c0c6,
  pipe: 0xc9ced3,
  hotPipe: 0xd08b5a,
  steam: 0xdfe9f2,
  fire: 0xff7b22,
  coal: 0x2c2c30,
  water: 0x2f6f9e,
  green: 0x3d8f5b,
  red: 0xc0392b,
  amber: 0xe0a52a,
  tower: 0xa8a8a2,
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, seg = 24, open = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function pipeRun(points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, Math.max(24, points.length * 8), radius, 10, false);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** Hyperbolic natural-draft cooling tower shell (lathe profile). */
function coolingTower(height, baseR, throatR, topR, mat) {
  const pts = [];
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = t * height;
    // classic hyperboloid of one sheet between the throat and the top
    const r = throatR + (baseR - throatR) * Math.pow(1 - t, 2.1)
      + (topR - throatR) * Math.pow(Math.max(0, (t - 0.78) / 0.22), 1.7);
    pts.push(new THREE.Vector2(Math.max(0.6, r), y));
  }
  const geo = new THREE.LatheGeometry(pts, 48);
  const m = new THREE.Mesh(geo, mat);
  m.material = mat.clone();
  m.material.side = THREE.DoubleSide;
  return m;
}

export class PlantScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.animated = {};
    this.build();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.animate();
  }

  /* ------------------------------------------------------------------ */
  build() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.sky);
    scene.fog = new THREE.Fog(C.sky, 260, 900);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 3000);
    camera.position.set(150, 78, 190);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 26, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 45;
    controls.maxDistance = 700;
    this.controls = controls;

    /* --------------------------- lighting --------------------------- */
    scene.add(new THREE.HemisphereLight(0x9db4d0, 0x20262e, 0.75));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.15);
    sun.position.set(-160, 210, 140);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 240;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 700;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x5577aa, 0.35);
    fill.position.set(140, 90, -160);
    scene.add(fill);

    /* ---------------------------- ground ---------------------------- */
    const groundMat = new THREE.MeshStandardMaterial({ color: C.ground, roughness: 0.97, metalness: 0.0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(1200, 60, 0x2a3138, 0x22282e);
    grid.position.y = 0.02;
    scene.add(grid);

    this.mats = {
      concrete: new THREE.MeshStandardMaterial({ color: C.concrete, roughness: 0.9 }),
      steel: new THREE.MeshStandardMaterial({ color: C.steel, roughness: 0.5, metalness: 0.75 }),
      boiler: new THREE.MeshStandardMaterial({ color: C.boiler, roughness: 0.62, metalness: 0.35 }),
      dark: new THREE.MeshStandardMaterial({ color: C.boilerDark, roughness: 0.8, metalness: 0.25 }),
      clad: new THREE.MeshStandardMaterial({ color: C.cladding, roughness: 0.55, metalness: 0.45 }),
      pipe: new THREE.MeshStandardMaterial({ color: C.pipe, roughness: 0.4, metalness: 0.85 }),
      hot: new THREE.MeshStandardMaterial({ color: C.hotPipe, roughness: 0.45, metalness: 0.7 }),
      coal: new THREE.MeshStandardMaterial({ color: C.coal, roughness: 1.0 }),
      water: new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.85 }),
      tower: new THREE.MeshStandardMaterial({ color: C.tower, roughness: 0.95, side: THREE.DoubleSide }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fd6ff, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.35 }),
      fire: new THREE.MeshBasicMaterial({ color: C.fire, transparent: true, opacity: 0.0 }),
    };

    this.buildCoalHandling();
    this.buildBoilers();
    this.buildTurbineHall();
    this.buildCondenserAndTower();
    this.buildFlueGasPath();
    this.buildPipework();
    this.buildLabels();
  }

  /* ------------------------- coal handling -------------------------- */
  buildCoalHandling() {
    const g = new THREE.Group();
    g.position.set(-150, 0, 0);

    // stockpile
    const pile = new THREE.Mesh(new THREE.ConeGeometry(26, 13, 32), this.mats.coal);
    pile.position.set(-30, 6.5, 0);
    pile.castShadow = true;
    g.add(pile);
    const pile2 = pile.clone(); pile2.position.set(-30, 5, 26); pile2.scale.set(0.8, 0.8, 0.8); g.add(pile2);

    // reclaim tunnel + conveyor gantries
    const gantryMat = this.mats.steel;
    const beltMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.95 });
    for (let i = 0; i < 2; i++) {
      const z = -14 + i * 28;
      const len = i === 0 ? 118 : 62;
      const ang = i === 0 ? 0 : 0.30;
      const cv = new THREE.Group();
      const frame = box(len, 1.6, 5, gantryMat, 0, 0, 0);
      cv.add(frame);
      const belt = box(len - 2, 0.4, 3.4, beltMat, 0, 1.1, 0);
      cv.add(belt);
      this.animated[`belt${i}`] = belt;
      for (let k = 0; k < len / 10; k++) {
        const leg = box(1.2, 14, 1.2, gantryMat, -len / 2 + 5 + k * 10, -7, 0);
        cv.add(leg);
      }
      cv.position.set(i === 0 ? 45 : 108, 15 + i * 9, z);
      cv.rotation.z = ang;
      g.add(cv);
    }

    // crusher house + transfer tower
    const crusher = box(16, 22, 16, this.mats.concrete, 96, 11, 0); g.add(crusher);
    const transfer = box(12, 58, 12, this.mats.concrete, 132, 29, 0); g.add(transfer);
    this.animated.crusherLight = this.addLamp(96, 24, 9, 0x33ff66);

    this.scene.add(g);
    this.coalGroup = g;
  }

  addLamp(x, y, z, color) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 12), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    this.scene.add(m);
    return m;
  }

  /* ---------------------------- boilers ---------------------------- */
  buildBoilers() {
    this.boilers = [];
    for (let i = 0; i < 2; i++) {
      const z = i === 0 ? -52 : 52;
      const g = new THREE.Group();
      g.position.set(0, 0, z);

      // boiler house steel frame + cladding
      const frame = new THREE.Group();
      const W = 34, D = 40, H = 74;
      const shellMat = this.mats.clad;
      const shell = box(W, H, D, shellMat, 0, H / 2, 0);
      shell.material = shellMat.clone();
      shell.material.transparent = true;
      shell.material.opacity = 0.30;
      frame.add(shell);
      // corner columns
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        frame.add(box(1.6, H, 1.6, this.mats.steel, sx * W / 2, H / 2, sz * D / 2));
      }
      for (let k = 1; k < 7; k++) {
        frame.add(box(W + 1, 0.8, 0.8, this.mats.steel, 0, k * H / 7, -D / 2));
        frame.add(box(W + 1, 0.8, 0.8, this.mats.steel, 0, k * H / 7, D / 2));
        frame.add(box(0.8, 0.8, D + 1, this.mats.steel, -W / 2, k * H / 7, 0));
        frame.add(box(0.8, 0.8, D + 1, this.mats.steel, W / 2, k * H / 7, 0));
      }
      g.add(frame);

      // furnace (visible through the open frame) — glowing volume
      const furnace = box(24, 34, 26, this.mats.dark, 0, 24, 0);
      g.add(furnace);
      const fireMat = new THREE.MeshBasicMaterial({ color: C.fire, transparent: true, opacity: 0 });
      const fireVol = box(22, 30, 24, fireMat, 0, 24, 0);
      g.add(fireVol);
      this.animated[`fire${i}`] = fireVol;

      // radiant platen superheater (hanging platens inside the furnace)
      const plat = new THREE.Group();
      for (let k = 0; k < 8; k++) {
        const p = box(0.5, 16, 20, this.mats.steel, -9 + k * 2.6, 46, 0);
        plat.add(p);
      }
      g.add(plat);

      // steam drum (horizontal, high up at the front)
      const drum = cyl(3.2, 3.2, 22, this.mats.steel, 28);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, 66, 22);
      g.add(drum);
      this.animated[`drum${i}`] = drum;
      // water level indicator inside the drum
      const waterMat = this.mats.water.clone();
      const drumWater = cyl(2.9, 2.9, 21.4, waterMat, 28);
      drumWater.rotation.z = Math.PI / 2;
      drumWater.position.set(0, 66, 22);
      g.add(drumWater);
      this.animated[`drumWater${i}`] = drumWater;

      // downcomers + waterwall risers
      for (const sx of [-1, 1]) {
        g.add(pipeRun([[sx * 11, 63, 22], [sx * 13, 44, 16], [sx * 13, 22, 10], [sx * 13, 8, 4]], 0.7, this.mats.pipe));
      }

      // convective pass (back pass) with the SH / RH / econ bundles
      const backPass = box(20, 40, 14, this.mats.dark, -6, 30, -18);
      g.add(backPass);
      const bundles = [];
      for (let k = 0; k < 3; k++) {
        const b = box(18, 6, 12, this.mats.pipe, -6, 18 + k * 12, -18);
        g.add(b); bundles.push(b);
      }
      this.animated[`bundles${i}`] = bundles;

      // mills (4, on the firing floor at the front)
      const mills = [];
      for (let k = 0; k < 4; k++) {
        const mx = -13.5 + k * 9;
        const grp = new THREE.Group();
        grp.add(cyl(2.4, 2.4, 5.4, this.mats.steel, 20));
        grp.add(cyl(3.0, 3.0, 1.2, this.mats.dark, 20));
        const rotor = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.25, 8, 20), this.mats.steel);
        rotor.rotation.x = Math.PI / 2; rotor.position.y = 3.1;
        grp.add(rotor);
        grp.position.set(mx, 4, 24);
        g.add(grp);
        mills.push({ grp, rotor });
      }
      this.animated[`mills${i}`] = mills;

      // PA / FD fans with rotating hubs
      const fans = [];
      const fanSpec = [[-24, 6, 34, 'fd'], [-24, 6, 40, 'pa'], [24, 6, 34, 'id']];
      for (const [fx, fy, fz, tag] of fanSpec) {
        const housing = cyl(3.4, 3.4, 2.4, this.mats.steel, 22);
        housing.rotation.x = Math.PI / 2;
        housing.position.set(fx, fy, fz);
        g.add(housing);
        const hub = new THREE.Group();
        for (let b = 0; b < 6; b++) {
          const blade = box(0.3, 5.6, 1.1, this.mats.pipe, 0, 0, 0);
          blade.rotation.z = (b / 6) * Math.PI * 2;
          blade.position.set(Math.sin((b / 6) * Math.PI * 2) * 1.5, Math.cos((b / 6) * Math.PI * 2) * 1.5, 0);
          hub.add(blade);
        }
        hub.position.set(fx, fy, fz - 1.4);
        g.add(hub);
        fans.push({ hub, tag });
      }
      this.animated[`fans${i}`] = fans;

      // coal bunkers feeding the mills
      for (let k = 0; k < 4; k++) {
        const bx = -13.5 + k * 9;
        const bunker = cyl(4.2, 2.2, 10, this.mats.steel, 16);
        bunker.position.set(bx, 16, 26);
        g.add(bunker);
        const coalIn = cyl(3.9, 2.0, 1.0, this.mats.coal, 16);
        coalIn.position.set(bx, 16, 26);
        g.add(coalIn);
        this.animated[`bunker${i}_${k}`] = coalIn;
      }

      // burners + oil guns on the furnace walls
      for (let el = 0; el < 4; el++) {
        for (const sx of [-1, 1]) {
          const flame = new THREE.Mesh(
            new THREE.ConeGeometry(1.0, 5.5, 10),
            new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0 }));
          flame.position.set(sx * 11.5, 12 + el * 9, 0);
          flame.rotation.z = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
          g.add(flame);
          this.animated[`burner${i}_${el}_${sx > 0 ? 1 : 0}`] = flame;
        }
      }

      this.scene.add(g);
      this.boilers.push(g);
    }
  }

  /* -------------------------- turbine hall -------------------------- */
  buildTurbineHall() {
    const g = new THREE.Group();
    g.position.set(78, 0, 0);

    // hall building (open-sided so the machine is visible)
    const hall = new THREE.Group();
    const hallMat = this.mats.clad.clone();
    hallMat.transparent = true; hallMat.opacity = 0.22;
    const roof = box(70, 1.5, 46, this.mats.steel, 0, 30, 0); hall.add(roof);
    const wall = box(70, 28, 1.2, hallMat, 0, 15, -23); hall.add(wall);
    const wall2 = box(70, 28, 1.2, hallMat, 0, 15, 23); hall.add(wall2);
    const endWall = box(1.2, 28, 46, hallMat, 35, 15, 0); hall.add(endWall);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      hall.add(box(1.4, 30, 1.4, this.mats.steel, sx * 35, 15, sz * 23));
    }
    // crane rail + hook
    const rail = box(70, 1.0, 1.0, this.mats.steel, 0, 28.5, 0); hall.add(rail);
    const trolley = box(5, 2, 4, this.mats.steel, -10, 27.2, 0); hall.add(trolley);
    g.add(hall);

    // plinth
    g.add(box(64, 6, 26, this.mats.concrete, 0, 3, 0));

    // shaft
    const shaft = cyl(0.75, 0.75, 56, this.mats.pipe, 18);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.set(0, 15, 0);
    g.add(shaft);
    this.animated.shaft = shaft;

    // HP / IP / LP casings
    const mkCasing = (r1, r2, len, x) => {
      const m = cyl(r1, r2, len, this.mats.clad, 26);
      m.rotation.z = Math.PI / 2;
      m.position.set(x, 15, 0);
      return m;
    };
    const hp = mkCasing(2.6, 3.4, 11, -22); g.add(hp);
    const ip = mkCasing(3.4, 4.6, 13, -7); g.add(ip);
    const lp1 = mkCasing(4.6, 7.2, 15, 8); g.add(lp1);
    const lp2 = mkCasing(4.6, 7.2, 15, 22); g.add(lp2);
    this.animated.casings = [hp, ip, lp1, lp2];

    // rotating discs inside the casings (visible hint of the blading)
    this.animated.bladeDiscs = [];
    const discMat = new THREE.MeshStandardMaterial({ color: 0xd9dde1, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide });
    for (const [cx, r] of [[-22, 2.9], [-7, 4.0], [8, 5.9], [22, 5.9]]) {
      for (let k = -2; k <= 2; k++) {
        const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.35, 28, 1, true), discMat);
        d.rotation.z = Math.PI / 2;
        d.position.set(cx + k * 2.4, 15, 0);
        g.add(d);
        this.animated.bladeDiscs.push(d);
      }
    }

    // generator + exciter
    const genShell = cyl(6.2, 6.2, 18, this.mats.steel, 30);
    genShell.rotation.z = Math.PI / 2;
    genShell.position.set(40, 15, 0);
    g.add(genShell);
    const genBody = cyl(5.6, 5.6, 17, new THREE.MeshStandardMaterial({ color: 0x5d6975, roughness: 0.5, metalness: 0.7 }), 30);
    genBody.rotation.z = Math.PI / 2;
    genBody.position.set(40, 15, 0);
    g.add(genBody);
    this.animated.generator = genShell;
    // busbars / terminal bushings
    for (let k = 0; k < 3; k++) {
      const bush = cyl(0.5, 0.5, 6, new THREE.MeshStandardMaterial({ color: 0xd8d0b8, roughness: 0.4 }), 12);
      bush.position.set(44, 22, -4 + k * 4);
      g.add(bush);
    }
    // exciter
    const exc = cyl(2.2, 2.2, 4, this.mats.steel, 18);
    exc.rotation.z = Math.PI / 2; exc.position.set(52, 15, 0);
    g.add(exc);

    // turning gear + jacking-oil skid
    const tg = box(3, 2.4, 3, this.mats.dark, 56, 9, 4); g.add(tg);
    this.animated.turningGear = tg;

    // bearings with vibration lamps
    this.animated.bearings = [];
    for (const bx of [-27, -13, 1, 15, 30]) {
      const b = box(2.2, 4.4, 3.4, this.mats.steel, bx, 12.4, 0);
      g.add(b);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0x33dd66 }));
      lamp.position.set(bx, 15.6, 2.2);
      g.add(lamp);
      this.animated.bearings.push(lamp);
    }

    this.scene.add(g);
    this.turbineHall = g;
  }

  /* -------------------- condenser + cooling tower ------------------- */
  buildCondenserAndTower() {
    const g = new THREE.Group();
    g.position.set(78, 0, 0);

    // condenser throat + shell beneath the LP exhausts
    for (const cx of [8, 22]) {
      const throat = box(9, 7, 18, this.mats.steel, cx, 3.5, 0);
      g.add(throat);
    }
    const condShell = cyl(6.5, 6.5, 34, this.mats.clad, 26);
    condShell.rotation.z = Math.PI / 2;
    condShell.position.set(15, -4.5, 0);
    g.add(condShell);
    const hotwell = cyl(2.0, 2.0, 30, this.mats.water, 20);
    hotwell.rotation.z = Math.PI / 2;
    hotwell.position.set(15, -9.5, 0);
    g.add(hotwell);
    this.animated.hotwell = hotwell;
    this.scene.add(g);

    // circulating-water pumps
    for (let k = 0; k < 2; k++) {
      const p = new THREE.Group();
      const motor = cyl(1.8, 1.8, 3.4, this.mats.steel, 16); p.add(motor);
      const pump = new THREE.Mesh(new THREE.SphereGeometry(2.1, 16, 12), this.mats.dark); pump.position.y = -2.4; p.add(pump);
      p.position.set(30, 4, -18 + k * 8);
      this.scene.add(p);
      this.animated[`cwp${k}`] = motor;
    }

    // CW pipework to the cooling tower
    this.scene.add(pipeRun([[108, 2, -14], [140, 2, -30], [150, 2, -46]], 1.7, this.mats.pipe));
    this.scene.add(pipeRun([[108, 2, 14], [140, 2, 30], [150, 2, 46]], 1.7, this.mats.pipe));

    // hyperbolic cooling tower
    const tower = coolingTower(115, 44, 26, 30, this.mats.tower);
    tower.position.set(168, 0, 0);
    this.scene.add(tower);
    // basin + fill deck
    const basin = cyl(46, 46, 3, this.mats.concrete, 48);
    basin.position.set(168, 1.5, 0);
    this.scene.add(basin);
    const water = cyl(44, 44, 1.2, this.mats.water, 48);
    water.position.set(168, 3.2, 0);
    this.scene.add(water);
    // internal V-columns
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const col = cyl(0.5, 0.5, 9, this.mats.concrete, 8);
      col.position.set(168 + Math.cos(a) * 41, 4.5, Math.sin(a) * 41);
      this.scene.add(col);
    }

    // plume (a stack of soft discs that grow and fade)
    this.plume = new THREE.Group();
    this.plume.position.set(168, 115, 0);
    for (let k = 0; k < 14; k++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(8 + k * 2.6, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xe8eef4, transparent: true, opacity: 0 }));
      m.position.y = k * 6;
      this.plume.add(m);
    }
    this.scene.add(this.plume);

    // switchyard: transformer + gantry
    const yard = new THREE.Group();
    yard.position.set(78, 0, -70);
    const tx = box(12, 10, 9, this.mats.steel, 0, 5, 0); yard.add(tx);
    for (let k = 0; k < 3; k++) {
      const bush = cyl(0.6, 0.6, 6, new THREE.MeshStandardMaterial({ color: 0xd8d0b8 }), 12);
      bush.position.set(-4 + k * 4, 13, 0); yard.add(bush);
    }
    const line = box(0.6, 26, 0.6, this.mats.steel, 20, 13, 0); yard.add(line);
    const line2 = box(0.6, 26, 0.6, this.mats.steel, 20, 13, 6); yard.add(line2);
    this.animated.energised = [];
    for (let k = 0; k < 2; k++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 10), new THREE.MeshBasicMaterial({ color: 0x333333 }));
      lamp.position.set(-4 + k * 8, 16.5, 0);
      yard.add(lamp);
      this.animated.energised.push(lamp);
    }
    this.scene.add(yard);
  }

  /* ------------------------ flue-gas cleaning ----------------------- */
  buildFlueGasPath() {
    const g = new THREE.Group();
    // ESP casings per boiler
    for (let i = 0; i < 2; i++) {
      const z = i === 0 ? -52 : 52;
      const esp = box(26, 16, 22, this.mats.clad, -46, 9, z);
      g.add(esp);
      for (let k = 0; k < 4; k++) g.add(box(0.6, 13, 20, this.mats.steel, -42 + k * 2.4, 9, z));
      // ash hoppers
      for (let k = 0; k < 4; k++) {
        const h = cyl(3.4, 1.2, 5, this.mats.dark, 12);
        h.position.set(-52 + k * 4.6, 0.5, z);
        g.add(h);
      }
      // FGD absorber tower
      const fgd = cyl(8, 8.6, 34, this.mats.clad, 28);
      fgd.position.set(-84, 17, z);
      g.add(fgd);
      const fgdTop = cyl(5, 8, 6, this.mats.clad, 28);
      fgdTop.position.set(-84, 37, z);
      g.add(fgdTop);
      // stack
      const stack = cyl(6.4, 9.5, 122, this.mats.concrete, 30);
      stack.position.set(-116, 61, z);
      g.add(stack);
      const stackTop = cyl(6.4, 6.4, 3, new THREE.MeshStandardMaterial({ color: 0x8c3b2f }), 30);
      stackTop.position.set(-116, 123, z);
      g.add(stackTop);
      // aviation light
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
      light.position.set(-116, 125, z);
      g.add(light);
      this.animated[`stackLight${i}`] = light;

      // plume from the stack
      const plume = new THREE.Group();
      plume.position.set(-116, 126, z);
      for (let k = 0; k < 10; k++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(5 + k * 2.2, 12, 9),
          new THREE.MeshBasicMaterial({ color: 0xcfd6dd, transparent: true, opacity: 0 }));
        m.position.set(-k * 3, k * 5, 0);
        plume.add(m);
      }
      g.add(plume);
      this.animated[`stackPlume${i}`] = plume;
    }

    // gypsum / ash silos
    for (let k = 0; k < 3; k++) {
      const silo = cyl(5, 5, 18, this.mats.concrete, 20);
      silo.position.set(-140, 9, -40 + k * 40);
      g.add(silo);
      const cone = cyl(5, 1.4, 5, this.mats.concrete, 20);
      cone.position.set(-140, 0.5, -40 + k * 40);
      g.add(cone);
    }

    // ducting from the boiler to the ESP
    for (let i = 0; i < 2; i++) {
      const z = i === 0 ? -52 : 52;
      this.scene.add(pipeRun([[-18, 30, z], [-32, 26, z], [-40, 14, z]], 3.4, this.mats.dark));
      this.scene.add(pipeRun([[-58, 10, z], [-70, 12, z], [-80, 18, z]], 3.2, this.mats.dark));
      this.scene.add(pipeRun([[-88, 30, z], [-100, 20, z], [-110, 10, z]], 3.6, this.mats.dark));
    }
    this.scene.add(g);
    this.fgdGroup = g;
  }

  /* --------------------------- pipework ----------------------------- */
  buildPipework() {
    const hot = this.mats.hot;
    // main steam headers from both boilers to the turbine
    for (const z of [-52, 52]) {
      this.scene.add(pipeRun([[6, 66, z], [26, 60, z * 0.8], [44, 46, z * 0.5], [56, 30, z * 0.22], [62, 16, 2], [60, 15.5, 0]], 1.3, hot));
    }
    // hot reheat
    for (const z of [-52, 52]) {
      this.scene.add(pipeRun([[6, 52, z], [26, 48, z * 0.8], [46, 34, z * 0.5], [58, 20, z * 0.2], [57, 16, 0]], 1.15, hot));
    }
    // cold reheat (from the HP exhaust back to the boiler)
    for (const z of [-52, 52]) {
      this.scene.add(pipeRun([[4, 44, z], [22, 40, z * 0.85], [40, 30, z * 0.55], [50, 22, z * 0.3], [30, 18, z * 0.4], [10, 30, z]], 1.0, this.mats.pipe));
    }
    // feedwater from the deaerator / BFPs to the economisers
    for (const z of [-52, 52]) {
      this.scene.add(pipeRun([[34, 8, z * 0.5], [20, 10, z * 0.7], [8, 24, z]], 0.9, this.mats.pipe));
    }
    // condensate from the condenser to the deaerator
    this.scene.add(pipeRun([[78, -8, 0], [82, 4, -14], [86, 12, -26]], 0.8, this.mats.pipe));

    // deaerator + feedwater pumps in the turbine hall
    const g = new THREE.Group();
    g.position.set(78, 0, -34);
    const dea = cyl(3.6, 3.6, 20, this.mats.steel, 24);
    dea.rotation.z = Math.PI / 2;
    dea.position.set(0, 22, 0);
    g.add(dea);
    for (let k = 0; k < 4; k++) g.add(box(0.7, 10, 0.7, this.mats.steel, -14 + k * 9, 17, 0));
    for (const sx of [-1, 1]) {
      const bfp = new THREE.Group();
      const motor = cyl(1.9, 1.9, 4.2, this.mats.steel, 16); bfp.add(motor);
      const pump = cyl(1.2, 1.6, 2.6, this.mats.dark, 16); pump.position.y = -3; bfp.add(pump);
      bfp.position.set(sx * 10, 5, 6);
      g.add(bfp);
      this.animated[`bfp${sx > 0 ? 1 : 0}`] = motor;
    }
    this.scene.add(g);
  }

  /* ---------------------------- labels ------------------------------ */
  buildLabels() {
    const make = (text, x, y, z, scale = 1) => {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 128;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = 'rgba(10,16,24,0.82)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = 'rgba(120,200,255,0.8)';
      ctx.lineWidth = 4; ctx.strokeRect(2, 2, cv.width - 4, cv.height - 4);
      ctx.fillStyle = '#dff0ff';
      ctx.font = 'bold 54px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, cv.width / 2, cv.height / 2 + 4);
      const tex = new THREE.CanvasTexture(cv);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      spr.position.set(x, y, z);
      spr.scale.set(28 * scale, 7 * scale, 1);
      return spr;
    };
    const L = new THREE.Group();
    L.add(make('BOILER A', 0, 96, -52));
    L.add(make('BOILER B', 0, 96, 52));
    L.add(make('TURBINE HALL', 78, 56, 0));
    L.add(make('GENERATOR', 118, 40, 0));
    L.add(make('COOLING TOWER', 168, 132, 0));
    L.add(make('ESP + FGD', -84, 56, 0));
    L.add(make('STACK', -116, 140, 0));
    L.add(make('COAL STOCKPILE', -180, 34, 0));
    L.add(make('SWITCHYARD', 78, 40, -70));
    this.scene.add(L);
    this.labels = L;
  }

  /* ------------------------------------------------------------------ */
  setLabelsVisible(v) { if (this.labels) this.labels.visible = v; }

  bind(s) {
    this.state = s;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(0.1, this.clock.getDelta());
    const s = this.state;
    const t = this.clock.elapsedTime;

    if (s) {
      // --- rotating machines ---
      const rpm = s.turbine.speed || 0;
      const spin = (rpm / 60) * dt * 2 * Math.PI;
      if (this.animated.shaft) this.animated.shaft.rotation.x += spin;
      for (const d of this.animated.bladeDiscs || []) d.rotation.x += spin;
      if (this.animated.generator) this.animated.generator.rotation.x += spin;

      for (let i = 0; i < 2; i++) {
        const b = s.boilers[i];
        if (!b) continue;
        // fire glow follows the flame intensity / firing rate
        const fv = this.animated[`fire${i}`];
        if (fv) {
          const inten = clamp01((b.flameIntensity || 0) * 1.05);
          fv.material.opacity = 0.16 + inten * 0.55;
          fv.material.color.setHSL(0.06 + 0.05 * inten, 0.95, 0.28 + 0.28 * inten);
          const puff = 1 + 0.03 * Math.sin(t * 6) * (0.3 + inten);
          fv.scale.set(puff, 1 + 0.02 * Math.sin(t * 4.3), puff);
        }
        // burners
        for (let el = 0; el < 4; el++) for (let sx = 0; sx < 2; sx++) {
          const fl = this.animated[`burner${i}_${el}_${sx}`];
          if (!fl) continue;
          const lit = (b.flameScanners || 0) > el * 2 ? clamp01((b.flameIntensity || 0) * 1.2) : 0;
          fl.material.opacity = lit * 0.85;
          fl.scale.setScalar(0.7 + lit * 0.6 + 0.06 * Math.sin(t * 11 + el));
        }
        // drum level: move the internal water surface
        const dw = this.animated[`drumWater${i}`];
        if (dw) {
          const lvl = clamp((b.drumLevelTotal || 0) / 300, -1, 1);
          dw.scale.y = 0.02 + 0.5 * (0.5 + 0.5 * lvl);
          dw.position.y = 66 - 0.9 + 1.5 * lvl;
          dw.visible = Math.abs(b.drumLevel) > 4;
        }
        // mills
        const mills = this.animated[`mills${i}`] || [];
        for (let k = 0; k < mills.length; k++) {
          const m = b.mills[k];
          const running = m && m.running;
          const target = running ? (m.coalFlow / 38) * 22 : 0;
          mills[k].rotor.rotation.y += target * dt;
          const glow = running ? 1 : 0;
          mills[k].grp.children[1].material = glow ? this.mats.steel : this.mats.dark;
        }
        // fans
        for (const f of this.animated[`fans${i}`] || []) {
          let on = 0, sp = 0;
          if (f.tag === 'fd') { on = b.fdRunning ? 1 : 0; sp = b.fdSpeed || 0; }
          if (f.tag === 'pa') { on = b.paRunning ? 1 : 0; sp = b.paSpeed || 0; }
          if (f.tag === 'id') { on = b.idRunning ? 1 : 0; sp = b.idSpeed || 0; }
          f.hub.rotation.z += on * (sp / 100) * 26 * dt;
        }
        // bunker coal level
        for (let k = 0; k < 4; k++) {
          const ci = this.animated[`bunker${i}_${k}`];
          if (!ci) continue;
          const lvl = clamp01((s.bop.bunkerLevels[k] || 0) / 100);
          ci.scale.y = 0.2 + 4.6 * lvl;
          ci.position.y = 11.2 + 4.8 * lvl;
          ci.visible = lvl > 0.03;
        }
        // stack plume follows the flue-gas flow
        const plume = this.animated[`stackPlume${i}`];
        if (plume) {
          const flow = clamp01((b.mGas || 0) / 1400);
          plume.children.forEach((m, k) => {
            const drift = (t * (0.35 + 0.1 * k) + k) % 10;
            m.position.x = -drift * 3 - k * 2.4;
            m.position.y = k * 5 + Math.sin(t * 0.9 + k) * 1.4;
            m.scale.setScalar(1 + k * 0.09 + 0.05 * Math.sin(t * 1.7 + k));
            m.material.opacity = flow * (0.30 - k * 0.026) * (0.75 + 0.25 * Math.sin(t * 1.3 + k));
          });
        }
        const sl = this.animated[`stackLight${i}`];
        if (sl) sl.material.opacity = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.6));
      }

      // cooling-tower plume
      if (this.plume) {
        const p = clamp01(s.bop.towerPlume || 0);
        this.plume.children.forEach((m, k) => {
          m.position.y = k * 6 + Math.sin(t * 0.6 + k * 0.5) * 2;
          m.position.x = Math.sin(t * 0.35 + k * 0.3) * (2 + k * 1.5);
          m.scale.setScalar(1 + k * 0.06 + 0.04 * Math.sin(t + k));
          m.material.opacity = p * (0.26 - k * 0.017) * (0.8 + 0.2 * Math.sin(t * 1.1 + k));
        });
      }

      // bearings: vibration colour
      const vib = s.turbine.vibrations || [];
      (this.animated.bearings || []).forEach((lamp, k) => {
        const v = vib[k] || 0;
        lamp.material.color.setHex(v > 11.6 ? 0xff2d2d : v > 8.6 ? 0xffb020 : 0x33dd66);
      });
      // generator energised lamps
      (this.animated.energised || []).forEach((l) => {
        l.material.color.setHex(s.turbine.breakerClosed ? 0x66ff99 : 0x333333);
      });
      // CW pumps
      for (let k = 0; k < 2; k++) {
        const m = this.animated[`cwp${k}`];
        if (m) m.rotation.x += (s.condenser.cwPumps && s.condenser.cwPumps[k] ? 1 : 0) * 18 * dt;
      }
      for (let k = 0; k < 2; k++) {
        const m = this.animated[`bfp${k}`];
        const p = s.bop.bfp && s.bop.bfp[k];
        if (m) m.rotation.x += (p && p.running ? 1 : 0) * 24 * dt;
      }
      // conveyors
      for (let k = 0; k < 2; k++) {
        const belt = this.animated[`belt${k}`];
        if (belt && s.bop.conveyorRunning) {
          belt.material = belt.material;
          belt.position.x = 0;
        }
      }
      if (this.animated.crusherLight) {
        this.animated.crusherLight.material.color.setHex(s.bop.crusherRunning ? 0x33ff66 : 0x662222);
      }
      if (this.animated.turningGear) {
        this.animated.turningGear.material = s.turbine.turningGear ? this.mats.steel : this.mats.dark;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  view(name) {
    const p = {
      overview: [[150, 78, 190], [0, 26, 0]],
      boilers: [[-10, 40, 130], [0, 34, 0]],
      furnace: [[70, 30, 40], [0, 24, -52]],
      turbine: [[78, 26, 62], [78, 16, 0]],
      turbineDeck: [[46, 22, 40], [50, 15, 0]],
      tower: [[210, 60, 90], [168, 50, 0]],
      coal: [[-120, 44, 120], [-120, 14, 0]],
      fgd: [[-40, 44, 130], [-84, 30, 0]],
      topDown: [[40, 240, 40], [40, 0, 0]],
    }[name] || [[150, 78, 190], [0, 26, 0]];
    this.camera.position.set(...p[0]);
    this.controls.target.set(...p[1]);
    this.controls.update();
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function clamp01(v) { return clamp(v, 0, 1); }
