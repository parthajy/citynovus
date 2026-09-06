// The rules of CityNovus. Pure functions, no I/O, used by the browser (local mode and previews)
// and by the server, so a rule can never differ between the two.
import type { Polygon, Position } from 'geojson';
import { circleRing, ringAreaM2, ringsOverlap } from './geo';

export type Kind = 'building' | 'pond' | 'park' | 'playground' | 'flyover' | 'road' | 'farm' | 'tree' | 'landmark' | 'furniture' | 'wall' | 'railway';
export const KIND_IDS: Kind[] = ['building', 'farm', 'tree', 'landmark', 'furniture', 'park', 'playground', 'pond', 'flyover', 'road', 'wall', 'railway'];

export interface KindRule {
  label: string;
  emoji: string;
  shape: 'polygon' | 'line' | 'point';
  tracePoints: number; // creating one where OSM has nothing
  editPoints: number; // colouring in / changing one
  buyBase: number; // coins, before multipliers
  lanes?: number;
  width?: number; // metres, for line kinds without lanes
  radius?: number; // metres, for point kinds
  minM2: number;
  maxM2: number;
  hint: string;
}
export const KINDS: Record<Kind, KindRule> = {
  building: { label: 'Building', emoji: '🏠', shape: 'polygon', tracePoints: 25, editPoints: 10, buyBase: 120, minM2: 6, maxM2: 40_000, hint: 'Tap the corners of the building' },
  farm: { label: 'Farm', emoji: '🌾', shape: 'polygon', tracePoints: 20, editPoints: 10, buyBase: 60, minM2: 20, maxM2: 300_000, hint: 'Tap around the edge of the field' },
  tree: { label: 'Tree', emoji: '🌳', shape: 'point', tracePoints: 5, editPoints: 2, buyBase: 10, minM2: 1, maxM2: 100, hint: 'Tap once where the tree stands' },
  park: { label: 'Park / garden', emoji: '🌿', shape: 'polygon', tracePoints: 20, editPoints: 10, buyBase: 90, minM2: 20, maxM2: 2_000_000, hint: 'Tap around the edge of the park' },
  playground: { label: 'Playground / field', emoji: '⚽', shape: 'polygon', tracePoints: 15, editPoints: 10, buyBase: 60, minM2: 20, maxM2: 200_000, hint: 'Tap around the field' },
  pond: { label: 'Pond / lake', emoji: '💧', shape: 'polygon', tracePoints: 20, editPoints: 10, buyBase: 150, minM2: 10, maxM2: 2_000_000, hint: "Tap around the water's edge" },
  flyover: { label: 'Flyover / bridge', emoji: '🌉', shape: 'line', tracePoints: 20, editPoints: 10, buyBase: 300, lanes: 4, minM2: 20, maxM2: 500_000, hint: 'Tap along the middle of the flyover, end to end' },
  road: { label: 'Road / lane', emoji: '🛣️', shape: 'line', tracePoints: 15, editPoints: 10, buyBase: 40, lanes: 2, minM2: 10, maxM2: 500_000, hint: 'Tap along the middle of the road' },
  landmark: { label: 'Landmark', emoji: '🛕', shape: 'point', tracePoints: 15, editPoints: 5, buyBase: 80, radius: 4, minM2: 1, maxM2: 400, hint: 'Tap where it stands' },
  furniture: { label: 'Street furniture', emoji: '💡', shape: 'point', tracePoints: 3, editPoints: 2, buyBase: 10, radius: 1.2, minM2: 0.5, maxM2: 50, hint: 'Tap where it goes' },
  wall: { label: 'Wall / fence', emoji: '🧱', shape: 'line', tracePoints: 10, editPoints: 5, buyBase: 30, width: 0.5, minM2: 1, maxM2: 20_000, hint: 'Tap along the wall' },
  railway: { label: 'Railway', emoji: '🚆', shape: 'line', tracePoints: 15, editPoints: 5, buyBase: 200, width: 4, minM2: 10, maxM2: 500_000, hint: 'Tap along the track' },
};
/** One-word names for tight spaces and short messages. */
export const SHORT: Record<Kind, string> = { building: 'building', farm: 'farm', tree: 'tree', park: 'park', playground: 'playground', pond: 'pond', flyover: 'flyover', road: 'road', landmark: 'landmark', furniture: 'furniture', wall: 'wall', railway: 'railway' };
export const SHORT_LABEL: Record<Kind, string> = { building: 'Building', farm: 'Farm', tree: 'Tree', park: 'Park', playground: 'Playground', pond: 'Pond', flyover: 'Flyover', road: 'Road', landmark: 'Landmark', furniture: 'Furniture', wall: 'Wall', railway: 'Railway' };
export const SHORT_HINT: Record<'polygon' | 'line' | 'point', string> = { polygon: 'Tap the corners', line: 'Tap along it', point: 'Tap once' };
export const LANDMARKS = [
  { id: 'temple', label: 'Temple' }, { id: 'mosque', label: 'Mosque' }, { id: 'church', label: 'Church' },
  { id: 'statue', label: 'Statue' }, { id: 'gate', label: 'Gate / arch' }, { id: 'tank', label: 'Water tank' },
];
export const FURNITURE = [
  { id: 'streetlight', label: 'Streetlight' }, { id: 'busstop', label: 'Bus stop' }, { id: 'bench', label: 'Bench' },
  { id: 'dustbin', label: 'Dustbin' }, { id: 'teastall', label: 'Tea stall cart' },
];
export const SIGN_MAX = 30;
export const LANE_WIDTH = 3.5;
export const FLYOVER_HEIGHT = 6;
export const FLOOR_HEIGHT = 3.2;
export const MAX_FLOORS = 60;
export const TREE_RADIUS_M = 2.2;

