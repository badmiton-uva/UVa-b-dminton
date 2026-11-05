import { todayIn } from './dates';
import { type Db } from './db';
import type { Mailer } from './mailer';
import { eventName, finished } from './news';
import type { PublicMatch, PublicState, PublicTournament } from './publicView';
import { clockOf, dateRange, dayLabel } from './share';
import { escapeHtml, listConfirmed, type Subscriber, unsubscribeUrl } from './subscribers';
import { settings } from './config';

/**
 * Correos a las personas suscritas, los menos posibles y agrupados: por cada torneo en el que juega alguien de lo que siguen, UN correo a media jornada
 * («así van») y UNO al final («resultados»), sea cual sea el número de partidos. Si coinciden varios torneos o avisos, van juntos en un solo correo. Máximo
 * dos correos al día por persona y solo de 9:00 a 23:00. Solo datos públicos (jugadores con consentimiento).
 */
const TZ = 'Europe/Madrid';
const site = () => settings.siteUrl || 'https://badmiton-uva.github.io/UVa-b-dminton';

export type Kind = 'mid' | 'final';
export interface Due { t: PublicTournament; kind: Kind; names: string[] }

/** Los jugadores de este torneo que sigue la persona (todos, si sigue al equipo). */
export function followedIn(state: PublicState, sub: Pick<Subscriber, 'allTeam' | 'playerIds'>, t: PublicTournament): string[] {
  const inTournament = new Set([...t.uvaPlayers, ...t.matches.flatMap((m) => m.players)]);
  if (sub.allTeam) return [...inTournament].sort((a, b) => a.localeCompare(b, 'es'));
  const mine = sub.playerIds.map((id) => state.players.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
  return mine.filter((n) => inTournament.has(n)).sort((a, b) => a.localeCompare(b, 'es'));
}

/** ¿Toca avisar de «así van»? Cuando el día en juego va entre el 40 y el 80 % de los partidos terminados (un solo aviso por torneo). */
export function midDue(t: PublicTournament, today: string): boolean {
  const p = t.progress;
  if (!p || p.done || p.date !== today || p.total < 12) return false;
  const share = p.finished / p.total;
  return share >= 0.4 && share <= 0.8 && t.matches.some((m) => m.state === 'finished' || m.state === 'live');
}

const when = (m: PublicMatch, today: string) => {
  const at = m.estimatedStart ?? m.plannedStart;
  return at ? `${m.date && m.date !== today ? `${dayLabel(m.date)} ` : ''}${clockOf(at)}${m.estimatedStart ? ' (estimada)' : ''}` : m.time ?? 'hora por confirmar';
};
const startKey = (m: PublicMatch) => m.plannedStart ?? `${m.date ?? '9999'}T${m.time ?? '99:99'}`;
const vs = (m: PublicMatch) => (m.opponent ? ` contra ${m.opponent}` : '');
const where = (m: PublicMatch) => [m.event, m.court && `Pista ${m.court}`].filter(Boolean).join(' · ');

/**
 * Lo más importante de una persona en el torneo, para ponerlo arriba: medallas, en qué punto está en cada prueba (pasa a la final, cae en octavos…) y su
 * balance de partidos. Solo sale lo que consta en los cuadros publicados.
 */
export function highlights(t: PublicTournament, name: string): string[] {
  const mine = t.results.filter((r) => r.entrant.split(/\s+\/\s+/).includes(name));
  const out: string[] = [];
  for (const r of mine.filter((x) => x.place).sort((a, b) => a.place! - b.place!)) out.push(`${r.place === 1 ? '🥇 Oro' : r.place === 2 ? '🥈 Plata' : '🥉 Bronce'} en ${eventName(r.event)}${r.score ? ` (${r.score})` : ''}`);
  for (const r of mine.filter((x) => !x.place)) out.push(`${eventName(r.event)}: ${r.text}`);
  const ms = t.matches.filter((m) => m.state === 'finished' && m.players.includes(name));
  const w = ms.filter((m) => m.outcome === 'win').length;
  const l = ms.filter((m) => m.outcome === 'loss').length;
  if (w + l > 0) out.push(`Balance: ${w} victoria${w === 1 ? '' : 's'} y ${l} derrota${l === 1 ? '' : 's'}`);
  return out;
}

/** Líneas de una persona: lo jugado (con rival y resultado), lo que juega ahora y lo siguiente. */
function playerLines(t: PublicTournament, name: string, kind: Kind, today: string): string[] {
  const ms = t.matches.filter((m) => m.players.includes(name)).sort((a, b) => startKey(a).localeCompare(startKey(b)));
  const lines: string[] = [];
  for (const m of ms.filter((x) => x.state === 'finished')) {
    lines.push(`${m.outcome === 'win' ? '✅ Ganó' : m.outcome === 'loss' ? '❌ Perdió' : '· Jugó'}${vs(m)}: ${m.score ?? 'sin marcador'} (${where(m)})`);
  }
  for (const m of ms.filter((x) => x.state === 'live')) lines.push(`🟢 Juega ahora${vs(m)} (${where(m)})`);
  const next = ms.filter((x) => x.state === 'scheduled');
  if (kind === 'mid') {
    for (const m of next.slice(0, 2)) lines.push(`⏭ Siguiente: ${when(m, today)}${vs(m)} (${where(m)})`);
    if (next.length > 2) lines.push(`   y ${next.length - 2} partido${next.length - 2 === 1 ? '' : 's'} más`);
  } else if (next.length) lines.push(`⏳ Le quedan ${next.length} partido${next.length === 1 ? '' : 's'} por jugar`);
  if (!lines.length) lines.push('Todavía no ha jugado.');
  return lines;
}

interface Section { title: string; lines: string[] }
function sectionFor(state: PublicState, d: Due, today: string): Section[] {
  const { t, kind, names } = d;
  const head = kind === 'mid' ? `${t.name} · así van a media jornada` : `${t.name} · resultados finales`;
  const wins = t.matches.filter((m) => m.state === 'finished' && m.outcome === 'win' && m.players.some((p) => names.includes(p))).length;
  const losses = t.matches.filter((m) => m.state === 'finished' && m.outcome === 'loss' && m.players.some((p) => names.includes(p))).length;
  const out: Section[] = [];
  const p = t.progress;
  const intro = [`${dateRange(t.startDate, t.endDate)}${t.city ? ` · ${t.city}` : ''}`, `${kind === 'mid' ? 'Hasta ahora' : 'Balance'}: ${wins} victoria${wins === 1 ? '' : 's'} y ${losses} derrota${losses === 1 ? '' : 's'}.`];
  if (kind === 'mid' && p && p.total) intro.push(`El torneo va por ${p.finished} de ${p.total} partidos${p.estimatedEnd ? ` y terminaría hacia las ${clockOf(p.estimatedEnd)} (estimación)` : ''}.`);
  out.push({ title: head, lines: intro });
  for (const n of names) {
    const key = highlights(t, n);
    out.push({ title: n, lines: [...(key.length ? ['LO MÁS IMPORTANTE', ...key.map((k) => `★ ${k}`), 'PARTIDO A PARTIDO'] : []), ...playerLines(t, n, kind, today)] });
  }
  if (kind === 'final') {
    const news = state.news.find((n) => n.tournamentGuid === t.id);
    if (news) out.push({ title: 'La noticia', lines: [news.title, news.summary] });
  }
  return out;
}

/** El correo de una persona con todo lo que le toca ahora (uno o varios torneos, a media jornada o al final). */
export function buildEmail(state: PublicState, due: Due[], unsub: string, followed: string, today: string, alerts: { t: PublicTournament; a: Alert }[] = []): { subject: string; text: string; html: string } {
  const sections = [...alerts.map((x) => ({ title: `★ ${x.a.title}`, lines: x.a.lines })), ...due.flatMap((d) => sectionFor(state, d, today))];
  const onlyMid = due.every((d) => d.kind === 'mid');
  const onlyFinal = due.every((d) => d.kind === 'final');
  const first = due[0].t.name;
  const one = due.length === 1 && due[0].names.length === 1 ? due[0].names[0].split(' ').slice(0, 2).join(' ') : undefined;
  const subject = one ? `${one}: ${due[0].kind === 'mid' ? 'así va' : 'resultados'} en ${first}` : due.length === 1 ? `UVa en ${first}: ${onlyMid ? 'así van a media jornada' : 'resultados finales'}` : `Club Bádminton UVa: ${onlyMid ? 'así van los torneos' : onlyFinal ? 'resultados finales' : 'novedades de los torneos'}`;
  const text = `Para ti: ${followed}\n\n${sections.map((s) => `${s.title.toUpperCase()}\n${s.lines.map((l) => `   ${l}`).join('\n')}`).join('\n\n')}\n\nEn directo: ${site()}/directo\n\nRecibes este correo porque te suscribiste en la web del Club Bádminton Universidad de Valladolid (como mucho, uno a media jornada y otro al final de cada torneo). Para darte de baja: ${unsub}\n`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#14132f"><p style="color:#566072;margin-bottom:4px">Para ti: ${escapeHtml(followed)}</p>${sections.map((s, i) => `${i === 0 || /·/.test(s.title) ? `<h2 style="color:#2f2c64;margin:18px 0 4px">${escapeHtml(s.title)}</h2>` : `<h3 style="color:#2f2c64;border-bottom:2px solid #7a3fe0;padding-bottom:3px;margin:14px 0 4px">${escapeHtml(s.title)}</h3>`}<ul style="padding-left:18px;margin:4px 0">${s.lines.map((l) => `<li style="margin:4px 0">${escapeHtml(l)}</li>`).join('')}</ul>`).join('')}<p><a href="${site()}/directo" style="display:inline-block;background:#2f2c64;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px">Ver en directo</a></p><p style="font-size:12px;color:#566072">Recibes este correo porque te suscribiste en la web del Club Bádminton Universidad de Valladolid (como mucho, uno a media jornada y otro al final de cada torneo). <a href="${unsub}">Darme de baja</a></p></div>`;
  return { subject, text, html };
}

/** Algo importante de una persona que sigue: quedó eliminada, llega a la final o ganó/quedó en el podio de una prueba. */
export interface Alert { key: string; name: string; event: string; kind: 'out' | 'final' | 'gold' | 'silver' | 'bronze'; title: string; lines: string[] }

/**
 * Hechos importantes de una persona en un torneo en juego (no cada partido): ya no juega más en una prueba (`done` y sin medalla: «Cae en Octavos»),
 * está en la final, o tiene medalla (campeona, finalista, bronce). Cada hecho se avisa una sola vez (clave estable).
 */
export function keyEvents(t: PublicTournament, name: string, today: string): Alert[] {
  const out: Alert[] = [];
  const mine = t.results.filter((r) => r.entrant.split(/\s+\/\s+/).includes(name));
  const matches = t.matches.filter((m) => m.players.includes(name));
  for (const r of mine) {
    const ev = eventName(r.event);
    const base = r.event.slice(0, 2);
    const inEvent = (m: PublicMatch) => (m.event ?? '').toUpperCase().startsWith(base.toUpperCase());
    const mk = (kind: Alert['kind'], title: string, lines: string[]): Alert => ({ key: `alert:${r.event}:${name}:${kind}`, name, event: ev, kind, title, lines });
    if (r.place === 1) out.push(mk('gold', `¡${name} gana ${ev}!`, [`🥇 ¡Campeón${/\s\/\s/.test(r.entrant) ? 'es' : ''} de ${ev}!${r.score ? ` Final: ${r.score}` : ''}`]));
    else if (r.place === 2) out.push(mk('silver', `${name}, finalista en ${ev}`, [`🥈 Subcampeón en ${ev}${r.score ? ` (final ${r.score})` : ''}`]));
    else if (r.place === 3) out.push(mk('bronze', `${name}, bronce en ${ev}`, [`🥉 Bronce en ${ev}`]));
    else if (r.done) {
      const last = [...matches].filter((m) => m.state === 'finished' && m.outcome === 'loss' && inEvent(m)).sort((a, b) => startKey(b).localeCompare(startKey(a)))[0];
      out.push(mk('out', `${name} queda eliminado en ${ev}`, [`❌ ${ev}: ${r.text}`, ...(last ? [`Último partido: perdió${vs(last)} (${last.score ?? 'sin marcador'})`] : []), 'Ya no tiene más partidos en esta prueba.']));
    } else if (/final/i.test(r.text) && !/semifinal|cuartos|octavos|grupo/i.test(r.text.replace(/pasa a final/i, ''))) {
      const next = matches.filter((m) => m.state !== 'finished' && inEvent(m) && /final/i.test(m.event ?? '')).sort((a, b) => startKey(a).localeCompare(startKey(b)))[0];
      out.push(mk('final', `¡${name} llega a la final de ${ev}!`, [`🏸 ${name} juega la final de ${ev}.`, ...(next ? [`Siguiente: ${when(next, today)}${vs(next)}${next.court ? ` · Pista ${next.court}` : ''}`] : [])]));
    }
  }
  return out;
}

/** Correo de uno o varios hechos importantes (sin el resumen del torneo): corto y directo. */
export function buildAlertEmail(alerts: { t: PublicTournament; a: Alert }[], unsub: string, followed: string): { subject: string; text: string; html: string } {
  const subject = alerts.length === 1 ? alerts[0].a.title : `Novedades importantes: ${[...new Set(alerts.map((x) => x.a.name.split(' ').slice(0, 2).join(' ')))].join(', ')}`;
  const sections = alerts.map((x) => ({ title: `${x.a.title} · ${x.t.name}`, lines: x.a.lines }));
  const text = `Para ti: ${followed}\n\n${sections.map((s) => `${s.title.toUpperCase()}\n${s.lines.map((l) => `   ${l}`).join('\n')}`).join('\n\n')}\n\nEn directo: ${site()}/directo\n\nRecibes este correo porque sigues a este jugador en la web del Club Bádminton Universidad de Valladolid (solo avisamos de lo importante: eliminado, final o podio). Para darte de baja: ${unsub}\n`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#14132f"><p style="color:#566072;margin-bottom:4px">Para ti: ${escapeHtml(followed)}</p>${sections.map((s) => `<h2 style="color:#2f2c64;margin:18px 0 4px">${escapeHtml(s.title)}</h2><ul style="padding-left:18px;margin:4px 0">${s.lines.map((l) => `<li style="margin:4px 0">${escapeHtml(l)}</li>`).join('')}</ul>`).join('')}<p><a href="${site()}/directo" style="display:inline-block;background:#2f2c64;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px">Ver en directo</a></p><p style="font-size:12px;color:#566072">Recibes este correo porque sigues a este jugador en la web del Club Bádminton Universidad de Valladolid (solo avisamos de lo importante: eliminado, final o podio). <a href="${unsub}">Darme de baja</a></p></div>`;
  return { subject, text, html };
}

const madridHour = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)) % 24;
const sentToday = (db: Db, id: number, today: string) => (db.prepare("select count(*) n from subscriber_mails where subscriber_id = ? and kind not like 'alert:%' and substr(sent_at, 1, 10) = ?").get(id, today) as unknown as { n: number }).n;
const alertsToday = (db: Db, id: number, today: string) => (db.prepare("select count(distinct substr(sent_at, 1, 16)) n from subscriber_mails where subscriber_id = ? and kind like 'alert:%' and substr(sent_at, 1, 10) = ?").get(id, today) as unknown as { n: number }).n;
const alreadySentKey = (db: Db, id: number, guid: string, key: string) => !!db.prepare('select 1 x from subscriber_mails where subscriber_id = ? and tournament_guid = ? and kind = ?').get(id, guid, key);
const alreadySent = (db: Db, id: number, guid: string, kind: Kind) => !!db.prepare('select 1 x from subscriber_mails where subscriber_id = ? and tournament_guid = ? and kind = ?').get(id, guid, kind);

