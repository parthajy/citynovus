// Runs the whole game inside one browser using the same rules module as the server.
import type { Position } from 'geojson';
import type { Activity, EditContext, EditInput, Footprint, HistoryItem, Kind, Note, Player, Plot, Result, SaleStatus, Session, Store } from './types';
import { LOCAL_FLAG_MIN_POINTS, STARTING_COINS } from './config';
import { applyBuy, applyConfirm, applyEdit, applyFlag, applyHarvest, applyHoarding, applyPlant, applyResolve, applySaleTerms, applyShield, canUndo, checkNote, checkPlacement, checkSize, newPoint, pointRing, NOTES_MIN_POINTS, type Outcome } from '../shared/rules';
import { uuid } from './geo';

const K = { player: 'tw.player', plots: 'tw.plots', confirms: 'tw.confirms', flags: 'tw.flags', log: 'tw.log' };

function read<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

export class LocalStore implements Store {
  readonly mode = 'local' as const;
  private me!: Player;
  private plots = new Map<string, Plot>();
  private confirms = new Set<string>();
  private flags = new Set<string>();
  private log: Activity[] = [];
  private listeners: ((p: Plot) => void)[] = [];
  private deleters: ((id: string) => void)[] = [];
  private world: () => Iterable<Footprint> = () => [];

  attachWorld(fn: () => Iterable<Footprint>) { this.world = fn; }

  async init(): Promise<Session> {
    this.me = read<Player>(K.player, { id: 'local-' + uuid(), name: null, points: 0, coins: STARTING_COINS });
    if (typeof this.me.coins !== 'number') this.me.coins = STARTING_COINS;
    write(K.player, this.me);
    for (const p of read<Plot[]>(K.plots, [])) this.plots.set(p.id, p);
    this.confirms = new Set(read<string[]>(K.confirms, []));
    this.flags = new Set(read<string[]>(K.flags, []));
    this.log = read<Activity[]>(K.log, []);
    return { player: this.me, loggedIn: true, verified: true, requireLogin: false, requireVerified: false, flagMinPoints: LOCAL_FLAG_MIN_POINTS, authMethods: { google: false, password: false }, provisionalHours: 0, unsaved: 0 };
  }
  player() { return this.me; }
  loggedIn() { return true; }
  async setName(name: string) { this.me = { ...this.me, name: name.trim() || null }; write(K.player, this.me); return this.me; }
  async register() { return this.me; }
  async login() { return this.me; }
  async logout() { /* nothing to do in local mode */ }
  async deleteAccount() { try { for (const k of Object.values(K)) localStorage.removeItem(k); } catch { /* ignore */ } }
  async forgot() { return 'Local mode has no accounts.'; }
  async wishlist() { const w = read<{ city: string; key: string }[]>('tw.wish', []); return { top: w.map((x) => ({ key: x.key, city: x.city, votes: 1 })), mine: w.map((x) => x.key) }; }
  async wish(city: string) { const w = read<{ city: string; key: string }[]>('tw.wish', []); const key = city.toLowerCase().trim(); if (!w.some((x) => x.key === key)) w.push({ city: city.trim(), key }); write('tw.wish', w); }
  async unwish(key: string) { write('tw.wish', read<{ city: string; key: string }[]>('tw.wish', []).filter((x) => x.key !== key)); }
  private live(): never { throw new Error('This needs the live server. Run npm run server.'); }
  async saleTerms(id: string, status: SaleStatus, price: number | null) { const p = this.plots.get(id); if (!p) throw new Error('Claim it first.'); return this.commit(applySaleTerms(p, this.me, status, price), 'sale_terms'); }
  async offer(): Promise<Player> { return this.live(); }
  async offers() { return { made: [], received: [] }; }
  async decideOffer(): Promise<Player> { return this.live(); }
  async shield(id: string) { const p = this.plots.get(id); if (!p) throw new Error('Claim it first.'); return this.commit(applyShield(p, this.me, this.now()), 'shield'); }
  async resolve(id: string) { const p = this.plots.get(id); if (!p) throw new Error('No such report.'); return this.commit(applyResolve(p, this.me, this.now()), 'resolve'); }
  async notes(id: string) { return read<Note[]>('tw.notes.' + id, []); }
  async addNote(id: string, text: string) { const t = checkNote(text, this.me, NOTES_MIN_POINTS); const n = read<Note[]>('tw.notes.' + id, []); n.unshift({ id: Date.now(), player_name: this.me.name, text: t, created_at: this.now() }); write('tw.notes.' + id, n); }
  async board() { return []; }
  async addBoardNote(): Promise<void> { return this.live(); }
  async inbox() { return { items: [], unread: 0 }; }
  async markRead() { /* nothing */ }
  async ledger() { return this.log.map((a) => ({ delta_points: 0, delta_coins: 0, reason: a.reason, plot_id: a.plot_id, plot_name: a.plot_name, created_at: a.time })); }
  async quests() { return { day: '', quests: [] }; }
  async claimQuest(): Promise<Player> { return this.live(); }
  async treasury() { return 0; }
  async googleStart(): Promise<string> { throw new Error('Local mode has no accounts. Run the server to sign in.'); }
  async reset() { return 'Local mode has no accounts.'; }
  async loadPlots() { return [...this.plots.values()]; }
  onChange(cb: (p: Plot) => void) { this.listeners.push(cb); }
  onDelete(cb: (id: string) => void) { this.deleters.push(cb); }
  track() { /* nothing to report to in local mode */ }

