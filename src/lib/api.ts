import type { LigaData, LiveState, NewsItem, Tournament } from '../types';

/** Dirección del servidor del club (VITE_API_URL). Sin ella, la web funciona solo con sus datos incluidos. */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').trim().replace(/\/$/, '');
export const hasApi = API_URL.length > 0;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchLiveState = () => getJson<LiveState>('/api/public/state');
/** `null` = el servidor aún no ha leído la Liga (404): se muestra «preparando», no un error. */
export const fetchLiga = async (): Promise<LigaData | null> => {
  const res = await fetch(API_URL + '/api/public/liga', { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LigaData;
};
export const fetchNews = () => getJson<{ news: NewsItem[] }>('/api/public/news');
export const fetchCalendar = () => getJson<{ meta: { comprobadoEl: string; fuente: string; nota: string }; tournaments: Tournament[] }>('/api/public/calendar');
export const fetchSubscribeStatus = () => getJson<{ enabled: boolean }>('/api/public/subscribe');
export const fetchPushKey = () => getJson<{ enabled: boolean; publicKey: string | null }>('/api/public/push/key');

export async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(API_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

/** Aviso del servidor («hay datos nuevos»). El navegador vuelve a pedir el estado al servidor del club, nunca a badminton.es. */
export function listenForUpdates(onUpdate: () => void): () => void {
  if (!hasApi || typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(API_URL + '/api/public/stream');
  es.addEventListener('update', onUpdate);
  return () => es.close();
}

/** Enlace que se comparte: al abrirlo muestra una vista previa del partido y lleva a la web del club. */
export type ShareKind = 'partido' | 'torneo' | 'resultados';
export const shareUrl = (id: string, kind: ShareKind = 'partido') => `${API_URL}/compartir/${kind}/${encodeURIComponent(id)}`;
/** Imagen de la tarjeta: `square` (publicación de Instagram) o `story` (historia); por defecto 1200×630 para la vista previa. */
export const shareImageUrl = (id: string, kind: ShareKind, size: 'og' | 'square' | 'story' = 'og') => `${API_URL}/og/${kind}/${encodeURIComponent(id)}.png?size=${size}`;

/** Abre la conexión con el servidor y pide ya estado, noticias y calendario: las respuestas quedan en la caché HTTP (10-60 s) para cuando la interfaz las pida. */
export function warmUpApi() {
  if (!hasApi || typeof document === 'undefined') return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = API_URL;
  link.crossOrigin = '';
  document.head.appendChild(link);
  for (const path of ['/api/public/state', '/api/public/news', '/api/public/calendar']) void fetch(API_URL + path, { headers: { Accept: 'application/json' } }).catch(() => undefined);
}
