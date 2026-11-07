import type { UvaMatch } from '../types';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Fecha (YYYY-MM-DD) y minutos desde las 00:00, en hora de Madrid, de un instante ISO. */
export function madrid(iso: string | Date): { date: string; minutes: number } {
  const p = Object.fromEntries(parts.formatToParts(typeof iso === 'string' ? new Date(iso) : iso).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export interface AgendaItem {
  match: UvaMatch;
  /** Minutos desde las 00:00 en los que se coloca el partido: la hora estimada, o la programada si no hay estimación. */
  at: number;
  planned?: number;
}

export interface AgendaDay {
  date: string;
  items: AgendaItem[];
  firstHour: number;
  lastHour: number;
}

const hhmm = (t?: string) => {
  const m = t?.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** Agrupa los partidos por día y los ordena por hora. Los que no tienen hora ni fecha no se pueden situar y se omiten. */
export function buildAgenda(matches: UvaMatch[]): AgendaDay[] {
  const byDay = new Map<string, AgendaItem[]>();
  for (const match of matches) {
    const planned = match.plannedStart ? madrid(match.plannedStart) : match.date && hhmm(match.time) !== undefined ? { date: match.date, minutes: hhmm(match.time)! } : undefined;
    const est = match.estimatedStart ? madrid(match.estimatedStart) : undefined;
    const where = match.state === 'scheduled' ? est ?? planned : planned ?? est;
    if (!where) continue;
    byDay.set(where.date, [...(byDay.get(where.date) ?? []), { match, at: where.minutes, planned: planned?.minutes }]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => {
      items.sort((a, b) => a.at - b.at || a.match.players.join().localeCompare(b.match.players.join()));
      return { date, items, firstHour: Math.floor(items[0].at / 60), lastHour: Math.floor(items[items.length - 1].at / 60) };
    });
}

/** Día que se muestra al abrir: hoy si hay partidos; si no, el próximo; si no, el último. */
export function pickDay(days: AgendaDay[], today: string): string | undefined {
  const hoy = days.find((d) => d.date === today);
  const siguiente = days.find((d) => d.date > today);
  // Si hoy ya no queda nada por jugar y hay un día siguiente publicado (el domingo de un máster), se abre ese.
  if (hoy && hoy.items.every((i) => i.match.state === 'finished') && siguiente) return siguiente.date;
  return hoy?.date ?? siguiente?.date ?? days.at(-1)?.date;
}
