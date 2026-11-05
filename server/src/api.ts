import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extractGuid } from './text';
import { settings } from './config';
import { type Db, nowIso } from './db';
import type { SyncEngine } from './engine';
import { kvGet } from './db';
import { buildPublicState, cachedPublicState, invalidatePublicState, type PublicMatch } from './publicView';
import { pushConfigured, subscribe, unsubscribe } from './push';
import { buildAccuracy } from './accuracy';
import { currentShift } from './calibration';
import type { Mailer } from './mailer';
import { confirmSubscription, requestSubscription, SubscribeError, subscriberCounts, unsubscribe as unsubscribeEmail } from './subscribers';
import { captureImage } from './itinerary';
import { learnedPriors, learnedTiming, loadPatterns } from './patterns';
import { defaultPriors } from './estimate';
import { cardVersion, findCard, metaOf, renderPng, shareHtmlPage, type CardKind, type Found } from './share';
import { rivalNamesFor } from './shareRivals';
import { decide, draftFor } from './chronicle';
import { buildSocial } from './social';
import { backupState } from './remoteBackup';
import { buildLiga, type LigaSnapshot } from './liga';
import { buildOverview } from './adminView';
import { importPlayersCsv } from './importCsv';
import { addManualMatch, createManualTournament, deleteManualMatch, deleteManualTournament, listManual, setManualProgress, updateManualMatch } from './manual';
import { createPlayer, deletePlayer, listPlayers, updatePlayer, ValidationError, type PlayerInput } from './roster';

const MAX_BODY = 64 * 1024;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Página que se ve al compartir un partido: etiquetas Open Graph para la vista previa y redirección a la web del club. */
/** Añade a la tarjeta de torneo los rivales (nombre y primer apellido), que solo viajan en la imagen y no en la API. */
const withRivals = (db: Db, f: Found | undefined): Found | undefined => (f && f.kind === 'torneo' ? { ...f, rivals: rivalNamesFor(db, f.t.id, f.t.name) } : f);

