import { createCipheriv, createDecipheriv, createHmac, scryptSync } from 'node:crypto';

/**
 * Cifrado de la copia de seguridad que se guarda en GitHub (rama `backup-data`, repositorio público): AES-256-GCM con una clave derivada de
 * ADMIN_TOKEN, que solo conoce el servidor. El IV sale de un HMAC del contenido, de modo que el mismo contenido da siempre el mismo
 * archivo (y GitHub no recibe commits nuevos si no ha cambiado nada). Formato: «CUB1» · IV (12) · etiqueta (16) · datos cifrados.
 */
const MAGIC = Buffer.from('CUB1');
let cached: { secret: string; enc: Buffer; mac: Buffer } | undefined;

function keys(secret: string) {
  if (cached?.secret !== secret) {
    const k = scryptSync(secret, 'club-uva-backup-v1', 64);
    cached = { secret, enc: k.subarray(0, 32), mac: k.subarray(32) };
  }
  return cached;
}

export function sealBackup(plain: Buffer, secret: string): Buffer {
  const k = keys(secret);
  const iv = createHmac('sha256', k.mac).update(plain).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

/** Descifra una copia; lanza un error si el formato o la clave no son los correctos. */
export function openBackup(blob: Buffer, secret: string): Buffer {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('formato de copia no válido');
  const k = keys(secret);
  const d = createDecipheriv('aes-256-gcm', k.enc, blob.subarray(4, 16));
  d.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([d.update(blob.subarray(32)), d.final()]);
}
