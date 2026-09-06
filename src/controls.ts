// Map controls drawn by us, so they match the rest of the UI: zoom, compass, tilt, locate.
import type { WorldMap } from './map';

export function mountControls(root: HTMLElement, world: WorldMap, toast: (m: string, k?: 'ok' | 'err') => void) {
  root.innerHTML = `
    <button class="btn icon fab-mini" data-ctl="in" title="Zoom in"><span class="ms">add</span></button>
    <button class="btn icon fab-mini" data-ctl="out" title="Zoom out"><span class="ms">remove</span></button>
    <button class="btn icon fab-mini" data-ctl="compass" title="Reset north"><span class="ms compass">navigation</span></button>
    <button class="btn icon fab-mini" data-ctl="tilt" title="Tilt 3D / flat"><span class="ms">3d_rotation</span></button>
    <button class="btn icon fab-mini" data-ctl="satellite" title="Satellite imagery"><span class="ms">satellite_alt</span></button>
    <button class="btn icon fab-mini" data-ctl="locate" title="Where am I"><span class="ms">my_location</span></button>`;
  const map = world.map;
  try { if (localStorage.getItem('tw.sat') === '1') { world.setSatellite(true); root.querySelector('[data-ctl="satellite"]')!.classList.add('on'); } } catch { /* ignore */ }
  const compass = root.querySelector<HTMLElement>('.compass')!;
  map.on('rotate', () => { compass.style.transform = `rotate(${-map.getBearing()}deg)`; });
  root.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-ctl]');
    if (!b) return;
    const c = b.dataset.ctl;
    if (c === 'in') map.zoomIn();
    else if (c === 'out') map.zoomOut();
    else if (c === 'compass') map.easeTo({ bearing: 0, duration: 500 });
    else if (c === 'tilt') world.toggle3D();
    else if (c === 'satellite') {
      world.setSatellite(!world.satellite);
      b.classList.toggle('on', world.satellite);
      try { localStorage.setItem('tw.sat', world.satellite ? '1' : '0'); } catch { /* ignore */ }
      toast(world.satellite ? 'Satellite on. Trace footprints straight off the imagery.' : 'Satellite off');
    }
    else if (c === 'locate') {
      if (!navigator.geolocation) { toast('No location on this device', 'err'); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => world.flyTo([pos.coords.longitude, pos.coords.latitude], 17.5),
        () => toast('Could not get your location. Search for your street instead.', 'err'),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }
  });
}

/** Material-style ripple on every button. */
export function enableRipples() {
  document.addEventListener('pointerdown', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b || b.hasAttribute('disabled')) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'ripple';
    const size = Math.max(r.width, r.height) * 2;
    s.style.cssText = `width:${size}px;height:${size}px;left:${ev.clientX - r.left - size / 2}px;top:${ev.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 600);
  });
}
