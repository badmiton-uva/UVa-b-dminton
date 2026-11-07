import { useEffect, useMemo, useState } from 'react';
import { buildAgenda, madrid, pickDay, type AgendaItem } from '../../lib/agenda';
import { lateness } from '../../lib/live';
import type { UvaMatch } from '../../types';
import { SetScores } from '../tournaments/SetScores';

const stateLabel = { scheduled: 'Programado', live: 'En juego', finished: 'Finalizado' } as const;
const pad = (n: number) => String(n).padStart(2, '0');
const at = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const dayName = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function Item({ item, highlight }: { item: AgendaItem; highlight?: boolean }) {
  const m = item.match;
  const late = lateness(m);
  const moved = m.state === 'scheduled' && item.planned !== undefined && item.planned !== item.at;
  return (
    <li id={`partido-${m.id}`} className={`dayplan__match dayplan__match--${m.state}${m.outcome ? ` dayplan__match--${m.outcome}` : ''}${highlight ? ' is-highlight' : ''}`}>
      <p className="dayplan__time">
        {m.state === 'scheduled' && m.estimatedStart && <abbr className="est" title="Estimación">EST</abbr>}
        <time>{at(item.at)}</time>
        {moved && <span className="dayplan__was">prog. {at(item.planned!)}</span>}
      </p>
      <div className="dayplan__body">
        <p className="dayplan__players">{m.players.join(' / ')}{m.opponent && <span> vs {m.opponent}</span>}</p>
        <p className="dayplan__meta">{[m.event, m.court && `Pista ${m.court}`].filter(Boolean).join(' · ')}</p>
        {m.state === 'finished' && (
          <p className="dayplan__result">
            {m.outcome && <strong className={`dayplan__outcome dayplan__outcome--${m.outcome}`}>{m.outcome === 'win' ? 'Victoria' : 'Derrota'}</strong>}
            {m.score ? <SetScores score={m.score} /> : <span>Resultado pendiente de publicar</span>}
          </p>
        )}
        {m.state === 'scheduled' && late !== undefined && Math.abs(late) >= 5 && (
          <p className={`dayplan__delay ${late > 0 ? 'late' : 'early'}`}>{late > 0 ? '+' : ''}{late} min respecto a lo programado</p>
        )}
      </div>
      <span className={`status status--${m.state === 'live' ? 'ongoing' : m.state === 'scheduled' ? 'upcoming' : 'finished'}`}>{stateLabel[m.state]}</span>
    </li>
  );
}

/** Calendario diario: los partidos de la UVa colocados por hora, con la hora estimada (o la programada) y el resultado al terminar. */
export function DayAgenda({ matches, now, highlight }: { matches: UvaMatch[]; now: Date; highlight?: string | null }) {
  const days = useMemo(() => buildAgenda(matches), [matches]);
  const today = madrid(now).date;
  const [chosen, setChosen] = useState<string>();
  const selected = days.find((d) => d.date === chosen) ?? days.find((d) => d.date === pickDay(days, today));

  useEffect(() => {
    if (!highlight) return;
    const target = days.find((d) => d.items.some((i) => i.match.id === highlight));
    if (target) setChosen(target.date);
  }, [highlight, days]);

  if (days.length === 0 || !selected) return <p className="empty">Todavía no hay horarios publicados para los partidos de la UVa.</p>;

  const nowMin = madrid(now).minutes;
  const isToday = selected.date === today;
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const hours: number[] = [];
  for (let h = selected.firstHour; h <= selected.lastHour; h++) hours.push(h);
  const first = selected.items.find((i) => i.match.state !== 'finished');

  return (
    <div className="dayplan">
      {days.length > 1 && (
        <div className="dayplan__days" role="tablist" aria-label="Día del torneo">
          {days.map((d) => (
            <button key={d.date} role="tab" type="button" aria-selected={d.date === selected.date} className={d.date === selected.date ? 'is-active' : ''} onClick={() => setChosen(d.date)}>
              {dayName.format(new Date(`${d.date}T12:00:00Z`))}
            </button>
          ))}
        </div>
      )}
      <h3 className="dayplan__title">{dayName.format(new Date(`${selected.date}T12:00:00Z`))}{isToday && <span className="dayplan__today">Hoy</span>}{selected.date === tomorrow && <span className="dayplan__today">Mañana</span>}</h3>
      <ol className="dayplan__grid">
        {hours.map((h) => {
          const items = selected.items.filter((i) => Math.floor(i.at / 60) === h);
          const isNow = isToday && Math.floor(nowMin / 60) === h;
          return (
            <li key={h} className={`dayplan__hour${isNow ? ' is-now' : ''}`}>
              <span className="dayplan__label">{pad(h)}:00</span>
              <div className="dayplan__slot" style={isNow ? ({ '--now': `${((nowMin % 60) / 60) * 100}%` } as React.CSSProperties) : undefined}>
                {isNow && <span className="dayplan__now" aria-label={`Ahora, ${at(nowMin)}`}><b>{at(nowMin)}</b></span>}
                {items.length > 0 ? (
                  <ul>{items.map((i) => <Item key={i.match.id} item={i} highlight={i.match.id === highlight} />)}</ul>
                ) : (
                  <span className="dayplan__empty" aria-hidden="true" />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {isToday && first && <p className="dayplan__next">Siguiente partido: <strong>{first.match.players.join(' / ')}</strong> a las {at(first.at)}</p>}
    </div>
  );
}

export type { UvaMatch };