/** What may not sit on top of what. A new `kind` is refused where any of these already are. */
export const BLOCKED_BY: Record<Kind, Kind[]> = {
  building: ['building', 'pond', 'flyover', 'farm', 'tree', 'road', 'landmark', 'railway', 'wall', 'furniture'],
  farm: ['building', 'pond', 'flyover', 'farm', 'road', 'tree', 'playground', 'landmark', 'railway'],
  tree: ['building', 'pond', 'flyover', 'road', 'farm', 'tree', 'landmark', 'railway', 'furniture'],
  park: ['building', 'pond', 'farm', 'park', 'playground'],
  playground: ['building', 'pond', 'farm', 'park', 'playground', 'flyover', 'landmark'],
  pond: ['building', 'farm', 'road', 'flyover', 'tree', 'pond', 'playground', 'landmark', 'railway', 'wall', 'furniture'],
  flyover: ['building', 'farm', 'tree', 'flyover', 'landmark'],
  road: ['building', 'pond', 'farm', 'tree', 'road', 'landmark'],
  landmark: ['building', 'pond', 'flyover', 'road', 'farm', 'landmark', 'tree', 'railway', 'furniture'],
  furniture: ['building', 'pond', 'landmark', 'furniture', 'tree'],
  wall: ['building', 'pond', 'wall', 'landmark'],
  railway: ['building', 'pond', 'farm', 'railway', 'landmark', 'tree'],
};
/** Strip width in metres for a line kind. */
export function lineWidth(kind: Kind, lanes?: number): number {
  const K = KINDS[kind];
  if (K.width) return K.width;
  return (lanes ?? K.lanes ?? 2) * LANE_WIDTH;
}

