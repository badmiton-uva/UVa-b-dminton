import { createHash } from 'node:crypto';
import { daysBetween, eachDay, todayIn } from './dates';
import { NoDrawsError, SourceUnavailableError } from './http';
import { settings } from './config';
import { type Db, kvGet, kvSet, nowIso } from './db';
import { intervalsFor, NEVER, priorityFor, tournamentPhase, type Phase } from './policy';
import { createPlayer, findByNameLoose, listPlayers, updatePlayer, type Player } from './roster';
import { nameTokens } from './text';
import { titleCase } from './rankingParse';
import { qualifiersPerGroup } from './lib/ts/parse/draws';
import { invalidatePublicState } from './publicView';
import { isUvaClub } from './uva';
import type { OfficialSource } from './source';
import { transformCalendar } from './calendar';
import { applyShift, currentShift } from './calibration';
import { currentPriors, currentTiming } from './patterns';

/** Hueco real aprendido y descanso entre partidos de una misma persona: el programado (10 min) es el mínimo; si los tiempos reales muestran uno mayor, manda ese. */
const learnedTimingFor = (db: Db, now: Date) => {
  const t = currentTiming(db, now);
  return { gapSample: t.gapSample, restMin: Math.max(settings.restMinutes, t.restMin) };
};
import { latestEdition, ligaEveryMs, type LigaSnapshot } from './liga';
import { defaultEstimateConfig, estimate, type Estimate, type Slot } from './estimate';
import type { MatchRow } from './model';
import { buildStoredMatch, type ClubEntrants, diffMatch, findClubEntrants, matchFingerprint, type EntrantLike, type StoredMatch } from './uva';

const DEFAULT_TZ = 'Europe/Madrid';

export type JobKind = 'roster' | 'discover' | 'info' | 'draws' | 'day' | 'calendar' | 'entries' | 'identify' | 'verify' | 'history' | 'liga';

/**
 * Reconocer a la gente del club en un torneo antes de que haya cuadros: se lee la lista de jugadores (solo nombres), se eligen los de la
 * lista del club por nombre y cada candidato se confirma con el perfil oficial que enlaza su ficha en el torneo (sin dudas con homónimos).
 */
interface IdentState { pending: { tsPlayerId: number; rosterId: number }[]; checked: Record<string, 0 | 1>; listAt?: string; listHash?: string }

/** Lectura del histórico de partidos por perfil: una persona del club por lectura, una vuelta al día. */
interface HistoryState { pending: number[]; doneAt?: string }

/** Avance de la lectura de inscritos de un torneo: una prueba por lectura, para no bloquear lo urgente. */
interface EntriesState { events: { eventId: number; name: string }[]; next: number; doneAt?: string }

/** Qué puede hacer el motor: el calendario usa solo rutas permitidas; lo «en directo» exige activarlo expresamente. */
export interface Features {
  live: boolean;
  calendar: boolean;
}
export interface Job {
  key: string;
  kind: JobKind;
  guid?: string;
  date?: string;
  phase: Phase;
  /** Cuándo toca (ms). */
  due: number;
  /** 0 = más urgente. */
  rank: number;
}

interface TournamentRow {
  guid: string; name: string; start_date: string | null; end_date: string | null; tz: string; days_json: string;
  info_ok_at: string | null; draws_ok_at: string | null; hidden: number;
}

/** Jugador de la lista cuyo nombre (p. ej. «Pablo Martín») está contenido en el del ranking («Pablo Martín Castañeda»). */
const matchRoster = (roster: Player[], rankingName: string): Player | undefined => {
  const full = new Set(nameTokens(rankingName));
  return roster.find((p) => {
    const t = nameTokens(p.name);
    return t.length >= 2 && t.every((x) => full.has(x));
  });
};

/** ¿Es una persona de HIDDEN_PLAYERS? Compara nombres completos o abreviados («Clara Campos» = «Clara Campos Alfaro»), en cualquier sentido. */
const isHidden = (name: string): boolean => {
  const t = new Set(nameTokens(name));
  return settings.hiddenPlayers.some((h) => {
    const ht = nameTokens(h);
    return ht.length >= 2 && (ht.every((x) => t.has(x)) || [...t].length >= 2 && [...t].every((x) => ht.includes(x)));
  });
};

const ms = (iso?: string | null) => (iso ? Date.parse(iso) : 0);

/**
 * Motor de sincronización. Cada «tick» (5 s) decide, según la fase de cada torneo, qué toca leer y ejecuta
 * como máximo UNA lectura lógica. Lee una vez por torneo (no una por jugador) y solo guarda partidos con
 * jugadores del club. Si la fuente falla se conservan los últimos datos; nunca se inventa nada.
 */
export class SyncEngine {
  private retry = new Map<string, { until: number; n: number }>();
  private pausedUntil = 0;
  /** Última actividad, para el panel de administración. */
  lastJob?: { key: string; at: string; ok: boolean; error?: string };

  constructor(
    private db: Db,
    private src: OfficialSource,
    private clock: () => Date = () => new Date(),
    private features: Features = { live: true, calendar: false },
  ) {}

  /* ---------------------------------------------------------------- */
  /* Planificación                                                     */
  /* ---------------------------------------------------------------- */

