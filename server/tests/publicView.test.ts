import { beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/config';
import { SyncEngine } from '../src/engine';
import { buildPublicState } from '../src/publicView';
import { createPlayer, updatePlayer } from '../src/roster';
import { FakeSource, GUID, memDb, PROFILE, row } from './helpers/fakes';

const NOW = new Date('2026-11-07T10:00:00+01:00');
const consent = { consentBy: 'Ella misma', consentAt: '2026-10-01' };

function setup() {
  const db = memDb();
  const src = new FakeSource();
  const engine = new SyncEngine(db, src, () => NOW);
  return { db, src, engine };
}

/** Deja el torneo descubierto, con sus cuadros y el orden de juego leídos (tres ciclos: la fuente real tarda en confirmar). */
async function runAll(engine: SyncEngine, times = 8) {
  for (let i = 0; i < times; i++) await engine.tick(new Date(NOW.getTime() + i * 5 * 60_000));
}

beforeEach(() => {
  settings.opponents = 'none';
  settings.officialReadEnabled = true;
});

describe('lo que se publica', () => {
  it('sin jugadores públicos no se publica nada, aunque haya datos', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE });
    src.dayRows = [row({ status: 'finished', winner: 1, sets: [[21, 15], [21, 17]] })];
    await runAll(engine);
    expect(db.prepare('select count(*) n from matches').get()).toEqual({ n: 1 });
    expect(buildPublicState(db, NOW).tournaments).toEqual([]);
  });

  it('con consentimiento aparece el torneo, el jugador y el resultado desde su punto de vista', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    // Ana es el equipo 2 y gana: los sets se invierten para mostrarlos desde la UVa.
    src.dayRows = [row({ names1: [['Rival Uno', 2]], names2: [['Ana Prueba', 1]], status: 'finished', winner: 2, sets: [[15, 21], [17, 21]] })];
    await runAll(engine);
    const [t] = buildPublicState(db, NOW).tournaments;
    expect(t.uvaPlayers).toEqual(['Ana Prueba']);
    expect(t.matches[0]).toMatchObject({ players: ['Ana Prueba'], state: 'finished', outcome: 'win', score: '21-15 21-17' });
  });

  it('el rival no se publica por defecto y sí si se activa', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    src.dayRows = [row()];
    await runAll(engine);
    expect(buildPublicState(db, NOW).tournaments[0].matches[0].opponent).toBeUndefined();
    expect(JSON.stringify(buildPublicState(db, NOW))).not.toContain('Rival Uno');
    settings.opponents = 'names';
    expect(buildPublicState(db, NOW).tournaments[0].matches[0].opponent).toBe('Rival Uno');
  });

  it('el rival sale con nombre y primer apellido, también en el cuadro, pero nunca en pruebas de menores', async () => {
    const { db, src, engine } = setup();
    settings.opponents = 'names';
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    src.dayRows = [
      row({ key: 'a', names2: [['Pedro de la Torre Gil', 2]] }),
      { ...row({ key: 'b', names2: [['Lucía Menor Pérez', 3]] }), drawName: 'IM Sub-13', eventCode: 'IM Sub-13' } as ReturnType<typeof row>,
    ];
    await runAll(engine);
    const t = buildPublicState(db, NOW).tournaments[0];
    expect(t.matches.find((m) => m.id === 'a')?.opponent).toBe('Pedro de la Torre');
    expect(t.matches.find((m) => m.id === 'b')?.opponent).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('Lucía Menor');
    expect(JSON.stringify(t)).not.toContain('Gil');
  });

  it('un partido de dobles se oculta entero si alguien del club no es público', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    createPlayer(db, { name: 'Carla Prueba' }); // oculta
    src.standingRows.push({ ...src.standingRows[0], names: ['Carla Prueba'], ids: [3] });
    src.dayRows = [row({ names1: [['Ana Prueba', 1], ['Carla Prueba', 3]] })];
    await runAll(engine);
    const t = buildPublicState(db, NOW).tournaments[0];
    expect(t.matches).toEqual([]); // el partido no se publica
    expect(JSON.stringify(t)).not.toContain('Carla');
  });

  it('al ocultar a una persona desaparece de inmediato', async () => {
    const { db, src, engine } = setup();
    const p = createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    src.dayRows = [row()];
    await runAll(engine);
    expect(buildPublicState(db, NOW).tournaments).toHaveLength(1);
    updatePlayer(db, p.id, { public: false });
    expect(buildPublicState(db, NOW).tournaments).toEqual([]);
  });

  it('una persona del club que no está en la lista nunca se publica', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Carla Prueba', profile: PROFILE, public: true, ...consent });
    src.dayRows = [row()]; // Ana figura con el club UVA pero no está en la lista
    await runAll(engine);
    const state = JSON.stringify(buildPublicState(db, NOW));
    expect(state).not.toContain('Ana Prueba');
  });

  it('los datos antiguos se marcan como tal en lugar de presentarse como en directo', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    src.dayRows = [row()];
    await runAll(engine);
    expect(buildPublicState(db, NOW).tournaments[0].stale).toBe(false);
    const later = new Date(NOW.getTime() + 8 * 3600_000 + settings.staleAfterMs);
    const t = buildPublicState(db, later).tournaments[0];
    expect(t.stale).toBe(true);
    expect(t.checkedAt).toBeDefined();
    expect(GUID).toBe(t.id);
  });
});

