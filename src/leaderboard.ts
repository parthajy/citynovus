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

  private district: string | null = null;
  private auto = true; // pick the district under the camera the first time the board opens

  render() {
    const q = this.filter.trim().toLowerCase();
    const all = this.world.stats().filter((r) => r.total > 0 || r.built > 0);
    const state = all.reduce((a, r) => ({ total: a.total + r.total, built: a.built + r.built }), { total: 0, built: 0 });
    const pct = (r: { built: number; total: number }) => (r.total ? Math.round((100 * r.built) / r.total) : 0);
    const byBuilt = (a: { built: number; total: number; name: string }, b: { built: number; total: number; name: string }) => b.built - a.built || b.total - a.total || a.name.localeCompare(b.name);
    if (this.auto) { this.auto = false; const c = this.world.map.getCenter(); const n = this.world.nearestNeighbourhood(c.lng, c.lat); if (n) this.district = this.world.districtOf(n); }

    const dmap = new Map<string, { name: string; total: number; built: number; civic: number; places: number }>();
    for (const r of all) { const d = dmap.get(r.district) ?? { name: r.district, total: 0, built: 0, civic: 0, places: 0 }; d.total += r.total; d.built += r.built; d.civic += r.civic; d.places++; dmap.set(r.district, d); }
    const districts = [...dmap.values()].sort(byBuilt);

    let body: string;
    if (q) {
      // A search cuts across districts: show every matching place, with its district for context.
      const rows = all.filter((r) => r.neighbourhood.toLowerCase().includes(q) || r.district.toLowerCase().includes(q)).map((r) => ({ ...r, name: r.neighbourhood })).sort(byBuilt).slice(0, 60);
      body = rows.length ? this.placeList(rows.map((r) => ({ ...r, sub: r.district })), pct) : `<p class="hint">Nothing called that. Try the town or district name.</p>`;
    } else if (this.district) {
      const rows = all.filter((r) => r.district === this.district).map((r) => ({ ...r, name: r.neighbourhood })).sort(byBuilt);
      const d = dmap.get(this.district) ?? { name: this.district, total: 0, built: 0, civic: 0, places: 0 };
      body = `
        <div class="board-crumb"><a href="#" data-act="districts"><span class="ms">arrow_back</span>All districts</a><span>${esc(d.name)} · ${d.built.toLocaleString()}/${d.total.toLocaleString()} · ${pct(d)}% · ${d.places} places</span><button class="btn icon" title="Share card" data-act="share" data-d="${esc(d.name)}"><span class="ms">share</span></button></div>
        ${rows.length ? this.placeList(rows, pct) : '<p class="hint">No mapped places here yet.</p>'}`;
    } else {
      body = `<ol class="board">${districts.map((d, i) => `
          <li>
            <span class="rank">${i + 1}</span>
            <div class="grow">
              <div class="line"><a href="#" data-act="district" data-d="${esc(d.name)}">${esc(d.name)}</a><span>${d.built.toLocaleString()}/${d.total.toLocaleString()} · ${pct(d)}%${d.civic ? ` · <span class="civic-n" title="open civic reports">${d.civic} open</span>` : ''} · ${d.places} places</span></div>
              <div class="bar"><i style="width:${pct(d)}%"></i></div>
            </div>
            <button class="btn icon" title="Open" data-act="district" data-d="${esc(d.name)}"><span class="ms">chevron_right</span></button>
          </li>`).join('')}</ol>`;
    }
    this.el.innerHTML = `
      <div class="panel-head">
        <div><h2><span class="ms">leaderboard</span>${this.district && !q ? esc(this.district) : 'Districts'}</h2><div class="sub">${state.built.toLocaleString()} of ${state.total.toLocaleString()} things built across Assam · ${districts.length} districts · ${all.length} places</div></div>
        <button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button>
      </div>
      <input class="board-filter" placeholder="Find your town, village or district" value="${esc(this.filter)}">
      <button class="btn tonal share-btn" data-act="share" data-n="__city__"><span class="ms">share</span>Share Assam card</button>
      ${body}
      <p class="hint">${state.total.toLocaleString()} buildings, ponds, parks and flyovers exist on the open map of Assam. Colour them in, and add what is missing.</p>
      <p class="hint">Not from Assam? <a href="#" data-act="wish">Vote for your state or city</a>.</p>
    `;
  }

  private placeList(rows: { name: string; total: number; built: number; civic: number; sub?: string }[], pct: (r: { built: number; total: number }) => number) {
    return `<ol class="board">${rows.map((r, i) => `
          <li>
            <span class="rank">${i + 1}</span>
            <div class="grow">
              <div class="line"><a href="#" data-act="go" data-n="${esc(r.name)}">${esc(r.name)}</a><span>${r.sub ? `${esc(r.sub)} · ` : ''}${r.built}/${r.total} · ${pct(r)}%${r.civic ? ` · <span class="civic-n" title="open civic reports">${r.civic} open</span>` : ''} · <a href="#" data-act="board" data-n="${esc(r.name)}">board</a></span></div>
              <div class="bar"><i style="width:${pct(r)}%"></i></div>
            </div>
            <button class="btn icon" title="Share card" data-act="share" data-n="${esc(r.name)}"><span class="ms">share</span></button>
          </li>`).join('')}</ol>`;
  }

  private async onClick(ev: Event) {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    ev.preventDefault();
    const n = btn.dataset.n ?? '';
    if (btn.dataset.act === 'close') this.el.hidden = true;
    else if (btn.dataset.act === 'district') { this.district = btn.dataset.d ?? null; this.filter = ''; this.render(); this.el.scrollTop = 0; }
    else if (btn.dataset.act === 'districts') { this.district = null; this.render(); this.el.scrollTop = 0; }
    else if (btn.dataset.act === 'board') { this.el.hidden = true; window.dispatchEvent(new CustomEvent('tw:board', { detail: n })); }
    else if (btn.dataset.act === 'wish') { this.el.hidden = true; document.querySelector<HTMLElement>('#profile [data-act="wish"]')?.click() ?? window.dispatchEvent(new CustomEvent('tw:wish')); }
    else if (btn.dataset.act === 'go') {
      const c = this.world.neighbourhoodCentre(n) ?? (() => { const p = this.places.find((x) => x.name === n); return p ? [p.lon, p.lat] as [number, number] : undefined; })();
      if (c) this.world.flyTo(c, 16.5);
    } else if (btn.dataset.act === 'share') {
      const rows = this.world.stats();
      const sum = (xs: { total: number; built: number }[]) => xs.reduce((a, x) => ({ total: a.total + x.total, built: a.built + x.built }), { total: 0, built: 0 });
      const d = btn.dataset.d;
      const r = n === '__city__'
        ? { neighbourhood: 'Assam', ...sum(rows) }
        : d ? { neighbourhood: `${d} district`, ...sum(rows.filter((x) => x.district === d)) }
        : rows.find((x) => x.neighbourhood === n);
      if (!r) return;
      try {
        const how = await shareCard(r.neighbourhood, r.built, r.total);
        this.toast(how === 'shared' ? 'Shared' : 'Card saved to downloads');
      } catch { /* user cancelled the share sheet */ }
    }
  }
}
