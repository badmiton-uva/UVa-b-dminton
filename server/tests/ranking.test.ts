import { describe, expect, it } from 'vitest';
import { parseRankingTable } from '../src/rankingParse';
import { SyncEngine } from '../src/engine';
import { createPlayer } from '../src/roster';
import { settings } from '../src/config';
import { buildPublicState } from '../src/publicView';
import { FakeSource, memDb, PROFILE } from './helpers/fakes';

const html = `<span class="rankingdate">(43-2026)</span><table class="ruler"><caption>Individual masculino</caption>
<tr><td class="rank"><div>18</div></td><td class="rank_up" title="Previous rank: 20">&nbsp;</td><td></td><td><a href="player.aspx?id=1&player=6348206">ENRIQUE FERNANDEZ POLO</a></td><td></td><td>6086</td><td class="right rankingpoints">4938</td><td class="right">29630,0</td><td class="right">8</td><td class="right">1994&nbsp;</td><td>Castilla León</td><td>Universidad de Valladolid</td></tr>
<tr><td class="rank"><div>19</div></td><td></td><td></td><td><a href="player.aspx?id=1&player=7">OTRO NOMBRE</a></td><td></td><td>1</td><td class="right rankingpoints">4900</td><td class="right">1,0</td><td class="right">5</td><td class="right">1990&nbsp;</td><td>Madrid</td><td>Otro Club</td></tr></table>`;

describe('ranking oficial del club', () => {
  it('lee puesto, puesto anterior, puntos, torneos, prueba y semana', () => {
    const t = parseRankingTable(html);
    expect(t.title).toBe('Individual masculino');
    expect(t.date).toBe('43-2026');
    expect(t.rows[0]).toMatchObject({ rank: 18, prevRank: 20, points: 4938, tournaments: 8, club: 'Universidad de Valladolid' });
    expect(t.rows).toHaveLength(2);
  });

  it('el servidor guarda el ranking del club y solo publica a las personas públicas', async () => {
    settings.officialReadEnabled = true;
    const db = memDb();
    createPlayer(db, { name: 'Enrique Fernandez Polo', profile: PROFILE, public: true, consentBy: 'x', consentAt: '2026-10-01' });
    createPlayer(db, { name: 'Marta Fernandez Polo', profile: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEE1', public: false });
    const src = new FakeSource();
    src.rankingTable = (async () => ({ ...parseRankingTable(html), rows: [...parseRankingTable(html).rows, { ...parseRankingTable(html).rows[0], name: 'MARTA FERNANDEZ POLO', playerPath: '/ranking/player.aspx?id=1&player=9', rank: 69 }] })) as never;
    src.rankingPlayers = (async () => []) as never;
    src.rankingProfile = (async () => PROFILE) as never;
    const now = new Date('2026-11-11T10:00:00Z');
    const e = new SyncEngine(db, src, () => now);
    for (let i = 0; i < 10; i++) await e.tick(new Date(now.getTime() + i * 60_000));
    const r = buildPublicState(db, now).ranking;
    expect(r?.date).toBe('43-2026');
    expect(r?.categories[0].name).toBe('Individual masculino');
    expect(r?.categories[0].rows.map((x) => x.name)).toEqual(['Enrique Fernandez Polo']); // Marta no es pública
    expect(r?.categories[0].rows[0]).toMatchObject({ rank: 18, prevRank: 20, points: 4938 });
  });
});
