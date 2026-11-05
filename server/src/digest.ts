import { daysBetween, todayIn } from './dates';
import { type Db, kvGet, kvSet, nowIso } from './db';
import type { Mailer } from './mailer';
import { eventName } from './news';
import type { PublicMatch, PublicState, PublicTournament } from './publicView';
import { dateRange, dayLabel } from './share';
import { escapeHtml, listConfirmed, type Subscriber, unsubscribeUrl } from './subscribers';
import { settings } from './config';

/**
 * Resumen semanal por correo de lo que ha pasado con las personas que sigue cada suscriptor (o con todo el equipo): partidos jugados (victorias y derrotas),
 * medallas, noticias nuevas y próximos torneos. Si no hay nada nuevo, no se envía. Solo datos públicos (jugadores con consentimiento).
 */
const TZ = 'Europe/Madrid';
const site = () => settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';

export interface Digest {
  subject: string;
  text: string;
  html: string;
  wins: number;
  losses: number;
}

const mentions = (names: Set<string> | 'all', who: string[]) => names === 'all' || who.some((n) => names.has(n));

/** Construye el resumen de un suscriptor desde `since` (exclusive) hasta hoy. `undefined` si no hay nada que contar. */
export function buildDigest(state: PublicState, sub: Pick<Subscriber, 'allTeam' | 'playerIds'>, since: string, today: string, unsubUrl: string): Digest | undefined {
  const names: Set<string> | 'all' = sub.allTeam ? 'all' : new Set(sub.playerIds.map((id) => state.players.find((p) => p.id === id)?.name).filter((x): x is string => !!x));
  if (names !== 'all' && names.size === 0) return undefined;
  const followed = names === 'all' ? 'todo el equipo' : [...names].join(', ');

  const sections: { title: string; lines: string[] }[] = [];
  let wins = 0;
  let losses = 0;
  const results: string[] = [];
  const medals: string[] = [];
  for (const t of state.tournaments) {
    const ms = t.matches.filter((m) => m.state === 'finished' && !!m.date && m.date > since && m.date <= today && mentions(names, m.players));
    const mine = (m: PublicMatch) => (names === 'all' ? m.players : m.players.filter((n) => names.has(n))).join(' / ');
    for (const m of ms.sort((a, b) => (a.plannedStart ?? '').localeCompare(b.plannedStart ?? ''))) {
      if (m.outcome === 'win') wins++;
      if (m.outcome === 'loss') losses++;
      results.push(`${m.outcome === 'win' ? '✅ Victoria' : m.outcome === 'loss' ? '❌ Derrota' : '·'} · ${mine(m)}${m.opponent ? ` vs ${m.opponent}` : ''} · ${m.score ?? 'sin marcador'} · ${[m.event, t.name].filter(Boolean).join(' · ')} (${m.date ? dayLabel(m.date) : ''})`);
    }
    const last = t.endDate ?? t.startDate;
    if (last && last > since && last <= today) {
      for (const r of t.results.filter((x) => x.place && mentions(names, x.entrant.split(/\s+\/\s+/)))) medals.push(`${r.place === 1 ? '🥇 Oro' : r.place === 2 ? '🥈 Plata' : '🥉 Bronce'} · ${eventName(r.event)} · ${r.entrant}${r.score ? ` (${r.score})` : ''} · ${t.name}`);
    }
  }
  if (results.length) sections.push({ title: 'Partidos', lines: results });
  if (medals.length) sections.push({ title: 'Medallas', lines: medals });

  const news = state.news.filter((n) => n.date > since && n.date <= today && state.tournaments.some((t) => t.id === n.tournamentGuid && (names === 'all' || t.uvaPlayers.some((p) => names.has(p)))));
  if (news.length) sections.push({ title: 'Noticias', lines: news.map((n) => `${n.title}\n   ${n.summary}`) });

  const upcoming = state.tournaments.filter((t: PublicTournament) => t.startDate && t.startDate > today && daysBetween(today, t.startDate) <= 14 && (names === 'all' ? t.uvaPlayers.length > 0 : t.uvaPlayers.some((p) => names.has(p))));
  if (upcoming.length) sections.push({ title: 'Próximos torneos', lines: upcoming.map((t) => `${t.name} · ${dateRange(t.startDate, t.endDate)}${t.city ? ` · ${t.city}` : ''}`) });

  // Sin partidos, medallas ni noticias nuevos no se escribe a nadie (los próximos torneos solos no justifican un correo).
  if (!results.length && !medals.length && !news.length) return undefined;

  const record = results.length ? `${wins} victoria${wins === 1 ? '' : 's'} y ${losses} derrota${losses === 1 ? '' : 's'} esta semana` : 'Novedades del club';
  const subject = `Club Bádminton UVa · ${record}`;
  const text = `Resumen para ti: ${followed}\n\n${sections.map((s) => `${s.title.toUpperCase()}\n${s.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')}\n\nTodo en directo: ${site()}/directo\n\nRecibes este correo porque te suscribiste en la web del Club Bádminton Universidad de Valladolid. Para darte de baja: ${unsubUrl}\n`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#14132f"><h2 style="color:#2f2c64;margin-bottom:4px">${escapeHtml(record)}</h2><p style="color:#566072;margin-top:0">Resumen para ti: ${escapeHtml(followed)}</p>${sections.map((s) => `<h3 style="color:#2f2c64;border-bottom:2px solid #7a3fe0;padding-bottom:4px">${s.title}</h3><ul style="padding-left:18px">${s.lines.map((l) => `<li style="margin:6px 0">${escapeHtml(l).replace(/\n\s+/g, '<br><span style="color:#566072">') + (l.includes('\n') ? '</span>' : '')}</li>`).join('')}</ul>`).join('')}<p><a href="${site()}/directo" style="display:inline-block;background:#2f2c64;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px">Ver en directo</a></p><p style="font-size:12px;color:#566072">Recibes este correo porque te suscribiste en la web del Club Bádminton Universidad de Valladolid. <a href="${unsubUrl}">Darme de baja</a></p></div>`;
  return { subject, text, html, wins, losses };
}

function madridNow(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/**
 * Cada minuto: en la hora del resumen semanal (por defecto, domingos a las 21:00 de Madrid, hasta 3 h después) envía el resumen a cada suscriptor confirmado
 * que tenga algo nuevo; a cada uno, una sola vez al día. Va de 25 en 25 por pasada para no pasar el límite del proveedor. Devuelve cuántos envió.
 */
export async function sendDigests(db: Db, state: PublicState, now: Date, mailer: Mailer): Promise<number> {
  const c = settings.subscriptions;
  const m = madridNow(now);
  const since0 = m.minutes - c.digestHour * 60;
  if (m.weekday !== c.digestWeekday || since0 < 0 || since0 > c.digestWindowMin) return 0;
  const today = todayIn(TZ, now);
  let sent = 0;
  for (const sub of listConfirmed(db)) {
    if (sent >= 25) break;
    if (kvGet(db, `digest:${sub.id}:${today}`)) continue;
    const d = buildDigest(state, sub, sub.lastDigestDate ?? today, today, unsubscribeUrl(db, sub.id));
    if (!d) {
      kvSet(db, `digest:${sub.id}:${today}`, { at: nowIso(), empty: true }); // nada nuevo: no se vuelve a calcular hoy
      db.prepare('update subscribers set last_digest_date = ? where id = ?').run(today, sub.id);
      continue;
    }
    try {
      await mailer.send({ to: sub.email, subject: d.subject, text: d.text, html: d.html, headers: { 'List-Unsubscribe': `<${unsubscribeUrl(db, sub.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    } catch (e) {
      // Un fallo con una dirección no debe frenar al resto: se reintenta en los minutos siguientes y, tras 3 fallos hoy, se deja para la semana próxima.
      const fails = (kvGet<{ n: number }>(db, `digest-fail:${sub.id}:${today}`)?.n ?? 0) + 1;
      kvSet(db, `digest-fail:${sub.id}:${today}`, { n: fails });
      if (fails >= 3) kvSet(db, `digest:${sub.id}:${today}`, { at: nowIso(), failed: true });
      console.error('resumen semanal', sub.id, (e as Error).message);
      continue;
    }
    kvSet(db, `digest:${sub.id}:${today}`, { at: nowIso() });
    db.prepare('update subscribers set last_digest_date = ? where id = ?').run(today, sub.id);
    sent++;
  }
  return sent;
}
