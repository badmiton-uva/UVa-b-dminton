import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { settings } from './config';
import { type Db, kvGet, kvSet, nowIso } from './db';
import type { Mailer } from './mailer';
import type { PublicState } from './publicView';

/**
 * Suscripciones por correo con doble confirmación: la persona indica su correo y a quién quiere seguir (todo el equipo o jugadores concretos), recibe un
 * mensaje para confirmar y, desde entonces, un resumen semanal. Cada correo lleva un enlace para darse de baja (se borra todo). Solo se puede seguir a
 * jugadores públicos (con consentimiento).
 */
export class SubscribeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Subscriber {
  id: number;
  email: string;
  confirmedAt: string | null;
  allTeam: boolean;
  playerIds: number[];
  lastDigestDate: string | null;
}

const EMAIL = /^[^\s@<>()"',;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const normalizeEmail = (e: unknown): string => {
  const s = String(e ?? '').trim().toLowerCase();
  if (s.length > 120 || !EMAIL.test(s)) throw new SubscribeError(400, 'Escribe un correo electrónico válido.');
  return s;
};

/** Clave secreta de los enlaces (aleatoria, guardada en la base de datos; `SUBSCRIBE_SECRET` la fija a mano). */
function secret(db: Db): string {
  if (process.env.SUBSCRIBE_SECRET) return process.env.SUBSCRIBE_SECRET;
  const k = kvGet<{ s: string }>(db, 'subscribe_secret');
  if (k) return k.s;
  const s = randomBytes(32).toString('hex');
  kvSet(db, 'subscribe_secret', { s });
  return s;
}
/** Token de un enlace (confirmar o darse de baja): firma de la persona y del fin del enlace; no caduca, pero solo vale para esa acción. */
export const tokenFor = (db: Db, id: number, purpose: 'c' | 'u'): string => createHmac('sha256', secret(db)).update(`${purpose}:${id}`).digest('hex').slice(0, 40);
export function tokenOk(db: Db, id: number, purpose: 'c' | 'u', token: string): boolean {
  const want = Buffer.from(tokenFor(db, id, purpose));
  const got = Buffer.from(String(token));
  return want.length === got.length && timingSafeEqual(want, got);
}

const base = () => settings.itinerary.baseUrl;
export const confirmUrl = (db: Db, id: number) => `${base()}/suscripcion/confirmar?i=${id}&t=${tokenFor(db, id, 'c')}`;
export const unsubscribeUrl = (db: Db, id: number) => `${base()}/suscripcion/baja?i=${id}&t=${tokenFor(db, id, 'u')}`;

interface Row { id: number; email: string; confirmed_at: string | null; all_team: number; pending_all: number; pending_players: string; pending_at: string | null; last_digest_date: string | null }

const publicIds = (state: PublicState) => new Set(state.players.map((p) => p.id));

/** Normaliza lo elegido: «todo el equipo» o una lista de jugadores públicos existentes (al menos uno). */
function choice(state: PublicState, input: { all?: unknown; players?: unknown }): { all: boolean; players: number[] } {
  const all = input.all === true;
  const ids = Array.isArray(input.players) ? [...new Set(input.players.map(Number).filter((n) => Number.isInteger(n)))] : [];
  const valid = ids.filter((id) => publicIds(state).has(id));
  if (!all && valid.length === 0) throw new SubscribeError(400, 'Elige a todo el equipo o, al menos, a un jugador.');
  return { all, players: all ? [] : valid.slice(0, 30) };
}

const mailFooter = 'Club Bádminton Universidad de Valladolid';

