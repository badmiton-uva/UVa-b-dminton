import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, Hub } from '../src/api';
import { settings } from '../src/config';
import { buildDigest, sendDigests } from '../src/digest';
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

describe('resumen semanal', () => {
  const unsub = 'https://servidor.example/suscripcion/baja?i=1&t=x';

  it('cuenta partidos ganados y perdidos, medallas, noticias y próximos torneos solo de lo que se sigue', () => {
    const ana = buildDigest(state, { allTeam: false, playerIds: [1] }, '2026-11-01', '2026-11-08', unsub)!;
    expect(ana.subject).toBe('Club Bádminton UVa · 1 victoria y 0 derrotas esta semana');
    expect(ana.text).toContain('Victoria · Ana Prueba vs Pedro de la Torre · 21-15 21-14');
    expect(ana.text).not.toContain('Luis Prueba'); // no sigue a Luis
    expect(ana.text).toContain('🥉 Bronce · Individual masculino · -n4 · Ana Prueba');
    expect(ana.text).toContain('La UVa en Gijón');
    expect(ana.text).toContain('Torneo próximo');
    expect(ana.text).toContain(unsub);
    expect(ana.html).toContain('Darme de baja');
    const team = buildDigest(state, { allTeam: true, playerIds: [] }, '2026-11-01', '2026-11-08', unsub)!;
    expect(team.subject).toContain('1 victoria y 1 derrota');
    expect(team.text).toContain('Luis Prueba');
  });

  it('si no hay nada nuevo, no hay resumen (ni siquiera por haber un torneo próximo)', () => {
    expect(buildDigest(state, { allTeam: true, playerIds: [] }, '2026-11-08', '2026-11-08', unsub)).toBeUndefined();
    expect(buildDigest(state, { allTeam: false, playerIds: [2] }, '2026-11-08', '2026-11-08', unsub)).toBeUndefined(); // Luis jugó el 7 y desde el 8 no hay nada nuevo
    expect(buildDigest(state, { allTeam: false, playerIds: [2] }, '2026-11-07', '2026-11-08', unsub)?.text).toContain('La UVa en Gijón'); // pero la noticia del 8 sí es nueva para él
  });

  it('se envía el domingo a las 21:00 de Madrid, una vez al día por persona, con la cabecera de baja con un clic; un fallo no frena a los demás', async () => {
    const db = memDb();
    const out = new Outbox();
    for (const e of ['a@example.com', 'b@example.com']) await requestSubscription(db, state, { email: e, consent: true, all: true }, out, new Date('2026-11-02T10:00:00Z'));
    for (const m of out.sent.splice(0)) confirmSubscription(db, Number(link(m)[1]), link(m)[2], new Date('2026-11-03T10:00:00Z'));
    db.prepare("update subscribers set last_digest_date = '2026-11-01'").run();
    expect(await sendDigests(db, state, new Date('2026-11-08T19:30:00Z'), out)).toBe(0); // domingo 20:30
    expect(await sendDigests(db, state, new Date('2026-11-07T20:10:00Z'), out)).toBe(0); // sábado 21:10
    expect(await sendDigests(db, state, new Date('2026-11-08T20:10:00Z'), out)).toBe(2); // domingo 21:10
    expect(out.sent.map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(out.sent[0].headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/servidor\.example\/suscripcion\/baja\?i=\d+&t=[0-9a-f]+>$/);
    expect(out.sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(await sendDigests(db, state, new Date('2026-11-08T20:30:00Z'), out)).toBe(0); // ya enviado hoy
    // Un proveedor que falla con una dirección no frena a las demás.
    const db2 = memDb();
    const o2 = new Outbox();
    for (const e of ['mala@example.com', 'buena@example.com']) await requestSubscription(db2, state, { email: e, consent: true, all: true }, o2, new Date('2026-11-02T10:00:00Z'));
    for (const m of o2.sent.splice(0)) confirmSubscription(db2, Number(link(m)[1]), link(m)[2], new Date('2026-11-03T10:00:00Z'));
    db2.prepare("update subscribers set last_digest_date = '2026-11-01'").run();
    const flaky: Mailer = { send: async (m) => { if (m.to.startsWith('mala')) throw new Error('rechazado'); o2.sent.push(m); } };
    expect(await sendDigests(db2, state, new Date('2026-11-08T20:10:00Z'), flaky)).toBe(1);
    expect(o2.sent.map((m) => m.to)).toEqual(['buena@example.com']);
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
