// CityNovus API. Run with: npm run server   (PGlite, zero setup)
// or with DATABASE_URL set for a real Postgres. Serves dist/ when it exists.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import multipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { moderate } from './moderation';
import { lastMails, sendMail } from './mail';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Polygon, Position } from 'geojson';
import { openDb, type Queryable } from './db';
import { World } from './world';
import {
  DEFAULT_FLAG_MIN_POINTS, KINDS, RATE_LIMIT_PER_MIN, RuleError, STARTING_COINS, applyBuy, applyConfirm, applyEdit, applyFlag, applyHarvest,
  applyHoarding, applyPlant, canUndo, checkPlacement, checkSize, newPoint, pointRing, type EditContext, type EditInput, type Kind, type Outcome, type Player, type Plot,
} from '../shared/rules';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PORT = Number(process.env.PORT ?? 8080);
const REQUIRE_LOGIN = (process.env.REQUIRE_LOGIN ?? 'false') === 'true';
const FLAG_MIN_POINTS = Number(process.env.FLAG_MIN_POINTS ?? DEFAULT_FLAG_MIN_POINTS);
const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 90);
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'false') === 'true';
const REQUIRE_VERIFIED = (process.env.REQUIRE_VERIFIED ?? 'false') === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'parthajy@gmail.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const SIGNUPS_PER_IP_PER_DAY = Number(process.env.SIGNUPS_PER_IP_PER_DAY ?? 5);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_MOCK = process.env.NODE_ENV !== 'production' && (process.env.GOOGLE_MOCK ?? 'false') === 'true';
const AUTH_METHODS = (process.env.AUTH_METHODS ?? 'google').split(',').map((m) => m.trim());
const PASSWORD_AUTH = AUTH_METHODS.includes('password');
const GOOGLE_AUTH = AUTH_METHODS.includes('google') && (!!GOOGLE_CLIENT_ID || GOOGLE_MOCK);
const PROVISIONAL_TTL_HOURS = Number(process.env.PROVISIONAL_TTL_HOURS ?? 24);
const DATA_DIR = process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
mkdirSync(PHOTO_DIR, { recursive: true });
const COOKIE = 'tw_session';

const db = await openDb();
const world = new World(process.env.WORLD_FILE ?? path.join(ROOT, 'public/data/world.geojson'), process.env.PLACES_FILE ?? path.join(ROOT, 'public/data/places.json'));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 512 * 1024, trustProxy: true });
await app.register(cookie);
await app.register(compress, { global: true });
await app.register(fastifyRateLimit, { global: true, max: Number(process.env.RATE_LIMIT_PER_IP_PER_MIN ?? 300), timeWindow: '1 minute', allowList: (req) => req.url === '/api/events' });
await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const ip = (req: FastifyRequest) => (req.ip || '').slice(0, 64);

// ---------- helpers ----------

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const bad = (msg: string) => new HttpError(400, msg);

const PLOT_COLS = 'id, kind, neighbourhood, geometry, floors, colour, style, roof, name, "use", photo_url, props, built_by_id, built_by_name, owner_id, owner_name, last_edit_by_name, confirmations, flag_score, hidden, provisional, created_at, updated_at';
function rowToPlot(r: Record<string, unknown>): Plot {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    ...(r as unknown as Plot),
    geometry: (r.geometry as Polygon | null) ?? null,
    props: (r.props as Plot['props']) ?? {},
    flag_score: Number(r.flag_score),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}
