import { openDb } from '../../src/db';
import type { BracketRound, DrawInfo, MatchRow, StandingRow, TournamentInfo } from '../../src/model';
import type { OfficialSource } from '../../src/source';

export const GUID = '11111111-2222-3333-4444-555555555555';
export const PROFILE = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

export const info = (over: Partial<TournamentInfo> = {}): TournamentInfo => ({
  id: GUID, name: 'Torneo de prueba', startDate: '2026-11-07', endDate: '2026-11-07', days: ['2026-11-07'],
  city: 'Valladolid', tz: 'Europe/Madrid', ...over,
});

export const standing = (names: string[], ids: number[], club: string): StandingRow => ({
  rank: 1, names, ids, club, played: 0, won: 0, drawn: 0, lost: 0, matches: '0-0', games: '0-0', points: '0-0', pts: 0, form: [],
});

export interface RowOpts {
  key?: string; names1?: [string, number][]; names2?: [string, number][]; status?: MatchRow['status'];
  winner?: 1 | 2; sets?: [number, number][]; clock?: string; court?: string; date?: string;
}
export const row = (o: RowOpts = {}): MatchRow =>
  ({
    key: o.key ?? 'm1', tournamentId: GUID, drawName: 'IM', eventCode: 'IM', round: 'Octavos',
    date: o.date ?? '2026-11-07', plannedClock: o.clock ?? '10:00', court: o.court ?? '1',
    team1: { players: (o.names1 ?? [['Ana Prueba', 1]]).map(([name, tsPlayerId]) => ({ name, tsPlayerId })) },
    team2: { players: (o.names2 ?? [['Rival Uno', 2]]).map(([name, tsPlayerId]) => ({ name, tsPlayerId })) },
    sets: o.sets ?? [], winner: o.winner, status: o.status ?? 'scheduled',
  }) as MatchRow;

/** Fuente oficial simulada: lo que devuelve se configura en cada prueba. Cuenta las peticiones. */
export class FakeSource implements OfficialSource {
  calls: string[] = [];
  profileTournaments: string[] = [GUID];
  infoData: TournamentInfo = info();
  drawList: DrawInfo[] = [{ drawId: 1, name: 'IM - Grupo A', type: 'roundrobin' }];
  standingRows: StandingRow[] = [standing(['Ana Prueba'], [1], 'UNIVERSIDAD DE VALLADOLID'), standing(['Rival Uno'], [2], 'OTRO CLUB')];
  bracketRounds: BracketRound[] = [];
  dayRows: MatchRow[] = [];
  rankingTable?: OfficialSource['rankingTable'];
  rankingPlayers?: OfficialSource['rankingPlayers'];
  rankingProfile?: OfficialSource['rankingProfile'];
  events?: OfficialSource['events'];
  eventEntries?: OfficialSource['eventEntries'];
  tournamentPlayers?: OfficialSource['tournamentPlayers'];
  playerProfile?: OfficialSource['playerProfile'];
  profileMatches?: OfficialSource['profileMatches'];
  leagueEditions?: OfficialSource['leagueEditions'];
  leagueDraw?: OfficialSource['leagueDraw'];
  calendarData: { fesba: never[]; finder: never[] } = { fesba: [], finder: [] };
  failWith?: Error;

  private async go<T>(label: string, value: T): Promise<T> {
    this.calls.push(label);
    if (this.failWith) throw this.failWith;
    return value;
  }
  profile = () => this.go('profile', { name: 'x', tournamentIds: this.profileTournaments });
  tournament = () => this.go('tournament', this.infoData);
  draws = () => this.go('draws', this.drawList);
  standings = () => this.go('standings', this.standingRows);
  bracket = () => this.go('bracket', this.bracketRounds);
  day = () => this.go('day', this.dayRows);
  calendar = () => this.go('calendar', this.calendarData);
}

export const memDb = () => openDb(':memory:');