describe('cuántos partidos faltan antes del siguiente del club', () => {
  it('cuenta los partidos del torneo que van antes (de cualquiera), sin W.O. ni los ya empezados o terminados', async () => {
    const { db, src, engine } = setup();
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, ...consent });
    const at = (r: ReturnType<typeof row>, i: number) => ({ ...r, orderIndex: i, plannedUtc: `2026-11-07T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00.000Z` });
    src.dayRows = [
      row({ key: 'a', clock: '09:00', status: 'finished', winner: 2, sets: [[10, 21], [10, 21]], names1: [['Otra Persona', 8]], names2: [['Rival Dos', 3]] }),
      row({ key: 'b', clock: '09:30', status: 'on_court', court: '2', names1: [['Persona Tres', 9]], names2: [['Rival Tres', 4]] }),
      row({ key: 'c', clock: '10:00', court: '3', names1: [['Persona Cuatro', 10]], names2: [['Rival Cuatro', 5]] }),
      row({ key: 'd', clock: '10:30', court: '4', names1: [['Persona Cinco', 11]], names2: [['Rival Cinco', 6]] }),
      row({ key: 'm1', clock: '11:00', court: '1' }), // el partido de Ana
      row({ key: 'f', clock: '11:30', court: '2', names1: [['Persona Seis', 12]], names2: [['Rival Seis', 7]] }),
    ].map(at);
    await runAll(engine);
    const ana = buildPublicState(db, NOW).tournaments[0].matches.find((m) => m.id === 'm1');
    expect(ana?.state).toBe('scheduled');
    expect(ana?.ahead).toBe(2); // c y d; no el terminado (a), ni el que está en pista (b), ni el posterior (f)
  });
});


describe('partido entre dos parejas del club', () => {
  it('se publica con el rival como «Jugador/a UVa» si el rival del club no es público, y se oculta si el no público es compañero de una persona pública', async () => {
    const { toPublicMatch } = await import('../src/publicView');
    const mk = (a: { rosterId?: number }[], b: { rosterId?: number }[]) =>
      ({ key: 'k', tournamentGuid: 'g', status: 'scheduled', sets: [], sides: [{ players: a.map((p, i) => ({ name: `A${i} Uno Dos`, uva: true, ...p })) }, { players: b.map((p, i) => ({ name: `B${i} Uno Dos`, uva: true, ...p })) }] }) as never;
    const pub = new Set([1, 2]);
    const ok = toPublicMatch(mk([{ rosterId: 1 }, { rosterId: 2 }], [{}, {}]), pub);
    expect(ok?.opponent).toBe('Jugador/a UVa / Jugador/a UVa');
    expect(ok?.players).toHaveLength(2);
    expect(toPublicMatch(mk([{ rosterId: 1 }, {}], [{}, {}]), pub)).toBeUndefined();
  });
});
