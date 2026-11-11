import * as cheerio from 'cheerio';
import { clean } from './text';

export interface RankingCandidate {
  name: string;
  /** Ruta de la ficha del ranking (player.aspx?id=…&player=…). */
  playerPath: string;
  club: string;
  birthYear?: number;
}

/** «PABLO MARTIN CASTAÑEDA» → «Pablo Martin Castañeda». */
export const titleCase = (s: string) =>
  clean(s)
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())
    .replace(/\b(De|Del|La|Las|Los|Y)\b/g, (m) => m.toLowerCase());

/** Categoría del ranking oficial (/ranking/category.aspx): jugadores con su club y año de nacimiento. */
export function parseRankingCategory(html: string): RankingCandidate[] {
  const $ = cheerio.load(html);
  const out: RankingCandidate[] = [];
  $('tr').each((_, tr) => {
    const a = $(tr).find('a[href*="player.aspx"]').first();
    const href = a.attr('href');
    if (!href || !/player=\d+/.test(href)) return;
    const cells = $(tr).children('td').map((_, td) => clean($(td).text())).get().filter(Boolean);
    const name = clean(a.text());
    const club = cells[cells.length - 1] ?? '';
    // El año de nacimiento va justo antes de la comunidad y el club; los puntos del ranking también pueden parecer un año.
    const year = cells.slice(0, -2).filter((c) => /^(19|20)\d{2}$/.test(c)).at(-1);
    if (name && club && club !== name) out.push({ name, playerPath: href.startsWith('/') ? href : `/ranking/${href}`, club, birthYear: year ? Number(year) : undefined });
  });
  return out;
}

/** Ficha de un jugador del ranking: GUID de su perfil oficial (profile/default.aspx?id=…). */
export function parseRankingProfileGuid(html: string): string | undefined {
  return html.match(/\/profile\/(?:default|overview)\.aspx\?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toUpperCase();
}

export interface RankingRow extends RankingCandidate {
  /** Puesto actual y anterior (si lo publica la federación), puntos del ranking y torneos computados. */
  rank: number;
  prevRank?: number;
  points: number;
  tournaments?: number;
}

/** Tabla de una categoría del ranking: nombre de la prueba («Individual masculino»), fecha del ranking («43-2026») y todas sus filas. */
export function parseRankingTable(html: string): { title?: string; date?: string; rows: RankingRow[] } {
  const $ = cheerio.load(html);
  const rows: RankingRow[] = [];
  $('tr').each((_, tr) => {
    const a = $(tr).find('a[href*="player.aspx"]').first();
    const href = a.attr('href');
    if (!href || !/player=\d+/.test(href)) return;
    const rank = Number(clean($(tr).find('td.rank').first().text()));
    const points = Number(clean($(tr).find('td.rankingpoints').first().text()).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(rank) || !Number.isFinite(points)) return;
    const prev = $(tr).find('[title^="Previous rank"]').first().attr('title')?.match(/(\d+)/)?.[1];
    const cells = $(tr).children('td').map((_, td) => clean($(td).text())).get();
    const name = clean(a.text());
    const club = cells.filter(Boolean).at(-1) ?? '';
    const year = cells.slice(0, -2).filter((c) => /^(19|20)\d{2}$/.test(c)).at(-1);
    const tournaments = Number(clean($(tr).find('td.right').eq(2).text()));
    rows.push({ name, playerPath: href.startsWith('/') ? href : `/ranking/${href}`, club, birthYear: year ? Number(year) : undefined, rank, prevRank: prev ? Number(prev) : undefined, points, tournaments: Number.isFinite(tournaments) ? tournaments : undefined });
  });
  return { title: clean($('table.ruler caption').first().text()) || undefined, date: clean($('.rankingdate').first().text()).replace(/[()]/g, '') || undefined, rows };
}
