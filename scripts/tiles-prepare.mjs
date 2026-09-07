// Turns an osmium GeoJSONSeq export into what CityNovus needs:
//   <out>/osm.geojsonl          one polygon per building / pond / park / playground / flyover (bridges pre-buffered), for tippecanoe
//   <out>/places.json           named places (city…hamlet) with coordinates, for neighbourhood assignment and search
//   <out>/neighbourhoods.json   per-neighbourhood totals and centroids, for the leaderboard
//   <out>/search.json           named roads, places and points of interest, for the in-app search
// Usage: node scripts/tiles-prepare.mjs <export.geojsonl> <outdir>
import { createReadStream, mkdirSync, writeFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [,, input, out = 'public/data', districtsFile = 'scripts/assam-districts.geojson'] = process.argv;
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
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest' || t.landuse === 'orchard') return { kind: 'grove', dense: t.natural === 'wood' || t.landuse === 'forest' };
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

// Districts: every place belongs to one, and a place name that repeats across districts gets the district appended,
// so "Bhaktagaon (Nagaon)" and "Bhaktagaon (Jorhat)" stay apart on the leaderboard.
const districts = existsSync(districtsFile) ? JSON.parse(readFileSync(districtsFile, 'utf8')).features.map((f) => ({ name: f.properties.name.replace(/\s+district$/i, '').trim(), rings: f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]) })) : [];
for (const d of districts) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const r of d.rings) for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } d.bbox = [x0, y0, x1, y1]; }
const pip = (pt, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside; } return inside; };
const districtOf = (lon, lat) => { for (const d of districts) { const b = d.bbox; if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue; if (d.rings.some((r) => pip([lon, lat], r))) return d.name; } return null; };
for (const p of places) p.district = districtOf(p.lon, p.lat) ?? 'Assam';
const byName = new Map();
for (const p of places) { const set = byName.get(p.name) ?? new Set(); set.add(p.district); byName.set(p.name, set); }
for (const p of places) if (byName.get(p.name).size > 1 && p.district !== 'Assam' && p.district !== p.name) p.name = `${p.name} (${p.district})`; // the district's namesake town keeps its plain name
console.log(`  ${districts.length} districts; ${[...byName.values()].filter((s) => s.size > 1).length} place names repeat across districts`);
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
let trees = 0;
const TREE_CAP = 60, TREE_M2 = 420;
const rnd = (() => { let x = 1234567; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; })();
const octagon = (c, r) => { const kx = 111320 * Math.cos((c[1] * Math.PI) / 180); const o = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; o.push([+(c[0] + (Math.cos(a) * r) / kx).toFixed(7), +(c[1] + (Math.sin(a) * r) / 111320).toFixed(7)]); } o.push(o[0]); return o; };
const ringArea = (ring) => { const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180); let a = 0; for (let i = 0; i < ring.length - 1; i++) a += (ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]); return Math.abs(a / 2) * kx * 111320; };
const emitTree = (c, big) => { const r = (big ? 2.4 : 1.7) + rnd() * 1.4, h = (big ? 5 : 3.6) + rnd() * 2.5; outStream.write(JSON.stringify({ type: 'Feature', properties: { id: `t/${++trees}`, kind: 'osmtree', h: +h.toFixed(1), c: Math.floor(rnd() * 4) }, geometry: { type: 'Polygon', coordinates: [octagon(c, r)] } }) + '\n'); };
await pass((f) => {
  const t = f.properties || {};
  if (t.natural === 'tree' && f.geometry.type === 'Point') { emitTree(f.geometry.coordinates, true); return; }
  const c = classify(t); if (!c) return;
  const g = f.geometry; let ring, line = null;
  if (c.kind === 'flyover') { if (g.type !== 'LineString' || g.coordinates.length < 2) return; line = g.coordinates.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]); ring = bufferLine(g.coordinates, c.lanes * LANE_WIDTH); }
  else { const poly = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null; if (!poly || poly.length < 4) return; ring = poly.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]); }
  if (c.kind === 'grove') {
    // scenery: the wood itself, plus a scatter of trees inside it (capped, so forests stay light)
    outStream.write(JSON.stringify({ type: 'Feature', properties: { id: `g/${t['@id']}`, kind: 'grove' }, geometry: { type: 'Polygon', coordinates: [ring] } }) + '\n');
    const area = ringArea(ring); const n = Math.min(TREE_CAP, Math.max(2, Math.round(area / (c.dense ? TREE_M2 : TREE_M2 * 2))));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) { const pt = [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)]; if (pip(pt, ring)) { emitTree(pt, c.dense); k++; } }
    counts.grove = (counts.grove ?? 0) + 1; return;
  }
  const cen = centroid(ring); const np = nearest(cen[0], cen[1]);
  const neighbourhood = np ? np.name : 'Unassigned';
  const tt = totals.get(neighbourhood) ?? { total: 0, x: 0, y: 0, district: np?.district ?? 'Assam' }; tt.total++; tt.x += cen[0]; tt.y += cen[1]; totals.set(neighbourhood, tt);
  counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const levels = parseInt(t['building:levels'] ?? '', 10);
  const props = { id: `${t['@type'] === 'relation' ? 'rel' : 'way'}/${t['@id']}`, kind: c.kind, neighbourhood, osm_floors: c.kind === 'building' && Number.isFinite(levels) ? Math.min(levels, 60) : null, osm_name: t.name ?? null, osm_building: t.building && t.building !== 'yes' ? t.building : null };
  if (c.kind === 'flyover') { props.lanes = c.lanes; props.line = JSON.stringify(line); }
  outStream.write(JSON.stringify({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } }) + '\n');
  if (++n % 100000 === 0) console.log(`  ${n} features`);
});
await new Promise((r) => outStream.end(r));
writeFileSync(`${out}/places.json`, JSON.stringify({ places: places.map(({ id, name, kind, lon, lat, district }) => ({ id, name, kind, lon, lat, district })) }));
writeFileSync(`${out}/neighbourhoods.json`, JSON.stringify([...totals.entries()].map(([name, t]) => ({ name, district: t.district, total: t.total, c: [+(t.x / t.total).toFixed(5), +(t.y / t.total).toFixed(5)] })).sort((a, b) => b.total - a.total)));
const dTotals = new Map();
for (const t of totals.values()) { const d = dTotals.get(t.district) ?? { total: 0, x: 0, y: 0 }; d.total += t.total; d.x += t.x; d.y += t.y; dTotals.set(t.district, d); }
writeFileSync(`${out}/districts.json`, JSON.stringify(districts.map((d) => { const t = dTotals.get(d.name) ?? { total: 0, x: 0, y: 0 }; const c = t.total ? [+(t.x / t.total).toFixed(4), +(t.y / t.total).toFixed(4)] : [(d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2]; return { name: d.name, total: t.total, c, bbox: d.bbox.map((v) => +v.toFixed(4)) }; }).sort((a, b) => b.total - a.total)));
search.sort((a, b) => a.n.localeCompare(b.n));
writeFileSync(`${out}/search.json`, JSON.stringify(search));
console.log(`done: ${n} footprints`, counts, `| ${trees} trees | ${totals.size} neighbourhoods`);
