import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, Hub } from '../src/api';
import { settings } from '../src/config';
import { buildEmail, followedIn, midDue, sendUpdates } from '../src/updates';
import type { Mail, Mailer } from '../src/mailer';
import { realMailer } from '../src/mailer';
import type { PublicState } from '../src/publicView';
import { confirmSubscription, confirmUrl, listConfirmed, normalizeEmail, pruneSubscribers, requestSubscription, SubscribeError, tokenFor, unsubscribe, unsubscribeUrl } from '../src/subscribers';
import { memDb } from './helpers/fakes';

const state = {
  players: [{ id: 1, name: 'Ana Prueba' }, { id: 2, name: 'Luis Prueba' }],
  news: [{ id: 'n1', date: '2026-11-08', tag: 'Torneo', title: 'La UVa en Gijón', summary: 'Así quedaron.', tournament: { name: 'Gijón' }, tournamentGuid: 'G1', sources: [], auto: true }],
  tournaments: [
    {
      id: 'G1', name: 'Master Gijón', startDate: '2026-11-07', endDate: '2026-11-08', city: 'Gijón', uvaPlayers: ['Ana Prueba', 'Luis Prueba'],
      results: [{ event: 'IM-n4', entrant: 'Ana Prueba', place: 3, text: 'Bronce', done: true }],
      matches: [
        { id: 'a', state: 'finished', players: ['Ana Prueba'], date: '2026-11-07', outcome: 'win', score: '21-15 21-14', opponent: 'Pedro de la Torre', event: 'IM-n4', plannedStart: '2026-11-07T08:30:00Z' },
        { id: 'b', state: 'finished', players: ['Luis Prueba'], date: '2026-11-07', outcome: 'loss', score: '10-21 12-21', event: 'IM-n4', plannedStart: '2026-11-07T09:30:00Z' },
      ],
    },
    { id: 'G2', name: 'Torneo próximo', startDate: '2026-11-14', city: 'Madrid', uvaPlayers: ['Ana Prueba'], results: [], matches: [] },
  ],
} as unknown as PublicState;

class Outbox implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) { this.sent.push(m); }
}

beforeEach(() => {
  settings.itinerary.baseUrl = 'https://servidor.example';
  settings.subscriptions.cooldownMin = 10;
  settings.subscriptions.max = 3000;
});

const NOW = new Date('2026-11-05T12:00:00Z');
const link = (m: Mail) => /https:\/\/servidor\.example\/suscripcion\/confirmar\?i=(\d+)&t=([0-9a-f]+)/.exec(m.text)!;

