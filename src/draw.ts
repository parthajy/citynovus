import type { Position } from 'geojson';
import type { WorldMap } from './map';

export class Tracer {
  points: Position[] = [];
  active = false;
  shape: 'polygon' | 'line' | 'point' = 'polygon';
  constructor(private world: WorldMap) {}

  start(shape: 'polygon' | 'line' | 'point') { this.active = true; this.shape = shape; this.points = []; this.render(); }
  add(p: Position) { if (this.active) { this.points.push(p); this.render(); } }
  undo() { this.points.pop(); this.render(); }
  cancel() { this.active = false; this.points = []; this.render(); }
  /** Returns the raw points; the caller turns them into a polygon or a buffered line. */
  finish(): Position[] | null {
    const need = this.shape === 'polygon' ? 3 : 2;
    if (this.points.length < need) return null;
    const pts = this.points;
    this.active = false;
    this.points = [];
    this.render();
    return pts;
  }
  private render() { this.world.setDraw(this.points, this.shape); }
}
