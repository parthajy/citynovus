// The OSM footprints, read from the same PMTiles archive the browser uses, so guardrails can see
// what is on the ground without holding all of Assam in memory.
import { readFileSync, openSync, readSync, fstatSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PMTiles, type Source, type RangeResponse } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Position } from 'geojson';
import type { Footprint, Kind } from '../shared/rules';

class FileTileSource implements Source {
  private fd: number;
  constructor(private path: string) { this.fd = openSync(path, 'r'); }
  getKey() { return this.path; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.alloc(length);
    const n = readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) };
  }
  size() { return fstatSync(this.fd).size; }
}

const Z = 15; // the zoom where every footprint is present
const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;

export class World {
  private pm: PMTiles | null = null;
  private neighbourhoods: { name: string; lon: number; lat: number }[] = [];
  private cache = new Map<string, { at: number; feats: Footprint[] }>();
  private ids = new Set<string>(); // ids seen so far, for cheap "is this an OSM id" checks

  constructor(tilesFile: string, placesFile: string) {
    if (existsSync(tilesFile)) {
      this.pm = new PMTiles(new FileTileSource(tilesFile), undefined, (buf, compression) => Promise.resolve(compression === 2 ? new Uint8Array(gunzipSync(Buffer.from(buf))).buffer : buf));
      console.log(`world: tiles at ${tilesFile}`);
    } else console.log(`world: no tiles at ${tilesFile}; guardrails see only stored plots`);
    try {
      const places = JSON.parse(readFileSync(placesFile, 'utf8')) as { places: { name: string; lon: number; lat: number }[] };
      this.neighbourhoods = places.places;
    } catch { /* optional */ }
    console.log(`world: ${this.neighbourhoods.length} places`);
  }

  private async tile(x: number, y: number): Promise<Footprint[]> {
    const key = `${x}/${y}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.feats;
    const feats: Footprint[] = [];
    if (this.pm) {
      const t = await this.pm.getZxy(Z, x, y);
      if (t) {
        const vt = new VectorTile(new Pbf(new Uint8Array(t.data)));
        const layer = vt.layers.osm;
        if (layer) for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          const id = String(f.properties.id ?? ''), kind = String(f.properties.kind ?? '') as Kind;
          if (!id) continue;
          const geom = f.loadGeometry();
          if (!geom.length) continue;
          const ring: Position[] = geom[0].map((p) => {
            const gx = x + p.x / f.extent, gy = y + p.y / f.extent;
            const lon = (gx / 2 ** Z) * 360 - 180;
            const n = Math.PI - (2 * Math.PI * gy) / 2 ** Z;
            return [lon, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
          });
          if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
          feats.push({ id, kind, ring });
          this.ids.add(id);
        }
      }
    }
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: Date.now(), feats });
    return feats;
  }

  /** OSM footprints around a ring, plus stored plots; a stored plot's geometry overrides the OSM one. */
  async footprintsNear(ring: Position[], plots: Iterable<{ id: string; kind: Kind; geometry: { coordinates: Position[][] } | null; hidden: boolean }>): Promise<Footprint[]> {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    const pad = 0.0005;
    const x0 = Math.floor(lon2x(minX - pad, Z)), x1 = Math.floor(lon2x(maxX + pad, Z)), y0 = Math.floor(lat2y(maxY + pad, Z)), y1 = Math.floor(lat2y(minY - pad, Z));
    const seen = new Set<string>();
    const out: Footprint[] = [];
    for (const p of plots) {
      seen.add(p.id);
      if (p.geometry) out.push({ id: p.id, kind: p.kind, ring: p.geometry.coordinates[0], hidden: p.hidden });
    }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      for (const f of await this.tile(x, y)) if (!seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
    return out;
  }

  /** Does this OSM id exist? Checked against the tile that would contain it, given a hint position. */
  async has(id: string, near?: Position): Promise<boolean> {
    if (this.ids.has(id)) return true;
    if (!near || !this.pm) return /^(way|rel)\/\d+$/.test(id) && !this.pm; // without tiles, trust the id shape
    const x = Math.floor(lon2x(near[0], Z)), y = Math.floor(lat2y(near[1], Z));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((await this.tile(x + dx, y + dy)).some((f) => f.id === id)) return true;
    return false;
  }

  nearestNeighbourhood(lon: number, lat: number): string {
    const k = Math.cos((lat * Math.PI) / 180);
    let best = 'Unassigned', bestD = Infinity;
    for (const p of this.neighbourhoods) {
      const dx = (lon - p.lon) * k, dy = lat - p.lat, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p.name; }
    }
    return best;
  }
}