describe('suscripción por correo (doble confirmación)', () => {
  it('valida el correo, exige consentimiento y una selección, y no se fía de campos trampa', async () => {
    const db = memDb();
    const out = new Outbox();
    expect(() => normalizeEmail('no-es-un-correo')).toThrow(SubscribeError);
    expect(() => normalizeEmail('a@b')).toThrow(SubscribeError);
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    await expect(requestSubscription(db, state, { email: 'ana@example.com', all: true }, out, NOW)).rejects.toThrow(/aceptar/);
    await expect(requestSubscription(db, state, { email: 'ana@example.com', consent: true }, out, NOW)).rejects.toThrow(/todo el equipo|al menos/);
    await expect(requestSubscription(db, state, { email: 'ana@example.com', consent: true, players: [999] }, out, NOW)).rejects.toThrow(/al menos/); // jugador que no es público
    await requestSubscription(db, state, { email: 'robot@example.com', consent: true, all: true, website: 'http://spam' }, out, NOW);
    expect(out.sent).toHaveLength(0); // los robots rellenan el campo trampa
    expect(db.prepare('select count(*) n from subscribers').get()).toEqual({ n: 0 });
  });

  it('no vale hasta confirmar: se envía el enlace, y al abrirlo se aplica la selección', async () => {
    const db = memDb();
    const out = new Outbox();
    await requestSubscription(db, state, { email: 'Ana@Example.com', consent: true, players: [1, 999] }, out, NOW);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0].to).toBe('ana@example.com');
    expect(out.sent[0].text).toContain('Ana Prueba');
    expect(listConfirmed(db)).toEqual([]); // sin confirmar no recibe nada
    const [, id, token] = link(out.sent[0]);
    expect(confirmSubscription(db, Number(id), 'mal-token', NOW)).toBeUndefined();
    expect(confirmSubscription(db, Number(id), token, NOW)).toEqual({ email: 'ana@example.com' });
    const [sub] = listConfirmed(db);
    expect(sub).toMatchObject({ email: 'ana@example.com', allTeam: false, playerIds: [1], lastDigestDate: '2026-10-29' }); // el primer resumen cubre la última semana
  });

  it('cambiar lo que se sigue también pide confirmar (nadie puede cambiar la suscripción de otra persona), con un mínimo entre correos', async () => {
    const db = memDb();
    const out = new Outbox();
    await requestSubscription(db, state, { email: 'ana@example.com', consent: true, players: [1] }, out, NOW);
    const [, id, token] = link(out.sent[0]);
    confirmSubscription(db, Number(id), token, NOW);
    await requestSubscription(db, state, { email: 'ana@example.com', consent: true, all: true }, out, new Date(NOW.getTime() + 60_000)); // demasiado pronto: sin correo
    expect(out.sent).toHaveLength(1);
    await requestSubscription(db, state, { email: 'ana@example.com', consent: true, all: true }, out, new Date(NOW.getTime() + 11 * 60_000));
    expect(out.sent).toHaveLength(2);
    expect(out.sent[1].subject).toContain('cambio');
    expect(listConfirmed(db)[0].playerIds).toEqual([1]); // todavía vale lo anterior
    confirmSubscription(db, Number(id), token, NOW);
    expect(listConfirmed(db)[0]).toMatchObject({ allTeam: true, playerIds: [] });
  });

  it('darse de baja borra todo; los enlaces no valen para otra persona ni otra acción; y lo no confirmado caduca a los 7 días', async () => {
    const db = memDb();
    const out = new Outbox();
    await requestSubscription(db, state, { email: 'ana@example.com', consent: true, all: true }, out, NOW);
    await requestSubscription(db, state, { email: 'luis@example.com', consent: true, all: true }, out, NOW);
    const [, id, token] = link(out.sent[0]);
    confirmSubscription(db, Number(id), token, NOW);
    expect(unsubscribe(db, Number(id), token)).toBe(false); // el token de confirmar no vale para darse de baja
    expect(unsubscribe(db, Number(id), tokenFor(db, Number(id), 'u'))).toBe(true);
    expect(db.prepare('select count(*) n from subscribers where email = ?').get('ana@example.com')).toEqual({ n: 0 });
    expect(pruneSubscribers(db, new Date(NOW.getTime() + 8 * 86_400_000))).toBe(1); // Luis nunca confirmó
    expect(db.prepare('select count(*) n from subscribers').get()).toEqual({ n: 0 });
    expect(confirmUrl(db, 5)).toContain('/suscripcion/confirmar?i=5&t=');
    expect(unsubscribeUrl(db, 5)).toContain('/suscripcion/baja?i=5&t=');
  });

  it('el tope de suscripciones se respeta', async () => {
    const db = memDb();
    settings.subscriptions.max = 1;
    await requestSubscription(db, state, { email: 'a@example.com', consent: true, all: true }, new Outbox(), NOW);
    await expect(requestSubscription(db, state, { email: 'b@example.com', consent: true, all: true }, new Outbox(), NOW)).rejects.toThrow(/más suscripciones/);
  });
});

