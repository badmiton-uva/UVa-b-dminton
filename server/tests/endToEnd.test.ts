import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, Hub } from '../src/api';
import { settings } from '../src/config';
import { todayIn } from '../src/dates';
import { SyncEngine } from '../src/engine';
import { createPlayer } from '../src/roster';
import { FakeSource, info, memDb, PROFILE, row } from './helpers/fakes';

const TODAY = todayIn('Europe/Madrid', new Date());

describe('de badminton.es a la web: se lee el cambio y se avisa a los navegadores', () => {
  const db = memDb();
  const hub = new Hub(db);
  const src = new FakeSource();
  const server = http.createServer(createApp(db, undefined, hub));
  let base = '';
  const START = Date.now();
  let step = 0;
  const engine = new SyncEngine(db, src, () => new Date(START + step * 5_000));

  beforeAll(async () => {
    settings.officialReadEnabled = true;
    settings.publicCacheMs = 10_000;
    src.infoData = info({ startDate: TODAY, endDate: TODAY, days: [TODAY] });
    src.dayRows = [row({ date: TODAY, status: 'on_court' })];
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, consentBy: 'Ella misma', consentAt: '2026-10-01' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  /** Un «tick» del servidor cada 5 s simulados, igual que el bucle real (tick + aviso a los navegadores). */
  const pump = async (seconds: number, until?: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < seconds / 5; i++) {
      step++;
      if (await engine.tick()) hub.check();
      await new Promise((r) => setImmediate(r));
      if (await until?.()) return;
    }
  };
  const matchState = async () => {
    const s = (await (await fetch(`${base}/api/public/state`, { headers: { 'Cache-Control': 'no-cache' } })).json()) as { tournaments: { matches: { state: string }[] }[] };
    return s.tournaments[0]?.matches?.[0]?.state;
  };

  it('un resultado nuevo llega al navegador (aviso SSE + estado público) en pocos minutos y relee los cuadros', async () => {
    await pump(10 * 60, () => src.calls.includes('day') && src.calls.includes('draws'));
    await pump(60);
    expect(await matchState()).toBe('live');

    // Un navegador conectado al flujo de avisos.
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/public/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let received = '';
    void (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true, value: undefined })); if (r.done) return; received += new TextDecoder().decode(r.value); } })();
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toContain('event: hello');

    // El partido termina en badminton.es.
    received = '';
    const drawsBefore = src.calls.filter((c) => c === 'draws').length;
    const t0 = step;
    src.dayRows = [row({ date: TODAY, status: 'finished', winner: 1, sets: [[21, 15], [21, 17]] })];
    await pump(8 * 60, async () => (await matchState()) === 'finished');
    await new Promise((r) => setTimeout(r, 20));
    const seconds = (step - t0) * 5;
    console.log(`Resultado nuevo → aviso al navegador en ${seconds} s (simulados)`);
    expect(received).toContain('event: update');
    expect(seconds).toBeLessThanOrEqual(5 * 60);
    expect(await matchState()).toBe('finished');

    // Además se releen los cuadros en pocos minutos (no esperan a su turno de 10 min).
    await pump(4 * 60, () => src.calls.filter((c) => c === 'draws').length > drawsBefore);
    expect(src.calls.filter((c) => c === 'draws').length).toBeGreaterThan(drawsBefore);
    ctrl.abort();
  });
});

describe('sin saturar a badminton.es', () => {
  it('en una jornada completa con un partido terminado cada pocos minutos, las lecturas por hora se mantienen muy por debajo del límite', async () => {
    const db = memDb();
    const src = new FakeSource();
    const START = Date.parse(`${TODAY}T09:00:00+01:00`);
    let step = 0;
    const clock = () => new Date(START + step * 5_000);
    src.infoData = info({ startDate: TODAY, endDate: TODAY, days: [TODAY] });
    createPlayer(db, { name: 'Ana Prueba', profile: PROFILE, public: true, consentBy: 'Ella misma', consentAt: '2026-10-01' });
    const rowsAt = (done: number) => Array.from({ length: 40 }, (_, i) => row({ key: `m${i}`, date: TODAY, names1: i === 0 ? [['Ana Prueba', 1]] : [[`Jugador ${i}`, 100 + i]], names2: [[`Rival ${i}`, 200 + i]], status: i < done ? 'finished' : i === done ? 'on_court' : 'scheduled', winner: i < done ? 1 : undefined, sets: i < done ? [[21, 10], [21, 12]] : [] }));
    src.dayRows = rowsAt(0);
    const engine = new SyncEngine(db, src, clock);
    const perHour: number[] = [];
    let last = 0;
    const HOURS = 8;
    for (let i = 0; i < (HOURS * 3600) / 5; i++) {
      step++;
      if (i % 96 === 0) src.dayRows = rowsAt(Math.min(40, Math.floor(i / 96))); // un partido terminado cada 8 min
      await engine.tick();
      if ((i + 1) % 720 === 0) { perHour.push(src.calls.length - last); last = src.calls.length; }
    }
    console.log(`Lecturas lógicas por hora en jornada: ${perHour.join(', ')}  (máx. posible a 2,5 s: 1440)`);
    expect(Math.max(...perHour)).toBeLessThan(240); // < 1 cada 15 s de media: por debajo de un 17 % de lo que permite el espaciado
  }, 30_000); // simula 8 h de lecturas: en el CI lento superaba los 5 s por defecto
});
