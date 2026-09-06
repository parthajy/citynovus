// Talks to the CityNovus API (server/). Cookie session for accounts, a device id for guests.
import type { Position } from 'geojson';
import type { Activity, EditContext, EditInput, Footprint, HistoryItem, Kind, LedgerItem, Note, Notification, Offer, Player, Plot, Quest, Result, SaleStatus, Session, Store } from './types';
import { API_URL } from './config';
import { uuid } from './geo';

const DEVICE_KEY = 'tw.device';
function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = uuid(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return 'ephemeral-' + uuid(); }
}

export class ServerStore implements Store {
  readonly mode = 'server' as const;
  private me: Player = { id: 'guest', name: null, points: 0, coins: 0 };
  private session: Session = { player: null, loggedIn: false, verified: false, requireLogin: false, requireVerified: false, flagMinPoints: 1000, authMethods: { google: false, password: false }, provisionalHours: 24, unsaved: 0 };
  private listeners: ((p: Plot) => void)[] = [];
  private deleters: ((id: string) => void)[] = [];
  private es: EventSource | null = null;

  attachWorld(_fn: () => Iterable<Footprint>) { /* the server has the world */ }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API_URL + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? { 'X-Device-Id': deviceId() } : { 'Content-Type': 'application/json', 'X-Device-Id': deviceId() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || (res.status === 429 ? 'Too many requests. Slow down a little.' : `${res.status} from the server`));
    return data as T;
  }

  static async probe(): Promise<boolean> {
    try {
      const res = await fetch(API_URL + '/api/session', { credentials: 'include', headers: { 'X-Device-Id': deviceId() } });
      return res.ok && (res.headers.get('content-type') || '').includes('json');
    } catch { return false; }
  }

  async init() {
    this.session = await this.call<Session>('GET', '/api/session');
    if (this.session.player) this.me = this.session.player;
    this.es = new EventSource(API_URL + '/api/events', { withCredentials: true });
    this.es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as Plot & { deleted?: boolean };
        if (!m || !m.id) return;
        if (m.deleted) for (const d of this.deleters) d(m.id); else for (const l of this.listeners) l(m);
      } catch { /* ignore */ }
    };
    return this.session;
  }
  player() { return this.me; }
  loggedIn() { return this.session.loggedIn; }
  onChange(cb: (p: Plot) => void) { this.listeners.push(cb); }
  onDelete(cb: (id: string) => void) { this.deleters.push(cb); }
  track(name: string, props: Record<string, unknown> = {}) {
    try { navigator.sendBeacon?.(API_URL + '/api/events/track', new Blob([JSON.stringify({ name, props, device: deviceId() })], { type: 'application/json' })); } catch { /* ignore */ }
  }

  private take(r: Result) { this.me = r.player; return r; }
  async setName(name: string) { this.me = await this.call<Player>('POST', '/api/me', { name }); this.session.player = this.me; return this.me; }
  async register(email: string, password: string, name: string) { this.me = await this.call<Player>('POST', '/api/auth/register', { email, password, name }); this.session.player = this.me; this.session.loggedIn = true; return this.me; }
  async login(email: string, password: string) { this.me = await this.call<Player>('POST', '/api/auth/login', { email, password }); this.session.player = this.me; this.session.loggedIn = true; return this.me; }
  async deleteAccount() { await this.call('POST', '/api/me/delete'); try { localStorage.removeItem('tw.device'); } catch { /* ignore */ } }
  async logout() { await this.call('POST', '/api/auth/logout'); this.session.player = null; this.session.loggedIn = false; this.me = { id: 'guest', name: null, points: 0, coins: 0 }; }
  async forgot(email: string) { return (await this.call<{ message: string }>('POST', '/api/auth/forgot', { email })).message; }
  async wishlist() { return this.call<{ top: { key: string; city: string; votes: number }[]; mine: string[] }>('GET', '/api/wishlist'); }
  async wish(city: string, note?: string) { await this.call('POST', '/api/wishlist', { city, note }); }
  async unwish(key: string) { await this.call('DELETE', `/api/wishlist/${encodeURIComponent(key)}`); }
  async saleTerms(id: string, status: SaleStatus, price: number | null) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/sale`, { status, price })); }
  async offer(id: string, amount: number) { const r = await this.call<{ player: Player }>('POST', `/api/plots/${encodeURIComponent(id)}/offer`, { amount }); this.me = r.player; return r.player; }
  async offers() { return this.call<{ made: Offer[]; received: Offer[] }>('GET', '/api/offers'); }
  async decideOffer(id: number, action: 'accept' | 'decline' | 'cancel') { const r = await this.call<{ player: Player }>('POST', `/api/offers/${id}/${action}`); if (r.player) this.me = r.player; return r.player; }
  async shield(id: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/shield`)); }
  async resolve(id: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/resolve`)); }
  async notes(id: string) { return this.call<Note[]>('GET', `/api/plots/${encodeURIComponent(id)}/notes`); }
  async addNote(id: string, text: string) { await this.call('POST', `/api/plots/${encodeURIComponent(id)}/notes`, { text }); }
  async board(name: string) { return this.call<Note[]>('GET', `/api/boards/${encodeURIComponent(name)}`); }
  async addBoardNote(name: string, text: string) { await this.call('POST', `/api/boards/${encodeURIComponent(name)}`, { text }); }
  async inbox() { return this.call<{ items: Notification[]; unread: number }>('GET', '/api/inbox'); }
  async markRead() { await this.call('POST', '/api/inbox/read'); }
  async ledger() { return this.call<LedgerItem[]>('GET', '/api/me/ledger'); }
  async quests() { return this.call<{ day: string; quests: Quest[] }>('GET', '/api/quests'); }
  async claimQuest(id: string) { const r = await this.call<{ player: Player }>('POST', `/api/quests/${id}/claim`); this.me = r.player; return r.player; }
  async treasury() { return (await this.call<{ balance: number }>('GET', '/api/treasury')).balance; }
  async googleStart() { return (await this.call<{ url: string }>('POST', '/api/auth/google/start', { device: deviceId() })).url; }
  async reset(token: string, password: string) { return (await this.call<{ message: string }>('POST', '/api/auth/reset', { token, password })).message; }
  async loadPlots() { return this.call<Plot[]>('GET', '/api/plots'); }
  async edit(id: string, ctx: EditContext, changes: EditInput) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/edit`, { ctx, changes })); }
  async confirm(id: string, photoUrl?: string | null) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/confirm`, { photo_url: photoUrl ?? null })); }
  async flag(id: string, reason: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/flag`, { reason })); }
  async buy(id: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/buy`)); }
  async plant(id: string, crop: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/plant`, { crop })); }
  async harvest(id: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/harvest`)); }
  async hoarding(id: string, text: string) { return this.take(await this.call('POST', `/api/plots/${encodeURIComponent(id)}/hoarding`, { text })); }
  async placePoint(kind: Kind, center: Position, neighbourhood: string, subtype?: string) { return this.take(await this.call('POST', '/api/points', { kind, center, neighbourhood, subtype })); }
  async undo(id: string) { const r = await this.call<{ id: string; player: Player }>('POST', `/api/plots/${encodeURIComponent(id)}/undo`); this.me = r.player; return r; }
  async uploadPhoto(file: File) {
    const fd = new FormData(); fd.append('photo', file, file.name || 'photo.jpg');
    const res = await fetch(API_URL + '/api/photos', { method: 'POST', credentials: 'include', headers: { 'X-Device-Id': deviceId() }, body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'Upload failed');
    return (data as { url: string }).url;
  }
  async activity() { return this.call<Activity[]>('GET', '/api/activity'); }
  async history(id: string) { return this.call<HistoryItem[]>('GET', `/api/plots/${encodeURIComponent(id)}/history`); }
}
