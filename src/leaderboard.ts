import type { WorldMap } from './map';
import type { Place } from './geo';
import { shareCard } from './share';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class Leaderboard {
  private filter = '';
  constructor(private el: HTMLElement, private world: WorldMap, private places: Place[], private toast: (m: string) => void) {
    el.addEventListener('click', (ev) => this.onClick(ev));
    el.addEventListener('input', (ev) => { const t = ev.target as HTMLInputElement; if (t.classList.contains('board-filter')) { this.filter = t.value; this.render(); const f = this.el.querySelector<HTMLInputElement>('.board-filter'); f?.focus(); f?.setSelectionRange(f.value.length, f.value.length); } });
  }

  toggle() { this.el.hidden = !this.el.hidden; if (!this.el.hidden) this.render(); }
  refresh() { if (!this.el.hidden) this.render(); }

  render() {
    const q = this.filter.toLowerCase();
    const allRows = this.world.stats().filter((r) => r.total > 0 || r.built > 0);
    const city = allRows.reduce((a, r) => ({ total: a.total + r.total, built: a.built + r.built }), { total: 0, built: 0 });
    allRows.sort((a, b) => b.built - a.built || b.total - a.total || a.neighbourhood.localeCompare(b.neighbourhood));
    const rows = (q ? allRows.filter((r) => r.neighbourhood.toLowerCase().includes(q)) : allRows).slice(0, 60);
    const pct = (r: { built: number; total: number }) => (r.total ? Math.round((100 * r.built) / r.total) : 0);
    this.el.innerHTML = `
      <div class="panel-head">
        <div><h2><span class="ms">leaderboard</span>Places</h2><div class="sub">${city.built.toLocaleString()} of ${city.total.toLocaleString()} things built across Assam · ${allRows.length} places</div></div>
        <button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button>
      </div>
      <input class="board-filter" placeholder="Find your town or village" value="${esc(this.filter)}">
      <button class="btn tonal share-btn" data-act="share" data-n="__city__"><span class="ms">share</span>Share Assam card</button>
      <ol class="board">
        ${rows.map((r, i) => `
          <li>
            <span class="rank">${i + 1}</span>
            <div class="grow">
              <div class="line"><a href="#" data-act="go" data-n="${esc(r.neighbourhood)}">${esc(r.neighbourhood)}</a><span>${r.built}/${r.total} · ${pct(r)}%${r.civic ? ` · <span class="civic-n" title="open civic reports">${r.civic} open</span>` : ''} · <a href="#" data-act="board" data-n="${esc(r.neighbourhood)}">board</a></span></div>
              <div class="bar"><i style="width:${pct(r)}%"></i></div>
            </div>
            <button class="btn icon" title="Share card" data-act="share" data-n="${esc(r.neighbourhood)}"><span class="ms">share</span></button>
          </li>`).join('')}
      </ol>
      <p class="hint">${city.total.toLocaleString()} buildings, ponds, parks and flyovers exist on the open map of Assam. Colour them in, and add what is missing.</p>
      <p class="hint">Not from Assam? <a href="#" data-act="wish">Vote for your state or city</a>.</p>
    `;
  }

  private async onClick(ev: Event) {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    ev.preventDefault();
    const n = btn.dataset.n ?? '';
    if (btn.dataset.act === 'close') this.el.hidden = true;
    else if (btn.dataset.act === 'board') { this.el.hidden = true; window.dispatchEvent(new CustomEvent('tw:board', { detail: n })); }
    else if (btn.dataset.act === 'wish') { this.el.hidden = true; document.querySelector<HTMLElement>('#profile [data-act="wish"]')?.click() ?? window.dispatchEvent(new CustomEvent('tw:wish')); }
    else if (btn.dataset.act === 'go') {
      const c = this.world.neighbourhoodCentre(n) ?? (() => { const p = this.places.find((x) => x.name === n); return p ? [p.lon, p.lat] as [number, number] : undefined; })();
      if (c) this.world.flyTo(c, 16.5);
    } else if (btn.dataset.act === 'share') {
      const rows = this.world.stats();
      const r = n === '__city__'
        ? { neighbourhood: 'Assam', ...rows.reduce((a, x) => ({ total: a.total + x.total, built: a.built + x.built }), { total: 0, built: 0 }) }
        : rows.find((x) => x.neighbourhood === n);
      if (!r) return;
      try {
        const how = await shareCard(r.neighbourhood, r.built, r.total);
        this.toast(how === 'shared' ? 'Shared' : 'Card saved to downloads');
      } catch { /* user cancelled the share sheet */ }
    }
  }
}
