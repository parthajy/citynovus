// Real building heights from Google Open Buildings 2.5D Temporal (CC BY 4.0 / ODbL), sampled at each footprint.
// Reads only a coarse overview (about 8 m per pixel) of each 12.5 km height raster over HTTP range requests,
// for the rasters that hold the most footprints, and writes <out>/heights.json: { "way/123": floors, ... }.
// Usage: node scripts/ob-heights.mjs <osm.geojsonl> <outdir> <manifest.json...>   env: MAX_TILES=80 MIN_BUILDINGS=1500
import { createReadStream, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const { fromUrl } = require('geotiff');

const [,, input, out = 'public/data', ...manifests] = process.argv;
const MAX_TILES = Number(process.env.MAX_TILES ?? 80), MIN_BUILDINGS = Number(process.env.MIN_BUILDINGS ?? 1500);
const FLOOR_M = 3.2;
const tiles = [];
for (const mf of manifests) {
  const j = JSON.parse(readFileSync(mf, 'utf8'));
  const epsg = /EPSG_(\d+)/.exec(j.name + " " + mf)[1]; const zone = Number(epsg.slice(-2));
  const proj = `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
  const cell = j.uriPrefix.replace(/^gs:\/\/open-buildings-temporal-data\/v1\/geotiffs\//, '');
  for (const ts of j.tilesets) for (const s of ts.sources) {
    const a = s.affineTransform;
    tiles.push({ url: `https://storage.googleapis.com/open-buildings-temporal-data/v1/geotiffs/${cell}${s.uris[0]}`, proj, x0: a.translateX, y1: a.translateY, w: s.dimensions.width, h: s.dimensions.height, scale: a.scaleX, buildings: [] });
  }
}
console.log(tiles.length, 'rasters in manifests');
const byProj = new Map(); for (const t of tiles) { if (!byProj.has(t.proj)) byProj.set(t.proj, []); byProj.get(t.proj).push(t); }
// Rasters are not aligned to a grid, so hash each one into every 12.5 km cell it touches and test bounds exactly.
const CELL = 12500, index = new Map();
for (const t of tiles) { const x1 = t.x0 + t.w * t.scale, y0 = t.y1 - t.h * Math.abs(t.scale); for (let cx = Math.floor(t.x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(t.y1 / CELL); cy++) { const k = `${t.proj}|${cx}|${cy}`; if (!index.has(k)) index.set(k, []); index.get(k).push(t); } }
const find = (lon, lat) => { for (const [proj] of byProj) { const [x, y] = proj4(proj, [lon, lat]); for (const t of index.get(`${proj}|${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`) ?? []) if (x >= t.x0 && x < t.x0 + t.w * t.scale && y <= t.y1 && y > t.y1 - t.h * Math.abs(t.scale)) return { t, x, y }; } return null; };

console.log('pass 1: bucketing footprints by raster');
let n = 0;
const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.includes('"building"')) continue;
  const f = JSON.parse(line); if (f.properties.kind !== 'building') continue;
  const r = f.geometry.coordinates[0]; let x = 0, y = 0; for (let i = 0; i < r.length - 1; i++) { x += r[i][0]; y += r[i][1]; }
  const hit = find(x / (r.length - 1), y / (r.length - 1)); if (!hit) continue;
  hit.t.buildings.push([f.properties.id, hit.x, hit.y, f.properties.osm_floors ?? 0]);
  if (++n % 200000 === 0) console.log('  ', n);
}
const chosen = tiles.filter((t) => t.buildings.length >= MIN_BUILDINGS).sort((a, b) => b.buildings.length - a.buildings.length).slice(0, MAX_TILES);
console.log(`${n} footprints inside rasters; ${chosen.length} rasters chosen covering ${chosen.reduce((a, t) => a + t.buildings.length, 0)} footprints`);

const heights = {}; let got = 0;
for (const [i, t] of chosen.entries()) {
  const t0 = Date.now();
  try {
    const tiff = await fromUrl(t.url, { allowFullFile: false });
    const count = await tiff.getImageCount();
    let pick = 0; for (let k = 0; k < count; k++) { const im = await tiff.getImage(k); if (im.getWidth() >= 1500 && im.getWidth() < 3200) { pick = k; break; } if (im.getWidth() >= 3200) pick = k; }
    const im = await tiff.getImage(pick); const W = im.getWidth(), H = im.getHeight();
    const [height] = await im.readRasters({ samples: [1] }); // band 1 is building height in metres; presence averages away at this overview
    const px = (t.w * t.scale) / W, py = (t.h * Math.abs(t.scale)) / H;
    let hit = 0;
    for (const [id, x, y, osm] of t.buildings) {
      if (osm) continue; // OSM already knows
      const cx = Math.floor((x - t.x0) / px), cy = Math.floor((t.y1 - y) / py);
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const k = Y * W + X; if (height[k] > best) best = height[k]; }
      if (best < 2.4) continue;
      heights[id] = Math.max(1, Math.min(40, Math.round(best / FLOOR_M))); hit++;
    }
    got += hit;
    console.log(`[${i + 1}/${chosen.length}] ${t.url.split('/').pop()} ${W}px ${t.buildings.length} footprints → ${hit} heights (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) { console.log(`[${i + 1}/${chosen.length}] failed: ${e.message}`); }
  writeFileSync(`${out}/heights.json`, JSON.stringify(heights));
}
console.log(`done: ${got} footprints with real heights → ${out}/heights.json`);