export interface Crop { label: string; emoji: string; hours: number; cost: number; yield: number; colour: string; ripe: string; height: number }
export const CROPS: Record<string, Crop> = {
  tomato: { label: 'Tomato', emoji: '🍅', hours: 4, cost: 10, yield: 22, colour: '#4f8a3a', ripe: '#d8453a', height: 0.9 },
  mustard: { label: 'Mustard', emoji: '🌼', hours: 8, cost: 12, yield: 30, colour: '#6aa84f', ripe: '#f2c14e', height: 1.0 },
  chilli: { label: 'Bhut jolokia', emoji: '🌶️', hours: 12, cost: 20, yield: 55, colour: '#3f7a3e', ripe: '#c0392b', height: 0.8 },
  rice: { label: 'Joha rice', emoji: '🌾', hours: 24, cost: 25, yield: 90, colour: '#7cb342', ripe: '#d4b94a', height: 1.1 },
  banana: { label: 'Banana', emoji: '🍌', hours: 36, cost: 30, yield: 120, colour: '#3d8b6e', ripe: '#e5c85a', height: 2.6 },
  tea: { label: 'Tea', emoji: '🍵', hours: 48, cost: 40, yield: 170, colour: '#2e7d4f', ripe: '#4fa06a', height: 1.2 },
  bamboo: { label: 'Bamboo', emoji: '🎋', hours: 72, cost: 35, yield: 200, colour: '#6b9b37', ripe: '#9dbb4c', height: 5 },
};
export const CROP_IDS = Object.keys(CROPS);

export const POINTS = { confirm: 3, confirmedBonus: 5, harvest: 5, buy: 5 };
export const STARTING_COINS = 200;
export const HOARDING_COST = 50;
export const HOARDING_DAYS = 7;
export const HOARDING_MAX = 40;
export const FLAG_THRESHOLD = 5;
export const DEFAULT_FLAG_MIN_POINTS = 1000;
export const SELLER_SHARE = 0.8;
export const RATE_LIMIT_PER_MIN = 40;
export const flagWeight = (points: number) => Math.min(1, 0.2 + points / 500);

export interface Props {
  trees?: string;
  lanes?: number;
  line?: Position[];
  crop?: string;
  planted_at?: string;
  hoarding?: string;
  hoarding_until?: string;
  subtype?: string; // landmark or furniture type
  sign?: string; // shopfront signage, free for the owner
  photos?: string[]; // photo-verified confirmations
}

export interface Plot {
  id: string; // "way/123" for OSM features, "tw/<uuid>" for player-made ones
  kind: Kind;
  neighbourhood: string;
  geometry: Polygon | null; // stored for player-made plots, or when a player re-shaped an OSM one
  floors: number;
  colour: string | null;
  style: string | null;
  roof: string | null;
  name: string | null;
  use: string | null;
  photo_url: string | null;
  props: Props;
  built_by_id: string | null;
  built_by_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  last_edit_by_name: string | null;
  confirmations: number;
  flag_score: number;
  hidden: boolean;
  /** Built by a guest: only they see it until they log in; expires otherwise. */
  provisional?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Player {
  id: string;
  name: string | null;
  points: number;
  coins: number;
  email?: string | null;
}

export interface EditInput {
  floors: number;
  colour: string | null;
  style: string | null;
  roof: string | null;
  name: string | null;
  use: string | null;
  photo_url: string | null;
  props: Props;
}
export interface EditContext { kind: Kind; geometry: Polygon | null; neighbourhood: string }

/** A footprint the rules can check against: either an OSM feature or a stored plot. */
export interface Footprint { id: string; kind: Kind; ring: Position[]; hidden?: boolean }

export class RuleError extends Error {}
function fail(m: string): never { throw new RuleError(m); }

/** Text that is never a building name: contact details and links. Word filtering lives on the server. */
export function checkText(t: string | null | undefined, what = 'That'): void {
  if (!t) return;
  if (/(\+?\d[\d\s-]{8,}\d)/.test(t)) fail(`${what} cannot contain a phone number.`);
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) fail(`${what} cannot contain an email address.`);
  if (/https?:\/\/|www\.|\.(com|in|org|net)\b/i.test(t)) fail(`${what} cannot contain a link.`);
}
export const UNDO_SECONDS = 90;
export function canUndo(p: Plot, me: Player, now = Date.now()): boolean {
  return p.owner_id === me.id && p.built_by_id === me.id && now - Date.parse(p.created_at) < UNDO_SECONDS * 1000;
}

// ---------- pricing and growth ----------