function confirmMail(db: Db, id: number, email: string, what: string, change: boolean): { subject: string; text: string; html: string } {
  const link = confirmUrl(db, id);
  const intro = change ? 'Has pedido cambiar lo que sigues en el Club Bádminton UVa' : 'Has pedido recibir por correo las noticias y resultados del Club Bádminton UVa';
  const text = `${intro}: ${what}.\n\nPara confirmarlo, abre este enlace (si no has sido tú, ignora este mensaje y no pasará nada):\n${link}\n\n${mailFooter}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14132f"><h2 style="color:#2f2c64">Confirma tu suscripción</h2><p>${intro}: <strong>${escapeHtml(what)}</strong>.</p><p><a href="${link}" style="display:inline-block;background:#2f2c64;color:#fff;padding:12px 20px;text-decoration:none;border-radius:4px">Confirmar</a></p><p style="font-size:13px;color:#566072">Si no has sido tú, ignora este mensaje y no pasará nada.<br>${mailFooter}</p></div>`;
  return { subject: change ? 'Confirma el cambio · Club Bádminton UVa' : 'Confirma tu suscripción · Club Bádminton UVa', text, html };
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const describe = (state: PublicState, c: { all: boolean; players: number[] }) => (c.all ? 'todo el equipo' : c.players.map((id) => state.players.find((p) => p.id === id)?.name).filter(Boolean).join(', '));

/**
 * Pide (o cambia) una suscripción. Siempre responde igual, exista o no el correo (no se revela quién está suscrito). La selección no vale hasta que la persona
 * abre el enlace del correo que se le envía. Entre dos correos a la misma dirección pasan al menos `cooldownMin` minutos.
 */
export async function requestSubscription(db: Db, state: PublicState, input: { email?: unknown; all?: unknown; players?: unknown; consent?: unknown; website?: unknown }, mailer: Mailer, now = new Date()): Promise<void> {
  if (input.website) return; // campo trampa: los robots lo rellenan
  if (input.consent !== true) throw new SubscribeError(400, 'Tienes que aceptar el tratamiento de tu correo para suscribirte.');
  const email = normalizeEmail(input.email);
  const c = choice(state, input);
  const row = db.prepare('select * from subscribers where email = ?').get(email) as unknown as Row | undefined;
  const at = now.toISOString();
  let id: number;
  if (row) {
    if (row.pending_at && now.getTime() - Date.parse(row.pending_at) < settings.subscriptions.cooldownMin * 60_000) return; // ya se le envió hace poco
    db.prepare('update subscribers set pending_all = ?, pending_players = ?, pending_at = ? where id = ?').run(c.all ? 1 : 0, JSON.stringify(c.players), at, row.id);
    id = row.id;
  } else {
    const n = (db.prepare('select count(*) n from subscribers').get() as unknown as { n: number }).n;
    if (n >= settings.subscriptions.max) throw new SubscribeError(503, 'Ahora mismo no se admiten más suscripciones.');
    id = Number(db.prepare('insert into subscribers(email, created_at, pending_all, pending_players, pending_at) values(?,?,?,?,?)').run(email, at, c.all ? 1 : 0, JSON.stringify(c.players), at).lastInsertRowid);
  }
  const m = confirmMail(db, id, email, describe(state, c), !!row?.confirmed_at);
  try {
    await mailer.send({ to: email, ...m });
  } catch (e) {
    // Si el correo no sale, no se queda la suscripción a medias ni se bloquea el reintento: lo nuevo se borra y lo existente vuelve a poder pedirse.
    if (row) db.prepare('update subscribers set pending_at = null where id = ?').run(id);
    else db.prepare('delete from subscribers where id = ?').run(id);
    throw e;
  }
}

/** Aplica lo pedido tras abrir el enlace de confirmación. Devuelve `undefined` si el enlace no vale. */
export function confirmSubscription(db: Db, id: number, token: string, now = new Date()): { email: string } | undefined {
  if (!tokenOk(db, id, 'c', token)) return undefined;
  const row = db.prepare('select * from subscribers where id = ?').get(id) as unknown as Row | undefined;
  if (!row) return undefined;
  const players = JSON.parse(row.pending_players) as number[];
  const first = !row.confirmed_at;
  db.prepare('update subscribers set confirmed_at = coalesce(confirmed_at, ?), all_team = ?, pending_players = ?, pending_all = 0 where id = ?').run(now.toISOString(), row.pending_all, '[]', id);
  db.prepare('delete from subscriber_players where subscriber_id = ?').run(id);
  const ins = db.prepare('insert or ignore into subscriber_players(subscriber_id, player_id) values(?,?)');
  for (const p of players) ins.run(id, p);
  // El primer resumen incluye la última semana, para que se vea qué se recibirá.
  if (first) db.prepare('update subscribers set last_digest_date = ? where id = ?').run(new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10), id);
  return { email: row.email };
}

/** Baja: se borra la persona y su selección. Devuelve `false` si el enlace no vale. */
export function unsubscribe(db: Db, id: number, token: string): boolean {
  if (!tokenOk(db, id, 'u', token)) return false;
  db.prepare('delete from subscribers where id = ?').run(id);
  return true;
}

export function listConfirmed(db: Db): Subscriber[] {
  const rows = db.prepare('select * from subscribers where confirmed_at is not null').all() as unknown as Row[];
  const sel = db.prepare('select player_id from subscriber_players where subscriber_id = ?');
  return rows.map((r) => ({ id: r.id, email: r.email, confirmedAt: r.confirmed_at, allTeam: !!r.all_team, playerIds: (sel.all(r.id) as unknown as { player_id: number }[]).map((x) => x.player_id), lastDigestDate: r.last_digest_date }));
}

/** Limpieza diaria: las suscripciones sin confirmar en 7 días se borran. */
export function pruneSubscribers(db: Db, now = new Date()): number {
  return Number(db.prepare('delete from subscribers where confirmed_at is null and created_at < ?').run(new Date(now.getTime() - 7 * 86_400_000).toISOString()).changes);
}

export const subscriberCounts = (db: Db) => db.prepare('select count(confirmed_at) confirmed, count(*) - count(confirmed_at) pending from subscribers').get() as unknown as { confirmed: number; pending: number };
void nowIso;
