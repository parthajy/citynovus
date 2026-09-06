// Turns an osmium GeoJSONSeq export into what CityNovus needs:
//   <out>/osm.geojsonl          one polygon per building / pond / park / playground / flyover (bridges pre-buffered), for tippecanoe
//   <out>/places.json           named places (city…hamlet) with coordinates, for neighbourhood assignment and search
//   <out>/neighbourhoods.json   per-neighbourhood totals and centroids, for the leaderboard
//   <out>/search.json           named roads, places and points of interest, for the in-app search
// Usage: node scripts/tiles-prepare.mjs <export.geojsonl> <outdir>
import { createReadStream, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [,, input, out = 'public/data'] = process.argv;
if (!input) { console.error('usage: node scripts/tiles-prepare.mjs export.geojsonl [outdir]'); process.exit(1); }
mkdirSync(out, { recursive: true });
const LANE_WIDTH = 3.5;
const LANES_BY_HIGHWAY = { motorway: 6, trunk: 4, primary: 4, secondary: 3, tertiary: 2, residential: 2, unclassified: 2, service: 1, trunk_link: 2, primary_link: 2, secondary_link: 1 };

function centroid(ring) { let x = 0, y = 0; const n = ring.length - 1 || 1; for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; } return [x / n, y / n]; }
function chaikin(pts, it = 2) { let p = pts; for (let k = 0; k < it; k++) { if (p.length < 3) return p; const o = [p[0]]; for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; o.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]); } o.push(p[p.length - 1]); p = o; } return p; }
function arc(c, r, a0, a1, through, m = 8) { let d = ((a1 - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2); const alt = d - Math.PI * 2; const mid = (dl) => [Math.cos(a0 + dl / 2), Math.sin(a0 + dl / 2)]; const pick = mid(d)[0] * through[0] + mid(d)[1] * through[1] >= mid(alt)[0] * through[0] + mid(alt)[1] * through[1] ? d : alt; const o = []; for (let k = 1; k < m; k++) { const a = a0 + (pick * k) / m; o.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); } return o; }
function bufferLine(points, widthM) {
  const src = points.length >= 3 ? chaikin(points, 2) : points;
  const [ox, oy] = src[0]; const kx = 111320 * Math.cos((oy * Math.PI) / 180), ky = 111320;
  const raw = src.map(([x, y]) => [(x - ox) * kx, (y - oy) * ky]); const P = [];
  for (const q of raw) if (!P.length || Math.hypot(q[0] - P[P.length - 1][0], q[1] - P[P.length - 1][1]) > 0.05) P.push(q);
  if (P.length < 2) P.push([P[0][0] + 0.1, P[0][1]]);
  const half = widthM / 2, norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }; const left = [], right = [];
  for (let i = 0; i < P.length; i++) { const dPrev = i > 0 ? norm([P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]]) : null; const dNext = i < P.length - 1 ? norm([P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]]) : null; const d = dPrev && dNext ? norm([dPrev[0] + dNext[0], dPrev[1] + dNext[1]]) : (dPrev ?? dNext); const n = [-d[1], d[0]]; const cosHalf = dPrev && dNext ? Math.max(0.5, d[0] * dNext[0] + d[1] * dNext[1]) : 1; const s = half / cosHalf; left.push([P[i][0] + n[0] * s, P[i][1] + n[1] * s]); right.push([P[i][0] - n[0] * s, P[i][1] - n[1] * s]); }
  const n = P.length, d0 = norm([P[1][0] - P[0][0], P[1][1] - P[0][1]]), dN = norm([P[n - 1][0] - P[n - 2][0], P[n - 1][1] - P[n - 2][1]]); const ang = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const ring = [...left, ...arc(P[n - 1], half, ang(left[n - 1], P[n - 1]), ang(right[n - 1], P[n - 1]), dN), ...right.reverse(), ...arc(P[0], half, ang(right[0], P[0]), ang(left[0], P[0]), [-d0[0], -d0[1]])].map(([x, y]) => [+(ox + x / kx).toFixed(7), +(oy + y / ky).toFixed(7)]);
  ring.push(ring[0]); return ring;
}
function classify(t) {
  if (t.building) return { kind: 'building' };
  if (t.natural === 'water' || t.landuse === 'reservoir') return { kind: 'pond' };
  if (t.leisure === 'playground' || t.leisure === 'pitch') return { kind: 'playground' };
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'recreation_ground') return { kind: 'park' };
  if (t.highway && t.bridge === 'yes' && LANES_BY_HIGHWAY[t.highway]) { const l = parseInt(t.lanes ?? '', 10); return { kind: 'flyover', lanes: Number.isFinite(l) ? Math.min(l, 8) : LANES_BY_HIGHWAY[t.highway] }; }
  return null;
}

