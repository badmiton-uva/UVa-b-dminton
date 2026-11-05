import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../src/engine';
import { createPlayer, findByNameLoose, listPlayers } from '../src/roster';
import { settings } from '../src/config';
import { FakeSource, GUID, memDb, PROFILE } from './helpers/fakes';

describe('homónimos: sin el segundo apellido, la persona se confirma con el perfil oficial', () => {
  settings.officialReadEnabled = true;
  const db = memDb();
  const javi = createPlayer(db, { name: 'Javier Gonzalez Martin', profile: PROFILE, public: true, consentBy: 'Él', consentAt: '2026-10-01' });
  const roster = listPlayers(db);

  it('un nombre oficial más corto que el de la lista solo vale si se permite expresamente', () => {
    expect(findByNameLoose(roster, 'Javier Gonzalez')?.id).toBe(javi.id); // comportamiento heredado (con perfil oficial que lo confirme)
    expect(findByNameLoose(roster, 'Javier Gonzalez', { shorterOk: false })).toBeUndefined();
    expect(findByNameLoose(roster, 'Javier Gonzalez Martin', { shorterOk: false })?.id).toBe(javi.id);
    expect(findByNameLoose(roster, 'Javier Gonzalez Martin Lopez', { shorterOk: false })?.id).toBe(javi.id); // más largo: sí
  });

  const scene = () => {
    const d = memDb();
    const p = createPlayer(d, { name: 'Javier Gonzalez Martin', profile: PROFILE, public: true, consentBy: 'Él', consentAt: '2026-10-01' });
    const q = createPlayer(d, { name: 'Ana Prueba', profile: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEE1', public: true, consentBy: 'Ella', consentAt: '2026-10-01' });
    d.prepare('insert into tournaments(guid, name, start_date, end_date, city, discovered_at, info_ok_at, days_json) values(?,?,?,?,?,?,?,?)').run(GUID, 'Guadarrama', '2026-11-01', '2026-11-01', 'Guadarrama', 'x', 'x', '["2026-11-01"]');
    d.prepare('insert into tournament_players(tournament_guid, player_id) values(?,?),(?,?)').run(GUID, p.id, GUID, q.id);
    const ent = d.prepare('insert into entrants(tournament_guid, ts_player_id, name, club, player_id, seen_at) values(?,?,?,?,?,?)');
    ent.run(GUID, 13, 'Javier Gonzalez', null, p.id, 'x'); // asociado por nombre corto, sin club: por verificar
    ent.run(GUID, 20, 'Ana Prueba', null, q.id, 'x'); // nombre completo: sin duda
    d.prepare('insert into entries(tournament_guid, event_id, event_name, player_id, status, seen_at) values(?,?,?,?,?,?)').run(GUID, 1, 'IM', p.id, 'admitted', 'x');
    const side = (id: number, uva: boolean, rosterId?: number) => ({ players: [{ name: 'X', tsPlayerId: id, uva, rosterId }] });
    const m = (key: string, a: ReturnType<typeof side>) => d.prepare('insert into matches(key, tournament_guid, date, json, hash, state, first_seen_at, updated_at, last_seen_at) values(?,?,?,?,?,?,?,?,?)').run(key, GUID, '2026-11-01', JSON.stringify({ key, tournamentGuid: GUID, sides: [a, side(99, false)], sets: [], status: 'finished' }), 'h', 'finished', 'x', 'x', 'x');
    m('del-homonimo', side(13, true, p.id));
    m('de-ana', side(20, true, q.id));
    return { d, p, q };
  };
  const run = async (d: ReturnType<typeof memDb>, profileOf13: string | undefined) => {
    const src = new FakeSource();
    src.profileTournaments = []; // el perfil oficial de la persona no lista este torneo
    src.playerProfile = (async (_g: string, id: number) => (id === 13 ? profileOf13 : undefined)) as never;
    const e = new SyncEngine(d, src, () => new Date('2026-11-05T12:00:00Z'));
    for (let i = 0; i < 30; i++) await e.tick(new Date(Date.parse('2026-11-05T12:00:00Z') + i * 60_000));
    return e;
  };

  it('un nombre corto sin club se comprueba con el perfil oficial: si es otro perfil, es un homónimo y se retira con sus partidos e inscripciones', async () => {
    const { d, p, q } = scene();
    const e = await run(d, 'E7030D2E-4B3F-4027-9BC9-C83208DFC37A'); // otro perfil
    expect(d.prepare('select player_id from entrants where ts_player_id = 13').get()).toEqual({ player_id: null });
    expect(d.prepare('select count(*) n from tournament_players where player_id = ?').get(p.id)).toEqual({ n: 0 });
    expect(d.prepare('select count(*) n from entries').get()).toEqual({ n: 0 });
    expect((d.prepare("select key from matches where key in ('del-homonimo', 'de-ana')").all() as { key: string }[]).map((r) => r.key)).toEqual(['de-ana']);
    expect(d.prepare('select player_id from entrants where ts_player_id = 20').get()).toEqual({ player_id: q.id }); // nombre completo: no se toca
    e.relinkEntrants(); // y no se vuelve a asociar por nombre
    expect(d.prepare('select player_id from entrants where ts_player_id = 13').get()).toEqual({ player_id: null });
  });

  it('si el perfil oficial coincide (es la misma persona con el nombre acortado), se queda todo', async () => {
    const { d, p } = scene();
    await run(d, PROFILE);
    expect(d.prepare('select player_id from entrants where ts_player_id = 13').get()).toEqual({ player_id: p.id });
    expect(d.prepare("select count(*) n from matches where key = 'del-homonimo'").get()).toEqual({ n: 1 });
  });

  it('si no se puede comprobar (la ficha no enlaza ningún perfil), no se borra nada', async () => {
    const { d, p } = scene();
    await run(d, undefined);
    expect(d.prepare('select player_id from entrants where ts_player_id = 13').get()).toEqual({ player_id: p.id });
  });
});

describe('reconstrucción de partidos de torneos recientes tras una limpieza', () => {
  it('un torneo terminado hace poco, con gente del club y sin partidos guardados, relee sus días una sola vez', async () => {
    const d = memDb();
    const p = createPlayer(d, { name: 'Ana Prueba', profile: PROFILE, public: true, consentBy: 'Ella', consentAt: '2026-10-01' });
    d.prepare('insert into tournaments(guid, name, start_date, end_date, city, discovered_at, info_ok_at, draws_ok_at, days_json) values(?,?,?,?,?,?,?,?,?)').run(GUID, 'Estella', '2026-10-24', '2026-10-24', 'Estella', 'x', 'x', 'x', '["2026-10-24"]');
    d.prepare('insert into tournament_players(tournament_guid, player_id) values(?,?)').run(GUID, p.id);
    const src = new FakeSource();
    const e = new SyncEngine(d, src, () => new Date('2026-11-05T12:00:00Z'));
    const now = new Date('2026-11-05T12:00:00Z');
    const days = () => e.plan(now).filter((j) => j.kind === 'day').map((j) => j.key);
    expect(days()).toEqual([]); // sin marca de reconstrucción no se relee nada
    d.prepare("insert into kv(k, v, updated_at) values('needs-rebuild:' || ?, '{}', 'x')").run(GUID);
    expect(days()).toEqual([`day:${GUID}:2026-10-24`]);
    d.prepare("insert into kv(k, v, updated_at) values('rebuilt:' || ? || ':2026-10-24', '{}', 'x')").run(GUID);
    expect(days()).toEqual([]); // hecho una vez, no se repite
  });
});
