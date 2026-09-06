create table if not exists players (
  id            text primary key,           -- 'dev_<device>' for guests, 'u_<uuid>' for accounts
  name          text,
  email         text unique,
  password_hash text,
  points        integer not null default 0,
  coins         integer not null default 200,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

create table if not exists sessions (
  token      text primary key,
  player_id  text not null references players(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists plots (
  id                text primary key,
  kind              text not null,
  neighbourhood     text not null,
  geometry          jsonb,
  floors            integer not null default 1,
  colour            text,
  style             text,
  roof              text,
  name              text,
  "use"             text,
  photo_url         text,
  props             jsonb not null default '{}',
  built_by_id       text,
  built_by_name     text,
  owner_id          text,
  owner_name        text,
  last_edit_by_name text,
  confirmations     integer not null default 0,
  flag_score        numeric not null default 0,
  hidden            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists plots_owner_idx on plots (owner_id);
create index if not exists plots_neighbourhood_idx on plots (neighbourhood);

create table if not exists edits (
  id         serial primary key,
  plot_id    text not null,
  player_id  text not null,
  changes    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists edits_player_time_idx on edits (player_id, created_at);

create table if not exists confirmations (
  plot_id    text not null,
  player_id  text not null,
  created_at timestamptz not null default now(),
  primary key (plot_id, player_id)
);

create table if not exists flags (
  plot_id    text not null,
  player_id  text not null,
  reason     text,
  weight     numeric not null,
  created_at timestamptz not null default now(),
  primary key (plot_id, player_id)
);

-- Every point and coin movement, so the economy can be audited and tuned.
create table if not exists ledger (
  id           serial primary key,
  player_id    text not null,
  delta_points integer not null default 0,
  delta_coins  integer not null default 0,
  reason       text not null,
  plot_id      text,
  created_at   timestamptz not null default now()
);

-- v0.4: accounts that can be verified and reset, bans, IPs for signup caps, tokens, product events, admin log.
alter table players add column if not exists verified boolean not null default false;
alter table players add column if not exists banned boolean not null default false;
alter table players add column if not exists ip text;

create table if not exists tokens (
  token      text primary key,
  player_id  text not null references players(id),
  kind       text not null,            -- 'verify' | 'reset'
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id         serial primary key,
  player_id  text,
  name       text not null,
  props      jsonb not null default '{}',
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists events_name_time_idx on events (name, created_at);

create table if not exists admin_log (
  id         serial primary key,
  action     text not null,
  target     text,
  detail     text,
  created_at timestamptz not null default now()
);

-- v0.5: Google sign-in, guest work that expires unless saved.
alter table players add column if not exists google_sub text unique;
alter table players add column if not exists avatar text;
alter table plots add column if not exists provisional boolean not null default false;
create index if not exists plots_provisional_idx on plots (provisional, created_at);

-- v0.6: which city next
create table if not exists wishlist (
  id         serial primary key,
  city       text not null,
  city_key   text not null,
  player_id  text not null,
  note       text,
  created_at timestamptz not null default now(),
  unique (city_key, player_id)
);
create index if not exists wishlist_city_idx on wishlist (city_key);

-- v0.6.1: OAuth state may be created before the guest row exists; no foreign key on tokens.
alter table tokens drop constraint if exists tokens_player_id_fkey;

-- v0.7: the economy. Sale terms, offers held in escrow, inbox, notes and boards, treasury, quests, streaks.
alter table plots add column if not exists sale_status text not null default 'none';
alter table plots add column if not exists sale_price integer;
alter table players add column if not exists streak integer not null default 0;
alter table players add column if not exists streak_day text;

create table if not exists offers (
  id         serial primary key,
  plot_id    text not null,
  buyer_id   text not null,
  amount     integer not null,
  status     text not null default 'pending',   -- pending | accepted | declined | cancelled | expired
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists offers_plot_idx on offers (plot_id, status);
create index if not exists offers_buyer_idx on offers (buyer_id, status);

create table if not exists notifications (
  id         serial primary key,
  player_id  text not null,
  type       text not null,
  text       text not null,
  plot_id    text,
  offer_id   integer,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_player_idx on notifications (player_id, read, id);

create table if not exists notes (
  id          serial primary key,
  plot_id     text,
  board       text,
  player_id   text not null,
  player_name text,
  text        text not null,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists notes_plot_idx on notes (plot_id, id);
create index if not exists notes_board_idx on notes (board, id);

create table if not exists treasury (id integer primary key, balance integer not null default 0);
insert into treasury (id, balance) values (1, 0) on conflict (id) do nothing;

create table if not exists quest_claims (
  player_id  text not null,
  day        text not null,
  quest      text not null,
  created_at timestamptz not null default now(),
  primary key (player_id, day, quest)
);
