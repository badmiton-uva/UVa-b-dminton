import path from 'node:path';

const num = (v: string | undefined, d: number) => (v && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const min = (name: string, d: number) => num(process.env[name], d) * 60_000;

export type OpponentPolicy = 'none' | 'names';

/** Direcciones de la web del club (GitHub Pages: la actual y la anterior al cambio de nombre de la cuenta); siempre autorizadas. */
const CLUB_ORIGINS = ['https://badmiton-uva.github.io', 'https://pablo06casta.github.io'];

/** Ajustes del servidor. Todo se puede cambiar con variables de entorno (ver .env.example). */
export const settings = {
  port: num(process.env.PORT, 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  /** Token de administración. Sin él, el panel y la API de administración quedan desactivados. */
  adminToken: process.env.ADMIN_TOKEN ?? '',
  /** Orígenes autorizados a leer la API pública (la web del club). `*` solo para pruebas. */
  corsOrigins: [...new Set([...(process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...CLUB_ORIGINS])],

  /** Lectura automática de badminton.es (cuadros, partidos y perfiles), con peticiones espaciadas. Activada por defecto; `OFFICIAL_READ_ENABLED=false` la desactiva. */
  officialReadEnabled: process.env.OFFICIAL_READ_ENABLED !== 'false',
  tickMs: num(process.env.TICK_MS, 5000),

  /** Frecuencias de lectura por fase del torneo (minutos). */
  intervals: {
    /** Cada cuánto se vuelven a leer TODOS los cuadros de un torneo (entre medias, solo donde juega alguien del club). */
    drawsFull: min('DRAWS_FULL_MINUTES', 360),
    discovery: min('DISCOVERY_MINUTES', 20),
    before: { info: min('BEFORE_INFO_MINUTES', 60), draws: min('BEFORE_DRAWS_MINUTES', 60), day: min('BEFORE_DAY_MINUTES', 60) },
    imminent: { info: min('IMMINENT_INFO_MINUTES', 20), draws: min('IMMINENT_DRAWS_MINUTES', 20), day: min('IMMINENT_DAY_MINUTES', 20) },
    /** Torneos con gente del club que empiezan en ≤ 7 días (y el día antes): el orden de juego se lee pronto y a menudo, porque se publica con días de antelación. */
    near: { info: min('NEAR_INFO_MINUTES', 20), draws: min('NEAR_DRAWS_MINUTES', 15), day: min('NEAR_DAY_MINUTES', 10) },
    nearImminent: { info: min('NEAR_IMMINENT_INFO_MINUTES', 15), draws: min('NEAR_IMMINENT_DRAWS_MINUTES', 10), day: min('NEAR_IMMINENT_DAY_MINUTES', 5) },
    /** Hasta cuántos días antes se lee el orden de juego de un torneo con gente del club (antes, 3). */
    dayLookaheadDays: num('DAY_LOOKAHEAD_DAYS', 7),
    live: { info: min('LIVE_INFO_MINUTES', 20), draws: min('LIVE_DRAWS_MINUTES', 10), day: min('LIVE_DAY_MINUTES', 3) },
    recent: { info: min('RECENT_INFO_MINUTES', 720), draws: min('RECENT_DRAWS_MINUTES', 60), day: min('RECENT_DAY_MINUTES', 180) },
  },
  /** Páginas del ranking oficial con los jugadores del club (separadas por comas). De ahí se construye la lista del club. */
  rankingUrls: (process.env.RANKING_URLS ?? [
    'https://www.badminton.es/ranking/category.aspx?id=54365&category=5939&ogid=9FC486AA-1B7C-4D65-9E14-3C75412D4773',
    'https://www.badminton.es/ranking/category.aspx?id=54365&category=5940&ogid=9FC486AA-1B7C-4D65-9E14-3C75412D4773',
    'https://www.badminton.es/ranking/category.aspx?id=54365&category=5789&ogid=9FC486AA-1B7C-4D65-9E14-3C75412D4773',
  ].join(',')).split(',').map((u) => u.trim()).filter(Boolean),
  /** Inscripción y admisión de la gente del club en torneos futuros: cada cuántos minutos se revisan las listas de inscritos y hasta cuántos días antes. */
  entries: { days: num('ENTRIES_DAYS', 90), far: min('ENTRIES_FAR_MINUTES', 120), soon: min('ENTRIES_SOON_MINUTES', 60), imminent: min('ENTRIES_IMMINENT_MINUTES', 30) },
  /** Histórico por perfil: partidos terminados de cada persona pública del club (≈ últimas temporadas), una vuelta al día. */
  historyEnabled: process.env.HISTORY_ENABLED !== 'false',
  /** Histórico: se lee una vez el cuadro de cada torneo ya terminado de los últimos N días (0 = no) para la gráfica de trayectoria del club. */
  backfillDays: num('BACKFILL_DAYS', 400),
  /** Detección de cambios: tiempo mínimo entre dos lecturas adelantadas de lo mismo (minutos). La web oficial no avisa; se detecta con lecturas baratas. */
  kickMinGapMs: min('KICK_MIN_GAP_MINUTES', 2),
  /** Para confirmar un resultado recién visto: segunda lectura del orden de juego pasados al menos estos segundos (con la web oficial no se va más rápido que esto). */
  confirmGapMs: num('CONFIRM_GAP_SECONDS', 45) * 1000,
  /** Cada cuánto se mira solo la lista de jugadores de un torneo cercano para detectar nuevas inscripciones (minutos): ver `identifyEvery`. */
  watchListMinutes: { far: num('WATCH_LIST_FAR_MINUTES', 30), soon: num('WATCH_LIST_SOON_MINUTES', 15), imminent: num('WATCH_LIST_IMMINENT_MINUTES', 10) },
  /** Torneos que no se leen ni se muestran: se excluyen por nombre (expresión regular, sin distinguir mayúsculas). */
  excludedTournaments: new RegExp(process.env.EXCLUDED_TOURNAMENTS ?? 'liga\\s+nacional', 'i'),
  /** Torneos absolutos del calendario oficial que empiezan en los próximos N días se leen una vez para ver quién del club juega (0 = desactivado). */
  followCalendarDays: num('FOLLOW_CALENDAR_DAYS', 30),
  followRefreshMinutes: min('FOLLOW_REFRESH_MINUTES', 360),
  autoRosterHours: num('AUTO_ROSTER_HOURS', 24),
  /** «declared»: los jugadores del club encontrados quedan visibles (consentimiento declarado por la administración). «hidden»: ocultos hasta registrar su consentimiento. */
  autoRosterConsent: (process.env.AUTO_ROSTER_CONSENT === 'declared' ? 'declared' : 'hidden') as 'declared' | 'hidden',
  /** Personas del club que NO deben publicarse (sin consentimiento), separadas por «;». Se ocultan siempre, aunque ya estén en la lista. */
  hiddenPlayers: (process.env.HIDDEN_PLAYERS ?? 'Clara Campos').split(';').map((x) => x.trim()).filter(Boolean),
  /** Liga Nacional de Clubes: clasificación y encuentros de la división que sigue el club (por defecto, Primera PLATA). Se busca sola la última edición («edición 2026-2027»); `LIGA_TOURNAMENT_ID` la fija a mano. */
  liga: {
    enabled: process.env.LIGA_ENABLED !== 'false',
    tournamentId: (process.env.LIGA_TOURNAMENT_ID ?? '').trim().toUpperCase(),
    division: new RegExp(process.env.LIGA_DIVISION ?? 'plata', 'i'),
  },
  /** Cuánto se reutiliza el estado público ya calculado (ms). Se descarta antes si cambia algo. 0 = sin caché. */
  publicCacheMs: num(process.env.PUBLIC_CACHE_MS, process.env.VITEST ? 0 : 10_000),
  /** Pasado este tiempo sin una lectura correcta, los datos se marcan como antiguos. */
  staleAfterMs: min('STALE_MINUTES', 45),
  /** Lecturas idénticas necesarias para confirmar un cambio de hora, pista o resultado. */
  confirmReads: 2,

  /** Dirección pública de la web del club (para los enlaces de avisos y de «compartir»). */
  siteUrl: (process.env.SITE_URL ?? '').replace(/\/$/, ''),
  /** Calendario oficial de torneos absolutos (rutas permitidas por robots.txt). Cada 6 h por defecto. */
  calendarRefreshEnabled: process.env.CALENDAR_REFRESH_ENABLED !== 'false',
  calendarHours: num(process.env.CALENDAR_HOURS, 6),
  /** Cómo se muestran en los cuadros las personas que no son jugadores públicos del club: iniciales, nombre o nada. */
  drawNames: (process.env.PUBLIC_DRAW_NAMES ?? 'initials') as 'initials' | 'full' | 'off',
  /** Avisos push (VAPID). Sin claves, los avisos quedan desactivados. */
  vapid: { publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '', subject: process.env.VAPID_SUBJECT ?? '' },
  defaultMatchMin: process.env.DEFAULT_MATCH_MINUTES ? num(process.env.DEFAULT_MATCH_MINUTES, 0) || undefined : undefined,
  changeoverMin: num(process.env.CHANGEOVER_MINUTES, 3),
  /** Descanso programado entre dos partidos de una misma persona (minutos; el club confirma 10). Si los tiempos reales muestran un descanso mayor, manda ese. */
  restMinutes: num(process.env.REST_MINUTES, 10),
  /** Qué se publica de los rivales: su nombre (nombre y primer apellido) o nada (`PUBLIC_OPPONENTS=none`). Por decisión del club, por defecto el nombre; nunca en pruebas de menores (ver `shareRivals.ts`). */
  opponents: (process.env.PUBLIC_OPPONENTS ?? 'names') as OpponentPolicy,
  /** Imagen de «compartir torneo»: el rival sale con nombre y primer apellido (con el consentimiento del club). `SHARE_RIVAL_NAMES=off` lo quita. */
  shareRivalNames: process.env.SHARE_RIVAL_NAMES !== 'off',
  /** Por defecto no se nombra a rivales en torneos con categorías de menores (Sub-13, Sub-17…). `SHARE_RIVAL_YOUTH=true` lo permite. */
  shareRivalYouth: process.env.SHARE_RIVAL_YOUTH === 'true',
  /** Crónicas con IA: con clave de la API de Anthropic y correo del responsable, al terminar un torneo se redacta un borrador y se envía para su aprobación. Sin clave, solo hay las noticias de plantilla. */
  chronicle: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.CHRONICLE_MODEL ?? 'claude-sonnet-5-5',
    email: process.env.CHRONICLE_EMAIL ?? '',
    /** Dirección pública de este servidor (Render la da en RENDER_EXTERNAL_URL): para el enlace de aprobación. */
    baseUrl: (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, ''),
  },
  /** Captura del itinerario en vivo: unos minutos antes del primer partido del día de cada torneo con gente del club, se guarda la imagen y se envía el enlace por correo (FormSubmit). `ITINERARY_EMAIL=off` lo desactiva. */
  itinerary: {
    email: process.env.ITINERARY_EMAIL === 'off' ? '' : process.env.ITINERARY_EMAIL ?? 'pablitocastaneda06@gmail.com',
    minutesBefore: num(process.env.ITINERARY_MINUTES_BEFORE, 15),
    baseUrl: (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'https://club-uva-badminton.onrender.com').replace(/\/$/, ''),
  },
  /** Previa del finde por correo: cada jueves a las 15:00 (Madrid) se envía quién juega y a qué hora son los primeros partidos de la UVa en los torneos que empiezan en los próximos días. `WEEKEND_PREVIEW_EMAIL=off` lo desactiva. */
  weekendPreview: {
    email: process.env.WEEKEND_PREVIEW_EMAIL === 'off' ? '' : process.env.WEEKEND_PREVIEW_EMAIL ?? 'pablitocastaneda06@gmail.com',
    weekday: num(process.env.WEEKEND_PREVIEW_WEEKDAY, 4), // 0 = domingo … 4 = jueves
    hour: num(process.env.WEEKEND_PREVIEW_HOUR, 15),
    /** Minutos desde la hora en que sigue valiendo el envío (por si el servidor se reinicia justo entonces). */
    windowMin: num(process.env.WEEKEND_PREVIEW_WINDOW_MINUTES, 180),
  },
  /** Resumen de resultados del club por correo: cada domingo a las 15:00 (Madrid), los resultados del torneo del finde y un mensaje para redes. `WEEKEND_RESULTS_EMAIL=off` lo desactiva. */
  weekendResults: {
    email: process.env.WEEKEND_RESULTS_EMAIL === 'off' ? '' : process.env.WEEKEND_RESULTS_EMAIL ?? 'pablitocastaneda06@gmail.com',
    weekday: num(process.env.WEEKEND_RESULTS_WEEKDAY, 0),
    hour: num(process.env.WEEKEND_RESULTS_HOUR, 15),
    windowMin: num(process.env.WEEKEND_RESULTS_WINDOW_MINUTES, 180),
  },
  /**
   * Correo saliente (suscripciones y resúmenes): `MAIL_PROVIDER=brevo|resend` con su clave (`BREVO_API_KEY` / `RESEND_API_KEY`) y el remitente
   * (`MAIL_FROM`, una dirección verificada en el proveedor; `MAIL_FROM_NAME`). Sin proveedor, las suscripciones quedan desactivadas.
   */
  mail: {
    provider: (process.env.MAIL_PROVIDER ?? '').trim().toLowerCase() as '' | 'brevo' | 'resend',
    // Se ignoran espacios y saltos de línea sobrantes (al pegar en el panel del hosting) y las variables vacías.
    apiKey: [process.env.BREVO_API_KEY, process.env.RESEND_API_KEY, process.env.MAIL_API_KEY].map((v) => (v ?? '').trim()).find(Boolean) ?? '',
    from: (process.env.MAIL_FROM ?? '').trim(),
    fromName: (process.env.MAIL_FROM_NAME ?? '').trim() || 'Club Bádminton UVa',
  },
  /** Suscripciones por correo: tope de personas, máximo de correos al día por persona y mínimo entre dos correos de confirmación a la misma dirección. */
  subscriptions: {
    max: num(process.env.SUBSCRIBERS_MAX, 3000),
    maxPerDay: num(process.env.SUBSCRIBER_MAILS_PER_DAY, 3),
    /** Avisos de hechos importantes (eliminado, final, podio) a quien sigue a jugadores concretos: máximo de correos distintos al día, aparte de los dos del torneo. */
    maxAlertsPerDay: num(process.env.SUBSCRIBER_ALERTS_PER_DAY, 3),
    cooldownMin: num(process.env.SUBSCRIBE_COOLDOWN_MINUTES, 10),
  },
  /** Limita las consultas a la API pública por IP y minuto. */
  publicRatePerMinute: num(process.env.PUBLIC_RATE_PER_MINUTE, 120),
  /** Días que se conservan las entradas del registro de cambios. */
  changeLogDays: num(process.env.CHANGE_LOG_DAYS, 90),
};

/** Texto del club tal y como aparece en clasificaciones y cuadros. */
export const CLUB_PATTERN = new RegExp(process.env.CLUB_PATTERN ?? 'universidad\\s+de\\s+valladolid|\\buva\\b|univ\\.?\\s+valladolid', 'i');
