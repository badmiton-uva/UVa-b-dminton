/** Estado de verificación de un contenido. Todo lo que no sea "verified" se muestra como pendiente. */
export type ContentStatus = 'verified' | 'pending';

/** Imagen del club. `responsive`: versiones WebP `<base>-<ancho>.webp` para cada ancho (el navegador elige la que necesita). */
export interface ClubImage {
  src: string;
  alt: string;
  provisional: boolean;
  responsive?: { base: string; widths: number[] };
}

export interface ClubInfo {
  name: string;
  university: string;
  tagline: string;
  /** Texto de la portada. Editable. */
  heroMessage: string;
  /** Texto de la sección "El club". Editable. */
  about: { title: string; paragraphs: string[]; status: ContentStatus };
  /** Correo oficial. `null` mientras no se facilite: no se muestra en la web. */
  email: string | null;
  /** Redes sociales confirmadas. Vacío mientras no se faciliten. */
  socials: { label: string; url: string }[];
  /** Dirección / sede habitual. `null` mientras no se facilite. */
  address: string | null;
  /** Datos del titular para el aviso legal. `null` = pendiente de facilitar (se marca en la página). */
  legal: { holder: string | null; taxId: string | null; address: string | null; email: string | null; dpoEmail: string | null; updated: string };
  /** Imágenes de portada y presentación. `provisional` muestra el aviso "imagen provisional". */
  images: {
    hero: ClubImage;
    about: ClubImage;
  };
}

export interface Player {
  id: string;
  name: string;
  /** Función dentro del club: jugador/a, capitán/a, entrenador/a, delegado/a… */
  role: string;
  /** Ruta de la fotografía. Si falta se muestra una silueta neutra. */
  photo?: string;
  /** Información deportiva adicional (categoría, palmarés…), solo si se facilita. */
  info?: string;
  /**
   * Autorización para publicar nombre y foto (en menores, de su familia o tutores).
   * Si no es `true`, la persona NO se muestra en la web.
   */
  consent: boolean;
}

export interface Achievement {
  id: string;
  title: string;
  /** Valor destacado (p. ej. "3"). `null` = dato pendiente de facilitar. */
  value: string | null;
  description: string;
  status: ContentStatus;
}

export interface HistorySection {
  id: string;
  title: string;
  /** Texto; vacío mientras esté pendiente. */
  paragraphs: string[];
  status: ContentStatus;
  /** Indicación para el responsable del club sobre qué información aportar. */
  needed: string;
}

export interface TimelineEntry {
  id: string;
  /** Año o fecha, tal cual se mostrará ("2019", "Octubre 2021"). */
  date: string;
  title: string;
  description: string;
  source?: string;
}

export interface HistoryData {
  sections: HistorySection[];
  /** Línea temporal: solo se muestra cuando hay entradas verificadas. */
  timeline: TimelineEntry[];
  /** Fotografías históricas (cuando se faciliten). */
  photos: { id: string; src: string; alt: string; caption: string; year?: string }[];
  /** Fuentes consultadas. */
  sources?: { label: string; url: string }[];
}

export type TournamentStatus = 'upcoming' | 'ongoing' | 'finished';

