import maplibregl, { type ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import type { Feature, FeatureCollection, LineString, Polygon, Position } from 'geojson';
import type { Footprint, Kind, Plot, Props } from './types';
import { CITY, CIVIC_SHORT, COMMERCIAL_USES, CROPS, FLOOR_HEIGHT, FLYOVER_HEIGHT, GREY, HIDDEN, MAP_STYLE, MAX_PLANTS, MAX_TREES, NIGHT_STYLE, PALETTE, ROOF_COLOURS, SATELLITE_ATTRIBUTION, SATELLITE_TILES, TILES_URL, TREE_M2, cropStage, hoardingActive, lineWidth } from './config';
import { centroid, circleRing, darken, insetRing, lineSegments, ringAreaM2, scatterInRing, seeded } from './geo';
import { Traffic } from './traffic';

maplibregl.addProtocol('pmtiles', new Protocol().tile);

export interface WorldProps {
  id: string;
  kind: Kind;
  neighbourhood: string;
  osm_floors: number | null;
  osm_name: string | null;
  osm_building: string | null;
  line: Position[] | null; // centre line for flyover/road
  floors: number;
  colour: string | null; // what the player chose
  wall: string | null; // what we paint (style-adjusted)
  ground: string | null; // shopfront band colour
  commercial: boolean;
  name: string | null;
  roof: string | null;
  style: string | null;
  props: Props;
  hoarding: string | null;
  sign: string | null;
  civic: string | null; // civic subtype label for the marker
  resolved: boolean;
  owner_name: string | null;
  built: boolean;
  hidden: boolean;
  provisional: boolean;
  sprite: string | null; // window pattern image for the walls
}
interface DecorProps { dk: 'roof' | 'slab' | 'band' | 'trunk' | 'canopy' | 'pier' | 'plant' | 'board' | 'deck' | 'model' | 'glow' | 'lot'; base: number; height: number; colour: string }

type WFeature = Feature<Polygon, WorldProps>;
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const ROOF_STEPS: Record<string, { s: number; h: number }[]> = {
  flat: [{ s: 0.96, h: 0.35 }],
  tin: [{ s: 0.97, h: 0.4 }, { s: 0.74, h: 0.9 }, { s: 0.48, h: 0.8 }],
  tiled: [{ s: 0.97, h: 0.4 }, { s: 0.74, h: 0.9 }, { s: 0.48, h: 0.8 }],
  thatch: [{ s: 0.98, h: 0.5 }, { s: 0.74, h: 1.0 }, { s: 0.45, h: 0.9 }],
  dome: [{ s: 0.9, h: 0.6 }, { s: 0.72, h: 0.6 }, { s: 0.52, h: 0.6 }, { s: 0.3, h: 0.6 }],
};
const CANOPY = ['#4f8a4b', '#5e9a52', '#3f7a3e', '#6aa35a'];
const OSM_MINZOOM = 11;

function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a), pb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b);
  if (!pa || !pb) return a;
  const c = [1, 2, 3].map((i) => Math.round(parseInt(pa[i], 16) * (1 - t) + parseInt(pb[i], 16) * t).toString(16).padStart(2, '0'));
  return '#' + c.join('');
}
/** Shrink a ring across its long axis only, so stacked steps form a ridge: a gable roof out of extrusions. */
function squeezeRing(ring: Position[], s: number, along = 1): Position[] {
  const c = centroid(ring);
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 111320;
  const pts = ring.map(([x, y]) => [(x - c[0]) * kx, (y - c[1]) * ky]);
  // long axis: the edge direction that gives the smallest bounding box
  let best = 0, bestArea = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { const rx = x * Math.cos(-a) - y * Math.sin(-a), ry = x * Math.sin(-a) + y * Math.cos(-a); x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry); }
    const w = x1 - x0, h = y1 - y0, area = w * h;
    if (area < bestArea) { bestArea = area; best = w >= h ? a : a + Math.PI / 2; }
  }
  const ca = Math.cos(-best), sa = Math.sin(-best);
  return pts.map(([x, y]) => {
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    const qx = rx * along, qy = ry * s;
    const bx = qx * Math.cos(best) - qy * Math.sin(best), by = qx * Math.sin(best) + qy * Math.cos(best);
    return [c[0] + bx / kx, c[1] + by / ky] as Position;
  });
}

/** A repeating window sprite for extrusion walls: one wall colour, a grid of panes, lit or dark. */
function windowSprite(wall: string, night: boolean, glass: string): ImageData | null {
  const size = 48;
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d'); if (!ctx) return null;
  ctx.fillStyle = wall; ctx.fillRect(0, 0, size, size);
  const cols = 3, rows = 2, pw = 8, ph = 11;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = Math.round((c + 0.5) * (size / cols) - pw / 2), y = Math.round((r + 0.5) * (size / rows) - ph / 2);
    const lit = night && ((r * 3 + c + wall.length) % 3 !== 0);
    ctx.fillStyle = darken(wall, 0.72); ctx.fillRect(x - 1, y - 1, pw + 2, ph + 2); // frame
    ctx.fillStyle = night ? (lit ? '#ffe08a' : '#2a3140') : glass; ctx.fillRect(x, y, pw, ph);
    if (!night) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x, y, pw, 3); }
  }
  return ctx.getImageData(0, 0, size, size);
}

function wallColour(colour: string | null, style: string | null): string | null {
  if (!colour) return null;
  if (style === 'modern') return mix(colour, '#a9cfe8', 0.55);
  if (style === 'bamboo') return mix(colour, '#a67c52', 0.35);
  if (style === 'colonial') return mix(colour, '#f5f0e6', 0.3);
  return colour;
}

/**
 * Two worlds on one map. The 'osm' source streams every footprint in Assam from vector tiles and draws them grey.
 * The 'world' source holds only what players have built (with geometry), plus whatever is being previewed.
 * A footprint that has been claimed is hidden in the tiles through feature-state, so nothing is drawn twice.
 */
export class WorldMap {
  readonly map: maplibregl.Map;
  night = false;
  satellite = false;
  private features = new Map<string, WFeature>(); // the world source
  private totals = new Map<string, number>(); // neighbourhood → OSM footprints, from neighbourhoods.json
  private centres = new Map<string, [number, number]>();
  private districts = new Map<string, string>(); // neighbourhood → district
  private ready: Promise<void>;
  private sun: { azimuth: number; altitude: number } | null = null;
  private traffic: Traffic | null = null;
  onSelect: (id: string | null) => void = () => {};
  /** Return true to swallow the click (used while tracing). */
  onMapClick: (lngLat: [number, number]) => boolean = () => false;

