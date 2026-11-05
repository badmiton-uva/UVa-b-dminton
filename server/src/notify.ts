import { settings } from './config';
import { escapeHtml } from './subscribers';
import type { Mailer } from './mailer';

/**
 * Aviso por correo al responsable del club (previa del finde, resultados, capturas del itinerario…): por el proveedor de correo (Brevo/Resend) si está
 * configurado, que es fiable; si no, por FormSubmit. Lanza error si no sale, para que quien llama lo reintente.
 */
export interface NoticeDeps {
  fetchImpl?: typeof fetch;
  mailer?: Mailer;
}

export async function sendNotice(to: string, subject: string, text: string, deps: NoticeDeps = {}, formName: { nombre: string; apellidos: string } = { nombre: 'Aviso', apellidos: 'Club' }): Promise<void> {
  if (deps.mailer) {
    const html = `<div style="font-family:Arial,sans-serif;color:#14132f;white-space:pre-wrap;line-height:1.45">${escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;
    await deps.mailer.send({ to, subject, text, html });
    return;
  }
  const site = settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';
  const res = await (deps.fetchImpl ?? fetch)(`https://formsubmit.co/ajax/${to}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: new URL(site).origin, referer: `${site}/contacto` },
    body: JSON.stringify({ ...formName, email: to, mensaje: text, _subject: subject, _template: 'table', _captcha: 'false' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Correo "${subject}": HTTP ${res.status}`);
}
