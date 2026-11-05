import { beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/config';
import type { PublicMatch, PublicState, PublicTournament } from '../src/publicView';
import { previewText, sendWeekendPreviews } from '../src/weekendPreview';
import { memDb } from './helpers/fakes';

const m = (id: string, players: string[], plannedStart: string, extra: Partial<PublicMatch> = {}): PublicMatch =>
  ({ id, state: 'scheduled', players, event: 'IM-n4 · Grupo H', date: '2026-11-07', plannedStart, ...extra }) as PublicMatch;
const T = {
  id: 'G1', name: 'Master Gijón', startDate: '2026-11-07', endDate: '2026-11-08', city: 'Gijón', manual: false, uvaPlayers: [], results: [], draws: [], stale: false,
  entries: [{ player: 'Ana Prueba', event: 'IM', status: 'admitted' }],
  matches: [
    m('b', ['Luis Prueba', 'Eva Prueba'], '2026-11-07T09:30:00Z', { event: 'DM · Grupo D', estimatedStart: '2026-11-07T09:41:00Z' }),
    m('a', ['Ana Prueba'], '2026-11-07T08:30:00Z', { estimatedStart: '2026-11-07T08:22:00Z', court: '4', opponent: 'Pedro de la Torre' }),
    m('c', ['Ana Prueba'], '2026-11-07T13:00:00Z'),
  ],
} as unknown as PublicTournament;
const state = (t: PublicTournament) => ({ tournaments: [t] }) as unknown as PublicState;
const ok = (sent: { url: string; body: Record<string, string> }[]) => (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  settings.weekendPreview.email = 'club@example.com';
  settings.weekendPreview.weekday = 4;
  settings.weekendPreview.hour = 15;
  settings.weekendPreview.windowMin = 180;
});

describe('previa del finde por correo', () => {
  it('el texto dice quién juega primero, la hora estimada y la oficial, pista, rival y cuántos partidos más tiene cada persona', () => {
    const txt = previewText(T, 'https://web.example');
    expect(txt).toContain('PRIMER PARTIDO DEL CLUB: sáb 7 nov 09:22 (estimada; oficial 09:30) · Ana Prueba');
    expect(txt).toContain('- Ana Prueba: sáb 7 nov 09:22 (estimada; oficial 09:30) · IM-n4 · Grupo H · Pista 4 · vs Pedro de la Torre (+1 partido más programado)');
    expect(txt).toContain('- Luis Prueba: sáb 7 nov 10:41 (estimada; oficial 10:30) · DM · Grupo D (con Eva Prueba)');
    expect(txt.indexOf('Ana Prueba:')).toBeLessThan(txt.indexOf('Luis Prueba:')); // por orden de hora
    expect(txt).toContain('https://web.example/directo');
  });

  it('sin orden de juego publicado, lo dice y lista a los inscritos', () => {
    const txt = previewText({ ...T, matches: [] } as unknown as PublicTournament, 'https://web.example');
    expect(txt).toContain('Todavía no está publicado el orden de juego');
    expect(txt).toContain('Ana Prueba');
  });

  it('se envía el jueves a las 15:00 de Madrid (no antes, no otro día), una sola vez por torneo', async () => {
    const db = memDb();
    const sent: { url: string; body: Record<string, string> }[] = [];
    const fetchImpl = ok(sent);
    // Miércoles 4 y jueves 5 de noviembre de 2026 (CET = UTC+1).
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-04T14:05:00Z'), { fetchImpl })).toBe(0); // miércoles
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-05T13:59:00Z'), { fetchImpl })).toBe(0); // jueves 14:59
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-05T14:01:00Z'), { fetchImpl })).toBe(1); // jueves 15:01
    expect(sent[0].url).toBe('https://formsubmit.co/ajax/club@example.com');
    expect(sent[0].body._subject).toBe('Previa del finde · Master Gijón · primeros partidos de la UVa');
    expect(sent[0].body.mensaje).toContain('PRIMER PARTIDO DEL CLUB');
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-05T14:05:00Z'), { fetchImpl })).toBe(0); // ya enviado
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-05T18:30:00Z'), { fetchImpl })).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('si el correo falla se reintenta el minuto siguiente; fuera de la ventana ya no; y no manda torneos lejanos ni sin nada', async () => {
    const db = memDb();
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(sendWeekendPreviews(db, state(T), new Date('2026-11-05T14:02:00Z'), { fetchImpl: bad })).rejects.toThrow();
    const sent: { url: string; body: Record<string, string> }[] = [];
    expect(await sendWeekendPreviews(db, state(T), new Date('2026-11-05T14:03:00Z'), { fetchImpl: ok(sent) })).toBe(1);
    expect(await sendWeekendPreviews(memDb(), state(T), new Date('2026-11-05T17:30:00Z'), { fetchImpl: ok([]) })).toBe(0); // 18:30 de Madrid: fuera de la ventana de 3 h
    const far = { ...T, startDate: '2026-11-21' } as unknown as PublicTournament;
    expect(await sendWeekendPreviews(memDb(), state(far), new Date('2026-11-05T14:03:00Z'), { fetchImpl: ok([]) })).toBe(0);
    const empty = { ...T, matches: [], entries: [] } as unknown as PublicTournament;
    expect(await sendWeekendPreviews(memDb(), state(empty), new Date('2026-11-05T14:03:00Z'), { fetchImpl: ok([]) })).toBe(0);
  });

  it('con WEEKEND_PREVIEW_EMAIL=off no hace nada', async () => {
    settings.weekendPreview.email = '';
    expect(await sendWeekendPreviews(memDb(), state(T), new Date('2026-11-05T14:03:00Z'))).toBe(0);
  });
});
