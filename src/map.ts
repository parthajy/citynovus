import maplibregl, { type ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, Polygon, Position } from 'geojson';
import type { Footprint, Kind, Plot, Props } from './types';
import { CITY, COMMERCIAL_USES, CROPS, FLOOR_HEIGHT, FLYOVER_HEIGHT, GREY, HIDDEN, MAP_STYLE, MAX_PLANTS, MAX_TREES, NIGHT_STYLE, ROOF_COLOURS, SATELLITE_ATTRIBUTION, SATELLITE_TILES, TREE_M2, cropStage, hoardingActive, lineWidth } from './config';
import { centroid, circleRing, darken, insetRing, lineSegments, ringAreaM2, scatterInRing, seeded } from './geo';

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
  owner_name: string | null;
  built: boolean;
  hidden: boolean;
  provisional: boolean;
}
interface DecorProps { dk: 'roof' | 'slab' | 'band' | 'trunk' | 'canopy' | 'pier' | 'plant' | 'board' | 'deck' | 'model' | 'glow'; base: number; height: number; colour: string }

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

function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a), pb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b);
  if (!pa || !pb) return a;
  const c = [1, 2, 3].map((i) => Math.round(parseInt(pa[i], 16) * (1 - t) + parseInt(pb[i], 16) * t).toString(16).padStart(2, '0'));
  return '#' + c.join('');
}
/** Wall colour after the style has its say: glass is bluish, bamboo is earthy. */
function wallColour(colour: string | null, style: string | null): string | null {
  if (!colour) return null;
  if (style === 'modern') return mix(colour, '#a9cfe8', 0.55);
  if (style === 'bamboo') return mix(colour, '#a67c52', 0.35);
  if (style === 'colonial') return mix(colour, '#f5f0e6', 0.3);
  return colour;
}

