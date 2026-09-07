import type maplibregl from 'maplibre-gl';
import type { Position } from 'geojson';

/** Player photos float above their plots as small billboards once you are close enough to read them. */
interface Card { id: string; url: string; at: Position; height: number }
export class Billboards {
  private loaded = new Set<string>();
  private timer: number | null = null;
  constructor(private map: maplibregl.Map, private cards: () => Card[]) {}
  start() {
    this.map.addSource('billboards', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({ id: 'billboards', type: 'symbol', source: 'billboards', minzoom: 16.5, layout: { 'icon-image': ['get', 'img'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 16.5, 0.35, 19, 0.8], 'icon-allow-overlap': false, 'icon-anchor': 'bottom', 'icon-offset': [0, -6], 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport' } });
    this.map.on('moveend', () => this.refresh());
    this.refresh();
  }
  refresh() { if (this.timer !== null) clearTimeout(this.timer); this.timer = window.setTimeout(() => { this.timer = null; void this.run(); }, 200); }
  private async run() {
    const src = this.map.getSource('billboards') as maplibregl.GeoJSONSource | undefined; if (!src) return;
    if (this.map.getZoom() < 16.5) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    const b = this.map.getBounds();
    const cards = this.cards().filter((c) => c.at[0] > b.getWest() && c.at[0] < b.getEast() && c.at[1] > b.getSouth() && c.at[1] < b.getNorth()).slice(0, 40);
    await Promise.all(cards.map((c) => this.ensure(c)));
    src.setData({ type: 'FeatureCollection', features: cards.filter((c) => this.map.hasImage('bb-' + c.id)).map((c) => ({ type: 'Feature', properties: { img: 'bb-' + c.id }, geometry: { type: 'Point', coordinates: c.at } })) });
  }
  private ensure(c: Card): Promise<void> {
    const key = 'bb-' + c.id;
    if (this.loaded.has(key)) return Promise.resolve();
    this.loaded.add(key);
    return new Promise((res) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          // polaroid: photo scaled into a 120px card with a white frame and a soft shadow
          const W = 120, H = 96, F = 5; const cv = document.createElement('canvas'); cv.width = W + 8; cv.height = H + 12; const ctx = cv.getContext('2d'); if (!ctx) return res();
          ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(4, 8, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
          const s = Math.max((W - 2 * F) / im.width, (H - 2 * F - 6) / im.height); const dw = im.width * s, dh = im.height * s;
          ctx.save(); ctx.beginPath(); ctx.rect(F, F, W - 2 * F, H - 2 * F - 6); ctx.clip(); ctx.drawImage(im, F + (W - 2 * F - dw) / 2, F + (H - 2 * F - 6 - dh) / 2, dw, dh); ctx.restore();
          if (!this.map.hasImage(key)) this.map.addImage(key, ctx.getImageData(0, 0, cv.width, cv.height), { pixelRatio: 1 });
        } catch { /* tainted canvas or decode error: no card */ }
        res();
      };
      im.onerror = () => res();
      im.src = c.url;
    });
  }
}
