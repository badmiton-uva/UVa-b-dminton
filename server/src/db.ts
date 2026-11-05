import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// `node:sqlite` viene con Node ≥ 22.13. Se carga en tiempo de ejecución para no depender del empaquetador.
function sqlite(): typeof import('node:sqlite') {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (!getBuiltin) throw new Error('Se necesita Node.js ≥ 22.13 (node:sqlite).');
  return getBuiltin('node:sqlite') as typeof import('node:sqlite');
}

export type Db = DatabaseSync;

const SCHEMA = `
create table if not exists kv (
  k text primary key,
  v text not null,
  updated_at text not null
);

-- Lista cerrada de jugadores del club. Nada se publica sin consentimiento.
create table if not exists players (
  id integer primary key autoincrement,
  name text not null,
  name_norm text not null,
  profile_guid text,
  category text,
  is_minor integer not null default 0,
  guardian_consent integer not null default 0,
  public integer not null default 0,
  consent_by text,
  consent_at text,
  notes text,
  created_at text not null,
  updated_at text not null,
  -- Un jugador solo puede ser público con consentimiento registrado (y, si es menor, de su familia).
  check (public = 0 or (consent_at is not null and (is_minor = 0 or guardian_consent = 1)))
);

create table if not exists tournaments (
  guid text primary key,
  name text not null,
  start_date text,
  end_date text,
  city text,
  venue text,
  level text,
  tz text not null default 'Europe/Madrid',
  days_json text not null default '[]',
  discovered_at text not null,
  info_ok_at text,
  draws_ok_at text,
  last_error text,
  last_error_at text,
  hidden integer not null default 0,
  -- 1 = torneo introducido a mano por el club: el motor no intenta leerlo de la fuente oficial.
  manual integer not null default 0
);

-- Qué jugadores de la lista aparecen vinculados a cada torneo (descubrimiento desde su perfil).
create table if not exists tournament_players (
  tournament_guid text not null,
  player_id integer not null references players(id) on delete cascade,
  primary key (tournament_guid, player_id)
);

-- Inscripción de jugadores del club en cada prueba y su estado según la lista oficial (admitido, reserva, baja…). No se guardan las parejas.
create table if not exists entries (
  tournament_guid text not null,
  event_id integer not null,
  event_name text not null,
  player_id integer not null references players(id) on delete cascade,
  status text not null,
  label text,
  seed integer,
  event_total integer,
  seen_at text not null,
  primary key (tournament_guid, event_id, player_id)
);

-- Partidos terminados de las personas del club según su perfil oficial (≈ las dos últimas temporadas): base del histórico mensual. Solo fecha, torneo y si se ganó.
create table if not exists history_matches (
  key text primary key,
  tournament_guid text not null,
  tournament_name text not null,
  date text not null,
  won integer not null,
  player_id integer not null references players(id) on delete cascade,
  seen_at text not null
);
create index if not exists history_by_tournament on history_matches(tournament_guid);

-- Crónicas de torneos redactadas por IA: borrador hasta que el responsable la aprueba por el enlace del correo.
create table if not exists chronicles (
  tournament_guid text primary key,
  status text not null,
  title text not null,
  summary text not null,
  body_json text not null,
  code text not null,
  created_at text not null,
  decided_at text
);

-- Participantes del torneo que son del club. Solo se guarda el nombre de quienes son del club (minimización).
create table if not exists entrants (
  tournament_guid text not null,
  ts_player_id integer not null,
  name text not null,
  club text,
  player_id integer references players(id) on delete set null,
  seen_at text not null,
  primary key (tournament_guid, ts_player_id)
);

create table if not exists matches (
  key text primary key,
  tournament_guid text not null,
  date text,
  json text not null,
  hash text not null,
  pending_hash text,
  pending_count integer not null default 0,
  state text not null,
  first_seen_at text not null,
  updated_at text not null,
  last_seen_at text not null
);
create index if not exists matches_t on matches(tournament_guid, date);

-- Registro de cambios. No contiene nombres: solo claves, campos y valores de hora, pista o resultado.
create table if not exists changes (
  id integer primary key autoincrement,
  at text not null,
  tournament_guid text,
  match_key text,
  kind text not null,
  field text,
  old_value text,
  new_value text
);

-- Orden de juego completo, solo datos anónimos de horarios (sin nombres): base de la estimación de fin de torneo.
create table if not exists slots (
  key text primary key,
  tournament_guid text not null,
  date text not null,
  planned_utc text,
  order_idx integer not null default 0,
  court text,
  event text,
  status text not null,
  duration_min integer,
  started_seen_at text,
  prev_poll_at text,
  finished_seen_at text,
  updated_at text not null
);
create index if not exists slots_t on slots(tournament_guid, date);

-- Historial de estimaciones, para medir después lo acertadas que fueron (solo horas y recuentos, sin nombres).
create table if not exists estimate_log (
  tournament_guid text not null,
  date text not null,
  at text not null,
  est_end text,
  est_end_low text,
  est_end_high text,
  remaining integer not null,
  finished integer not null,
  total integer not null,
  primary key (tournament_guid, date, at)
);
create table if not exists estimate_starts (
  tournament_guid text not null,
  date text not null,
  at text not null,
  slot_key text not null,
  est_start text not null,
  primary key (tournament_guid, date, at, slot_key)
);

-- Patrón de cada jornada terminada (solo cifras anónimas): de aquí aprende la estimación (ver patterns.ts). No se borra con el registro.
create table if not exists day_patterns (
  tournament_guid text not null,
  date text not null,
  created_at text not null,
  json text not null,
  primary key (tournament_guid, date)
);

-- Capturas del itinerario en vivo enviadas por correo (solo imágenes con datos públicos). Una por torneo y día.
create table if not exists captures (
  id text primary key,
  day_key text not null unique,
  tournament_guid text not null,
  created_at text not null,
  png blob not null
);

-- Suscripciones por correo (doble confirmación): quién sigue a qué jugadores. Se borra todo al darse de baja.
create table if not exists subscribers (
  id integer primary key autoincrement,
  email text not null unique,
  confirmed_at text,
  created_at text not null,
  -- Selección vigente (tras confirmar): todo el equipo o los jugadores de subscriber_players.
  all_team integer not null default 0,
  -- Selección pedida, pendiente de confirmar por correo.
  pending_all integer not null default 0,
  pending_players text not null default '[]',
  pending_at text,
  last_digest_date text
);
-- Qué avisos de torneo se han enviado ya a cada persona (a media jornada y al final): evita repetirlos.
create table if not exists subscriber_mails (
  subscriber_id integer not null references subscribers(id) on delete cascade,
  tournament_guid text not null,
  kind text not null,
  sent_at text not null,
  primary key (subscriber_id, tournament_guid, kind)
);
create table if not exists subscriber_players (
  subscriber_id integer not null references subscribers(id) on delete cascade,
  player_id integer not null,
  primary key (subscriber_id, player_id)
);

-- Cuadros y clasificaciones tal como los publica la fuente. Con nombres de terceros: solo se sirven anonimizados.
create table if not exists draws (
  tournament_guid text not null,
  draw_id integer not null,
  name text not null,
  type text not null,
  json text not null,
  updated_at text not null,
  primary key (tournament_guid, draw_id)
);

-- Suscripciones a avisos push, ligadas a un jugador público.
create table if not exists push_subs (
  id integer primary key autoincrement,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  player_id integer not null references players(id) on delete cascade,
  minutes_before integer not null default 20,
  created_at text not null
);
create table if not exists push_sent (
  sub_id integer not null references push_subs(id) on delete cascade,
  match_key text not null,
  sent_at text not null,
  primary key (sub_id, match_key)
);

create table if not exists fetch_log (
  id integer primary key autoincrement,
  at text not null,
  url text not null,
  status integer,
  ms integer,
  bytes integer,
  changed integer,
  error text
);
`;

