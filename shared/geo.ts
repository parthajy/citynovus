import type { Polygon, Position } from 'geojson';

export interface Place { id: string; name: string; kind: string; lon: number; lat: number }

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export function centroid(ring: Position[]): [number, number] {
  let x = 0, y = 0;
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

export function nearestPlace(lonlat: [number, number], places: Place[]): Place | null {
  const k = Math.cos((lonlat[1] * Math.PI) / 180);
  let best: Place | null = null, bestD = Infinity;
  for (const p of places) {
    const dx = (lonlat[0] - p.lon) * k, dy = lonlat[1] - p.lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Shoelace area of a lon/lat ring, projected locally. Fine for city-block-sized polygons.
export function ringAreaM2(ring: Position[]): number {
  if (ring.length < 3) return 0;
  const [cx, cy] = centroid(ring);
  const kx = mPerDegLon(cy), ky = M_PER_DEG_LAT;
  let a = 0;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring : [...ring, ring[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const x1 = (pts[i][0] - cx) * kx, y1 = (pts[i][1] - cy) * ky;
    const x2 = (pts[i + 1][0] - cx) * kx, y2 = (pts[i + 1][1] - cy) * ky;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function closeRing(points: Position[]): Polygon {
  const ring = points.map((p) => [p[0], p[1]] as Position);
  const f = ring[0], l = ring[ring.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Shrink (or grow) a ring about its centroid. Good enough for roof caps on building-shaped polygons. */
export function insetRing(ring: Position[], factor: number): Position[] {
  const [cx, cy] = centroid(ring);
  return ring.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

/** Points along a line every `stepM` metres. */
export function alongLine(points: Position[], stepM: number): Position[] {
  const out: Position[] = [];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const kx = mPerDegLon(y1), ky = M_PER_DEG_LAT;
    const len = Math.hypot((x2 - x1) * kx, (y2 - y1) * ky);
    if (len === 0) continue;
    let t = carry;
    while (t <= len) {
      out.push([x1 + ((x2 - x1) * t) / len, y1 + ((y2 - y1) * t) / len]);
      t += stepM;
    }
    carry = t - len;
  }
  return out;
}

export function pointInRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Small deterministic RNG so decorations do not jump around between renders. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function scatterInRing(ring: Position[], n: number, rnd: () => number): Position[] {
  const [minX, minY, maxX, maxY] = ringBbox(ring);
  const out: Position[] = [];
  for (let tries = 0; out.length < n && tries < n * 12; tries++) {
    const p: Position = [minX + rnd() * (maxX - minX), minY + rnd() * (maxY - minY)];
    if (pointInRing(p, ring)) out.push(p);
  }
  return out;
}

export function circleRing([lon, lat]: Position, rM: number, sides = 8, rot = 0): Position[] {
  const kx = mPerDegLon(lat), ky = M_PER_DEG_LAT;
  const ring: Position[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    ring.push([lon + (Math.cos(a) * rM) / kx, lat + (Math.sin(a) * rM) / ky]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

export function darken(hex: string, f: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = m.slice(1).map((h) => Math.round(parseInt(h, 16) * f).toString(16).padStart(2, '0'));
  return '#' + c.join('');
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** [minX, minY, maxX, maxY] */
export function ringBbox(ring: Position[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return [minX, minY, maxX, maxY];
}
export function bboxesTouch(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
function segmentsCross(a: Position, b: Position, c: Position, d: Position): boolean {
  const o = (p: Position, q: Position, r: Position) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}
/** True when two rings share any interior area: a vertex inside the other, or crossing edges. */
export function ringsOverlap(a: Position[], b: Position[]): boolean {
  if (!bboxesTouch(ringBbox(a), ringBbox(b))) return false;
  for (const p of a) if (pointInRing(p, b)) return true;
  for (const p of b) if (pointInRing(p, a)) return true;
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

/** Chaikin corner cutting: turns a hand-tapped polyline into a smooth curve. Endpoints stay put on open lines. */
export function chaikin(pts: Position[], iterations = 2, closed = false): Position[] {
  let p = pts.map((q) => [q[0], q[1]] as Position);
  if (closed && p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
  for (let k = 0; k < iterations; k++) {
    const n = p.length;
    if (n < 3) return p;
    const out: Position[] = [];
    if (!closed) out.push(p[0]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = p[i], b = p[(i + 1) % n];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}

function local(points: Position[]) {
  const [ox, oy] = points[0];
  const kx = mPerDegLon(oy), ky = M_PER_DEG_LAT;
  const P = points.map(([x, y]) => [(x - ox) * kx, (y - oy) * ky]);
  return { P, back: ([x, y]: number[]): Position => [ox + x / kx, oy + y / ky] };
}
const norm2 = (v: number[]) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
function dedupe(P: number[][]): number[][] {
  const out: number[][] = [];
  for (const p of P) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.05) out.push(p);
  return out;
}
/** Points on a circle from angle a0 to a1 (exclusive), sweeping the way that passes through direction `through`. */
function arc(c: number[], r: number, a0: number, a1: number, through: number[], m = 8): number[][] {
  let d = a1 - a0;
  d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); // 0..2π counter-clockwise
  const alt = d - Math.PI * 2;
  const mid = (delta: number) => [Math.cos(a0 + delta / 2), Math.sin(a0 + delta / 2)];
  const pick = mid(d)[0] * through[0] + mid(d)[1] * through[1] >= mid(alt)[0] * through[0] + mid(alt)[1] * through[1] ? d : alt;
  const out: number[][] = [];
  for (let k = 1; k < m; k++) { const a = a0 + (pick * k) / m; out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
  return out;
}

export function lineLengthM(points: Position[]): number {
  const { P } = local(points);
  let L = 0;
  for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  return L;
}

/** Turn a centre line into a smooth strip with round ends. Width in metres. */
export function bufferLine(points: Position[], widthM: number, opts: { smooth?: boolean; round?: boolean } = {}): Polygon {
  const smooth = opts.smooth ?? true, round = opts.round ?? true;
  const src = smooth && points.length >= 3 ? chaikin(points, 2) : points;
  const { P: raw, back } = local(src);
  const P = dedupe(raw);
  if (P.length < 2) P.push([P[0][0] + 0.1, P[0][1]]);
  const half = widthM / 2;
  const left: number[][] = [], right: number[][] = [];
  for (let i = 0; i < P.length; i++) {
    const dPrev = i > 0 ? norm2([P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]]) : null;
    const dNext = i < P.length - 1 ? norm2([P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]]) : null;
    const d = dPrev && dNext ? norm2([dPrev[0] + dNext[0], dPrev[1] + dNext[1]]) : (dPrev ?? dNext)!;
    const n = [-d[1], d[0]];
    const cosHalf = dPrev && dNext ? Math.max(0.5, d[0] * dNext[0] + d[1] * dNext[1]) : 1;
    const s = half / cosHalf;
    left.push([P[i][0] + n[0] * s, P[i][1] + n[1] * s]);
    right.push([P[i][0] - n[0] * s, P[i][1] - n[1] * s]);
  }
  const n = P.length;
  const d0 = norm2([P[1][0] - P[0][0], P[1][1] - P[0][1]]);
  const dN = norm2([P[n - 1][0] - P[n - 2][0], P[n - 1][1] - P[n - 2][1]]);
  const ang = (p: number[], c: number[]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const ring: number[][] = [...left];
  if (round) ring.push(...arc(P[n - 1], half, ang(left[n - 1], P[n - 1]), ang(right[n - 1], P[n - 1]), dN));
  ring.push(...[...right].reverse());
  if (round) ring.push(...arc(P[0], half, ang(right[0], P[0]), ang(left[0], P[0]), [-d0[0], -d0[1]]));
  const out = ring.map(back);
  out.push([out[0][0], out[0][1]]);
  return { type: 'Polygon', coordinates: [out] };
}

/** The same strip cut into short rectangles along its length, so a deck can rise and fall. t runs 0..1. */
export function lineSegments(points: Position[], widthM: number, stepM: number, smooth = true): { ring: Position[]; t: number; mid: Position; lengthM: number }[] {
  const src = smooth && points.length >= 3 ? chaikin(points, 2) : points;
  const { P: raw, back } = local(src);
  const P = dedupe(raw);
  if (P.length < 2) return [];
  // resample
  const samples: number[][] = [P[0]];
  let total = 0;
  const cum = [0];
  for (let i = 1; i < P.length; i++) { total += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); cum.push(total); }
  let next = stepM;
  for (let i = 1; i < P.length; i++) {
    const segLen = cum[i] - cum[i - 1];
    while (next < cum[i] && segLen > 0) {
      const u = (next - cum[i - 1]) / segLen;
      samples.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u]);
      next += stepM;
    }
  }
  samples.push(P[P.length - 1]);
  const half = widthM / 2, ov = 0.6;
  const out: { ring: Position[]; t: number; mid: Position; lengthM: number }[] = [];
  let dist = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const d = norm2([b[0] - a[0], b[1] - a[1]]), nn = [-d[1], d[0]];
    const A = [a[0] - d[0] * ov, a[1] - d[1] * ov], B = [b[0] + d[0] * ov, b[1] + d[1] * ov];
    const ring = [
      [A[0] + nn[0] * half, A[1] + nn[1] * half], [B[0] + nn[0] * half, B[1] + nn[1] * half],
      [B[0] - nn[0] * half, B[1] - nn[1] * half], [A[0] - nn[0] * half, A[1] - nn[1] * half],
    ].map(back);
    ring.push([ring[0][0], ring[0][1]]);
    const midLocal = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    out.push({ ring, t: total ? (dist + len / 2) / total : 0.5, mid: back(midLocal), lengthM: total });
    dist += len;
  }
  return out;
}
