import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DayAgenda } from '../components/live/DayAgenda';
import { DrawsView } from '../components/live/DrawsView';
import { ShareMenu } from '../components/live/ShareMenu';
import { EntriesList } from '../components/tournaments/EntriesList';
import { EndEstimate } from '../components/live/EndEstimate';
import { MatchCard } from '../components/live/MatchCard';
import { NextMatch } from '../components/live/NextMatch';
import { PlayerTimes } from '../components/live/PlayerTimes';
import { NotifyPanel } from '../components/live/NotifyPanel';
import { TrajectoryChart } from '../components/live/TrajectoryChart';
import { Notice, PageHeader } from '../components/ui';
import { useTournaments } from '../hooks/useTournaments';
import { usePageTitle } from '../hooks/usePageTitle';
import { hasApi } from '../lib/api';
import { toISO, formatDateRange } from '../lib/dates';
import { boardOf, clock, clockSec, pickActive } from '../lib/live';
import type { Tournament } from '../types';

export function LivePage() {
  usePageTitle('Directo', 'Partidos de bádminton de los jugadores de la UVa en directo: en juego ahora, próximos partidos con hora estimada, resultados y hora estimada de fin del torneo.');
  const { status, tournaments, live, liveError, refreshedAt, refreshMs } = useTournaments();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState<string>();
  const today = toISO(now);

  const candidates = useMemo(() => tournaments.filter((t) => t.liveId), [tournaments]);
  const active: Tournament | undefined = candidates.find((t) => t.id === (chosen ?? params.get('torneo'))) ?? pickActive(tournaments, today);
  const board = useMemo(() => boardOf((active?.matches ?? []).map((match) => ({ tournament: active!, match }))), [active]);
  const highlight = params.get('partido');

  useEffect(() => {
    if (highlight) document.getElementById(`partido-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, status, active?.id]);

  return (
    <>
      <PageHeader sport title="Directo" lead="Partidos que se juegan ahora, resultados y próximos partidos de los jugadores de la UVa." />
      <div className="section">
        <div className="container live">
          {!hasApi && (
            <Notice kind="warning" title="Sin conexión con el servidor en directo">
              Esta web todavía no está conectada al servidor del club, por lo que no hay partidos ni resultados en directo.
            </Notice>
          )}
          {hasApi && liveError && (
            <Notice kind="warning" title="No se puede contactar con el servidor">
              Se muestran los últimos datos conocidos. Se volverá a intentar automáticamente.
            </Notice>
          )}
          {live && !live.officialReadEnabled && (
            <Notice title="Resultados anotados por el club">
              Los partidos y resultados los introduce el club durante la jornada; no se leen automáticamente de badminton.es.
            </Notice>
          )}

          {status === 'ready' && hasApi && (
            <p className="live__stamp" aria-live="polite">
              Se actualiza cada {refreshMs >= 300_000 ? '5 minutos' : 'minuto'} · Comprobado en esta pantalla a las {refreshedAt ? clockSec(refreshedAt) : '—'}
            </p>
          )}

          {candidates.length > 1 && (
            <label className="live__select">
              <span>Torneo</span>
              <select value={active?.id ?? ''} onChange={(e) => setChosen(e.target.value)}>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} · {formatDateRange(t.startDate, t.endDate)}</option>
                ))}
              </select>
            </label>
          )}

          {status === 'loading' && <p className="empty">Cargando…</p>}
          {status === 'ready' && !active && hasApi && !liveError && (
            <Notice title="Todavía no hay torneos con jugadores de la UVa en seguimiento">
              Cuando un jugador del club tenga torneo, aparecerá aquí con sus partidos y la hora estimada de fin.
            </Notice>
          )}

          {status === 'ready' && <PlayerTimes tournaments={candidates} today={today} updatedAt={refreshedAt} />}

          {active && (
            <>
              <header className="live__head">
                <h2>{active.name}</h2>
                <p>{formatDateRange(active.startDate, active.endDate)} · {active.city}{active.venue ? ` · ${active.venue}` : ''}</p>
                {active.liveId && (
                  <p className="dialog__share">
                    <ShareMenu kind="torneo" id={active.liveId} title={`${active.name} · jugadores de la UVa`} label="Compartir torneo" />
                    {active.podium && active.podium.length > 0 && <ShareMenu kind="resultados" id={active.liveId} title={`Resultados de la UVa en ${active.name}`} label="Compartir resultados" />}
                  </p>
                )}
                {active.stale && (
                  <Notice kind="warning" title="Datos antiguos">
                    La última lectura correcta de este torneo fue a las {active.checkedAt ? clock(active.checkedAt) : '—'}. No se muestran como «en directo» hasta que vuelva a actualizarse.
                  </Notice>
                )}
              </header>

              {board.next[0] && <NextMatch match={board.next[0].match} progress={active.progress} now={now} />}

              <section className="livenow" aria-labelledby="b-live">
                <h3 id="b-live">
                  <span className={`livenow__dot${board.live.length > 0 ? ' is-on' : ''}`} aria-hidden="true" />
                  En juego ahora <span className="count-pill">{board.live.length}</span>
                </h3>
                {board.live.length > 0 ? (
                  <ul className="mlist livenow__list">
                    {board.live.map(({ match }) => <MatchCard key={match.id} match={match} tournament={active.name} highlight={match.id === highlight} />)}
                  </ul>
                ) : (
                  <p className="empty">
                    Ningún partido de la UVa se está jugando ahora.
                    {board.next[0] && <> Siguiente: <strong>{board.next[0].match.players.join(' / ')}</strong>{board.next[0].match.estimatedStart ?? board.next[0].match.plannedStart ? ` a las ${clock((board.next[0].match.estimatedStart ?? board.next[0].match.plannedStart)!)}` : ''}.</>}
                  </p>
                )}
              </section>

              <EndEstimate tournament={active} />

              <section className="livenow" aria-labelledby="b-agenda">
                <h3 id="b-agenda">Partidos por horas <span className="count-pill">{(active.matches ?? []).length}</span></h3>
                <p className="dayplan__hint">Cada partido está colocado a su hora estimada; si aún no hay estimación, a la programada. Los resultados aparecen al terminar.</p>
                <DayAgenda matches={active.matches ?? []} now={now} highlight={highlight} />
              </section>

              {active.entries && active.entries.length > 0 && (
                <section className="livenow" aria-labelledby="entries-title">
                  <h3 id="entries-title">Inscripción y admisión</h3>
                  <EntriesList entries={active.entries} />
                </section>
              )}
              <DrawsView draws={active.draws ?? []} updatedAt={active.checkedAt} />
              {active.officialUrl && (
                <p className="source-note"><a href={active.officialUrl} target="_blank" rel="noopener noreferrer">Ver el torneo completo en badminton.es<span className="sr-only"> (se abre en una pestaña nueva)</span></a></p>
              )}
            </>
          )}

          <TrajectoryChart tournaments={tournaments} history={live?.history} />

          {live && <NotifyPanel live={live} />}
        </div>
      </div>
    </>
  );
}
