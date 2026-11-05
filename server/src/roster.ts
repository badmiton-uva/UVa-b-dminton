import { type Db, nowIso } from './db';
import { extractGuid, nameTokens, normalizeName, sameFullName } from './text';

export interface Player {
  id: number;
  name: string;
  profileGuid: string | null;
  category: string | null;
  isMinor: boolean;
  guardianConsent: boolean;
  public: boolean;
  consentBy: string | null;
  consentAt: string | null;
  notes: string | null;
}

export interface PlayerInput {
  name: string;
  /** GUID o URL del perfil oficial (profile/overview.aspx?id=…). */
  profile?: string | null;
  category?: string | null;
  isMinor?: boolean;
  guardianConsent?: boolean;
  /** «Mostrar públicamente». Exige consentimiento registrado (y, en menores, de su familia). */
  public?: boolean;
  consentBy?: string | null;
  consentAt?: string | null;
  notes?: string | null;
}

export class ValidationError extends Error {}

interface Row {
  id: number; name: string; profile_guid: string | null; category: string | null; is_minor: number;
  guardian_consent: number; public: number; consent_by: string | null; consent_at: string | null; notes: string | null;
}

const toPlayer = (r: Row): Player => ({
  id: r.id, name: r.name, profileGuid: r.profile_guid, category: r.category, isMinor: !!r.is_minor,
  guardianConsent: !!r.guardian_consent, public: !!r.public, consentBy: r.consent_by, consentAt: r.consent_at, notes: r.notes,
});

/** Valida y normaliza una ficha. Aplica la regla del consentimiento antes de tocar la base de datos. */
export function normalizeInput(input: PlayerInput, current?: Player): Omit<Player, 'id'> {
  const name = (input.name ?? current?.name ?? '').trim();
  if (name.length < 3 || nameTokens(name).length < 2) throw new ValidationError('Indica nombre y apellidos.');
  const rawProfile = input.profile === undefined ? current?.profileGuid ?? null : input.profile;
  let profileGuid: string | null = null;
  if (rawProfile) {
    profileGuid = extractGuid(rawProfile)?.toUpperCase() ?? null;
    if (!profileGuid) throw new ValidationError('El perfil debe ser un GUID o un enlace de badminton.es (profile/overview.aspx?id=…).');
  }
  const isMinor = input.isMinor ?? current?.isMinor ?? false;
  const guardianConsent = input.guardianConsent ?? current?.guardianConsent ?? false;
  const wantsPublic = input.public ?? current?.public ?? false;
  const consentBy = input.consentBy === undefined ? current?.consentBy ?? null : input.consentBy;
  const consentAt = input.consentAt === undefined ? current?.consentAt ?? null : input.consentAt;
  if (wantsPublic) {
    if (!consentAt || !consentBy) throw new ValidationError('Para mostrar a una persona hay que registrar quién consintió y cuándo.');
    if (isMinor && !guardianConsent) throw new ValidationError('Es menor: hace falta el consentimiento de su familia o tutores.');
  }
  return {
    name, profileGuid, category: input.category === undefined ? current?.category ?? null : input.category,
    isMinor, guardianConsent, public: wantsPublic, consentBy, consentAt,
    notes: input.notes === undefined ? current?.notes ?? null : input.notes,
  };
}

export function listPlayers(db: Db): Player[] {
  return (db.prepare('select * from players order by name_norm').all() as unknown as Row[]).map(toPlayer);
}

export function getPlayer(db: Db, id: number): Player | undefined {
  const r = db.prepare('select * from players where id = ?').get(id) as unknown as Row | undefined;
  return r ? toPlayer(r) : undefined;
}

export function createPlayer(db: Db, input: PlayerInput): Player {
  const p = normalizeInput(input);
  const now = nowIso();
  const res = db
    .prepare(`insert into players(name, name_norm, profile_guid, category, is_minor, guardian_consent, public, consent_by, consent_at, notes, created_at, updated_at)
              values(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.name, normalizeName(p.name), p.profileGuid, p.category, +p.isMinor, +p.guardianConsent, +p.public, p.consentBy, p.consentAt, p.notes, now, now);
  return getPlayer(db, Number(res.lastInsertRowid))!;
}

export function updatePlayer(db: Db, id: number, input: Partial<PlayerInput>): Player {
  const current = getPlayer(db, id);
  if (!current) throw new ValidationError('No existe ese jugador.');
  const p = normalizeInput({ ...input, name: input.name ?? current.name }, current);
  db.prepare(`update players set name=?, name_norm=?, profile_guid=?, category=?, is_minor=?, guardian_consent=?, public=?, consent_by=?, consent_at=?, notes=?, updated_at=? where id=?`)
    .run(p.name, normalizeName(p.name), p.profileGuid, p.category, +p.isMinor, +p.guardianConsent, +p.public, p.consentBy, p.consentAt, p.notes, nowIso(), id);
  if (!p.public) db.prepare('delete from push_subs where player_id = ?').run(id); // sin publicación no hay avisos
  return getPlayer(db, id)!;
}

/**
 * Derecho de supresión: borra a la persona y todo lo que la identifica en el servidor
 * (vínculos, participaciones guardadas y partidos en los que figura). El registro de cambios no contiene nombres.
 */
export function deletePlayer(db: Db, id: number): boolean {
  const p = getPlayer(db, id);
  if (!p) return false;
  const rows = db.prepare('select key, json from matches').all() as unknown as { key: string; json: string }[];
  const drop = db.prepare('delete from matches where key = ?');
  for (const r of rows) {
    const m = JSON.parse(r.json) as { sides: { players: { rosterId?: number }[] }[] };
    if (m.sides.some((s) => s.players.some((x) => x.rosterId === id))) drop.run(r.key);
  }
  db.prepare('delete from entrants where player_id = ?').run(id);
  db.prepare('delete from players where id = ?').run(id);
  return true;
}

/** Busca en la lista a quien corresponde un nombre publicado por la fuente oficial (mismos tokens, en cualquier orden). */
/**
 * Como `findByName`, pero admite el nombre corto de los torneos («Pablo Martín») frente al completo del ranking
 * («Pablo Martín Castañeda»). Exige al menos dos palabras y que el resultado sea único.
 */
/**
 * Busca por nombre, con tolerancia: el nombre oficial puede traer más palabras que el de la lista (segundo apellido, etc.).
 * Con `shorterOk: false` NO se acepta un nombre oficial MÁS CORTO que el de la lista («Javier Gonzalez» frente a «Javier Gonzalez Martin»):
 * sin el segundo apellido no se sabe de quién se trata y hay homónimos en otros clubes. Solo vale si hay otra prueba (club de la UVA, perfil oficial).
 */
export function findByNameLoose(players: Player[], name: string, opts: { shorterOk?: boolean } = {}): Player | undefined {
  const exact = players.find((p) => sameFullName(p.name, name));
  if (exact) return exact;
  const t = new Set(nameTokens(name));
  if (t.size < 2) return undefined;
  const shorterOk = opts.shorterOk ?? true;
  const hits = players.filter((p) => {
    const r = new Set(nameTokens(p.name));
    if (r.size < 2) return false;
    if (!shorterOk && t.size < r.size) return false; // el nombre oficial no trae todo lo que trae el de la lista
    const [small, big] = r.size <= t.size ? [r, t] : [t, r];
    return [...small].every((x) => big.has(x));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

export function findByName(players: Player[], name: string): Player | undefined {
  return players.find((p) => sameFullName(p.name, name));
}