  plan(now = this.clock()): Job[] {
    const jobs: Job[] = [];
    const nowMs = now.getTime();
    const today = todayIn(DEFAULT_TZ, now);

    if (this.features.calendar) {
      const lastCal = ms(kvGet<{ at: string }>(this.db, 'calendar_ok')?.at);
      jobs.push({ key: 'calendar', kind: 'calendar', phase: 'far', due: lastCal + settings.calendarHours * 3600_000, rank: 5 });
    }
    if (!this.features.live) return this.due(jobs, nowMs);

    if (this.src.rankingPlayers && settings.rankingUrls.length > 0) {
      const last = ms(kvGet<{ at: string }>(this.db, 'roster_ok')?.at);
      jobs.push({ key: 'roster', kind: 'roster', phase: 'far', due: last + settings.autoRosterHours * 3600_000, rank: 3 });
    }
    const rostered = listPlayers(this.db).filter((p) => p.profileGuid);
    if (rostered.length > 0) {
      const last = ms(kvGet<{ at: string }>(this.db, 'discover_ok')?.at);
      jobs.push({ key: 'discover', kind: 'discover', phase: 'far', due: last + settings.intervals.discovery, rank: 4 });
    }

    // Liga Nacional de Clubes (división que sigue el club): clasificación y encuentros, con más frecuencia en jornada.
    if (this.src.leagueDraw && this.src.leagueEditions && settings.liga.enabled) {
      const snap = kvGet<LigaSnapshot>(this.db, 'liga');
      jobs.push({ key: 'liga', kind: 'liga', phase: 'far', due: snap ? ms(snap.updatedAt) + ligaEveryMs(snap, new Date(nowMs)) : 0, rank: snap ? 6 : 2 }); // la primera lectura va pronto: sin ella la página está vacía
    }

    // Histórico de partidos de las personas del club (perfil oficial): una persona por lectura, una vuelta al día, solo con lo urgente atendido.
    if (this.src.profileMatches && settings.historyEnabled && rostered.some((p) => p.public)) {
      const st = kvGet<HistoryState>(this.db, 'history');
      jobs.push({ key: 'history', kind: 'history', phase: 'far', due: st && st.pending.length > 0 ? 0 : st?.doneAt ? ms(st.doneAt) + 24 * 3600_000 : 0, rank: 7 });
    }

    const rows = this.db.prepare('select * from tournaments where hidden = 0 and manual = 0').all() as unknown as TournamentRow[];
    // Asociaciones por nombre corto pendientes de verificar con el perfil oficial: los torneos en juego o próximos, primero.
    if (this.src.playerProfile) {
      const sus = new Set(this.suspectEntrants(listPlayers(this.db)).map((r) => r.g));
      for (const t of rows) {
        if (!sus.has(t.guid)) continue;
        const ph = tournamentPhase({ startDate: t.start_date, endDate: t.end_date }, today);
        jobs.push({ key: `verify:${t.guid}`, kind: 'verify', guid: t.guid, phase: ph, due: 0, rank: ph === 'past' ? 5 : 2 });
      }
    }
    // Los torneos ya terminados solo se leen (una vez, para la trayectoria) cuando no hay ninguno en juego, para no retrasar lo urgente.
    // Solo un torneo en juego lo retrasa: las noticias y la gráfica se rehacen enseguida tras un reinicio, empezando por el torneo terminado más reciente.
    const quiet = !rows.some((t) => tournamentPhase({ startDate: t.start_date, endDate: t.end_date }, today) === 'live');
    const backfillAt = ms(kvGet<{ at: string }>(this.db, 'backfill_at')?.at);
    for (const t of rows) {
      if (t.name && settings.excludedTournaments.test(t.name)) {
        this.db.prepare('update tournaments set hidden = 1 where guid = ?').run(t.guid);
        continue;
      }
      const phase = tournamentPhase({ startDate: t.start_date, endDate: t.end_date }, today);
      // Lo más cercano primero: tras un reinicio, los torneos de esta semana se leen antes que el resto.
      const soonDays = t.start_date ? daysBetween(today, t.start_date) : 99;
      // Torneo con gente del club en los próximos días: el orden de juego se publica con antelación, así que se lee pronto y a menudo.
      const nearLinked =
        (phase === 'soon' || phase === 'imminent') && soonDays <= settings.intervals.dayLookaheadDays &&
        ((this.db.prepare('select count(*) n from tournament_players where tournament_guid = ?').get(t.guid) as unknown as { n: number }).n > 0);
      const iv = nearLinked ? { ...intervalsFor(phase), ...(phase === 'imminent' ? settings.intervals.nearImminent : settings.intervals.near) } : intervalsFor(phase);
      const infoDue = t.info_ok_at ? ms(t.info_ok_at) + iv.info : 0;
      // Sin información básica (fechas) no se sabe en qué fase está: se lee ya.
      jobs.push({ key: `info:${t.guid}`, kind: 'info', guid: t.guid, phase, due: infoDue, rank: phase === 'live' ? 2 : 3 });
      if (!t.info_ok_at) continue;
      if (phase === 'past') {
        // Torneos recientes marcados para reconstruir (tras una limpieza errónea que borró partidos): se leen sus días una vez.
        if (quiet && t.start_date && daysBetween(t.start_date, today) <= 30 && kvGet(this.db, `needs-rebuild:${t.guid}`) && (this.db.prepare('select count(*) n from tournament_players where tournament_guid = ?').get(t.guid) as unknown as { n: number }).n > 0) {
          for (const date of JSON.parse(t.days_json) as string[]) {
            if (kvGet(this.db, `rebuilt:${t.guid}:${date}`)) continue;
            jobs.push({ key: `day:${t.guid}:${date}`, kind: 'day', guid: t.guid, date, phase, due: 0, rank: 6.5 });
          }
        }
        if (!t.draws_ok_at && quiet && settings.backfillDays > 0 && t.start_date && daysBetween(t.start_date, today) <= settings.backfillDays) {
          jobs.push({ key: `draws:${t.guid}`, kind: 'draws', guid: t.guid, phase, due: backfillAt + 2 * 60_000, rank: 6 + daysBetween(t.start_date, today) / 1000 });
        }
        continue;
      }
      // La primera lectura de cuadros va antes que el orden de juego: de ahí sale quién es del club.
      const hasDraws = (this.db.prepare('select count(*) n from draws where tournament_guid = ?').get(t.guid) as unknown as { n: number }).n > 0;
      const linked = (this.db.prepare('select count(*) n from tournament_players where tournament_guid = ?').get(t.guid) as unknown as { n: number }).n > 0;
      // Torneos seguidos solo por el calendario (aún sin nadie del club identificado): se revisan cada pocas horas.
      const drawsEvery = !linked && (phase === 'far' || phase === 'soon') ? Math.max(iv.draws, settings.followRefreshMinutes) : iv.draws;
      // Sin cuadros publicados todavía (torneo futuro): se vuelve a mirar cada 2 h (cada 30 min el día antes), sin contarlo como error.
      const noDrawsAt = !hasDraws ? ms(kvGet<{ at: string }>(this.db, `nodraws:${t.guid}`)?.at) : 0;
      const noDrawsEvery = phase === 'imminent' || nearLinked ? 30 * 60_000 : 120 * 60_000;
      jobs.push({ key: `draws:${t.guid}`, kind: 'draws', guid: t.guid, phase, due: noDrawsAt ? noDrawsAt + noDrawsEvery : t.draws_ok_at && hasDraws ? ms(t.draws_ok_at) + drawsEvery : 0, rank: !t.draws_ok_at ? (soonDays <= 7 ? -3 : -1) : phase === 'live' ? 1 : 3 });

      // Torneos de los próximos días (30 por defecto): ¿hay inscrita gente del club? Se mira la lista de jugadores aunque aún no haya cuadros.
      if (this.src.tournamentPlayers && this.src.playerProfile && settings.followCalendarDays > 0 && (phase === 'far' || phase === 'soon' || phase === 'imminent') && soonDays <= settings.followCalendarDays) {
        const st = kvGet<IdentState>(this.db, `identify:${t.guid}`);
        const every = settings.watchListMinutes[phase] * 60_000;
        jobs.push({ key: `identify:${t.guid}`, kind: 'identify', guid: t.guid, phase, due: st && st.pending.length > 0 ? 0 : st?.listAt ? ms(st.listAt) + every : 0, rank: 4 });
      }

      // Inscripción y admisión de la gente del club en torneos futuros (listas de cada prueba), una prueba por lectura.
      if (linked && this.src.events && this.src.eventEntries && (phase === 'far' || phase === 'soon' || phase === 'imminent') && soonDays <= settings.entries.days) {
        const st = kvGet<EntriesState>(this.db, `entries:${t.guid}`);
        const every = nearLinked ? Math.min(settings.entries[phase], 30 * 60_000) : settings.entries[phase];
        const inCycle = !!st && st.next < st.events.length;
        jobs.push({ key: `entries:${t.guid}`, kind: 'entries', guid: t.guid, phase, due: inCycle ? 0 : st?.doneAt ? ms(st.doneAt) + every : 0, rank: 4 });
      }

      if (phase === 'live' || phase === 'recent' || phase === 'imminent' || phase === 'soon') {
        const days: string[] = JSON.parse(t.days_json);
        const wanted =
          phase === 'live' ? days.filter((d) => d === today || daysBetween(today, d) === 1) // y el día siguiente (másters de sábado y domingo): su orden de juego sale el día anterior
          : phase === 'soon' ? days.filter((d) => daysBetween(today, d) <= (nearLinked ? settings.intervals.dayLookaheadDays : 3)) // sin gente del club, a más de 3 días aún no se busca el orden de juego
          : days;
        for (const date of wanted) {
          const k = `day:${t.guid}:${date}`;
          const lastOk = ms(kvGet<{ at: string }>(this.db, `ok:${k}`)?.at);
          jobs.push({ key: k, kind: 'day', guid: t.guid, date, phase, due: lastOk ? lastOk + (phase === 'live' && date !== today ? Math.max(iv.day, 10 * 60_000) : iv.day) : 0, rank: phase === 'live' ? (date === today ? 0 : 1) : phase === 'recent' ? 2 : 1 });
        }
      }
    }

    return this.due(jobs, nowMs);
  }