export function buyPrice(p: Plot): number {
  const base = KINDS[p.kind].buyBase;
  const size = p.kind === 'building' ? 1 + (p.floors - 1) * 0.25 : 1;
  const cred = 1 + Math.min(p.confirmations, 10) * 0.2;
  const price = Math.round(base * size * cred);
  return p.hidden ? Math.max(5, Math.round(price / 10)) : price;
}

/** 0 = just planted, 1 = ready to harvest. */
export function cropStage(props: Props, now = Date.now()): number {
  if (!props.crop || !props.planted_at) return 0;
  const c = CROPS[props.crop];
  if (!c) return 0;
  const t = (now - Date.parse(props.planted_at)) / (c.hours * 3600_000);
  return Math.max(0, Math.min(1, t));
}
export function hoardingActive(props: Props, now = Date.now()): boolean {
  return !!props.hoarding && !!props.hoarding_until && Date.parse(props.hoarding_until) > now;
}
export function canTerrace(p: { kind: Kind; roof: string | null }): boolean {
  return p.kind === 'farm' || (p.kind === 'building' && p.roof === 'flat');
}

// ---------- guardrails ----------

export function checkSize(kind: Kind, ring: Position[]): void {
  const K = KINDS[kind];
  const a = ringAreaM2(ring);
  if (a < K.minM2) fail(`That is too small to be a real ${K.label.toLowerCase()}.`);
  if (a > K.maxM2) fail(`That is too big for one ${K.label.toLowerCase()}. Trace it in parts.`);
}

/** Refuse a shape that sits on something it may not: a house in a pond, a farm on a flyover. */
export function checkPlacement(kind: Kind, ring: Position[], others: Iterable<Footprint>, selfId?: string): void {
  const blocked = BLOCKED_BY[kind];
  for (const o of others) {
    if (o.id === selfId || !blocked.includes(o.kind)) continue;
    if (ringsOverlap(ring, o.ring)) fail(`A ${SHORT[kind]} can't sit on a ${SHORT[o.kind]}. Move it a little.`);
  }
}

export function treeRing(center: Position): Position[] { return circleRing(center, TREE_RADIUS_M, 8); }
export function pointRing(kind: Kind, center: Position): Position[] { return circleRing(center, KINDS[kind].radius ?? TREE_RADIUS_M, 8); }

// ---------- actions ----------
// Each returns the new plot and what the actor gains. Callers persist both.

export interface Outcome { plot: Plot; points: number; coins: number; seller?: { id: string; coins: number } }

