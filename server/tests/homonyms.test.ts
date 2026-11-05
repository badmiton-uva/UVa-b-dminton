import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../src/engine';
import { createPlayer, findByNameLoose, listPlayers } from '../src/roster';
import { findClubEntrants } from '../src/uva';
import { buildPublicState } from '../src/publicView';
import { FakeSource, GUID, memDb, PROFILE } from './helpers/fakes';

describe('homónimos: sin el segundo apellido no se da por buena una coincidencia', () => {
  const db = memDb();
  const javi = createPlayer(db, { name: 'Javier Gonzalez Martin', profile: PROFILE, public: true, consentBy: 'Él', consentAt: '2026-10-01' });
  const roster = listPlayers(db);

  it('un nombre oficial más corto que el de la lista solo vale si se permite expresamente', () => {
    expect(findByNameLoose(roster, 'Javier Gonzalez')?.id).toBe(javi.id); // comportamiento heredado (con perfil oficial que lo confirme)
    expect(findByNameLoose(roster, 'Javier Gonzalez', { shorterOk: false })).toBeUndefined();
    expect(findByNameLoose(roster, 'Javier Gonzalez Martin', { shorterOk: false })?.id).toBe(javi.id);
    expect(findByNameLoose(roster, 'Javier Gonzalez Martin Lopez', { shorterOk: false })?.id).toBe(javi.id); // más largo: sí
  });

  it('un participante sin club llamado «Javier Gonzalez» no es de la UVa; con el club de la UVA, sí', () => {
    const sinClub = findClubEntrants([{ names: ['Javier Gonzalez'], ids: [13], club: undefined }] as never, roster);
    expect(sinClub).toEqual([]);
    const otroClub = findClubEntrants([{ names: ['Javier Gonzalez'], ids: [13], club: 'CB Gijón' }] as never, roster);
    expect(otroClub).toEqual([]);
    const conClub = findClubEntrants([{ names: ['Javier Gonzalez'], ids: [13], club: 'Universidad de Valladolid' }] as never, roster);
    expect(conClub.map((f) => f.rosterId)).toEqual([javi.id]);
    const completo = findClubEntrants([{ names: ['Javier Gonzalez Martin'], ids: [14], club: undefined }] as never, roster);
    expect(completo.map((f) => f.rosterId)).toEqual([javi.id]);
  });

  it('limpia lo asociado por error antes: su participación, sus partidos y sus inscripciones desaparecen; lo confirmado se queda', () => {
    const d = memDb();
    const p = createPlayer(d, { name: 'Javier Gonzalez Martin', profile: PROFILE, public: true, consentBy: 'Él', consentAt: '2026-10-01' });
    const q = createPlayer(d, { name: 'Ana Prueba', profile: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEE1', public: true, consentBy: 'Ella', consentAt: '2026-10-01' });
    d.prepare('insert into tournaments(guid, name, start_date, end_date, city, discovered_at, info_ok_at) values(?,?,?,?,?,?,?)').run(GUID, 'Guadarrama', '2026-11-01', '2026-11-01', 'Guadarrama', 'x', 'x');
    d.prepare('insert into tournament_players(tournament_guid, player_id) values(?,?),(?,?)').run(GUID, p.id, GUID, q.id);
    const ent = d.prepare('insert into entrants(tournament_guid, ts_player_id, name, club, player_id, seen_at) values(?,?,?,?,?,?)');
    ent.run(GUID, 13, 'Javier Gonzalez', null, p.id, 'x'); // homónimo asociado por nombre corto
    ent.run(GUID, 20, 'Ana Prueba', null, q.id, 'x'); // confirmado (nombre completo)
    d.prepare('insert into entries(tournament_guid, event_id, event_name, player_id, status, seen_at) values(?,?,?,?,?,?)').run(GUID, 1, 'IM', p.id, 'admitted', 'x');
    const side = (id: number, uva: boolean, rosterId?: number) => ({ players: [{ name: 'X', tsPlayerId: id, uva, rosterId }] });
    const m = (key: string, a: ReturnType<typeof side>) => d.prepare('insert into matches(key, tournament_guid, date, json, hash, state, first_seen_at, updated_at, last_seen_at) values(?,?,?,?,?,?,?,?,?)').run(key, GUID, '2026-11-01', JSON.stringify({ key, tournamentGuid: GUID, sides: [a, side(99, false)], sets: [], status: 'finished' }), 'h', 'finished', 'x', 'x', 'x');
    m('del-homonimo', side(13, true, p.id));
    m('de-ana', side(20, true, q.id));
    const e = new SyncEngine(d, new FakeSource());
    e.relinkEntrants();
    expect(d.prepare('select player_id from entrants where ts_player_id = 13').get()).toEqual({ player_id: null });
    expect(d.prepare('select count(*) n from tournament_players where player_id = ?').get(p.id)).toEqual({ n: 0 });
    expect(d.prepare('select count(*) n from entries').get()).toEqual({ n: 0 });
    expect((d.prepare('select key from matches').all() as { key: string }[]).map((r) => r.key)).toEqual(['de-ana']);
    expect(d.prepare('select player_id from entrants where ts_player_id = 20').get()).toEqual({ player_id: q.id }); // lo confirmado no se toca
    expect(buildPublicState(d, new Date('2026-11-05T12:00:00Z')).tournaments.flatMap((t) => t.uvaPlayers)).not.toContain('Javier Gonzalez Martin');
  });
});
