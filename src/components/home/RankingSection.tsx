import { useState } from 'react';
import { useTournaments } from '../../hooks/useTournaments';
import { SectionHeading } from '../ui';

const number = new Intl.NumberFormat('es-ES');
const short = (name: string) => name.replace(/^Individual /, 'Ind. ').replace(/^Dobles /, 'Dobles ');

/** Ranking oficial de la federación (Absoluto) de los jugadores del club, por prueba: puesto, evolución y puntos. */
export function RankingSection() {
  const { live } = useTournaments();
  const ranking = live?.ranking;
  const [chosen, setChosen] = useState<string>();
  if (!ranking || ranking.categories.length === 0) return null;
  const cat = ranking.categories.find((c) => c.name === chosen) ?? ranking.categories[0];
  const week = ranking.date?.match(/^(\d+)-(\d{4})$/);

  return (
    <section id="ranking" className="section section--tint" aria-labelledby="ranking-title">
      <div className="container">
        <SectionHeading
          id="ranking-title"
          eyebrow="Ranking"
          title="Ranking nacional del club"
          lead={`Puesto y puntos de nuestros jugadores en el ranking absoluto de la Federación Española${week ? ` (semana ${week[1]} de ${week[2]})` : ''}.`}
          sport
        />
        <div className="rk__tabs" role="tablist" aria-label="Prueba del ranking">
          {ranking.categories.map((c) => (
            <button key={c.name} role="tab" type="button" aria-selected={c.name === cat.name} className={c.name === cat.name ? 'is-active' : ''} onClick={() => setChosen(c.name)}>
              {short(c.name)}
            </button>
          ))}
        </div>
        <div className="rk__wrap">
          <table className="rk__table">
            <caption className="sr-only">{cat.name}: ranking de los jugadores del club</caption>
            <thead>
              <tr><th scope="col">Puesto</th><th scope="col"><span className="sr-only">Evolución</span></th><th scope="col">Jugador/a</th><th scope="col" className="rk__num">Puntos</th><th scope="col" className="rk__num rk__hide">Torneos</th></tr>
            </thead>
            <tbody>
              {cat.rows.map((r) => {
                const d = r.prevRank !== undefined ? r.prevRank - r.rank : 0;
                return (
                  <tr key={r.name}>
                    <td className="rk__pos">{r.rank}º</td>
                    <td className={`rk__trend${d > 0 ? ' up' : d < 0 ? ' down' : ''}`} title={r.prevRank !== undefined ? `Puesto anterior: ${r.prevRank}º` : undefined}>
                      {d > 0 ? <><span aria-hidden="true">▲</span> <span className="sr-only">Sube </span>{d}</> : d < 0 ? <><span aria-hidden="true">▼</span> <span className="sr-only">Baja </span>{-d}</> : <span aria-hidden="true">=</span>}
                    </td>
                    <td className="rk__name">{r.name}</td>
                    <td className="rk__num"><strong>{number.format(r.points)}</strong></td>
                    <td className="rk__num rk__hide">{r.tournaments ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="source-note">Fuente: <a href="https://www.badminton.es/ranking/" target="_blank" rel="noopener noreferrer">ranking oficial en badminton.es<span className="sr-only"> (se abre en una pestaña nueva)</span></a>. Se actualiza solo cada día; solo aparecen quienes han dado su consentimiento.</p>
      </div>
    </section>
  );
}