  /**
   * Trabajos adelantados porque se ha detectado un cambio en badminton.es (un partido terminado, una lista de inscritos nueva...).
   * badminton.es no avisa de sus cambios, así que el servidor los detecta con las lecturas baratas que ya hace y, al verlos,
   * adelanta de inmediato la lectura de lo que depende de ello en vez de esperar a su turno.
   */
  private kicked = new Map<string, number>();

  /** Pide leer `key` cuanto antes, pero no antes de que pasen `minGap` desde su última lectura (para no machacar la web oficial). */
  kick(key: string, now: Date, minGap = settings.kickMinGapMs) {
    const [kind, guid] = key.split(':');
    const col = kind === 'draws' ? 'draws_ok_at' : kind === 'info' ? 'info_ok_at' : undefined;
    const last = col ? (this.db.prepare(`select ${col} v from tournaments where guid = ?`).get(guid) as unknown as { v: string | null } | undefined)?.v : undefined;
    const at = col ? ms(last) : kind === 'entries' ? ms(kvGet<EntriesState>(this.db, key)?.doneAt) : kind === 'day' ? ms(kvGet<{ at: string }>(this.db, `ok:${key}`)?.at) : 0;
    const when = Math.max(now.getTime(), at + minGap);
    this.kicked.set(key, Math.min(when, this.kicked.get(key) ?? when));
  }

  private due(jobs: Job[], nowMs: number): Job[] {
    return jobs
      .filter((j) => Number.isFinite(j.due) && (j.due <= nowMs || (this.kicked.get(j.key) ?? Infinity) <= nowMs) && (this.retry.get(j.key)?.until ?? 0) <= nowMs)
      .sort((a, b) => a.rank - b.rank || a.due - b.due);
  }

  private relinked = false;

  /**
   * Vuelve a asociar a los participantes ya guardados con la lista del club (por si la lista cambió o el nombre corto del torneo
   * no coincidía con el completo) y completa el identificador en los partidos guardados. No hace peticiones.
   */
  /**
   * Participantes asociados a una persona de la lista SOLO por el nombre, con un nombre oficial más corto que el de la lista (sin segundo apellido:
   * «Javier Gonzalez» frente a «Javier Gonzalez Martin») y sin club de la UVA: pueden ser un homónimo de otro club. Los que ya se verificaron no salen.
   */
  private suspectEntrants(roster: Player[]) {
    const rows = this.db.prepare('select tournament_guid g, ts_player_id id, name, club, player_id pid from entrants where player_id is not null').all() as unknown as { g: string; id: number; name: string; club: string | null; pid: number }[];
    return rows.filter((r) => {
      if (isUvaClub(r.club)) return false;
      const pl = roster.find((x) => x.id === r.pid);
      if (!pl || findByNameLoose([pl], r.name, { shorterOk: false })) return false; // nombre completo (o más largo): sin duda
      return kvGet(this.db, `verified:${r.g}:${r.id}`) === undefined;
    });
  }

  /** Retira de un torneo la asociación de un participante con una persona de la lista: su vínculo, sus partidos y sus inscripciones. */
  private unlinkEntrant(guid: string, tsPlayerId: number, rosterId: number) {
    this.db.prepare('update entrants set player_id = null where tournament_guid = ? and ts_player_id = ?').run(guid, tsPlayerId);
    if (!this.db.prepare('select 1 x from entrants where tournament_guid = ? and player_id = ?').get(guid, rosterId)) {
      this.db.prepare('delete from tournament_players where tournament_guid = ? and player_id = ?').run(guid, rosterId);
      this.db.prepare('delete from entries where tournament_guid = ? and player_id = ?').run(guid, rosterId);
    }
    for (const m of this.db.prepare('select key, json from matches where tournament_guid = ?').all(guid) as unknown as { key: string; json: string }[]) {
      const stored = JSON.parse(m.json) as StoredMatch;
      if (stored.sides.some((s) => s.players.some((p) => p.tsPlayerId === tsPlayerId && p.uva))) this.db.prepare('delete from matches where key = ?').run(m.key);
    }
    invalidatePublicState(this.db);
  }

  /**
   * Comprueba con el PERFIL OFICIAL (el que enlaza su ficha en el torneo) si un participante asociado por nombre corto es de verdad la persona de la
   * lista. Si el perfil es otro, es un homónimo y se retira. Si no se puede comprobar (la persona no tiene perfil enlazado o la ficha no lo muestra), se deja.
   */
  private async verify(job: Job, now: Date) {
    const guid = job.guid!;
    const roster = listPlayers(this.db);
    const next = this.suspectEntrants(roster).find((r) => r.g === guid);
    if (!next) return;
    const pl = roster.find((x) => x.id === next.pid)!;
    const found = await this.src.playerProfile!(guid, next.id, priorityFor(job.phase, 'discover'));
    const decisive = !!found && !!pl.profileGuid;
    const same = !decisive || found!.toUpperCase() === pl.profileGuid!.toUpperCase();
    kvSet(this.db, `verified:${guid}:${next.id}`, { ok: same, decisive, at: now.toISOString() });
    if (!same) this.unlinkEntrant(guid, next.id, pl.id);
  }

  relinkEntrants() {
    const roster = listPlayers(this.db);
    const link = this.db.prepare('insert or ignore into tournament_players(tournament_guid, player_id) values(?, ?)');
    const rows = this.db.prepare('select tournament_guid g, ts_player_id id, name, club, player_id pid from entrants').all() as unknown as { g: string; id: number; name: string; club: string | null; pid: number | null }[];
    const set = this.db.prepare('update entrants set player_id = ? where tournament_guid = ? and ts_player_id = ?');
    // Primera pasada tras la limpieza errónea del 05/11/2026: lo que se vuelve a asociar en torneos ya terminados necesita releer sus días (se borraron sus partidos).
    const first = !kvGet(this.db, 'migrated-rebuild-1');
    for (const r of rows) {
      if (r.pid || (r.club && !isUvaClub(r.club))) continue;
      if (kvGet<{ ok: boolean }>(this.db, `verified:${r.g}:${r.id}`)?.ok === false) continue; // el perfil oficial demostró que es un homónimo
      const p = findByNameLoose(roster, r.name);
      if (!p) continue;
      set.run(p.id, r.g, r.id);
      link.run(r.g, p.id);
      if (first) kvSet(this.db, `needs-rebuild:${r.g}`, { at: nowIso() });
    }
    if (first) kvSet(this.db, 'migrated-rebuild-1', { at: nowIso() });
    const byTournament = new Map<string, Map<number, number>>();
    for (const r of this.db.prepare('select tournament_guid g, ts_player_id id, player_id pid from entrants where player_id is not null').all() as unknown as { g: string; id: number; pid: number }[]) {
      (byTournament.get(r.g) ?? byTournament.set(r.g, new Map()).get(r.g)!).set(r.id, r.pid);
    }
    const upd = this.db.prepare('update matches set json = ? where key = ?');
    for (const [g, map] of byTournament) {
      for (const m of this.db.prepare('select key, json from matches where tournament_guid = ?').all(g) as unknown as { key: string; json: string }[]) {
        const stored = JSON.parse(m.json) as StoredMatch;
        let changed = false;
        for (const side of stored.sides) for (const pl of side.players) {
          const pid = pl.tsPlayerId !== undefined ? map.get(pl.tsPlayerId) : undefined;
          if (pl.uva && pl.rosterId === undefined && pid !== undefined) { pl.rosterId = pid; changed = true; }
        }
        if (changed) upd.run(JSON.stringify(stored), m.key);
      }
    }
  }

