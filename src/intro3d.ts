// The sign-in drive: a first-person ride through a stylised night city, corners and all,
// then a pull-up to a bird's-eye view under the card. Procedural, self-contained, loaded only when needed.
import * as THREE from 'three';

const ROUTE: [number, number, number][] = [
  [0, 0, 0], [0, 0, -34], [-6, 0, -58], [-30, 0, -76], [-56, 0, -80], [-78, 0, -98], [-84, 0, -128], [-72, 0, -158], [-48, 0, -176], [-30, 0, -204], [-34, 0, -240],
  [-52, 0, -272], [-80, 0, -290], [-110, 0, -300], [-140, 0, -320], // scenery continues past where the ride stops, so the road never runs out
];
const RIDE_END = 0.74; // the camera stops here; the rest is what you see ahead
const PALETTE = [0x1f5566, 0x2f6f80, 0x3a7a8c, 0xe07a5f, 0xd9c9a8, 0xf2c14e, 0x8ab17d, 0x5b8def, 0xb57edc, 0x8d6e63];
const rnd = (() => { let s = 20260906; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

function windowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, 64, 64); // wall, tinted per building
  for (let y = 6; y < 64; y += 16) for (let x = 6; x < 64; x += 16) {
    const lit = rnd() > 0.35;
    g.fillStyle = lit ? (rnd() > 0.5 ? '#ffe2a0' : '#ffd070') : '#2a3a44';
    g.fillRect(x, y, 8, 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,225,150,.9)'); r.addColorStop(1, 'rgba(255,225,150,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Drive {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private curve: THREE.CatmullRomCurve3;
  private raf = 0;
  private t0 = 0;
  private total = 5000;
  private frames = 0;
  private done = false;
  private orbit = 0;
  private onEnd: () => void = () => {};
  private centre = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 700);
    this.curve = new THREE.CatmullRomCurve3(ROUTE.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.4);
    this.build();
    this.resize();
    addEventListener('resize', this.resize);
  }

  private at(u: number, target?: THREE.Vector3) { return this.curve.getPointAt(Math.min(0.9995, Math.max(0, u)), target); }
  private tangent(u: number) { return this.curve.getTangentAt(Math.min(0.9995, Math.max(0.0005, u))); }

  private resize = () => {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private build() {
    const s = this.scene;
    s.background = new THREE.Color(0x0d3543);
    s.fog = new THREE.FogExp2(0x0d3543, 0.006);
    s.add(new THREE.HemisphereLight(0xa9cbdb, 0x14323d, 1.0));
    const sun = new THREE.DirectionalLight(0xffd9b0, 0.55); sun.position.set(-60, 40, -120); s.add(sun);

    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshLambertMaterial({ color: 0x113642 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; s.add(ground);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    for (let i = 0; i < 700; i++) { const a = rnd() * Math.PI * 2, e = rnd() * 0.6 + 0.1, r = 500; sp.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r); }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    s.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8, fog: false })));

    // road, kerbs, dashes along the curve
    const N = 360;
    const pts = this.curve.getSpacedPoints(N);
    const ribbon = (half: number, y: number, colour: number) => {
      const pos: number[] = [], idx: number[] = [];
      for (let i = 0; i <= N; i++) {
        const p = pts[i], tan = this.tangent(i / N);
        const nx = -tan.z, nz = tan.x;
        pos.push(p.x + nx * half, y, p.z + nz * half, p.x - nx * half, y, p.z - nz * half);
        if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: colour, side: THREE.DoubleSide }));
      s.add(m);
    };
    ribbon(7.6, 0.02, 0x9aa3a6); // pavement
    ribbon(4.8, 0.04, 0x2a343d); // asphalt
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xe9e3d6 });
    const dashGeo = new THREE.PlaneGeometry(0.22, 2.2);
    const len = this.curve.getLength();
    for (let d = 0; d < len; d += 6) {
      const u = d / len, p = this.at(u), tan = this.tangent(u);
      const m = new THREE.Mesh(dashGeo, dashMat);
      m.position.set(p.x, 0.06, p.z); m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(tan.x, -tan.z) + Math.PI / 2 - Math.PI / 2;
      m.rotation.set(-Math.PI / 2, 0, Math.atan2(tan.x, tan.z));
      s.add(m);
    }

    // buildings, trees, streetlights on both sides
    const winTex = windowTexture();
    const glow = new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4030 });
    const canopyMats = [0x2e6b4f, 0x3d8b6e, 0x4f8a4b].map((c) => new THREE.MeshLambertMaterial({ color: c }));
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x6a7075 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });
    const occupied: { x: number; z: number; r: number }[] = [];
    for (const side of [1, -1]) {
      let d = 6 + rnd() * 6;
      while (d < len - 4) {
        const u = d / len, p = this.at(u), tan = this.tangent(u);
        const nx = -tan.z * side, nz = tan.x * side;
        const w = 7 + rnd() * 9, depth = 8 + rnd() * 10;
        const h = rnd() < 0.15 ? 26 + rnd() * 30 : 6 + rnd() * 16;
        const off = 9.5 + depth / 2 + rnd() * 4;
        const cx = p.x + nx * off, cz = p.z + nz * off;
        if (!occupied.some((o) => Math.hypot(o.x - cx, o.z - cz) < (o.r + Math.max(w, depth) / 2) * 0.9)) {
          occupied.push({ x: cx, z: cz, r: Math.max(w, depth) / 2 });
          const tex = winTex.clone(); tex.needsUpdate = true; tex.repeat.set(Math.max(2, Math.round(w / 2.4)), Math.max(2, Math.round(h / 3.2)));
          const mat = new THREE.MeshLambertMaterial({ color: pick(PALETTE), map: tex, emissiveMap: tex, emissive: 0xffe0a0, emissiveIntensity: 0.7 });
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
          b.position.set(cx, h / 2, cz); b.rotation.y = Math.atan2(tan.x, tan.z);
          s.add(b);
          if (rnd() < 0.4) { // a roof box
            const r = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 2.2, depth * 0.4), new THREE.MeshLambertMaterial({ color: 0x33424c }));
            r.position.set(cx, h + 1.1, cz); r.rotation.y = b.rotation.y; s.add(r);
          }
        }
        d += w + 2 + rnd() * 6;
      }
      // a second, taller row behind the first, and a backdrop skyline further out for depth
      for (let d4 = rnd() * 10; d4 < len; d4 += 14 + rnd() * 12) {
        const u = d4 / len, p = this.at(u), tan = this.tangent(u);
        const nx = -tan.z * side, nz = tan.x * side;
        const w = 12 + rnd() * 14, depth = 12 + rnd() * 12, h = 18 + rnd() * 42, off = 34 + rnd() * 14;
        const cx = p.x + nx * off, cz = p.z + nz * off;
        if (occupied.some((o) => Math.hypot(o.x - cx, o.z - cz) < (o.r + Math.max(w, depth) / 2) * 0.85)) continue;
        occupied.push({ x: cx, z: cz, r: Math.max(w, depth) / 2 });
        const tex = winTex.clone(); tex.needsUpdate = true; tex.repeat.set(Math.max(2, Math.round(w / 2.4)), Math.max(2, Math.round(h / 3.2)));
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), new THREE.MeshLambertMaterial({ color: pick(PALETTE), map: tex, emissiveMap: tex, emissive: 0xffe0a0, emissiveIntensity: 0.45 }));
        b.position.set(cx, h / 2, cz); b.rotation.y = Math.atan2(tan.x, tan.z) + (rnd() - 0.5) * 0.3; s.add(b);
      }
      for (let d5 = rnd() * 20; d5 < len; d5 += 24 + rnd() * 20) {
        const u = d5 / len, p = this.at(u), tan = this.tangent(u);
        const nx = -tan.z * side, nz = tan.x * side;
        const w = 18 + rnd() * 20, h = 24 + rnd() * 36, off = 70 + rnd() * 40;
        const tex = winTex.clone(); tex.needsUpdate = true; tex.repeat.set(Math.max(2, Math.round(w / 2.6)), Math.max(2, Math.round(h / 3.4)));
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshLambertMaterial({ color: 0x2b5f6f, map: tex, emissiveMap: tex, emissive: 0xffe0a0, emissiveIntensity: 0.35 }));
        b.position.set(p.x + nx * off, h / 2, p.z + nz * off); b.rotation.y = rnd() * Math.PI; s.add(b);
      }
      // trees on the pavement
      for (let d2 = 3 + rnd() * 5; d2 < len - 3; d2 += 7 + rnd() * 6) {
        const u = d2 / len, p = this.at(u), tan = this.tangent(u);
        const nx = -tan.z * side, nz = tan.x * side;
        const x = p.x + nx * 6.6, z = p.z + nz * 6.6;
        const th = 2 + rnd() * 1.5, cr = 1.6 + rnd() * 1.2;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, th, 6), trunkMat); trunk.position.set(x, th / 2, z); s.add(trunk);
        const canopy = new THREE.Mesh(rnd() < 0.5 ? new THREE.SphereGeometry(cr, 8, 6) : new THREE.ConeGeometry(cr, cr * 2.2, 7), pick(canopyMats));
        canopy.position.set(x, th + cr * 0.7, z); s.add(canopy);
      }
      // streetlights
      for (let d3 = 12; d3 < len; d3 += 26) {
        const u = d3 / len, p = this.at(u), tan = this.tangent(u);
        const nx = -tan.z * side, nz = tan.x * side;
        const x = p.x + nx * 5.6, z = p.z + nz * 5.6;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.5, 6), poleMat); pole.position.set(x, 3.25, z); s.add(pole);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), lampMat); lamp.position.set(x - nx * 0.9, 6.5, z - nz * 0.9); s.add(lamp);
        const sp = new THREE.Sprite(glow); sp.position.copy(lamp.position); sp.scale.set(4, 4, 1); s.add(sp);
      }
    }
    const box = new THREE.Box3();
    for (const o of occupied) box.expandByPoint(new THREE.Vector3(o.x, 0, o.z));
    box.getCenter(this.centre);
    this.centre.y = 0;
  }

  /** Drive for `total` ms, then pull up; calls onEnd when the card should appear. */
  play(total: number, onEnd: () => void) {
    this.total = total; this.onEnd = onEnd; this.done = false; this.frames = 0;
    this.t0 = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }
  skip() { if (!this.done) { this.done = true; this.overview(1); this.onEnd(); } }

  private overview(k: number) {
    // From the last street position up to a bird's-eye view over the whole route.
    const end = this.at(RIDE_END);
    const target = new THREE.Vector3(this.centre.x, 0, this.centre.z);
    const high = new THREE.Vector3(this.centre.x + 40, 200, this.centre.z + 230);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const from = end.clone().setY(1.8);
    this.camera.position.lerpVectors(from, high, e);
    const look = new THREE.Vector3().lerpVectors(this.at(RIDE_END + 0.02).setY(2), target, e);
    this.camera.lookAt(look);
    this.camera.rotation.z = 0;
    this.renderer.render(this.scene, this.camera);
  }

  private frame = (now: number) => {
    const t = now - this.t0;
    // The first frames include shader compilation, so judge the device on the window after that.
    if (t > 600) this.frames++;
    if (t > 1500 && this.frames < 8 && !(window as unknown as { __forceIntro?: boolean }).__forceIntro) { this.skip(); return; } // a phone that cannot keep up gets the card
    const driveMs = this.total - 900;
    if (!this.done) {
      if (t < driveMs) {
        const u = Math.min(RIDE_END, (t / driveMs) * (this.total >= 5000 ? RIDE_END : RIDE_END * 0.62));
        const p = this.at(u), ahead = this.at(u + 0.02);
        const tan0 = this.tangent(u), tan1 = this.tangent(u + 0.03);
        const turn = tan0.x * tan1.z - tan0.z * tan1.x; // signed curvature: lean into corners
        this.camera.position.set(p.x, 1.8 + Math.sin(t / 90) * 0.02, p.z);
        this.camera.lookAt(ahead.x, 1.9, ahead.z);
        this.camera.rotateZ(Math.max(-0.05, Math.min(0.05, turn * 0.3)));
        this.renderer.render(this.scene, this.camera);
      } else if (t < this.total) {
        this.overview((t - driveMs) / 900);
      } else {
        this.done = true; this.overview(1); this.onEnd();
      }
    } else {
      // Under the card: a slow orbit so the city keeps breathing.
      this.orbit += 0.0016;
      const r = 235;
      this.camera.position.set(this.centre.x + Math.sin(this.orbit + 0.17) * r, 200, this.centre.z + Math.cos(this.orbit + 0.17) * r);
      this.camera.lookAt(this.centre.x, 0, this.centre.z);
      this.renderer.render(this.scene, this.camera);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  dispose() {
    this.stop();
    removeEventListener('resize', this.resize);
    this.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
    this.renderer.dispose();
  }
}
