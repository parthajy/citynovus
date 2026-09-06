// Pulls one city's buildings, ponds, parks, playgrounds and flyovers from OpenStreetMap
// via Overpass, assigns each to its nearest named neighbourhood, and writes
//   public/data/world.geojson
//   public/data/places.json
//
// Usage:  npm run fetch-osm
//         BBOX="S,W,N,E" npm run fetch-osm      (default is Guwahati)
//
// OSM data is ODbL. Keep the attribution in the app.

import { writeFileSync, mkdirSync } from 'node:fs';

const BBOX = process.env.BBOX ?? '26.08,91.62,26.22,91.88';
const MIRRORS = process.env.OVERPASS
  ? [process.env.OVERPASS]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = 'public/data';
const LANE_WIDTH = 3.5;

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*', 'User-Agent': 'citynovus.com fetch-osm (open source)' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = 3000 * (attempt + 1);
      console.log(`  overpass attempt ${attempt + 1} failed (${e.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}
function dist2([lon1, lat1], [lon2, lat2]) {
  const k = Math.cos((lat1 * Math.PI) / 180);
  const dx = (lon1 - lon2) * k, dy = lat1 - lat2;
  return dx * dx + dy * dy;
}
// Same algorithm as shared/geo.ts bufferLine: Chaikin-smoothed centre line, round ends.
function chaikin(pts, iterations = 2) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    if (p.length < 3) return p;
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}
function arc(c, r, a0, a1, through, m = 8) {
  let d = ((a1 - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const alt = d - Math.PI * 2;
  const mid = (delta) => [Math.cos(a0 + delta / 2), Math.sin(a0 + delta / 2)];
  const pick = mid(d)[0] * through[0] + mid(d)[1] * through[1] >= mid(alt)[0] * through[0] + mid(alt)[1] * through[1] ? d : alt;
  const out = [];
  for (let k = 1; k < m; k++) { const a = a0 + (pick * k) / m; out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
  return out;
}
function bufferLine(points, widthM) {
  const src = points.length >= 3 ? chaikin(points, 2) : points;
  const [ox, oy] = src[0];
  const kx = 111320 * Math.cos((oy * Math.PI) / 180), ky = 111320;
  const raw = src.map(([x, y]) => [(x - ox) * kx, (y - oy) * ky]);
  const P = [];
  for (const q of raw) if (!P.length || Math.hypot(q[0] - P[P.length - 1][0], q[1] - P[P.length - 1][1]) > 0.05) P.push(q);
  if (P.length < 2) P.push([P[0][0] + 0.1, P[0][1]]);
  const half = widthM / 2;
  const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const left = [], right = [];
  for (let i = 0; i < P.length; i++) {
    const dPrev = i > 0 ? norm([P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]]) : null;
    const dNext = i < P.length - 1 ? norm([P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]]) : null;
    const d = dPrev && dNext ? norm([dPrev[0] + dNext[0], dPrev[1] + dNext[1]]) : (dPrev ?? dNext);
    const n = [-d[1], d[0]];
    const cosHalf = dPrev && dNext ? Math.max(0.5, d[0] * dNext[0] + d[1] * dNext[1]) : 1;
    const s = half / cosHalf;
    left.push([P[i][0] + n[0] * s, P[i][1] + n[1] * s]);
    right.push([P[i][0] - n[0] * s, P[i][1] - n[1] * s]);
  }
  const n = P.length;
  const d0 = norm([P[1][0] - P[0][0], P[1][1] - P[0][1]]), dN = norm([P[n - 1][0] - P[n - 2][0], P[n - 1][1] - P[n - 2][1]]);
  const ang = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const ring = [...left, ...arc(P[n - 1], half, ang(left[n - 1], P[n - 1]), ang(right[n - 1], P[n - 1]), dN), ...right.reverse(), ...arc(P[0], half, ang(right[0], P[0]), ang(left[0], P[0]), [-d0[0], -d0[1]])]
    .map(([x, y]) => [ox + x / kx, oy + y / ky]);
  ring.push(ring[0]);
  return ring;
}

const LANES_BY_HIGHWAY = { motorway: 6, trunk: 4, primary: 4, secondary: 3, tertiary: 2, residential: 2, unclassified: 2, service: 1, trunk_link: 2, primary_link: 2, secondary_link: 1 };

function classify(t) {
  if (t.building) return { kind: 'building' };
  if (t.natural === 'water' || t.landuse === 'reservoir') return { kind: 'pond' };
  if (t.leisure === 'playground' || t.leisure === 'pitch') return { kind: 'playground' };
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'recreation_ground') return { kind: 'park' };
  if (t.highway && t.bridge === 'yes' && LANES_BY_HIGHWAY[t.highway]) {
    const lanes = parseInt(t.lanes ?? '', 10);
    return { kind: 'flyover', lanes: Number.isFinite(lanes) ? Math.min(lanes, 8) : LANES_BY_HIGHWAY[t.highway] };
  }
  return null;
}

console.log(`Fetching places in ${BBOX} ...`);
const placesRaw = await overpass(
  `[out:json][timeout:60];(node["place"~"^(suburb|neighbourhood|quarter)$"]["name"](${BBOX}););out;`
);
const places = placesRaw.elements
  .filter((n) => n.tags?.name && n.tags.name !== 'undefined')
  .map((n) => ({ id: `node/${n.id}`, name: n.tags.name.trim(), kind: n.tags.place, lon: n.lon, lat: n.lat }));
console.log(`  ${places.length} named neighbourhoods`);

console.log(`Fetching buildings, water, parks and flyovers in ${BBOX} ...`);
const raw = await overpass(`[out:json][timeout:180];(
  way["building"](${BBOX});
  way["natural"="water"](${BBOX});
  way["landuse"~"^(reservoir|grass|recreation_ground)$"](${BBOX});
  way["leisure"~"^(park|garden|playground|pitch)$"](${BBOX});
  way["highway"]["bridge"="yes"](${BBOX});
);out tags geom;`);

const features = [];
const totals = {};
const counts = {};
for (const w of raw.elements) {
  if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue;
  const t = w.tags ?? {};
  const c = classify(t);
  if (!c) continue;
  const pts = w.geometry.map((p) => [p.lon, p.lat]);
  let ring, line = null;
  if (c.kind === 'flyover') {
    if (pts.length < 2) continue;
    line = pts;
    ring = bufferLine(pts, c.lanes * LANE_WIDTH);
  } else {
    if (pts.length < 4) continue;
    ring = pts;
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  }
  const cen = centroid(ring);
  let best = null, bestD = Infinity;
  for (const p of places) {
    const d = dist2(cen, [p.lon, p.lat]);
    if (d < bestD) { bestD = d; best = p; }
  }
  const neighbourhood = best ? best.name : 'Unassigned';
  totals[neighbourhood] = (totals[neighbourhood] ?? 0) + 1;
  counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const levels = parseInt(t['building:levels'] ?? '', 10);
  features.push({
    type: 'Feature',
    id: w.id,
    properties: {
      id: `way/${w.id}`,
      kind: c.kind,
      neighbourhood,
      osm_floors: c.kind === 'building' && Number.isFinite(levels) ? Math.min(levels, 60) : null,
      osm_name: t.name ?? null,
      osm_building: t.building && t.building !== 'yes' ? t.building : null,
      line,
      props: c.kind === 'flyover' ? { lanes: c.lanes, line } : {},
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
}

// A search index of our own, so the app never has to lean on Nominatim's public servers.
console.log('Fetching named roads and places for search ...');
const sRaw = await overpass(`[out:json][timeout:180];(
  way["highway"]["name"](${BBOX});
  nwr["name"]["amenity"](${BBOX});
  nwr["name"]["shop"](${BBOX});
  nwr["name"]["tourism"](${BBOX});
  nwr["name"]["leisure"](${BBOX});
  nwr["name"]["place"](${BBOX});
  nwr["name"]["railway"="station"](${BBOX});
  nwr["name"]["historic"](${BBOX});
);out tags center;`);
const seen = new Set();
const search = [];
for (const e of sRaw.elements) {
  const name = e.tags?.name?.trim();
  if (!name) continue;
  const lon = e.lon ?? e.center?.lon, lat = e.lat ?? e.center?.lat;
  if (lon === undefined || lat === undefined) continue;
  const type = e.tags.highway ? 'road' : e.tags.amenity || e.tags.shop || e.tags.tourism || e.tags.leisure || e.tags.place || e.tags.historic || (e.tags.railway ? 'station' : 'place');
  const key = (name + '|' + type).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  search.push({ n: name, t: String(type).replace(/_/g, ' '), c: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] });
}
search.sort((a, b) => a.n.localeCompare(b.n));

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/search.json`, JSON.stringify(search));
console.log(`  ${search.length} searchable names written to ${OUT}/search.json`);
writeFileSync(`${OUT}/world.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
writeFileSync(`${OUT}/places.json`, JSON.stringify({ bbox: BBOX, fetched_at: new Date().toISOString(), places, totals, counts }, null, 1));

console.log(`  ${features.length} features written to ${OUT}/world.geojson:`, counts);
const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('  most-mapped neighbourhoods:', top.map(([n, c]) => `${n} (${c})`).join(', '));
console.log('Note: multipolygon relations (the Brahmaputra, big parks) are skipped in v0.2; the basemap still draws them.');
