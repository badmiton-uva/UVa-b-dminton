import { randomBytes } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { settings } from './config';
import { todayIn } from './dates';
import { type Db, nowIso } from './db';
import type { PublicMatch, PublicState, PublicTournament } from './publicView';
import { sendNotice, type NoticeDeps } from './notify';
import { clip, clockOf, dayLabel, esc, FONT_FILES, fit, LOGO, upper, wrap } from './share';

/**
 * Captura del itinerario en vivo («Partidos por horas» de Directo) como imagen PNG: se genera sola 15 minutos antes de que empiece
 * cada torneo con jugadores del club y se envía por correo (con el enlace a la imagen guardada, que no cambia después).
 * Solo usa los datos públicos ya filtrados (jugadores con consentimiento); no lleva rivales.
 */
const TZ = 'Europe/Madrid';

const clockMin = (iso: string) => {
  const [h, m] = clockOf(iso)!.split(':').map(Number);
  return h * 60 + m;
};
/** Hora con la que se coloca cada partido: la estimada si aún no ha empezado; si no, la programada. */
const shownAt = (m: PublicMatch): string | undefined => (m.state === 'scheduled' ? m.estimatedStart ?? m.plannedStart : m.plannedStart ?? m.estimatedStart);

const STATUS = {
  scheduled: { text: 'PROGRAMADO', bg: '#dcebf7', fg: '#174a75', bar: '#2367a0', card: '#f5f7fa' },
  live: { text: 'EN JUEGO', bg: '#2f2c64', fg: '#ffffff', bar: '#e5383b', card: '#fdeeee' },
  finished: { text: 'FINALIZADO', bg: '#e6e9f0', fg: '#5b6a8a', bar: '#2f2c64', card: '#eef0fa' },
} as const;

function sets(score?: string): [string, string][] {
  if (!score || /^(W\.O\.|Retirada)/i.test(score)) return [];
  return score.split(/\s+/).flatMap((s) => (/^\d+-\d+$/.test(s) ? [s.split('-') as [string, string]] : []));
}