describe('avisos de torneo: a media jornada y al final, agrupados', () => {
  const T = (extra: object = {}) => ({
    id: 'G1', name: 'Master Gijón', startDate: '2026-11-07', endDate: '2026-11-08', city: 'Gijón', uvaPlayers: ['Ana Prueba', 'Luis Prueba'], entries: [],
    progress: { date: '2026-11-07', total: 60, finished: 30, live: 4, remaining: 26, done: false, estimatedEnd: '2026-11-07T17:30:00Z' },
    results: [{ event: 'IM-n4', entrant: 'Ana Prueba', place: 3, text: 'Bronce', done: true }],
    matches: [
      { id: 'a', state: 'finished', players: ['Ana Prueba'], date: '2026-11-07', outcome: 'win', score: '21-15 21-14', opponent: 'Pedro de la Torre', event: 'IM-n4 · Grupo H', plannedStart: '2026-11-07T08:30:00Z' },
      { id: 'b', state: 'live', players: ['Ana Prueba'], date: '2026-11-07', opponent: 'Eva Gil', event: 'DM-n4', court: '3', plannedStart: '2026-11-07T11:00:00Z' },
      { id: 'c', state: 'scheduled', players: ['Ana Prueba'], date: '2026-11-07', opponent: 'Marta Ruiz', event: 'IM-n4 · Octavos', plannedStart: '2026-11-07T13:00:00Z', estimatedStart: '2026-11-07T13:20:00Z' },
      { id: 'd', state: 'finished', players: ['Luis Prueba'], date: '2026-11-07', outcome: 'loss', score: '10-21 12-21', event: 'IM-n4', plannedStart: '2026-11-07T09:30:00Z' },
    ],
    ...extra,
  });
  const day1 = (...ts: object[]) => ({ ...state, tournaments: ts, news: [{ id: 'n', date: '2026-11-08', tag: 'Torneo', title: 'La UVa en Gijón', summary: 'Así quedaron.', tournament: { name: 'Gijón' }, tournamentGuid: 'G1', sources: [], auto: true }] }) as unknown as PublicState;
  const confirmed = async (db: ReturnType<typeof memDb>, email: string, input: object, at: Date) => {
    const out = new Outbox();
    await requestSubscription(db, state, { email, consent: true, ...input }, out, at);
    confirmSubscription(db, Number(link(out.sent[0])[1]), link(out.sent[0])[2], at);
  };
  const SAT = new Date('2026-11-07T13:00:00Z'); // sábado 14:00 de Madrid
  const FIN = new Date('2026-11-08T21:30:00Z'); // domingo 22:30

  it('«a media jornada» solo entre el 40 y el 80 % de los partidos y con el día en juego', () => {
    expect(midDue(T() as never, '2026-11-07')).toBe(true);
    expect(midDue(T({ progress: { date: '2026-11-07', total: 60, finished: 10, done: false } }) as never, '2026-11-07')).toBe(false); // aún pronto
    expect(midDue(T({ progress: { date: '2026-11-07', total: 60, finished: 55, done: false } }) as never, '2026-11-07')).toBe(false); // casi acabado
    expect(midDue(T({ progress: { date: '2026-11-07', total: 60, finished: 30, done: true } }) as never, '2026-11-07')).toBe(false);
    expect(midDue(T({ progress: { date: '2026-11-07', total: 8, finished: 4, done: false } }) as never, '2026-11-07')).toBe(false); // torneo muy pequeño
  });

  it('con un jugador: cómo va, contra quién juega, si ganó o no y qué toca después; lo de otros jugadores no sale', async () => {
    const db = memDb();
    await confirmed(db, 'ana@example.com', { players: [1] }, new Date('2026-11-01T10:00:00Z'));
    const out = new Outbox();
    expect(await sendUpdates(db, day1(T()), SAT, out)).toBe(1);
    expect(out.sent).toHaveLength(1);
    const m = out.sent[0];
    expect(m.subject).toBe('Ana Prueba: así va en Master Gijón'); // un solo jugador: su nombre en el asunto
    expect(m.text).toContain('LO MÁS IMPORTANTE\n   ★ 🥉 Bronce en Individual masculino · -n4'); // lo importante, arriba
    expect(m.text.indexOf('LO MÁS IMPORTANTE')).toBeLessThan(m.text.indexOf('PARTIDO A PARTIDO'));
    expect(m.text).toContain('★ Balance: 1 victoria y 0 derrotas');
    expect(m.text).toContain('✅ Ganó contra Pedro de la Torre: 21-15 21-14 (IM-n4 · Grupo H');
    expect(m.text).toContain('🟢 Juega ahora contra Eva Gil');
    expect(m.text).toContain('⏭ Siguiente: 14:20 (estimada) contra Marta Ruiz');
    expect(m.text).toContain('va por 30 de 60 partidos');
    expect(m.text).not.toContain('Luis Prueba'); // no lo sigue
    expect(m.headers?.['List-Unsubscribe']).toContain('/suscripcion/baja');
    expect(await sendUpdates(db, day1(T()), new Date(SAT.getTime() + 60_000), out)).toBe(0); // un solo aviso a media jornada por torneo
  });

  it('con todo el equipo: un correo a media jornada y otro al final con medallas y noticia; nada en medio', async () => {
    const db = memDb();
    await confirmed(db, 'club@example.com', { all: true }, new Date('2026-11-01T10:00:00Z'));
    const out = new Outbox();
    expect(await sendUpdates(db, day1(T()), SAT, out)).toBe(1);
    expect(out.sent[0].text).toContain('ANA PRUEBA');
    expect(out.sent[0].text).toContain('LUIS PRUEBA');
    const over = T({ progress: { date: '2026-11-08', total: 90, finished: 90, done: true } });
    expect(await sendUpdates(db, day1(T()), new Date('2026-11-07T19:00:00Z'), out)).toBe(0); // sábado por la tarde: ya se avisó de la media jornada y el torneo sigue
    expect(await sendUpdates(db, day1(over), FIN, out)).toBe(1);
    expect(out.sent[1].subject).toBe('UVa en Master Gijón: resultados finales'); // varios jugadores: asunto del torneo
    expect(out.sent[1].text).toContain('🥉 Bronce');
    expect(out.sent[1].text).toContain('La UVa en Gijón');
    expect(await sendUpdates(db, day1(over), new Date(FIN.getTime() + 60_000), out)).toBe(0);
    expect(out.sent).toHaveLength(2); // dos correos en todo el torneo
  });

  it('si coinciden varios torneos, van juntos en un solo correo; y como mucho 2 al día', async () => {
    const db = memDb();
    await confirmed(db, 'club@example.com', { all: true }, new Date('2026-11-01T10:00:00Z'));
    const t2 = T({ id: 'G2', name: 'Otro torneo', news: undefined });
    const out = new Outbox();
    expect(await sendUpdates(db, day1(T(), t2), SAT, out)).toBe(1);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0].subject).toBe('Club Bádminton UVa: así van los torneos');
    expect(out.sent[0].text).toContain('MASTER GIJÓN');
    expect(out.sent[0].text).toContain('OTRO TORNEO');
    // Tope diario: con 2 correos ya enviados hoy, no se manda un tercero.
    db.prepare("insert into subscriber_mails(subscriber_id, tournament_guid, kind, sent_at) values(1, 'X', 'mid', ?), (1, 'Y', 'final', ?)").run(SAT.toISOString(), SAT.toISOString());
    const t3 = T({ id: 'G3', name: 'Tercero' });
    expect(await sendUpdates(db, day1(t3), new Date(SAT.getTime() + 3600_000), out)).toBe(0);
  });

  it('solo de 9:00 a 23:00; no se avisa de media jornada a quien se suscribió con el torneo empezado, pero sí del final; sin jugadores suyos no hay correo', async () => {
    const db = memDb();
    await confirmed(db, 'tarde@example.com', { all: true }, new Date('2026-11-07T10:00:00Z')); // se suscribe el sábado
    await confirmed(db, 'luis@example.com', { players: [2] }, new Date('2026-11-01T10:00:00Z'));
    const out = new Outbox();
    expect(await sendUpdates(db, day1(T()), new Date('2026-11-07T22:30:00Z'), out)).toBe(0); // 23:30 de Madrid: fuera de horario
    expect(await sendUpdates(db, day1(T()), SAT, out)).toBe(1); // solo Luis (el otro llegó con el torneo empezado)
    expect(out.sent[0].to).toBe('luis@example.com');
    const over = T({ progress: { date: '2026-11-08', total: 90, finished: 90, done: true } });
    expect(await sendUpdates(db, day1(over), FIN, out)).toBe(2); // el final llega a los dos
    const sinJugadores = memDb();
    await confirmed(sinJugadores, 'x@example.com', { players: [1] }, new Date('2026-11-01T10:00:00Z'));
    const o2 = new Outbox();
    expect(await sendUpdates(sinJugadores, day1(T({ uvaPlayers: ['Luis Prueba'], matches: [T().matches[3]] })), SAT, o2)).toBe(0); // Ana no juega en ese torneo
  });

  describe('hechos importantes de un jugador (eliminado, final, campeón)', () => {
    const live = (results: object[], matches: object[] = T().matches) => T({ progress: { date: '2026-11-07', total: 60, finished: 15, live: 4, done: false }, results, matches });
    const lost = { id: 'x', state: 'finished', players: ['Ana Prueba'], date: '2026-11-07', outcome: 'loss', score: '18-21 15-21', opponent: 'Eva Gil', event: 'DM-n4 · Octavos', plannedStart: '2026-11-07T12:00:00Z' };
    const early = new Date('2026-11-07T09:00:00Z'); // sábado 10:00: aún no toca la media jornada

    it('avisa cuando un jugador queda eliminado y ya no juega más en esa prueba, una sola vez, con el último partido', async () => {
      const db = memDb();
      await confirmed(db, 'ana@example.com', { players: [1] }, new Date('2026-11-01T10:00:00Z'));
      const out = new Outbox();
      const t = live([{ event: 'DM-n4', entrant: 'Ana Prueba / Eva Prueba', text: 'Cae en Octavos (16)', done: true }], [lost]);
      expect(await sendUpdates(db, day1(t), early, out)).toBe(1);
      expect(out.sent[0].subject).toBe('Ana Prueba queda eliminado en Dobles masculino · -n4');
      expect(out.sent[0].text).toContain('❌ Dobles masculino · -n4: Cae en Octavos (16)');
      expect(out.sent[0].text).toContain('Último partido: perdió contra Eva Gil (18-21 15-21)');
      expect(await sendUpdates(db, day1(t), new Date(early.getTime() + 60_000), out)).toBe(0); // ya avisado
    });

    it('avisa de que llega a la final y de que gana el torneo, pero no de cada partido ni a quien sigue a todo el equipo', async () => {
      const db = memDb();
      await confirmed(db, 'ana@example.com', { players: [1] }, new Date('2026-11-01T10:00:00Z'));
      await confirmed(db, 'club@example.com', { all: true }, new Date('2026-11-01T10:00:00Z'));
      const out = new Outbox();
      const finalMatch = { id: 'f', state: 'scheduled', players: ['Ana Prueba'], date: '2026-11-07', opponent: 'Marta Ruiz', event: 'IM-n4 · Final', court: '1', estimatedStart: '2026-11-07T13:30:00Z', plannedStart: '2026-11-07T13:00:00Z' };
      const t = live([{ event: 'IM-n4', entrant: 'Ana Prueba', text: 'Pasa a Final', done: false }], [finalMatch]);
      expect(await sendUpdates(db, day1(t), early, out)).toBe(1); // solo Ana; el equipo no recibe avisos sueltos
      expect(out.sent[0].to).toBe('ana@example.com');
      expect(out.sent[0].subject).toBe('¡Ana Prueba llega a la final de Individual masculino · -n4!');
      expect(out.sent[0].text).toContain('Siguiente: 14:30 (estimada) contra Marta Ruiz');
      const won = live([{ event: 'IM-n4', entrant: 'Ana Prueba', place: 1, text: 'Oro', score: '21-14 21-17', done: true }], [finalMatch]);
      expect(await sendUpdates(db, day1(won), new Date(early.getTime() + 3600_000), out)).toBe(1);
      expect(out.sent[1].subject).toBe('¡Ana Prueba gana Individual masculino · -n4!');
      expect(out.sent[1].text).toContain('🥇 ¡Campeón de Individual masculino · -n4! Final: 21-14 21-17');
    });

    it('no avisa a quien se suscribió con el torneo empezado, ni si el torneo ya terminó (entonces va en el correo final, junto)', async () => {
      const tarde = memDb();
      await confirmed(tarde, 'tarde@example.com', { players: [1] }, new Date('2026-11-07T08:00:00Z'));
      const t = live([{ event: 'DM-n4', entrant: 'Ana Prueba / Eva Prueba', text: 'Cae en Octavos (16)', done: true }], [lost]);
      expect(await sendUpdates(tarde, day1(t), early, new Outbox())).toBe(0);
      const db = memDb();
      await confirmed(db, 'ana@example.com', { players: [1] }, new Date('2026-11-01T10:00:00Z'));
      const out = new Outbox();
      const over = T({ progress: { date: '2026-11-08', total: 90, finished: 90, done: true }, results: [{ event: 'DM-n4', entrant: 'Ana Prueba / Eva Prueba', text: 'Cae en Octavos (16)', done: true }], matches: [lost] });
      expect(await sendUpdates(db, day1(over), FIN, out)).toBe(1);
      expect(out.sent).toHaveLength(1); // un solo correo: el final, con lo más importante dentro
      expect(out.sent[0].subject).toBe('Ana Prueba: resultados en Master Gijón');
    });

    it('tope de avisos distintos al día', async () => {
      const db = memDb();
      settings.subscriptions.maxAlertsPerDay = 1;
      await confirmed(db, 'ana@example.com', { players: [1, 2] }, new Date('2026-11-01T10:00:00Z'));
      const out = new Outbox();
      const t = live([{ event: 'DM-n4', entrant: 'Ana Prueba / Eva Prueba', text: 'Cae en Octavos (16)', done: true }, { event: 'IF-n1', entrant: 'Luis Prueba', text: 'Cae en Cuartos (8)', done: true }], [lost]);
      expect(await sendUpdates(db, day1(t), early, out)).toBe(1);
      expect(out.sent[0].subject).toContain('Novedades importantes'); // los dos hechos, juntos en un solo correo
      expect(out.sent[0].text).toContain('ANA PRUEBA');
      expect(await sendUpdates(db, day1(live([...(t.results as object[]), { event: 'IM-n4', entrant: 'Ana Prueba', text: 'Pasa a Final', done: false }])), new Date(early.getTime() + 600_000), out)).toBe(0); // tope: el nuevo espera a mañana
      settings.subscriptions.maxAlertsPerDay = 3;
    });
  });

  it('un fallo con una dirección no frena a las demás y se reintenta', async () => {
    const db = memDb();
    await confirmed(db, 'mala@example.com', { all: true }, new Date('2026-11-01T10:00:00Z'));
    await confirmed(db, 'buena@example.com', { all: true }, new Date('2026-11-01T10:00:00Z'));
    const sent: string[] = [];
    let fail = true;
    const flaky: Mailer = { send: async (m) => { if (m.to.startsWith('mala') && fail) throw new Error('rechazado'); sent.push(m.to); } };
    expect(await sendUpdates(db, day1(T()), SAT, flaky)).toBe(1);
    fail = false;
    expect(await sendUpdates(db, day1(T()), new Date(SAT.getTime() + 60_000), flaky)).toBe(1);
    expect(sent.sort()).toEqual(['buena@example.com', 'mala@example.com']);
  });

  it('followedIn y buildEmail: solo lo que sigue, y los dobles/medallas con su compañero', () => {
    expect(followedIn(day1(T()), { allTeam: false, playerIds: [1] }, T() as never)).toEqual(['Ana Prueba']);
    expect(followedIn(day1(T()), { allTeam: true, playerIds: [] }, T() as never)).toEqual(['Ana Prueba', 'Luis Prueba']);
    const e = buildEmail(day1(T()), [{ t: T() as never, kind: 'mid', names: ['Ana Prueba'] }], 'https://x/baja', 'Ana Prueba', '2026-11-07');
    expect(e.html).toContain('Darme de baja');
    expect(e.text).toContain('https://x/baja');
  });
});