export function shareHtml(tournament: string, m: PublicMatch, id: string): string {
  const when = [m.date, m.time].filter(Boolean).join(' ');
  const title = `${m.players.join(' / ')} · ${m.event ?? tournament}`;
  const state = m.state === 'finished' ? `${m.outcome === 'win' ? 'Victoria' : m.outcome === 'loss' ? 'Derrota' : 'Finalizado'} ${m.score ?? ''}`.trim() : m.state === 'live' ? 'En juego' : `Programado ${when}`.trim();
  const desc = `${tournament} · ${state}${m.court ? ` · Pista ${m.court}` : ''}`;
  const target = settings.siteUrl ? `${settings.siteUrl}/directo?partido=${encodeURIComponent(id)}` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta name="twitter:card" content="summary">
${target ? `<meta property="og:url" content="${esc(target)}"><meta http-equiv="refresh" content="0; url=${esc(target)}">` : ''}</head>
<body><p>${esc(title)}</p><p>${esc(desc)}</p>${target ? `<p><a href="${esc(target)}">Ver en la web del club</a></p>` : ''}</body></html>`;
}

class HttpFail extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Avisos al navegador por SSE: solo dicen «hay datos nuevos»; el navegador vuelve a pedir el estado a este servidor. */
export class Hub {
  private clients = new Set<http.ServerResponse>();
  private last = '';
  constructor(private db: Db) {}

  add(res: http.ServerResponse) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }
  get size() {
    return this.clients.size;
  }
  /** Llamar tras cada lectura o cambio de la lista: avisa solo si cambió algo publicable. */
  check() {
    const v = cachedPublicState(this.db).state.version;
    if (v === this.last) return;
    this.last = v;
    for (const c of this.clients) c.write(`event: update\ndata: ${JSON.stringify({ version: v, at: nowIso() })}\n\n`);
  }
  heartbeat() {
    for (const c of this.clients) c.write(': ping\n\n');
  }
}

const safeEqual = (a: string, b: string) => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpFail(413, 'Cuerpo demasiado grande.');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFail(400, 'JSON no válido.');
  }
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new HttpFail(413, 'Cuerpo demasiado grande.');
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const approvalPage = (title: string, inner: string) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${html(title)}</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:1.4rem}.b{display:flex;gap:12px;margin-top:20px}button{font:inherit;padding:12px 20px;border:0;border-radius:6px;cursor:pointer}.ok{background:#2f2c64;color:#fff}.no{background:#e6e6ee}</style></head><body>${inner}</body></html>`;

const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function createApp(db: Db, engine: SyncEngine | undefined, hub: Hub, mailer?: Mailer) {
  const hits = new Map<string, { n: number; reset: number }>();
  const adminHtml = () => fs.readFileSync(path.join(import.meta.dirname, 'admin.html'), 'utf8');

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };

  const cors = (req: http.IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (origin && (settings.corsOrigins.includes('*') || settings.corsOrigins.includes(origin))) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};
  };

  const limited = (req: http.IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? '?';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    return ++h.n > settings.publicRatePerMinute;
  };

  const requireAdmin = (req: http.IncomingMessage) => {
    if (!settings.adminToken) throw new HttpFail(403, 'La administración está desactivada: define ADMIN_TOKEN.');
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m || !safeEqual(m[1], settings.adminToken)) throw new HttpFail(401, 'No autorizado.');
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors(req), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }

      if (route === 'GET /api/health') {
        const lastError = kvGet<{ at: string; job: string; message: string }>(db, 'last_error');
        // Por defecto, una respuesta pequeña (< 1 KB): los vigilantes externos (cron-job.org, etc.) rechazan respuestas grandes. `?full=1` añade el diagnóstico completo.
        const full = new URL(req.url ?? '/', 'http://x').searchParams.get('full') === '1';
        const d = engine?.diagnose();
        const last = engine?.lastJob;
        return send(res, 200, {
          ok: true,
          officialReadEnabled: settings.officialReadEnabled,
          time: nowIso(),
          // Cuándo arrancó este proceso: si es reciente sin que haya habido un despliegue, el alojamiento lo había dormido o reiniciado.
          startedAt: STARTED_AT,
          uptimeMin: Math.round(process.uptime() / 60),
          // Diagnóstico sin datos personales: qué hizo el motor por última vez y el último error.
          ...(full ? { backup: backupState, subscribers: subscriberCounts(db), mail: (db.prepare("select k, v from kv where k like 'weekend-%' order by updated_at desc limit 10").all() as unknown as { k: string; v: string }[]).map((r) => ({ k: r.k.slice(0, 40), ...(JSON.parse(r.v) as object) })) } : {}),
          engine: !engine || !d ? null : {
            ...(full ? d : { pausedUntil: d.pausedUntil, retrying: d.retrying.length, http: d.http }),
            lastJob: last ? { job: last.key.split(':')[0], at: last.at, ok: last.ok } : null,
            lastError: lastError ? { at: lastError.at, job: lastError.job.split(':')[0], message: full ? lastError.message : lastError.message.slice(0, 120) } : null,
          },
        });
      }

      if (route === 'GET /api/public/state') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const c = cachedPublicState(db);
        const headers = { ...cors(req), 'Cache-Control': 'public, max-age=10, must-revalidate', ETag: c.etag };
        // El navegador pregunta cada minuto: si no ha cambiado nada, basta con un «304 no modificado» sin cuerpo.
        if (req.headers['if-none-match'] === c.etag) {
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
        return res.end(c.body);
      }

      if (route === 'GET /api/public/news') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const c = cachedPublicState(db);
        const headers = { ...cors(req), 'Cache-Control': 'public, max-age=60, must-revalidate', ETag: c.newsEtag };
        if (req.headers['if-none-match'] === c.newsEtag) {
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
        return res.end(c.newsBody);
      }

      // Paquete listo para publicar (imágenes + pie de foto de partida): `?when=previa` (torneos de mañana) o `?when=resultados` (fin de semana).
      if (route === 'GET /api/public/social') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const when = url.searchParams.get('when') === 'resultados' ? 'resultados' : 'previa';
        const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0];
        const base = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) });
        return res.end(JSON.stringify({ generatedAt: nowIso(), when, items: buildSocial(cachedPublicState(db).state, when, base) }));
      }

      // Liga Nacional de Clubes (división que sigue el club): clasificación, clubes y jornadas con sus encuentros.
      if (route === 'GET /api/public/liga') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const liga = buildLiga(kvGet<LigaSnapshot>(db, 'liga'));
        if (!liga) return send(res, 404, { error: 'La Liga aún no está disponible.' }, { ...cors(req), 'Cache-Control': 'no-store' });
        const etag = `"l${liga.version}"`;
        const headers = { ...cors(req), 'Cache-Control': 'public, max-age=30, must-revalidate', ETag: etag };
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, headers);
          return res.end();
        }
        return send(res, 200, liga, headers);
      }

      if (route === 'GET /api/public/accuracy') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        // Acierto de la estimación frente a lo ocurrido (solo horas y recuentos, sin nombres). `?days=N` limita a los últimos N días (por defecto 45).
        const days = Math.min(120, Math.max(1, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('days')) || 45));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff', ...cors(req) });
        return res.end(JSON.stringify({ generatedAt: nowIso(), calibration: currentShift(db, new Date()), learning: learningReport(db, url.searchParams.get('timing') === '1'), days: buildAccuracy(db, since) }));
      }

      if (route === 'GET /api/public/stream') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors(req) });
        res.write(`event: hello\ndata: ${JSON.stringify({ version: buildPublicState(db).version })}\n\n`);
        hub.add(res);
        return;
      }

      if (route === 'GET /api/public/calendar') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const cal = kvGet<{ meta: unknown; tournaments: unknown[] }>(db, 'calendar');
        return send(res, cal ? 200 : 404, cal ?? { error: 'Calendario aún no disponible.' }, { ...cors(req), 'Cache-Control': 'public, max-age=300' });
      }

      if (route === 'GET /api/public/push/key') {
        return send(res, 200, { enabled: pushConfigured(), publicKey: pushConfigured() ? settings.vapid.publicKey : null }, cors(req));
      }
      // Suscripción por correo (doble confirmación): estado del servicio, alta/cambio y páginas de confirmar y darse de baja.
      if (route === 'GET /api/public/subscribe') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        return send(res, 200, { enabled: !!mailer }, cors(req));
      }
      if (route === 'POST /api/public/subscribe') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        if (!mailer) throw new HttpFail(503, 'Las suscripciones por correo todavía no están activadas.');
        try {
          await requestSubscription(db, cachedPublicState(db).state, (await readJson(req)) as Parameters<typeof requestSubscription>[2], mailer);
        } catch (e) {
          if (e instanceof SubscribeError) throw new HttpFail(e.status, e.message);
          console.error('suscripción', e);
          throw new HttpFail(502, 'No hemos podido enviar el correo de confirmación. Inténtalo de nuevo en unos minutos.');
        }
        return send(res, 202, { ok: true }, cors(req)); // misma respuesta exista o no el correo
      }
      const sub = /^\/suscripcion\/(confirmar|baja)$/.exec(url.pathname);
      if (sub && (req.method === 'GET' || req.method === 'POST')) {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const id = Number(url.searchParams.get('i'));
        const token = url.searchParams.get('t') ?? '';
        const page = (title: string, body: string, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#14132f"><h1 style="color:#2f2c64">${esc(title)}</h1>${body}<p style="margin-top:32px;font-size:13px;color:#566072">Club Bádminton Universidad de Valladolid</p></body></html>`);
        };
        const back = settings.siteUrl ? `<p><a href="${esc(settings.siteUrl)}">Volver a la web del club</a></p>` : '';
        const button = (label: string) => `<form method="post" action="${esc(url.pathname)}?i=${Number.isInteger(id) ? id : 0}&t=${encodeURIComponent(token)}"><button type="submit" style="background:#2f2c64;color:#fff;border:0;padding:12px 20px;border-radius:4px;font-size:16px;cursor:pointer">${label}</button></form>`;
        if (req.method === 'GET') {
          return sub[1] === 'confirmar'
            ? page('Confirmar suscripción', `<p>Pulsa para confirmar que quieres recibir por correo las noticias y resultados del club.</p>${button('Confirmar suscripción')}`)
            : page('Darse de baja', `<p>Pulsa para dejar de recibir los correos del club. Se borrará tu dirección.</p>${button('Darme de baja')}`);
        }
        for await (const _ of req) void _; // se descarta el cuerpo (los clientes de correo envían «List-Unsubscribe=One-Click»)
        if (sub[1] === 'confirmar') {
          const ok = Number.isInteger(id) && confirmSubscription(db, id, token);
          return ok ? page('¡Suscripción confirmada!', `<p>Gracias. Recibirás un resumen semanal con las noticias y resultados de lo que has elegido. Cada correo lleva un enlace para darte de baja.</p>${back}`) : page('Enlace no válido', '<p>Este enlace no es válido o ya se usó. Puedes volver a suscribirte desde la web del club.</p>' + back, 400);
        }
        const gone = Number.isInteger(id) && unsubscribeEmail(db, id, token);
        return gone ? page('Te has dado de baja', `<p>Hecho: no recibirás más correos y tu dirección se ha borrado.</p>${back}`) : page('Enlace no válido', '<p>Este enlace no es válido o ya te habías dado de baja.</p>' + back, 400);
      }
      if (route === 'POST /api/public/push/subscribe') {
        if (limited(req) || !pushConfigured()) throw new HttpFail(pushConfigured() ? 429 : 409, pushConfigured() ? 'Demasiadas consultas.' : 'Los avisos no están activados.');
        subscribe(db, (await readJson(req)) as Parameters<typeof subscribe>[1]);
        return send(res, 201, { ok: true }, cors(req));
      }
      if (route === 'POST /api/public/push/unsubscribe') {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const b = (await readJson(req)) as { endpoint?: string; playerId?: number };
        if (b.endpoint) unsubscribe(db, b.endpoint, b.playerId);
        return send(res, 200, { ok: true }, cors(req));
      }

      // Captura del itinerario enviada por correo: /captura/<id>.png (el id es aleatorio; la imagen solo lleva datos públicos).
      const cap = /^\/captura\/([0-9a-f]{24})\.png$/.exec(url.pathname);
      if (req.method === 'GET' && cap) {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const png = captureImage(db, cap[1]);
        if (!png) throw new HttpFail(404, 'No disponible.');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', ...cors(req) });
        return res.end(png);
      }

      // Imagen (PNG) de la tarjeta: /og/<partido|torneo|resultados>/<id>.png?size=og|square|story
      const og = /^\/og\/(partido|torneo|resultados)\/(.+)\.png$/.exec(url.pathname);
      if (req.method === 'GET' && og) {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const found = withRivals(db, findCard(cachedPublicState(db).state, og[1] as CardKind, decodeURIComponent(og[2])));
        if (!found) throw new HttpFail(404, 'No disponible.');
        const size = (['og', 'square', 'story'] as const).find((x) => x === url.searchParams.get('size')) ?? 'og';
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', ...cors(req) });
        return res.end(renderPng(found, size));
      }

      // Página que se comparte: etiquetas Open Graph (vista previa en WhatsApp, Telegram, X…) y redirección a la web del club.
      // /compartir/<partido|torneo|resultados>/<id>; /compartir/<id> sigue valiendo para partidos (enlaces antiguos).
      const share = /^\/compartir\/(?:(partido|torneo|resultados)\/)?(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && share) {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const kind = (share[1] ?? 'partido') as CardKind;
        const id = decodeURIComponent(share[2]);
        const found = withRivals(db, findCard(cachedPublicState(db).state, kind, id));
        if (!found) throw new HttpFail(404, 'No disponible.');
        const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0];
        const base = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
        const m = metaOf(found);
        const image = `${base}/og/${kind}/${encodeURIComponent(id)}.png?v=${cardVersion(found)}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
        return res.end(shareHtmlPage({ title: m.title, description: m.description, image, target: settings.siteUrl ? `${settings.siteUrl}${m.webPath}` : '' }));
      }

      // Aprobación de una crónica redactada por IA: el enlace del correo lleva un código secreto por borrador.
      const approve = /^\/aprobar-cronica\/([0-9A-Fa-f-]{36})$/.exec(url.pathname);
      if (approve && (req.method === 'GET' || req.method === 'POST')) {
        if (limited(req)) throw new HttpFail(429, 'Demasiadas consultas.');
        const page = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
        const guid = approve[1].toUpperCase();
        if (req.method === 'GET') {
          const code = url.searchParams.get('code') ?? '';
          const d = draftFor(db, guid, code);
          res.writeHead(d ? 200 : 404, page);
          if (!d) return res.end(approvalPage('No disponible', '<h1>Enlace no válido o caducado</h1>'));
          const c = d.chronicle;
          const done = d.status !== 'draft' ? `<p><strong>Estado: ${d.status === 'published' ? 'publicada' : 'descartada'}.</strong></p>` : '';
          return res.end(approvalPage('Revisar crónica', `<h1>${html(c.title)}</h1><p><em>${html(c.summary)}</em></p>${c.paragraphs.map((p) => `<p>${html(p)}</p>`).join('')}${done}<form method="post" class="b"><input type="hidden" name="code" value="${html(code)}"><button class="ok" name="action" value="publish">Publicar</button><button class="no" name="action" value="discard">Descartar</button></form>`));
        }
        const form = await readForm(req);
        const action = form.get('action') === 'publish' ? 'publish' : 'discard';
        const ok = decide(db, guid, form.get('code') ?? '', action);
        res.writeHead(ok ? 200 : 404, page);
        return res.end(approvalPage('Hecho', ok ? `<h1>${action === 'publish' ? 'Crónica publicada' : 'Crónica descartada'}</h1><p>${action === 'publish' ? 'Ya aparece en las noticias de la web.' : 'La noticia sigue con el texto automático.'}</p>` : '<h1>Enlace no válido</h1>'));
      }

      if (route === 'GET /admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'" });
        return res.end(adminHtml());
      }

      if (url.pathname.startsWith('/api/admin/')) {
        requireAdmin(req);
        const rest = url.pathname.slice('/api/admin/'.length);

        if (rest === 'players' && req.method === 'GET') return send(res, 200, listPlayers(db));
        if (rest === 'players' && req.method === 'POST') {
          const p = createPlayer(db, (await readJson(req)) as unknown as PlayerInput);
          hub.check();
          return send(res, 201, p);
        }
        const m = /^players\/(\d+)$/.exec(rest);
        if (m && req.method === 'PATCH') {
          const p = updatePlayer(db, Number(m[1]), (await readJson(req)) as Partial<PlayerInput>);
          hub.check();
          return send(res, 200, p);
        }
        if (m && req.method === 'DELETE') {
          if (!deletePlayer(db, Number(m[1]))) throw new HttpFail(404, 'No existe ese jugador.');
          hub.check();
          return send(res, 200, { deleted: true });
        }

        if (rest === 'tournaments' && req.method === 'POST') {
          if (!engine) throw new HttpFail(409, 'La lectura automática está desactivada.');
          const body = await readJson(req);
          const guid = extractGuid(String(body.guid ?? body.url ?? ''))?.toUpperCase();
          if (!guid) throw new HttpFail(400, 'Indica el GUID o el enlace oficial del torneo.');
          const ids = Array.isArray(body.playerIds) ? (body.playerIds as number[]) : [undefined];
          for (const id of ids) engine.track(guid, id);
          return send(res, 201, { tracking: guid });
        }

        // --- Torneos, partidos y resultados introducidos a mano por el club ---
        if (rest === 'manual' && req.method === 'GET') return send(res, 200, listManual(db));
        if (rest === 'manual/tournaments' && req.method === 'POST') {
          const guid = createManualTournament(db, (await readJson(req)) as unknown as Parameters<typeof createManualTournament>[1]);
          hub.check();
          return send(res, 201, { guid });
        }
        const mt = /^manual\/tournaments\/(.+)$/.exec(rest);
        if (mt && req.method === 'DELETE') {
          deleteManualTournament(db, decodeURIComponent(mt[1]));
          hub.check();
          return send(res, 200, { deleted: true });
        }
        if (rest === 'manual/matches' && req.method === 'POST') {
          const key = addManualMatch(db, (await readJson(req)) as unknown as Parameters<typeof addManualMatch>[1]);
          hub.check();
          return send(res, 201, { key });
        }
        const mm = /^manual\/matches\/(.+)$/.exec(rest);
        if (mm && req.method === 'PATCH') {
          updateManualMatch(db, decodeURIComponent(mm[1]), (await readJson(req)) as Partial<Parameters<typeof addManualMatch>[1]>);
          hub.check();
          return send(res, 200, { ok: true });
        }
        if (mm && req.method === 'DELETE') {
          if (!deleteManualMatch(db, decodeURIComponent(mm[1]))) throw new HttpFail(404, 'No existe ese partido manual.');
          hub.check();
          return send(res, 200, { deleted: true });
        }
        const mp = /^manual\/progress\/(.+)$/.exec(rest);
        if (mp && req.method === 'PUT') {
          const est = setManualProgress(db, decodeURIComponent(mp[1]), (await readJson(req)) as unknown as Parameters<typeof setManualProgress>[2]);
          hub.check();
          return send(res, 200, { estimatedEnd: est.estimatedEnd });
        }

        if (rest === 'overview' && req.method === 'GET') return send(res, 200, buildOverview(db));

        if (rest === 'candidates' && req.method === 'GET') {
          // Personas con el club de la UVA en clasificaciones o cuadros que NO están en la lista: se muestran solo aquí.
          const rows = db
            .prepare(`select e.name, e.club, t.name as tournament, t.start_date as date from entrants e join tournaments t on t.guid = e.tournament_guid where e.player_id is null order by t.start_date desc`)
            .all();
          return send(res, 200, rows);
        }

        if (rest === 'status' && req.method === 'GET') {
          const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
          return send(res, 200, {
            officialReadEnabled: settings.officialReadEnabled,
            lastJob: engine?.lastJob ?? null,
            tournaments: count('select count(*) n from tournaments'),
            matches: count('select count(*) n from matches'),
            players: count('select count(*) n from players'),
            publicPlayers: count('select count(*) n from players where public = 1'),
            sseClients: hub.size,
            recentChanges: db.prepare('select at, kind, field, old_value, new_value from changes order by id desc limit 30').all(),
            recentRequests: db.prepare('select at, url, status, ms from fetch_log order by id desc limit 30').all(),
          });
        }

        if (rest === 'import-csv' && req.method === 'POST') {
          const body = await readJson(req);
          const result = importPlayersCsv(db, String(body.csv ?? ''));
          hub.check();
          return send(res, 201, result);
        }

        if (rest === 'export' && req.method === 'GET') return send(res, 200, { exportedAt: nowIso(), players: listPlayers(db) });
        if (rest === 'import' && req.method === 'POST') {
          const body = await readJson(req);
          const list = Array.isArray(body.players) ? (body.players as PlayerInput[]) : [];
          for (const p of list) createPlayer(db, { ...p, profile: (p as { profileGuid?: string }).profileGuid ?? p.profile });
          hub.check();
          return send(res, 201, { imported: list.length });
        }
        throw new HttpFail(404, 'No encontrado.');
      }

      throw new HttpFail(404, 'No encontrado.');
    } catch (e) {
      if (e instanceof HttpFail) return send(res, e.status, { error: e.message });
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      const message = String((e as Error).message);
      if (/UNIQUE|constraint/i.test(message)) return send(res, 400, { error: 'No se puede guardar: ' + message });
      console.error(e);
      return send(res, 500, { error: 'Error interno.' });
    } finally {
      // Cualquier cambio desde la administración (jugadores, partidos a mano…) debe verse enseguida.
      if (req.method !== 'GET' && url.pathname.startsWith('/api/admin/')) invalidatePublicState(db);
    }
  };
}

/** Qué ha aprendido el modelo: valores de partida frente a los de fábrica y resumen de cada jornada guardada (solo cifras). */
function learningReport(db: Db, withTiming = false) {
  const patterns = loadPatterns(db);
  const learned = learnedPriors(db);
  return {
    patterns: patterns.length,
    learnedFrom: { days: learned.days, matches: learned.matches },
    priors: { default: defaultPriors, learned: learned.priors },
    timing: (({ gapSample, ...t }) => ({ ...t, gapSampleReady: !!gapSample }))(learnedTiming(db)),
    days: patterns.map(({ perEvent: _p, timing, ...d }) => (withTiming ? { ...d, timing } : d)),
  };
}
