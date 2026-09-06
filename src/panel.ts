import type { Polygon, Position } from 'geojson';
import type { EditInput, Plot, Props, Store } from './types';
import type { WorldMap } from './map';
import type { ShapeEditor } from './editor';
import {
  COMMERCIAL_USES, CROPS, CROP_IDS, FLAG_REASONS, FLAG_THRESHOLD, FURNITURE, HOARDINGS_ENABLED, HOARDING_COST, HOARDING_DAYS, HOARDING_MAX, KINDS, KIND_ICONS, LANDMARKS, LANES, MAX_FLOORS, PALETTE, ROOFS, SIGN_MAX, STYLES, TREES, USES,
  buyPrice, canTerrace, checkPlacement, checkSize, cropStage, hoardingActive, lineWidth, type Kind,
} from './config';
import { RuleError, SHORT_LABEL } from '../shared/rules';
const mobile = () => matchMedia('(max-width: 760px)').matches;
import { bufferLine, closeRing } from './geo';

interface Deps {
  store: Store;
  world: WorldMap;
  editor: ShapeEditor;
  state: Map<string, Plot>;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  onPlayer: () => void;
  onChanged: () => void;
  requireIdentity: () => Promise<boolean>;
  flagMinPoints: () => number;
  /** True when the server wants an account before anything can be built. */
  needsLogin: () => boolean;
  onLogin: () => void;
  onEarn: () => void;
  /** Called after a fresh claim or trace with the plot id, so the app can offer Undo. */
  onFresh: (id: string) => void;
}

interface OpenOpts { geometry?: Polygon; neighbourhood?: string; isNew?: boolean; kind?: Kind; props?: Props }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const opts = (list: { id: string; label: string }[], current: string | null | undefined, blank = true) =>
  (blank ? `<option value="">—</option>` : '') + list.map((o) => `<option value="${o.id}" ${o.id === current ? 'selected' : ''}>${o.label}</option>`).join('');
const hours = (h: number) => (h < 24 ? `${h}h` : `${Math.round(h / 24)}d`);

export class Panel {
  currentId: string | null = null;
  private open_: OpenOpts = {};
  private draft: EditInput | null = null;
  private geometry: Polygon | null = null; // re-shaped geometry waiting to be published
  private originalGeometry: Polygon | null = null;
  private editing = false;
  private error: string | null = null; // last failure, shown inside the panel until the next action

  constructor(private el: HTMLElement, private d: Deps) {
    d.editor.onPreview = (id, pts) => this.previewShape(id, pts);
  }

  open(id: string, o: OpenOpts = {}) {
    if (this.editing) this.d.editor.cancel();
    this.editing = false;
    this.error = null;
    this.currentId = id;
    this.open_ = o;
    this.draft = null;
    this.geometry = o.geometry ?? null;
    const f = this.d.world.feature(id);
    this.originalGeometry = f ? { type: 'Polygon', coordinates: f.geometry.coordinates.map((r) => r.map((p) => [p[0], p[1]])) } : null;
    this.el.hidden = false;
    this.render();
  }

  close(discard = true) {
    if (this.editing) { this.d.editor.cancel(); this.editing = false; }
    if (this.currentId && discard) {
      if (this.open_.isNew) this.d.world.remove(this.currentId);
      else this.d.world.resetPreview(this.currentId, this.d.state.get(this.currentId) ?? null, this.originalGeometry ?? undefined);
    }
    this.currentId = null;
    this.open_ = {};
    this.draft = null;
    this.geometry = null;
    this.originalGeometry = null;
    this.el.hidden = true;
    this.d.world.select(null);
  }

  private kind(): Kind {
    const f = this.currentId ? this.d.world.feature(this.currentId) : null;
    return this.open_.kind ?? f?.properties.kind ?? 'building';
  }

