import type { WorldMap } from './map';
import type { Place } from './geo';
import { shareCard } from './share';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class Leaderboard {
  constructor(private el: HTMLElement, private world: WorldMap, private places: Place[], private toast: (m: string) => void) {
    el.addEventListener('click', (ev) => this.onClick(ev));
  }

  toggle() { this.el.hidden = !this.el.hidden; if (!this.el.hidden) this.render(); }
  refresh() { if (!this.el.hidden) this.render(); }

  render() {
    const rows = this.world.stats().filter((r) => r.total > 0);
    const city = rows.reduce((a, r) => ({ total: a.total + r.total, built: a.built + r.built }), { total: 0, built: 0 });
    rows.sort((a, b) => b.built - a.built || b.built / b.total - a.built / a.total || a.neighbourhood.localeCompare(b.neighbourhood));
    const pct = (r: { built: number; total: number }) => (r.total ? Math.round((100 * r.built) / r.total) : 0);
    this.el.innerHTML = `
      <div class="panel-head">
        <div><h2><span class="ms">leaderboard</span>Neighbourhoods</h2><div class="sub">${city.built} of ${city.total} features built · ${pct(city)}% of the mapped city</div></div>
        <button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button>
      </div>
      <button class="btn tonal share-btn" data-act="share" data-n="__city__"><span class="ms">share</span>Share city card</button>
      <ol class="board">
        ${rows.map((r, i) => `
          <li>
            <span class="rank">${i + 1}</span>
            <div class="grow">
              <div class="line"><a href="#" data-act="go" data-n="${esc(r.neighbourhood)}">${esc(r.neighbourhood)}</a><span>${r.built}/${r.total} · ${pct(r)}%</span></div>
              <div class="bar"><i style="width:${pct(r)}%"></i></div>
            </div>
            <button class="btn icon" title="Share card" data-act="share" data-n="${esc(r.neighbourhood)}"><span class="ms">share</span></button>
          </li>`).join('')}
      </ol>
      <p class="hint">Only ${city.total} buildings, ponds, parks and flyovers exist on any open map of Guwahati. Add the rest.</p>
      <p class="hint">Not from Guwahati? <a href="#" data-act="wish">Vote for your city</a>.</p>
    `;
  }

  private async onClick(ev: Event) {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    ev.preventDefault();
    const n = btn.dataset.n ?? '';
    if (btn.dataset.act === 'close') this.el.hidden = true;
    else if (btn.dataset.act === 'wish') { this.el.hidden = true; document.querySelector<HTMLElement>('#profile [data-act="wish"]')?.click() ?? window.dispatchEvent(new CustomEvent('tw:wish')); }
    else if (btn.dataset.act === 'go') {
      const p = this.places.find((x) => x.name === n);
      if (p) this.world.flyTo([p.lon, p.lat], 16.5);
    } else if (btn.dataset.act === 'share') {
      const rows = this.world.stats();
      const r = n === '__city__'
        ? { neighbourhood: 'Guwahati', ...rows.reduce((a, x) => ({ total: a.total + x.total, built: a.built + x.built }), { total: 0, built: 0 }) }
        : rows.find((x) => x.neighbourhood === n);
      if (!r) return;
      try {
        const how = await shareCard(r.neighbourhood, r.built, r.total);
        this.toast(how === 'shared' ? 'Shared' : 'Card saved to downloads');
      } catch { /* user cancelled the share sheet */ }
    }
  }
}