/** Cambios de esquema sobre bases de datos ya creadas (idempotentes). */
function migrate(db: Db) {
  const cols = (db.prepare('pragma table_info(draws)').all() as unknown as { name: string }[]).map((c) => c.name);
  if (!cols.includes('has_club')) db.exec('alter table draws add column has_club integer not null default 0');
  const scols = (db.prepare('pragma table_info(slots)').all() as unknown as { name: string }[]).map((c) => c.name);
  if (!scols.includes('pids')) db.exec('alter table slots add column pids text');
  const ecols = (db.prepare('pragma table_info(entries)').all() as unknown as { name: string }[]).map((c) => c.name);
  if (!ecols.includes('seed')) db.exec('alter table entries add column seed integer');
  if (!ecols.includes('event_total')) db.exec('alter table entries add column event_total integer');
}

export function openDb(file?: string): Db {
  const { DatabaseSync } = sqlite();
  let target = file ?? ':memory:';
  if (file && file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    target = file;
  }
  const db = new DatabaseSync(target);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const nowIso = () => new Date().toISOString();

export const kvGet = <T>(db: Db, k: string): T | undefined => {
  const row = db.prepare('select v from kv where k = ?').get(k) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : undefined;
};

export const kvSet = (db: Db, k: string, v: unknown, at = nowIso()) => {
  db.prepare('insert into kv(k, v, updated_at) values(?, ?, ?) on conflict(k) do update set v = excluded.v, updated_at = excluded.updated_at').run(
    k,
    JSON.stringify(v),
    at,
  );
};
