# CityNovus

**citynovus.com — India builds its own 3D map.**

Google has 3D buildings for a handful of Indian metros. OpenStreetMap has 2,734 building
footprints for all of Guwahati. Nobody has a visual map of India. CityNovus lets a city
colour itself in, block by block, and makes it a game.

Every OSM footprint starts as a grey box. Tap one, give it floors, a roof, a colour and a
name, and it rises in front of you with a roof cap and, for shops, a darker shopfront.
Ponds fill with water, parks grow trees, flyovers lift onto a deck with piers. Where OSM
has nothing, trace it: buildings, ponds, parks, playgrounds, flyovers and roads. Points
for every edit, more when a neighbour confirms it, weighted flags to take bad edits down,
and a neighbourhood leaderboard with a share card.

Code is MIT. Contributed map data is ODbL, the OpenStreetMap licence, so it can go back
into OSM and can never be taken private.

## Run it

```bash
npm install
npm run fetch-osm     # pulls Guwahati buildings, water, parks, flyovers + neighbourhoods into public/data
npm run dev           # http://localhost:5173 — local mode, everything stays in this browser
```

Local mode is the whole game with no backend, good enough to demo and to play alone.

## Run it multiplayer, on your laptop

```bash
npm run server        # API on :8080 with an embedded Postgres (PGlite) in ./data — no install
npm run dev           # the dev site finds the API on /api and goes live automatically
```

Two browsers on the same Wi-Fi now see each other's work in real time.

## Run it on DigitalOcean

The server is one Node process plus Postgres. Two ways:

**The droplet (168.144.127.72) with docker compose.** The compose file runs Postgres, the API and
Caddy, which gets and renews the HTTPS certificate for citynovus.com by itself.

1. DNS: an `A` record for `citynovus.com` and one for `www` pointing at `168.144.127.72`.
2. One-time: `ssh root@168.144.127.72 'bash -s' < deploy/setup-droplet.sh` installs Docker, the
   firewall and swap.
3. Put the repo at `/opt/citynovus` (`deploy/deploy.sh` rsyncs it from your laptop), copy
   `deploy/env.production.example` to `/opt/citynovus/.env` and fill in the secrets.
4. `cd /opt/citynovus && docker compose up -d --build`. Check `https://citynovus.com/api/health`.
5. Seed from your laptop: `ADMIN_TOKEN=… API=https://citynovus.com SEED=300 node scripts/seed.mjs`.
6. Later deploys: `deploy/deploy.sh`.

**Google sign-in credentials.** In Google Cloud Console → APIs & Services → Credentials → OAuth
client (Web application):

- Authorised JavaScript origins: `https://citynovus.com`, `https://www.citynovus.com`,
  `http://localhost:8080`, `http://localhost:5173`
- Authorised redirect URIs: `https://citynovus.com/api/auth/google/callback`,
  `http://localhost:8080/api/auth/google/callback`, `http://localhost:5173/api/auth/google/callback`

Google does not accept a bare IP address, so the domain must be live before sign-in works on
the droplet.

**App Platform + Managed Postgres.** Create the app from the repo with the Dockerfile, add a
Managed Postgres, and set these environment variables on the app:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Managed Postgres connection string |
| `REQUIRE_LOGIN` | `true` — only accounts can build; anyone can look |
| `FLAG_MIN_POINTS` | `1000` — points needed before a player can flag |
| `COOKIE_SECURE` | `true` |

The server serves the built site itself, so there is nothing else to deploy. Accounts are email
and password, hashed with scrypt, sessions in httpOnly cookies. A guest who creates an account
keeps their points, coins and everything they built.

## The look

Roads and flyovers are traced as a few taps and turned into smooth, round-ended strips
(Chaikin smoothing). Flyovers are decks built from short segments, so a traced one ramps up
from the ground at both ends and arches gently; OSM bridge spans just arch. Ponds, parks and
farms you trace get rounded corners. Buildings get a ledge between floors and a window band
on every floor, lit at night. The satellite button switches the ground to aerial imagery
(Esri World Imagery, attribution kept; check their terms before commercial use) with the
basemap's labels on top, which is also the easiest way to trace accurate footprints.

## Weather and night

The map runs on the real sky. Open-Meteo (no key) gives Guwahati's current conditions every ten
minutes; the sun's position is computed from the clock and the city's coordinates. When the sun
is below the horizon the basemap swaps to a blue-grey night style (readable, not black), the
app chrome goes dark, window bands light up and stars come out over the horizon. Rain, drizzle, thunder flashes and fog
are drawn on a canvas over the map in proportion to what is actually falling. Severe conditions
show a nudge to banpani.org, which carries the official alerts.

## The rules, in one place

Everything below lives in `shared/rules.ts`, which both the browser and the server run, so a
rule cannot differ between the two. The currency is **Novus Coins (NC)**: earned by playing,
spent on land, seeds, tall floors and shields, never bought, sold or transferred.

**Market.** A plot is *not for sale* (default), *for sale at a fixed price* (instant buy), or
*open to offers*. Offers hold the buyer's coins in escrow for up to 7 days; the owner accepts
or declines from the inbox. An owner absent for 30 days makes their plots buyable without
asking, unless shielded (50 NC for 30 days). Every sale, forever: owner 80%, original builder
10%, City Treasury 10%. Plots under community review can be taken over for a tenth of value.
Land value = kind × floors × confirmations × neighbourhood demand.

