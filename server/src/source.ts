import { type FinderRow, finderPageBody, parseFesbaCalendar, parseFinder } from './calendarParse';
import type { FesbaCalendarRow } from './calendar';
import { httpConfig } from './config-http';
import { type Priority, PoliteClient } from './http';
import type { RankingCandidate, RankingRow } from './rankingParse';
import type { BracketRound, DrawInfo, MatchRow, StandingRow, TournamentInfo } from './model';
import type { LigaFixture, LigaStanding } from './ligaParse';

/** Lectores de las páginas de torneo (información, cuadros, clasificaciones, orden de juego y perfiles). */
export interface RosterReaders {
  /** Jugadores de una categoría del ranking oficial con su club. */
  rankingPlayers(url: string, p: Priority): Promise<RankingCandidate[]>;
  /** Tabla completa de una categoría del ranking (puestos y puntos). */
  rankingTable?(url: string, p: Priority): Promise<{ title?: string; date?: string; rows: RankingRow[] }>;
  /** GUID del perfil oficial de un jugador, desde su ficha del ranking. */
  rankingProfile(playerPath: string, p: Priority): Promise<string | undefined>;
}

export interface LiveReaders extends Partial<RosterReaders> {
  profile(guid: string, p: Priority): Promise<{ name: string; tournamentIds: string[] }>;
  tournament(guid: string, p: Priority): Promise<TournamentInfo>;
  draws(guid: string, p: Priority): Promise<DrawInfo[]>;
  standings(guid: string, drawId: number, p: Priority): Promise<StandingRow[]>;
  bracket(guid: string, drawId: number, p: Priority): Promise<BracketRound[]>;
  day(guid: string, date: string, tz: string, p: Priority): Promise<MatchRow[]>;
  /** Pruebas del torneo (IM, DX…) y, de cada una, la lista de inscritos con su estado (admitido, reserva…). */
  events?(guid: string, p: Priority): Promise<{ eventId: number; name: string }[]>;
  eventEntries?(guid: string, eventId: number, p: Priority): Promise<EventEntryRow[]>;
  /** Jugadores inscritos en el torneo (solo nombre) y el perfil oficial de uno de ellos: así se reconoce a la gente del club sin confundir homónimos. */
  tournamentPlayers?(guid: string, p: Priority): Promise<{ tsPlayerId: number; name: string }[]>;
  playerProfile?(guid: string, tsPlayerId: number, p: Priority): Promise<string | undefined>;
  /** Partidos terminados del perfil oficial de una persona (≈ 100 últimos): fecha, torneo y si ganó. `isMe` indica qué lado es ella. */
  profileMatches?(guid: string, isMe: (name: string) => boolean, p: Priority): Promise<HistoryRow[]>;
  /** Ediciones de la Liga Nacional de Clubes que figuran en el buscador de torneos y, de una división, su clasificación y sus encuentros. */
  leagueEditions?(p: Priority): Promise<{ id: string; name: string }[]>;
  leagueDraw?(guid: string, drawId: number, p: Priority): Promise<{ standings: LigaStanding[]; fixtures: LigaFixture[] }>;
}

export interface HistoryRow {
  key: string;
  tournamentId: string;
  tournamentName: string;
  date: string;
  won: boolean;
}

export interface EventEntryRow {
  names: string[];
  status: 'confirmed' | 'reserve' | 'excluded' | 'unknown';
  label: string;
  /** Cabeza de serie (nº) según la lista oficial, si la tiene. */
  seed?: string;
}

/** Lo que el motor necesita de la fuente oficial. Las pruebas usan una copia simulada. */
export interface OfficialSource extends LiveReaders {
  /** Calendario oficial FESBA y buscador de torneos (rutas públicas permitidas por robots.txt). */
  calendar(p: Priority): Promise<{ fesba: FesbaCalendarRow[]; finder: FinderRow[] }>;
}

export class LiveReadersMissingError extends Error {
  constructor() {
    super('Los lectores de las páginas de torneo no están implementados.');
    this.name = 'LiveReadersMissingError';
  }
}

const missing = () => Promise.reject(new LiveReadersMissingError());

