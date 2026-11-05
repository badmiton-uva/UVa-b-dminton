import { beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/config';
import { SyncEngine } from '../src/engine';
import { createPlayer, listPlayers } from '../src/roster';
import { parseRankingCategory, parseRankingProfileGuid, titleCase } from '../src/rankingParse';
import { FakeSource, memDb } from './helpers/fakes';

/** Páginas ficticias con la estructura del ranking oficial. */
const row = (rank: number, name: string, id: number, year: number, club: string) =>
  `<tr><td>${rank}</td><td><a href="player.aspx?id=1&amp;player=${id}">${name}</a></td><td>6086</td><td>4938</td><td>29630,0</td><td>8</td><td>${year}</td><td>Castilla León</td><td>${club}</td></tr>`;
const category = `<table><tr><th>Puesto</th><th>Jugador</th></tr>
${row(18, 'ANA PRUEBA GIL', 11, 1994, 'Universidad de Valladolid')}
${row(20, 'LUIS EJEMPLO DE LA FUENTE', 12, 2010, 'Universidad de Valladolid')}
${row(25, 'MARTA PUNTOS ALTOS', 14, 2005, 'Universidad de Valladolid').replace('<td>4938</td>', '<td>2058</td>')}
${row(30, 'ROSA OTRA SANZ', 13, 1990, 'Club de Otra Ciudad')}</table>`;
const GUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('lectura del ranking', () => {
  it('lee jugadores, club, año y ficha; los nombres pasan a formato normal', () => {
    const c = parseRankingCategory(category);
    expect(c.map((x) => x.name)).toEqual(['ANA PRUEBA GIL', 'LUIS EJEMPLO DE LA FUENTE', 'MARTA PUNTOS ALTOS', 'ROSA OTRA SANZ']);
    expect(c[2].birthYear).toBe(2005); // los puntos (2058) no se confunden con el año
    expect(c[0]).toMatchObject({ club: 'Universidad de Valladolid', birthYear: 1994, playerPath: '/ranking/player.aspx?id=1&player=11' });
    expect(titleCase('LUIS EJEMPLO DE LA FUENTE')).toBe('Luis Ejemplo de la Fuente');
  });
  it('extrae el GUID del perfil de la ficha', () => {
    expect(parseRankingProfileGuid(`<a href="/profile/default.aspx?id=${GUID.toLowerCase()}">Perfil</a>`)).toBe(GUID);
    expect(parseRankingProfileGuid('<p>sin enlace</p>')).toBeUndefined();
  });
});

describe('lista del club construida sola', () => {
  beforeEach(() => {
    settings.rankingUrls = ['https://fuente.test/ranking/cat1'];
    settings.autoRosterConsent = 'declared';
  });
  const source = () => {
    const s = new FakeSource();
    s.rankingPlayers = async () => parseRankingCategory(category);
    s.rankingProfile = async () => GUID;
    return s;
  };
  const NOW = new Date('2026-10-21T10:00:00Z');

  it('añade a quienes figuran con el club de la UVa, con su perfil, y no duplica a los que ya están', async () => {
    const db = memDb();
    createPlayer(db, { name: 'Ana Prueba', public: true, consentBy: 'Ella', consentAt: '2026-10-01' }); // sin perfil
    const e = new SyncEngine(db, source(), () => NOW);
    expect(await e.tick(NOW)).toBe('roster');
    const players = listPlayers(db);
    expect(players.map((p) => p.name).sort()).toEqual(['Ana Prueba', 'Luis Ejemplo de la Fuente', 'Marta Puntos Altos']); // Rosa es de otro club
    expect(players.find((p) => p.name === 'Ana Prueba')!.profileGuid).toBe(GUID); // se completó el perfil
  });

  it('los menores se añaden ocultos, aunque el consentimiento esté «declarado»', async () => {
    const db = memDb();
    await new SyncEngine(db, source(), () => NOW).tick(NOW);
    const luis = listPlayers(db).find((p) => p.name.startsWith('Luis'))!;
    expect(luis).toMatchObject({ isMinor: true, public: false });
    const ana = listPlayers(db).find((p) => p.name.startsWith('Ana'))!;
    expect(ana).toMatchObject({ isMinor: false, public: true, consentBy: 'Declarado por la administración del club' });
  });

  it('con el modo «hidden» nadie queda visible', async () => {
    settings.autoRosterConsent = 'hidden';
    const db = memDb();
    await new SyncEngine(db, source(), () => NOW).tick(NOW);
    expect(listPlayers(db).every((p) => !p.public)).toBe(true);
  });

  it('se repite solo una vez al día', async () => {
    const db = memDb();
    const e = new SyncEngine(db, source(), () => NOW);
    expect(await e.tick(NOW)).toBe('roster');
    const jobs = e.plan(new Date(NOW.getTime() + 3600_000)).map((j) => j.kind);
    expect(jobs).not.toContain('roster');
    expect(e.plan(new Date(NOW.getTime() + 25 * 3600_000)).map((j) => j.kind)).toContain('roster');
  });
  it('las personas de HIDDEN_PLAYERS no se publican: ni al crearlas ni si ya estaban visibles', async () => {
    const db = memDb();
    settings.hiddenPlayers = ['Ana Prueba'];
    const prev = createPlayer(db, { name: 'Luis Ejemplo', public: true, consentBy: 'Él mismo', consentAt: '2026-10-01' });
    const engine = new SyncEngine(db, source(), () => NOW);
    await engine.tick(NOW);
    const by = (n: string) => listPlayers(db).find((p) => p.name.startsWith(n))!;
    expect(by('Ana Prueba').public).toBe(false);
    expect(prev.public).toBe(true);
    settings.hiddenPlayers = ['Luis Ejemplo'];
    const e2 = new SyncEngine(db, source(), () => NOW);
    await e2.tick(NOW);
    expect(by('Luis Ejemplo').public).toBe(false);
    settings.hiddenPlayers = ['Luis Ejemplo'];
    createPlayer(db, { name: 'Luis Ejemplo de la Fuente', public: true, consentBy: 'Él', consentAt: '2026-10-01' });
    await new SyncEngine(db, source(), () => NOW).tick(NOW);
    expect(listPlayers(db).filter((p) => p.name.startsWith('Luis')).every((p) => !p.public)).toBe(true); // nombre corto frente a completo
    settings.hiddenPlayers = [];
  });
});

describe('nombre corto del torneo frente al nombre completo del ranking', () => {
  const NOW2 = new Date('2026-11-07T10:00:00+01:00');
  it('reconoce a «Pablo Martin» como «Pablo Martin Castañeda» y publica su partido', async () => {
    const { buildPublicState } = await import('../src/publicView');
    const { standing, row, GUID, PROFILE } = await import('./helpers/fakes');
    settings.opponents = 'none';
    settings.officialReadEnabled = true;
    settings.rankingUrls = [];
    const db = memDb();
    const src = new FakeSource();
    src.standingRows = [standing(['Pablo Martin'], [1], 'UNIVERSIDAD DE VALLADOLID'), standing(['Rival Uno'], [2], 'OTRO CLUB')];
    src.dayRows = [row({ names1: [['Pablo Martin', 1]], names2: [['Rival Uno', 2]] })];
    createPlayer(db, { name: 'Pablo Martin Castañeda', profile: PROFILE, public: true, consentBy: 'Club', consentAt: '2026-10-20' });
    const e = new SyncEngine(db, src, () => NOW2);
    for (let i = 0; i < 8; i++) await e.tick(new Date(NOW2.getTime() + i * 5 * 60_000));
    const [t] = buildPublicState(db, NOW2).tournaments;
    expect(t.uvaPlayers).toEqual(['Pablo Martin Castañeda']);
    expect(t.matches[0]).toMatchObject({ players: ['Pablo Martin Castañeda'], state: 'scheduled' });
    void GUID;
  });

  it('repara los partidos ya guardados sin identificador, sin hacer peticiones', async () => {
    const { buildPublicState } = await import('../src/publicView');
    const { standing, row, GUID, PROFILE } = await import('./helpers/fakes');
    const db = memDb();
    const src = new FakeSource();
    src.standingRows = [standing(['Pablo Martin'], [1], 'UNIVERSIDAD DE VALLADOLID')];
    src.dayRows = [row({ names1: [['Pablo Martin', 1]], names2: [['Rival Uno', 2]] })];
    // Se leen los datos cuando la lista aún no tiene a la persona…
    let e = new SyncEngine(db, src, () => NOW2);
    createPlayer(db, { name: 'Otro Jugador', profile: PROFILE });
    for (let i = 0; i < 8; i++) await e.tick(new Date(NOW2.getTime() + i * 5 * 60_000));
    expect(buildPublicState(db, NOW2).tournaments).toEqual([]);
    // …y después se añade: al reiniciar el motor se reasocia y el partido ya se puede publicar.
    createPlayer(db, { name: 'Pablo Martin Castañeda', public: true, consentBy: 'Club', consentAt: '2026-10-20' });
    e = new SyncEngine(db, new FakeSource(), () => NOW2);
    e.relinkEntrants();
    db.prepare('insert or ignore into tournament_players select ?, id from players where name like ?').run(GUID, 'Pablo%');
    expect(buildPublicState(db, NOW2).tournaments[0].matches[0]).toMatchObject({ players: ['Pablo Martin Castañeda'] });
  });
});

describe('cuadros públicos con nombres cortos', () => {
  it('marca como de la UVa a «Pablo Martin» (nombre corto) y no a un homónimo de otro club', async () => {
    const { entrantLabel } = await import('../src/publicView');
    const pablo = { id: 1, name: 'Pablo Martin Castañeda', profileGuid: null, category: null, isMinor: false, guardianConsent: false, public: true, consentBy: 'x', consentAt: 'y', notes: null };
    expect(entrantLabel(['Pablo Martin'], 'UNIVERSIDAD DE VALLADOLID', [pablo])).toEqual({ label: 'Pablo Martin Castañeda', uva: true });
    expect(entrantLabel(['Pablo Martin'], undefined, [pablo]).uva).toBe(true);
    expect(entrantLabel(['Pablo Martin'], 'OTRO CLUB', [pablo]).uva).toBe(false); // homónimo
  });
});
