// Drag the corners of a shape. Vertices are white handles, midpoints are hollow ones:
// drag a midpoint to add a corner, double-click a corner to remove it.
import type { Position } from 'geojson';
import type maplibregl from 'maplibre-gl';
import type { WorldMap } from './map';

export class ShapeEditor {
  active = false;
  id = '';
  pts: Position[] = [];
  closed = true;
  onPreview: (id: string, pts: Position[]) => void = () => {};
  onMessage: (msg: string) => void = () => {};
  private dragging: number | null = null;
  private onDown = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => this.down(e);
  private onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => this.move(e);
  private onUp = () => this.up();
  private onDbl = (e: maplibregl.MapMouseEvent) => this.dbl(e);

  constructor(private world: WorldMap) {}

  start(id: string, pts: Position[], closed: boolean) {
    this.id = id; this.pts = pts.map((p) => [p[0], p[1]]); this.closed = closed; this.active = true;
    const m = this.world.map;
    m.on('mousedown', 'draw-points', this.onDown);
    m.on('touchstart', 'draw-points', this.onDown);
    m.on('dblclick', 'draw-points', this.onDbl);
    m.doubleClickZoom.disable();
    this.render();
  }

  private stop() {
    const m = this.world.map;
    m.off('mousedown', 'draw-points', this.onDown);
    m.off('touchstart', 'draw-points', this.onDown);
    m.off('dblclick', 'draw-points', this.onDbl);
    m.doubleClickZoom.enable();
    this.active = false;
    this.world.setHandles([], [], true);
  }
  finish(): Position[] { const pts = this.pts; this.stop(); return pts; }
  cancel() { this.stop(); }

  private mids(): Position[] {
    const out: Position[] = [];
    const n = this.closed ? this.pts.length : this.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i], b = this.pts[(i + 1) % this.pts.length];
      out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return out;
  }
  private render() {
    this.world.setHandles(this.pts, this.mids(), this.closed);
    this.onPreview(this.id, this.pts);
  }

  private down(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
    const f = this.world.map.queryRenderedFeatures(e.point, { layers: ['draw-points'] })[0];
    if (!f) return;
    e.preventDefault();
    const i = Number(f.properties.i);
    if (f.properties.h === 'm') {
      this.pts.splice(i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
      this.dragging = i + 1;
    } else this.dragging = i;
    const m = this.world.map;
    m.dragPan.disable();
    m.on('mousemove', this.onMove); m.on('touchmove', this.onMove);
    m.once('mouseup', this.onUp); m.once('touchend', this.onUp);
  }
  private move(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
    if (this.dragging === null) return;
    this.pts[this.dragging] = [e.lngLat.lng, e.lngLat.lat];
    this.render();
  }
  private up() {
    const m = this.world.map;
    m.off('mousemove', this.onMove); m.off('touchmove', this.onMove);
    m.dragPan.enable();
    this.dragging = null;
    this.render();
  }
  private dbl(e: maplibregl.MapMouseEvent) {
    const f = this.world.map.queryRenderedFeatures(e.point, { layers: ['draw-points'] })[0];
    if (!f || f.properties.h !== 'v') return;
    e.preventDefault();
    const min = this.closed ? 3 : 2;
    if (this.pts.length <= min) { this.onMessage(`A ${this.closed ? 'shape needs at least three corners' : 'line needs at least two points'}.`); return; }
    this.pts.splice(Number(f.properties.i), 1);
    this.render();
  }
}
