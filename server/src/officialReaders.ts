import type { PoliteClient, Priority } from './http';
import { NoDrawsError } from './http';
import type { LiveReaders, RosterReaders } from './source';
import { parseRankingCategory, parseRankingProfileGuid, parseRankingTable } from './rankingParse';
import { TsSource, urls } from './lib/ts/source';
import { parseBracket, parseDrawsList, parseStandingTable } from './lib/ts/parse/draws';
import { parseEventPage } from './lib/ts/parse/pages';
import { parseLigaFixtures, parseLigaStandings } from './ligaParse';
import { load } from 'cheerio';
import { parseEventsList, parsePlayerPageProfile, parsePlayersList } from './entriesParse';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * Lectores de las páginas públicas de torneo y de perfil de badminton.es.
 * Todas las lecturas pasan por el cliente prudente (una petición cada ≥ 2,5 s, con caché y reintentos).
 * Los lectores de HTML (`lib/ts/parse`) proceden de «Badminton Live» y están probados allí con páginas oficiales reales.
 */
export class OfficialLiveReaders implements LiveReaders, RosterReaders {
  private readonly src: TsSource;

  constructor(private readonly http: PoliteClient) {
    this.src = new TsSource(http, http.url('/').replace(/\/$/, ''));
  }

  async profile(guid: string, p: Priority) {
    const { data } = await this.src.profile(guid, p);
    const ids = new Set<string>([...data.currentlyPlaying.map((t) => t.tournamentId), ...data.recentTournamentIds]);
    return { name: data.name, tournamentIds: [...ids] };
  }

  async tournament(guid: string, p: Priority) {
    const { data } = await this.src.tournament(guid, p);
    return data;
  }

  async draws(guid: string, p: Priority) {
    const res = await this.http.get(urls.draws(guid), { priority: p });
    const list = parseDrawsList(res.body);
    if (list.length === 0) {
      // Para diagnóstico: qué página llegó realmente (código, dirección final, título y tamaño), sin contenido personal.
      const title = res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80);
      const e = new Error(`Lista de cuadros vacía: HTTP ${res.status}, ${res.bytes || res.body.length} B, final «${res.finalUrl ?? res.url}», título «${title ?? '-'}»`);
      throw new NoDrawsError(e.message);
    }
    return list;
  }

  async standings(guid: string, drawId: number, p: Priority) {
    return parseStandingTable((await this.http.get(urls.standings(guid, drawId), { priority: p, headers: XHR })).body);
  }

  async bracket(guid: string, drawId: number, p: Priority) {
    return parseBracket((await this.http.get(urls.drawContent(guid, drawId), { priority: p, headers: XHR })).body);
  }

  async day(guid: string, date: string, tz: string, p: Priority) {
    const { data } = await this.src.day(guid, date, tz, p);
    return data;
  }

  async events(guid: string, p: Priority) {
    return parseEventsList((await this.http.get(`/sport/events.aspx?id=${guid}`, { priority: p })).body);
  }

  /** Jugadores del torneo (sin club) y, de uno concreto, el perfil oficial que enlaza su ficha. */
  async tournamentPlayers(guid: string, p: Priority) {
    return parsePlayersList((await this.http.get(urls.players(guid), { priority: p })).body);
  }

  async playerProfile(guid: string, tsPlayerId: number, p: Priority) {
    return parsePlayerPageProfile((await this.http.get(urls.tournamentPlayer(guid, tsPlayerId), { priority: p })).body);
  }

  /** Partidos terminados del perfil oficial (≈ 100 últimos), solo los del propio jugador con ganador conocido. */
  async profileMatches(guid: string, isMe: (name: string) => boolean, p: Priority) {
    const { data } = await this.src.profileMatches(guid, 'Europe/Madrid', (name) => isMe(name), p);
    return data
      .filter((m) => m.mySide && m.winner && m.date && m.status === 'finished')
      .map((m) => ({ key: m.key, tournamentId: m.tournamentId, tournamentName: m.tournamentName, date: m.date!, won: m.winner === m.mySide }));
  }

  /** Ediciones de la Liga Nacional de Clubes (buscador de torneos de badminton.es). */
  async leagueEditions(p: Priority) {
    const $ = load((await this.http.get('/find/tournament?q=Liga+Nacional+de+Clubes+edici%C3%B3n', { priority: p })).body);
    const out: { id: string; name: string }[] = [];
    $('a[href*="tournament"]').each((_, a) => {
      const id = ($(a).attr('href') ?? '').match(/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/)?.[1];
      const name = $(a).text().replace(/\s+/g, ' ').trim();
      if (id && name && !out.some((o) => o.id === id.toUpperCase())) out.push({ id: id.toUpperCase(), name });
    });
    return out;
  }

  /** Clasificación (página de la división) y todos los encuentros (listado de partidos) de una división de la Liga. */
  async leagueDraw(guid: string, drawId: number, p: Priority) {
    const standings = parseLigaStandings((await this.http.get(urls.draw(guid, drawId), { priority: p })).body);
    const fixtures = parseLigaFixtures((await this.http.get(`/sport/drawmatches.aspx?id=${guid}&draw=${drawId}`, { priority: p })).body);
    return { standings, fixtures };
  }

  async eventEntries(guid: string, eventId: number, p: Priority) {
    const { entries } = parseEventPage((await this.http.get(urls.event(guid, eventId), { priority: p })).body);
    return entries.map((e) => ({ names: e.names, status: e.status as 'confirmed' | 'reserve' | 'excluded' | 'unknown', label: e.label, seed: e.seed }));
  }

  async rankingTable(url: string, p: Priority) {
    return parseRankingTable((await this.http.get(url, { priority: p })).body);
  }

  async rankingPlayers(url: string, p: Priority) {
    return parseRankingCategory((await this.http.get(url, { priority: p })).body);
  }

  async rankingProfile(playerPath: string, p: Priority) {
    return parseRankingProfileGuid((await this.http.get(playerPath, { priority: p })).body);
  }
}
