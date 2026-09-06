import './style.css';
import type { Polygon } from 'geojson';
import type { Plot, Props, Session, Store } from './types';
import { BACKEND, BADGES, BOARD_MIN_POINTS, CIVIC, CURRENCY, CURRENCY_SHORT, FURNITURE, KINDS, KIND_ICONS, KIND_IDS, LANDMARKS, PALETTE, ROOFS, SHORT_HINT, SHORT_LABEL, SUBTYPE_ICONS, checkPlacement, checkSize, lineWidth, type Kind } from './config';
import { WeatherFX, describe, fetchWeather, isNight, severe, sunPosition, type Weather } from './weather';
import { enableRipples, mountControls } from './controls';
import { LoginScreen } from './login';
import { LocalStore } from './store-local';
import { ServerStore } from './store-server';
import { WorldMap } from './map';
import { Tracer } from './draw';
import { ShapeEditor } from './editor';
import { Panel } from './panel';
import { Leaderboard } from './leaderboard';
import { bufferLine, centroid, chaikin, closeRing, nearestPlace, uuid, type Place } from './geo';
import type { Activity } from './types';
import { CITY } from './config';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const mobile = () => matchMedia('(max-width: 760px)').matches;
const kindLabel = (k: Kind) => (mobile() ? SHORT_LABEL[k] : KINDS[k].label);
const kindHint = (k: Kind) => (mobile() ? SHORT_HINT[KINDS[k].shape] : KINDS[k].hint);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const state = new Map<string, Plot>();
const world = new WorldMap('map');
const tracer = new Tracer(world);
const editor = new ShapeEditor(world);
let store: Store;
let session: Session;
let traceKind: Kind = 'building';
let traceSubtype: string | undefined;
let paint: { colour: string; floors: number; roof: string } | null = null; // paint-many mode

let toastTimer = 0;
function toast(msg: string, kind: 'ok' | 'err' = 'ok', action?: { label: string; fn: () => void; ms?: number }) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'snack ' + kind;
  if (action) {
    const b = document.createElement('button'); b.className = 'btn text on-dark'; b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), action?.ms ?? (kind === 'err' ? 6500 : 3600));
}

function showUnread(n: number) { const b = $('#inbox-badge'); b.hidden = n === 0; b.textContent = String(n); }
function showPlayer() {
  const me = store.player();
  $('#points-text').textContent = String(me.points);
  $('#coins-text').textContent = String(me.coins);
  const unsaved = isGuest() ? [...state.values()].filter((p) => p.provisional && p.owner_id === me.id).length : 0;
  if (session) session.unsaved = unsaved;
  $('#unsaved').hidden = unsaved === 0;
  $('#unsaved-text').textContent = `Unsaved · ${unsaved}`;
  const nameEl = $<HTMLInputElement>('#name');
  if (document.activeElement !== nameEl) nameEl.value = me.name ?? '';
  $('#btn-login').hidden = store.mode !== 'server' || store.loggedIn();
}

/** Before any change: a name, and in production an account. */
async function requireIdentity(): Promise<boolean> {
  if (store.mode === 'server' && session.requireLogin && !store.loggedIn()) { openAuth('Log in to build. Your work will carry your name.'); return false; }
  if (store.player().name) return true;
  const input = $<HTMLInputElement>('#name');
  const v = input.value.trim();
  if (v) { await store.setName(v); showPlayer(); return true; }
  input.focus();
  toast('Give yourself a name first, so your work can carry it', 'err');
  return false;
}

let login: LoginScreen;
function openAuth(msg = '') { login.open(msg); }
const isGuest = () => store.mode === 'server' && !store.loggedIn();