export function applyEdit(existing: Plot | null, id: string, ctx: EditContext, changes: EditInput, me: Player, now: string): Outcome {
  if (!me.name) fail('Pick a name before publishing.');
  const isNew = !existing;
  const kind = existing?.kind ?? ctx.kind;
  if (!KINDS[kind]) fail('Unknown kind.');
  if (isNew && id.startsWith('tw/') && !ctx.geometry) fail('A traced feature needs a shape.');
  if (existing && existing.owner_id && existing.owner_id !== me.id) {
    fail(existing.hidden ? `This is under review. Buy it for ${buyPrice(existing)} coins to take it over.` : `Owned by ${existing.owner_name || 'someone else'}. Buy it to change it.`);
  }
  const floors = Math.max(1, Math.min(MAX_FLOORS, Math.round(changes.floors || 1)));
  if (changes.colour && !/^#[0-9a-fA-F]{6}$/.test(changes.colour)) fail('Bad colour.');
  if (changes.name && changes.name.length > 60) fail('Name is too long.');
  checkText(changes.name, 'A name');
  if (changes.props.sign !== undefined) {
    if (kind !== 'building') fail('Signs go on buildings.');
    if ((changes.props.sign ?? '').length > SIGN_MAX) fail(`Keep the sign under ${SIGN_MAX} characters.`);
    checkText(changes.props.sign, 'A sign');
  }
  if ((kind === 'landmark' || kind === 'furniture') && changes.props.subtype) {
    const ok = (kind === 'landmark' ? LANDMARKS : FURNITURE).some((x) => x.id === changes.props.subtype);
    if (!ok) fail('Unknown type.');
  }
  if (changes.photo_url && !/^(https?:\/\/.{1,290}|\/photos\/[\w.-]{1,80}|data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{1,3000000})$/.test(changes.photo_url)) fail('Photo link must be a web address or an uploaded photo.');
  const props: Props = { ...(existing?.props ?? {}), ...changes.props };
  // A crop or hoarding is never set through a plain edit.
  props.crop = existing?.props.crop; props.planted_at = existing?.props.planted_at;
  props.hoarding = existing?.props.hoarding; props.hoarding_until = existing?.props.hoarding_until;
  props.photos = existing?.props.photos;
  if (props.sign !== undefined && !props.sign?.trim()) delete props.sign;
  if (kind === 'building' && changes.roof !== 'flat' && props.crop) fail('Harvest the terrace before changing the roof.');
  const plot: Plot = {
    id, kind,
    neighbourhood: existing?.neighbourhood ?? ctx.neighbourhood ?? 'Unassigned',
    geometry: ctx.geometry ?? existing?.geometry ?? null,
    floors: kind === 'building' ? floors : existing?.floors ?? 1,
    colour: changes.colour ?? null,
    style: changes.style ?? null,
    roof: changes.roof ?? null,
    name: changes.name?.trim() || null,
    use: changes.use ?? null,
    photo_url: changes.photo_url?.trim() || null,
    props,
    built_by_id: existing?.built_by_id ?? me.id,
    built_by_name: existing?.built_by_name ?? me.name,
    owner_id: existing?.owner_id ?? me.id,
    owner_name: existing?.owner_name ?? me.name,
    last_edit_by_name: me.name,
    confirmations: 0,
    flag_score: existing?.flag_score ?? 0,
    hidden: existing?.hidden ?? false,
    provisional: existing?.provisional ?? false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const gained = isNew ? (id.startsWith('tw/') ? KINDS[kind].tracePoints : KINDS[kind].editPoints) : Math.max(2, Math.round(KINDS[kind].editPoints / 2));
  return { plot, points: gained, coins: gained };
}

/** A confirmation with a photo of the real thing counts triple and keeps the photo on the plot. */
export function applyConfirm(p: Plot, me: Player, already: boolean, photoUrl?: string | null): Outcome {
  if (p.owner_id === me.id) fail('You cannot confirm your own work.');
  if (already) fail('You already confirmed this one.');
  const weight = photoUrl ? 3 : 1;
  const photos = photoUrl ? [...(p.props.photos ?? []), photoUrl].slice(-6) : p.props.photos;
  return { plot: { ...p, confirmations: p.confirmations + weight, props: { ...p.props, ...(photos ? { photos } : {}) } }, points: POINTS.confirm * weight, coins: POINTS.confirm * weight };
}

export function applyFlag(p: Plot, me: Player, already: boolean, minPoints: number): Outcome {
  if (me.points < minPoints) fail(`You need ${minPoints} points before you can flag. Build more first.`);
  if (p.owner_id === me.id) fail('You cannot flag your own work.');
  if (already) fail('You already flagged this one.');
  const score = p.flag_score + flagWeight(me.points);
  return { plot: { ...p, flag_score: score, hidden: score >= FLAG_THRESHOLD }, points: 0, coins: 0 };
}

export function applyBuy(p: Plot, me: Player, now: string): Outcome {
  if (!me.name) fail('Pick a name first.');
  if (p.provisional) fail('This is a guest\'s unsaved work and cannot be bought yet.');
  if (p.owner_id === me.id) fail('You already own this.');
  const price = buyPrice(p);
  if (me.coins < price) fail(`You need ${price} coins and have ${me.coins}. Earn more by building and confirming.`);
  const seller = p.owner_id ? { id: p.owner_id, coins: Math.round(price * SELLER_SHARE) } : undefined;
  const plot: Plot = { ...p, owner_id: me.id, owner_name: me.name, confirmations: 0, flag_score: 0, hidden: false, updated_at: now };
  return { plot, points: POINTS.buy, coins: -price, seller };
}

export function applyPlant(p: Plot, crop: string, me: Player, now: string): Outcome {
  const c = CROPS[crop];
  if (!c) fail('Unknown crop.');
  if (p.owner_id !== me.id) fail('Only the owner can plant here.');
  if (!canTerrace(p)) fail(p.kind === 'building' ? 'Only flat roofs can hold a terrace farm.' : 'You can only plant on a farm or a flat roof.');
  if (p.props.crop) fail('Something is already growing here. Harvest it first.');
  if (me.coins < c.cost) fail(`${c.label} seeds cost ${c.cost} coins. You have ${me.coins}.`);
  return { plot: { ...p, props: { ...p.props, crop, planted_at: now }, updated_at: now }, points: 2, coins: -c.cost };
}

export function applyHarvest(p: Plot, me: Player, now: string): Outcome {
  if (p.owner_id !== me.id) fail('Only the owner can harvest.');
  const c = p.props.crop ? CROPS[p.props.crop] : null;
  if (!c) fail('Nothing is growing here.');
  const stage = cropStage(p.props, Date.parse(now));
  if (stage < 1) fail(`${c.label} is ${Math.round(stage * 100)}% grown. Come back later.`);
  const props = { ...p.props }; delete props.crop; delete props.planted_at;
  return { plot: { ...p, props, updated_at: now }, points: POINTS.harvest, coins: c.yield };
}

export function applyHoarding(p: Plot, text: string, me: Player, now: string): Outcome {
  if (p.owner_id !== me.id) fail('Only the owner can put up a hoarding.');
  if (p.kind !== 'building' || p.floors < 2) fail('Hoardings go on buildings with two or more floors.');
  const t = text.trim();
  checkText(t, 'A hoarding');
  if (!t) {
    const props = { ...p.props }; delete props.hoarding; delete props.hoarding_until;
    return { plot: { ...p, props, updated_at: now }, points: 0, coins: 0 };
  }
  if (t.length > HOARDING_MAX) fail(`Keep it under ${HOARDING_MAX} characters.`);
  if (me.coins < HOARDING_COST) fail(`A hoarding costs ${HOARDING_COST} coins for ${HOARDING_DAYS} days.`);
  const until = new Date(Date.parse(now) + HOARDING_DAYS * 86400_000).toISOString();
  return { plot: { ...p, props: { ...p.props, hoarding: t, hoarding_until: until }, updated_at: now }, points: 0, coins: -HOARDING_COST };
}

/** One-tap things: trees, landmarks, street furniture. */
export function newPoint(id: string, kind: Kind, center: Position, neighbourhood: string, me: Player, now: string, subtype?: string): Outcome {
  if (!me.name) fail('Pick a name first.');
  if (KINDS[kind].shape !== 'point') fail('Not a one-tap kind.');
  if (kind === 'landmark' && !LANDMARKS.some((x) => x.id === subtype)) fail('Pick a landmark type.');
  if (kind === 'furniture' && !FURNITURE.some((x) => x.id === subtype)) fail('Pick what it is.');
  const ring = pointRing(kind, center);
  const plot: Plot = {
    id, kind, neighbourhood, geometry: { type: 'Polygon', coordinates: [ring] },
    floors: 1, colour: null, style: null, roof: null, name: null, use: null, photo_url: null, props: subtype ? { subtype } : {},
    built_by_id: me.id, built_by_name: me.name, owner_id: me.id, owner_name: me.name, last_edit_by_name: me.name,
    confirmations: 0, flag_score: 0, hidden: false, created_at: now, updated_at: now,
  };
  return { plot, points: KINDS[kind].tracePoints, coins: KINDS[kind].tracePoints };
}
export function newTree(id: string, center: Position, neighbourhood: string, me: Player, now: string): Outcome {
  return newPoint(id, 'tree', center, neighbourhood, me, now);
}