  render() {
    const id = this.currentId;
    if (!id) return;
    const f = this.d.world.feature(id);
    const b = this.d.state.get(id) ?? null;
    if (!f) { this.close(false); return; }
    const p = f.properties;
    const kind = this.kind();
    const K = KINDS[kind];
    const me = this.d.store.player();
    const mine = !!b && b.owner_id === me.id;
    const canEdit = mine || !b;
    const cheapest = Math.min(...CROP_IDS.map((k) => CROPS[k].cost)); // owner, or an unclaimed grey feature
    const draft: EditInput = this.draft ?? {
      floors: b?.floors ?? p.osm_floors ?? 1,
      colour: b?.colour ?? null,
      style: b?.style ?? null,
      roof: b?.roof ?? null,
      name: b?.name ?? p.osm_name ?? null,
      use: b?.use ?? null,
      photo_url: b?.photo_url ?? null,
      props: { ...(p.props ?? {}), ...(b?.props ?? {}), ...(this.open_.props ?? {}) },
    };
    this.draft = draft;
    const noun = SHORT_LABEL[kind].toLowerCase();
    const title = draft.name || draft.props.sign || p.osm_name || (b ? `Unnamed ${noun}` : this.open_.isNew ? `New ${noun}` : `Grey ${noun}`);
    const neighbourhood = b?.neighbourhood ?? this.open_.neighbourhood ?? p.neighbourhood;
    const status = this.open_.isNew ? (mobile() ? ` · +${K.tracePoints}` : ` · yours once published (+${K.tracePoints})`) : b ? '' : (mobile() ? ` · +${K.editPoints}` : ` · unclaimed (+${K.editPoints})`);
    const dis = canEdit ? '' : 'disabled';

    if (this.editing) {
      this.el.innerHTML = `
        <div class="panel-head"><div><h2><span class="ms">open_with</span>Reshape ${esc(noun)}</h2><div class="sub">Drag a corner to move it. Drag a hollow midpoint to add one. Double-click a corner to remove it.</div></div></div>
        <div class="actions"><button class="btn filled" data-act="shape-done"><span class="ms">check</span>Done</button><button class="btn tonal" data-act="shape-cancel">Cancel</button></div>`;
      this.el.onclick = (ev) => this.onClick(ev);
      return;
    }

    const buildingFields = `
      <label>Floors
        <div class="stepper">
          <button data-act="floors" data-delta="-1" ${dis}>−</button>
          <input name="floors" type="number" min="1" max="${MAX_FLOORS}" value="${draft.floors}" ${dis}>
          <button data-act="floors" data-delta="1" ${dis}>+</button>
        </div>
      </label>
      <label>Colour
        <div class="swatches ${dis}">
          ${PALETTE.map((c) => `<button class="swatch ${draft.colour === c ? 'on' : ''}" data-act="colour" data-colour="${c}" style="background:${c}" aria-label="${c}" ${dis}></button>`).join('')}
        </div>
      </label>
      <div class="row">
        <label>Style<select name="style" ${dis}>${opts(STYLES, draft.style)}</select></label>
        <label>Roof<select name="roof" ${dis}>${opts(ROOFS, draft.roof)}</select></label>
      </div>
      <label>What is it<select name="use" ${dis}>${opts(USES, draft.use)}</select></label>`;
    const parkFields = `<label>Trees<select name="trees" ${dis}>${opts(TREES, draft.props.trees ?? (kind === 'playground' ? 'sparse' : 'normal'), false)}</select></label>`;
    const lineFields = `<label>Width<select name="lanes" ${dis}>${opts(LANES, String(draft.props.lanes ?? K.lanes ?? 2), false)}</select></label>`;
    const subFields = kind === 'landmark' || kind === 'furniture'
      ? `<label>What is it<select name="subtype" ${dis}>${opts(kind === 'landmark' ? LANDMARKS : FURNITURE, draft.props.subtype ?? (kind === 'landmark' ? 'temple' : 'streetlight'), false)}</select></label>` : '';
    const signField = kind === 'building' && draft.use && COMMERCIAL_USES.has(draft.use)
      ? `<label>Shop sign${mobile() ? '' : ' (street-level board, separate from the name)'}<input name="sign" maxlength="${SIGN_MAX}" placeholder="e.g. Bora Tea Stall" value="${esc(draft.props.sign ?? '')}" ${dis}></label>` : '';
    const fields = kind === 'building' ? buildingFields : kind === 'park' || kind === 'playground' ? parkFields : K.shape === 'line' && K.lanes ? lineFields : subFields;
    const namePlaceholder = kind === 'building' ? 'Shop, school, landmark — never a private person' : kind === 'tree' ? 'Krishnachura, mango, tamul…' : `Name of the ${noun}`;

    // Farming: a farm, or a flat roof.
    let farm = '';
    if (b && mine && canTerrace({ kind, roof: draft.roof })) {
      const c = b.props.crop ? CROPS[b.props.crop] : null;
      if (c) {
        const stage = cropStage(b.props);
        const pct = Math.round(stage * 100);
        farm = `<section class="farm">
          <div class="farm-head"><span><span class="ms">grass</span> ${c.label} ${kind === 'building' ? 'on the terrace' : ''}</span><span>${pct}%</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <button class="btn filled" data-act="harvest" ${stage >= 1 ? '' : `aria-disabled="true" data-why="${c.label} is ${pct}% grown. Ready in ${hours(Math.ceil(c.hours * (1 - stage)))}."`}><span class="ms">agriculture</span>${stage >= 1 ? `Harvest · +${c.yield} coins` : `Ready in ${hours(Math.ceil(c.hours * (1 - stage)))}`}</button>
        </section>`;
      } else {
        farm = `<section class="farm">
          <div class="farm-head"><span><span class="ms">potted_plant</span> ${kind === 'building' ? 'Terrace farm' : 'Plant something'}</span></div>
          <div class="row"><select name="crop">${CROP_IDS.map((k) => `<option value="${k}">${CROPS[k].emoji} ${CROPS[k].label} · ${CROPS[k].cost} coins · ${hours(CROPS[k].hours)} · yields ${CROPS[k].yield}</option>`).join('')}</select>
          <button class="btn tonal" data-act="plant" ${me.coins < cheapest ? `aria-disabled="true" data-why="Seeds cost at least ${cheapest} coins. You have ${me.coins}."` : ''}><span class="ms">potted_plant</span>Plant</button></div>
        </section>`;
      }
    } else if (b && mine && kind === 'building') {
      farm = `<p class="hint">Choose a flat roof to farm on the terrace.</p>`;
    }

    let hoarding = '';
    if (HOARDINGS_ENABLED && b && mine && kind === 'building' && b.floors >= 2) {
      const active = hoardingActive(b.props);
      hoarding = `<section class="farm">
        <div class="farm-head"><span><span class="ms">campaign</span> Hoarding</span>${active ? `<span>until ${new Date(b.props.hoarding_until!).toLocaleDateString()}</span>` : ''}</div>
        <div class="row"><input name="hoarding" maxlength="${HOARDING_MAX}" placeholder="Your message on the roof" value="${esc(active ? b.props.hoarding! : '')}">
        <button class="btn tonal" data-act="hoarding" ${!active && me.coins < HOARDING_COST ? `aria-disabled="true" data-why="A hoarding costs ${HOARDING_COST} coins. You have ${me.coins}."` : ''}><span class="ms">campaign</span>${active ? 'Update' : `${HOARDING_COST} coins`}</button></div>
        ${active ? `<button class="linkish" data-act="hoarding-down">Take it down</button>` : `<div class="hint">${HOARDING_DAYS} days. Brands will pay for these later, and you keep most of it.</div>`}
      </section>`;
    }

    const price = b ? buyPrice(b) : 0;
    const flagMin = this.d.flagMinPoints();
    const short = Math.max(0, price - me.coins);
    const needsLogin = this.d.needsLogin();
    const why: string[] = [];
    if (b && !mine && short > 0) why.push(`You have ${me.coins} coins and need ${short} more. <a href="#" data-act="earn">How to earn coins</a>`);
    if (b && !mine && me.points < flagMin) why.push(`Flagging opens at ${flagMin} points. You have ${me.points}.`);
    if (b && mine && canTerrace({ kind, roof: draft.roof }) && !b.props.crop && me.coins < cheapest) why.push(`Seeds cost ${cheapest}+ coins. You have ${me.coins}. <a href="#" data-act="earn">How to earn coins</a>`);
    if (HOARDINGS_ENABLED && b && mine && kind === 'building' && b.floors >= 2 && !hoardingActive(b.props) && me.coins < HOARDING_COST) why.push(`A hoarding costs ${HOARDING_COST} coins. You have ${me.coins}. <a href="#" data-act="earn">How to earn coins</a>`);
    this.el.innerHTML = `
      <div class="panel-head">
        <div>
          <h2><span class="ms">${KIND_ICONS[kind]}</span>${esc(title)}</h2>
          <div class="sub">${esc(mobile() ? SHORT_LABEL[kind] : K.label)} · ${esc(neighbourhood)}${p.osm_building && !mobile() ? ` · OSM: ${esc(p.osm_building)}` : ''}${status}</div>
        </div>
        <button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button>
      </div>
      ${b?.hidden ? `<div class="banner warn">Under community review (${b.flag_score.toFixed(1)}/${FLAG_THRESHOLD} flags). Anyone can buy it for ${price} coins and fix it.</div>` : ''}
      ${b ? `<div class="meta">${mine ? 'Yours' : `Owned by <b>${esc(b.owner_name || 'someone')}</b>`}${b.built_by_name && b.built_by_name !== b.owner_name ? `, built by ${esc(b.built_by_name)}` : ''} · confirmed ${b.confirmations}×${!mine ? ` · <b>${price} coins</b> to buy` : ''}</div>` : ''}
      ${!canEdit ? `<div class="banner">Buy it to change it. The owner gets most of the coins.</div>` : ''}
      ${needsLogin && canEdit ? `<div class="banner">You need an account to build. <a href="#" data-act="login">Log in or create one</a>. It takes a minute and you keep everything.</div>` : ''}
      ${!needsLogin && !me.name && canEdit ? `<div class="banner"><label>Your name goes on what you build<input name="player_name" maxlength="24" placeholder="your name"></label></div>` : ''}
      ${fields}
      <label>Name<input name="name" maxlength="60" placeholder="${namePlaceholder}" value="${esc(draft.name ?? '')}" ${dis}></label>
      ${signField}
      ${canEdit ? `<label>Photo (optional)<div class="row photo-row"><input name="photo_url" type="url" maxlength="300" placeholder="${mobile() ? 'Link or upload' : 'https://… or upload'}" value="${esc(draft.photo_url ?? '')}" ${dis}><button class="btn tonal" data-act="upload" title="Upload a photo"><span class="ms">photo_camera</span><span class="lbl">Upload</span></button><input type="file" name="photo_file" accept="image/*" capture="environment" hidden></div></label>` : ''}
      ${draft.photo_url ? `<img class="photo" src="${esc(draft.photo_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      ${b?.props.photos?.length ? `<div class="photos">${b.props.photos.slice(-3).map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}<span class="hint">Photo-verified ${b.props.photos.length}×</span></div>` : ''}
      <div class="actions">
        ${canEdit ? `<button class="btn filled main" data-act="publish"><span class="ms">publish</span>${mobile() ? 'Publish' : b ? 'Publish changes' : this.open_.isNew ? 'Publish' : 'Claim & publish'}</button>` : `<button class="btn filled main" data-act="buy" ${short > 0 ? `aria-disabled="true" data-why="You need ${short} more coins. Claim grey buildings, plant trees or confirm neighbours to earn them."` : ''}><span class="ms">shopping_bag</span>${short > 0 ? `Need ${short} more coins` : `Buy · ${price} coins`}</button>`}
        ${canEdit && kind !== 'tree' ? `<button class="btn tonal" data-act="shape" title="Drag the corners"><span class="ms">open_with</span>Reshape</button>` : ''}
        ${b && !mine ? `<button class="btn tonal" data-act="confirm" title="Yes, this is really here"><span class="ms">verified</span>Confirm</button>` : ''}
        ${b && !mine ? `<button class="btn tonal" data-act="confirm-photo" title="Confirm with a photo of the real thing: counts triple"><span class="ms">add_a_photo</span>Photo</button><input type="file" name="confirm_file" accept="image/*" capture="environment" hidden>` : ''}
        ${b && !mine ? `<button class="btn tonal danger" data-act="flag" ${me.points < flagMin ? `aria-disabled="true" data-why="Flagging opens at ${flagMin} points. You have ${me.points}. Build more first."` : ''}><span class="ms">flag</span>Flag</button>` : ''}
      </div>
      ${this.error ? `<div class="banner error"><span class="ms">error</span>${esc(this.error)}</div>` : ''}
      ${why.map((w) => `<div class="hint why">${w}</div>`).join('')}
      ${farm}${hoarding}
      <div class="flag-box" hidden>
        <select name="flag_reason">${FLAG_REASONS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}</select>
        <button class="btn tonal danger" data-act="flag-send">Send flag</button>
      </div>
      <div class="share-line"><a href="#b=${encodeURIComponent(id)}" data-act="copy">${mobile() ? 'Copy link' : `Copy link to this ${esc(noun)}`}</a>${b ? ` · <a href="#" data-act="history">History</a>` : ''}</div>
      <div class="history" hidden></div>
    `;

    this.el.onclick = (ev) => this.onClick(ev);
    this.el.oninput = (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.matches('[name="crop"],[name="hoarding"],[name="flag_reason"],[name="player_name"]')) return;
      this.onInput();
      // Some fields change which sections exist (shop sign, terrace farm), so redraw the form.
      if (t.name === 'use' || t.name === 'roof' || t.name === 'subtype') this.render();
    };
    this.el.onchange = (ev) => { const t = ev.target as HTMLInputElement; if (t.name === 'photo_file' || t.name === 'confirm_file') void this.onFile(t); };
  }

  private read(): EditInput {
    const q = (n: string) => this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`);
    const v = (n: string) => q(n)?.value.trim() || null;
    const floorsEl = q('floors');
    const floors = floorsEl ? Math.max(1, Math.min(MAX_FLOORS, parseInt(floorsEl.value, 10) || 1)) : this.draft?.floors ?? 1;
    const props: Props = { ...(this.draft?.props ?? {}) };
    const trees = v('trees'); if (trees) props.trees = trees;
    const lanes = v('lanes'); if (lanes) props.lanes = parseInt(lanes, 10);
    const subtype = v('subtype'); if (subtype) props.subtype = subtype;
    if (q('sign')) props.sign = v('sign') ?? '';
    return { floors, colour: this.draft?.colour ?? null, style: v('style'), roof: v('roof'), name: v('name'), use: v('use'), photo_url: v('photo_url'), props };
  }

  private applyPreview() {
    if (!this.currentId || !this.draft) return;
    const d = this.draft;
    const f = this.d.world.feature(this.currentId);
    let geometry: Polygon | undefined;
    const line = d.props.line ?? f?.properties.line ?? null;
    if (line && d.props.lanes && KINDS[this.kind()].shape === 'line' && KINDS[this.kind()].lanes) {
      geometry = bufferLine(line, lineWidth(this.kind(), d.props.lanes));
      this.geometry = geometry;
    }
    this.d.world.preview(this.currentId, {
      floors: d.floors, colour: d.colour, roof: d.roof, style: d.style, name: d.name ?? f?.properties.osm_name ?? null,
      commercial: !!d.use && COMMERCIAL_USES.has(d.use), props: { ...(f?.properties.props ?? {}), ...d.props },
    }, geometry);
  }
  private onInput() { this.draft = this.read(); this.applyPreview(); }

  private previewShape(id: string, pts: Position[]) {
    const K = KINDS[this.kind()];
    if (pts.length < (K.shape === 'line' ? 2 : 3)) return;
    const poly = K.shape === 'line' ? bufferLine(pts, lineWidth(this.kind(), this.draft?.props.lanes)) : closeRing(pts);
    this.d.world.preview(id, {}, poly);
  }

  private async onFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      this.d.toast('Uploading photo…');
      const url = await this.d.store.uploadPhoto(file);
      if (input.name === 'photo_file') {
        const f = this.el.querySelector<HTMLInputElement>('[name="photo_url"]');
        if (f) f.value = url;
        this.onInput();
        this.d.toast('Photo attached. Publish to keep it.');
      } else if (this.currentId) {
        const id = this.currentId;
        await this.act(() => this.d.store.confirm(id, url), (r) => `Photo-verified · +${r.gained} points`);
      }
    } catch (e) { this.error = (e as Error).message; this.d.toast(this.error, 'err'); this.render(); }
  }

  private startShape() {
    if (!this.currentId) return;
    const f = this.d.world.feature(this.currentId)!;
    const K = KINDS[this.kind()];
    const line = this.draft?.props.line ?? f.properties.line;
    const pts = K.shape === 'line' && line ? line : f.geometry.coordinates[0].slice(0, -1);
    this.editing = true;
    this.d.editor.start(this.currentId, pts, K.shape !== 'line');
    this.render();
  }
  private finishShape(keep: boolean) {
    if (!this.currentId) return;
    const id = this.currentId;
    const K = KINDS[this.kind()];
    if (!keep) {
      this.d.editor.cancel();
      this.editing = false;
      const f = this.d.world.feature(id);
      if (f) { f.geometry = this.geometry ?? this.originalGeometry ?? f.geometry; }
      this.applyPreview();
      this.render();
      return;
    }
    const pts = this.d.editor.finish();
    this.editing = false;
    const poly = K.shape === 'line' ? bufferLine(pts, lineWidth(this.kind(), this.draft?.props.lanes)) : closeRing(pts);
    try {
      checkSize(this.kind(), poly.coordinates[0]);
      checkPlacement(this.kind(), poly.coordinates[0], this.d.world.footprints(), id);
    } catch (e) {
      this.d.toast((e as Error).message, 'err');
      const f = this.d.world.feature(id);
      if (f) f.geometry = this.geometry ?? this.originalGeometry ?? f.geometry;
      this.applyPreview();
      this.render();
      return;
    }
    this.geometry = poly;
    if (K.shape === 'line' && this.draft) this.draft.props.line = pts;
    this.d.world.preview(id, {}, poly);
    this.d.toast('Shape updated. Publish to save it.');
    this.render();
  }

  /** Name typed inside the panel counts; then the usual checks. */
  private async identity(): Promise<boolean> {
    const inline = this.el.querySelector<HTMLInputElement>('[name="player_name"]');
    if (inline && inline.value.trim()) { await this.d.store.setName(inline.value.trim()); this.d.onPlayer(); }
    if (this.d.needsLogin()) { this.d.onLogin(); return false; }
    if (!this.d.store.player().name) { this.error = 'Add your name first. It goes on everything you build.'; this.render(); this.el.querySelector<HTMLInputElement>('[name="player_name"]')?.focus(); return false; }
    return this.d.requireIdentity();
  }

  private async act(fn: () => Promise<{ plot: Plot; gained: number }>, msg: (r: { plot: Plot; gained: number }) => string) {
    const r = await fn();
    this.error = null;
    this.d.state.set(r.plot.id, r.plot);
    this.d.world.mergeState(r.plot);
    this.d.onPlayer();
    this.d.onChanged();
    this.d.toast(msg(r), 'ok');
    this.open_ = {};
    this.draft = null;
    this.geometry = null;
    this.render();
  }

  private async onClick(ev: Event) {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || !this.currentId) return;
    if (btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled')) {
      ev.preventDefault();
      const why = this.el.querySelector('.why');
      if (why) { why.classList.remove('flash'); void (why as HTMLElement).offsetWidth; why.classList.add('flash'); }
      this.error = btn.dataset.why || btn.getAttribute('title') || 'Not available yet';
      this.d.toast(this.error, 'err');
      this.render();
      return;
    }
    const id = this.currentId;
    const act = btn.dataset.act;
    const store = this.d.store;
    try {
      if (act === 'close') this.close();
      else if (act === 'shape') this.startShape();
      else if (act === 'shape-done') this.finishShape(true);
      else if (act === 'shape-cancel') this.finishShape(false);
      else if (act === 'floors') {
        const input = this.el.querySelector<HTMLInputElement>('[name="floors"]')!;
        input.value = String(Math.max(1, Math.min(MAX_FLOORS, (parseInt(input.value, 10) || 1) + Number(btn.dataset.delta))));
        this.onInput();
      } else if (act === 'colour') {
        this.draft = { ...this.read(), colour: this.draft?.colour === btn.dataset.colour ? null : btn.dataset.colour! };
        this.el.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', (s as HTMLElement).dataset.colour === this.draft!.colour));
        this.applyPreview();
      } else if (act === 'earn') {
        ev.preventDefault();
        this.d.onEarn();
      } else if (act === 'login') {
        ev.preventDefault();
        this.d.onLogin();
      } else if (act === 'publish') {
        if (!(await this.identity())) return;
        const changes = this.read();
        changes.colour = this.draft?.colour ?? null;
        const f = this.d.world.feature(id)!;
        if (f.properties.line && !changes.props.line) changes.props.line = f.properties.line;
        const ctx = { kind: this.kind(), geometry: this.geometry, neighbourhood: this.open_.neighbourhood ?? f.properties.neighbourhood };
        const fresh = !this.d.state.get(id);
        await this.act(() => store.edit(id, ctx, changes), (r) => `Published · +${r.gained} points`);
        this.originalGeometry = null;
        if (fresh) this.d.onFresh(id);
      } else if (act === 'buy') {
        if (!(await this.identity())) return;
        await this.act(() => store.buy(id), (r) => `It is yours · ${esc(r.plot.owner_name || '')}`);
      } else if (act === 'plant') {
        const crop = this.el.querySelector<HTMLSelectElement>('[name="crop"]')!.value;
        await this.act(() => store.plant(id, crop), () => `${CROPS[crop].emoji} Planted. Come back in ${hours(CROPS[crop].hours)}.`);
      } else if (act === 'harvest') {
        await this.act(() => store.harvest(id), (r) => `Harvested · +${r.gained} points and coins`);
      } else if (act === 'hoarding' || act === 'hoarding-down') {
        const text = act === 'hoarding-down' ? '' : this.el.querySelector<HTMLInputElement>('[name="hoarding"]')!.value;
        await this.act(() => store.hoarding(id, text), () => (text ? '📢 Hoarding is up' : 'Hoarding taken down'));
      } else if (act === 'confirm') {
        await this.act(() => store.confirm(id), () => 'Confirmed · +3 points');
      } else if (act === 'confirm-photo') {
        if (!(await this.identity())) return;
        this.el.querySelector<HTMLInputElement>('[name="confirm_file"]')!.click();
      } else if (act === 'upload') {
        this.el.querySelector<HTMLInputElement>('[name="photo_file"]')!.click();
      } else if (act === 'history') {
        ev.preventDefault();
        const box = this.el.querySelector<HTMLElement>('.history')!;
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false; box.innerHTML = '<div class="hint">Loading…</div>';
        const items = await store.history(id);
        box.innerHTML = items.length ? `<ol class="hist">${items.map((h) => `<li><b>${esc(h.player || 'someone')}</b> <span class="sub">${new Date(h.time).toLocaleString()}</span><br><span class="sub">${esc(Object.entries(h.changes).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'props').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 160) || 'created')}</span></li>`).join('')}</ol>` : '<div class="hint">No history yet.</div>';
      } else if (act === 'flag') {
        this.el.querySelector<HTMLElement>('.flag-box')!.hidden = false;
      } else if (act === 'flag-send') {
        const reason = this.el.querySelector<HTMLSelectElement>('[name="flag_reason"]')!.value;
        await this.act(() => store.flag(id, reason), (r) => (r.plot.hidden ? 'Flagged · now under review' : 'Flagged · thanks'));
      } else if (act === 'copy') {
        ev.preventDefault();
        const url = `${location.origin}${location.pathname}#b=${encodeURIComponent(id)}`;
        await navigator.clipboard?.writeText(url);
        this.d.toast('Link copied', 'ok');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      this.error = msg;
      this.d.toast(msg, 'err');
      if (/log in/i.test(msg)) this.d.onLogin();
      this.render();
    }
  }
}