// Pass 1: places (small), so pass 2 can assign neighbourhoods with a grid lookup.
const PLACE_RANK = { city: 0, town: 1, suburb: 2, neighbourhood: 3, quarter: 3, village: 4, hamlet: 5 };
const places = [];
const search = [];
const seenSearch = new Set();
const addSearch = (n, t, c) => { const key = (n + '|' + t).toLowerCase(); if (seenSearch.has(key)) return; seenSearch.add(key); search.push({ n, t, c: [+c[0].toFixed(5), +c[1].toFixed(5)] }); };
async function pass(fn) { const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity }); for await (const line of rl) { const text = line.charCodeAt(0) === 0x1e ? line.slice(1) : line; if (!text.trim()) continue; let f; try { f = JSON.parse(text); } catch { continue; } fn(f); } }
const geomCentre = (g) => g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.type === 'Polygon' ? centroid(g.coordinates[0]) : g.type === 'MultiPolygon' ? centroid(g.coordinates[0][0]) : null;
console.log('pass 1: places and search names');
await pass((f) => {
  const t = f.properties || {};
  const c = geomCentre(f.geometry); if (!c) return;
  if (t.place && PLACE_RANK[t.place] !== undefined && t.name) { places.push({ id: `${t['@type'] ?? 'n'}/${t['@id']}`, name: t.name.trim(), kind: t.place, lon: +c[0].toFixed(5), lat: +c[1].toFixed(5), rank: PLACE_RANK[t.place] }); addSearch(t.name.trim(), t.place, c); }
  else if (t.name) {
    const type = t.highway ? 'road' : t.amenity || t.shop || t.tourism || t.historic || t.leisure || (t.railway === 'station' ? 'station' : null);
    if (type && (t.highway ? f.geometry.type === 'LineString' : true)) addSearch(t.name.trim(), String(type).replace(/_/g, ' '), c);
  }
});
console.log(`  ${places.length} places, ${search.length} searchable names`);
// grid for nearest place: 0.05° cells
const G = 0.05, grid = new Map();
const gk = (x, y) => `${Math.floor(x / G)}_${Math.floor(y / G)}`;
for (const p of places) { const k = gk(p.lon, p.lat); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
function nearest(lon, lat) {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = Infinity;
  for (let r = 0; r <= 4 && !best; r++) { // widen until something is found, then take the closest in that ring
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cell = grid.get(`${Math.floor(lon / G) + dx}_${Math.floor(lat / G) + dy}`); if (!cell) continue;
      for (const p of cell) { const d = ((p.lon - lon) * kx) ** 2 + (p.lat - lat) ** 2 + p.rank * 1e-6; if (d < bestD) { bestD = d; best = p; } }
    }
  }
  return best;
}

console.log('pass 2: footprints');
const outStream = createWriteStream(`${out}/osm.geojsonl`);
const totals = new Map(); const counts = {};
let n = 0;
await pass((f) => {
  const t = f.properties || {}; const c = classify(t); if (!c) return;
  const g = f.geometry; let ring, line = null;
  if (c.kind === 'flyover') { if (g.type !== 'LineString' || g.coordinates.length < 2) return; line = g.coordinates.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]); ring = bufferLine(g.coordinates, c.lanes * LANE_WIDTH); }
  else { const poly = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null; if (!poly || poly.length < 4) return; ring = poly.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]); }
  const cen = centroid(ring); const np = nearest(cen[0], cen[1]);
  const neighbourhood = np ? np.name : 'Unassigned';
  const tt = totals.get(neighbourhood) ?? { total: 0, x: 0, y: 0 }; tt.total++; tt.x += cen[0]; tt.y += cen[1]; totals.set(neighbourhood, tt);
  counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const levels = parseInt(t['building:levels'] ?? '', 10);
  const props = { id: `${t['@type'] === 'relation' ? 'rel' : 'way'}/${t['@id']}`, kind: c.kind, neighbourhood, osm_floors: c.kind === 'building' && Number.isFinite(levels) ? Math.min(levels, 60) : null, osm_name: t.name ?? null, osm_building: t.building && t.building !== 'yes' ? t.building : null };
  if (c.kind === 'flyover') { props.lanes = c.lanes; props.line = JSON.stringify(line); }
  outStream.write(JSON.stringify({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } }) + '\n');
  if (++n % 100000 === 0) console.log(`  ${n} features`);
});
await new Promise((r) => outStream.end(r));
writeFileSync(`${out}/places.json`, JSON.stringify({ places: places.map(({ id, name, kind, lon, lat }) => ({ id, name, kind, lon, lat })) }));
writeFileSync(`${out}/neighbourhoods.json`, JSON.stringify([...totals.entries()].map(([name, t]) => ({ name, total: t.total, c: [+(t.x / t.total).toFixed(5), +(t.y / t.total).toFixed(5)] })).sort((a, b) => b.total - a.total)));
search.sort((a, b) => a.n.localeCompare(b.n));
writeFileSync(`${out}/search.json`, JSON.stringify(search));
console.log(`done: ${n} footprints`, counts, `| ${totals.size} neighbourhoods`);
