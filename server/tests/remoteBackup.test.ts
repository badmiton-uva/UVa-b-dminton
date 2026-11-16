import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { kvGet, kvSet, openDb } from '../src/db';
import { resetSnapshotState, restoreIfMissing, saveSnapshot } from '../src/remoteBackup';

/** Upstash simulado en memoria. */
function fakeUpstash() {
  const store = new Map<string, string>();
  let writes = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const [op, key, value] = JSON.parse(String(init.body)) as string[];
    if (op === 'SET') { store.set(key, value); writes++; return Response.json({ result: 'OK' }); }
    return Response.json({ result: store.get(key) ?? null });
  }) as typeof fetch;
  return { cfg: { url: 'https://upstash.test', token: 't', fetchImpl }, store, writes: () => writes };
}

beforeEach(() => resetSnapshotState());

describe('copia remota de la base de datos', () => {
  it('guarda la base y la restaura en un disco vacío, con todos sus datos', async () => {
    const up = fakeUpstash();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
    const db = openDb(path.join(dir, 'a.sqlite'));
    kvSet(db, 'prueba', { hola: 'mundo' });
    kvSet(db, 'estimate:g', { grande: 'x'.repeat(2_000_000) }); // caché: no se copia
    db.prepare("insert into players(name, name_norm, created_at, updated_at) values('Ana Prueba','ana prueba','x','x')").run();
    expect(await saveSnapshot(db, up.cfg)).toBe(true);

    const restored = path.join(dir, 'b', 'club.sqlite');
    expect(await restoreIfMissing(restored, up.cfg)).toBe(true);
    const db2 = openDb(restored);
    expect(kvGet<{ hola: string }>(db2, 'prueba')?.hola).toBe('mundo');
    expect(db2.prepare('select name from players').get()).toEqual({ name: 'Ana Prueba' });
    expect(kvGet(db2, 'estimate:g')).toBeUndefined();
    expect(up.store.size).toBeLessThanOrEqual(2); // un trozo + meta
  });

  it('solo guarda lo imprescindible y no reenvía por marcas de lectura que cambian a cada minuto', async () => {
    const up = fakeUpstash();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
    const db = openDb(path.join(dir, 'a.sqlite'));
    db.prepare("insert into subscribers(email, created_at) values('a@b.es','x')").run();
    kvSet(db, 'ok:day:g:2026-11-07', { at: 'a' });
    expect(await saveSnapshot(db, up.cfg)).toBe(true);
    const w = up.writes();
    kvSet(db, 'ok:day:g:2026-11-07', { at: 'b' }); // marca de lectura: no cambia nada importante
    db.prepare("insert into slots(key, tournament_guid, date, status, updated_at) values('k','g','2026-11-07','scheduled','x')").run();
    expect(await saveSnapshot(db, up.cfg)).toBe(false);
    expect(up.writes()).toBe(w);
    db.prepare("insert into subscribers(email, created_at) values('c@d.es','x')").run();
    expect(await saveSnapshot(db, up.cfg)).toBe(true); // un suscriptor nuevo sí se guarda
  });

  it('no restaura si ya hay base de datos, ni reenvía si no ha cambiado', async () => {
    const up = fakeUpstash();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
    const file = path.join(dir, 'c.sqlite');
    const db = openDb(file);
    expect(await saveSnapshot(db, up.cfg)).toBe(true);
    const w = up.writes();
    expect(await saveSnapshot(db, up.cfg)).toBe(false);
    expect(up.writes()).toBe(w);
    expect(await restoreIfMissing(file, up.cfg)).toBe(false); // ya existe
  });

  it('sin configuración o sin copia previa, no hace nada y no falla', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
    expect(await restoreIfMissing(path.join(dir, 'd.sqlite'), undefined)).toBe(false);
    expect(await restoreIfMissing(path.join(dir, 'e.sqlite'), fakeUpstash().cfg)).toBe(false);
    expect(await saveSnapshot(openDb(path.join(dir, 'f.sqlite')), undefined)).toBe(false);
  });
});