**Civic reports.** One tap: garbage, pothole, waterlogging, open drain, broken streetlight,
illegal dumping, footpath encroachment, with a photo. Others confirm it is real or mark it
fixed; three "fixed" marks close it and pay the reporter. Open counts show on the
neighbourhood leaderboard; `/api/admin/civic.csv` is the export for the municipality.

**Notes and boards.** Plot notes open at 1000 points, neighbourhood boards at 5000. Same
blocklist, flags and admin tools as everything else. No direct messages.

**Daily.** A streak bonus on each day's first visit (5 to 25 NC) and four daily quests worth up
to 45 NC, claimed from the wallet. The wallet shows the full ledger and the Treasury balance.

| Action | Points | Coins | Notes |
|---|---|---|---|
| Claim anything OSM already has | +10 | +10 | building, pond, park, playground, flyover. It is yours. |
| Add a building OSM does not have | +25 | +25 | 6 to 40,000 m² |
| Add a pond, park, farm or flyover | +20 | +20 | |
| Add a playground or road | +15 | +15 | |
| Plant a tree | +5 | +5 | one tap |
| Change something you own | +5 | +5 | |
| Confirm someone else's work | +3 | +3 | owner gets +5 |
| Buy someone's plot | +5 | −price | owner gets 80% of the price |
| Plant a crop | +2 | −seed cost | farms, and flat roofs (terrace farms) |
| Harvest | +5 | +yield | tomato 4h → tea 2d → bamboo 3d, real time |
| Put up a hoarding | 0 | −50 | off until launch traction (`VITE_HOARDINGS=true`); the future revenue model |
| Flag | 0 | 0 | needs 1000 points; weight grows from 0.2 to 1 |
| Floors above 6 | 0 | −20 each | paid once when you go up |
| Shield a plot | 0 | −50 | 30 days safe from the abandonment rule |
| Report a civic issue | +5 | +5 | +10 more when three people mark it fixed |
| Mark a report fixed | +3 | +3 | |
| Daily streak | 0 | +5 to +25 | first visit each day |
| Daily quest | 0 | +10 to +15 | claim in the wallet |
| Place a landmark | +15 | +15 | one tap |
| Street furniture | +3 | +3 | one tap |
| Wall or railway | +10 / +15 | same | traced as a line |
| Photo-verify someone's work | +9 | +9 | owner gets +15 |

Everyone starts with 200 coins. A plot's price is its kind's base times floors times how often
it was confirmed, so well-built and well-liked things cost more. Anything under community
review (5 flags) can be bought for a tenth of the price and fixed.

**Guardrails.** A shape is refused where it does not belong: no building in a pond, no farm on
a flyover, no tree on a road. The full matrix is `BLOCKED_BY` in the rules. Flyovers may cross
ponds and roads (they are bridges); roads may cross parks.

**Ownership.** Claiming or tracing something makes you its owner. Only the owner can change,
reshape, plant, harvest or put a hoarding on it. Anyone can confirm, flag, or buy it.

Flyovers and roads are traced as a centre line and turned into a strip; change the lanes
later and the strip re-shapes. Every polygon can be reshaped by dragging its corners.

A building is hidden for review when its flag score reaches 5. Anyone other than the
original builder can edit it to bring it back, which clears the flags. Twenty edits a
minute per device is the rate limit. Names on buildings are for shops, schools and
landmarks, never private people; that is a flag reason.

## Layout

```
scripts/fetch-osm.mjs        Overpass → public/data/{world.geojson, places.json}
shared/rules.ts              THE RULES: kinds, points, coins, prices, crops, guardrails, every action
shared/geo.ts                geometry helpers, overlap tests
src/config.ts                city, palette, styles, badges, UI lists
src/map.ts                   MapLibre map: extrusions, roofs, slabs, trees, crops, piers, hoardings, sky
src/draw.ts                  polygon, line and point tracer
src/editor.ts                drag-the-corners shape editor
src/panel.ts                 the editor panel, one form per kind, farming and hoardings
src/leaderboard.ts           neighbourhood progress + share cards
src/share.ts                 the 1200×630 share card
src/store-local.ts           browser-only backend (same rules)
src/store-server.ts          API client (cookie session or device id, SSE for live updates)
server/index.ts              Fastify API: auth, plots, actions, live events, serves dist/
server/db.ts                 Postgres via pg, or embedded PGlite when DATABASE_URL is empty
server/schema.sql            players, sessions, plots, edits, confirmations, flags, ledger
```

## What is deliberately not here yet

Real 3D models (pitched roofs are stepped caps, trees are octagons), multipolygon
relations from OSM (the Brahmaputra, the biggest parks), paid hoardings for real brands,
photo upload, a moderation dashboard, email verification and password reset, pushing
traced footprints back to OSM. Colour in a few thousand things first.

The look is deliberately a toy city, not photoreal. The next step up in believability is a
Three.js custom layer with procedurally generated pitched roofs and a small set of
regional building models, which MapLibre supports without replacing anything here.

Map data © OpenStreetMap contributors. Basemap tiles by OpenFreeMap.