function rowToPlayer(r: Record<string, unknown>): Player & { verified?: boolean; banned?: boolean } {
  return { id: String(r.id), name: (r.name as string | null) ?? null, points: Number(r.points), coins: Number(r.coins), email: (r.email as string | null) ?? null, verified: !!r.verified, banned: !!r.banned };
}
async function savePlot(q: Queryable, p: Plot) {
  await q.query(
    `insert into plots (${PLOT_COLS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     on conflict (id) do update set kind=$2, neighbourhood=$3, geometry=$4, floors=$5, colour=$6, style=$7, roof=$8, name=$9, "use"=$10, photo_url=$11, props=$12,
       built_by_id=$13, built_by_name=$14, owner_id=$15, owner_name=$16, last_edit_by_name=$17, confirmations=$18, flag_score=$19, hidden=$20, provisional=$21, created_at=$22, updated_at=$23`,
    [p.id, p.kind, p.neighbourhood, p.geometry ? JSON.stringify(p.geometry) : null, p.floors, p.colour, p.style, p.roof, p.name, p.use, p.photo_url, JSON.stringify(p.props),
     p.built_by_id, p.built_by_name, p.owner_id, p.owner_name, p.last_edit_by_name, p.confirmations, p.flag_score, p.hidden, !!p.provisional, p.created_at, p.updated_at],
  );
}
async function getPlot(q: Queryable, id: string): Promise<Plot | null> {
  const r = await q.query(`select ${PLOT_COLS} from plots where id = $1`, [id]);
  return r[0] ? rowToPlot(r[0]) : null;
}
async function getPlayer(q: Queryable, id: string): Promise<(Player & { verified?: boolean; banned?: boolean }) | null> {
  const r = await q.query('select id, name, email, points, coins, verified, banned from players where id = $1', [id]);
  return r[0] ? rowToPlayer(r[0]) : null;
}
async function credit(q: Queryable, playerId: string, points: number, coins: number, reason: string, plotId: string | null): Promise<Player> {
  const r = await q.query('update players set points = points + $2, coins = coins + $3, last_seen = now() where id = $1 returning id, name, email, points, coins', [playerId, points, coins]);
  if (!r[0]) throw bad('No such player.');
  if (points || coins) await q.query('insert into ledger (player_id, delta_points, delta_coins, reason, plot_id) values ($1,$2,$3,$4,$5)', [playerId, points, coins, reason, plotId]);
  return rowToPlayer(r[0]);
}
const isGuest = (id: string) => id.startsWith('dev_');
async function commit(q: Queryable, me: Player, o: Outcome, reason: string) {
  // A guest's new work is provisional: only they see it, until they log in.
  if (isGuest(me.id) && o.plot.owner_id === me.id) o.plot.provisional = true;
  await savePlot(q, o.plot);
  const player = await credit(q, me.id, o.points, o.coins, reason, o.plot.id);
  if (o.seller && o.seller.id !== me.id) await credit(q, o.seller.id, 0, o.seller.coins, 'sold', o.plot.id);
  if (!o.plot.provisional) broadcast(o.plot);
  return { plot: o.plot, player, gained: o.points };
}
/** Guests build alone; judging and buying need an account. */
function requireAccount(me: Player, what: string) {
  if (isGuest(me.id)) throw new HttpError(401, `Log in to ${what}. Guests can build, but not judge, buy or confirm.`);
}
/** Move a guest's points, coins and work onto an account, and make the work visible to everyone. */
async function adoptGuest(guestId: string, accountId: string, name: string) {
  if (!(await getPlayer(db, guestId))) return; // nothing to carry over
  await db.query('update players set points = points + (select points from players where id = $1), coins = coins + (select coins from players where id = $1) where id = $2', [guestId, accountId]);
  await db.query('update players set points = 0, coins = 0 where id = $1', [guestId]);
  await db.query('update plots set owner_id = $2, owner_name = $3, provisional = false where owner_id = $1', [guestId, accountId, name]);
  await db.query('update plots set built_by_id = $2, built_by_name = $3 where built_by_id = $1', [guestId, accountId, name]);
  await db.query('update confirmations set player_id = $2 where player_id = $1', [guestId, accountId]);
  await db.query('update flags set player_id = $2 where player_id = $1', [guestId, accountId]);
  await db.query('update ledger set player_id = $2 where player_id = $1', [guestId, accountId]);
  await db.query('delete from wishlist where player_id = $1 and city_key in (select city_key from wishlist where player_id = $2)', [guestId, accountId]);
  await db.query('update wishlist set player_id = $2 where player_id = $1', [guestId, accountId]);
  for (const r of (await db.query(`select ${PLOT_COLS} from plots where owner_id = $1`, [accountId])).map(rowToPlot)) broadcast(r);
}
/** Provisional work that was never saved goes away. Runs every ten minutes. */
async function expireProvisional() {
  const old = await db.query<{ id: string }>(`select id from plots where provisional and created_at < now() - interval '${PROVISIONAL_TTL_HOURS * 60} minutes'`);
  for (const { id } of old) {
    for (const t of ['confirmations', 'flags', 'edits']) await db.query(`delete from ${t} where plot_id = $1`, [id]);
    await db.query('delete from plots where id = $1', [id]);
  }
  if (old.length) app.log.info(`expired ${old.length} provisional plots`);
  return old.length;
}
setInterval(() => { expireProvisional().catch((e) => app.log.error(e)); }, 10 * 60_000).unref();
async function guard(q: Queryable, kind: Plot['kind'], ring: Position[], selfId?: string, meId?: string) {
  checkSize(kind, ring);
  // Other guests' unsaved work is invisible to this player, so it must not block them either.
  const rows = await q.query('select id, kind, geometry, hidden from plots where not provisional or owner_id = $1', [meId ?? '']);
  checkPlacement(kind, ring, world.footprints(rows as never), selfId);
}
async function rateLimit(q: Queryable, playerId: string) {
  const r = await q.query<{ n: string }>(`select count(*) as n from edits where player_id = $1 and created_at > now() - interval '1 minute'`, [playerId]);
  if (Number(r[0]?.n ?? 0) >= RATE_LIMIT_PER_MIN) throw new HttpError(429, 'Slow down: twenty edits a minute is plenty.');
}

// ---------- identity ----------

const hash = (pw: string) => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(pw, salt, 64).toString('hex'); };
const verify = (pw: string, stored: string) => { const [salt, h] = stored.split(':'); const a = scryptSync(pw, salt, 64); const b = Buffer.from(h, 'hex'); return a.length === b.length && timingSafeEqual(a, b); };