async function boot() {
  // Pick a backend: the API if one answers, else this browser.
  const useServer = BACKEND === 'server' || (BACKEND === 'auto' && (await ServerStore.probe()));
  store = useServer ? new ServerStore() : new LocalStore();
  store.attachWorld(() => world.footprints());

  const [sess, placesJson, totals] = await Promise.all([
    store.init(),
    fetch('/data/places.json').then((r) => r.json()) as Promise<{ places: Place[] }>,
    fetch('/data/neighbourhoods.json').then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<{ name: string; total: number; c: [number, number] }[]>,
  ]);
  // The search index is a few megabytes for all of Assam; fetch it the first time someone searches.
  let searchIndex: { n: string; t: string; c: [number, number] }[] = [];
  let searchLoading: Promise<void> | null = null;
  const ensureSearch = () => (searchLoading ??= fetch('/data/search.json').then((r) => (r.ok ? r.json() : [])).then((j) => { searchIndex = j; }).catch(() => { searchIndex = []; }));
  session = sess;
  const places = placesJson.places;
  $('#mode').textContent = store.mode === 'local' ? 'local mode: everything stays in this browser' : session.requireLogin ? 'live · log in to build' : 'live';

  let stored: Plot[] = [];
  try { stored = await store.loadPlots(); } catch (e) { toast('Could not load the world: ' + (e as Error).message, 'err'); }
  for (const b of stored) state.set(b.id, b);
  await world.load(stored);
  world.setTotals(totals);
  showPlayer();

  enableRipples();
  mountControls($('#controls'), world, toast);
  login = new LoginScreen(world, store, () => session, toast);
  const board = new Leaderboard($('#board'), world, places, toast);
  const panel = new Panel($('#panel'), {
    store, world, editor, state, toast, requireIdentity,
    onPlayer: showPlayer,
    onChanged: () => board.refresh(),
    flagMinPoints: () => session.flagMinPoints,
    needsLogin: () => store.mode === 'server' && session.requireLogin && !store.loggedIn(),
    onLogin: () => openAuth('Log in to build. Your work will carry your name.'),
    onEarn: () => openEarn(),
    onInbox: () => void openInbox(),
    onFresh: (id) => { offerUndo(id); store.track('publish'); onboarding.published(); },
  });
  if (session.streakBonus) setTimeout(() => toast(`Day ${session.streak} streak · +${session.streakBonus} ${CURRENCY_SHORT}`), 1500);
  showUnread(session.unread ?? 0);
  store.track('session_start');

  // Undo a fresh publish for a short while. Guests get the thing that matters more: a way to keep it.
  function offerUndo(id: string) {
    if (isGuest()) { toast(`Published, but unsaved. Guest work expires in ${session.provisionalHours} h.`, 'ok', { label: 'Log in to keep', ms: 12_000, fn: () => login.open('Log in and everything you built is saved.') }); return; }
    toast('Published', 'ok', { label: 'Undo', ms: 30_000, fn: async () => {
      try { const r = await store.undo(id); state.delete(r.id); removeFromWorld(r.id); showPlayer(); board.refresh(); if (panel.currentId === r.id) panel.close(false); toast('Undone'); }
      catch (e) { toast((e as Error).message, 'err'); }
    } });
  }
  function removeFromWorld(id: string) {
    if (id.startsWith('tw/')) world.remove(id); else world.resetPreview(id, null);
  }
  store.onDelete((id) => { state.delete(id); removeFromWorld(id); board.refresh(); if (panel.currentId === id) panel.close(false); });
  editor.onMessage = (m) => toast(m, 'err');

  // How to get coins: the answer to every "not enough coins".
  function openEarn() {
    const p = $('#earn');
    p.innerHTML = `
      <div class="panel-head"><div><h2><span class="ms">toll</span>Earning ${CURRENCY}</h2><div class="sub">You have ${store.player().coins} ${CURRENCY_SHORT} and ${store.player().points} points</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      <p class="sub">Every point you earn is also a coin. Points stay forever; coins get spent.</p>
      <ul class="earn">
        <li><span class="ms">home_work</span><div><b>Claim a grey building</b> · +10 coins<br><span class="sub">Tap any grey box, give it floors and a colour, publish.</span></div></li>
        <li><span class="ms">draw</span><div><b>Add something OSM does not have</b> · +15 to +25<br><span class="sub">Tap Add. Buildings pay the most. Turn on satellite to trace exactly.</span></div></li>
        <li><span class="ms">park</span><div><b>Plant a tree</b> · +5 each<br><span class="sub">One tap. Ten trees is 50 coins and the Gardener badge.</span></div></li>
        <li><span class="ms">verified</span><div><b>Confirm a neighbour's work</b> · +3<br><span class="sub">Open anything someone else built and tap Confirm. They get +5.</span></div></li>
        <li><span class="ms">agriculture</span><div><b>Farm</b> · seeds cost 10 to 40, harvests pay 22 to 200<br><span class="sub">Tomato is ready in four hours. Tea and bamboo take days but pay the most.</span></div></li>
        <li><span class="ms">sell</span><div><b>Sell</b> · 80% of the price, and 10% forever if you built it<br><span class="sub">Set a price or take offers on anything you own. The original builder earns a royalty on every resale.</span></div></li>
        <li><span class="ms">local_fire_department</span><div><b>Come back daily</b> · +5 to +25<br><span class="sub">A streak bonus every day, and four daily quests worth up to 45.</span></div></li>
        <li><span class="ms">report_problem</span><div><b>Report civic issues</b> · +5, +10 when fixed<br><span class="sub">Garbage, potholes, waterlogging. Three neighbours confirming it is fixed closes it.</span></div></li>
      </ul>
      <p class="hint">Everything on CityNovus is free. ${CURRENCY} cannot be bought or sold for money and cannot be sent to other players.</p>`;
    closePopovers();
    p.hidden = false;
  }
  $('#earn').addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('[data-act="close"]')) $('#earn').hidden = true; });

  world.onSelect = (id) => { if (id && paint) { void paintTap(id); world.select(null); return; } if (id) { closePopovers(); panel.open(id); onboarding.step(id); } else panel.close(); };
  world.onMapClick = (lngLat) => {
    if (!tracer.active) return false;
    if (tracer.shape === 'point') { tracer.cancel(); $('#trace-bar').hidden = true; void placePoint(lngLat); return true; }
    tracer.add(lngLat);
    return true;
  };

  store.onChange((b) => {
    state.set(b.id, b);
    world.mergeState(b);
    board.refresh();
    if (panel.currentId === b.id) panel.render();
  });
  setInterval(() => world.refresh(), 60_000); // crops grow

  function closePopovers() { for (const id of ['board', 'kind-menu', 'profile', 'search-results', 'weather-panel', 'earn', 'activity', 'wishlist', 'inbox', 'wallet', 'board-sheet']) $('#' + id).hidden = true; }

  // Name
  // Saved quietly: a toast here would stomp on whatever button the user was reaching for.
  $<HTMLInputElement>('#name').addEventListener('change', async (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v === (store.player().name ?? '')) return;
    try { await store.setName(v); showPlayer(); } catch (err) { toast((err as Error).message, 'err'); }
  });

  // Accounts (server mode)
  $('#btn-login').addEventListener('click', () => openAuth());
  $('#unsaved').addEventListener('click', () => login.open(`Log in to keep your ${session.unsaved} unsaved ${session.unsaved === 1 ? 'thing' : 'things'}.`));
  {
    const q = new URLSearchParams(location.search);
    if (q.get('verified') === '1') { toast('Email verified. Welcome to CityNovus.'); history.replaceState(null, '', '/'); }
    if (q.get('verified') === '0') { toast('That verification link is not valid any more.', 'err'); history.replaceState(null, '', '/'); }
    if (q.get('reset')) { openAuth('Choose a new password.'); $('#login').classList.add('reset'); }
    if (q.get('login') === '1') { toast(`Welcome, ${store.player().name ?? 'friend'}. Everything you built is saved.`); history.replaceState(null, '', '/'); store.track('login_done'); }
    if (q.get('login') === 'failed') { toast('Google sign-in did not go through. Try again.', 'err'); history.replaceState(null, '', '/'); }
    if (q.get('login') === 'cancelled' || q.get('login') === 'expired') { history.replaceState(null, '', '/'); }
    if (store.mode === 'server' && session.requireLogin && session.requireVerified && store.loggedIn() && !session.verified) toast('Check your email for the verification link before building.', 'err');
  }

  // Tilt hint, 3D toggle
  const hint = $('#hint');
  try { if (localStorage.getItem('tw.hint') !== '1') hint.hidden = false; } catch { hint.hidden = false; }
  $('#hint-close').addEventListener('click', () => { hint.hidden = true; try { localStorage.setItem('tw.hint', '1'); } catch { /* ignore */ } });
  // Keyboard: Escape backs out of anything, Enter finishes a trace.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (tracer.active) { tracer.cancel(); traceBar.hidden = true; } if (paint) { paint = null; paintBar.hidden = true; } closePopovers(); panel.close(); }
    if (ev.key === 'Enter' && tracer.active && tracer.shape !== 'point' && document.activeElement === document.body) $('#trace-finish').click();
  });

  // Search: "Where do you live?"
  const search = $<HTMLInputElement>('#search');
  const results = $('#search-results');
  // Search runs entirely in the browser: OSM names from the fetch script plus everything players have named.
  const runSearch = () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { results.hidden = true; return; }
    const score = (n: string) => { const l = n.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(' ' + q) ? 2 : l.includes(q) ? 3 : 9; };
    const own = [...state.values()].filter((p) => p.name).map((p) => ({ n: p.name!, t: `${KINDS[p.kind].label.toLowerCase()} · by ${p.owner_name ?? 'someone'}`, c: centroid((world.feature(p.id)?.geometry ?? p.geometry!).coordinates[0]) as [number, number] }));
    const hits = [...own, ...searchIndex].map((h) => ({ h, s: score(h.n) })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || a.h.n.length - b.h.n.length).slice(0, 7);
    if (!hits.length) { results.innerHTML = `<div class="hint" style="padding:10px 14px">${searchIndex.length ? 'Nothing called that in Assam yet. Add it, and it will be searchable.' : 'Loading the index…'}</div>`; results.hidden = false; return; }
    results.innerHTML = hits.map(({ h }) => `<button data-lon="${h.c[0]}" data-lat="${h.c[1]}"><b>${esc(h.n)}</b> <span class="sub">${esc(h.t)}</span></button>`).join('');
    results.hidden = false;
  };
  search.addEventListener('focus', () => { void ensureSearch(); });
  search.addEventListener('input', () => { if (!searchIndex.length && searchLoading) { void ensureSearch().then(runSearch); } runSearch(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { results.hidden = true; search.blur(); }
    if (ev.key === 'Enter') { runSearch(); results.querySelector<HTMLElement>('button')?.click(); }
  });
  results.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    results.hidden = true;
    world.flyTo([Number(b.dataset.lon), Number(b.dataset.lat)], 17.2);
    try { localStorage.setItem('tw.home', JSON.stringify([Number(b.dataset.lon), Number(b.dataset.lat)])); } catch { /* ignore */ }
    store.track('search');
    onboarding.searched();
    toast('This is your neighbourhood. Tap anything grey.');
  });

  // Profile and badges
  const openProfile = () => { const p = $('#profile'); const open = p.hidden; closePopovers(); if (open) { renderProfile(); p.hidden = false; } };
  $('#points').addEventListener('click', openProfile);
  $('#btn-account').addEventListener('click', openProfile);
  function renderProfile() {
    const me = store.player();
    const kinds: Record<string, number> = {};
    let owned = 0;
    for (const b of state.values()) if (b.owner_id === me.id) { owned++; kinds[b.kind] = (kinds[b.kind] ?? 0) + 1; }
    const stats = { points: me.points, kinds };
    const guest = store.mode === 'server' && !store.loggedIn();
    $('#profile').innerHTML = `
      <div class="panel-head"><div><h2>${session.player?.avatar ? `<img class="avatar" src="${esc(session.player.avatar)}" alt="">` : '<span class="ms">account_circle</span>'}${esc(me.name || 'Anonymous')}</h2><div class="sub">${owned} things owned${guest ? ' · guest' : ''}</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      ${guest ? `<button class="btn accent wide" data-act="login"><span class="ms">login</span>${session.unsaved > 0 ? `Log in to save ${session.unsaved} unsaved ${session.unsaved === 1 ? 'thing' : 'things'}` : 'Log in with Google'}</button><p class="hint centre">Guest work disappears after ${session.provisionalHours} hours.</p>` : ''}
      <div class="stat-row">
        <div class="stat-card"><b>${me.points}</b><span>points · reputation, never spent</span></div>
        <div class="stat-card" data-act="wallet" style="cursor:pointer"><b>${me.coins}</b><span>${CURRENCY} · tap for wallet</span></div>
      </div>
      <label>Name on your buildings<input id="profile-name" maxlength="24" value="${esc(me.name ?? '')}" placeholder="your name"></label>
      <div class="badges">${BADGES.map((bd) => `<div class="badge ${bd.test(stats) ? 'on' : ''}" title="${bd.hint}"><span>${bd.emoji}</span>${bd.label}<small>${bd.hint}</small></div>`).join('')}</div>
      <div class="owned">${KIND_IDS.filter((k) => kinds[k]).map((k) => `${KINDS[k].emoji} ${kinds[k]} ${KINDS[k].label.toLowerCase()}`).join(' · ') || 'Nothing yet. Tap a grey building.'}</div>
      <button data-act="wallet">Wallet, quests, streak</button>
      <button data-act="inbox">Inbox</button>
      <button data-act="earn">How to earn ${CURRENCY}</button>
      <button data-act="activity">What changed near me</button>
      <button data-act="wish">Which city next?</button>
      ${session.admin ? `<a class="btn tonal" href="/admin">Admin</a>` : ''}
      ${store.mode === 'server' && store.loggedIn() ? `<button data-act="logout">Log out</button>` : ''}
      <p class="hint"><a href="/privacy.html" target="_blank">Privacy</a> · <a href="/terms.html" target="_blank">Terms</a> · <a href="#" data-act="delete">Delete my account</a></p>
      <p class="hint">You earn ${CURRENCY} alongside points. Points are forever: 1000 unlocks flagging and plot notes, 5000 the neighbourhood boards. Confirming a neighbour's work pays you both.</p>`;
  }
  $('#profile').addEventListener('change', async (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.id !== 'profile-name') return;
    if (t.value.trim() === (store.player().name ?? '')) return;
    try { await store.setName(t.value); showPlayer(); } catch (err) { toast((err as Error).message, 'err'); }
  });
  $('#profile').addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') $('#profile').hidden = true;
    if (b.dataset.act === 'logout') { await store.logout(); location.reload(); }
    if (b.dataset.act === 'login') { $('#profile').hidden = true; openAuth(); }
    if (b.dataset.act === 'earn') openEarn();
    if (b.dataset.act === 'wallet') void openWallet();
    if (b.dataset.act === 'inbox') void openInbox();
    if (b.dataset.act === 'activity') void openActivity();
    if (b.dataset.act === 'wish') void openWishlist();
    if (b.dataset.act === 'delete') {
      ev.preventDefault();
      const ok = confirm(store.loggedIn()
        ? 'Delete your account? Your email, Google link and name are removed for good. What you built stays on the map as open data, credited to "a former player".'
        : 'Delete your guest data? Everything you built as a guest is removed.');
      if (!ok) return;
      try { await store.deleteAccount(); toast('Account deleted.'); setTimeout(() => location.reload(), 900); } catch (e) { toast((e as Error).message, 'err'); }
    }
  });

  // Inbox: offers, sales, confirmations, notes.
  async function openInbox() {
    const p = $('#inbox');
    closePopovers();
    p.innerHTML = `<div class="panel-head"><div><h2><span class="ms">notifications</span>Inbox</h2><div class="sub">Offers, sales, confirmations, notes</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div><div class="hint">Loading…</div>`;
    p.hidden = false;
    try {
      const [{ items }, offers] = await Promise.all([store.inbox(), store.offers()]);
      const ago = (t: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
      const received = offers.received.map((o) => `<li class="offer"><div class="grow"><b>${esc(o.buyer_name || 'someone')}</b> offers <b>${o.amount} ${CURRENCY_SHORT}</b> for ${esc(o.plot_name || 'your ' + o.kind)}<br><span class="sub">${ago(o.created_at)}</span></div><button class="btn filled" data-offer="${o.id}" data-do="accept">Accept</button><button class="btn text" data-offer="${o.id}" data-do="decline">Decline</button></li>`).join('');
      const made = offers.made.filter((o) => o.status === 'pending').map((o) => `<li class="offer"><div class="grow">Your <b>${o.amount} ${CURRENCY_SHORT}</b> offer on ${esc(o.plot_name || 'a ' + o.kind)} (${esc(o.owner_name || 'owner')})<br><span class="sub">waiting · ${ago(o.created_at)}</span></div><button class="btn text" data-offer="${o.id}" data-do="cancel">Cancel</button></li>`).join('');
      p.querySelector('.hint')!.outerHTML = `${received || made ? `<ol class="feed">${received}${made}</ol>` : ''}${items.length ? `<ol class="feed">${items.map((n) => `<li data-id="${esc(n.plot_id ?? '')}" class="${n.read ? '' : 'unread'}">${esc(n.text)}<br><span class="sub">${ago(n.created_at)}</span></li>`).join('')}</ol>` : '<div class="hint">Nothing yet. Build, and people will react.</div>'}`;
      await store.markRead(); showUnread(0);
    } catch (e) { p.querySelector('.hint')!.textContent = (e as Error).message; }
  }
  $('#inbox').addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-act="close"]')) { $('#inbox').hidden = true; return; }
    const ob = t.closest<HTMLElement>('[data-offer]');
    if (ob) { try { await store.decideOffer(Number(ob.dataset.offer), ob.dataset.do as 'accept' | 'decline' | 'cancel'); showPlayer(); toast(ob.dataset.do === 'accept' ? 'Sold. Coins are in your wallet.' : ob.dataset.do === 'decline' ? 'Declined. Their coins went back.' : 'Offer cancelled.'); void openInbox(); } catch (e) { toast((e as Error).message, 'err'); } return; }
    const li = t.closest<HTMLElement>('li[data-id]');
    if (li && li.dataset.id) { const f = world.feature(li.dataset.id); if (f) { $('#inbox').hidden = true; world.flyTo(centroid(f.geometry.coordinates[0])); world.select(f.properties.id); panel.open(f.properties.id); } }
  });
  $('#btn-inbox').addEventListener('click', () => { const open = $('#inbox').hidden; panel.close(); closePopovers(); if (open) void openInbox(); });
  setInterval(async () => { if (store.mode !== 'server' || !document.hasFocus()) return; try { const { unread } = await store.inbox(); showUnread(unread); } catch { /* offline */ } }, 20_000);

  // Wallet: balance, streak, today's quests, the ledger, the City Treasury.
  async function openWallet() {
    const p = $('#wallet');
    closePopovers();
    const me = store.player();
    p.innerHTML = `<div class="panel-head"><div><h2><span class="ms">toll</span>${CURRENCY}</h2><div class="sub">Earned by playing. Spent on land, seeds, tall floors, shields.</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      <div class="stat-row"><div class="stat-card"><b>${me.coins}</b><span>${CURRENCY_SHORT} in your wallet</span></div><div class="stat-card"><b>${session.streak ?? 0}</b><span>day streak · +${Math.min(5, (session.streak ?? 0) + 1) * 5} tomorrow</span></div></div>
      <h3 class="sub-h">Today's quests</h3><div class="quests hint">Loading…</div>
      <h3 class="sub-h">City Treasury</h3><div class="hint treasury">…</div>
      <h3 class="sub-h">Recent</h3><ol class="feed ledger"><li class="hint">Loading…</li></ol>
      <p class="hint">${CURRENCY} cannot be bought, sold or sent to other players. Every sale pays the owner 80%, the builder 10% and the Treasury 10%.</p>`;
    p.hidden = false;
    try {
      const [q, led, tre] = await Promise.all([store.quests(), store.ledger(), store.treasury()]);
      p.querySelector('.quests')!.outerHTML = q.quests.length ? `<div class="quests">${q.quests.map((x) => `<div class="quest ${x.done ? 'done' : ''}"><div class="grow"><b>${esc(x.label)}</b><div class="bar"><i style="width:${Math.round((x.progress / x.need) * 100)}%"></i></div><span class="sub">${x.progress}/${x.need} · +${x.reward} ${CURRENCY_SHORT}</span></div>${x.claimed ? '<span class="ms done">check_circle</span>' : x.done ? `<button class="btn filled" data-quest="${x.id}">Claim</button>` : ''}</div>`).join('')}</div>` : '<div class="quests hint">Quests need the live server.</div>';
      p.querySelector('.treasury')!.textContent = `${tre} ${CURRENCY_SHORT} collected from sales, to be paid out as weekly prizes for the best neighbourhood and the top civic reporter.`;
      const label: Record<string, string> = { claim: 'claimed', edit: 'edited', buy: 'bought', bought: 'bought', sold: 'sold', royalty: "builder's royalty", offer_escrow: 'offer held', offer_refund: 'offer returned', confirm: 'confirmed', confirm_photo: 'photo-verified', confirmed: 'your work confirmed', harvest: 'harvest', plant: 'seeds', tree: 'tree', landmark: 'landmark', furniture: 'furniture', civic: 'report', resolve: 'marked fixed', resolved: 'report closed', streak: 'daily streak', quest: 'quest', shield: 'shield', sale_terms: 'terms', undo: 'undo', sale_cut: 'treasury' };
      p.querySelector('.ledger')!.innerHTML = led.length ? led.map((l) => `<li><span class="grow">${esc(label[l.reason] ?? l.reason)}${l.plot_name ? ` · ${esc(l.plot_name)}` : ''}<br><span class="sub">${new Date(l.created_at).toLocaleString()}</span></span><b class="${l.delta_coins < 0 ? 'neg' : 'pos'}">${l.delta_coins > 0 ? '+' : ''}${l.delta_coins} ${CURRENCY_SHORT}</b></li>`).join('') : '<li class="hint">Nothing yet.</li>';
    } catch (e) { toast((e as Error).message, 'err'); }
  }
  $('#wallet').addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-act="close"]')) { $('#wallet').hidden = true; return; }
    const qb = t.closest<HTMLElement>('[data-quest]');
    if (qb) { try { await store.claimQuest(qb.dataset.quest!); showPlayer(); toast(`Quest done · ${CURRENCY} added`); void openWallet(); } catch (e) { toast((e as Error).message, 'err'); } }
  });
  $('#coins').addEventListener('click', () => { const open = $('#wallet').hidden; panel.close(); closePopovers(); if (open) void openWallet(); });

  // Neighbourhood boards: one thread per neighbourhood, posting at ${BOARD_MIN_POINTS} points.
  async function openBoard(name: string) {
    const p = $('#board-sheet');
    closePopovers();
    const me = store.player();
    p.innerHTML = `<div class="panel-head"><div><h2><span class="ms">forum</span>${esc(name)}</h2><div class="sub">Neighbourhood board</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      ${me.points >= BOARD_MIN_POINTS ? `<div class="row wish-row"><input name="board_text" maxlength="240" placeholder="Say it to the neighbourhood"><button class="btn filled" data-act="post" data-n="${esc(name)}"><span class="ms">send</span></button></div>` : `<div class="hint">Posting here opens at ${BOARD_MIN_POINTS} points. You have ${me.points}. Reading is free.</div>`}
      <ol class="feed notes-feed"><li class="hint">Loading…</li></ol>`;
    p.hidden = false;
    try { const notes = await store.board(name); p.querySelector('.notes-feed')!.innerHTML = notes.length ? notes.map((n) => `<li><b>${esc(n.player_name || 'someone')}</b> <span class="sub">${new Date(n.created_at).toLocaleString()}</span><br>${esc(n.text)}</li>`).join('') : '<li class="hint">Quiet so far.</li>'; } catch (e) { toast((e as Error).message, 'err'); }
  }
  $('#board-sheet').addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-act="close"]')) { $('#board-sheet').hidden = true; return; }
    const pb = t.closest<HTMLElement>('[data-act="post"]');
    if (pb) { const input = $<HTMLInputElement>('[name="board_text"]'); try { await store.addBoardNote(pb.dataset.n!, input.value); input.value = ''; void openBoard(pb.dataset.n!); } catch (e) { toast((e as Error).message, 'err'); } }
  });
  window.addEventListener('tw:board', (ev) => void openBoard((ev as CustomEvent<string>).detail));

  // Which city next: one vote per city per player, shown to everyone, read by the admin.
  async function openWishlist() {
    const p = $('#wishlist');
    closePopovers();
    p.innerHTML = `<div class="panel-head"><div><h2><span class="ms">location_city</span>Where next?</h2><div class="sub">Assam is first. Tell us which state or city CityNovus should open after.</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      <div class="row wish-row"><input name="wish_city" maxlength="60" placeholder="Your city, e.g. Jorhat"><button class="btn filled" data-act="vote"><span class="ms">how_to_vote</span>Vote</button></div>
      <p id="wish-msg" class="sub"></p><ol class="feed wish-list"><li class="hint">Loading…</li></ol>`;
    p.hidden = false;
    await renderWishes();
  }
  async function renderWishes() {
    const p = $('#wishlist');
    try {
      const w = await store.wishlist();
      p.querySelector('.wish-list')!.innerHTML = w.top.length ? w.top.map((c) => `<li><span class="grow"><b>${esc(c.city)}</b> <span class="sub">${c.votes} ${c.votes === 1 ? 'vote' : 'votes'}</span></span>${w.mine.includes(c.key) ? `<button class="btn text" data-act="unvote" data-key="${esc(c.key)}">Voted ✓</button>` : `<button class="btn tonal" data-act="upvote" data-key="${esc(c.key)}" data-city="${esc(c.city)}">+1</button>`}</li>`).join('') : '<li class="hint">No votes yet. Yours would be the first.</li>';
    } catch (e) { p.querySelector('.wish-list')!.innerHTML = `<li class="hint">${esc((e as Error).message)}</li>`; }
  }
  $('#wishlist').addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const msg = $('#wish-msg');
    try {
      if (b.dataset.act === 'close') { $('#wishlist').hidden = true; return; }
      if (!(await requireIdentity())) return;
      if (b.dataset.act === 'vote') { const v = $<HTMLInputElement>('[name="wish_city"]').value.trim(); if (v.length < 2) { msg.textContent = 'Type a city.'; return; } await store.wish(v); $<HTMLInputElement>('[name="wish_city"]').value = ''; msg.textContent = `Counted. Thanks for asking for ${v}.`; store.track('wish', { city: v }); }
      if (b.dataset.act === 'upvote') { await store.wish(b.dataset.city!); msg.textContent = 'Counted.'; }
      if (b.dataset.act === 'unvote') { await store.unwish(b.dataset.key!); msg.textContent = 'Vote removed.'; }
      await renderWishes();
    } catch (e) { msg.textContent = (e as Error).message; }
  });
  $('#wishlist').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('[name="wish_city"]')) $('#wishlist [data-act="vote"]').click(); });

  async function openActivity() {
    const p = $('#activity');
    closePopovers();
    p.innerHTML = `<div class="panel-head"><div><h2><span class="ms">history</span>What changed</h2><div class="sub">Latest across the city</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div><div class="hint">Loading…</div>`;
    p.hidden = false;
    let items: Activity[] = [];
    try { items = await store.activity(); } catch (e) { p.querySelector('.hint')!.textContent = (e as Error).message; return; }
    // Verbs that already name the thing take no object; the rest get the plot's name or its kind.
    const solo: Record<string, string> = { tree: 'planted a tree', landmark: 'placed a landmark', furniture: 'added street furniture' };
    const verb: Record<string, string> = { claim: 'claimed', edit: 'changed', buy: 'bought', harvest: 'harvested', confirm: 'confirmed', confirm_photo: 'photo-verified', hoarding: 'put up a hoarding on', plant: 'planted on' };
    const ago = (t: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const live = items.filter((a) => a.kind); // plots that have since been undone or deleted drop out
    const line = (a: Activity) => {
      if (solo[a.reason]) return `${solo[a.reason]}${a.plot_name ? ` <b>${esc(a.plot_name)}</b>` : ''}`;
      const what = a.plot_name ? `<b>${esc(a.plot_name)}</b>` : `a ${esc(KINDS[a.kind as Kind]?.label.toLowerCase().split(' /')[0] ?? a.kind ?? 'plot')}`;
      return `${verb[a.reason] ?? a.reason} ${what}`;
    };
    p.querySelector('.hint')!.outerHTML = live.length ? `<ol class="feed">${live.map((a) => `<li data-id="${esc(a.plot_id ?? '')}"><b>${esc(a.player || 'someone')}</b> ${line(a)}${a.neighbourhood ? ` in ${esc(a.neighbourhood)}` : ''}<br><span class="sub">${ago(a.time)}</span></li>`).join('')}</ol>` : '<div class="hint">Nothing yet. Be the first.</div>';
  }
  $('#activity').addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-act="close"]')) { $('#activity').hidden = true; return; }
    const li = (ev.target as HTMLElement).closest<HTMLElement>('li[data-id]');
    if (!li || !li.dataset.id) return;
    const f = world.feature(li.dataset.id);
    if (f) { $('#activity').hidden = true; world.flyTo(centroid(f.geometry.coordinates[0])); world.select(f.properties.id); panel.open(f.properties.id); }
  });
  $('#btn-activity').addEventListener('click', () => { const open = $('#activity').hidden; panel.close(); closePopovers(); if (open) void openActivity(); });

  // Onboarding: three steps, auto-advancing, tracked.
  const onboarding = (() => {
    const el = $('#coach');
    let step = 0;
    let done = false;
    try { done = localStorage.getItem('tw.onboarded') === '1'; } catch { /* ignore */ }
    const steps = [
      { icon: 'search', text: mobile() ? 'Search your street, or tap locate.' : 'Find your street: search a road or landmark, or tap the locate button.' },
      { icon: 'touch_app', text: mobile() ? 'Tap anything grey.' : 'Tap anything grey. Give it floors, a roof and a colour.' },
      { icon: 'publish', text: isGuest() ? (mobile() ? 'Publish, then log in to keep it.' : `Hit Publish. Then log in to keep it: guest work expires in ${session.provisionalHours} hours.`) : (mobile() ? 'Publish. It is yours.' : 'Hit Publish. It is yours, and everyone sees it.') },
    ];
    const show = () => { if (done || step >= steps.length) { el.hidden = true; return; } el.innerHTML = `<span class="ms">${steps[step].icon}</span><div><b>${step + 1}/3</b> ${steps[step].text}</div><button class="btn text on-dark" data-act="skip">Skip</button>`; el.hidden = false; };
    const finish = () => { done = true; el.hidden = true; try { localStorage.setItem('tw.onboarded', '1'); } catch { /* ignore */ } store.track('onboarding_done'); setTimeout(() => toast('You are set. Keep an eye on your neighbourhood.'), 4000); };
    el.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('[data-act="skip"]')) { done = true; el.hidden = true; try { localStorage.setItem('tw.onboarded', '1'); } catch { /* ignore */ } store.track('onboarding_skip'); } });
    return {
      start() { if (!done) { store.track('onboarding_1'); show(); } },
      searched() { if (!done && step === 0) { step = 1; store.track('onboarding_2'); show(); } },
      step(id: string) { if (done) return; const p = state.get(id); if (step <= 1 && !p) { step = 2; store.track('onboarding_3'); show(); } },
      published() { if (!done) finish(); },
    };
  })();
  onboarding.start();
  store.onChange(() => { /* live updates handled above */ });
  const origFresh = panel; void origFresh;

  // Tracing: pick a kind, tap points, finish. Trees are one tap.
  const menu = $('#kind-menu');
  const menuMain = () => KIND_IDS.map((k) => `<button data-kind="${k}"><span class="ms">${KIND_ICONS[k]}</span><span>${kindLabel(k)}<small>+${KINDS[k].tracePoints}${mobile() ? '' : ' points'} · ${SHORT_HINT[KINDS[k].shape].toLowerCase()}</small></span></button>`).join('')
    + `<button data-paint="1" class="span2"><span class="ms">format_paint</span><span>${mobile() ? 'Paint many' : 'Paint many buildings'}<small>${mobile() ? 'One look, tap grey buildings' : 'Pick a colour once, then tap grey buildings one after another'}</small></span></button>`;
  const menuSub = (k: Kind) => `<button data-back="1" class="span2"><span class="ms">arrow_back</span><span>${kindLabel(k)}</span></button>` + (k === 'landmark' ? LANDMARKS : k === 'civic' ? CIVIC : FURNITURE).map((t) => `<button data-kind="${k}" data-sub="${t.id}"><span class="ms">${SUBTYPE_ICONS[t.id]}</span><span>${t.label}<small>+${KINDS[k].tracePoints}${mobile() ? '' : ' points · one tap'}</small></span></button>`).join('');
  menu.innerHTML = menuMain();
  const traceBar = $('#trace-bar');
  $('#btn-trace').addEventListener('click', () => { const open = menu.hidden; closePopovers(); menu.hidden = !open; });
  menu.addEventListener('click', (ev) => {
    const back = (ev.target as HTMLElement).closest<HTMLElement>('[data-back]');
    if (back) { menu.innerHTML = menuMain(); return; }
    const pb = (ev.target as HTMLElement).closest<HTMLElement>('[data-paint]');
    if (pb) { menu.hidden = true; menu.innerHTML = menuMain(); startPaint(); return; }
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (!btn) return;
    const k = btn.dataset.kind as Kind;
    if ((k === 'landmark' || k === 'furniture' || k === 'civic') && !btn.dataset.sub) { menu.innerHTML = menuSub(k); return; }
    traceKind = k;
    traceSubtype = btn.dataset.sub;
    menu.innerHTML = menuMain();
    menu.hidden = true;
    panel.close();
    tracer.start(KINDS[traceKind].shape);
    $('#trace-hint').textContent = kindHint(traceKind);
    $('#trace-finish').hidden = KINDS[traceKind].shape === 'point';
    $('#trace-undo').hidden = KINDS[traceKind].shape === 'point';
    traceBar.hidden = false;
    toast(KINDS[traceKind].shape === 'point' ? kindHint(traceKind) : `${kindHint(traceKind)}, then Finish`);
  });
  $('#trace-undo').addEventListener('click', () => tracer.undo());
  $('#trace-cancel').addEventListener('click', () => { tracer.cancel(); traceBar.hidden = true; });
  $('#trace-finish').addEventListener('click', () => {
    const K = KINDS[traceKind];
    const pts = tracer.finish();
    traceBar.hidden = true;
    if (!pts) { tracer.start(K.shape); traceBar.hidden = false; toast(K.shape === 'line' ? 'Two points at least. Keep tapping.' : 'Three corners at least. Keep tapping.', 'err'); return; }
    let poly: Polygon;
    const props: Props = {};
    if (K.shape === 'line') {
      if (K.lanes) props.lanes = K.lanes;
      props.line = pts;
      poly = bufferLine(pts, lineWidth(traceKind, props.lanes));
    } else {
      // Water, parks and fields are never polygons with sharp corners in real life.
      const organic = traceKind === 'pond' || traceKind === 'park' || traceKind === 'farm' || traceKind === 'playground';
      poly = closeRing(organic && pts.length >= 4 ? chaikin(pts, 2, true) : pts);
    }
    try {
      checkSize(traceKind, poly.coordinates[0]);
      checkPlacement(traceKind, poly.coordinates[0], world.footprints());
    } catch (e) {
      // Keep what they tapped so they can Undo a point or two instead of starting over.
      tracer.start(K.shape);
      for (const p of pts) tracer.add(p);
      traceBar.hidden = false;
      toast(`${(e as Error).message}${mobile() ? ' Undo a point.' : ' Undo the last point and try again.'}`, 'err');
      return;
    }
    const id = 'tw/' + uuid();
    const place = nearestPlace(centroid(poly.coordinates[0]), places);
    const neighbourhood = place?.name ?? 'Unassigned';
    world.addTraced(id, poly, neighbourhood, traceKind, props);
    world.select(id);
    panel.open(id, { geometry: poly, neighbourhood, isNew: true, kind: traceKind, props });
  });

  async function placePoint(lngLat: [number, number]) {
    if (!(await requireIdentity())) return;
    try {
      const place = nearestPlace(lngLat, places);
      const r = await store.placePoint(traceKind, lngLat, place?.name ?? 'Unassigned', traceSubtype);
      state.set(r.plot.id, r.plot);
      world.mergeState(r.plot);
      showPlayer();
      board.refresh();
      store.track('place', { kind: traceKind, subtype: traceSubtype });
      toast(`${KINDS[traceKind].emoji} ${traceKind === 'civic' ? 'Reported' : 'Placed'} · +${r.gained} points`, 'ok', { label: 'Undo', ms: 30_000, fn: async () => { try { const u = await store.undo(r.plot.id); state.delete(u.id); removeFromWorld(u.id); showPlayer(); board.refresh(); toast('Undone'); } catch (e) { toast((e as Error).message, 'err'); } } });
      if (traceKind === 'civic') { world.select(r.plot.id); panel.open(r.plot.id); } // add details and a photo straight away
      else if (traceKind !== 'tree') { tracer.start('point'); $('#trace-bar').hidden = false; } // keep placing furniture and landmarks until Cancel
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  // Paint many: one preset, one tap per grey building.
  const paintBar = $('#paint-bar');
  function startPaint() {
    panel.close();
    paint = paint ?? { colour: PALETTE[0], floors: 2, roof: 'tin' };
    paintBar.innerHTML = `<span class="ms">format_paint</span>
      <div class="swatches mini">${PALETTE.map((c) => `<button class="swatch ${paint!.colour === c ? 'on' : ''}" data-colour="${c}" style="background:${c}"></button>`).join('')}</div>
      <select name="pfloors">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${paint!.floors === n ? 'selected' : ''}>${n} fl</option>`).join('')}</select>
      <select name="proof">${ROOFS.map((r) => `<option value="${r.id}" ${paint!.roof === r.id ? 'selected' : ''}>${r.label.split(' (')[0]}</option>`).join('')}</select>
      <span class="sub">Tap grey buildings</span><button class="btn text" data-act="stop">Done</button>`;
    paintBar.hidden = false;
    toast('Paint mode: every grey building you tap gets this look. +10 each.');
  }
  paintBar.addEventListener('click', (ev) => {
    const sw = (ev.target as HTMLElement).closest<HTMLElement>('[data-colour]');
    if (sw && paint) { paint.colour = sw.dataset.colour!; paintBar.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === sw)); return; }
    if ((ev.target as HTMLElement).closest('[data-act="stop"]')) { paint = null; paintBar.hidden = true; }
  });
  paintBar.addEventListener('change', () => { if (!paint) return; paint.floors = Number(paintBar.querySelector<HTMLSelectElement>('[name="pfloors"]')!.value); paint.roof = paintBar.querySelector<HTMLSelectElement>('[name="proof"]')!.value; });
  async function paintTap(id: string): Promise<boolean> {
    if (!paint) return false;
    const f = world.feature(id);
    if (!f || f.properties.kind !== 'building') return true;
    if (state.get(id)) { toast('Already claimed. Grey ones only.', 'err'); return true; }
    if (!(await requireIdentity())) return true;
    try {
      const r = await store.edit(id, { kind: 'building', geometry: f.geometry, neighbourhood: f.properties.neighbourhood }, { floors: paint.floors, colour: paint.colour, style: null, roof: paint.roof, name: f.properties.osm_name, use: null, photo_url: null, props: {} });
      state.set(id, r.plot); world.mergeState(r.plot); showPlayer(); board.refresh();
      store.track('paint');
      toast(`+${r.gained} · keep tapping`, 'ok', { label: 'Undo', ms: 10_000, fn: async () => { try { const u = await store.undo(id); state.delete(u.id); removeFromWorld(u.id); showPlayer(); } catch (e) { toast((e as Error).message, 'err'); } } });
    } catch (e) { toast((e as Error).message, 'err'); }
    return true;
  }

  $('#btn-board').addEventListener('click', () => { const open = $('#board').hidden; panel.close(); closePopovers(); if (open) board.toggle(); });

  // Live weather: real sky, real rain, real night.
  const fx = new WeatherFX($('#fx') as HTMLCanvasElement);
  let weather: Weather | null = null;
  const applySky = async () => {
    const night = isNight();
    document.documentElement.dataset.theme = night ? 'dark' : 'light';
    const cc = world.map.getCenter();
    world.setSun(sunPosition(new Date(), cc.lat, cc.lng));
    await world.setNight(night);
    fx.apply(weather, night, world.map.getPitch());
  };
  world.map.on('pitch', () => fx.apply(weather, world.night, world.map.getPitch()));
  let weatherAt: [number, number] | null = null;
  let here = 'Assam';
  const loadWeather = async () => {
    try {
      const c = world.map.getCenter();
      weatherAt = [c.lng, c.lat];
      weather = await fetchWeather(weatherAt);
      const d = describe(weather);
      $('#weather').hidden = false;
      $('#weather .ms').textContent = d.icon;
      here = nearestPlace(weatherAt, places.filter((p) => p.kind === 'city' || p.kind === 'town'))?.name ?? 'Assam';
      $('#weather-text').textContent = `${Math.round(weather.temp)}° ${d.label} · ${here}`;
      const alert = severe(weather);
      if (alert) toast(`⚠ ${alert}. Live alerts on banpani.org`, 'err');
    } catch { /* offline: the map is still fine */ }
    await applySky();
  };
  await loadWeather();
  setInterval(loadWeather, 10 * 60_000);
  world.map.on('moveend', () => { const c = world.map.getCenter(); if (weatherAt && Math.hypot(c.lng - weatherAt[0], c.lat - weatherAt[1]) > 0.25) void loadWeather(); });
  setInterval(applySky, 60_000);
  $('#weather').addEventListener('click', () => {
    const p = $('#weather-panel'); const open = p.hidden; closePopovers(); if (!open || !weather) return;
    const d = describe(weather);
    const alert = severe(weather);
    p.innerHTML = `
      <div class="panel-head"><div><h2><span class="ms">${d.icon}</span>${esc(here)} now</h2><div class="sub">Open-Meteo · ${weather.time.replace('T', ' ')} · updates every 10 min</div></div><button class="btn icon" data-act="close" aria-label="Close"><span class="ms">close</span></button></div>
      <div class="wx-now"><span class="ms">${d.icon}</span><div><b>${Math.round(weather.temp)}°</b> <span class="sub">feels ${Math.round(weather.feels)}°</span><div>${d.label} · ${weather.humidity}% humidity · wind ${Math.round(weather.wind)} km/h · cloud ${weather.cloud}%</div></div></div>
      ${alert ? `<div class="banner warn">⚠ ${alert}. Official alerts and relief on <a href="https://banpani.org" target="_blank" rel="noopener">banpani.org</a>.</div>` : ''}
      <div class="sub">Rain chance, next 8 hours</div>
      <div class="wx-hours">${weather.hourly.map((h) => `<div><i style="--p:${h.prob}%"></i>${h.time.slice(11, 13)}h<br>${h.prob}%</div>`).join('')}</div>
      <p class="hint">The map is ${world.night ? 'in night mode because the sun is below the horizon here' : 'lit by the real sun position'}. Rain and thunder on the map are the real thing.</p>`;
    p.hidden = false;
  });
  $('#weather-panel').addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('[data-act="close"]')) $('#weather-panel').hidden = true; });

  // First visit
  try { if (!localStorage.getItem('tw.seen')) { localStorage.setItem('tw.seen', '1'); setTimeout(() => toast('Search your street above, then tap anything grey to make it yours.'), 1200); } } catch { /* ignore */ }

  // Deep link: #b=way/123
  const m = location.hash.match(/#b=(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const f = world.feature(id);
    if (f) { world.flyTo(centroid(f.geometry.coordinates[0])); world.select(id); panel.open(id); }
  }

  window.township = { world, store, state, fx, setWeather: (w: Weather | null) => { weather = w; fx.apply(w, world.night, world.map.getPitch()); } };
}

boot().catch((e) => { console.error(e); toast('Failed to start: ' + (e as Error).message, 'err'); });

declare global { interface Window { township?: { world: WorldMap; store: Store; state: Map<string, Plot>; fx: WeatherFX; setWeather: (w: Weather | null) => void } } }
