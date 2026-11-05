import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApp, Hub } from './api';
import { settings } from './config';
import { openDb } from './db';
import { remoteConfig, restoreIfMissing, saveSnapshot } from './remoteBackup';
import { importPlayersCsv } from './importCsv';
import { listPlayers } from './roster';
import { SyncEngine } from './engine';
import { cachedPublicState } from './publicView';
import { draftChronicles } from './chronicle';
import { sendDueItineraries } from './itinerary';
import { purgeGhostEra } from './patterns';
import { sendWeekendPreviews } from './weekendPreview';
import { sendWeekendResults } from './weekendResults';
import { notifyUpcoming, realSender } from './push';
import { RealSource } from './source';
import { OfficialLiveReaders } from './officialReaders';
import { PoliteClient } from './http';
import { httpConfig } from './config-http';

/**
 * El puerto se abre lo primero: así el alojamiento ve el servidor «vivo» y deja de esperar mientras se restaura la base (copia remota)
 * y se prepara todo lo demás. Hasta entonces solo responde el estado de salud y, al resto, «reintenta en unos segundos».
 */
let handler: http.RequestListener = (req, res) => {
  const health = (req.url ?? '').startsWith('/api/health');
  res.writeHead(health ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
  res.end(JSON.stringify(health ? { ok: true, starting: true } : { error: 'Arrancando, reintenta en unos segundos.' }));
};
const server = http.createServer((req, res) => handler(req, res));
server.listen(settings.port, () => console.log(`Servidor del club en http://localhost:${settings.port}`));

const dbFile = path.join(settings.dataDir, 'club.sqlite');
if (await restoreIfMissing(dbFile)) console.log('Base de datos restaurada desde la copia remota (Upstash).');
const db = openDb(dbFile);
if (purgeGhostEra(db, new Date())) console.log('Estimaciones anteriores a la retirada de partidos fantasma descartadas (no se aprende de ellas).');

/** Copia de la base de datos (consentimientos, jugadores, partidos): al arrancar y cada 24 h; se conservan las 7 últimas. */
function backup() {
  try {
    const dir = path.join(settings.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `club-${new Date().toISOString().slice(0, 10)}.sqlite`);
    fs.rmSync(file, { force: true });
    db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
    for (const old of fs.readdirSync(dir).filter((f) => f.startsWith('club-')).sort().slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true });
  } catch (e) {
    console.error('copia de seguridad', e);
  }
}
// Hosting sin disco persistente (p. ej. Render gratuito): si la base está vacía, se carga la lista del club desde ROSTER_CSV.
if (process.env.ROSTER_CSV && listPlayers(db).length === 0) {
  const r = importPlayersCsv(db, process.env.ROSTER_CSV);
  console.log(`Lista del club cargada desde ROSTER_CSV: ${r.created} jugadores, ${r.errors.length} errores.`);
}
backup();
setInterval(backup, 24 * 3600_000).unref();
if (remoteConfig()) {
  console.log('Copia remota (Upstash) activada: se guarda cada 5 minutos si hay cambios.');
  setInterval(() => void saveSnapshot(db), 5 * 60_000).unref();
  setTimeout(() => void saveSnapshot(db), 60_000).unref();
}
const hub = new Hub(db);

const client = new PoliteClient({ baseUrl: httpConfig.baseUrl, minIntervalMs: httpConfig.minIntervalMs, timeoutMs: httpConfig.timeoutMs, userAgent: httpConfig.userAgent });
const source = new RealSource(client, new OfficialLiveReaders(client));
const features = { live: settings.officialReadEnabled && source.hasLiveReaders, calendar: settings.calendarRefreshEnabled };
let engine: SyncEngine | undefined;
if (features.live || features.calendar) {
  source.http.onLog = (e) =>
    db.prepare('insert into fetch_log(at, url, status, ms, bytes, changed, error) values(?,?,?,?,?,?,?)').run(e.at, e.url, e.status, e.ms, e.bytes, +e.changed, e.error ?? null);
  engine = new SyncEngine(db, source, () => new Date(), features);
}
console.log(
  features.live
    ? 'Lectura EN DIRECTO de badminton.es ACTIVADA (≥2,5 s entre peticiones). Asegúrate de contar con autorización.'
    : 'Lectura en directo DESACTIVADA (OFFICIAL_READ_ENABLED no es "true"): sin partidos ni cuadros automáticos.',
);
console.log(features.calendar ? `Calendario oficial: se actualiza cada ${settings.calendarHours} h (rutas permitidas por robots.txt).` : 'Calendario oficial: actualización desactivada.');
if (!settings.adminToken) console.warn('ADMIN_TOKEN sin definir: el panel de administración está desactivado.');

const sender = realSender();
console.log(sender ? 'Avisos push: activados.' : 'Avisos push: desactivados (faltan VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT).');

handler = createApp(db, engine, hub);

let stopping = false;
const loop = async () => {
  if (stopping) return;
  try {
    if (engine && (await engine.tick())) {
      hub.check();
      if (sender) await notifyUpcoming(db, new Date(), sender);
    }
  } catch (e) {
    console.error('tick', e);
  }
  setTimeout(loop, settings.tickMs);
};
if (engine) loop();

setInterval(() => hub.heartbeat(), 25_000).unref();
// Crónicas con IA (si hay clave): cada 15 minutos se mira si ha terminado algún torneo sin crónica; el borrador va por correo para su aprobación.
if (settings.chronicle.apiKey && settings.chronicle.email) {
  console.log('Crónicas con IA: activadas (borrador por correo para aprobar).');
  setInterval(() => void draftChronicles(db, cachedPublicState(db).state, new Date()).catch((e) => console.error('crónicas', e)), 15 * 60_000).unref();
}
setInterval(() => engine?.prune(), 24 * 3600_000).unref();
// Captura del itinerario en vivo 15 min antes de empezar cada torneo con gente del club: se comprueba cada minuto con lo ya guardado.
if (settings.itinerary.email) {
  console.log(`Itinerario en vivo: captura por correo ${settings.itinerary.minutesBefore} min antes de cada torneo.`);
  setInterval(() => void sendDueItineraries(db, cachedPublicState(db).state, new Date()).catch((e) => console.error('itinerario', e)), 60_000).unref();
}
// Los avisos dependen de la hora: se comprueban cada minuto con lo ya guardado (sin pedir nada a badminton.es).
if (sender) setInterval(() => void notifyUpcoming(db, new Date(), sender).catch((e) => console.error('push', e)), 60_000).unref();

// Previa del finde por correo: los jueves a las 15:00 (Madrid), quién juega y a qué hora son los primeros partidos de la UVa.
if (settings.weekendPreview.email) {
  console.log('Previa del finde por correo: jueves a las 15:00 (Madrid).');
  setInterval(() => void sendWeekendPreviews(db, cachedPublicState(db).state, new Date()).catch((e) => console.error('previa del finde', e)), 60_000).unref();
}

// Resultados del finde por correo: los domingos a las 15:00 (Madrid), resultados del club y mensaje para redes.
if (settings.weekendResults.email) {
  console.log('Resultados del finde por correo: domingo a las 15:00 (Madrid).');
  setInterval(() => void sendWeekendResults(db, cachedPublicState(db).state, new Date()).catch((e) => console.error('resultados del finde', e)), 60_000).unref();
}

const shutdown = () => {
  stopping = true;
  void saveSnapshot(db);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
