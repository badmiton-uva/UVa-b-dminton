import { CLUB_PATTERN } from './config';
import { createHash } from 'node:crypto';
import { findByNameLoose, type Player } from './roster';
import type { MatchRow, MatchStatus, Team } from './model';

/** ¿El club que publica la fuente oficial es el de la Universidad de Valladolid? */
export const isUvaClub = (club?: string | null): boolean => !!club && CLUB_PATTERN.test(club);

export interface SidePlayer {
  name: string;
  tsPlayerId?: number;
  /** Es del club: figura con el club de la UVA, está en la lista del club, o ambas. */
  uva: boolean;
  /** Id en la lista del club, si coincide con alguien de ella. */
  rosterId?: number;
}

export interface Side {
  players: SidePlayer[];
  placeholder?: string;
}

/** Partido tal y como se guarda: solo partidos con al menos un jugador del club. */
export interface StoredMatch {
  key: string;
  tournamentGuid: string;
  date?: string;
  plannedClock?: string;
  /** Hora programada en UTC. No forma parte de la huella: la hora se vigila con `plannedClock`. */
  plannedUtc?: string;
  drawName: string;
  eventCode?: string;
  round?: string;
  court?: string;
  status: MatchStatus;
  winner?: 1 | 2;
  sets: [number, number][];
  scoreText?: string;
  durationMin?: number;
  sides: [Side, Side];
}

export interface EntrantLike {
  names: string[];
  ids: number[];
  club?: string;
}

export interface FoundEntrant {
  tsPlayerId: number;
  name: string;
  club?: string;
  rosterId?: number;
  uva: boolean;
}

/** Participantes del torneo que son del club (por el club publicado o por estar en la lista). */
export function findClubEntrants(entrants: EntrantLike[], roster: Player[]): FoundEntrant[] {
  const out: FoundEntrant[] = [];
  for (const e of entrants) {
    e.ids.forEach((tsPlayerId, i) => {
      const name = e.names[i];
      if (!tsPlayerId || !name) return;
      // Apellidos muy comunes tienen homónimos en otros clubes: un nombre de la lista solo vale si el club publicado
      // es el de la UVA o no se publica ninguno. Con otro club, es otra persona.
      // Un nombre oficial más corto que el de la lista (sin segundo apellido) y sin club de la UVA queda «por verificar» con el perfil oficial (ver engine.verify).
      const rostered = !e.club || isUvaClub(e.club) ? findByNameLoose(roster, name) : undefined;
      const uva = isUvaClub(e.club) || !!rostered;
      if (uva) out.push({ tsPlayerId, name, club: e.club, rosterId: rostered?.id, uva });
    });
  }
  return out;
}

/** Número de jugador en el torneo → id en la lista del club (`undefined` si es del club pero no está en la lista). */
export type ClubEntrants = Map<number, number | undefined>;

/**
 * Un jugador es del club solo si su número en el torneo figura entre los participantes verificados por el club
 * publicado (clasificaciones y cuadros). Coincidir solo en el nombre no basta: hay homónimos en otros clubes.
 */
const sideOf = (team: Team, entrants: ClubEntrants): Side => ({
  placeholder: team.placeholder,
  players: team.players.map((p) => {
    const known = p.tsPlayerId !== undefined && entrants.has(p.tsPlayerId);
    return { name: p.name, tsPlayerId: p.tsPlayerId, uva: known, rosterId: known ? entrants.get(p.tsPlayerId!) ?? undefined : undefined };
  }),
});

export function buildStoredMatch(row: MatchRow, ctx: { tournamentGuid: string; entrants: ClubEntrants }): StoredMatch | undefined {
  const sides: [Side, Side] = [sideOf(row.team1, ctx.entrants), sideOf(row.team2, ctx.entrants)];
  if (!sides.some((s) => s.players.some((p) => p.uva))) return undefined;
  return {
    key: row.key,
    tournamentGuid: ctx.tournamentGuid,
    date: row.date,
    plannedClock: row.plannedClock,
    plannedUtc: row.plannedUtc,
    drawName: row.drawName,
    eventCode: row.eventCode,
    round: row.round,
    court: row.court,
    status: row.status,
    winner: row.winner,
    sets: row.sets,
    scoreText: row.scoreText,
    durationMin: row.durationMin,
    sides,
  };
}

/** Los campos que pueden cambiar durante el torneo. Su huella decide si hay un cambio que confirmar. */
export const MUTABLE_FIELDS = ['date', 'plannedClock', 'court', 'status', 'winner', 'scoreText'] as const;

export function matchFingerprint(m: StoredMatch): string {
  const mutable = { ...Object.fromEntries(MUTABLE_FIELDS.map((f) => [f, m[f] ?? null])), sets: m.sets };
  return createHash('sha1').update(JSON.stringify(mutable)).digest('hex').slice(0, 16);
}

/** Cambios entre dos versiones de un partido, sin nombres: solo campo y valor. */
export function diffMatch(a: StoredMatch, b: StoredMatch): { field: string; old: string; new: string }[] {
  const out: { field: string; old: string; new: string }[] = [];
  for (const f of MUTABLE_FIELDS) {
    if ((a[f] ?? null) !== (b[f] ?? null)) out.push({ field: f, old: String(a[f] ?? ''), new: String(b[f] ?? '') });
  }
  if (JSON.stringify(a.sets) !== JSON.stringify(b.sets)) {
    out.push({ field: 'sets', old: a.sets.map((s) => s.join('-')).join(' '), new: b.sets.map((s) => s.join('-')).join(' ') });
  }
  return out;
}
