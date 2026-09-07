import type maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';

/**
 * Little cars driving the real streets. Roads come from whatever basemap road lines are on screen;
 * cars pick one, drive to its end (on the left, this is India) and pick another. Cheap: a few dozen
 * boxes re-sent to one GeoJSON source about ten times a second, only when zoomed in.
 */
interface Road { pts: Position[]; cum: number[]; length: number }
interface Car { road: number; t: number; dir: 1 | -1; speed: number; colour: string; w: number; l: number; h: number }
const COLOURS = ['#e63946', '#f4a261', '#ffffff', '#2a9d8f', '#264653', '#ffd166', '#8ecae6', '#ffffff', '#bdbdbd', '#6a4c93'];
const ROAD_LAYERS = ['highway_minor', 'highway_major_inner', 'highway_motorway_inner'];

export class Traffic {
  private roads: Road[] = [];
  private cars: Car[] = [];
  private timer: number | null = null;
  private last = 0;
  private rebuildQueued = false;
  constructor(private map: maplibregl.Map, private night: () => boolean) {}

  start() {
    if (!this.map.getSource('cars')) {
      this.map.addSource('cars', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ id: 'cars', type: 'fill-extrusion', source: 'cars', minzoom: 15.5, paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.98 } });
    }
    this.map.on('moveend', () => this.queueRebuild());
    this.map.on('idle', () => { if (this.rebuildQueued) this.rebuild(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else this.resume(); });
    this.queueRebuild();
    this.resume();
  }
  private queueRebuild() { this.rebuildQueued = true; }
  private stop() { if (this.timer !== null) { cancelAnimationFrame(this.timer); this.timer = null; } }
  private resume() { if (this.timer === null) { this.last = performance.now(); this.timer = requestAnimationFrame((t) => this.tick(t)); } }

  private rebuild() {
    this.rebuildQueued = false;
    if (this.map.getZoom() < 15.5) { this.roads = []; this.cars = []; this.push(); return; }
    const seen = new Set<string>();
    const roads: Road[] = [];
    let feats: maplibregl.MapGeoJSONFeature[] = [];
    try { feats = this.map.queryRenderedFeatures({ layers: ROAD_LAYERS.filter((l) => this.map.getLayer(l)) }); } catch { feats = []; }
    for (const f of feats) {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const pts of lines) {
        if (pts.length < 2) continue;
        const key = pts[0].join(',') + '|' + pts[pts.length - 1].join(',');
        if (seen.has(key)) continue; seen.add(key);
        const cum = [0]; const kx = 111320 * Math.cos((pts[0][1] * Math.PI) / 180);
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * kx, (pts[i][1] - pts[i - 1][1]) * 111320));
        const length = cum[cum.length - 1];
        if (length >= 40) roads.push({ pts, cum, length });
      }
    }
    this.roads = roads;
    const want = roads.length ? Math.min(window.innerWidth < 720 ? 14 : 30, Math.max(8, Math.round(roads.reduce((a, r) => a + r.length, 0) / 60))) : 0;
    this.cars = this.cars.filter((c) => c.road < roads.length).slice(0, want);
    while (this.cars.length < want) this.cars.push(this.spawn());
    for (const c of this.cars) if (c.t > this.roads[c.road].length) c.t = Math.random() * this.roads[c.road].length;
  }
  private spawn(): Car {
    const road = Math.floor(Math.random() * this.roads.length);
    const truck = Math.random() < 0.12;
    return { road, t: Math.random() * this.roads[road].length, dir: Math.random() < 0.5 ? 1 : -1, speed: truck ? 6 + Math.random() * 3 : 8 + Math.random() * 6, colour: COLOURS[Math.floor(Math.random() * COLOURS.length)], w: truck ? 2.4 : 2.0, l: truck ? 7.5 : 4.6, h: truck ? 2.8 : 1.6 };
  }
  private tick(now: number) {
    this.timer = requestAnimationFrame((t) => this.tick(t));
    const dt = Math.min(0.2, (now - this.last) / 1000);
    if (dt < 0.09) return; // ~11 updates a second is plenty for toy cars
    this.last = now;
    if (!this.cars.length) return;
    for (const c of this.cars) {
      c.t += c.dir * c.speed * dt;
      const r = this.roads[c.road];
      if (!r || c.t < 0 || c.t > r.length) Object.assign(c, this.spawn(), { colour: c.colour, w: c.w, l: c.l, h: c.h, speed: c.speed });
    }
    this.push();
  }
  private push() {
    const src = this.map.getSource('cars') as maplibregl.GeoJSONSource | undefined; if (!src) return;
    const out: Feature<Polygon, { colour: string; base: number; height: number }>[] = [];
    const night = this.night();
    for (const c of this.cars) {
      const r = this.roads[c.road]; if (!r) continue;
      let i = 1; while (i < r.cum.length - 1 && r.cum[i] < c.t) i++;
      const a = r.pts[i - 1], b = r.pts[i];
      const seg = Math.max(0.01, r.cum[i] - r.cum[i - 1]); const k = Math.min(1, Math.max(0, (c.t - r.cum[i - 1]) / seg));
      const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
      const dx = (b[0] - a[0]) * kx * c.dir, dy = (b[1] - a[1]) * 111320 * c.dir; const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len; const nx = -uy, ny = ux; // left of travel
      const cx = (a[0] + (b[0] - a[0]) * k) + (nx * 1.9) / kx, cy = (a[1] + (b[1] - a[1]) * k) + (ny * 1.9) / 111320;
      const box = (l: number, w: number): Position[] => { const hx = ux * l / 2, hy = uy * l / 2, wx = nx * w / 2, wy = ny * w / 2; const ring = [[hx + wx, hy + wy], [hx - wx, hy - wy], [-hx - wx, -hy - wy], [-hx + wx, -hy + wy]].map(([x, y]) => [cx + x / kx, cy + y / 111320] as Position); ring.push(ring[0]); return ring; };
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(c.l, c.w)] }, properties: { colour: c.colour, base: 0.25, height: c.h * 0.62 } });
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(c.l * 0.55, c.w * 0.9)] }, properties: { colour: night ? '#3a4250' : '#2b3540', base: c.h * 0.62, height: c.h } });
      if (night) out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(c.l * 0.15, c.w * 0.8).map((p, idx, arr) => idx < arr.length ? [p[0] + (ux * c.l * 0.45) / kx, p[1] + (uy * c.l * 0.45) / 111320] as Position : p)] }, properties: { colour: '#fff4c2', base: 0.4, height: 0.7 } });
    }
    const fc: FeatureCollection = { type: 'FeatureCollection', features: out };
    src.setData(fc);
  }
}