  /** Estado interno para diagnóstico (sin datos personales). */
  diagnose(now = this.clock()) {
    const http = (this.src as unknown as { http?: { stats?: () => unknown } }).http?.stats?.();
    return {
      next: this.plan(now).slice(0, 3).map((j) => ({ job: j.kind, rank: j.rank })),
      pausedUntil: this.pausedUntil > now.getTime() ? new Date(this.pausedUntil).toISOString() : null,
      retrying: [...this.retry.entries()].map(([k, v]) => ({ job: k.split(':')[0], n: v.n, until: new Date(v.until).toISOString() })),
      http,
      tournaments: (this.db.prepare('select substr(name,1,40) n, start_date d, info_ok_at i, draws_ok_at dr, last_error e, (select count(*) from draws x where x.tournament_guid = t.guid) c, (select coalesce(sum(length(json)),0) from draws x where x.tournament_guid = t.guid) jl, (select count(*) from entrants x where x.tournament_guid = t.guid) en, (select count(*) from matches x where x.tournament_guid = t.guid) pm from tournaments t where hidden = 0 order by start_date').all() as unknown as Record<string, unknown>[]),
    };
  }

  /** Ejecuta, como máximo, una lectura. Devuelve la clave del trabajo ejecutado. */
  async tick(now = this.clock()): Promise<string | undefined> {
    if (now.getTime() < this.pausedUntil) return undefined;
    if (!this.relinked) {
      this.relinked = true;
      try {
        this.enforceHidden();
        this.relinkEntrants();
        // Las estimaciones guardadas pueden venir de una versión anterior: se recalculan con lo ya guardado (sin peticiones).
        for (const r of this.db.prepare('select distinct tournament_guid g, date d from slots where date >= ? order by date').all(todayIn(DEFAULT_TZ, new Date(now.getTime() - 10 * 86_400_000))) as unknown as { g: string; d: string }[]) this.recomputeEstimate(r.g, r.d, now); // por fecha: la guardada de cada torneo es la del último día
      } catch (e) {
        console.error('relinkEntrants', e);
      }
    }
    this.sweepEstimates(now);
    const job = this.plan(now)[0];
    if (!job) return undefined;
    this.kicked.delete(job.key);
    try {
      await this.run(job, now);
      invalidatePublicState(this.db);
      this.retry.delete(job.key);
      this.lastJob = { key: job.key, at: nowIso(), ok: true };
    } catch (e) {
      const err = e as Error;
      if (e instanceof SourceUnavailableError) {
        this.pausedUntil = e.retryAt ?? now.getTime() + 5 * 60_000;
      } else {
        const n = (this.retry.get(job.key)?.n ?? 0) + 1;
        this.retry.set(job.key, { n, until: now.getTime() + Math.min(60 * 60_000, 60_000 * 2 ** n) });
      }
      if (job.guid) {
        this.db.prepare('update tournaments set last_error = ?, last_error_at = ? where guid = ?').run(err.message, nowIso(), job.guid);
      }
      kvSet(this.db, 'last_error', { at: nowIso(), job: job.key, message: err.message });
      this.lastJob = { key: job.key, at: nowIso(), ok: false, error: err.message };
    }
    return job.key;
  }

