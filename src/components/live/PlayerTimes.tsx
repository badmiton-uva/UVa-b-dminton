import { formatDay } from '../../lib/dates';
import { clock, clockSec, playerSchedule } from '../../lib/live';
import type { Tournament, UvaMatch } from '../../types';

const sameDay = (m: UvaMatch, today: string) => (m.date ?? today) === today;

function Line({ m, today }: { m: UvaMatch; today: string }) {
  const at = m.state === 'scheduled' ? m.estimatedStart ?? m.plannedStart : m.plannedStart ?? m.estimatedStart;
  const official = m.plannedStart && m.estimatedStart && m.state === 'scheduled' && clock(m.plannedStart) !== clock(m.estimatedStart) ? clock(m.plannedStart) : undefined;
  return (
    <li className={`ptimes__match ptimes__match--${m.state}`}>
      <span className="ptimes__when">
        {!sameDay(m, today) && m.date && <small>{formatDay(m.date)}</small>}
        {m.state === 'live' ? (
          <strong className="ptimes__live">AHORA</strong>
        ) : (
          <strong>
            {m.state === 'scheduled' && m.estimatedStart && <abbr className="est" title="Estimación">EST</abbr>} {at ? clock(at) : m.time ?? '—'}
          </strong>
        )}
        {official && <small>oficial {official}</small>}
        {m.state === 'scheduled' && m.earliestStart && m.estimatedStart && clock(m.earliestStart) !== clock(m.estimatedStart) && Date.parse(m.earliestStart) < Date.parse(m.estimatedStart) && <small>desde {clock(m.earliestStart)}</small>}
      </span>
      <span className="ptimes__what">
        {[m.event, m.court && `Pista ${m.court}`].filter(Boolean).join(' · ')}
        {m.opponent && <> · vs {m.opponent}</>}
      </span>
      {m.state === 'finished' && (
        <span className={`ptimes__result${m.outcome ? ` ptimes__result--${m.outcome}` : ''}`}>
          {m.outcome === 'win' ? 'Victoria' : m.outcome === 'loss' ? 'Derrota' : 'Terminado'}{m.score ? ` ${m.score}` : ''}
        </span>
      )}
    </li>
  );
}

/** Horas a las que juega cada jugador de la UVa en cada torneo (hoy en adelante), con la hora estimada y la oficial; se actualiza con los datos en directo. */
export function PlayerTimes({ tournaments, today, updatedAt }: { tournaments: Tournament[]; today: string; updatedAt?: Date }) {
  const schedule = playerSchedule(tournaments, today);
  if (schedule.length === 0) return null;
  return (
    <section className="ptimes" aria-labelledby="ptimes-title" aria-live="polite">
      <h2 id="ptimes-title">A qué hora juega cada jugador de la UVa</h2>
      <p className="ptimes__hint">
        Hora estimada (<abbr className="est" title="Estimación">EST</abbr>) según el ritmo real del torneo, con la oficial al lado cuando difiere. {updatedAt ? `Actualizado a las ${clockSec(updatedAt)}.` : ''}
      </p>
      <div className="ptimes__grid">
        {schedule.map(({ tournament: t, players }) => (
          <article key={t.id} className="ptimes__card" aria-labelledby={`pt-${t.id}`}>
            <h3 id={`pt-${t.id}`}>{t.name}</h3>
            <p className="ptimes__meta">{[t.city, t.checkedAt ? `leído a las ${clock(t.checkedAt)}` : ''].filter(Boolean).join(' · ')}</p>
            <ul className="ptimes__players">
              {players.map((p) => (
                <li key={p.name}>
                  <h4>{p.name}</h4>
                  <ul>{p.matches.map((m) => <Line key={`${p.name}-${m.id}`} m={m} today={today} />)}</ul>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