export interface Tournament {
  id: string;
  name: string;
  /** ISO `YYYY-MM-DD`. */
  startDate: string;
  /** ISO `YYYY-MM-DD`. Omitir en torneos de un solo día. */
  endDate?: string;
  city: string;
  venue?: string;
  address?: string;
  /** Ámbito (Nacional / Territorial) en el calendario oficial; en torneos propios, la categoría. */
  category?: string;
  /** Nivel oficial publicado por la FESBA (n7, TOP Máster, Premium…). */
  level?: string;
  /** Nº de integrantes del club inscritos. Omitir si no se conoce. */
  clubParticipants?: number;
  /** Nombres de inscritos: solo si es público y está autorizado. */
  players?: string[];
  externalUrl?: string;
  /** Resultados en texto, para torneos finalizados. */
  results?: string;
  /** Partidos de jugadores de la UVa (los registra el club, o llegan del servidor en directo). */
  matches?: UvaMatch[];
  /** Identificador del torneo en el servidor en directo (GUID oficial). */
  liveId?: string;
  progress?: LiveProgress;
  draws?: LiveDraw[];
  /** Resultados de la UVa por prueba (medallas y ronda alcanzada). */
  podium?: UvaResult[];
  /** Balance de la UVa (partidos ganados/perdidos y medallas): base de la gráfica de trayectoria. */
  record?: UvaRecord;
  /** Inscripción y admisión de personas del club (solo torneos futuros leídos por el servidor). */
  entries?: TournamentEntry[];
  /** Última lectura correcta de la fuente para este torneo (ISO) y si ya es antigua. */
  checkedAt?: string;
  stale?: boolean;
  officialUrl?: string;
  /** `true` = dato de ejemplo, no real. Se muestra con la etiqueta "Provisional". */
  provisional?: boolean;
  /**
   * Origen del dato. Hoy todo es "manual"; reservado para una futura sincronización
   * con una fuente oficial (ver `src/lib/tournamentSource.ts`).
   */
  source?: 'manual' | 'official';
  /** Identificador en la fuente oficial, si algún día existe. */
  externalId?: string;
}

/** Participación de la UVa en un torneo del calendario oficial. Solo se rellena con datos confirmados por el club. */
export interface UvaEntry {
  /** `id` del torneo en `calendario-oficial.json` (p. ej. "fesba-88169"). */
  tournamentId: string;
  clubParticipants?: number;
  /** Nombres: solo de jugadores con autorización para publicarse. */
  players?: string[];
  results?: string;
  matches?: UvaMatch[];
}

export interface UvaTournamentsFile {
  entradas: UvaEntry[];
  /** Torneos con jugadores de la UVa que no figuran en el calendario oficial absoluto. */
  torneosPropios: Tournament[];
}

export type MatchState = 'scheduled' | 'live' | 'finished';

/** Partido de jugadores de la UVa. Lo registra el club; solo con jugadores autorizados para publicarse. */
export interface UvaMatch {
  id: string;
  /** Prueba y ronda, tal cual las publica el torneo ("IM · Octavos"). */
  event?: string;
  /** Jugadores de la UVa que disputan el partido. */
  players: string[];
  opponent?: string;
  state: MatchState;
  /** `YYYY-MM-DD` y `HH:MM` locales de la sede, si se conocen. */
  date?: string;
  time?: string;
  court?: string;
  /** Marcador por sets desde el punto de vista de la UVa ("21-15 18-21 21-17"). Solo si ha terminado. */
  score?: string;
  /** Resultado para la UVa; solo si el partido ha terminado y se conoce. */
  outcome?: 'win' | 'loss';
  /** Hora programada y hora estimada de inicio según el ritmo real del torneo (ISO). */
  plannedStart?: string;
  estimatedStart?: string;
  /** «Podría empezar desde»: hora más temprana razonable (percentil bajo de la estimación). */
  earliestStart?: string;
  /** Partidos del torneo (de cualquiera) que aún no han empezado y van antes que este. */
  ahead?: number;
}

/** Balance de la UVa en un torneo (lo calcula el servidor con los cuadros). */
export interface UvaRecord {
  won: number;
  lost: number;
  gold: number;
  silver: number;
  bronze: number;
}

/** Resultado de una persona o pareja de la UVa en una prueba (lo calcula el servidor con los cuadros). */
export interface UvaResult {
  event: string;
  entrant: string;
  /** 1 = oro, 2 = plata, 3 = bronce. */
  place?: 1 | 2 | 3;
  text: string;
  done: boolean;
}

/** Inscripción de una persona del club en una prueba y su estado según la lista oficial. */
export interface TournamentEntry {
  player: string;
  event: string;
  status: 'admitted' | 'reserve' | 'excluded' | 'registered';
  /** Cabeza de serie (nº) en la lista oficial y nº de inscripciones de la prueba. */
  seed?: number;
  total?: number;
}

/** Estimación estadística del avance del torneo (la calcula el servidor con el ritmo real de los partidos). */
export interface LiveProgress {
  date: string;
  asOf: string;
  total: number;
  finished: number;
  live: number;
  remaining: number;
  avgDurationMin?: number;
  plannedSlotMin?: number;
  delayMin?: number;
  courts: number;
  basis: 'observed' | 'default' | 'manual';
  done: boolean;
  estimatedEnd?: string;
  estimatedEndLow?: string;
  estimatedEndHigh?: string;
}

