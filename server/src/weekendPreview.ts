import { settings } from './config';
import { daysBetween } from './dates';
import { type Db, kvGet, kvSet, nowIso } from './db';
import type { PublicMatch, PublicState, PublicTournament } from './publicView';
import { sendNotice, type NoticeDeps } from './notify';
import { clockOf, dateRange, dayLabel } from './share';

/**
 * «Previa del finde» por correo: cada jueves a las 15:00 (Madrid), para cada torneo con jugadores de la UVa que empieza en los próximos días,
 * quién juega y a qué hora es su primer partido (hora estimada y oficial), el primer partido del club y cuántos tiene cada persona.
 * Solo usa los datos públicos (jugadores con consentimiento; rivales según la política publicada).
 */
const TZ = 'Europe/Madrid';

/** Día de la semana (0 = domingo), fecha y minutos desde medianoche en Madrid. */
function madridNow(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) % 24 * 60 + Number(parts.minute) };
}

const startOf = (m: PublicMatch) => m.estimatedStart ?? m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;
const timeOf = (m: PublicMatch) => {
  const est = m.state === 'scheduled' && m.estimatedStart ? clockOf(m.estimatedStart) : undefined;
  const plan = m.plannedStart ? clockOf(m.plannedStart) : m.time;
  if (est && plan && est !== plan) return `${est} (estimada; oficial ${plan})`;
  return est ? `${est} (estimada)` : plan ?? 'hora por confirmar';
};
const what = (m: PublicMatch) => [m.event, m.court && `Pista ${m.court}`, m.opponent && `vs ${m.opponent}`].filter(Boolean).join(' · ');

/** Texto del correo de un torneo. */
export function previewText(t: PublicTournament, site: string): string {
  const upcoming = t.matches.filter((m) => m.state !== 'finished').sort((a, b) => startOf(a).localeCompare(startOf(b)));
  const head = `PREVIA DEL FINDE · ${t.name}\n${dateRange(t.startDate, t.endDate)}${t.city ? ` · ${t.city}` : ''}\n`;
  const foot = `\nLas horas estimadas se ajustan con el ritmo real del torneo y pueden cambiar; la web las actualiza en directo:\n${site}/directo\n`;
  if (upcoming.length === 0) {
    const players = [...new Set(t.entries.filter((e) => e.status !== 'excluded').map((e) => e.player))].sort((a, b) => a.localeCompare(b, 'es'));
    return `${head}\nTodavía no está publicado el orden de juego.${players.length ? `\nJugadores de la UVa inscritos: ${players.join(', ')}.` : ''}\nSe volverá a leer cada pocos minutos en la web.\n${foot}`;
  }
  const first = upcoming[0];
  const day = (m: PublicMatch) => (m.date ? dayLabel(m.date) : '');
  const byPlayer = new Map<string, PublicMatch[]>();
  for (const m of upcoming) for (const name of m.players) byPlayer.set(name, [...(byPlayer.get(name) ?? []), m]);
  const lines = [...byPlayer]
    .map(([name, ms]) => ({ name, first: ms[0], n: ms.length }))
    .sort((a, b) => startOf(a.first).localeCompare(startOf(b.first)) || a.name.localeCompare(b.name, 'es'))
    .map((p) => `- ${p.name}: ${day(p.first)} ${timeOf(p.first)} · ${what(p.first)}${p.first.players.length > 1 ? ` (con ${p.first.players.filter((x) => x !== p.name).join(' / ')})` : ''}${p.n > 1 ? ` (+${p.n - 1} partido${p.n > 2 ? 's' : ''} más programado${p.n > 2 ? 's' : ''})` : ''}`);
  return `${head}\nPRIMER PARTIDO DEL CLUB: ${day(first)} ${timeOf(first)} · ${first.players.join(' / ')} · ${what(first)}\n\nPRIMER PARTIDO DE CADA JUGADOR (por orden de hora):\n${lines.join('\n')}\n\nPartidos de la UVa programados en total: ${upcoming.length}.\n${foot}`;
}

export type PreviewDeps = NoticeDeps;

/**
 * Cada minuto: si es la hora de la previa (jueves a las 15:00 de Madrid, dentro de la ventana) envía un correo por cada torneo con jugadores de la UVa
 * que empieza en 1-4 días y aún no se haya enviado. Devuelve cuántos envió.
 */
export async function sendWeekendPreviews(db: Db, state: PublicState, now: Date, deps: PreviewDeps = {}): Promise<number> {
  const c = settings.weekendPreview;
  if (!c.email) return 0;
  const m = madridNow(now);
  const since = m.minutes - c.hour * 60;
  if (m.weekday !== c.weekday || since < 0 || since > c.windowMin) return 0;
  const site = settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';
  let sent = 0;
  for (const t of state.tournaments) {
    if (!t.startDate || t.manual) continue;
    const d = daysBetween(m.date, t.startDate);
    if (d < 1 || d > 4 || (t.matches.length === 0 && t.entries.length === 0)) continue;
    const key = `weekend-preview:${t.id}:${t.startDate}`;
    if (kvGet(db, key)) continue;
    await sendNotice(c.email, `Previa del finde · ${t.name} · primeros partidos de la UVa`, previewText(t, site), deps, { nombre: 'Previa', apellidos: 'Finde' }); // sin marcar si falla: se reintenta el minuto siguiente dentro de la ventana
    kvSet(db, key, { at: nowIso() });
    sent++;
  }
  return sent;
}
