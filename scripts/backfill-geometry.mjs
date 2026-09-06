// One-time: plots claimed from the old Guwahati GeoJSON have no geometry stored. Give them one from that file.
// Usage: ADMIN_TOKEN=… API=https://citynovus.com node scripts/backfill-geometry.mjs public/data/world.geojson
import { readFileSync } from 'node:fs';
const API = (process.env.API ?? 'http://localhost:8080').replace(/\/$/, '');
const file = process.argv[2] ?? 'public/data/world.geojson';
const world = JSON.parse(readFileSync(file, 'utf8'));
const geoms = new Map(world.features.map((f) => [f.properties.id, f.geometry]));
const r = await fetch(`${API}/api/admin/backfill-geometry`, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ geometries: Object.fromEntries(geoms) }) });
console.log(r.status, await r.text());