export interface LiveEntrant {
  label: string;
  uva: boolean;
  club?: string;
  bye?: boolean;
  placeholder?: string;
}

export interface LiveDraw {
  id: number;
  name: string;
  type: 'knockout' | 'roundrobin';
  /** Prueba («IM», «DX»…) y, en grupos, «Grupo A» y cuántos de él pasan al cuadro final. */
  base: string;
  group?: string;
  qualify?: number;
  standings?: { rank: number; entrant: LiveEntrant; played: number; won: number; lost: number; matches: string; games: string; points: string; pts: number }[];
  rounds?: { title: string; matches: { a: LiveEntrant; b: LiveEntrant; winner?: 1 | 2; sets: [number, number][]; when?: string; court?: string; note?: string }[] }[];
}

/** Lo que devuelve /api/public/state del servidor. */
export interface LiveState {
  generatedAt: string;
  officialReadEnabled: boolean;
  lastErrorAt?: string;
  version: string;
  players: { id: number; name: string; category?: string }[];
  pushEnabled: boolean;
  /** Noticias generadas solas con los resultados de los torneos terminados. */
  news?: NewsItem[];
  /** Partidos ganados/perdidos en torneos que no figuran en `tournaments` (últimas temporadas): solo para la gráfica de trayectoria. */
  history?: { id: string; name: string; date: string; won: number; lost: number }[];
  /** Ranking oficial del club por prueba (solo jugadores públicos). */
  ranking?: LiveRanking;
  tournaments: {
    id: string; name: string; startDate?: string; endDate?: string; city?: string; venue?: string; level?: string;
    officialUrl?: string; manual?: boolean; uvaPlayers: string[]; matches: UvaMatch[]; progress?: LiveProgress; draws: LiveDraw[]; results?: UvaResult[]; record?: UvaRecord; entries?: TournamentEntry[]; checkedAt?: string; stale: boolean;
  }[];
}

export interface LiveRanking {
  updatedAt: string;
  /** Semana del ranking oficial, p. ej. «43-2026». */
  date?: string;
  categories: { name: string; rows: { name: string; rank: number; prevRank?: number; points: number; tournaments?: number }[] }[];
}

/** Noticia del club (se escribe a mano en `src/data/news.json`). */
export interface NewsItem {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  tag: string;
  title: string;
  summary: string;
  tournament?: { name: string; place?: string };
  /** Resultados del club en la noticia: 1 = oro, 2 = plata, 3 = bronce. */
  medals?: { place: 1 | 2 | 3; event: string; eventName: string; who: string; detail?: string }[];
  /** Puntos clave de la noticia (camino hasta la medalla, etc.). */
  highlights?: string[];
  /** Crónica (párrafos) redactada con IA y aprobada por el club. */
  body?: string[];
  /** Torneo al que se refiere (GUID oficial): una noticia escrita a mano sustituye a la automática del mismo torneo. */
  tournamentGuid?: string;
  /** `true` si la ha generado sola el servidor con los resultados oficiales. */
  auto?: boolean;
  sources?: { label: string; url: string }[];
}

/** Liga Nacional de Clubes (división que sigue el club), tal como la publica el servidor en /api/public/liga. */
export interface LigaClub {
  rank: number;
  club: string;
  uva: boolean;
  points: number;
  adjusted: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  matchesFor: number;
  matchesAgainst: number;
}

export interface LigaFixture {
  id: number;
  home: string;
  away: string;
  homeScore?: number;
  awayScore?: number;
  date?: string;
  time?: string;
  moved: boolean;
  uva: boolean;
  status: 'scheduled' | 'finished';
  url: string;
}

export interface LigaData {
  edition: string;
  division: string;
  updatedAt: string;
  officialUrl: string;
  /** `false` hasta que se juegue el primer encuentro. */
  started: boolean;
  clubs: LigaClub[];
  rounds: { round: number; date?: string; fixtures: LigaFixture[] }[];
  currentRound?: number;
  version: string;
}