/** Who is calling: a logged-in account, or (when allowed) a guest known by device id. */
async function identify(req: FastifyRequest, create = false): Promise<(Player & { verified?: boolean; banned?: boolean }) | null> {
  const token = req.cookies[COOKIE];
  if (token) {
    const r = await db.query('select p.id, p.name, p.email, p.points, p.coins, p.verified, p.banned, s.expires_at from sessions s join players p on p.id = s.player_id where s.token = $1 and s.expires_at > now()', [token]);
    if (r[0]) {
      // Sliding sessions: anyone who keeps coming back stays logged in.
      const left = (new Date(r[0].expires_at as string).getTime() - Date.now()) / 86400_000;
      if (left < SESSION_DAYS - 1) await db.query(`update sessions set expires_at = now() + interval '${SESSION_DAYS} days' where token = $1`, [token]);
      return rowToPlayer(r[0]);
    }
  }
  if (REQUIRE_LOGIN) return null;
  const device = String(req.headers['x-device-id'] ?? '');
  if (!/^[\w-]{8,64}$/.test(device)) return null;
  const id = 'dev_' + device;
  const existing = await getPlayer(db, id);
  if (existing || !create) return existing;
  await db.query('insert into players (id, coins, ip) values ($1, $2, $3) on conflict (id) do nothing', [id, STARTING_COINS, ip(req)]);
  return getPlayer(db, id);
}
async function requireActor(req: FastifyRequest): Promise<Player> {
  const me = await identify(req, true);
  if (!me) throw new HttpError(401, REQUIRE_LOGIN ? 'Log in to build.' : 'No identity.');
  if (me.banned) throw new HttpError(403, 'This account has been suspended.');
  if (REQUIRE_LOGIN && REQUIRE_VERIFIED && !me.verified) throw new HttpError(403, 'Verify your email to build. Check your inbox for the link.');
  return me;
}
/** Admin is the signed-in account whose email is on the list, or a script holding the token. */
async function isAdmin(req: FastifyRequest): Promise<boolean> {
  const h = String(req.headers.authorization ?? '');
  if (ADMIN_TOKEN && h === `Bearer ${ADMIN_TOKEN}`) return true;
  const me = await identify(req, false);
  return !!me?.email && ADMIN_EMAILS.includes(me.email.toLowerCase());
}
async function requireAdminAsync(req: FastifyRequest) { if (!(await isAdmin(req))) throw new HttpError(401, 'Sign in with the admin Google account, or use the admin token.'); }
function requireAdmin(req: FastifyRequest) { const h = String(req.headers.authorization ?? ''); if (!ADMIN_TOKEN || h !== `Bearer ${ADMIN_TOKEN}`) throw new HttpError(401, 'Admin token required.'); }
async function adminLog(action: string, target: string, detail = '') { await db.query('insert into admin_log (action, target, detail) values ($1,$2,$3)', [action, target, detail]); }
async function issueToken(playerId: string, kind: 'verify' | 'reset', hours: number) {
  const token = randomBytes(24).toString('hex');
  await db.query(`insert into tokens (token, player_id, kind, expires_at) values ($1, $2, $3, now() + interval '${hours} hours')`, [token, playerId, kind]);
  return token;
}
async function sendVerification(playerId: string, email: string) {
  const token = await issueToken(playerId, 'verify', 48);
  await sendMail({ to: email, subject: 'Verify your CityNovus account', text: `Welcome to CityNovus.\n\nClick to verify your email:\n${PUBLIC_URL}/api/auth/verify?token=${token}\n\nThe link works for 48 hours.` });
}
async function startSession(reply: FastifyReply, playerId: string) {
  const token = randomBytes(32).toString('hex');
  await db.query(`insert into sessions (token, player_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [token, playerId]);
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: SESSION_DAYS * 86400 });
}

// ---------- realtime ----------

const streams = new Set<FastifyReply>();
function broadcast(p: Plot) {
  const line = `data: ${JSON.stringify(p)}\n\n`;
  for (const s of streams) { try { s.raw.write(line); } catch { streams.delete(s); } }
}
setInterval(() => { for (const s of streams) { try { s.raw.write(': ping\n\n'); } catch { streams.delete(s); } } }, 25_000).unref();

// ---------- routes ----------

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof RuleError) return reply.status(400).send({ error: err.message });
  app.log.error(err);
  return reply.status(500).send({ error: 'Something went wrong on the server.' });
});

app.get('/api/session', async (req) => {
  const player = await identify(req, true);
  const loggedIn = !!player && player.id.startsWith('u_');
  const { verified, banned, ...pub } = player ?? ({} as never);
  void banned;
  const avatar = player ? (await db.query<{ avatar: string | null }>('select avatar from players where id = $1', [player.id]))[0]?.avatar ?? null : null;
  const unsaved = player && isGuest(player.id) ? Number((await db.query<{ n: string }>('select count(*) as n from plots where owner_id = $1 and provisional', [player.id]))[0]?.n ?? 0) : 0;
  return { player: player ? { ...pub, avatar } : null, loggedIn, verified: !!verified, requireLogin: REQUIRE_LOGIN, requireVerified: REQUIRE_VERIFIED, flagMinPoints: FLAG_MIN_POINTS,
    authMethods: { google: GOOGLE_AUTH, password: PASSWORD_AUTH }, provisionalHours: PROVISIONAL_TTL_HOURS, unsaved, admin: !!player?.email && ADMIN_EMAILS.includes(player.email.toLowerCase()) };
});

// ---------- Google sign-in ----------
// The browser asks for a URL first (so the guest's device id travels with the state), then navigates to Google.
app.post<{ Body: { device?: string } }>('/api/auth/google/start', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (req) => {
  if (!GOOGLE_AUTH) throw bad(PASSWORD_AUTH ? 'Google sign-in is not set up yet. Use email instead.' : 'Sign-in is being set up. Please try again later.');
  const device = String(req.body?.device ?? '');
  const guest = /^[\w-]{8,64}$/.test(device) ? 'dev_' + device : '';
  if (guest) await identify(req, true); // make sure the guest row exists so their work can follow them
  const state = randomBytes(16).toString('hex');
  await db.query(`insert into tokens (token, player_id, kind, expires_at) values ($1, $2, 'oauth', now() + interval '15 minutes')`, [state, guest || 'none']);
  const redirect = `${PUBLIC_URL}/api/auth/google/callback`;
  if (GOOGLE_MOCK && !GOOGLE_CLIENT_ID) return { url: `/api/auth/google/callback?state=${state}&mock=1` };
  const q = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
});

app.get<{ Querystring: { code?: string; state?: string; mock?: string; mock_email?: string; mock_name?: string; error?: string } }>('/api/auth/google/callback', async (req, reply) => {
  const state = String(req.query.state ?? '');
  const row = (await db.query<{ player_id: string }>(`select player_id from tokens where token = $1 and kind = 'oauth' and expires_at > now()`, [state]))[0];
  if (!row) return reply.redirect('/?login=expired');
  await db.query('delete from tokens where token = $1', [state]);
  if (req.query.error) return reply.redirect('/?login=cancelled');
  let profile: { sub: string; email: string; name: string; picture: string | null };
  if (GOOGLE_MOCK && req.query.mock === '1') {
    const email = String(req.query.mock_email ?? 'mock.user@example.com').toLowerCase();
    profile = { sub: 'mock-' + email, email, name: String(req.query.mock_name ?? email.split('@')[0]), picture: null };
  } else {
    const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(req.query.code ?? ''), client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`, grant_type: 'authorization_code' }) });
    const tj = (await tok.json()) as { access_token?: string; error?: string };
    if (!tok.ok || !tj.access_token) { app.log.warn({ tj }, 'google token exchange failed'); return reply.redirect('/?login=failed'); }
    const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tj.access_token}` } });
    const u = (await ui.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    if (!ui.ok || !u.sub || !u.email) return reply.redirect('/?login=failed');
    profile = { sub: u.sub, email: u.email.toLowerCase(), name: u.name || u.email.split('@')[0], picture: u.picture ?? null };
  }
  let acct = (await db.query<{ id: string; name: string | null }>('select id, name from players where google_sub = $1 or email = $2 order by google_sub nulls last limit 1', [profile.sub, profile.email]))[0];
  const guest = row.player_id !== 'none' ? row.player_id : null;
  const name = (acct?.name || profile.name).slice(0, 24);
  if (!acct) {
    const id = 'u_' + randomBytes(12).toString('hex');
    // A guest brings their own coins along; a brand-new player gets the starting purse.
    await db.query('insert into players (id, name, email, google_sub, avatar, verified, points, coins, ip) values ($1,$2,$3,$4,$5,true,0,$6,$7)', [id, name, profile.email, profile.sub, profile.picture, guest ? 0 : STARTING_COINS, ip(req)]);
    acct = { id, name };
    await db.query('insert into events (player_id, name, ip) values ($1, $2, $3)', [id, 'register', ip(req)]);
  } else {
    await db.query('update players set google_sub = coalesce(google_sub, $2), avatar = coalesce($3, avatar), verified = true, last_seen = now() where id = $1', [acct.id, profile.sub, profile.picture]);
  }
  if (guest && guest !== acct.id) await adoptGuest(guest, acct.id, name);
  await startSession(reply, acct.id);
  return reply.redirect('/?login=1');
});

app.get('/api/health', async () => {
  const r = await db.query<{ n: string }>('select count(*) as n from plots');
  return { ok: true, plots: Number(r[0]?.n ?? 0), time: new Date().toISOString() };
});

app.post<{ Body: { name?: string } }>('/api/me', async (req) => {
  const me = await requireActor(req);
  const name = String(req.body?.name ?? '').trim().slice(0, 24);
  moderate(name, 'A name');
  const r = await db.query('update players set name = $2, last_seen = now() where id = $1 returning id, name, email, points, coins', [me.id, name || null]);
  const { verified, banned, ...pub } = rowToPlayer(r[0]); void verified; void banned;
  return pub;
});

app.post<{ Body: { email?: string; password?: string; name?: string } }>('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
  if (!PASSWORD_AUTH) throw bad('Email sign-up is off. Continue with Google.');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = String(req.body?.name ?? '').trim().slice(0, 24);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('That does not look like an email address.');
  if (password.length < 8) throw bad('Use at least eight characters for the password.');
  if (!name) throw bad('Pick a name that will show on your buildings.');
  moderate(name, 'A name');
  const recent = await db.query<{ n: string }>(`select count(*) as n from players where ip = $1 and email is not null and created_at > now() - interval '1 day'`, [ip(req)]);
  if (Number(recent[0]?.n ?? 0) >= SIGNUPS_PER_IP_PER_DAY) throw new HttpError(429, 'Too many new accounts from this connection today. Try again tomorrow.');
  const taken = await db.query('select 1 from players where email = $1', [email]);
  if (taken[0]) throw bad('There is already an account with that email. Log in instead.');
  // A guest who registers keeps their points and coins.
  const guest = await identify(req, false);
  const id = 'u_' + randomBytes(12).toString('hex');
  await db.query('insert into players (id, name, email, password_hash, points, coins, ip) values ($1,$2,$3,$4,0,$5,$6)', [id, name, email, hash(password), guest ? 0 : STARTING_COINS, ip(req)]);
  if (guest) await adoptGuest(guest.id, id, name);
  await startSession(reply, id);
  await sendVerification(id, email);
  await db.query('insert into events (player_id, name, ip) values ($1, $2, $3)', [id, 'register', ip(req)]);
  const { verified, banned, ...pub } = (await getPlayer(db, id))!; void verified; void banned;
  return pub;
});

app.get<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
  const t = await db.query<{ player_id: string }>(`select player_id from tokens where token = $1 and kind = 'verify' and expires_at > now()`, [String(req.query.token ?? '')]);
  if (!t[0]) return reply.redirect('/?verified=0');
  await db.query('update players set verified = true where id = $1', [t[0].player_id]);
  await db.query('delete from tokens where token = $1', [String(req.query.token)]);
  return reply.redirect('/?verified=1');
});

app.post<{ Body: { email?: string } }>('/api/auth/forgot', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const r = await db.query<{ id: string }>('select id from players where email = $1', [email]);
  if (r[0]) {
    const token = await issueToken(r[0].id, 'reset', 2);
    await sendMail({ to: email, subject: 'Reset your CityNovus password', text: `Someone asked to reset the password for this CityNovus account.\n\nOpen this link to choose a new one (valid for two hours):\n${PUBLIC_URL}/?reset=${token}\n\nIf that was not you, ignore this email.` });
  }
  return { message: 'If that email has an account, a reset link is on its way.' };
});

app.post<{ Body: { token?: string; password?: string } }>('/api/auth/reset', async (req, reply) => {
  const password = String(req.body?.password ?? '');
  if (password.length < 8) throw bad('Use at least eight characters for the password.');
  const t = await db.query<{ player_id: string }>(`select player_id from tokens where token = $1 and kind = 'reset' and expires_at > now()`, [String(req.body?.token ?? '')]);
  if (!t[0]) throw bad('That reset link has expired. Ask for a new one.');
  await db.query('update players set password_hash = $2, verified = true where id = $1', [t[0].player_id, hash(password)]);
  await db.query('delete from tokens where player_id = $1', [t[0].player_id]);
  await db.query('delete from sessions where player_id = $1', [t[0].player_id]);
  await startSession(reply, t[0].player_id);
  return { message: 'Password changed. You are logged in.' };
});

if (process.env.NODE_ENV !== 'production') app.get('/api/dev/mail', async () => lastMails);

app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
  if (!PASSWORD_AUTH) throw bad('Email login is off. Continue with Google.');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const r = await db.query<{ id: string; password_hash: string }>('select id, password_hash from players where email = $1', [email]);
  if (!r[0] || !verify(String(req.body?.password ?? ''), r[0].password_hash)) throw new HttpError(401, 'Wrong email or password.');
  await startSession(reply, r[0].id);
  const { verified, banned, ...pub } = (await getPlayer(db, r[0].id))!; void verified; void banned;
  return pub;
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[COOKIE];
  if (token) await db.query('delete from sessions where token = $1', [token]);
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/plots', async (req) => {
  const me = await identify(req, false);
  return (await db.query(`select ${PLOT_COLS} from plots where not provisional or owner_id = $1`, [me?.id ?? ''])).map(rowToPlot);
});
app.post('/api/admin/expire', async (req) => { await requireAdminAsync(req); return { expired: await expireProvisional() }; });
// A session for the house account, so seeding and official content are never provisional.
app.post('/api/admin/system-session', async (req, reply) => {
  requireAdmin(req);
  await db.query(`insert into players (id, name, verified, coins) values ('u_system', 'CityNovus', true, 0) on conflict (id) do nothing`);
  await startSession(reply, 'u_system');
  return { ok: true, id: 'u_system' };
});

app.get('/api/events', async (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  reply.raw.write(': hello\n\n');
  streams.add(reply);
  req.raw.on('close', () => streams.delete(reply));
});

const now = () => new Date().toISOString();

app.post<{ Params: { id: string }; Body: { ctx: EditContext; changes: EditInput } }>('/api/plots/:id/edit', async (req) => {
  const me = await requireActor(req);
  const { ctx, changes } = req.body ?? ({} as never);
  if (!ctx || !changes) throw bad('Missing edit.');
  const id = req.params.id;
  if (!/^(way|tw)\/[\w-]{1,40}$/.test(id)) throw bad('Bad id.');
  return db.tx(async (q) => {
    await rateLimit(q, me.id);
    let existing = await getPlot(q, id);
    // Another guest's unsaved work holds no claim: whoever publishes next takes the footprint.
    if (existing?.provisional && existing.owner_id !== me.id) {
      for (const t of ['confirmations', 'flags', 'edits']) await q.query(`delete from ${t} where plot_id = $1`, [id]);
      await q.query('delete from plots where id = $1', [id]);
      existing = null;
    }
    if (!existing && !ctx.geometry && !world.has(id)) throw bad('Unknown feature.');
    if (ctx.geometry) await guard(q, existing?.kind ?? ctx.kind, ctx.geometry.coordinates[0], id, me.id);
    moderate(changes.name, 'A name');
    moderate(changes.props?.sign, 'A sign');
    const o = applyEdit(existing, id, ctx, changes, me, now());
    await q.query('insert into edits (plot_id, player_id, changes) values ($1,$2,$3)', [id, me.id, JSON.stringify(changes)]);
    return commit(q, me, o, existing ? 'edit' : 'claim');
  });
});

app.post<{ Params: { id: string }; Body: { photo_url?: string | null } }>('/api/plots/:id/confirm', async (req) => {
  const me = await requireActor(req);
  requireAccount(me, 'confirm');
  const photo = req.body?.photo_url ? String(req.body.photo_url) : null;
  if (photo && !photo.startsWith('/photos/')) throw bad('Upload the photo first.');
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Nothing to confirm yet.');
    const already = (await q.query('select 1 from confirmations where plot_id = $1 and player_id = $2', [p.id, me.id]))[0];
    const o = applyConfirm(p, me, !!already, photo);
    await q.query('insert into confirmations (plot_id, player_id) values ($1,$2)', [p.id, me.id]);
    const r = await commit(q, me, o, photo ? 'confirm_photo' : 'confirm');
    if (p.owner_id && p.owner_id !== me.id) await credit(q, p.owner_id, photo ? 15 : 5, photo ? 15 : 5, 'confirmed', p.id);
    return r;
  });
});

app.post('/api/photos', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
  await requireActor(req);
  const file = await req.file();
  if (!file) throw bad('No photo in the request.');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype];
  if (!ext) throw bad('Photos must be JPEG, PNG or WebP.');
  const buf = await file.toBuffer();
  if (file.file.truncated) throw bad('Photos up to 4 MB.');
  const name = randomBytes(12).toString('hex') + '.' + ext;
  writeFileSync(path.join(PHOTO_DIR, name), buf);
  return { url: `/photos/${name}` };
});

app.post<{ Params: { id: string } }>('/api/plots/:id/undo', async (req) => {
  const me = await requireActor(req);
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Nothing to undo.');
    if (!canUndo(p, me)) throw bad('The undo window has passed, or this is not your fresh work.');
    const edits = await q.query<{ n: string }>('select count(*) as n from edits where plot_id = $1', [p.id]);
    if (Number(edits[0]?.n ?? 0) > 1) throw bad('It has been changed since; undo is only for a fresh publish.');
    const led = await q.query<{ dp: string; dc: string }>('select coalesce(sum(delta_points),0) as dp, coalesce(sum(delta_coins),0) as dc from ledger where plot_id = $1 and player_id = $2', [p.id, me.id]);
    const player = await credit(q, me.id, -Number(led[0].dp), -Number(led[0].dc), 'undo', p.id);
    for (const t of ['confirmations', 'flags', 'edits']) await q.query(`delete from ${t} where plot_id = $1`, [p.id]);
    await q.query('delete from plots where id = $1', [p.id]);
    const line = `data: ${JSON.stringify({ id: p.id, deleted: true })}\n\n`;
    for (const s of streams) { try { s.raw.write(line); } catch { streams.delete(s); } }
    return { id: p.id, player };
  });
});

app.get('/api/activity', async () => db.query(
  `select l.created_at as time, pl.name as player, l.reason, l.plot_id, p.name as plot_name, p.kind, p.neighbourhood
     from ledger l left join players pl on pl.id = l.player_id left join plots p on p.id = l.plot_id
    where l.reason in ('claim','edit','buy','harvest','confirm','confirm_photo','tree','landmark','furniture','hoarding','plant') and (p.id is null or not p.provisional)
    order by l.id desc limit 40`,
));

app.get<{ Params: { id: string } }>('/api/plots/:id/history', async (req) => db.query(
  `select e.created_at as time, pl.name as player, e.changes from edits e left join players pl on pl.id = e.player_id where e.plot_id = $1 order by e.id desc limit 30`, [req.params.id],
));

app.post<{ Body: { name?: string; props?: Record<string, unknown>; device?: string } }>('/api/events/track', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
  const name = String(req.body?.name ?? '').slice(0, 40);
  if (!/^[a-z_0-9]+$/.test(name)) return reply.status(204).send();
  const me = await identify(req, false);
  const dev = String(req.body?.device ?? '');
  const pid = me?.id ?? (/^[\w-]{8,64}$/.test(dev) ? 'dev_' + dev : null);
  await db.query('insert into events (player_id, name, props, ip) values ($1,$2,$3,$4)', [pid, name, JSON.stringify(req.body?.props ?? {}).slice(0, 2000), ip(req)]);
  return reply.status(204).send();
});

// ---------- admin ----------

app.get('/admin', async (_req, reply) => reply.type('text/html').send(readFileSync(path.join(here, 'admin.html'), 'utf8')));
app.get<{ Querystring: { filter?: string } }>('/api/admin/plots', async (req) => {
  await requireAdminAsync(req);
  const f = req.query.filter ?? 'flagged';
  const where = f === 'hidden' ? 'where hidden' : f === 'flagged' ? 'where flag_score > 0' : '';
  return (await db.query(`select ${PLOT_COLS} from plots ${where} order by updated_at desc limit 100`)).map(rowToPlot);
});
app.post<{ Params: { id: string }; Body: { action?: string; name?: string } }>('/api/admin/plots/:id', async (req) => {
  await requireAdminAsync(req);
  const id = req.params.id, a = req.body?.action;
  const p = await getPlot(db, id); if (!p) throw bad('No such plot.');
  if (a === 'hide') await db.query('update plots set hidden = true where id = $1', [id]);
  else if (a === 'restore') await db.query('update plots set hidden = false, flag_score = 0 where id = $1', [id]);
  else if (a === 'rename') await db.query('update plots set name = $2 where id = $1', [id, String(req.body?.name ?? '').slice(0, 60) || null]);
  else if (a === 'delete') { for (const t of ['confirmations', 'flags', 'edits']) await db.query(`delete from ${t} where plot_id = $1`, [id]); await db.query('delete from plots where id = $1', [id]); }
  else throw bad('Unknown action.');
  await adminLog(a, id, req.body?.name ?? '');
  if (a === 'delete') { const line = `data: ${JSON.stringify({ id, deleted: true })}\n\n`; for (const s of streams) { try { s.raw.write(line); } catch { streams.delete(s); } } }
  else { const np = await getPlot(db, id); if (np) broadcast(np); }
  return { ok: true };
});
app.post<{ Params: { id: string }; Body: { banned?: boolean } }>('/api/admin/players/:id/ban', async (req) => {
  await requireAdminAsync(req);
  await db.query('update players set banned = $2 where id = $1', [req.params.id, !!req.body?.banned]);
  await db.query('delete from sessions where player_id = $1', [req.params.id]);
  await adminLog(req.body?.banned ? 'ban' : 'unban', req.params.id);
  return { ok: true };
});
app.get('/api/admin/log', async (req) => { await requireAdminAsync(req); return db.query('select * from admin_log order by id desc limit 100'); });
app.get('/api/admin/metrics', async (req) => {
  await requireAdminAsync(req);
  const one = async (sql: string) => Number((await db.query<{ v: string }>(sql))[0]?.v ?? 0);
  const players = await one('select count(*) as v from players');
  const accounts = await one('select count(*) as v from players where email is not null');
  const activeToday = await one(`select count(*) as v from players where last_seen > now() - interval '1 day'`);
  const active7d = await one(`select count(*) as v from players where last_seen > now() - interval '7 days'`);
  const cohort = await one(`select count(*) as v from players where created_at between now() - interval '14 days' and now() - interval '7 days'`);
  const returned = await one(`select count(*) as v from players where created_at between now() - interval '14 days' and now() - interval '7 days' and last_seen >= created_at + interval '7 days'`);
  const plots = await one('select count(*) as v from plots');
  const builders = await one('select count(distinct owner_id) as v from plots');
  const confirms = await one('select count(*) as v from confirmations');
  const flagged = await one('select count(*) as v from plots where flag_score > 0');
  const hidden = await one('select count(*) as v from plots where hidden');
  const onboarded = await one(`select count(distinct player_id) as v from events where name = 'onboarding_done'`);
  const started = await one(`select count(distinct player_id) as v from events where name = 'session_start'`);
  const byKind: Record<string, number> = {};
  for (const r of await db.query<{ kind: string; n: string }>('select kind, count(*) as n from plots where not provisional group by kind')) byKind[r.kind] = Number(r.n);
  const photos = await one(`select count(*) as v from plots where photo_url is not null or jsonb_array_length(coalesce(props->'photos','[]'::jsonb)) > 0`);
  const provisional = await one('select count(*) as v from plots where provisional');
  const wishes = await one('select count(*) as v from wishlist');
  return {
    players, accounts, guests: players - accounts, active_today: activeToday, active_7d: active7d,
    day7_return_rate: cohort ? returned / cohort : 0, day7_cohort_size: cohort,
    plots, buildings: byKind.building ?? 0, trees: byKind.tree ?? 0, farms: byKind.farm ?? 0, landmarks: byKind.landmark ?? 0, furniture: byKind.furniture ?? 0,
    parks: (byKind.park ?? 0) + (byKind.playground ?? 0), ponds: byKind.pond ?? 0, roads_and_flyovers: (byKind.road ?? 0) + (byKind.flyover ?? 0) + (byKind.railway ?? 0) + (byKind.wall ?? 0),
    builders, plots_per_builder: builders ? plots / builders : 0, confirms, confirms_per_plot: plots ? confirms / plots : 0, photos, unsaved_guest_plots: provisional,
    flagged, hidden, onboarding_completion: started ? onboarded / started : 0, wishlist_votes: wishes,
  };
});

app.get('/api/admin/users', async (req) => {
  await requireAdminAsync(req);
  return db.query(`select p.id, p.name, p.email, p.points, p.coins, p.verified, p.banned, p.created_at, p.last_seen,
      (select count(*) from plots where owner_id = p.id) as plots,
      (select count(*) from plots where owner_id = p.id and kind = 'building') as buildings,
      (select count(*) from confirmations where player_id = p.id) as confirmations
    from players p where p.email is not null order by p.created_at desc limit 500`);
});

// ---------- which city next ----------
app.get('/api/wishlist', async (req) => {
  const me = await identify(req, false);
  const top = await db.query('select city_key as key, min(city) as city, count(*) as votes from wishlist group by city_key order by votes desc, min(created_at) asc limit 25');
  const mine = me ? (await db.query<{ city_key: string }>('select city_key from wishlist where player_id = $1', [me.id])).map((r) => r.city_key) : [];
  return { top: top.map((r) => ({ key: r.key, city: r.city, votes: Number(r.votes) })), mine };
});
app.post<{ Body: { city?: string; note?: string } }>('/api/wishlist', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
  const me = await requireActor(req);
  const city = String(req.body?.city ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (city.length < 2) throw bad('Which city?');
  moderate(city, 'A city name');
  const note = String(req.body?.note ?? '').trim().slice(0, 140) || null;
  if (note) moderate(note, 'A note');
  const key = city.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').trim();
  await db.query('insert into wishlist (city, city_key, player_id, note) values ($1,$2,$3,$4) on conflict (city_key, player_id) do nothing', [city, key, me.id, note]);
  return { ok: true, key };
});
app.delete<{ Params: { key: string } }>('/api/wishlist/:key', async (req) => {
  const me = await requireActor(req);
  await db.query('delete from wishlist where city_key = $1 and player_id = $2', [req.params.key, me.id]);
  return { ok: true };
});
app.get('/api/admin/wishlist', async (req) => {
  await requireAdminAsync(req);
  return db.query(`select w.city_key as key, min(w.city) as city, count(*) as votes,
      string_agg(coalesce(p.email, p.name, w.player_id), ', ' order by w.created_at) as voters,
      string_agg(w.note, ' | ') filter (where w.note is not null) as notes, min(w.created_at) as first_at
    from wishlist w left join players p on p.id = w.player_id group by w.city_key order by votes desc, first_at asc limit 200`);
});

app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/plots/:id/flag', async (req) => {
  const me = await requireActor(req);
  requireAccount(me, 'flag');
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Nothing to flag yet.');
    const already = (await q.query('select 1 from flags where plot_id = $1 and player_id = $2', [p.id, me.id]))[0];
    const o = applyFlag(p, me, !!already, FLAG_MIN_POINTS);
    await q.query('insert into flags (plot_id, player_id, reason, weight) values ($1,$2,$3,$4)', [p.id, me.id, String(req.body?.reason ?? '').slice(0, 40), o.plot.flag_score - p.flag_score]);
    return commit(q, me, o, 'flag');
  });
});

app.post<{ Params: { id: string } }>('/api/plots/:id/buy', async (req) => {
  const me = await requireActor(req);
  requireAccount(me, 'buy');
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Nothing to buy yet. Colour it in and it is yours.');
    return commit(q, me, applyBuy(p, me, now()), 'buy');
  });
});

app.post<{ Params: { id: string }; Body: { crop?: string } }>('/api/plots/:id/plant', async (req) => {
  const me = await requireActor(req);
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Claim it first.');
    return commit(q, me, applyPlant(p, String(req.body?.crop ?? ''), me, now()), 'plant');
  });
});

app.post<{ Params: { id: string } }>('/api/plots/:id/harvest', async (req) => {
  const me = await requireActor(req);
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Nothing here.');
    return commit(q, me, applyHarvest(p, me, now()), 'harvest');
  });
});

app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/plots/:id/hoarding', async (req) => {
  const me = await requireActor(req);
  return db.tx(async (q) => {
    const p = await getPlot(q, req.params.id); if (!p) throw bad('Claim it first.');
    return commit(q, me, applyHoarding(p, String(req.body?.text ?? ''), me, now()), 'hoarding');
  });
});

async function placePoint(req: FastifyRequest, kind: Kind, c: Position, subtype?: string) {
  const me = await requireActor(req);
  if (!Array.isArray(c) || c.length !== 2 || !c.every((n) => typeof n === 'number' && Number.isFinite(n))) throw bad('Where does it go?');
  if (!KINDS[kind] || KINDS[kind].shape !== 'point') throw bad('Not a one-tap kind.');
  return db.tx(async (q) => {
    await rateLimit(q, me.id);
    await guard(q, kind, pointRing(kind, c), undefined, me.id);
    const id = 'tw/' + randomBytes(8).toString('hex');
    const o = newPoint(id, kind, c, world.nearestNeighbourhood(c[0], c[1]), me, now(), subtype);
    await q.query('insert into edits (plot_id, player_id, changes) values ($1,$2,$3)', [id, me.id, JSON.stringify({ kind, subtype })]);
    return commit(q, me, o, kind);
  });
}
app.post<{ Body: { center?: Position; neighbourhood?: string } }>('/api/trees', async (req) => placePoint(req, 'tree', req.body?.center as Position));
app.post<{ Body: { kind?: Kind; center?: Position; subtype?: string } }>('/api/points', async (req) => placePoint(req, req.body?.kind as Kind, req.body?.center as Position, req.body?.subtype ? String(req.body.subtype) : undefined));

await app.register(fstatic, { root: PHOTO_DIR, prefix: '/photos/', decorateReply: false, maxAge: '30d' });

// Static site, when built.
const dist = path.join(ROOT, 'dist');
if (existsSync(dist)) {
  await app.register(fstatic, { root: dist, wildcard: false, decorateReply: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.status(404).send({ error: 'Not found' });
  });
}

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`citynovus api on :${PORT}  auth: ${[GOOGLE_AUTH ? (GOOGLE_MOCK && !GOOGLE_CLIENT_ID ? 'google(mock)' : 'google') : '', PASSWORD_AUTH ? 'password' : ''].filter(Boolean).join('+') || 'none'}  guest work expires after ${PROVISIONAL_TTL_HOURS}h  login required: ${REQUIRE_LOGIN}  verified required: ${REQUIRE_VERIFIED}  flag threshold: ${FLAG_MIN_POINTS} points  admin: ${ADMIN_TOKEN ? 'on' : 'off (set ADMIN_TOKEN)'}  mail: ${process.env.SMTP_URL ? 'smtp' : 'console'}`);
