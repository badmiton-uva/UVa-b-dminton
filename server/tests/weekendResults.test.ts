import { beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/config';
import type { PublicMatch, PublicState, PublicTournament } from '../src/publicView';
import { resultsText, sendWeekendResults } from '../src/weekendResults';
import { memDb } from './helpers/fakes';

const m = (id: string, players: string[], plannedStart: string, extra: Partial<PublicMatch> = {}): PublicMatch =>
  ({ id, state: 'finished', players, event: 'IM-n4 · Grupo H', date: '2026-11-07', plannedStart, ...extra }) as PublicMatch;
const T = {
  id: 'G1', name: 'Master Gijón', startDate: '2026-11-07', endDate: '2026-11-08', city: 'Gijón', manual: false, uvaPlayers: ['Ana Prueba', 'Luis Prueba'], draws: [], entries: [], stale: false,
  record: { won: 2, lost: 1, gold: 0, silver: 0, bronze: 1 },
  progress: { done: false },
  results: [{ event: 'IM-n4', entrant: 'Ana Prueba', place: 3, text: 'Bronce', done: true }, { event: 'DM-n4', entrant: 'Luis Prueba / Eva Prueba', text: 'Pasa a Final', done: false }],
  matches: [
    m('a', ['Ana Prueba'], '2026-11-07T08:30:00Z', { outcome: 'win', score: '21-15 21-14', opponent: 'Pedro de la Torre', court: '4' }),
    m('b', ['Ana Prueba'], '2026-11-07T10:00:00Z', { outcome: 'loss', score: '15-21 18-21' }),
    m('c', ['Luis Prueba'], '2026-11-08T09:00:00Z', { state: 'scheduled', date: '2026-11-08', estimatedStart: '2026-11-08T09:20:00Z' }),
  ],
} as unknown as PublicTournament;
const state = (t: PublicTournament) => ({ tournaments: [t] }) as unknown as PublicState;
const ok = (sent: { url: string; body: Record<string, string> }[]) => (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  settings.weekendResults.email = 'club@example.com';
  settings.weekendResults.weekday = 0;
  settings.weekendResults.hour = 15;
  settings.weekendResults.windowMin = 180;
  settings.itinerary.baseUrl = 'https://servidor.example';
});

describe('resultados del finde por correo', () => {
  it('el texto trae el balance, las medallas, el partido a partido por jugador y un mensaje para redes con los enlaces de las imágenes', () => {
    const txt = resultsText(T, 'https://web.example', 'https://servidor.example');
    expect(txt).toContain('RESULTADOS DEL FINDE · Master Gijón');
    expect(txt).toContain('EL TORNEO SIGUE EN JUEGO'); // hay un partido pendiente
    expect(txt).toContain('BALANCE DEL CLUB: 1 victoria y 1 derrota; 1 partido por jugar.');
    expect(txt).toContain('BRONCE · Individual masculino · -n4 · Ana Prueba');
    expect(txt).toContain('V 21-15 21-14 vs Pedro de la Torre · IM-n4 · Grupo H · Pista 4');
    expect(txt).toContain('D 15-21 18-21');
    expect(txt).toContain('pendiente a las 10:20 (estimada)');
    expect(txt).toContain('MENSAJE PARA REDES (copia y pega):');
    expect(txt).toContain('#ClubBadmintonUVA');
    expect(txt).toContain('https://servidor.example/og/resultados/G1.png?size=square');
    expect(txt).toContain('https://servidor.example/og/resultados/G1.png?size=story');
  });

  it('se envía el domingo a las 15:00 de Madrid (no antes, no otro día), una sola vez, y solo si ya hay partidos jugados', async () => {
    const db = memDb();
    const sent: { url: string; body: Record<string, string> }[] = [];
    const fetchImpl = ok(sent);
    expect(await sendWeekendResults(db, state(T), new Date('2026-11-07T14:05:00Z'), { fetchImpl })).toBe(0); // sábado
    expect(await sendWeekendResults(db, state(T), new Date('2026-11-08T13:59:00Z'), { fetchImpl })).toBe(0); // domingo 14:59
    expect(await sendWeekendResults(db, state(T), new Date('2026-11-08T14:01:00Z'), { fetchImpl })).toBe(1); // domingo 15:01
    expect(sent[0].url).toBe('https://formsubmit.co/ajax/club@example.com');
    expect(sent[0].body._subject).toBe('Resultados del finde · Master Gijón · mensaje para redes');
    expect(sent[0].body.mensaje).toContain('MENSAJE PARA REDES');
    expect(await sendWeekendResults(db, state(T), new Date('2026-11-08T14:10:00Z'), { fetchImpl })).toBe(0); // ya enviado
    const none = { ...T, matches: [T.matches[2]] } as unknown as PublicTournament; // nada jugado todavía
    expect(await sendWeekendResults(memDb(), state(none), new Date('2026-11-08T14:01:00Z'), { fetchImpl })).toBe(0);
    const old = { ...T, startDate: '2026-10-24', endDate: '2026-10-25' } as unknown as PublicTournament; // torneo de hace dos semanas
    expect(await sendWeekendResults(memDb(), state(old), new Date('2026-11-08T14:01:00Z'), { fetchImpl })).toBe(0);
  });

  it('si el correo falla se reintenta; fuera de la ventana ya no; con WEEKEND_RESULTS_EMAIL=off no hace nada', async () => {
    const db = memDb();
    const bad = (async () => ({ ok: false, status: 522 })) as unknown as typeof fetch;
    await expect(sendWeekendResults(db, state(T), new Date('2026-11-08T14:02:00Z'), { fetchImpl: bad })).rejects.toThrow();
    expect(await sendWeekendResults(db, state(T), new Date('2026-11-08T14:03:00Z'), { fetchImpl: ok([]) })).toBe(1);
    expect(await sendWeekendResults(memDb(), state(T), new Date('2026-11-08T18:30:00Z'), { fetchImpl: ok([]) })).toBe(0); // 19:30 de Madrid
    settings.weekendResults.email = '';
    expect(await sendWeekendResults(memDb(), state(T), new Date('2026-11-08T14:03:00Z'))).toBe(0);
  });
});
