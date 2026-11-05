import { settings } from './config';

/** Un correo saliente. `html` y `text` van juntos (el texto es la alternativa). */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Cabeceras extra (p. ej. List-Unsubscribe, que permite darse de baja con un clic desde el propio cliente de correo). */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Proveedor de correo real: Brevo o Resend (API HTTP, sin dependencias). Devuelve `undefined` si no está configurado
 * (MAIL_PROVIDER + clave + MAIL_FROM): entonces las suscripciones se muestran como «aún no activadas».
 */
export function realMailer(fetchImpl: typeof fetch = fetch): Mailer | undefined {
  const m = settings.mail;
  if (!m.provider || !m.apiKey || !m.from) return undefined;
  if (m.provider === 'brevo') {
    return {
      async send(mail) {
        const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': m.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender: { name: m.fromName, email: m.from }, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text, headers: mail.headers }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Brevo: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      },
    };
  }
  if (m.provider === 'resend') {
    return {
      async send(mail) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: `${m.fromName} <${m.from}>`, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Resend: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      },
    };
  }
  return undefined;
}
