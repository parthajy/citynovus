import type maplibregl from 'maplibre-gl';
import { SATELLITE_TILES } from './config';

/**
 * Grey buildings borrow their colour from the satellite photo underneath: the roof pixel under each
 * footprint, muted so grey still reads as "nobody has claimed this". One imagery tile serves every
 * building inside it, so a screenful costs a few dozen small JPEGs, fetched once and cached.
 */
const Z = 17;
export class Tint {
  private tiles = new Map<string, Promise<ImageData | null>>();
  private done = new Set<string>();
  private timer: number | null = null;
  constructor(private map: maplibregl.Map, private night: () => boolean) {}
  start() {
    this.map.on('moveend', () => this.queue());
    this.map.on('sourcedata', (e) => { if (e.sourceId === 'osm' && e.isSourceLoaded) this.queue(); });
    this.queue();
  }
  private queue() { if (this.timer !== null) clearTimeout(this.timer); this.timer = window.setTimeout(() => { this.timer = null; void this.run(); }, 250); }
  private async run() {
    if (this.map.getZoom() < 15.5 || !this.map.getSource('osm')) return;
    let feats: maplibregl.MapGeoJSONFeature[] = [];
    try { feats = this.map.queryRenderedFeatures({ layers: ['osm-buildings'] }); } catch { return; }
    const jobs: { id: string; lon: number; lat: number }[] = [];
    for (const f of feats) {
      const id = String(f.properties.id);
      if (this.done.has(id) || f.geometry.type !== 'Polygon') continue;
      this.done.add(id);
      const r = f.geometry.coordinates[0]; let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; }
      jobs.push({ id, lon: x / r.length, lat: y / r.length });
      if (jobs.length >= 1500) break;
    }
    if (!jobs.length) return;
    const n = 2 ** Z;
    const byTile = new Map<string, { id: string; px: number; py: number }[]>();
    for (const j of jobs) {
      const tx = ((j.lon + 180) / 360) * n; const latR = (j.lat * Math.PI) / 180; const ty = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
      const key = `${Math.floor(tx)}/${Math.floor(ty)}`;
      const list = byTile.get(key) ?? []; list.push({ id: j.id, px: Math.floor((tx % 1) * 256), py: Math.floor((ty % 1) * 256) }); byTile.set(key, list);
    }
    const night = this.night();
    await Promise.all([...byTile.entries()].map(async ([key, list]) => {
      const img = await this.tile(key); if (!img) return;
      for (const b of list) {
        // average a 5×5 patch so a single bright pixel does not paint the roof white
        let r = 0, g = 0, bl = 0, c = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = b.px + dx, y = b.py + dy; if (x < 0 || y < 0 || x >= 256 || y >= 256) continue; const i = (y * 256 + x) * 4; r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2]; c++; }
        if (!c) continue;
        r /= c; g /= c; bl /= c;
        // keep the hue, lift towards the grey so unclaimed stays unclaimed-looking
        const mixTo = night ? [0x6b, 0x72, 0x80] : [0xcf, 0xcf, 0xcf]; const k = night ? 0.65 : 0.45;
        const hex = [r, g, bl].map((v, i) => Math.round(v * (1 - k) + mixTo[i] * k).toString(16).padStart(2, '0')).join('');
        this.map.setFeatureState({ source: 'osm', sourceLayer: 'osm', id: b.id }, { tint: '#' + hex });
      }
    }));
  }
  private tile(key: string): Promise<ImageData | null> {
    let p = this.tiles.get(key);
    if (!p) {
      const [x, y] = key.split('/');
      const url = SATELLITE_TILES.replace('{z}', String(Z)).replace('{x}', x).replace('{y}', y);
      p = new Promise((res) => {
        const im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = () => { try { const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256; const ctx = cv.getContext('2d'); if (!ctx) return res(null); ctx.drawImage(im, 0, 0, 256, 256); res(ctx.getImageData(0, 0, 256, 256)); } catch { res(null); } };
        im.onerror = () => res(null);
        im.src = url;
      });
      this.tiles.set(key, p);
      if (this.tiles.size > 400) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return p;
  }
}