import zlib from 'node:zlib';
import { openBackup, sealBackup } from '../src/backupCrypto';
import { backupState, essentialSnapshot, resetServedBackup, servedBackup } from '../src/remoteBackup';

describe('copia cifrada en GitHub (sin pagar a nadie)', () => {
  it('cifra y descifra; el mismo contenido da el mismo archivo; con otra clave falla', () => {
    const plain = Buffer.from('suscriptores y consentimientos');
    const a = sealBackup(plain, 'clave-secreta-larga');
    expect(a.subarray(0, 4).toString()).toBe('CUB1');
    expect(a.includes(plain)).toBe(false);
    expect(sealBackup(plain, 'clave-secreta-larga').equals(a)).toBe(true);
    expect(openBackup(a, 'clave-secreta-larga').equals(plain)).toBe(true);
    expect(() => openBackup(a, 'otra-clave')).toThrow();
    expect(() => openBackup(Buffer.from('basura'), 'clave-secreta-larga')).toThrow();
  });

  const mkDb = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
    const db = openDb(path.join(dir, 'a.sqlite'));
    db.prepare("insert into players(name, name_norm, created_at, updated_at) values('Ana Prueba','ana prueba','x','x')").run();
    db.prepare("insert into subscribers(email, created_at, confirmed_at) values('a@b.es','x','y')").run();
    return { dir, db };
  };

  it('el servidor sirve la copia cifrada y, en un disco vacío, se restaura desde GitHub con todos sus datos', async () => {
    resetServedBackup();
    const { dir, db } = mkDb();
    const blob = servedBackup(db, 'clave-secreta-larga')!;
    expect(blob).toBeDefined();
    expect(blob.includes(Buffer.from('a@b.es'))).toBe(false); // el correo no aparece en claro

    const restored = path.join(dir, 'nuevo', 'club.sqlite');
    const fetchImpl = (async () => new Response(new Uint8Array(blob))) as typeof fetch;
    expect(await restoreIfMissing(restored, undefined, { url: 'https://raw.test/club.bin', secret: 'clave-secreta-larga', fetchImpl })).toBe(true);
    expect(backupState.restoredFrom).toBe('github');
    const db2 = openDb(restored);
    expect(db2.prepare('select email from subscribers').get()).toEqual({ email: 'a@b.es' });
    expect(db2.prepare('select name from players').get()).toEqual({ name: 'Ana Prueba' });
  });

  it('sin copia en GitHub (404) no falla; con una copia ilegible se bloquea la publicación de copias nuevas', async () => {
    resetServedBackup();
    backupState.restoreFailed = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
    const f404 = (async () => new Response('no', { status: 404 })) as typeof fetch;
    expect(await restoreIfMissing(path.join(dir, 'a', 'club.sqlite'), undefined, { url: 'https://raw.test/x', secret: 's', fetchImpl: f404 })).toBe(false);
    expect(backupState.restoreFailed).toBeFalsy();

    const bad = (async () => new Response('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) as typeof fetch;
    expect(await restoreIfMissing(path.join(dir, 'b', 'club.sqlite'), undefined, { url: 'https://raw.test/x', secret: 's', fetchImpl: bad })).toBe(false);
    expect(backupState.restoreFailed).toBe(true);
    const { db } = mkDb();
    expect(servedBackup(db, 's')).toBeUndefined(); // no se pisa la copia buena con una base vacía
    backupState.restoreFailed = false;
  });

  it('la copia no cambia (mismo archivo) mientras no cambie nada importante', () => {
    resetServedBackup();
    const { db } = mkDb();
    kvSet(db, 'ok:day:g:1', { at: 'a' });
    const a = sealBackup(essentialSnapshot(db).gz, 'k');
    kvSet(db, 'ok:day:g:1', { at: 'b' });
    expect(sealBackup(essentialSnapshot(db).gz, 'k').equals(a)).toBe(true);
    db.prepare("insert into subscribers(email, created_at) values('c@d.es','x')").run();
    expect(sealBackup(essentialSnapshot(db).gz, 'k').equals(a)).toBe(false);
    expect(zlib.gunzipSync(essentialSnapshot(db).gz).length).toBeGreaterThan(0);
  });
});