const text = (x: number, y: number, s: string, size: number, fill: string, weight = 700, extra = '') => `<text x="${x}" y="${y}" font-weight="${weight}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const slant = (x: number, y: number, w: number, h: number, k: number, fill: string) => `<polygon points="${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}" fill="${fill}"/>`;

/** Formato: `wide` = una sola imagen ancha (como la web); `story` = páginas verticales 1080×1920 para historias (el diseño se dibuja en 800 de ancho y se amplía). */
export type ItineraryFormat = 'wide' | 'story';
const LAYOUT = {
  wide: { w: 1200, pad: 28, hourW: 100 },
  story: { w: 800, pad: 24, hourW: 78 },
} as const;
const STORY_H = Math.round((1920 * 800) / 1080); // alto lógico de una página de historia

interface Item {
  kind: 'card' | 'now';
  h: number;
  hour?: number;
  draw: (y: number, showHour: boolean) => string;
}

function cardItem(m: PublicMatch, f: ItineraryFormat): Item {
  const { w, pad, hourW } = LAYOUT[f];
  const cx = pad + hourW;
  const cw = w - cx - pad;
  const at = shownAt(m)!;
  const st = STATUS[m.state];
  const done = m.state === 'finished';
  const ss = done ? sets(m.score) : [];
  const hasResult = done && !!(m.score || m.outcome);
  const estimated = m.state === 'scheduled' && !!m.estimatedStart;
  const wide = f === 'wide';
  const h = wide ? (hasResult ? 124 : done ? 96 : 92) : hasResult ? 168 : 124;
  const hour = Math.floor(clockMin(at) / 60);
  const names = m.players.join(' / ');
  const sub = [m.opponent ? `vs ${m.opponent}` : '', m.event, m.court ? `Pista ${m.court}` : ''].filter(Boolean).join(' · ');

  const draw = (y: number, showHour: boolean) => {
    let g = '';
    if (showHour) g += text(pad, y + (wide ? 36 : 34), `${String(hour).padStart(2, '0')}:00`, wide ? 32 : 28, '#14132f', 800);
    g += `<rect x="${cx}" y="${y}" width="${cw}" height="${h}" fill="${st.card}"/><rect x="${cx}" y="${y}" width="7" height="${h}" fill="${st.bar}"/>`;
    const chipW = st.text.length * (wide ? 13 : 11) + 34;
    const chipH = wide ? 32 : 28;
    const chip = (yy: number) => slant(cx + cw - chipW - 14, yy, chipW, chipH, 10, st.bg) + text(cx + cw - 14 - chipW / 2 - 2, yy + chipH * 0.72, st.text, wide ? 22 : 19, st.fg, 800, 'text-anchor="middle" letter-spacing="2"');
    if (wide) {
      if (estimated) g += `<rect x="${cx + 24}" y="${y + 12}" width="44" height="24" rx="3" fill="#dcebf7"/>${text(cx + 46, y + 30, 'EST', 18, '#174a75', 800, 'text-anchor="middle" letter-spacing="1"')}`;
      g += text(cx + 24, y + (estimated ? 70 : 52), clockOf(at)!, 44, '#2f2c64', 800);
      const nx = cx + 150;
      const maxW = cw - 150 - 220;
      const size = fit(names, maxW, 32, 22);
      g += text(nx, y + 40, clip(names, maxW, size), size, '#14132f', 800);
      g += text(nx, y + 72, clip(sub, maxW, 22), 22, '#566072', 400);
      g += chip(y + 14);
      if (hasResult) g += result(nx, y + 108, 22, 28, 48, 34, 116);
    } else {
      let tx = cx + 22;
      if (estimated) {
        g += `<rect x="${tx}" y="${y + 20}" width="40" height="24" rx="3" fill="#dcebf7"/>${text(tx + 20, y + 38, 'EST', 17, '#174a75', 800, 'text-anchor="middle" letter-spacing="1"')}`;
        tx += 52;
      }
      g += text(tx, y + 46, clockOf(at)!, 40, '#2f2c64', 800);
      g += chip(y + 14);
      const maxW = cw - 44;
      const size = fit(names, maxW, 30, 18);
      g += text(cx + 22, y + 84, clip(names, maxW, size), size, '#14132f', 800);
      g += text(cx + 22, y + 110, clip(sub, maxW, 20), 20, '#566072', 400);
      if (hasResult) g += result(cx + 22, y + 152, 20, 26, 44, 32, 106);
    }
    return g;
  };
  const result = (x: number, baseY: number, wordSize: number, numSize: number, bw: number, bh: number, step: number) => {
    const word = m.outcome === 'win' ? 'VICTORIA' : m.outcome === 'loss' ? 'DERROTA' : 'FINALIZADO';
    let g = text(x, baseY, word, wordSize, m.outcome === 'win' ? '#1f9d55' : m.outcome === 'loss' ? '#c0392b' : '#5b6a8a', 800, 'letter-spacing="3"');
    let bx = x + (wordSize === 22 ? 130 : 120);
    if (ss.length) {
      for (const [a, b] of ss) {
        g += `<rect x="${bx}" y="${baseY - bh + 6}" width="${bw}" height="${bh}" fill="#2f2c64"/>${text(bx + bw / 2, baseY + 2, a, numSize, '#fff', 800, 'text-anchor="middle"')}`;
        g += `<rect x="${bx + bw + 4}" y="${baseY - bh + 6}" width="${bw}" height="${bh}" fill="none" stroke="#2f2c64" stroke-width="2"/>${text(bx + bw + 4 + bw / 2, baseY + 2, b, numSize, '#2f2c64', 800, 'text-anchor="middle"')}`;
        bx += step;
      }
    } else if (m.score) g += text(bx, baseY, m.score, numSize - 2, '#2f2c64', 800);
    return g;
  };
  return { kind: 'card', h, hour, draw };
}

function nowItem(now: Date, f: ItineraryFormat): Item {
  const { w, pad } = LAYOUT[f];
  return {
    kind: 'now',
    h: 18,
    draw: (y) => {
      const yy = y + 6;
      return `<line x1="${pad + 4}" x2="${w - pad}" y1="${yy}" y2="${yy}" stroke="#e5383b" stroke-width="3"/><circle cx="${pad + 4}" cy="${yy}" r="6" fill="#e5383b"/><rect x="${w - pad - 86}" y="${yy - 17}" width="86" height="34" rx="17" fill="#e5383b"/>${text(w - pad - 43, yy + 8, clockOf(now.toISOString())!, 24, '#fff', 800, 'text-anchor="middle"')}`;
    },
  };
}

const dayTitle = (date: string) => upper(new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)));
const siteHost = () => `${(settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton').replace(/^https?:\/\//, '')}/directo`;

/** Todas las páginas del itinerario de un día: una (`wide`) o las que hagan falta para que quepa en historias (`story`). */
export function itineraryPages(t: PublicTournament, date: string, now: Date, f: ItineraryFormat = 'wide'): string[] {
  const { w, pad } = LAYOUT[f];
  const wide = f === 'wide';
  const list = t.matches.filter((m) => m.date === date && shownAt(m)).sort((a, b) => shownAt(a)!.localeCompare(shownAt(b)!));
  const nowMin = clockMin(now.toISOString());
  const isToday = todayIn(TZ, now) === date;

  const items: Item[] = [];
  let nowDone = !isToday || list.length === 0;
  for (const m of list) {
    if (!nowDone && clockMin(shownAt(m)!) > nowMin) {
      items.push(nowItem(now, f));
      nowDone = true;
    }
    items.push(cardItem(m, f));
  }
  if (!nowDone) items.push(nowItem(now, f));

  // Cabecera de la primera página y, en historias, una más corta para las siguientes.
  const dayText = dayTitle(date);
  const hoy = (x: number, y: number) => (isToday ? slant(x, y - 28, wide ? 84 : 70, wide ? 28 : 24, 10, '#e5383b') + text(x + (wide ? 42 : 35), y - 7, 'HOY', wide ? 22 : 19, '#fff', 800, 'text-anchor="middle" letter-spacing="2"') : '');
  const head = (first: boolean, count: number): { svg: string; bottom: number } => {
    let g = '';
    let y: number;
    if (first) {
      const logo = wide ? 84 : 64;
      g += `<image href="${LOGO}" x="${pad}" y="${pad}" width="${logo}" height="${logo}"/>`;
      g += text(pad + logo + 20, pad + (wide ? 38 : 28), 'CLUB BÁDMINTON · UNIVERSIDAD DE VALLADOLID', wide ? 28 : 19, '#2367a0', 800, 'letter-spacing="3"');
      const title = upper(t.name);
      if (wide) {
        const size = fit(title, w - pad * 2 - 110, 46, 32);
        g += text(pad + logo + 20, pad + 84, clip(title, w - pad * 2 - 110, size), size, '#14132f', 800);
        y = pad + 84 + 56;
      } else {
        const lines = wrap(title, 36, 2);
        lines.forEach((l, i) => (g += text(pad + logo + 20, pad + 62 + i * 34, l, 32, '#14132f', 800)));
        y = pad + 62 + (lines.length - 1) * 34 + 58;
      }
      const label = 'PARTIDOS POR HORAS';
      g += text(pad, y, label, wide ? 46 : 36, '#14132f', 800);
      const px = pad + label.length * (wide ? 19.9 : 15.6) + 22;
      g += slant(px, y - (wide ? 34 : 28), wide ? 64 : 52, wide ? 28 : 24, 8, '#2367a0') + text(px + (wide ? 32 : 26), y - (wide ? 13 : 9), String(count), wide ? 26 : 22, '#fff', 800, 'text-anchor="middle"');
      y += wide ? 34 : 14;
      if (wide) {
        g += text(pad, y, 'Cada partido está colocado a su hora estimada; si aún no hay estimación, a la programada.', 22, '#566072', 400);
        y += 46;
      } else y += 30;
      g += text(pad, y, dayText, wide ? 32 : 26, '#14132f', 800, 'letter-spacing="1"');
      g += hoy(pad + dayText.length * (wide ? 15 : 12) + 24, y);
      y += 22;
    } else {
      g += `<image href="${LOGO}" x="${pad}" y="${pad - 4}" width="44" height="44"/>`;
      g += text(pad + 60, pad + 26, 'PARTIDOS POR HORAS · continúa', 26, '#14132f', 800);
      g += text(pad + 60, pad + 46, dayText, 17, '#566072', 700, 'letter-spacing="1"');
      y = pad + 64;
    }
    return { svg: g, bottom: y };
  };

  const footerH = 52;
  let cur: { item: Item; showHour: boolean }[] = [];
  const groups: { item: Item; showHour: boolean }[][] = [];
  const headFirst = head(true, list.length);
  const headNext = head(false, list.length);
  if (!wide) {
    let room = STORY_H - headFirst.bottom - footerH;
    let lastHour = -1;
    for (const it of items) {
      if (it.h + 10 > room && cur.length > 0) {
        groups.push(cur);
        cur = [];
        room = STORY_H - headNext.bottom - footerH;
        lastHour = -1;
      }
      const sh = it.kind === 'card' && (it.hour !== lastHour || cur.length === 0);
      cur.push({ item: it, showHour: sh });
      if (it.kind === 'card') lastHour = it.hour!;
      room -= it.h + 10;
    }
    groups.push(cur);
  } else {
    let lastHour = -1;
    groups.push(items.map((it) => {
      const sh = it.kind === 'card' && it.hour !== lastHour;
      if (it.kind === 'card') lastHour = it.hour!;
      return { item: it, showHour: sh };
    }));
  }

  const stampText = `Captura del ${clockOf(now.toISOString())} · ${siteHost()}`;
  return groups.map((g, i) => {
    const hd = i === 0 ? headFirst : headNext;
    let y = hd.bottom;
    let body = hd.svg;
    if (list.length === 0) {
      body += text(pad, y + 40, 'Aún no hay partidos con hora publicada para este día.', wide ? 28 : 24, '#566072', 400);
      y += 90;
    }
    for (const { item, showHour } of g) {
      body += item.draw(y, showHour);
      y += item.h + 10;
    }
    y += 18;
    const total = groups.length;
    body += text(pad, wide ? y + 10 : Math.max(y + 10, STORY_H - 24), `${stampText}${total > 1 ? ` · ${i + 1}/${total}` : ''}`, wide ? 22 : 17, '#566072', 400);
    const H = wide ? y + 40 : STORY_H;
    const outW = wide ? w : 1080;
    const outH = wide ? H : 1920;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${w} ${H}" font-family="Barlow Condensed"><rect width="${w}" height="${H}" fill="#ffffff"/><rect width="${w}" height="8" fill="#2f2c64"/>${body}</svg>`;
  });
}

export const itinerarySvg = (t: PublicTournament, date: string, now: Date): string => itineraryPages(t, date, now, 'wide')[0];

const png = (svg: string) => new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Barlow Condensed' } }).render().asPng();
export const renderItinerary = (t: PublicTournament, date: string, now: Date): Buffer => png(itinerarySvg(t, date, now));
/** Páginas verticales 1080×1920 para historias (una o varias, según cuántos partidos haya). */
export const renderItineraryStories = (t: PublicTournament, date: string, now: Date): Buffer[] => itineraryPages(t, date, now, 'story').map(png);

/* ------------------------------ Envío 15 min antes ------------------------------ */

export type ItineraryDeps = NoticeDeps;

/** Hora del primer partido del día (de todo el torneo si hay orden de juego; si no, el primero del club). */
function firstStart(db: Db, t: PublicTournament, date: string): number | undefined {
  const row = db.prepare('select min(planned_utc) p from slots where tournament_guid = ? and date = ? and planned_utc is not null').get(t.id, date) as unknown as { p: string | null };
  const club = t.matches.filter((m) => m.date === date && m.plannedStart).map((m) => m.plannedStart!).sort()[0];
  const first = row.p ?? club;
  return first ? Date.parse(first) : undefined;
}

export function captureUrl(id: string) {
  return `${settings.itinerary.baseUrl}/captura/${id}.png`;
}

/**
 * Cada minuto: si falta ≤ `minutesBefore` para el primer partido del día de un torneo con jugadores del club (y no han pasado más de
 * 30 minutos), guarda la captura y la envía por correo. Una sola vez por torneo y día. Devuelve cuántas envió.
 */
export async function sendDueItineraries(db: Db, state: PublicState, now: Date, deps: ItineraryDeps = {}): Promise<number> {
  const c = settings.itinerary;
  if (!c.email || !c.baseUrl) return 0;
  const date = todayIn(TZ, now);
  let sent = 0;
  for (const t of state.tournaments) {
    if (!t.matches.some((m) => m.date === date)) continue;
    const first = firstStart(db, t, date);
    if (first === undefined) continue;
    const untilMs = first - now.getTime();
    if (untilMs > c.minutesBefore * 60_000 || untilMs < -30 * 60_000) continue;
    const key = `${t.id}|${date}`;
    if (db.prepare('select 1 from captures where day_key = ?').get(key)) continue;
    const wide = renderItinerary(t, date, now);
    const stories = renderItineraryStories(t, date, now);
    const id = randomBytes(12).toString('hex');
    const storyIds = stories.map(() => randomBytes(12).toString('hex'));
    const when = clockOf(new Date(first).toISOString());
    const site = settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';
    const links = storyIds.map((sid, i) => `  Historia ${i + 1}${stories.length > 1 ? ` de ${stories.length}` : ''}: ${captureUrl(sid)}`).join('\n');
    const msg = `Itinerario en vivo de ${t.name} (${dayLabel(date)}): el primer partido empieza a las ${when}. La captura se ha tomado ${Math.max(0, Math.round(untilMs / 60_000))} min antes.\n\nPARA HISTORIAS (vertical 1080×1920${stories.length > 1 ? `, ${stories.length} imágenes en orden` : ''}):\n${links}\n\nVERSIÓN ANCHA (como en la web): ${captureUrl(id)}\n\nVer en directo: ${site}/directo`;
    await sendNotice(c.email, 'HISTORIAS RRSS DIRECTO TORNEOS JORNADA', msg, deps, { nombre: 'Itinerario', apellidos: 'En vivo' }); // sin guardar si falla: se reintenta el minuto siguiente dentro de la ventana
    const ins = db.prepare('insert into captures(id, day_key, tournament_guid, created_at, png) values(?,?,?,?,?)');
    ins.run(id, key, t.id, nowIso(), wide);
    stories.forEach((p, i) => ins.run(storyIds[i], `${key}|h${i + 1}`, t.id, nowIso(), p));
    sent++;
  }
  return sent;
}

export function captureImage(db: Db, id: string): Buffer | undefined {
  if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
  const row = db.prepare('select png from captures where id = ?').get(id) as unknown as { png: Uint8Array } | undefined;
  return row ? Buffer.from(row.png) : undefined;
}
