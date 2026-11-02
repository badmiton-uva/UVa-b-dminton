import type { LiveProgress, LiveState, Tournament, UvaMatch } from '../types';

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const sameCity = (a?: string, b?: string) => {
  const x = norm(a ?? '');
  const y = norm(b ?? '');
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

/**
 * Superpone los datos en directo del servidor sobre el calendario oficial. Se empareja por fecha de inicio y localidad;
 * si el torneo no está en el calendario absoluto, se añade como torneo propio.
 */
export function mergeLive(base: Tournament[], live: LiveState): Tournament[] {
  const out = [...base];
  for (const lt of live.tournaments) {
    const patch: Partial<Tournament> = {
      liveId: lt.id,
      players: lt.uvaPlayers,
      clubParticipants: lt.uvaPlayers.length || undefined,
      matches: lt.matches as UvaMatch[],
      progress: lt.progress,
      draws: lt.draws,
      podium: lt.results,
      record: lt.record,
      entries: lt.entries,
      checkedAt: lt.checkedAt,
      stale: lt.stale,
      officialUrl: lt.officialUrl,
    };
    const i = out.findIndex((o) => o.startDate === lt.startDate && sameCity(o.city, lt.city));
    if (i >= 0) {
      out[i] = { ...out[i], ...patch, endDate: out[i].endDate ?? lt.endDate, venue: out[i].venue ?? lt.venue };
    } else if (lt.startDate) {
      out.push({
        id: `ts-${lt.id.slice(0, 8).toLowerCase()}`,
        name: lt.name,
        startDate: lt.startDate,
        endDate: lt.endDate,
        city: lt.city ?? 'Localidad por determinar',
        venue: lt.venue,
        level: lt.level,
        externalUrl: lt.officialUrl,
        source: 'official',
        ...patch,
      });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name, 'es'));
}

export type MatchWithTournament = { tournament: Tournament; match: UvaMatch };

export const allMatches = (list: Tournament[]): MatchWithTournament[] =>
  list.flatMap((tournament) => (tournament.matches ?? []).map((match) => ({ tournament, match })));

const startOf = (m: UvaMatch) => m.estimatedStart ?? m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;

/** Partidos por situación: en juego, próximos (por hora estimada) y resultados (el más reciente primero). */
export function boardOf(matches: MatchWithTournament[]) {
  const sorted = (xs: MatchWithTournament[], dir: 1 | -1) => [...xs].sort((a, b) => dir * startOf(a.match).localeCompare(startOf(b.match)));
  return {
    live: sorted(matches.filter((x) => x.match.state === 'live'), 1),
    next: sorted(matches.filter((x) => x.match.state === 'scheduled'), 1),
    done: sorted(matches.filter((x) => x.match.state === 'finished'), -1),
  };
}

/** Torneo a mostrar en «Directo»: el que está en juego hoy; si no, el próximo; si no, el último. */
export function pickActive(list: Tournament[], today: string): Tournament | undefined {
  const withData = list.filter((t) => t.progress || (t.matches?.length ?? 0) > 0 || t.liveId);
  const end = (t: Tournament) => t.endDate ?? t.startDate;
  return (
    withData.find((t) => t.startDate <= today && today <= end(t)) ??
    withData.filter((t) => t.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ??
    [...withData].sort((a, b) => end(b).localeCompare(end(a)))[0]
  );
}

const fmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const fmtSec = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Madrid' });
export const clock = (iso: string) => fmt.format(new Date(iso));
export const clockSec = (iso: string | Date) => fmtSec.format(typeof iso === 'string' ? new Date(iso) : iso);

/** Minutos de diferencia entre la hora estimada y la programada (+ = más tarde). */
export const lateness = (m: UvaMatch): number | undefined =>
  m.estimatedStart && m.plannedStart ? Math.round((Date.parse(m.estimatedStart) - Date.parse(m.plannedStart)) / 60_000) : undefined;

export interface NextInfo {
  /** Partidos por empezar que van antes que este. */
  ahead?: number;
  /** Partidos que se están jugando ahora en el torneo. */
  inPlay?: number;
  /** Partidos que quedan por jugar hoy en el torneo (los que se juegan ahora incluidos). */
  remaining?: number;
  /** Minutos hasta que empiece (por la hora estimada; si no la hay, por la programada). */
  minutes?: number;
  plannedAt?: string;
  estimatedAt?: string;
  /** Minutos de diferencia entre la estimada y la oficial (+ = más tarde). */
  delay?: number;
}

/** Lo que se muestra del siguiente partido de la UVa: cuántos faltan, cuánto falta y las horas oficial y estimada. */
export function nextInfo(m: UvaMatch, p: LiveProgress | undefined, now: Date): NextInfo {
  const target = m.estimatedStart ?? m.plannedStart;
  const sameDay = !!p && !p.done && (!m.date || p.date === m.date);
  return {
    ahead: m.ahead,
    inPlay: sameDay ? p.live : undefined,
    remaining: sameDay ? p.remaining + p.live : undefined,
    minutes: target ? Math.max(0, Math.round((Date.parse(target) - now.getTime()) / 60_000)) : undefined,
    plannedAt: m.plannedStart,
    estimatedAt: m.estimatedStart,
    delay: lateness(m),
  };
}

/** «25 min», «1 h 05 min». */
export const spanText = (min: number): string => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`);

/** Torneos que se están jugando hoy y todavía no han terminado (se quitan solos al acabar: último día y todo terminado). */
export function liveTournaments(list: Tournament[], today: string): Tournament[] {
  return list.filter((t) => {
    const end = t.endDate ?? t.startDate;
    if (!t.liveId || t.stale || today < t.startDate || today > end) return false;
    const ms = t.matches ?? [];
    if (ms.length === 0 && !t.progress) return false;
    const over = today >= end && ((t.progress?.done && t.progress.date >= end) || (ms.length > 0 && ms.every((m) => m.state === 'finished')));
    return !over;
  });
}

export interface LiveSummary {
  tournament: Tournament;
  /** En pista ahora. */
  playing: UvaMatch[];
  /** Los siguientes pendientes de hoy, por hora estimada. */
  next: UvaMatch[];
  /** Partidos de hoy de la UVa ya terminados, ganados y perdidos. */
  finished: number;
  won: number;
  lost: number;
  /** Partidos de la UVa pendientes hoy. */
  pending: number;
}

/** Resumen de «cómo vamos» en un torneo en juego, con los partidos de la UVa de hoy. */
export function summarize(t: Tournament, today: string): LiveSummary {
  const ms = (t.matches ?? []).filter((m) => !m.date || m.date === today);
  const start = (m: UvaMatch) => m.estimatedStart ?? m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;
  const done = ms.filter((m) => m.state === 'finished');
  const scheduled = ms.filter((m) => m.state === 'scheduled').sort((a, b) => start(a).localeCompare(start(b)));
  return {
    tournament: t,
    playing: ms.filter((m) => m.state === 'live'),
    next: scheduled.slice(0, 3),
    finished: done.length,
    won: done.filter((m) => m.outcome === 'win').length,
    lost: done.filter((m) => m.outcome === 'loss').length,
    pending: scheduled.length,
  };
}

export interface PlayerSchedule {
  tournament: Tournament;
  players: { name: string; matches: UvaMatch[] }[];
}

const startKey = (m: UvaMatch) => m.estimatedStart ?? m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;

/**
 * A qué hora juega cada jugador de la UVa, torneo por torneo: los partidos de hoy en adelante (los de días ya pasados no), ordenados por hora
 * (la estimada si la hay; si no, la programada). Un torneo sin partidos de hoy en adelante no sale. Los dobles aparecen bajo cada persona del club.
 */
export function playerSchedule(list: Tournament[], today: string): PlayerSchedule[] {
  const out: PlayerSchedule[] = [];
  for (const tournament of list) {
    const upcoming = (tournament.matches ?? []).filter((m) => (m.date ?? today) >= today);
    if (upcoming.length === 0) continue;
    const byPlayer = new Map<string, UvaMatch[]>();
    for (const m of upcoming) for (const name of m.players) byPlayer.set(name, [...(byPlayer.get(name) ?? []), m]);
    out.push({
      tournament,
      players: [...byPlayer]
        .map(([name, matches]) => ({ name, matches: [...matches].sort((a, b) => startKey(a).localeCompare(startKey(b))) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    });
  }
  return out.sort((a, b) => a.tournament.startDate.localeCompare(b.tournament.startDate) || a.tournament.name.localeCompare(b.tournament.name, 'es'));
}