  constructor(container: string) {
    this.map = new maplibregl.Map({
      container,
      style: MAP_STYLE,
      center: CITY.center,
      zoom: CITY.zoom,
      pitch: 55,
      bearing: -17,
      maxPitch: 72,
      maxBounds: CITY.bounds,
      attributionControl: false,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    this.ready = new Promise((res) => this.map.once('load', () => res()));
    this.map.on('styleimagemissing', (e) => { if (!this.map.hasImage(e.id)) this.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  }

  private blank(id: string, kind: Kind, neighbourhood: string, geometry: Polygon, extra: Partial<WorldProps> = {}): WFeature {
    return {
      type: 'Feature',
      geometry,
      properties: {
        id, kind, neighbourhood,
        osm_floors: null, osm_name: null, osm_building: null, line: null,
        floors: 1, colour: null, wall: null, ground: null, commercial: false, name: null, roof: null, style: null, props: {},
        hoarding: null, sign: null, civic: null, resolved: false, owner_name: null, built: false, hidden: false, provisional: false, sprite: null,
        ...extra,
      },
    };
  }

  setTotals(list: { name: string; district?: string; total: number; c: [number, number] }[]) {
    for (const n of list) { this.totals.set(n.name, n.total); this.centres.set(n.name, n.c); this.districts.set(n.name, n.district ?? 'Assam'); }
    const src = this.map.getSource('coverage') as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: list.filter((n) => n.total >= 20).map((n) => ({ type: 'Feature', properties: { name: n.name, total: n.total }, geometry: { type: 'Point', coordinates: n.c } })) });
  }
  neighbourhoodCentre(name: string) { return this.centres.get(name); }
  districtOf(neighbourhood: string) { return this.districts.get(neighbourhood) ?? 'Assam'; }
  /** The neighbourhood whose centre is closest to a point (used to guess the district under the camera). */
  nearestNeighbourhood(lon: number, lat: number): string | null {
    const kx = Math.cos((lat * Math.PI) / 180);
    let best: string | null = null, bd = Infinity;
    for (const [name, c] of this.centres) { const d = ((c[0] - lon) * kx) ** 2 + (c[1] - lat) ** 2; if (d < bd) { bd = d; best = name; } }
    return best;
  }

  /** Toy-city ground: flat green lots, pale roads with sidewalks and a dashed centre line, soft water. */
  private toyBasemap() {
    const m = this.map, n = this.night;
    const set = (id: string, prop: string, v: unknown) => { if (m.getLayer(id)) m.setPaintProperty(id, prop, v as never); };
    set('background', 'background-color', n ? '#232a36' : '#dbe7c6');
    set('landuse_residential', 'fill-color', n ? '#28303c' : '#d6e3bd'); set('landuse_residential', 'fill-opacity', 1);
    set('park', 'fill-color', n ? '#2c3d33' : '#b9dc96');
    set('landcover_wood', 'fill-color', n ? '#2a3a30' : '#a8d287');
    set('water', 'fill-color', n ? '#2f4a6b' : '#93c5ea');
    set('waterway', 'line-color', n ? '#2f4a6b' : '#93c5ea');
    const road = n ? '#4a5262' : '#c9d3dd', side = n ? '#5b6474' : '#f2f5f8';
    set('highway_minor', 'line-color', road); set('highway_minor', 'line-opacity', 1);
    set('highway_minor', 'line-width', ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1.8, 16, 6, 20, 34]);
    set('highway_major_inner', 'line-color', road);
    set('highway_major_inner', 'line-width', ['interpolate', ['exponential', 1.4], ['zoom'], 10, 2, 16, 10, 20, 44]);
    set('highway_major_casing', 'line-color', side);
    set('highway_major_casing', 'line-width', ['interpolate', ['exponential', 1.4], ['zoom'], 10, 3, 16, 14, 20, 54]);
    set('highway_motorway_inner', 'line-color', road);
    set('highway_motorway_casing', 'line-color', side);
    set('highway_path', 'line-color', n ? '#55607a' : '#e3e8d8');
    const layers = m.getStyle().layers ?? [];
    for (const id of ['highway_minor', 'highway_major_inner', 'highway_motorway_inner']) {
      const at = layers.findIndex((l) => l.id === id); if (at < 0) continue;
      const base = layers[at] as maplibregl.LineLayerSpecification;
      const cid = `toy-centre-${id}`;
      if (!m.getLayer(cid)) {
        const next = layers[at + 1]?.id;
        m.addLayer({ id: cid, type: 'line', source: base.source, 'source-layer': base['source-layer'], ...(base.filter ? { filter: base.filter } : {}), minzoom: 15.5, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 15.5, 0.8, 18, 2], 'line-dasharray': [3, 3], 'line-opacity': 0.9 } }, next);
      }
      m.setPaintProperty(cid, 'line-color', n ? '#8b93a3' : '#ffffff');
    }
    // The basemap's own buildings would fight ours; ours live on other sources and stay.
    for (const layer of layers) if (layer.type === 'fill' && (layer as maplibregl.FillLayerSpecification)['source-layer'] === 'building') m.setLayoutProperty(layer.id, 'visibility', 'none');
    set('osm-park', 'fill-color', n ? '#2c3d33' : '#e3ebdc');
    set('osm-water', 'fill-color', n ? '#2f4a6b' : '#dbe8f2'); set('osm-water-line', 'line-color', n ? '#3d5a7e' : '#b9cfe0');
    set('osm-flyover', 'fill-color', n ? '#3a4250' : '#dedede'); set('osm-flyover-line', 'line-color', n ? '#555f70' : '#b9b9b9');
    set('osm-buildings', 'fill-extrusion-color', n ? '#6b7280' : GREY);
    set('coverage', 'circle-color', n ? '#9fb3c8' : '#104050');
    this.loadSprites();
  }
  private loadSprites() {
    const glass = '#7fa7c9';
    for (const c of [...PALETTE, GREY]) for (const style of [null, 'modern', 'bamboo', 'colonial']) {
      const wall = wallColour(c, style) ?? c;
      const id = `win-${wall.slice(1)}-${this.night ? 'n' : 'd'}`;
      if (this.map.hasImage(id)) continue;
      const img = windowSprite(wall, this.night, style === 'modern' ? '#5d7f9c' : glass);
      if (img) this.map.addImage(id, img, { pixelRatio: 1 });
    }
  }

  async load(states: Plot[]) {
    await this.ready;
    for (const b of states) this.mergeState(b, false);

    this.toyBasemap();
    for (const f of this.features.values()) f.properties.sprite = this.spriteFor(f.properties); // stored plots arrived before the sprites did
    this.applyAtmosphere();

    this.map.addSource('osm', { type: 'vector', url: `pmtiles://${TILES_URL}`, promoteId: { osm: 'id' }, minzoom: OSM_MINZOOM, maxzoom: 15 });
    this.map.addSource('world', { type: 'geojson', data: this.collection(), promoteId: 'id' });
    this.map.addSource('decor', { type: 'geojson', data: this.decor() });
    this.map.addSource('lines', { type: 'geojson', data: this.lines() });
    this.map.addSource('draw', { type: 'geojson', data: EMPTY });
    this.map.addSource('coverage', { type: 'geojson', data: EMPTY });

    const kind = (...k: Kind[]) => ['in', ['get', 'kind'], ['literal', k]] as unknown as maplibregl.FilterSpecification;
    const all = (...parts: unknown[]) => ['all', ...parts] as unknown as maplibregl.FilterSpecification;
    const built: ExpressionSpecification = ['boolean', ['get', 'built'], false];
    const hidden: ExpressionSpecification = ['boolean', ['get', 'hidden'], false];
    const not = (e: ExpressionSpecification) => ['!', e] as ExpressionSpecification;
    const taken: ExpressionSpecification = ['boolean', ['feature-state', 'taken'], false]; // claimed: drawn from the world source instead
    const osm = { source: 'osm', 'source-layer': 'osm' } as const;

    this.addSatellite();

    // Where the tiles have not loaded (zoomed out), show how much of each place exists to colour in.
    this.map.addLayer({ id: 'coverage', type: 'circle', source: 'coverage', maxzoom: OSM_MINZOOM, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['interpolate', ['linear'], ['get', 'total'], 20, 2, 5000, 9], 10, ['interpolate', ['linear'], ['get', 'total'], 20, 4, 5000, 18]],
      'circle-color': '#104050', 'circle-opacity': 0.45, 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.5,
    } });
    this.map.addLayer({ id: 'coverage-labels', type: 'symbol', source: 'coverage', minzoom: 8, maxzoom: OSM_MINZOOM, filter: ['>=', ['get', 'total'], 200], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2] }, paint: { 'text-color': '#104050', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });

    // Grey Assam: everything OSM knows, from tiles.
    this.map.addLayer({ id: 'osm-park', type: 'fill', ...osm, filter: kind('park', 'playground'), paint: { 'fill-color': '#e3ebdc', 'fill-opacity': ['case', taken, 0, 0.9] } });
    this.map.addLayer({ id: 'osm-water', type: 'fill', ...osm, filter: kind('pond'), paint: { 'fill-color': '#dbe8f2', 'fill-opacity': ['case', taken, 0, 0.95] } });
    this.map.addLayer({ id: 'osm-water-line', type: 'line', ...osm, filter: kind('pond'), paint: { 'line-color': '#b9cfe0', 'line-width': 1, 'line-opacity': ['case', taken, 0, 1] } });
    this.map.addLayer({ id: 'osm-flyover', type: 'fill', ...osm, filter: kind('flyover'), paint: { 'fill-color': '#dedede', 'fill-opacity': ['case', taken, 0, 0.9] } });
    this.map.addLayer({ id: 'osm-flyover-line', type: 'line', ...osm, filter: kind('flyover'), paint: { 'line-color': '#b9b9b9', 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': ['case', taken, 0, 1] } });

    // Built ground features.
    this.map.addLayer({ id: 'park-fill', type: 'fill', source: 'world', filter: kind('park', 'playground'), paint: { 'fill-color': ['case', built, ['case', ['==', ['get', 'kind'], 'playground'], '#d3d98f', '#a9d18e'], '#e3ebdc'] } });
    this.map.addLayer({ id: 'farm-fill', type: 'fill', source: 'world', filter: kind('farm'), paint: { 'fill-color': ['case', built, '#b08d57', '#e8dcc0'] } });
    this.map.addLayer({ id: 'farm-line', type: 'line', source: 'world', filter: kind('farm'), paint: { 'line-color': ['case', built, '#8a6d3b', '#d2c3a0'], 'line-width': 1 } });
    this.map.addLayer({ id: 'water-fill', type: 'fill', source: 'world', filter: kind('pond'), paint: { 'fill-color': ['case', built, '#8dbfe3', '#dbe8f2'] } });
    this.map.addLayer({ id: 'water-line', type: 'line', source: 'world', filter: kind('pond'), paint: { 'line-color': ['case', built, '#6fa6cf', '#b9cfe0'], 'line-width': 1 } });
    this.map.addLayer({ id: 'road-fill', type: 'fill', source: 'world', filter: kind('road'), paint: { 'fill-color': ['case', built, '#6f747b', '#e4e4e4'] } });
    this.map.addLayer({ id: 'road-centre', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'road'], paint: { 'line-color': '#f5f0e6', 'line-width': 1.2, 'line-dasharray': [3, 3] } });
    this.map.addLayer({ id: 'flyover-flat', type: 'fill', source: 'world', filter: kind('flyover'), paint: { 'fill-color': '#dedede' } });
    this.map.addLayer({ id: 'flyover-flat-line', type: 'line', source: 'world', filter: all(kind('flyover'), not(built)), paint: { 'line-color': '#b9b9b9', 'line-width': 1, 'line-dasharray': [2, 2] } });
    this.map.addLayer({ id: 'tree-fill', type: 'fill', source: 'world', filter: kind('tree'), paint: { 'fill-color': '#8fbf7a', 'fill-opacity': ['case', hidden, 0.3, 0.6] } });
    this.map.addLayer({ id: 'point-fill', type: 'fill', source: 'world', filter: kind('landmark', 'furniture', 'civic'), paint: { 'fill-color': ['case', ['==', ['get', 'kind'], 'civic'], ['case', ['boolean', ['get', 'resolved'], false], '#8ab17d', '#e07a5f'], '#d9d2c5'], 'fill-opacity': ['case', hidden, 0.2, 0.45] } });
    this.map.addLayer({ id: 'rail-fill', type: 'fill', source: 'world', filter: kind('railway'), paint: { 'fill-color': ['case', built, '#5f5a55', '#e6e2dc'], 'fill-opacity': ['case', hidden, 0.3, 0.95] } });
    this.map.addLayer({ id: 'rail-sleepers', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'railway'], paint: { 'line-color': '#8a7a66', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 18, 12], 'line-dasharray': [0.4, 0.8] } });
    this.map.addLayer({ id: 'rail-line', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'railway'], paint: { 'line-color': '#c9c9c9', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1, 18, 2] } });
    this.map.addLayer({ id: 'wall-flat', type: 'line', source: 'world', filter: all(kind('wall'), not(built)), paint: { 'line-color': '#b9b1a3', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    this.map.addLayer({ id: 'lots', type: 'fill', source: 'decor', filter: ['==', ['get', 'dk'], 'lot'], paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.9 } }, 'park-fill');
    this.map.addLayer({ id: 'lots-line', type: 'line', source: 'decor', filter: ['==', ['get', 'dk'], 'lot'], paint: { 'line-color': ['get', 'colour'], 'line-width': 1, 'line-opacity': 0.6 } }, 'park-fill');
    this.map.addLayer({ id: 'glow', type: 'fill-extrusion', source: 'decor', filter: ['==', ['get', 'dk'], 'glow'], paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': 0, 'fill-extrusion-height': 0.05, 'fill-extrusion-opacity': 0.35 } });
    this.map.addLayer({ id: 'walls-3d', type: 'fill-extrusion', source: 'world', filter: all(kind('wall'), built), paint: { 'fill-extrusion-color': ['case', hidden, HIDDEN, '#b8a48c'], 'fill-extrusion-height': 2, 'fill-extrusion-opacity': 0.95 } });
    this.map.addLayer({ id: 'decor-ground', type: 'fill-extrusion', source: 'decor', filter: ['in', ['get', 'dk'], ['literal', ['trunk', 'canopy', 'pier', 'plant', 'model']]], paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95 } });

    // Grey buildings from tiles: a claimed one drops to zero height so the coloured one shows through.
    this.map.addLayer({ id: 'osm-buildings', type: 'fill-extrusion', ...osm, filter: kind('building'), paint: {
      'fill-extrusion-color': GREY,
      'fill-extrusion-height': ['case', taken, 0, ['*', ['coalesce', ['get', 'osm_floors'], 1], FLOOR_HEIGHT]],
      'fill-extrusion-opacity': 0.94,
      'fill-extrusion-vertical-gradient': true,
    } });
    // Built buildings.
    this.map.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'world', filter: all(kind('building'), ['!', ['to-boolean', ['get', 'sprite']]]), paint: {
      'fill-extrusion-color': ['case', hidden, HIDDEN, ['coalesce', ['get', 'wall'], GREY]],
      'fill-extrusion-base': ['case', ['all', built, ['boolean', ['get', 'commercial'], false]], FLOOR_HEIGHT, 0],
      'fill-extrusion-height': ['case', hidden, 0.6, ['*', ['coalesce', ['get', 'floors'], 1], FLOOR_HEIGHT]],
      'fill-extrusion-opacity': 0.94,
      'fill-extrusion-vertical-gradient': true,
    } });
    // Built walls carry a window sprite in the wall colour; the sprite name is set per feature in mergeState.
    this.map.addLayer({ id: 'buildings-win', type: 'fill-extrusion', source: 'world', filter: all(kind('building'), ['to-boolean', ['get', 'sprite']]), paint: {
      'fill-extrusion-pattern': ['get', 'sprite'],
      'fill-extrusion-base': ['case', ['boolean', ['get', 'commercial'], false], FLOOR_HEIGHT, 0],
      'fill-extrusion-height': ['*', ['coalesce', ['get', 'floors'], 1], FLOOR_HEIGHT],
      'fill-extrusion-opacity': 0.98,
      'fill-extrusion-vertical-gradient': false,
    } });
    this.map.addLayer({ id: 'ground-3d', type: 'fill-extrusion', source: 'world', filter: all(kind('building'), built, not(hidden), ['boolean', ['get', 'commercial'], false]), paint: { 'fill-extrusion-color': ['coalesce', ['get', 'ground'], GREY], 'fill-extrusion-base': 0, 'fill-extrusion-height': FLOOR_HEIGHT, 'fill-extrusion-opacity': 0.94 } });
    this.map.addLayer({ id: 'decor-roof', type: 'fill-extrusion', source: 'decor', filter: ['in', ['get', 'dk'], ['literal', ['roof', 'slab', 'band', 'board', 'deck']]], paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.96 } });

    this.map.addLayer({ id: 'world-provisional', type: 'line', source: 'world', filter: ['boolean', ['get', 'provisional'], false], paint: { 'line-color': '#e07a5f', 'line-width': 2, 'line-dasharray': [1.5, 1.5] } });
    this.map.addLayer({ id: 'world-selected', type: 'line', source: 'world', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#111', 'line-width': 3 } });

    // Names: OSM ones from tiles until claimed, then from the world.
    this.map.addLayer({ id: 'osm-labels', type: 'symbol', ...osm, minzoom: 15.5, filter: ['to-boolean', ['get', 'osm_name']], layout: { 'text-field': ['get', 'osm_name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 10, 18, 13], 'text-max-width': 8, 'text-padding': 4, 'symbol-sort-key': 1 }, paint: { 'text-color': '#222', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4, 'text-opacity': ['case', taken, 0, 1] } });
    this.map.addLayer({ id: 'world-labels', type: 'symbol', source: 'world', minzoom: 15.5, filter: all(['to-boolean', ['get', 'name']], not(hidden), ['!', ['to-boolean', ['get', 'hoarding']]]), layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 10, 18, 13], 'text-max-width': 8, 'text-padding': 4, 'symbol-sort-key': 0 }, paint: { 'text-color': '#222', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 } });
    this.map.addLayer({ id: 'signs', type: 'symbol', source: 'world', minzoom: 16.5, filter: all(['to-boolean', ['get', 'sign']], not(hidden)), layout: { 'text-field': ['get', 'sign'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-max-width': 10, 'text-offset': [0, 1.5], 'text-padding': 2, 'symbol-sort-key': 2 }, paint: { 'text-color': '#1b1b1b', 'text-halo-color': '#fff3c4', 'text-halo-width': 1.6 } });
    this.map.addLayer({ id: 'civic-labels', type: 'symbol', source: 'world', minzoom: 14, filter: all(['to-boolean', ['get', 'civic']], not(hidden)), layout: { 'text-field': ['get', 'civic'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, -1.9], 'text-padding': 4, 'symbol-sort-key': 0, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['boolean', ['get', 'resolved'], false], '#2f6f5a', '#b4532f'], 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
    this.map.addLayer({ id: 'hoardings', type: 'symbol', source: 'world', minzoom: 14.5, filter: all(['to-boolean', ['get', 'hoarding']], not(hidden)), layout: { 'text-field': ['upcase', ['get', 'hoarding']], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-max-width': 12, 'text-offset': [0, -2.2], 'text-padding': 6, 'symbol-sort-key': -1 }, paint: { 'text-color': '#ffd166', 'text-halo-color': '#1b1b1b', 'text-halo-width': 2 } });

    this.map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#5b8def', 'fill-opacity': 0.25 } });
    this.map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#5b8def', 'line-width': 2, 'line-dasharray': [2, 1] } });
    this.map.addLayer({ id: 'draw-points', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['==', ['get', 'h'], 'm'], 5, 7], 'circle-color': ['case', ['==', ['get', 'h'], 'm'], 'rgba(255,255,255,0.6)', '#fff'], 'circle-stroke-color': '#5b8def', 'circle-stroke-width': 2 } });

    this.applyGroundOpacity();
    for (const id of this.features.keys()) if (!id.startsWith('tw/')) this.map.setFeatureState({ source: 'osm', sourceLayer: 'osm', id }, { taken: true });
    this.traffic = new Traffic(this.map, () => this.night);
    this.traffic.start();

    const worldPick = ['buildings-3d', 'buildings-win', 'ground-3d', 'walls-3d', 'flyover-flat', 'tree-fill', 'point-fill', 'rail-fill', 'farm-fill', 'water-fill', 'park-fill', 'road-fill'];
    const osmPick = ['osm-buildings', 'osm-flyover', 'osm-water', 'osm-park'];
    this.map.on('click', (e) => {
      if (this.onMapClick([e.lngLat.lng, e.lngLat.lat])) return;
      const hit = this.map.queryRenderedFeatures(e.point, { layers: worldPick })[0] ?? this.map.queryRenderedFeatures(e.point, { layers: osmPick }).find((f) => !this.features.has(String(f.properties.id)));
      const id = hit ? String(hit.properties.id) : null;
      if (id && !this.features.has(id) && hit) this.adopt(hit);
      this.select(id);
      this.onSelect(id);
    });
    this.map.on('mousemove', (e) => {
      const hits = this.map.queryRenderedFeatures(e.point, { layers: [...worldPick, ...osmPick, 'draw-points'] });
      this.map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
    });
  }

  /** Copy a tile feature into the world so it can be previewed, edited and claimed. */
  private adopt(f: { properties: Record<string, unknown>; geometry: { type: string; coordinates?: unknown } }): WFeature | null {
    const p = f.properties as Record<string, unknown>;
    const id = String(p.id ?? '');
    if (!id) return null;
    const existing = this.features.get(id);
    if (existing) return existing;
    const geometry = (f.geometry.type === "Polygon" ? (f.geometry as unknown as Polygon) : f.geometry.type === "MultiPolygon" ? { type: "Polygon", coordinates: (f.geometry as unknown as { coordinates: Position[][][] }).coordinates[0] } : null) as Polygon | null;
    if (!geometry) return null;
    let line: Position[] | null = null;
    if (typeof p.line === 'string') { try { line = JSON.parse(p.line as string) as Position[]; } catch { line = null; } } else if (Array.isArray(p.line)) line = p.line as Position[];
    const floors = typeof p.osm_floors === 'number' ? p.osm_floors : null;
    const w = this.blank(id, (p.kind as Kind) ?? 'building', String(p.neighbourhood ?? 'Unassigned'), geometry, {
      osm_floors: floors, osm_name: (p.osm_name as string | null) ?? null, osm_building: (p.osm_building as string | null) ?? null, line, floors: floors ?? 1, name: (p.osm_name as string | null) ?? null,
      props: typeof p.lanes === 'number' ? { lanes: p.lanes as number, line: line ?? undefined } : {},
    });
    this.features.set(id, w);
    this.map.setFeatureState({ source: 'osm', sourceLayer: 'osm', id }, { taken: true });
    this.push();
    return w;
  }

  /** Aerial imagery under everything but the basemap's labels. */
  private addSatellite() {
    if (!this.map.getSource('satellite')) this.map.addSource('satellite', { type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 19, attribution: SATELLITE_ATTRIBUTION });
    if (!this.map.getLayer('satellite')) {
      const before = (this.map.getStyle().layers ?? []).find((l) => l.type === 'symbol')?.id;
      this.map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: this.satellite ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0 } }, before);
    }
    this.map.setPaintProperty('satellite', 'raster-brightness-max', this.night ? 0.42 : 1);
    this.map.setPaintProperty('satellite', 'raster-saturation', this.night ? -0.5 : -0.08);
  }
  setSatellite(on: boolean) {
    this.satellite = on;
    if (!this.map.loaded()) return;
    this.addSatellite();
    this.map.setLayoutProperty('satellite', 'visibility', on ? 'visible' : 'none');
    this.applyGroundOpacity();
  }
  private applyGroundOpacity() {
    const taken: ExpressionSpecification = ['boolean', ['feature-state', 'taken'], false];
    const built: ExpressionSpecification = ['boolean', ['get', 'built'], false];
    const hidden: ExpressionSpecification = ['boolean', ['get', 'hidden'], false];
    const unbuilt = this.satellite ? 0.18 : 0.9;
    for (const l of ['osm-park', 'osm-water', 'osm-flyover']) if (this.map.getLayer(l)) this.map.setPaintProperty(l, 'fill-opacity', ['case', taken, 0, unbuilt]);
    const set = (layer: string, whenBuilt: number) => { if (this.map.getLayer(layer)) this.map.setPaintProperty(layer, 'fill-opacity', ['case', hidden, 0.3, built, whenBuilt, unbuilt]); };
    set('park-fill', this.satellite ? 0.55 : 0.9);
    set('farm-fill', this.satellite ? 0.75 : 0.95);
    set('water-fill', this.satellite ? 0.6 : 0.95);
    set('road-fill', 1);
    if (this.map.getLayer('flyover-flat')) this.map.setPaintProperty('flyover-flat', 'fill-opacity', ['case', built, 0.04, this.satellite ? 0.25 : 0.9]);
  }

  private applyAtmosphere() {
    const sun = this.sun;
    if (this.night) this.map.setLight({ anchor: 'map', position: [1.3, 200, 60], intensity: 0.18, color: '#c9d4ff' });
    else if (sun && sun.altitude > 0) this.map.setLight({ anchor: 'map', position: [1.3, sun.azimuth, Math.max(8, 90 - sun.altitude)], intensity: 0.3 + 0.25 * Math.min(1, sun.altitude / 45), color: sun.altitude < 12 ? '#ffd9b0' : '#ffffff' });
    else this.map.setLight({ anchor: 'map', position: [1.3, 200, 35], intensity: 0.45, color: '#ffffff' });
    try {
      this.map.setSky(this.night
        ? { 'sky-color': '#1a2236', 'horizon-color': '#3b4761', 'fog-color': '#3f4a66', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.85, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 0.4] }
        : { 'sky-color': sun && sun.altitude < 12 ? '#f4b9a0' : '#bcd6ee', 'horizon-color': '#f2ede4', 'fog-color': '#f5f0e6', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 0.35] });
    } catch { /* older style spec */ }
  }
  setSun(sun: { azimuth: number; altitude: number }) { this.sun = sun; if (this.map.loaded()) this.applyAtmosphere(); }

  async setNight(night: boolean) {
    if (this.night === night) return;
    this.night = night;
    await this.ready;
    const mine = new Set(['osm', 'world', 'decor', 'lines', 'draw', 'satellite', 'coverage', 'cars']);
    await new Promise<void>((res) => {
      this.map.once('style.load', () => res());
      this.map.setStyle(night ? NIGHT_STYLE : MAP_STYLE, {
        transformStyle: (prev, next) => {
          const sources = { ...next.sources };
          for (const k of mine) if (prev?.sources[k]) sources[k] = prev.sources[k];
          const layers = next.layers.map((l) => (l.type === 'fill' && (l as maplibregl.FillLayerSpecification)['source-layer'] === 'building' ? { ...l, layout: { ...(l.layout ?? {}), visibility: 'none' as const } } : l));
          const ours = (prev?.layers ?? []).filter((l) => 'source' in l && mine.has(String(l.source)) && l.id !== 'satellite');
          const sat = (prev?.layers ?? []).find((l) => l.id === 'satellite');
          const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
          if (sat) layers.splice(firstSymbol < 0 ? layers.length : firstSymbol, 0, sat);
          return { ...next, sources, layers: [...layers, ...ours] };
        },
      });
    });
    this.toyBasemap();
    this.addSatellite();
    this.applyGroundOpacity();
    this.applyAtmosphere();
    for (const id of this.features.keys()) if (!id.startsWith('tw/')) this.map.setFeatureState({ source: 'osm', sourceLayer: 'osm', id }, { taken: true });
    for (const f of this.features.values()) f.properties.sprite = this.spriteFor(f.properties);
    this.push();
  }

  collection(): FeatureCollection<Polygon, WorldProps> { return { type: 'FeatureCollection', features: [...this.features.values()] }; }
  /** A world feature, adopting it from the loaded tiles if needed. */
  feature(id: string) {
    const w = this.features.get(id);
    if (w) return w;
    const hit = this.map.getSource('osm') ? this.map.querySourceFeatures('osm', { sourceLayer: 'osm', filter: ['==', ['get', 'id'], id] })[0] : undefined;
    return hit ? this.adopt(hit) ?? undefined : undefined;
  }
  /** Everything on the ground nearby: world features plus whatever tiles are loaded. */
  *footprints(): Iterable<Footprint> {
    const seen = new Set<string>();
    for (const f of this.features.values()) { seen.add(f.properties.id); yield { id: f.properties.id, kind: f.properties.kind, ring: f.geometry.coordinates[0], hidden: f.properties.hidden }; }
    if (!this.map.getSource('osm')) return;
    for (const f of this.map.querySourceFeatures('osm', { sourceLayer: 'osm' })) {
      const id = String(f.properties.id);
      if (seen.has(id) || f.geometry.type !== 'Polygon') continue;
      seen.add(id);
      yield { id, kind: f.properties.kind as Kind, ring: f.geometry.coordinates[0] };
    }
  }
  private push() {
    (this.map.getSource('world') as maplibregl.GeoJSONSource | undefined)?.setData(this.collection());
    (this.map.getSource('decor') as maplibregl.GeoJSONSource | undefined)?.setData(this.decor());
    (this.map.getSource('lines') as maplibregl.GeoJSONSource | undefined)?.setData(this.lines());
  }
  refresh() { (this.map.getSource('decor') as maplibregl.GeoJSONSource | undefined)?.setData(this.decor()); }

  private lines(): FeatureCollection<LineString, { kind: Kind }> {
    const out: Feature<LineString, { kind: Kind }>[] = [];
    for (const f of this.features.values()) {
      const p = f.properties;
      if ((p.kind === 'road' || p.kind === 'railway') && p.built && !p.hidden && p.line && p.line.length >= 2) out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: p.line }, properties: { kind: p.kind } });
    }
    return { type: 'FeatureCollection', features: out };
  }

  private decor(): FeatureCollection<Polygon, DecorProps> {
    const out: Feature<Polygon, DecorProps>[] = [];
    const add = (ring: Position[], props: DecorProps) => out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: props });
    const now = Date.now();
    const plants = (ring: Position[], base: number, props: Props, id: string, perM2: number) => {
      const c = props.crop ? CROPS[props.crop] : null;
      if (!c) return;
      const stage = cropStage(props, now);
      const n = Math.min(MAX_PLANTS, Math.max(4, Math.round(ringAreaM2(ring) / perM2)));
      const rnd = seeded(id + ':crop');
      const colour = stage > 0.85 ? c.ripe : mix(c.colour, c.ripe, Math.max(0, stage - 0.5));
      for (const pt of scatterInRing(ring, n, rnd)) add(circleRing(pt, 0.45 + rnd() * 0.2, 6), { dk: 'plant', base, height: base + 0.15 + stage * c.height * (0.8 + rnd() * 0.4), colour });
    };
    const rect = (c: Position, w: number, h: number, dx = 0, dy = 0): Position[] => {
      const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 111320;
      const cx = c[0] + dx / kx, cy = c[1] + dy / ky;
      const r: Position[] = [[cx - w / 2 / kx, cy - h / 2 / ky], [cx + w / 2 / kx, cy - h / 2 / ky], [cx + w / 2 / kx, cy + h / 2 / ky], [cx - w / 2 / kx, cy + h / 2 / ky]];
      r.push(r[0]); return r;
    };
    const off = (c: Position, dx: number, dy: number): Position => { const kx = 111320 * Math.cos((c[1] * Math.PI) / 180); return [c[0] + dx / kx, c[1] + dy / 111320]; };
    const model = (kind: string, sub: string | undefined, c: Position) => {
      const m = (ring: Position[], base: number, height: number, colour: string) => add(ring, { dk: 'model', base, height, colour });
      if (kind === 'landmark') {
        if (sub === 'temple') { m(rect(c, 6, 6), 0, 1, '#c9b79c'); m(rect(c, 3.6, 3.6), 1, 5, '#c98b4a'); m(rect(c, 2.6, 2.6), 5, 7.5, '#b9773a'); m(rect(c, 1.8, 1.8), 7.5, 9.5, '#b9773a'); m(rect(c, 1, 1), 9.5, 11, '#b9773a'); m(circleRing(c, 0.35, 6), 11, 12.2, '#e0b040'); }
        else if (sub === 'mosque') { m(rect(c, 6.5, 6.5), 0, 4, '#f2efe8'); m(circleRing(c, 2.3, 10), 4, 4.8, '#3d8b6e'); m(circleRing(c, 1.8, 10), 4.8, 5.5, '#3d8b6e'); m(circleRing(c, 1.2, 10), 5.5, 6.1, '#3d8b6e'); m(circleRing(c, 0.5, 8), 6.1, 6.9, '#e0b040'); const mn = off(c, 3.8, 0); m(circleRing(mn, 0.55, 8), 0, 9, '#f2efe8'); m(circleRing(mn, 0.75, 8), 9, 9.8, '#3d8b6e'); }
        else if (sub === 'church') { m(rect(c, 4.5, 8), 0, 5, '#e8e2d6'); const t = off(c, 0, -4.5); m(rect(t, 2.4, 2.4), 0, 9, '#e8e2d6'); m(rect(t, 1.7, 1.7), 9, 10.5, '#7a6f66'); m(rect(t, 1, 1), 10.5, 11.8, '#7a6f66'); m(rect(t, 0.4, 0.4), 11.8, 13.2, '#7a6f66'); }
        else if (sub === 'statue') { m(rect(c, 2.6, 2.6), 0, 1.6, '#8a8f96'); m(rect(c, 1.3, 1.3), 1.6, 3.4, '#8a8f96'); m(circleRing(c, 0.55, 8), 3.4, 5.2, '#6b5a3e'); }
        else if (sub === 'gate') { m(rect(c, 1, 1, -2.6, 0), 0, 4.5, '#b07c4a'); m(rect(c, 1, 1, 2.6, 0), 0, 4.5, '#b07c4a'); m(rect(c, 6.4, 0.9), 4.5, 5.3, '#b07c4a'); m(rect(c, 7, 1.6), 5.3, 5.9, '#8a5a2b'); }
        else if (sub === 'tank') { for (const [dx, dy] of [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]]) m(rect(c, 0.5, 0.5, dx, dy), 0, 6, '#8a8f96'); m(circleRing(c, 2.3, 10), 6, 9, '#9fb3c8'); m(circleRing(c, 1, 8), 9, 9.6, '#8a8f96'); }
      } else if (kind === 'furniture') {
        if (sub === 'streetlight') { m(circleRing(c, 0.14, 6), 0, 7, '#4a4f57'); m(circleRing(c, 0.45, 6), 6.6, 7.2, this.night ? '#fff1a8' : '#d8d8d8'); if (this.night) add(circleRing(c, 4.5, 12), { dk: 'glow', base: 0, height: 0.05, colour: '#ffe28a' }); }
        else if (sub === 'busstop') { m(rect(c, 0.15, 0.15, -1.6, 0), 0, 2.6, '#4a4f57'); m(rect(c, 0.15, 0.15, 1.6, 0), 0, 2.6, '#4a4f57'); m(rect(c, 3.8, 1.5), 2.6, 2.9, '#3d8b6e'); m(rect(c, 2.6, 0.45, 0, 0.4), 0.45, 0.55, '#8d6e63'); }
        else if (sub === 'bench') { m(rect(c, 1.7, 0.5), 0.42, 0.55, '#8d6e63'); m(rect(c, 0.1, 0.4, -0.7, 0), 0, 0.42, '#4a4f57'); m(rect(c, 0.1, 0.4, 0.7, 0), 0, 0.42, '#4a4f57'); }
        else if (sub === 'dustbin') { m(circleRing(c, 0.38, 8), 0, 1, '#2f6f5a'); }
        else if (sub === 'teastall') { m(rect(c, 2.2, 1.1), 0.7, 1.6, '#a0522d'); m(rect(c, 0.08, 0.08, -1, -0.5), 1.6, 2.1, '#4a4f57'); m(rect(c, 0.08, 0.08, 1, -0.5), 1.6, 2.1, '#4a4f57'); m(rect(c, 2.6, 1.6), 2.1, 2.25, '#d94f4f'); }
      }
    };
    const tree = (pt: Position, rnd: () => number, big = false) => {
      // lollipop: a trunk and a rounded canopy built from three rings
      const r = (big ? 2.2 : 1.6) + rnd() * 1.2, h = (big ? 4.2 : 3.4) + rnd() * 2;
      const rot = rnd() * Math.PI, colour = CANOPY[Math.floor(rnd() * CANOPY.length)];
      add(circleRing(pt, 0.35, 6), { dk: 'trunk', base: 0, height: 2.2, colour: '#6b4f3a' });
      add(circleRing(pt, r * 0.7, 8, rot), { dk: 'canopy', base: 1.9, height: 1.9 + h * 0.3, colour: darken(colour, 0.85) });
      add(circleRing(pt, r, 8, rot), { dk: 'canopy', base: 1.9 + h * 0.3, height: 1.9 + h * 0.75, colour });
      add(circleRing(pt, r * 0.62, 8, rot), { dk: 'canopy', base: 1.9 + h * 0.75, height: 1.9 + h, colour: mix(colour, '#ffffff', 0.12) });
    };
    for (const f of this.features.values()) {
      const p = f.properties;
      if (!p.built || p.hidden) continue;
      const ring = f.geometry.coordinates[0];
      if (p.kind === 'building') {
        const wall = p.wall ?? GREY;
        const colour = (p.roof && ROOF_COLOURS[p.roof]) || darken(wall, 0.72);
        let top = p.floors * FLOOR_HEIGHT;
        const roofBase = top;
        if (!this.satellite) add(insetRing(ring, 1.28), { dk: 'lot', base: 0, height: 0, colour: this.night ? '#2f3d33' : '#a9d18e' });
        if (p.roof === 'tin' || p.roof === 'tiled' || p.roof === 'thatch') {
          // gable: an eave overhang, then steps that shrink across the long axis up to a ridge
          const eave = p.roof === 'thatch' ? 1.12 : 1.06;
          const N = 5, rise = p.roof === 'thatch' ? 0.75 : 0.6;
          add(insetRing(ring, eave), { dk: 'roof', base: top - 0.15, height: top + 0.3, colour: darken(colour, 0.85) });
          top += 0.3;
          for (let k = 0; k < N; k++) { const sq = 1 - (k + 0.5) / N; add(squeezeRing(insetRing(ring, eave - 0.02 * k), Math.max(0.08, sq)), { dk: 'roof', base: top - 0.05, height: top + rise, colour: k % 2 ? colour : mix(colour, '#ffffff', 0.08) }); top += rise; }
        } else {
          const steps = ROOF_STEPS[p.roof ?? 'flat'] ?? ROOF_STEPS.flat;
          for (const st of steps) { add(insetRing(ring, st.s), { dk: 'roof', base: top, height: top + st.h, colour }); top += st.h; }
        }
        const step = Math.max(1, Math.ceil(p.floors / 14));
        const glass = p.style === 'modern' ? '#5d7f9c' : mix(wall, '#2a3a4a', 0.55);
        const band = this.night ? '#ffd98a' : glass;
        const first = p.commercial ? 1 : 0;
        for (let k = first; k < p.floors; k += step) {
          const lo = k * FLOOR_HEIGHT + (p.style === 'modern' ? 0.35 : 1.0), hi = k * FLOOR_HEIGHT + (p.style === 'modern' ? 3.0 : 2.3);
          if (!p.sprite) add(insetRing(ring, 1.012), { dk: 'band', base: lo, height: hi, colour: band });
          if (k > 0 && p.style !== 'modern') add(insetRing(ring, 1.03), { dk: 'slab', base: k * FLOOR_HEIGHT - 0.1, height: k * FLOOR_HEIGHT + 0.12, colour: darken(wall, 0.8) });
        }
        if (p.roof === 'flat' && p.props.crop) plants(insetRing(ring, 0.82), roofBase + 0.35, p.props, p.id, 8);
        if (p.hoarding) add(circleRing(centroid(ring), 1.4, 4, Math.PI / 4), { dk: 'board', base: top + 0.2, height: top + 3.4, colour: '#1b1b1b' });
      } else if (p.kind === 'farm') {
        plants(ring, 0, p.props, p.id, 14);
      } else if (p.kind === 'tree') {
        tree(centroid(ring), seeded(p.id), true);
      } else if (p.kind === 'landmark' || p.kind === 'furniture') {
        model(p.kind, p.props.subtype, centroid(ring));
      } else if (p.kind === 'civic') {
        const c = centroid(ring);
        const head = p.resolved ? '#3d8b6e' : '#e07a5f';
        add(circleRing(c, 0.18, 6), { dk: 'model', base: 0, height: 4.2, colour: '#4a4f57' });
        add(circleRing(c, 0.8, 8), { dk: 'model', base: 4.2, height: 5.6, colour: head });
        add(circleRing(c, 1.6, 10), { dk: 'glow', base: 0, height: 0.05, colour: head });
      } else if (p.kind === 'park' || p.kind === 'playground') {
        const density = p.props.trees ?? (p.kind === 'playground' ? 'sparse' : 'normal');
        const n = Math.min(MAX_TREES, Math.max(1, Math.round(ringAreaM2(ring) / (TREE_M2[density] ?? 220))));
        const rnd = seeded(p.id);
        for (const pt of scatterInRing(ring, n, rnd)) tree(pt, rnd);
      } else if (p.kind === 'flyover' && p.line) {
        const width = lineWidth('flyover', p.props.lanes);
        const segs = lineSegments(p.line, width, 8);
        const L = segs[0]?.lengthM ?? 0;
        const ramped = p.id.startsWith('tw/') && L > 60;
        const rampFrac = Math.min(0.4, 60 / Math.max(L, 1));
        const hAt = (t: number) => { if (!ramped) return FLYOVER_HEIGHT + 1.2 * Math.sin(Math.PI * t); const e = Math.min(t, 1 - t) / rampFrac; const k = e >= 1 ? 1 : e * e * (3 - 2 * e); return FLYOVER_HEIGHT * k + 0.8 * Math.sin(Math.PI * t); };
        const deck = this.night ? '#3a3f47' : '#4f545b';
        let sincePier = 99;
        for (const sg of segs) {
          const h = hAt(sg.t);
          add(sg.ring, { dk: 'deck', base: Math.max(0, h - 0.2), height: h + 0.9, colour: deck });
          sincePier += 8;
          if (h > 2.2 && sincePier >= 28) { sincePier = 0; add(circleRing(sg.mid, 0.9, 4, Math.PI / 4), { dk: 'pier', base: 0, height: h, colour: '#a3a7ab' }); }
        }
      }
    }
    return { type: 'FeatureCollection', features: out };
  }

  /** Apply a stored plot onto the world. Every stored plot carries its geometry, so no tile is needed. */
  mergeState(b: Plot, push = true) {
    let f = this.features.get(b.id);
    if (!f) {
      if (!b.geometry) return;
      f = this.blank(b.id, b.kind, b.neighbourhood, b.geometry);
      this.features.set(b.id, f);
      if (!b.id.startsWith('tw/') && this.map.getSource('osm')) this.map.setFeatureState({ source: 'osm', sourceLayer: 'osm', id: b.id }, { taken: true });
    } else if (b.geometry) f.geometry = b.geometry;
    const p = f.properties;
    p.kind = b.kind ?? p.kind;
    p.floors = b.floors ?? p.osm_floors ?? 1;
    p.colour = b.colour;
    p.style = b.style;
    p.wall = wallColour(b.colour, b.style);
    p.name = b.name ?? p.osm_name;
    p.roof = b.roof;
    p.props = { ...p.props, ...(b.props ?? {}) };
    if (p.props.line) p.line = p.props.line;
    p.commercial = !!b.use && COMMERCIAL_USES.has(b.use);
    p.ground = p.wall ? darken(p.wall, 0.7) : darken(GREY, 0.8);
    p.hoarding = hoardingActive(b.props ?? {}) ? b.props.hoarding! : null;
    p.sign = b.props?.sign ?? null;
    p.civic = b.kind === 'civic' ? (CIVIC_SHORT[b.props?.subtype ?? ''] ?? 'Issue') : null;
    p.resolved = !!b.props?.resolved_at;
    p.owner_name = b.owner_name;
    p.built = true;
    p.hidden = b.hidden;
    p.provisional = !!b.provisional;
    p.sprite = this.spriteFor(p);
    if (push) this.push();
  }
  private spriteFor(p: WorldProps): string | null {
    if (p.kind !== 'building' || !p.built || p.hidden || !p.wall || p.style === 'bamboo') return null;
    const id = `win-${p.wall.slice(1)}-${this.night ? 'n' : 'd'}`;
    return this.map.hasImage(id) ? id : null;
  }

  preview(id: string, patch: Partial<Pick<WorldProps, 'floors' | 'colour' | 'roof' | 'style' | 'commercial' | 'props' | 'name'>>, geometry?: Polygon) {
    const f = this.features.get(id);
    if (!f) return;
    Object.assign(f.properties, patch);
    const p = f.properties;
    p.wall = wallColour(p.colour, p.style);
    p.ground = p.wall ? darken(p.wall, 0.7) : darken(GREY, 0.8);
    p.sprite = this.spriteFor(p);
    if (geometry) f.geometry = geometry;
    this.push();
  }
  /** Back to how it was: a saved plot returns to its saved state, an unclaimed footprint goes back to the tiles. */
  resetPreview(id: string, saved: Plot | null, originalGeometry?: Polygon) {
    const f = this.features.get(id);
    if (!f) return;
    if (originalGeometry) f.geometry = originalGeometry;
    if (saved) { this.mergeState(saved); return; }
    this.remove(id);
  }

  addTraced(id: string, geometry: Polygon, neighbourhood: string, kind: Kind, props: Props) {
    this.features.set(id, this.blank(id, kind, neighbourhood, geometry, { props, line: props.line ?? null }));
    this.push();
  }
  remove(id: string) {
    this.features.delete(id);
    if (!id.startsWith('tw/') && this.map.getSource('osm')) this.map.removeFeatureState({ source: 'osm', sourceLayer: 'osm', id });
    this.push();
  }

  select(id: string | null) { this.map.setFilter('world-selected', ['==', ['get', 'id'], id ?? '']); }
  flyTo(lonlat: [number, number], zoom = 17.5) { this.map.flyTo({ center: lonlat, zoom, pitch: 55, essential: true }); }
  toggle3D(): boolean {
    const flat = this.map.getPitch() > 5;
    this.map.easeTo(flat ? { pitch: 0, bearing: 0 } : { pitch: 55, bearing: -17 }, { duration: 600 });
    return !flat;
  }

  setDraw(points: Position[], shape: 'polygon' | 'line' | 'point' = 'polygon') {
    const features: Feature[] = points.map((p, i) => ({ type: 'Feature', properties: { h: 'v', i }, geometry: { type: 'Point', coordinates: p } }));
    if (points.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } });
    if (shape === 'polygon' && points.length >= 3) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] } });
    (this.map.getSource('draw') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }
  setHandles(pts: Position[], mids: Position[], closed: boolean) {
    const features: Feature[] = [];
    if (pts.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: closed ? [...pts, pts[0]] : pts } });
    mids.forEach((p, i) => features.push({ type: 'Feature', properties: { h: 'm', i }, geometry: { type: 'Point', coordinates: p } }));
    pts.forEach((p, i) => features.push({ type: 'Feature', properties: { h: 'v', i }, geometry: { type: 'Point', coordinates: p } }));
    (this.map.getSource('draw') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Per-neighbourhood totals for the leaderboard: OSM totals from the index, built counts from the world. */
  stats(): { neighbourhood: string; district: string; total: number; built: number; civic: number }[] {
    const m = new Map<string, { total: number; built: number; civic: number }>();
    for (const [name, total] of this.totals) m.set(name, { total, built: 0, civic: 0 });
    for (const f of this.features.values()) {
      const n = f.properties.neighbourhood;
      const s = m.get(n) ?? { total: 0, built: 0, civic: 0 };
      if (f.properties.kind === 'civic') { if (f.properties.built && !f.properties.hidden && !f.properties.resolved) s.civic++; m.set(n, s); continue; }
      if (f.properties.built && !f.properties.hidden) { s.built++; if (f.properties.id.startsWith('tw/')) s.total++; }
      m.set(n, s);
    }
    return [...m.entries()].map(([neighbourhood, s]) => ({ neighbourhood, district: this.districtOf(neighbourhood), ...s }));
  }
  builtIn(neighbourhood: string): number { let n = 0; for (const f of this.features.values()) if (f.properties.neighbourhood === neighbourhood && f.properties.built && !f.properties.hidden && f.properties.kind !== 'civic') n++; return n; }
}
