// The OSM footprints, loaded once so guardrails can see what is already on the ground.
import { readFileSync } from 'node:fs';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { Footprint, Kind } from '../shared/rules';

export class World {
  private osm = new Map<string, Footprint>();
  private neighbourhoods: { name: string; lon: number; lat: number }[] = [];

  constructor(worldFile: string, placesFile: string) {
    const fc = JSON.parse(readFileSync(worldFile, 'utf8')) as FeatureCollection<Polygon, { id: string; kind: Kind }>;
    for (const f of fc.features as Feature<Polygon, { id: string; kind: Kind }>[]) {
      this.osm.set(f.properties.id, { id: f.properties.id, kind: f.properties.kind, ring: f.geometry.coordinates[0] });
    }
    try {
      const places = JSON.parse(readFileSync(placesFile, 'utf8')) as { places: { name: string; lon: number; lat: number }[] };
      this.neighbourhoods = places.places;
    } catch { /* optional */ }
    console.log(`world: ${this.osm.size} OSM footprints, ${this.neighbourhoods.length} neighbourhoods`);
  }

  /** OSM footprints plus stored plots; a stored plot's geometry overrides the OSM one. */
  *footprints(plots: Iterable<{ id: string; kind: Kind; geometry: Polygon | null; hidden: boolean }>): Iterable<Footprint> {
    const seen = new Set<string>();
    for (const p of plots) {
      seen.add(p.id);
      const ring = p.geometry?.coordinates[0] ?? this.osm.get(p.id)?.ring;
      if (ring) yield { id: p.id, kind: p.kind, ring, hidden: p.hidden };
    }
    for (const f of this.osm.values()) if (!seen.has(f.id)) yield f;
  }

  has(id: string) { return this.osm.has(id); }

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
