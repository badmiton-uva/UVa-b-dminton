import { settings } from './config';
import { daysBetween } from './dates';
import { type Db, kvGet, kvSet, nowIso } from './db';
import { eventName } from './news';
import type { PublicMatch, PublicState, PublicTournament } from './publicView';
import { sendNotice, type NoticeDeps } from './notify';
import { clockOf, dateRange } from './share';
import { buildSocial } from './social';

/**
 * «Resultados del finde» por correo: el domingo a las 15:00 (Madrid), para cada torneo del fin de semana con jugadores de la UVa, los resultados del
 * club (balance, medallas y partido a partido por jugador) y un mensaje listo para publicar en redes con los enlaces de las imágenes.
 * Solo usa los datos públicos (jugadores con consentimiento).
 */
const TZ = 'Europe/Madrid';

function madridNow(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

const startOf = (m: PublicMatch) => m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;
const line = (m: PublicMatch) => {
  const rival = m.opponent ? ` vs ${m.opponent}` : '';
  const where = [m.event, m.court && `Pista ${m.court}`].filter(Boolean).join(' · ');
  if (m.state === 'finished') return `${m.outcome === 'win' ? 'V' : m.outcome === 'loss' ? 'D' : '·'} ${m.score ?? 'sin marcador'}${rival} · ${where}`;
  if (m.state === 'live') return `JUGANDO AHORA${rival} · ${where}`;
  const at = m.estimatedStart ?? m.plannedStart;
  return `pendiente ${at ? `a las ${clockOf(at)}` : m.time ?? ''}${m.estimatedStart ? ' (estimada)' : ''}${rival} · ${where}`;
};

/** Texto del correo de un torneo: resultados del club y mensaje para redes. */
export function resultsText(t: PublicTournament, site: string, base: string): string {
  const social = buildSocial({ tournaments: [t] } as PublicState, 'resultados', base, new Date(`${t.endDate ?? t.startDate}T12:00:00Z`))[0];
  const finished = t.matches.filter((m) => m.state === 'finished');
  const pending = t.matches.filter((m) => m.state !== 'finished');
  const wins = finished.filter((m) => m.outcome === 'win').length;
  const losses = finished.filter((m) => m.outcome === 'loss').length;
  const open = pending.length > 0 || t.progress?.done === false;
  const head = `RESULTADOS DEL FINDE · ${t.name}\n${dateRange(t.startDate, t.endDate)}${t.city ? ` · ${t.city}` : ''}\n${open ? '\n⚠ EL TORNEO SIGUE EN JUEGO: resultados provisionales hasta ahora.\n' : ''}`;
  const record = `\nBALANCE DEL CLUB: ${wins} victoria${wins === 1 ? '' : 's'} y ${losses} derrota${losses === 1 ? '' : 's'}${pending.length ? `; ${pending.length} partido${pending.length === 1 ? '' : 's'} por jugar` : ''}.${t.record && (t.record.won || t.record.lost) ? ` (Balance oficial del torneo: ${t.record.won} ganados, ${t.record.lost} perdidos.)` : ''}\n`;
  const medals = t.results.filter((r) => r.place).sort((a, b) => a.place! - b.place!);
  const medalsTxt = medals.length ? `\nMEDALLAS: ${medals.length}\n${medals.map((r) => `- ${r.place === 1 ? 'ORO' : r.place === 2 ? 'PLATA' : 'BRONCE'} · ${eventName(r.event)} · ${r.entrant}${r.score ? ` (${r.score})` : ''}`).join('\n')}\n` : '\nSin medallas hasta ahora.\n';
  const others = t.results.filter((r) => !r.place);
  const othersTxt = others.length ? `\nOTRAS PRUEBAS:\n${others.map((r) => `- ${eventName(r.event)} · ${r.entrant}: ${r.text}`).join('\n')}\n` : '';
  const byPlayer = new Map<string, PublicMatch[]>();
  for (const m of [...t.matches].sort((a, b) => startOf(a).localeCompare(startOf(b)))) for (const n of m.players) byPlayer.set(n, [...(byPlayer.get(n) ?? []), m]);
  const players = [...byPlayer].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([n, ms]) => `${n}\n${ms.map((m) => `   ${line(m)}`).join('\n')}`).join('\n\n');
  const redes = social
    ? `\n————————————————\nMENSAJE PARA REDES (copia y pega):\n\n${social.caption}${open ? '\n\n(Provisional: si el torneo sigue en juego, actualiza los números antes de publicar.)' : ''}\n\nVersión corta para stories: ${social.short}\n\nIMÁGENES (ábrelas o guárdalas):\n- Cuadrada (Instagram): ${social.images.square}\n- Vertical (historia): ${social.images.story}\n`
    : '';
  return `${head}${record}${medalsTxt}${othersTxt}\nRESULTADOS POR JUGADOR:\n${players}\n${redes}\nWeb en directo: ${site}/directo\n`;
}

export type ResultsDeps = NoticeDeps;

/**
 * Cada minuto: el domingo a las 15:00 de Madrid (y hasta `windowMin` después) envía un correo por cada torneo que se juega ese fin de semana
 * (empezó hace 0-3 días y aún no terminó ayer) con jugadores de la UVa y algún partido jugado. Una vez por torneo y día. Devuelve cuántos envió.
 */
export async function sendWeekendResults(db: Db, state: PublicState, now: Date, deps: ResultsDeps = {}): Promise<number> {
  const c = settings.weekendResults;
  if (!c.email) return 0;
  const m = madridNow(now);
  const since = m.minutes - c.hour * 60;
  if (m.weekday !== c.weekday || since < 0 || since > c.windowMin) return 0;
  const site = settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';
  const base = settings.itinerary.baseUrl;
  let sent = 0;
  for (const t of state.tournaments) {
    if (!t.startDate || t.manual) continue;
    const last = t.endDate ?? t.startDate;
    if (t.startDate > m.date || daysBetween(t.startDate, m.date) > 3 || last < m.date || !t.matches.some((x) => x.state === 'finished')) continue;
    const key = `weekend-results:${t.id}:${m.date}`;
    if (kvGet(db, key)) continue;
    await sendNotice(c.email, `Resultados del finde · ${t.name} · mensaje para redes`, resultsText(t, site, base), deps, { nombre: 'Resultados', apellidos: 'Finde' });
    kvSet(db, key, { at: nowIso() });
    sent++;
  }
  return sent;
}
