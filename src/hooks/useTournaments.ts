import { useCallback, useEffect, useRef, useState } from 'react';
import { hasApi, listenForUpdates } from '../lib/api';
import { tournamentSource, type TournamentData } from '../lib/tournamentSource';

const CACHE_KEY = 'uva-torneos-v1';

/** Últimos datos recibidos: se pintan al instante al volver a abrir la web y se renuevan enseguida (útil con cobertura irregular o servidor dormido). */
const CACHE_MAX_AGE_MS = 30 * 60_000; // más viejo que esto, los partidos «en juego» podrían ya no serlo: no se usa

function readCache(): TournamentData | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as (TournamentData & { cachedAt?: number }) | null;
    return v && Array.isArray(v.tournaments) && v.tournaments.length > 0 && Date.now() - (v.cachedAt ?? 0) < CACHE_MAX_AGE_MS ? v : undefined;
  } catch {
    return undefined;
  }
}
function writeCache(data: TournamentData) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, liveError: false, cachedAt: Date.now() }));
  } catch {
    /* sin almacenamiento (modo privado, lleno): solo se pierde la carga instantánea */
  }
}

type State = { status: 'loading' | 'ready' | 'error'; refreshedAt?: Date; refreshMs: number; reload: () => void } & TournamentData;

/** Refresco periódico con servidor: cada 5 minutos (cada minuto si hay partidos hoy), al volver a la pestaña y cuando el servidor avisa. */
const REFRESH_MS = 5 * 60_000;
const REFRESH_LIVE_MS = 60_000;
/** Con partidos de la UVa en los próximos 7 días (el orden de juego se publica con antelación): cada 2 minutos. */
const REFRESH_NEAR_MS = 120_000;
const todayLocal = (plusDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + plusDays * 86_400_000));

/** Fuente única de torneos para Inicio, Calendario y Directo. */
export function useTournaments(): State {
  const [state, setState] = useState<Omit<State, 'reload' | 'refreshMs'>>(() => {
    const cached = hasApi ? readCache() : undefined;
    return cached ? { status: 'ready', ...cached } : { status: 'loading', tournaments: [] };
  });
  const alive = useRef(true);
  const playingToday = useRef(false);
  const nearMatches = useRef(false);
  const today = todayLocal();
  const inAWeek = todayLocal(7);
  nearMatches.current = state.tournaments.some((t) => (t.matches ?? []).some((m) => m.state !== 'finished' && !!m.date && m.date >= today && m.date <= inAWeek));
  playingToday.current = state.tournaments.some((t) => (t.matches ?? []).some((m) => m.date === today && m.state !== 'finished') || (t.matches ?? []).some((m) => m.state === 'live'));

  const load = useCallback(() => {
    tournamentSource
      .load()
      .then((data) => {
        if (!alive.current) return;
        setState({ status: 'ready', refreshedAt: new Date(), ...data });
        if (hasApi && !data.liveError) writeCache(data);
      })
      .catch(() => alive.current && setState((s) => (s.status === 'ready' ? s : { status: 'error', tournaments: [] })));
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    if (!hasApi) return () => void (alive.current = false);
    // Más seguido mientras hay partidos hoy: así se ve el avance del torneo y las horas estimadas se mantienen al día.
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      load();
      timer = setTimeout(tick, playingToday.current ? REFRESH_LIVE_MS : nearMatches.current ? REFRESH_NEAR_MS : REFRESH_MS);
    };
    timer = setTimeout(tick, REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    const stop = listenForUpdates(load);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      stop();
    };
  }, [load]);

  return { ...state, refreshMs: playingToday.current ? REFRESH_LIVE_MS : nearMatches.current ? REFRESH_NEAR_MS : REFRESH_MS, reload: load };
}