export class WorldMap {
  readonly map: maplibregl.Map;
  night = false;
  satellite = false;
  private features = new Map<string, WFeature>();
  private ready: Promise<void>;
  private sun: { azimuth: number; altitude: number } | null = null;
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
    // Basemap styles sometimes reference sprite images they do not ship; a blank pixel keeps the console quiet.
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
        hoarding: null, sign: null, owner_name: null, built: false, hidden: false, provisional: false,
        ...extra,
      },
    };
  }

  async load(collection: FeatureCollection<Polygon, Partial<WorldProps>>, states: Plot[]) {
    await this.ready;
    for (const f of collection.features) {
      const p = f.properties;
      const id = String(p.id);
      this.features.set(id, this.blank(id, (p.kind as Kind) ?? 'building', p.neighbourhood ?? 'Unassigned', f.geometry, {
        osm_floors: p.osm_floors ?? null,
        osm_name: p.osm_name ?? null,
        osm_building: p.osm_building ?? null,
        line: p.line ?? null,
        floors: p.osm_floors ?? 1,
        name: p.osm_name ?? null,
        props: p.props ?? {},
      }));
    }
    for (const b of states) this.mergeState(b, false);

    // The basemap draws its own flat buildings; ours replace them.
    for (const layer of this.map.getStyle().layers ?? []) {
      if (/building/i.test(layer.id)) this.map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
    this.applyAtmosphere();

    this.map.addSource('world', { type: 'geojson', data: this.collection(), promoteId: 'id' });
    this.map.addSource('decor', { type: 'geojson', data: this.decor() });
    this.map.addSource('lines', { type: 'geojson', data: this.lines() });
    this.map.addSource('draw', { type: 'geojson', data: EMPTY });

    const kind = (...k: Kind[]) => ['in', ['get', 'kind'], ['literal', k]] as unknown as maplibregl.FilterSpecification;
    const all = (...parts: unknown[]) => ['all', ...parts] as unknown as maplibregl.FilterSpecification;
    const built: ExpressionSpecification = ['boolean', ['get', 'built'], false];
    const hidden: ExpressionSpecification = ['boolean', ['get', 'hidden'], false];
    const not = (e: ExpressionSpecification) => ['!', e] as ExpressionSpecification;

    this.addSatellite();

    // Flat ground features, bottom to top.
    this.map.addLayer({ id: 'park-fill', type: 'fill', source: 'world', filter: kind('park', 'playground'), paint: {
      'fill-color': ['case', built, ['case', ['==', ['get', 'kind'], 'playground'], '#d3d98f', '#a9d18e'], '#e3ebdc'],
    } });
    this.map.addLayer({ id: 'farm-fill', type: 'fill', source: 'world', filter: kind('farm'), paint: {
      'fill-color': ['case', built, '#b08d57', '#e8dcc0'],
    } });
    this.map.addLayer({ id: 'farm-line', type: 'line', source: 'world', filter: kind('farm'), paint: { 'line-color': ['case', built, '#8a6d3b', '#d2c3a0'], 'line-width': 1 } });
    this.map.addLayer({ id: 'water-fill', type: 'fill', source: 'world', filter: kind('pond'), paint: {
      'fill-color': ['case', built, '#8dbfe3', '#dbe8f2'],
    } });
    this.map.addLayer({ id: 'water-line', type: 'line', source: 'world', filter: kind('pond'), paint: { 'line-color': ['case', built, '#6fa6cf', '#b9cfe0'], 'line-width': 1 } });
    this.map.addLayer({ id: 'road-fill', type: 'fill', source: 'world', filter: kind('road'), paint: {
      'fill-color': ['case', built, '#6f747b', '#e4e4e4'],
    } });
    this.map.addLayer({ id: 'road-centre', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'road'], paint: { 'line-color': '#f5f0e6', 'line-width': 1.2, 'line-dasharray': [3, 3] } });
    // Flyovers: the flat strip is the thing you tap; the deck itself is built from segments in decor().
    this.map.addLayer({ id: 'flyover-flat', type: 'fill', source: 'world', filter: kind('flyover'), paint: { 'fill-color': '#dedede' } });
    this.map.addLayer({ id: 'flyover-flat-line', type: 'line', source: 'world', filter: all(kind('flyover'), not(built)), paint: { 'line-color': '#b9b9b9', 'line-width': 1, 'line-dasharray': [2, 2] } });
    this.map.addLayer({ id: 'tree-fill', type: 'fill', source: 'world', filter: kind('tree'), paint: { 'fill-color': '#8fbf7a', 'fill-opacity': ['case', hidden, 0.3, 0.6] } });
    this.map.addLayer({ id: 'point-fill', type: 'fill', source: 'world', filter: kind('landmark', 'furniture'), paint: { 'fill-color': '#d9d2c5', 'fill-opacity': ['case', hidden, 0.2, 0.45] } });
    this.map.addLayer({ id: 'rail-fill', type: 'fill', source: 'world', filter: kind('railway'), paint: { 'fill-color': ['case', built, '#5f5a55', '#e6e2dc'], 'fill-opacity': ['case', hidden, 0.3, 0.95] } });
    this.map.addLayer({ id: 'rail-sleepers', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'railway'], paint: { 'line-color': '#8a7a66', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 18, 12], 'line-dasharray': [0.4, 0.8] } });
    this.map.addLayer({ id: 'rail-line', type: 'line', source: 'lines', filter: ['==', ['get', 'kind'], 'railway'], paint: { 'line-color': '#c9c9c9', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1, 18, 2] } });
    this.map.addLayer({ id: 'wall-flat', type: 'line', source: 'world', filter: all(kind('wall'), not(built)), paint: { 'line-color': '#b9b1a3', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    this.map.addLayer({ id: 'glow', type: 'fill-extrusion', source: 'decor', filter: ['==', ['get', 'dk'], 'glow'], paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': 0, 'fill-extrusion-height': 0.05, 'fill-extrusion-opacity': 0.35 } });

    // Trees, plants and piers sit on the ground, under buildings.
    this.map.addLayer({ id: 'walls-3d', type: 'fill-extrusion', source: 'world', filter: all(kind('wall'), built), paint: { 'fill-extrusion-color': ['case', hidden, HIDDEN, '#b8a48c'], 'fill-extrusion-height': 2, 'fill-extrusion-opacity': 0.95 } });
    this.map.addLayer({ id: 'decor-ground', type: 'fill-extrusion', source: 'decor', filter: ['in', ['get', 'dk'], ['literal', ['trunk', 'canopy', 'pier', 'plant', 'model']]], paint: {
      'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95,
    } });

    // Buildings: body, optional ground-floor shopfront band, then roof caps, floor slabs, boards.
    this.map.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'world', filter: kind('building'), paint: {
      'fill-extrusion-color': ['case', hidden, HIDDEN, ['coalesce', ['get', 'wall'], GREY]],
      'fill-extrusion-base': ['case', ['all', built, ['boolean', ['get', 'commercial'], false]], FLOOR_HEIGHT, 0],
      'fill-extrusion-height': ['case', hidden, 0.6, ['*', ['coalesce', ['get', 'floors'], 1], FLOOR_HEIGHT]],
      'fill-extrusion-opacity': 0.94,
      'fill-extrusion-vertical-gradient': true,
    } });
    this.map.addLayer({ id: 'ground-3d', type: 'fill-extrusion', source: 'world', filter: all(kind('building'), built, not(hidden), ['boolean', ['get', 'commercial'], false]), paint: {
      'fill-extrusion-color': ['coalesce', ['get', 'ground'], GREY], 'fill-extrusion-base': 0, 'fill-extrusion-height': FLOOR_HEIGHT, 'fill-extrusion-opacity': 0.94,
    } });
    this.map.addLayer({ id: 'decor-roof', type: 'fill-extrusion', source: 'decor', filter: ['in', ['get', 'dk'], ['literal', ['roof', 'slab', 'band', 'board', 'deck']]], paint: {
      'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.96,
    } });

    this.applyGroundOpacity();

    // A guest's unsaved work: dashed outline until they log in.
    this.map.addLayer({ id: 'world-provisional', type: 'line', source: 'world', filter: ['boolean', ['get', 'provisional'], false], paint: { 'line-color': '#e07a5f', 'line-width': 2, 'line-dasharray': [1.5, 1.5] } });
    this.map.addLayer({ id: 'world-selected', type: 'line', source: 'world', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#111', 'line-width': 3 } });

    // Names once you are close enough to read them, hoardings a little earlier.
    this.map.addLayer({ id: 'world-labels', type: 'symbol', source: 'world', minzoom: 15.5, filter: all(['to-boolean', ['get', 'name']], not(hidden), ['!', ['to-boolean', ['get', 'hoarding']]]), layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 10, 18, 13],
      'text-max-width': 8, 'text-padding': 4, 'symbol-sort-key': ['case', built, 0, 1],
    }, paint: { 'text-color': '#222', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 } });
    this.map.addLayer({ id: 'signs', type: 'symbol', source: 'world', minzoom: 16.5, filter: all(['to-boolean', ['get', 'sign']], not(hidden)), layout: {
      'text-field': ['get', 'sign'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-max-width': 10, 'text-offset': [0, 1.5], 'text-padding': 2, 'symbol-sort-key': 2,
    }, paint: { 'text-color': '#1b1b1b', 'text-halo-color': '#fff3c4', 'text-halo-width': 1.6 } });
    this.map.addLayer({ id: 'hoardings', type: 'symbol', source: 'world', minzoom: 14.5, filter: all(['to-boolean', ['get', 'hoarding']], not(hidden)), layout: {
      'text-field': ['upcase', ['get', 'hoarding']], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-max-width': 12, 'text-offset': [0, -2.2], 'text-padding': 6, 'symbol-sort-key': -1,
    }, paint: { 'text-color': '#ffd166', 'text-halo-color': '#1b1b1b', 'text-halo-width': 2 } });

    this.map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#5b8def', 'fill-opacity': 0.25 } });
    this.map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#5b8def', 'line-width': 2, 'line-dasharray': [2, 1] } });
    this.map.addLayer({ id: 'draw-points', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'], paint: {
      'circle-radius': ['case', ['==', ['get', 'h'], 'm'], 5, 7],
      'circle-color': ['case', ['==', ['get', 'h'], 'm'], 'rgba(255,255,255,0.6)', '#fff'],
      'circle-stroke-color': '#5b8def', 'circle-stroke-width': 2,
    } });

    const pickable = ['buildings-3d', 'ground-3d', 'walls-3d', 'flyover-flat', 'tree-fill', 'point-fill', 'rail-fill', 'farm-fill', 'water-fill', 'park-fill', 'road-fill'];
    this.map.on('click', (e) => {
      if (this.onMapClick([e.lngLat.lng, e.lngLat.lat])) return;
      const hits = this.map.queryRenderedFeatures(e.point, { layers: pickable });
      const id = hits.length ? String(hits[0].properties.id) : null;
      this.select(id);
      this.onSelect(id);
    });
    this.map.on('mousemove', (e) => {
      const hits = this.map.queryRenderedFeatures(e.point, { layers: [...pickable, 'draw-points'] });
      this.map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
    });
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
  /** Unbuilt ground features fade over imagery so the real ground shows through until someone claims them. */
  private applyGroundOpacity() {
    const built: ExpressionSpecification = ['boolean', ['get', 'built'], false];
    const hidden: ExpressionSpecification = ['boolean', ['get', 'hidden'], false];
    const unbuilt = this.satellite ? 0.18 : 0.9;
    const set = (layer: string, whenBuilt: number) => { if (this.map.getLayer(layer)) this.map.setPaintProperty(layer, 'fill-opacity', ['case', hidden, 0.3, built, whenBuilt, unbuilt]); };
    set('park-fill', this.satellite ? 0.55 : 0.9);
    set('farm-fill', this.satellite ? 0.75 : 0.95);
    set('water-fill', this.satellite ? 0.6 : 0.95);
    set('road-fill', 1);
    if (this.map.getLayer('flyover-flat')) this.map.setPaintProperty('flyover-flat', 'fill-opacity', ['case', built, 0.04, this.satellite ? 0.25 : 0.9]);
  }

  /** Light and sky for the time of day. Called on load, on night/day changes, and after a basemap swap. */
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

  /** Swap the basemap for night, carrying our sources and layers across. */
  async setNight(night: boolean) {
    if (this.night === night) return;
    this.night = night;
    await this.ready;
    const mine = new Set(['world', 'decor', 'lines', 'draw', 'satellite']);
    await new Promise<void>((res) => {
      this.map.once('style.load', () => res());
      this.map.setStyle(night ? NIGHT_STYLE : MAP_STYLE, {
        transformStyle: (prev, next) => {
          const sources = { ...next.sources };
          for (const k of mine) if (prev?.sources[k]) sources[k] = prev.sources[k];
          const layers = next.layers.map((l) => (/building/i.test(l.id) ? { ...l, layout: { ...(l.layout ?? {}), visibility: 'none' as const } } : l));
          const ours = (prev?.layers ?? []).filter((l) => 'source' in l && mine.has(String(l.source)) && l.id !== 'satellite');
          const sat = (prev?.layers ?? []).find((l) => l.id === 'satellite');
          const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
          if (sat) layers.splice(firstSymbol < 0 ? layers.length : firstSymbol, 0, sat);
          return { ...next, sources, layers: [...layers, ...ours] };
        },
      });
    });
    this.addSatellite();
    this.applyGroundOpacity();
    this.applyAtmosphere();
    this.push(); // windows light up
  }

  collection(): FeatureCollection<Polygon, WorldProps> {
    return { type: 'FeatureCollection', features: [...this.features.values()] };
  }
  feature(id: string) { return this.features.get(id); }
  *footprints(): Iterable<Footprint> {
    for (const f of this.features.values()) yield { id: f.properties.id, kind: f.properties.kind, ring: f.geometry.coordinates[0], hidden: f.properties.hidden };
  }
  private push() {
    (this.map.getSource('world') as maplibregl.GeoJSONSource | undefined)?.setData(this.collection());
    (this.map.getSource('decor') as maplibregl.GeoJSONSource | undefined)?.setData(this.decor());
    (this.map.getSource('lines') as maplibregl.GeoJSONSource | undefined)?.setData(this.lines());
  }
  /** Crops grow in real time; call now and then so they visibly do. */
  refresh() { (this.map.getSource('decor') as maplibregl.GeoJSONSource | undefined)?.setData(this.decor()); }

  private lines(): FeatureCollection<LineString, { kind: Kind }> {
    const out: Feature<LineString, { kind: Kind }>[] = [];
    for (const f of this.features.values()) {
      const p = f.properties;
      if ((p.kind === 'road' || p.kind === 'railway') && p.built && !p.hidden && p.line && p.line.length >= 2) out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: p.line }, properties: { kind: p.kind } });
    }
    return { type: 'FeatureCollection', features: out };
  }

  /** Roof caps, floor slabs, trees, crops, piers and hoarding boards, generated from the built features. */
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
    // Tiny procedural models. Axis-aligned boxes and cylinders are enough at city scale.
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
      const r = (big ? 2.2 : 1.6) + rnd() * 1.4, h = (big ? 4.5 : 3.5) + rnd() * 2.5;
      add(circleRing(pt, 0.35, 6), { dk: 'trunk', base: 0, height: 2, colour: '#6b4f3a' });
      add(circleRing(pt, r, 8, rnd() * Math.PI), { dk: 'canopy', base: 1.7, height: 1.7 + h, colour: CANOPY[Math.floor(rnd() * CANOPY.length)] });
    };
    for (const f of this.features.values()) {
      const p = f.properties;
      if (!p.built || p.hidden) continue;
      const ring = f.geometry.coordinates[0];
      if (p.kind === 'building') {
        const wall = p.wall ?? GREY;
        const steps = ROOF_STEPS[p.roof ?? 'flat'] ?? ROOF_STEPS.flat;
        const colour = (p.roof && ROOF_COLOURS[p.roof]) || darken(wall, 0.72);
        let top = p.floors * FLOOR_HEIGHT;
        const roofBase = top;
        for (const st of steps) { add(insetRing(ring, st.s), { dk: 'roof', base: top, height: top + st.h, colour }); top += st.h; }
        // Floors: a thin ledge between floors and a window band on each one, lit at night.
        const step = Math.max(1, Math.ceil(p.floors / 14));
        const glass = p.style === 'modern' ? '#5d7f9c' : mix(wall, '#2a3a4a', 0.55);
        const band = this.night ? '#ffd98a' : glass;
        const first = p.commercial ? 1 : 0;
        for (let k = first; k < p.floors; k += step) {
          const lo = k * FLOOR_HEIGHT + (p.style === 'modern' ? 0.35 : 1.0), hi = k * FLOOR_HEIGHT + (p.style === 'modern' ? 3.0 : 2.3);
          add(insetRing(ring, 1.012), { dk: 'band', base: lo, height: hi, colour: band });
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
      } else if (p.kind === 'park' || p.kind === 'playground') {
        const density = p.props.trees ?? (p.kind === 'playground' ? 'sparse' : 'normal');
        const n = Math.min(MAX_TREES, Math.max(1, Math.round(ringAreaM2(ring) / (TREE_M2[density] ?? 220))));
        const rnd = seeded(p.id);
        for (const pt of scatterInRing(ring, n, rnd)) tree(pt, rnd);
      } else if (p.kind === 'flyover' && p.line) {
        // A deck that rises from the ground on player-traced flyovers (they include the approaches) and arches gently on OSM spans.
        const width = lineWidth('flyover', p.props.lanes);
        const segs = lineSegments(p.line, width, 8);
        const L = segs[0]?.lengthM ?? 0;
        const ramped = p.id.startsWith('tw/') && L > 60;
        const rampFrac = Math.min(0.4, 60 / Math.max(L, 1));
        const hAt = (t: number) => {
          if (!ramped) return FLYOVER_HEIGHT + 1.2 * Math.sin(Math.PI * t);
          const e = Math.min(t, 1 - t) / rampFrac;
          const k = e >= 1 ? 1 : e * e * (3 - 2 * e);
          return FLYOVER_HEIGHT * k + 0.8 * Math.sin(Math.PI * t);
        };
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

  /** Apply a stored plot onto its footprint. Creates the footprint for player-made plots. */
  mergeState(b: Plot, push = true) {
    let f = this.features.get(b.id);
    if (!f) {
      if (!b.geometry) return; // an OSM footprint we no longer have; ignore
      f = this.blank(b.id, b.kind, b.neighbourhood, b.geometry);
      this.features.set(b.id, f);
    } else if (b.geometry) {
      f.geometry = b.geometry; // a player re-shaped it
    }
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
    p.owner_name = b.owner_name;
    p.built = true;
    p.hidden = b.hidden;
    p.provisional = !!b.provisional;
    if (push) this.push();
  }

  /** Temporary look while the panel is open; mergeState/resetPreview undo it. */
  preview(id: string, patch: Partial<Pick<WorldProps, 'floors' | 'colour' | 'roof' | 'style' | 'commercial' | 'props' | 'name'>>, geometry?: Polygon) {
    const f = this.features.get(id);
    if (!f) return;
    Object.assign(f.properties, patch);
    const p = f.properties;
    p.wall = wallColour(p.colour, p.style);
    p.ground = p.wall ? darken(p.wall, 0.7) : darken(GREY, 0.8);
    if (geometry) f.geometry = geometry;
    this.push();
  }
  resetPreview(id: string, saved: Plot | null, originalGeometry?: Polygon) {
    const f = this.features.get(id);
    if (!f) return;
    if (originalGeometry) f.geometry = originalGeometry;
    if (saved) { this.mergeState(saved); return; }
    const p = f.properties;
    p.floors = p.osm_floors ?? 1; p.colour = null; p.wall = null; p.roof = null; p.style = null; p.commercial = false; p.name = p.osm_name; p.built = false; p.provisional = false;
    this.push();
  }

  addTraced(id: string, geometry: Polygon, neighbourhood: string, kind: Kind, props: Props) {
    this.features.set(id, this.blank(id, kind, neighbourhood, geometry, { props, line: props.line ?? null }));
    this.push();
  }
  remove(id: string) { this.features.delete(id); this.push(); }

  select(id: string | null) {
    this.map.setFilter('world-selected', ['==', ['get', 'id'], id ?? '']);
  }
  flyTo(lonlat: [number, number], zoom = 17.5) {
    this.map.flyTo({ center: lonlat, zoom, pitch: 55, essential: true });
  }
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
  /** Vertex and midpoint handles for the shape editor. */
  setHandles(pts: Position[], mids: Position[], closed: boolean) {
    const features: Feature[] = [];
    if (pts.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: closed ? [...pts, pts[0]] : pts } });
    mids.forEach((p, i) => features.push({ type: 'Feature', properties: { h: 'm', i }, geometry: { type: 'Point', coordinates: p } }));
    pts.forEach((p, i) => features.push({ type: 'Feature', properties: { h: 'v', i }, geometry: { type: 'Point', coordinates: p } }));
    (this.map.getSource('draw') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Per-neighbourhood totals for the leaderboard. */
  stats(): { neighbourhood: string; total: number; built: number }[] {
    const m = new Map<string, { total: number; built: number }>();
    for (const f of this.features.values()) {
      const n = f.properties.neighbourhood;
      const s = m.get(n) ?? { total: 0, built: 0 };
      s.total++;
      if (f.properties.built && !f.properties.hidden) s.built++;
      m.set(n, s);
    }
    return [...m.entries()].map(([neighbourhood, s]) => ({ neighbourhood, ...s }));
  }
}