  private commit(o: Outcome, reason: string): Result {
    this.me = { ...this.me, points: this.me.points + o.points, coins: this.me.coins + o.coins };
    write(K.player, this.me);
    this.plots.set(o.plot.id, o.plot);
    write(K.plots, [...this.plots.values()]);
    this.log.unshift({ time: new Date().toISOString(), player: this.me.name, reason, plot_id: o.plot.id, plot_name: o.plot.name, kind: o.plot.kind, neighbourhood: o.plot.neighbourhood });
    this.log = this.log.slice(0, 60); write(K.log, this.log);
    for (const l of this.listeners) l(o.plot);
    return { plot: o.plot, player: this.me, gained: o.points };
  }
  private now() { return new Date().toISOString(); }
  private guard(kind: Kind, ring: Position[], selfId?: string) {
    checkSize(kind, ring);
    checkPlacement(kind, ring, this.world(), selfId);
  }

  async edit(id: string, ctx: EditContext, changes: EditInput) {
    const existing = this.plots.get(id) ?? null;
    if (ctx.geometry) this.guard(existing?.kind ?? ctx.kind, ctx.geometry.coordinates[0], id);
    return this.commit(applyEdit(existing, id, ctx, changes, this.me, this.now()), existing ? 'edit' : 'claim');
  }
  async confirm(id: string, photoUrl?: string | null) {
    const p = this.plots.get(id); if (!p) throw new Error('Nothing to confirm yet.');
    const r = this.commit(applyConfirm(p, this.me, this.confirms.has(id), photoUrl), 'confirm');
    this.confirms.add(id); write(K.confirms, [...this.confirms]);
    return r;
  }
  async flag(id: string, _reason: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Nothing to flag yet.');
    const r = this.commit(applyFlag(p, this.me, this.flags.has(id), LOCAL_FLAG_MIN_POINTS), 'flag');
    this.flags.add(id); write(K.flags, [...this.flags]);
    return r;
  }
  async buy(id: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Nothing to buy yet. Colour it in and it is yours.');
    return this.commit(applyBuy(p, this.me, this.now()), 'buy');
  }
  async plant(id: string, crop: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Claim it first.');
    return this.commit(applyPlant(p, crop, this.me, this.now()), 'plant');
  }
  async harvest(id: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Nothing here.');
    return this.commit(applyHarvest(p, this.me, this.now()), 'harvest');
  }
  async hoarding(id: string, text: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Claim it first.');
    return this.commit(applyHoarding(p, text, this.me, this.now()), 'hoarding');
  }
  async placePoint(kind: Kind, center: Position, neighbourhood: string, subtype?: string) {
    this.guard(kind, pointRing(kind, center));
    return this.commit(newPoint('tw/' + uuid(), kind, center, neighbourhood, this.me, this.now(), subtype), kind);
  }
  async undo(id: string) {
    const p = this.plots.get(id); if (!p) throw new Error('Nothing to undo.');
    if (!canUndo(p, this.me)) throw new Error('The undo window has passed.');
    const gained = id.startsWith('tw/') ? (await import('../shared/rules')).KINDS[p.kind].tracePoints : (await import('../shared/rules')).KINDS[p.kind].editPoints;
    this.me = { ...this.me, points: Math.max(0, this.me.points - gained), coins: Math.max(0, this.me.coins - gained) };
    write(K.player, this.me);
    this.plots.delete(id); write(K.plots, [...this.plots.values()]);
    for (const d of this.deleters) d(id);
    return { id, player: this.me };
  }
  async uploadPhoto(file: File) {
    if (file.size > 4 * 1024 * 1024) throw new Error('Photos up to 4 MB.');
    return new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Could not read the photo.')); r.readAsDataURL(file); });
  }
  async activity() { return this.log; }
  async history(id: string): Promise<HistoryItem[]> { return this.log.filter((a) => a.plot_id === id).map((a) => ({ time: a.time, player: a.player, changes: { reason: a.reason } })); }
}