  private async run(job: Job, now: Date) {
    switch (job.kind) {
      case 'roster':
        return this.buildRoster(now);
      case 'discover':
        return this.discover(now);
      case 'info':
        return this.readInfo(job, now);
      case 'draws':
        return this.readDraws(job, now);
      case 'day':
        return this.readDay(job, now);
      case 'calendar':
        return this.readCalendar(now);
      case 'entries':
        return this.readEntries(job, now);
      case 'identify':
        return this.identify(job, now);
      case 'verify':
        return this.verify(job, now);
      case 'history':
        return this.readHistory(now);
      case 'liga':
        return this.readLiga(now);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Trabajos                                                          */
  /* ---------------------------------------------------------------- */

  /** Oculta (y retira los avisos de) las personas de HIDDEN_PLAYERS: sin consentimiento no se publica nada suyo. */
  private enforceHidden() {
    for (const p of listPlayers(this.db)) {
      if (p.public && isHidden(p.name)) updatePlayer(this.db, p.id, { public: false, consentBy: null, consentAt: null });
    }
  }

  /**
   * Construye la lista del club sola: lee las categorías del ranking oficial, se queda con quienes figuran con el club de la UVa
   * y busca el enlace de su perfil. Quien ya está en la lista no se duplica. Los menores nunca se publican sin consentimiento familiar.
   */
  private async buildRoster(now: Date) {
    const found = new Map<string, { name: string; playerPath: string; birthYear?: number }>();
    for (const url of settings.rankingUrls) {
      for (const c of await this.src.rankingPlayers!(url, 2)) if (isUvaClub(c.club)) found.set(c.playerPath, c);
    }
    const today = now.toISOString().slice(0, 10);
    let created = 0;
    for (const c of found.values()) {
      const name = titleCase(c.name);
      const roster = listPlayers(this.db);
      const known = matchRoster(roster, name);
      if (known?.profileGuid) continue;
      const profile = await this.src.rankingProfile!(c.playerPath, 2);
      if (known) {
        if (profile) updatePlayer(this.db, known.id, { profile });
        continue;
      }
      const age = c.birthYear === undefined ? undefined : Number(today.slice(0, 4)) - c.birthYear;
      const isMinor = age !== undefined && age < 18;
      // Sin año de nacimiento no se puede descartar que sea menor: queda oculto hasta que la administración lo revise.
      const publish = settings.autoRosterConsent === 'declared' && age !== undefined && !isMinor && !isHidden(name);
      createPlayer(this.db, {
        name,
        profile: profile ?? null,
        isMinor,
        public: publish,
        consentBy: publish ? 'Declarado por la administración del club' : null,
        consentAt: publish ? today : null,
        notes: 'Añadido automáticamente desde el ranking oficial',
      });
      created++;
    }
    kvSet(this.db, 'roster_ok', { at: now.toISOString(), found: found.size, created });
    this.relinkEntrants();
  }

  /** Torneos de cada jugador de la lista, desde su perfil oficial. */
  private async discover(now: Date) {
    for (const p of listPlayers(this.db).filter((x) => x.profileGuid)) {
      const { tournamentIds } = await this.src.profile(p.profileGuid!, 2);
      for (const guid of tournamentIds) this.track(guid.toUpperCase(), p.id, now);
    }
    kvSet(this.db, 'discover_ok', { at: now.toISOString() });
  }

  /** Empieza a seguir un torneo (descubierto o añadido por el administrador) y lo vincula con un jugador. */
  track(guid: string, playerId: number | undefined, now = this.clock()) {
    this.db.prepare('insert or ignore into tournaments(guid, name, discovered_at) values(?, ?, ?)').run(guid, guid, now.toISOString());
    if (playerId) this.db.prepare('insert or ignore into tournament_players(tournament_guid, player_id) values(?, ?)').run(guid, playerId);
  }

  private async readInfo(job: Job, now: Date) {
    const info = await this.src.tournament(job.guid!, priorityFor(job.phase, 'info'));
    const days = info.days.length ? info.days : info.startDate ? eachDay(info.startDate, info.endDate ?? info.startDate) : [];
    const before = this.db.prepare('select days_json, start_date, info_ok_at from tournaments where guid = ?').get(job.guid!) as unknown as { days_json: string; start_date: string | null; info_ok_at: string | null } | undefined;
    this.db
      .prepare(
        `update tournaments set name=?, start_date=?, end_date=?, city=?, venue=?, level=?, tz=?, days_json=?, info_ok_at=?, last_error=null where guid=?`,
      )
      .run(info.name, info.startDate ?? null, info.endDate ?? info.startDate ?? null, info.city ?? null, info.venue ?? null, info.level ?? null, info.tz || DEFAULT_TZ, JSON.stringify(days), now.toISOString(), job.guid!);
    // Si el torneo cambia de fechas o publica nuevas jornadas, se vuelven a leer ya los cuadros y las inscripciones.
    if (before?.info_ok_at && (before.days_json !== JSON.stringify(days) || before.start_date !== (info.startDate ?? null))) {
      this.kick(`draws:${job.guid}`, now);
      this.kick(`entries:${job.guid}`, now);
    }
  }

  /**
   * Cuadros del torneo: grupos (clasificación y partidos) y cuadros finales. De ellos sale quién es del club y lo que se muestra.
   * La primera lectura (y una completa cada pocas horas) recorre todos; entre medias solo se actualizan los cuadros donde
   * juega alguien del club y los cuadros finales de esas pruebas, que son los que cambian y los que se publican.
   */
  private async readDraws(job: Job, now: Date) {
    const guid = job.guid!;
    const p = priorityFor(job.phase, 'draws');
    const roster = listPlayers(this.db);
    const entrants: EntrantLike[] = [];
    const save = this.db.prepare(
      `insert into draws(tournament_guid, draw_id, name, type, json, updated_at, has_club) values(?,?,?,?,?,?,?)
       on conflict(tournament_guid, draw_id) do update set name=excluded.name, type=excluded.type, json=excluded.json, updated_at=excluded.updated_at, has_club=excluded.has_club`,
    );
    const waiting = job.phase === 'far' || job.phase === 'soon' || job.phase === 'imminent';
    const past = job.phase === 'past';
    if (past) kvSet(this.db, 'backfill_at', { at: now.toISOString() }); // una lectura histórica cada 2 min como mucho: tras un reinicio las noticias vuelven en minutos
    let drawList: Awaited<ReturnType<OfficialSource['draws']>> = [];
    try {
      drawList = await this.src.draws(guid, p);
    } catch (e) {
      if (!(e instanceof NoDrawsError) || !(waiting || past)) throw e;
    }
    // Torneo pasado sin cuadros: no hay nada que recuperar. Se da por leído para no volver a intentarlo.
    if (drawList.length === 0 && past) {
      this.db.prepare('update tournaments set draws_ok_at = ?, last_error = null where guid = ?').run(now.toISOString(), guid);
      return;
    }
    // Torneo aún sin cuadros publicados: no es un fallo. Se anota y se vuelve a mirar más tarde (ver plan), sin reintentos con espera creciente.
    if (drawList.length === 0 && waiting) {
      kvSet(this.db, `nodraws:${guid}`, { at: now.toISOString() });
      this.db.prepare('update tournaments set last_error = null where guid = ?').run(guid);
      return;
    }
    // En un torneo en curso o recién terminado, una lista vacía sí es un fallo: la fuente devolvió otra página. Se reintenta con espera creciente.
    if (drawList.length === 0) throw new Error('La lista de cuadros llegó vacía (sin publicar o página inesperada).'); // (las fuentes reales ya lanzan un error con detalle)
    this.db.prepare("delete from kv where k = ?").run(`nodraws:${guid}`);

    const stored = new Map(
      (this.db.prepare('select draw_id, name, type, json, has_club from draws where tournament_guid = ?').all(guid) as unknown as { draw_id: number; name: string; type: string; json: string; has_club: number }[]).map((r) => [r.draw_id, r]),
    );
    const fullKey = `draws_full:${guid}`;
    const fullAt = ms(kvGet<{ at: string }>(this.db, fullKey)?.at);
    const full = stored.size === 0 || now.getTime() - fullAt >= settings.intervals.drawsFull;
    const baseOf = (name: string) => name.match(/^(.*?)\s+-\s+(?:Grupo|Group)\s+\S+$/i)?.[1] ?? name;
    const clubBases = new Set([...stored.values()].filter((r) => r.has_club).map((r) => baseOf(r.name)));

    for (const d of drawList) {
      const prev = stored.get(d.drawId);
      const wanted = full || !prev || (prev.has_club ? true : d.type === 'knockout' && clubBases.has(baseOf(d.name)));
      if (!wanted) continue;
      if (d.type === 'roundrobin') {
        const rows = await this.src.standings(guid, d.drawId, p);
        const here: EntrantLike[] = rows.map((r) => ({ names: r.names, ids: r.ids, club: r.club }));
        entrants.push(...here);
        const hasClub = findClubEntrants(here, roster).length > 0;
        // Los partidos del grupo solo se piden si hay alguien del club (lo único que se publica).
        const rounds = hasClub ? await this.src.bracket(guid, d.drawId, p) : undefined;
        save.run(guid, d.drawId, d.name, d.type, JSON.stringify({ standings: rows, ...(rounds ? { rounds } : {}) }), now.toISOString(), +hasClub);
      } else {
        const rounds = await this.src.bracket(guid, d.drawId, p);
        const here: EntrantLike[] = rounds.flatMap((round) => round.matches.flatMap((m) => [m.a, m.b].map((e) => ({ names: e.names, ids: e.ids, club: e.club }))));
        entrants.push(...here);
        const hasClub = findClubEntrants(here, roster).length > 0;
        // Cuántos de cada grupo pasan al cuadro, según las plazas «Grupo A #1»; se recuerda cuando ya hay nombres en su lugar.
        const found = qualifiersPerGroup(rounds);
        const before = prev ? (JSON.parse(prev.json) as { qualifiers?: Record<string, number> }).qualifiers : undefined;
        const qualifiers = Object.keys(found).length > 0 ? found : before;
        save.run(guid, d.drawId, d.name, d.type, JSON.stringify({ rounds, ...(qualifiers ? { qualifiers } : {}) }), now.toISOString(), +hasClub);
      }
    }
    // Los cuadros que ya no figuran en la lista oficial se retiran.
    const ids = new Set(drawList.map((d) => d.drawId));
    for (const id of stored.keys()) if (!ids.has(id)) this.db.prepare('delete from draws where tournament_guid = ? and draw_id = ?').run(guid, id);
    if (full) kvSet(this.db, fullKey, { at: now.toISOString() });
    this.saveEntrants(guid, entrants, roster, now);
    this.db.prepare('update tournaments set draws_ok_at = ?, last_error = null where guid = ?').run(now.toISOString(), guid);
  }

  /** Reconoce a la gente del club entre los jugadores inscritos de un torneo (una lectura por tick). Ver `IdentState`. */
  private async identify(job: Job, now: Date) {
    const guid = job.guid!;
    const key = `identify:${guid}`;
    const p = priorityFor(job.phase, 'discover');
    const st = kvGet<IdentState>(this.db, key) ?? { pending: [], checked: {} };
    const roster = listPlayers(this.db).filter((x) => x.profileGuid);
    if (st.pending.length === 0) {
      const list = await this.src.tournamentPlayers!(guid, p);
      // Huella de la lista de jugadores: si cambia (nuevas inscripciones o bajas), se vuelven a leer ya las listas de cada prueba.
      const listHash = createHash('sha1').update(list.map((e) => `${e.tsPlayerId}|${e.name}`).sort().join('\n')).digest('hex');
      if (st.listHash && st.listHash !== listHash) this.kick(`entries:${guid}`, now);
      const pending: IdentState['pending'] = [];
      for (const e of list) {
        if (String(e.tsPlayerId) in st.checked) continue;
        for (const pl of roster) if (findByNameLoose([pl], e.name)) pending.push({ tsPlayerId: e.tsPlayerId, rosterId: pl.id });
      }
      kvSet(this.db, key, { pending, checked: st.checked, listAt: now.toISOString(), listHash } satisfies IdentState);
      return;
    }
    const [next, ...rest] = st.pending;
    const found = await this.src.playerProfile!(guid, next.tsPlayerId, p);
    const pl = roster.find((x) => x.id === next.rosterId);
    const same = !!found && !!pl?.profileGuid && found.toUpperCase() === pl.profileGuid.toUpperCase();
    if (same && pl) {
      this.db.prepare('insert or ignore into tournament_players(tournament_guid, player_id) values(?, ?)').run(guid, pl.id);
      this.db
        .prepare(`insert into entrants(tournament_guid, ts_player_id, name, club, player_id, seen_at) values(?,?,?,?,?,?)
                  on conflict(tournament_guid, ts_player_id) do update set player_id=excluded.player_id, seen_at=excluded.seen_at`)
        .run(guid, next.tsPlayerId, pl.name, null, pl.id, now.toISOString());
    }
    kvSet(this.db, key, { pending: rest, checked: { ...st.checked, [String(next.tsPlayerId)]: same ? 1 : 0 }, listAt: st.listAt, listHash: st.listHash } satisfies IdentState);
  }

  /** Liga: busca la última edición y la división (una vez al día) y lee su clasificación y todos sus encuentros. */
  private async readLiga(now: Date) {
    const prev = kvGet<LigaSnapshot>(this.db, 'liga');
    let { tournamentId, drawId, edition, division, resolvedAt } = prev ?? ({} as Partial<LigaSnapshot>);
    const live = new Date(now).getTime();
    if (!tournamentId || !drawId || !resolvedAt || live - ms(resolvedAt) > 24 * 3600_000 || (settings.liga.tournamentId && settings.liga.tournamentId !== tournamentId)) {
      const id = settings.liga.tournamentId || latestEdition(await this.src.leagueEditions!(2))?.id;
      if (!id) throw new Error('No se encuentra la edición de la Liga en el buscador de badminton.es.');
      const draw = (await this.src.draws(id, 2)).find((d) => d.type === 'roundrobin' && settings.liga.division.test(d.name));
      if (!draw) throw new Error('La edición de la Liga aún no publica la división seguida.');
      tournamentId = id;
      drawId = draw.drawId;
      division = draw.name.replace(/^Liga Nacional de Clubes\s*[–-]\s*/i, '').trim();
      edition = (await this.src.tournament(id, 2)).name;
      resolvedAt = now.toISOString();
    }
    const today = todayIn(DEFAULT_TZ, now);
    const data = await this.src.leagueDraw!(tournamentId, drawId, ligaEveryMs(prev, now) <= 5 * 60_000 && prev?.fixtures.some((f) => f.date === today) ? 1 : 2);
    if (data.standings.length === 0 && data.fixtures.length === 0) throw new Error('La página de la Liga llegó sin clasificación ni encuentros.');
    kvSet(this.db, 'liga', { tournamentId, edition: edition!, division: division!, drawId, resolvedAt, updatedAt: now.toISOString(), standings: data.standings, fixtures: data.fixtures } satisfies LigaSnapshot);
  }

  /** Partidos terminados del perfil oficial de cada persona pública del club: de ahí salen los partidos ganados por mes y torneo. */
  private async readHistory(now: Date) {
    const st = kvGet<HistoryState>(this.db, 'history') ?? { pending: [] };
    const roster = listPlayers(this.db).filter((p) => p.public && p.profileGuid);
    const pending = st.pending.length > 0 ? st.pending : roster.map((p) => p.id);
    const [id, ...rest] = pending;
    const pl = roster.find((p) => p.id === id);
    if (pl) {
      const rows = await this.src.profileMatches!(pl.profileGuid!, (name) => !!findByNameLoose([pl], name), 2);
      const ins = this.db.prepare('insert or ignore into history_matches(key, tournament_guid, tournament_name, date, won, player_id, seen_at) values(?,?,?,?,?,?,?)');
      for (const r of rows) if (!settings.excludedTournaments.test(r.tournamentName)) ins.run(r.key, r.tournamentId, r.tournamentName, r.date, r.won ? 1 : 0, pl.id, now.toISOString());
    }
    kvSet(this.db, 'history', { pending: rest, ...(rest.length === 0 ? { doneAt: now.toISOString() } : st.doneAt ? { doneAt: st.doneAt } : {}) } satisfies HistoryState);
  }

  /**
   * Inscripción y admisión: una lectura por tick. Primero la lista de pruebas del torneo; después, una prueba cada vez, guardando
   * solo a las personas del club ya vinculadas a este torneo (no se guardan parejas ni rivales).
   */
  private async readEntries(job: Job, now: Date) {
    const guid = job.guid!;
    const key = `entries:${guid}`;
    const p = priorityFor(job.phase, 'draws');
    const st = kvGet<EntriesState>(this.db, key);
    if (!st || st.next >= st.events.length) {
      const events = await this.src.events!(guid, p);
      if (events.length === 0) throw new Error('El torneo aún no publica la lista de pruebas.');
      kvSet(this.db, key, { events, next: 0 } satisfies EntriesState);
      return;
    }
    const ev = st.events[st.next];
    const rows = await this.src.eventEntries!(guid, ev.eventId, p);
    const linked = listPlayers(this.db).filter((x) => (this.db.prepare('select 1 from tournament_players where tournament_guid = ? and player_id = ?').get(guid, x.id) as unknown) !== undefined);
    this.db.prepare('delete from entries where tournament_guid = ? and event_id = ?').run(guid, ev.eventId);
    const ins = this.db.prepare('insert or replace into entries(tournament_guid, event_id, event_name, player_id, status, label, seed, event_total, seen_at) values(?,?,?,?,?,?,?,?,?)');
    // Un mismo nombre puede salir dos veces en una prueba (homónimos, p. ej. «Enrique Fernandez» y «Enrique Fernández»): se elige la inscripción cuyo
    // nombre coincide con el de la lista del club incluidas las tildes y, a igualdad, la primera (las listas van primero con los cabezas de serie).
    const raw = (x: string) => x.toLowerCase().split(/\s+/).filter(Boolean);
    for (const pl of linked) {
      const plTokens = new Set(raw(pl.name));
      const cands = rows.filter((r) => r.names.some((n) => findByNameLoose([pl], n))).map((r) => ({ r, exact: r.names.some((n) => raw(n).length >= 2 && raw(n).every((t) => plTokens.has(t))) }));
      const best = cands.find((c) => c.exact) ?? cands[0];
      if (best) ins.run(guid, ev.eventId, ev.name, pl.id, best.r.status, best.r.label, /^\d+$/.test(best.r.seed ?? '') ? Number(best.r.seed) : null, rows.length, now.toISOString());
    }
    const next = st.next + 1;
    kvSet(this.db, key, { events: st.events, next, ...(next >= st.events.length ? { doneAt: now.toISOString() } : {}) } satisfies EntriesState);
  }

  saveEntrants(guid: string, entrants: EntrantLike[], roster: Player[], now: Date) {
    const up = this.db.prepare(
      `insert into entrants(tournament_guid, ts_player_id, name, club, player_id, seen_at) values(?,?,?,?,?,?)
       on conflict(tournament_guid, ts_player_id) do update set name=excluded.name, club=excluded.club, player_id=excluded.player_id, seen_at=excluded.seen_at`,
    );
    const link = this.db.prepare('insert or ignore into tournament_players(tournament_guid, player_id) values(?, ?)');
    for (const f of findClubEntrants(entrants, roster)) {
      if (kvGet<{ ok: boolean }>(this.db, `verified:${guid}:${f.tsPlayerId}`)?.ok === false) continue; // homónimo ya descartado con el perfil oficial
      up.run(guid, f.tsPlayerId, f.name, f.club ?? null, f.rosterId ?? null, now.toISOString());
      if (f.rosterId) link.run(guid, f.rosterId);
    }
    this.relinkEntrants();
  }

  /** Orden de juego de un día: se filtran los partidos de jugadores del club y se confirman los cambios. */
  private async readDay(job: Job, now: Date) {
    const guid = job.guid!;
    const t = this.db.prepare('select tz from tournaments where guid = ?').get(guid) as unknown as { tz: string };
    const rows = await this.src.day(guid, job.date!, t.tz || DEFAULT_TZ, priorityFor(job.phase, 'day'));
    const entrants: ClubEntrants = new Map(
      (this.db.prepare('select ts_player_id, player_id from entrants where tournament_guid = ?').all(guid) as unknown as { ts_player_id: number; player_id: number | null }[]).map((r) => [r.ts_player_id, r.player_id ?? undefined]),
    );
    const prevRead = kvGet<{ at: string }>(this.db, `ok:${job.key}`)?.at;
    let finishedNow = 0;
    let resultPending = false;
    // Quién juega cada partido, solo como relación: índices anónimos dentro del día (no se guarda ninguna identidad). Sirve para el descanso entre partidos.
    const pidIndex = new Map<number, number>();
    for (const id of [...new Set(rows.flatMap((r) => [...r.team1.players, ...r.team2.players]).map((p) => p.tsPlayerId).filter((x): x is number => typeof x === 'number'))].sort((a, b) => a - b)) pidIndex.set(id, pidIndex.size);
    for (const row of rows) {
      const pids = [...row.team1.players, ...row.team2.players].map((p) => (typeof p.tsPlayerId === 'number' ? pidIndex.get(p.tsPlayerId) : undefined)).filter((x): x is number => x !== undefined);
      if (this.upsertSlot(guid, job.date!, row, now, prevRead, pids)) finishedNow++;
      const m = buildStoredMatch(row, { tournamentGuid: guid, entrants });
      if (m && this.ingest(m, now) === 'pending' && (m.status === 'finished' || m.status === 'walkover' || m.status === 'retired')) resultPending = true;
    }
    // Partidos «fantasma»: los que la fuente ya no publica (cambian de clave al asignarse jugadores, se suspenden o se reordenan) y quedaron
    // como pendientes. Si no se retiran, el torneo parece no acabar nunca y la hora estimada de fin queda en el futuro para siempre.
    if (rows.length > 0) {
      const iso = now.toISOString();
      this.db.prepare("delete from slots where tournament_guid = ? and date = ? and updated_at < ? and status in ('scheduled', 'unknown')").run(guid, job.date!, iso);
      this.db.prepare("delete from slots where tournament_guid = ? and date = ? and updated_at < ? and status = 'on_court'").run(guid, job.date!, new Date(now.getTime() - 30 * 60_000).toISOString());
      // Lo mismo con los partidos del club que aún no se han jugado: si la fuente ya no los publica, no pueden seguir como «siguiente partido».
      this.db.prepare("delete from matches where tournament_guid = ? and date = ? and state = 'scheduled' and last_seen_at < ?").run(guid, job.date!, iso);
    }
    // Partidos que acaban de terminar: los cuadros y las clasificaciones cambian con ellos, así que se leen ya (no a su hora).
    if (finishedNow > 0) this.kick(`draws:${guid}`, now);
    kvSet(this.db, `ok:${job.key}`, { at: now.toISOString() });
    if (job.phase === 'past') kvSet(this.db, `rebuilt:${guid}:${job.date}`, { at: now.toISOString() }); // lectura de reconstrucción hecha: no se repite
    this.recomputeEstimate(guid, job.date!, now);
    // Un resultado nuevo de un partido del club necesita una segunda lectura igual para darse por bueno: se pide ya, sin esperar los 3 min.
    if (resultPending) this.kick(job.key, now, settings.confirmGapMs);
  }

  /** Datos anónimos de horario de TODOS los partidos del día (no solo los del club): base de la estimación. */
  private upsertSlot(guid: string, date: string, r: MatchRow, now: Date, prevRead?: string, pids: number[] = []): boolean {
    const iso = now.toISOString();
    const done = r.status === 'finished' || r.status === 'walkover' || r.status === 'retired';
    const row = this.db.prepare('select started_seen_at, finished_seen_at, duration_min from slots where key = ?').get(r.key) as unknown as
      | { started_seen_at: string | null; finished_seen_at: string | null; duration_min: number | null }
      | undefined;
    const started = row?.started_seen_at ?? (r.status === 'on_court' ? iso : null);
    const prev = row?.started_seen_at ? undefined : r.status === 'on_court' ? prevRead ?? iso : undefined;
    const finishedAt = row?.finished_seen_at ?? (done ? iso : null);
    this.db
      .prepare(
        `insert into slots(key, tournament_guid, date, planned_utc, order_idx, court, event, status, duration_min, started_seen_at, prev_poll_at, finished_seen_at, updated_at, pids)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         on conflict(key) do update set planned_utc=excluded.planned_utc, order_idx=excluded.order_idx, court=excluded.court, status=excluded.status, pids=excluded.pids,
           duration_min=coalesce(excluded.duration_min, slots.duration_min),
           started_seen_at=coalesce(slots.started_seen_at, excluded.started_seen_at), prev_poll_at=coalesce(slots.prev_poll_at, excluded.prev_poll_at),
           finished_seen_at=coalesce(slots.finished_seen_at, excluded.finished_seen_at), updated_at=excluded.updated_at`,
      )
      .run(r.key, guid, date, r.plannedUtc ?? null, r.orderIndex ?? 0, r.court ?? null, r.eventCode ?? null, r.status, r.durationMin ?? row?.duration_min ?? null, started, prev ?? null, finishedAt, iso, pids.length ? pids.join(',') : null);
    return done && !row?.finished_seen_at;
  }

  private lastSweep = 0;
  /**
   * Cada 5 minutos recalcula, con lo ya guardado (sin peticiones), la estimación del último día de cada torneo que aún no figura como
   * terminado: así una jornada que se queda sin partidos que jugar se cierra aunque ya no haya lecturas nuevas de ese día.
   */
  private sweepEstimates(now: Date) {
    if (now.getTime() - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = now.getTime();
    try {
      for (const r of this.db.prepare('select tournament_guid g, max(date) d from slots group by tournament_guid').all() as unknown as { g: string; d: string }[]) {
        const est = kvGet<{ date: string; done?: boolean }>(this.db, `estimate:${r.g}`);
        if (est && est.date === r.d && est.done) continue;
        this.recomputeEstimate(r.g, r.d, now);
      }
    } catch (e) {
      console.error('sweepEstimates', e);
    }
  }

  /** Recalcula la estimación del día y la guarda: hora de fin probable, ritmo, retraso y hora estimada de cada partido. */
  recomputeEstimate(guid: string, date: string, now: Date) {
    const rows = this.db.prepare('select * from slots where tournament_guid = ? and date = ?').all(guid, date) as unknown as Record<string, unknown>[];
    const slots: Slot[] = rows.map((r) => ({
      key: r.key as string, plannedUtc: (r.planned_utc as string) ?? undefined, orderIdx: r.order_idx as number, court: (r.court as string) ?? undefined,
      event: (r.event as string) ?? undefined, status: r.status as Slot['status'], durationMin: (r.duration_min as number) ?? undefined,
      startedSeenAt: (r.started_seen_at as string) ?? undefined, prevPollAt: (r.prev_poll_at as string) ?? undefined, finishedSeenAt: (r.finished_seen_at as string) ?? undefined,
      players: r.pids ? String(r.pids).split(',').map(Number) : undefined,
    }));
    // Valores de partida: los de fábrica, reajustados con lo aprendido de cada jornada terminada (ver patterns.ts).
    const est = estimate(slots, now, { ...defaultEstimateConfig, priors: currentPriors(this.db, now).priors, ...learnedTimingFor(this.db, now), defaultMatchMin: settings.defaultMatchMin, changeoverMin: settings.changeoverMin });
    // Se registra la estimación en bruto (para medir el modelo) y se publica la corregida con lo aprendido (ver calibration.ts).
    const shown = applyShift(est, currentShift(this.db, now));
    kvSet(this.db, `estimate:${guid}`, { date, ...shown }, now.toISOString());
    this.logEstimate(guid, date, est, now);
    return shown;
  }

  /**
   * Guarda una «foto» de la estimación (hora de fin y hora estimada de cada partido pendiente) para medir después su acierto.
   * Cada 10 minutos el día del torneo y cada 3 horas los días previos; solo si hay partidos pendientes o es la última foto.
   */
  private logEstimate(guid: string, date: string, est: Estimate, now: Date) {
    if (est.total === 0) return;
    const today = todayIn(DEFAULT_TZ, now);
    if (date < today) return; // al recalcular al arrancar días ya pasados no se guarda nada
    const gap = (date === today ? 10 : 180) * 60_000;
    const last = this.db.prepare('select max(at) a from estimate_log where tournament_guid = ? and date = ?').get(guid, date) as unknown as { a: string | null };
    const lastDone = est.done && !(this.db.prepare('select 1 x from estimate_log where tournament_guid = ? and date = ? and remaining = 0').get(guid, date) as unknown);
    if (last.a && now.getTime() - Date.parse(last.a) < gap && !lastDone) return;
    const at = now.toISOString();
    this.db
      .prepare('insert or ignore into estimate_log(tournament_guid, date, at, est_end, est_end_low, est_end_high, remaining, finished, total) values(?,?,?,?,?,?,?,?,?)')
      .run(guid, date, at, est.estimatedEnd ?? null, est.estimatedEndLow ?? null, est.estimatedEndHigh ?? null, est.remaining, est.finished, est.total);
    const ins = this.db.prepare('insert or ignore into estimate_starts(tournament_guid, date, at, slot_key, est_start) values(?,?,?,?,?)');
    for (const [key, start] of Object.entries(est.starts)) ins.run(guid, date, at, key, start);
  }

  /** Calendario oficial de torneos absolutos (solo rutas permitidas). */
  private async readCalendar(now: Date) {
    const { fesba, finder } = await this.src.calendar(2);
    if (fesba.length === 0 && finder.length === 0) throw new Error('El calendario oficial devolvió 0 filas: se conserva el anterior.');
    kvSet(this.db, 'calendar', transformCalendar(fesba, finder, now.toISOString()), now.toISOString());
    kvSet(this.db, 'calendar_ok', { at: now.toISOString() });
    this.followCalendar(now);
  }

  /**
   * Sigue los torneos absolutos del calendario oficial que están cerca: se leen sus cuadros una vez (y de vez en cuando)
   * para saber quién del club juega, aunque aún no figuren en el perfil de nadie.
   */
  followCalendar(now: Date) {
    if (settings.followCalendarDays <= 0) return;
    const cal = kvGet<{ tournaments: { tsId?: string; name?: string; startDate?: string }[] }>(this.db, 'calendar');
    const today = todayIn(DEFAULT_TZ, now);
    for (const t of cal?.tournaments ?? []) {
      if (!t.tsId || !t.startDate || (t.name && settings.excludedTournaments.test(t.name))) continue;
      const d = daysBetween(today, t.startDate);
      if (d >= -3 && d <= settings.followCalendarDays) this.track(t.tsId, undefined, now);
    }
  }

  /**
   * Guarda un partido. Un partido nuevo se guarda tal cual; un cambio de hora, pista o resultado solo se
   * da por bueno tras `confirmReads` lecturas idénticas seguidas (la web oficial oscila entre servidores).
   */
  ingest(m: StoredMatch, now: Date): 'new' | 'same' | 'pending' | 'changed' {
    const iso = now.toISOString();
    const hash = matchFingerprint(m);
    const row = this.db.prepare('select json, hash, pending_hash, pending_count from matches where key = ?').get(m.key) as unknown as
      | { json: string; hash: string; pending_hash: string | null; pending_count: number }
      | undefined;

    if (!row) {
      this.db
        .prepare('insert into matches(key, tournament_guid, date, json, hash, state, first_seen_at, updated_at, last_seen_at) values(?,?,?,?,?,?,?,?,?)')
        .run(m.key, m.tournamentGuid, m.date ?? null, JSON.stringify(m), hash, m.status, iso, iso, iso);
      this.log(m, 'new', undefined, undefined, m.status, iso);
      return 'new';
    }
    if (row.hash === hash) {
      this.db.prepare('update matches set last_seen_at = ?, pending_hash = null, pending_count = 0 where key = ?').run(iso, m.key);
      return 'same';
    }
    const count = row.pending_hash === hash ? row.pending_count + 1 : 1;
    if (count < settings.confirmReads) {
      this.db.prepare('update matches set pending_hash = ?, pending_count = ?, last_seen_at = ? where key = ?').run(hash, count, iso, m.key);
      return 'pending';
    }
    const before = JSON.parse(row.json) as StoredMatch;
    for (const d of diffMatch(before, m)) this.log(m, 'changed', d.field, d.old, d.new, iso);
    this.db
      .prepare('update matches set json = ?, hash = ?, state = ?, date = ?, pending_hash = null, pending_count = 0, updated_at = ?, last_seen_at = ? where key = ?')
      .run(JSON.stringify(m), hash, m.status, m.date ?? null, iso, iso, m.key);
    return 'changed';
  }

  private log(m: StoredMatch, kind: string, field: string | undefined, oldV: string | undefined, newV: string, at: string) {
    this.db
      .prepare('insert into changes(at, tournament_guid, match_key, kind, field, old_value, new_value) values(?,?,?,?,?,?,?)')
      .run(at, m.tournamentGuid, m.key, kind, field ?? null, oldV ?? null, newV);
  }

  /** Borra entradas antiguas del registro de cambios y de la bitácora de peticiones. */
  prune(now = this.clock()) {
    const cutoff = new Date(now.getTime() - settings.changeLogDays * 86_400_000).toISOString();
    this.db.prepare('delete from changes where at < ?').run(cutoff);
    this.db.prepare('delete from fetch_log where at < ?').run(new Date(now.getTime() - 7 * 86_400_000).toISOString());
    const old = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    this.db.prepare('delete from estimate_log where at < ?').run(old);
    this.db.prepare('delete from estimate_starts where at < ?').run(old);
    this.db.prepare('delete from captures where created_at < ?').run(new Date(now.getTime() - 30 * 86_400_000).toISOString());
  }
}

export { NEVER };
