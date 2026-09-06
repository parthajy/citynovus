import type { Position } from 'geojson';
export type { EditContext, EditInput, Footprint, Kind, Player, Plot, Props, SaleStatus } from '../shared/rules';
import type { EditContext, EditInput, Footprint, Kind, Player, Plot, SaleStatus } from '../shared/rules';

export interface Session {
  player: (Player & { avatar?: string | null }) | null; loggedIn: boolean; verified: boolean; requireLogin: boolean; requireVerified: boolean; flagMinPoints: number;
  authMethods: { google: boolean; password: boolean }; provisionalHours: number; unsaved: number; admin?: boolean;
  streak?: number; streakBonus?: number; unread?: number;
}
export interface Offer { id: number; plot_id: string; amount: number; status: string; created_at: string; plot_name: string | null; kind: string; owner_name?: string; buyer_name?: string }
export interface Notification { id: number; type: string; text: string; plot_id: string | null; offer_id: number | null; read: boolean; created_at: string }
export interface Note { id: number; player_name: string | null; text: string; created_at: string }
export interface LedgerItem { delta_points: number; delta_coins: number; reason: string; plot_id: string | null; plot_name: string | null; created_at: string }
export interface Quest { id: string; label: string; need: number; progress: number; reward: number; done: boolean; claimed: boolean }
export interface Result { plot: Plot; player: Player; gained: number }
export interface Activity { time: string; player: string | null; reason: string; plot_id: string | null; plot_name: string | null; kind: string | null; neighbourhood: string | null }
export interface HistoryItem { time: string; player: string | null; changes: Record<string, unknown> }

export interface Store {
  readonly mode: 'local' | 'server';
  /** The rules need every footprint around a new shape to enforce guardrails. */
  attachWorld(fn: () => Iterable<Footprint>): void;
  init(): Promise<Session>;
  player(): Player;
  loggedIn(): boolean;
  setName(name: string): Promise<Player>;
  register(email: string, password: string, name: string): Promise<Player>;
  login(email: string, password: string): Promise<Player>;
  logout(): Promise<void>;
  deleteAccount(): Promise<void>;
  forgot(email: string): Promise<string>;
  /** Returns the URL to send the browser to for Google sign-in. */
  googleStart(): Promise<string>;
  reset(token: string, password: string): Promise<string>;
  loadPlots(): Promise<Plot[]>;
  edit(id: string, ctx: EditContext, changes: EditInput): Promise<Result>;
  confirm(id: string, photoUrl?: string | null): Promise<Result>;
  flag(id: string, reason: string): Promise<Result>;
  buy(id: string): Promise<Result>;
  plant(id: string, crop: string): Promise<Result>;
  harvest(id: string): Promise<Result>;
  hoarding(id: string, text: string): Promise<Result>;
  placePoint(kind: Kind, center: Position, neighbourhood: string, subtype?: string): Promise<Result>;
  undo(id: string): Promise<{ id: string; player: Player }>;
  uploadPhoto(file: File): Promise<string>;
  activity(): Promise<Activity[]>;
  history(id: string): Promise<HistoryItem[]>;
  track(name: string, props?: Record<string, unknown>): void;
  wishlist(): Promise<{ top: { key: string; city: string; votes: number }[]; mine: string[] }>;
  saleTerms(id: string, status: SaleStatus, price: number | null): Promise<Result>;
  offer(id: string, amount: number): Promise<Player>;
  offers(): Promise<{ made: Offer[]; received: Offer[] }>;
  decideOffer(id: number, action: 'accept' | 'decline' | 'cancel'): Promise<Player>;
  shield(id: string): Promise<Result>;
  resolve(id: string): Promise<Result>;
  notes(id: string): Promise<Note[]>;
  addNote(id: string, text: string): Promise<void>;
  board(name: string): Promise<Note[]>;
  addBoardNote(name: string, text: string): Promise<void>;
  inbox(): Promise<{ items: Notification[]; unread: number }>;
  markRead(): Promise<void>;
  ledger(): Promise<LedgerItem[]>;
  quests(): Promise<{ day: string; quests: Quest[] }>;
  claimQuest(id: string): Promise<Player>;
  treasury(): Promise<number>;
  wish(city: string, note?: string): Promise<void>;
  unwish(key: string): Promise<void>;
  onChange(cb: (p: Plot) => void): void;
  onDelete(cb: (id: string) => void): void;
}
