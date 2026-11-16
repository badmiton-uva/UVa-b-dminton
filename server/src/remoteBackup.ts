import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db';
import { openBackup, sealBackup } from './backupCrypto';

/**
 * Copia de la base de datos en un Redis externo gratuito (Upstash, API REST). Sirve para hostings sin disco persistente
 * (p. ej. Render gratuito): al arrancar sin base de datos se restaura la última copia, y cada 30 minutos (y al apagarse) se guarda otra, para no agotar el plan gratuito.
 * Se configura con UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN. Sin ellas, no hace nada.
 */
const CHUNK = 600_000; // caracteres por clave: por debajo del límite de petición del plan gratuito
const PREFIX = 'club-uva:db:';

export interface RemoteConfig {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export const remoteConfig = (): RemoteConfig | undefined => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : undefined;
};

async function cmd(c: RemoteConfig, args: (string | number)[]): Promise<unknown> {
  const res = await (c.fetchImpl ?? fetch)(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(`Upstash: ${body.error ?? res.status}`);
  return body.result;
}

/** Dónde deja GitHub Actions la copia cifrada (rama `backup-data`, repositorio público). Se puede cambiar con BACKUP_URL; «off» la desactiva. */
export const BACKUP_URL_DEFAULT = 'https://raw.githubusercontent.com/badmiton-uva/UVa-b-dminton/backup-data/club.bin';

export interface GithubRestore { url?: string; secret?: string; fetchImpl?: typeof fetch }

/** Restaura la copia cifrada guardada en GitHub. `true` si se restauró; `false` si no hay copia; lanza si hay copia pero no se pudo leer. */
async function restoreFromGithub(file: string, g: GithubRestore): Promise<boolean> {
  const url = g.url ?? process.env.BACKUP_URL ?? BACKUP_URL_DEFAULT;
  if (!g.secret || url === 'off') return false;
  const res = await (g.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return false; // todavía no hay copia
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const plain = zlib.gunzipSync(openBackup(Buffer.from(await res.arrayBuffer()), g.secret));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plain);
  backupState.restoredFrom = 'github';
  return true;
}

/** Restaura la última copia en `file` si todavía no existe: primero la de GitHub, después la de Upstash. Devuelve true si se restauró. */
export async function restoreIfMissing(file: string, c: RemoteConfig | undefined = remoteConfig(), g: GithubRestore = { secret: process.env.ADMIN_TOKEN }): Promise<boolean> {
  backupState.configured = !!c;
  if (fs.existsSync(file)) return false;
  try {
    if (await restoreFromGithub(file, g)) { backupState.restored = true; return true; }
  } catch (e) {
    // Hay copia pero no se pudo leer: no se publica una copia nueva (vacía) encima de la buena hasta reiniciar.
    backupState.restoreFailed = true;
    backupState.lastError = `restaurar (GitHub): ${(e as Error).message}`;
    console.error('No se pudo restaurar la copia de GitHub:', (e as Error).message);
  }
  if (!c) return false;
  try {
    const meta = (await cmd(c, ['GET', `${PREFIX}meta`])) as string | null;
    if (!meta) return false;
    const { chunks } = JSON.parse(meta) as { chunks: number };
    let b64 = '';
    for (let i = 0; i < chunks; i++) b64 += String(await cmd(c, ['GET', `${PREFIX}${i}`]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gunzipSync(Buffer.from(b64, 'base64')));
    backupState.restored = true;
    backupState.restoredFrom = 'upstash';
    backupState.restoreFailed = false;
    return true;
  } catch (e) {
    backupState.lastError = `restaurar: ${(e as Error).message}`;
    console.error('No se pudo restaurar la copia remota:', (e as Error).message);
    return false;
  }
}

let lastHash = '';
/** Estado de la copia remota, para el diagnóstico (`/api/health?full=1`). */
export const backupState: { configured: boolean; restored?: boolean; restoredFrom?: 'github' | 'upstash'; restoreFailed?: boolean; lastSavedAt?: string; lastServedAt?: string; lastError?: string } = { configured: false };

/**
 * La copia remota guarda solo lo que NO se puede volver a leer de la federación: jugadores y consentimientos, suscriptores y sus envíos,
 * avisos push, crónicas, patrones de aprendizaje, torneos, partidos ya terminados y el historial. Lo demás (cuadros, orden de juego,
 * estimaciones, registros, partidos por jugar, caché) se reconstruye solo al arrancar. Así la copia pesa pocos KB y los planes gratuitos bastan.
 */
const EMPTY_TABLES = ['slots', 'estimate_log', 'estimate_starts', 'changes', 'fetch_log', 'push_sent', 'draws', 'captures', 'entrants', 'entries'];
/** Claves de `kv` que son caché o marcas de lectura y cambian a cada minuto: no se copian (se rehacen). */
const VOLATILE_KV = /^(ok:|estimate:|rebuilt:|nodraws:|needs-rebuild:|identify:|entries:|liga$|calendar|ranking$|history$|last_error$|roster_ok$|discover_ok$|backfill_at$)/;
const KEEP_KV_MAX = 50_000; // caracteres: lo más grande es caché

/** Reduce una copia de la base de datos a lo imprescindible. Devuelve una huella del contenido que no cambia por marcas de lectura. */
export function shrinkSnapshot(file: string): string {
  const s = new DatabaseSync(file);
  try {
    for (const t of EMPTY_TABLES) s.exec(`delete from ${t}`);
    s.exec("delete from matches where state not in ('finished', 'walkover', 'retired')");
    for (const r of s.prepare('select k, length(v) n from kv').all() as unknown as { k: string; n: number }[]) {
      if (VOLATILE_KV.test(r.k) || r.n > KEEP_KV_MAX) s.prepare('delete from kv where k = ?').run(r.k);
    }
    const h = createHash('sha1');
    for (const t of ['kv', 'players', 'subscribers', 'subscriber_players', 'subscriber_mails', 'push_subs', 'chronicles', 'day_patterns', 'tournaments', 'tournament_players', 'history_matches', 'matches']) {
      const cols = (s.prepare(`pragma table_info(${t})`).all() as unknown as { name: string }[]).map((c) => c.name).filter((c) => !/^(updated_at|last_seen_at|seen_at|checked_at)$/.test(c));
      for (const row of s.prepare(`select ${cols.join(', ')} from ${t} order by rowid`).all()) h.update(JSON.stringify(row));
    }
    s.exec('vacuum');
    return h.digest('hex');
  } finally {
    s.close();
  }
}

let essential: { hash: string; gz: Buffer; at: number } | undefined;

/** Copia reducida y comprimida de la base de datos (solo se rehace si lo importante ha cambiado). */
export function essentialSnapshot(db: Db): { hash: string; gz: Buffer } {
  const tmp = path.join(os.tmpdir(), `club-essential-${process.pid}.sqlite`);
  try {
    fs.rmSync(tmp, { force: true });
    db.exec(`vacuum into '${tmp.replace(/'/g, "''")}'`);
    const hash = shrinkSnapshot(tmp);
    if (essential?.hash === hash) return essential;
    essential = { hash, gz: zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }), at: Date.now() };
    return essential;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let served: { at: number; blob: Buffer } | undefined;
/**
 * Copia cifrada para GitHub Actions (`GET /api/public/backup`). Se reutiliza 10 minutos. `undefined` si no hay clave (ADMIN_TOKEN) o si la
 * restauración falló (para no pisar con una copia vacía la que está guardada).
 */
export function servedBackup(db: Db, secret: string, now = Date.now()): Buffer | undefined {
  if (!secret || backupState.restoreFailed) return undefined;
  if (!served || now - served.at > 10 * 60_000) served = { at: now, blob: sealBackup(essentialSnapshot(db).gz, secret) };
  backupState.lastServedAt = new Date(now).toISOString();
  return served.blob;
}
export const resetServedBackup = () => void (served = undefined);

/** Guarda una copia comprimida y reducida de la base de datos. Si lo importante no ha cambiado desde la última, no envía nada. */
export async function saveSnapshot(db: Db, c: RemoteConfig | undefined = remoteConfig()): Promise<boolean> {
  backupState.configured = !!c;
  if (!c) return false;
  const tmp = path.join(os.tmpdir(), `club-snapshot-${process.pid}.sqlite`);
  try {
    fs.rmSync(tmp, { force: true });
    db.exec(`vacuum into '${tmp.replace(/'/g, "''")}'`);
    const hash = shrinkSnapshot(tmp);
    if (hash === lastHash) return false;
    const b64 = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }).toString('base64');
    const chunks = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < chunks; i++) await cmd(c, ['SET', `${PREFIX}${i}`, b64.slice(i * CHUNK, (i + 1) * CHUNK)]);
    await cmd(c, ['SET', `${PREFIX}meta`, JSON.stringify({ chunks, at: new Date().toISOString() })]);
    lastHash = hash;
    backupState.lastSavedAt = new Date().toISOString();
    return true;
  } catch (e) {
    backupState.lastError = `guardar: ${(e as Error).message}`;
    console.error('No se pudo guardar la copia remota:', (e as Error).message);
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const resetSnapshotState = () => void (lastHash = '');