describe('proveedor de correo y rutas HTTP', () => {
  it('sin configurar no hay proveedor; con Brevo o Resend se llama a su API con la clave y el remitente', async () => {
    settings.mail.provider = '';
    expect(realMailer()).toBeUndefined();
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => (calls.push({ url, init }), { ok: true, status: 201, text: async () => '' })) as unknown as typeof fetch;
    Object.assign(settings.mail, { provider: 'brevo', apiKey: 'KEY', from: 'club@example.com', fromName: 'Club' });
    await realMailer(f)!.send({ to: 'x@example.com', subject: 'S', text: 'T', html: '<p>H</p>', headers: { 'List-Unsubscribe': '<u>' } });
    expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(calls[0].init.headers['api-key']).toBe('KEY');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ sender: { email: 'club@example.com' }, to: [{ email: 'x@example.com' }], subject: 'S' });
    settings.mail.provider = 'resend';
    await realMailer(f)!.send({ to: 'x@example.com', subject: 'S', text: 'T', html: '<p>H</p>' });
    expect(calls[1].url).toBe('https://api.resend.com/emails');
    expect(calls[1].init.headers.authorization).toBe('Bearer KEY');
    settings.mail.provider = '';
  });

  describe('API', () => {
    const db = memDb();
    const out = new Outbox();
    const server = http.createServer(createApp(db, undefined, new Hub(db), out));
    const off = http.createServer(createApp(memDb(), undefined, new Hub(memDb())));
    let base = '';
    let baseOff = '';
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      baseOff = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections(); off.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => off.close(r))]);
    });
    const post = (b: string, body: unknown) => fetch(`${b}/api/public/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('el estado dice si están activadas; sin proveedor, el alta responde 503', async () => {
      expect(await (await fetch(`${base}/api/public/subscribe`)).json()).toEqual({ enabled: true });
      expect(await (await fetch(`${baseOff}/api/public/subscribe`)).json()).toEqual({ enabled: false });
      expect((await post(baseOff, { email: 'a@example.com', consent: true, all: true })).status).toBe(503);
    });

    it('alta → correo → página de confirmar con botón → confirmación; y baja con un clic o con página', async () => {
      const bad = await post(base, { email: 'no', consent: true, all: true });
      expect(bad.status).toBe(400);
      const ok = await post(base, { email: 'ana@example.com', consent: true, all: true });
      expect(ok.status).toBe(202);
      const mail = out.sent.at(-1)!;
      const [, id, token] = link(mail);
      const pageGet = await fetch(`${base}/suscripcion/confirmar?i=${id}&t=${token}`);
      expect(pageGet.status).toBe(200);
      expect(await pageGet.text()).toContain('<button'); // abrir el enlace no confirma: hace falta pulsar (los escáneres de correo no lo hacen)
      expect(listConfirmed(db)).toHaveLength(0);
      const conf = await fetch(`${base}/suscripcion/confirmar?i=${id}&t=${token}`, { method: 'POST' });
      expect(await conf.text()).toContain('Suscripción confirmada');
      expect(listConfirmed(db)).toHaveLength(1);
      expect((await fetch(`${base}/suscripcion/confirmar?i=${id}&t=mal`, { method: 'POST' })).status).toBe(400);
      const u = unsubscribeUrl(db, Number(id)).replace('https://servidor.example', base);
      expect(await (await fetch(u)).text()).toContain('Darme de baja'); // página con botón
      expect(listConfirmed(db)).toHaveLength(1);
      const oneClick = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      expect(oneClick.status).toBe(200);
      expect(listConfirmed(db)).toHaveLength(0);
    });
  });
});

describe('si el correo no sale', () => {
  it('no queda la suscripción a medias ni se bloquea el reintento', async () => {
    const db = memDb();
    const bad: Mailer = { send: async () => { throw new Error('proveedor caído'); } };
    await expect(requestSubscription(db, state, { email: 'ana@example.com', consent: true, all: true }, bad, NOW)).rejects.toThrow('proveedor caído');
    expect(db.prepare('select count(*) n from subscribers').get()).toEqual({ n: 0 });
    const out = new Outbox();
    await requestSubscription(db, state, { email: 'ana@example.com', consent: true, all: true }, out, new Date(NOW.getTime() + 1000)); // reintento inmediato
    expect(out.sent).toHaveLength(1);
  });
});

describe('CORS de las suscripciones desde la web publicada', () => {
  it('el preflight permite POST con JSON desde el origen del club y no desde otros', async () => {
    const db = memDb();
    const server = http.createServer(createApp(db, undefined, new Hub(db), new Outbox()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pre = (origin: string) => fetch(`${base}/api/public/subscribe`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    const ok = await pre('https://badmiton-uva.github.io');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://badmiton-uva.github.io');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect((await pre('https://otra-web.example')).headers.get('access-control-allow-origin')).toBeNull();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});
