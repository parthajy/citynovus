// Colours in a few hundred buildings around well-known spots so the city is never empty on day one.
// Usage: API=http://localhost:8080 SEED=300 node scripts/seed.mjs
import { readFileSync } from 'node:fs';

const API = (process.env.API ?? 'http://localhost:8080').replace(/\/$/, '');
const N = Number(process.env.SEED ?? 300);
const DEVICE = 'seed-citynovus-000001';
const CENTRES = [[91.7505, 26.1855], [91.7440, 26.1990], [91.7650, 26.1600], [91.7360, 26.1450]]; // Ambari, Uzan Bazar, Zoo Road side, Paltan Bazar side
const PALETTE = ['#f2c14e', '#e07a5f', '#d94f4f', '#f4a261', '#8ab17d', '#3d8b6e', '#5b8def', '#3a5ba0', '#b57edc', '#8d6e63', '#f5f0e6', '#4a4a4a'];
const ROOFS = ['tin', 'tin', 'tiled', 'flat', 'flat', 'thatch'];
const USES = ['house', 'house', 'house', 'shop', 'shop', 'restaurant', 'office', 'school'];
const STYLES = ['assam-type', 'rcc', 'rcc', 'shophouse', 'colonial'];

const world = JSON.parse(readFileSync('public/data/world.geojson', 'utf8'));
const buildings = world.features.filter((f) => f.properties.kind === 'building');
const centroid = (r) => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; };
const d2 = (a, b) => ((a[0] - b[0]) * 0.9) ** 2 + (a[1] - b[1]) ** 2;
const ranked = buildings.map((f) => { const c = centroid(f.geometry.coordinates[0]); return { f, d: Math.min(...CENTRES.map((k) => d2(c, k))) }; }).sort((a, b) => a.d - b.d);

// With ADMIN_TOKEN the seed runs as the house account; without it, as a guest (provisional, expires).
let cookie = '';
if (process.env.ADMIN_TOKEN) {
  const r = await fetch(API + '/api/admin/system-session', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } });
  if (!r.ok) throw new Error('admin token rejected');
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  console.log('seeding as the CityNovus house account');
} else console.log('no ADMIN_TOKEN: seeding as a guest, which is provisional and expires');
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

if (!cookie) await call('POST', '/api/me', { name: 'CityNovus' });
const existing = new Set((await call('GET', '/api/plots')).map((p) => p.id));
let done = 0, skipped = 0;
for (const { f } of ranked) {
  if (done >= N) break;
  const id = f.properties.id;
  if (existing.has(id)) { skipped++; continue; }
  const use = pick(USES);
  const floors = f.properties.osm_floors ?? (use === 'house' ? 1 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 4));
  try {
    await call('POST', `/api/plots/${encodeURIComponent(id)}/edit`, {
      ctx: { kind: 'building', geometry: null, neighbourhood: f.properties.neighbourhood },
      changes: { floors, colour: pick(PALETTE), style: pick(STYLES), roof: pick(ROOFS), name: f.properties.osm_name ?? null, use, photo_url: null, props: {} },
    });
    done++;
    if (done % 25 === 0) { console.log(`  ${done} buildings`); await new Promise((r) => setTimeout(r, 1500)); } // stay under the per-minute rate limit
  } catch (e) {
    if (String(e.message).includes('Slow down')) { await new Promise((r) => setTimeout(r, 20000)); } else console.log('skip', id, e.message);
  }
}
console.log(`seeded ${done} buildings (${skipped} already built)`);