/**
 * Cada minuto: de 9:00 a 23:00 (Madrid), reúne para cada persona lo que le toca (un aviso «a media jornada» y otro «al final» por torneo, solo de lo que
 * sigue) y lo envía en UN correo, con un máximo de `maxPerDay` al día (lo demás queda para el día siguiente). La media jornada no se avisa a quien se
 * suscribió con el torneo ya empezado; el final, sí, si se suscribió antes de que acabara. Devuelve cuántos correos envió.
 */
export async function sendUpdates(db: Db, state: PublicState, now: Date, mailer: Mailer): Promise<number> {
  const hour = madridHour(now);
  if (hour < 9 || hour >= 23) return 0;
  const today = todayIn(TZ, now);
  const mid = state.tournaments.filter((t) => midDue(t, today));
  const fin = state.tournaments.filter((t) => finished(t, today) && t.matches.some((m) => m.state === 'finished'));
  const playing = state.tournaments.some((t) => !!t.startDate && t.startDate <= today && !finished(t, today) && t.results.length > 0);
  if (mid.length === 0 && fin.length === 0 && !playing) return 0;
  let sent = 0;
  for (const sub of listConfirmed(db)) {
    if (sent >= 25) break;
    if (sentToday(db, sub.id, today) >= settings.subscriptions.maxPerDay) continue;
    const joined = (sub.confirmedAt ?? '').slice(0, 10);
    const due: Due[] = [];
    for (const t of mid) {
      const names = followedIn(state, sub, t);
      if (names.length && joined < (t.startDate ?? '') && !alreadySent(db, sub.id, t.id, 'mid')) due.push({ t, kind: 'mid', names });
    }
    for (const t of fin) {
      const names = followedIn(state, sub, t);
      if (names.length && joined <= (t.endDate ?? t.startDate ?? '') && !alreadySent(db, sub.id, t.id, 'final')) due.push({ t, kind: 'final', names });
    }
    // Hechos importantes (eliminado, final, campeón…) de los jugadores que sigue, mientras el torneo está en juego; los de un torneo que ya terminó van en el correo final.
    const alerts: { t: PublicTournament; a: Alert }[] = [];
    if (!sub.allTeam && alertsToday(db, sub.id, today) < settings.subscriptions.maxAlertsPerDay) {
      for (const t of state.tournaments) {
        if (finished(t, today) || !t.startDate || t.startDate > today || joined >= t.startDate || due.some((d) => d.t.id === t.id && d.kind === 'final')) continue;
        for (const n of followedIn(state, sub, t)) for (const a of keyEvents(t, n, today)) if (!alreadySentKey(db, sub.id, t.id, a.key)) alerts.push({ t, a });
      }
    }
    if (due.length === 0 && alerts.length === 0) continue;
    const unsub = unsubscribeUrl(db, sub.id);
    const followed = sub.allTeam ? 'todo el equipo' : [...new Set([...due.flatMap((d) => d.names), ...alerts.map((x) => x.a.name)])].join(', ');
    const mail = due.length ? buildEmail(state, due, unsub, followed, today, alerts) : buildAlertEmail(alerts, unsub, followed);
    try {
      await mailer.send({ to: sub.email, ...mail, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    } catch (e) {
      console.error('correo de torneo', sub.id, (e as Error).message); // se reintenta en los minutos siguientes
      continue;
    }
    const mark = db.prepare('insert or ignore into subscriber_mails(subscriber_id, tournament_guid, kind, sent_at) values(?,?,?,?)');
    for (const d of due) mark.run(sub.id, d.t.id, d.kind, now.toISOString());
    for (const x of alerts) mark.run(sub.id, x.t.id, x.a.key, now.toISOString());
    sent++;
  }
  return sent;
}