/**
 * Fuente real: badminton.es a través del cliente prudente. El calendario está implementado (páginas públicas permitidas).
 * Los lectores de torneo se inyectan en `live`; mientras no existan, la lectura en directo no puede activarse.
 */
export class RealSource implements OfficialSource {
  readonly http: PoliteClient;

  constructor(
    http?: PoliteClient,
    private readonly live?: LiveReaders,
  ) {
    this.http = http ?? new PoliteClient({ baseUrl: httpConfig.baseUrl, minIntervalMs: httpConfig.minIntervalMs, timeoutMs: httpConfig.timeoutMs, userAgent: httpConfig.userAgent });
    if (live?.events) this.events = (g, p) => live.events!(g, p);
    if (live?.eventEntries) this.eventEntries = (g, e, p) => live.eventEntries!(g, e, p);
    if (live?.tournamentPlayers) this.tournamentPlayers = (g, p) => live.tournamentPlayers!(g, p);
    if (live?.playerProfile) this.playerProfile = (g, id, p) => live.playerProfile!(g, id, p);
    if (live?.profileMatches) this.profileMatches = (g, isMe, p) => live.profileMatches!(g, isMe, p);
    if (live?.leagueEditions) this.leagueEditions = (p) => live.leagueEditions!(p);
    if (live?.leagueDraw) this.leagueDraw = (g, d, p) => live.leagueDraw!(g, d, p);
  }

  get hasLiveReaders() {
    return !!this.live;
  }

  /** Lectores opcionales (inscritos y admisión): solo existen si los lectores inyectados los tienen; el motor comprueba su presencia. */
  events?: LiveReaders['events'];
  eventEntries?: LiveReaders['eventEntries'];
  tournamentPlayers?: LiveReaders['tournamentPlayers'];
  playerProfile?: LiveReaders['playerProfile'];
  profileMatches?: LiveReaders['profileMatches'];
  leagueEditions?: LiveReaders['leagueEditions'];
  leagueDraw?: LiveReaders['leagueDraw'];

  rankingTable = (u: string, p: Priority) => (this.live?.rankingTable ? this.live.rankingTable(u, p) : missing());
  rankingPlayers = (u: string, p: Priority) => (this.live?.rankingPlayers ? this.live.rankingPlayers(u, p) : missing());
  rankingProfile = (path: string, p: Priority) => (this.live?.rankingProfile ? this.live.rankingProfile(path, p) : missing());
  profile = (g: string, p: Priority) => (this.live ? this.live.profile(g, p) : missing());
  tournament = (g: string, p: Priority) => (this.live ? this.live.tournament(g, p) : missing());
  draws = (g: string, p: Priority) => (this.live ? this.live.draws(g, p) : missing());
  standings = (g: string, d: number, p: Priority) => (this.live ? this.live.standings(g, d, p) : missing());
  bracket = (g: string, d: number, p: Priority) => (this.live ? this.live.bracket(g, d, p) : missing());
  day = (g: string, date: string, tz: string, p: Priority) => (this.live ? this.live.day(g, date, tz, p) : missing());

  async calendar(p: Priority) {
    const year = new Date().getFullYear();
    const fesba: FesbaCalendarRow[] = [];
    for (const y of [year, year + 1]) {
      for (const egid of ['593', '253', '276']) {
        const res = await this.http.get(`/calendar/192/Calendario-FESBA?year=${y}&egid=${egid}`, { priority: p });
        for (const r of parseFesbaCalendar(res.body, httpConfig.baseUrl)) fesba.push({ ...r, year: y, egid });
      }
    }
    const finder: FinderRow[] = [];
    const size = 100;
    const first = (await this.http.get('/tournamentlist.aspx', { priority: p })).body;
    let html = first;
    for (let page = 1; page <= 4; page++) {
      html = (
        await this.http.get('/tournamentlist.aspx', {
          priority: p,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: finderPageBody(page === 1 ? first : html, page, size),
        })
      ).body;
      const parsed = parseFinder(html);
      finder.push(...parsed.rows);
      if (!parsed.pages || page >= parsed.pages) break;
    }
    return { fesba, finder };
  }
}
