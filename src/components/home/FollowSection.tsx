import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTournaments } from '../../hooks/useTournaments';
import { fetchSubscribeStatus, hasApi, postJson } from '../../lib/api';
import { SectionHeading } from '../ui';

type Status = 'idle' | 'sending' | 'sent' | 'error';

/**
 * «Sigue al club»: formulario para recibir por correo el resumen semanal de noticias, resultados y partidos ganados del equipo o de jugadores concretos.
 * Doble confirmación: la persona recibe un correo y la suscripción no vale hasta que lo confirma; cada resumen lleva un enlace para darse de baja.
 */
export function FollowSection() {
  const { live } = useTournaments();
  const players = live?.players ?? [];
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<number[]>([]);
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!hasApi) return;
    fetchSubscribeStatus().then((s) => setEnabled(s.enabled), () => setEnabled(undefined));
  }, []);

  if (!hasApi) return null;
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const ready = enabled === true && status !== 'sending';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'some' && picked.length === 0) {
      setStatus('error');
      setMessage('Elige al menos un jugador, o sigue a todo el equipo.');
      return;
    }
    setStatus('sending');
    try {
      await postJson('/api/public/subscribe', { email, all: mode === 'all', players: mode === 'all' ? [] : picked, consent, website: trap });
      setStatus('sent');
      setMessage('');
    } catch (err) {
      setStatus('error');
      setMessage((err as Error).message || 'No hemos podido enviar el correo. Inténtalo de nuevo en unos minutos.');
    }
  }

  return (
    <section className="section follow" aria-labelledby="follow-title" id="sigue">
      <div className="container follow__box">
        <SectionHeading sport id="follow-title" eyebrow="Sigue al club" title="Recibe los resultados en tu correo" lead="Elige a todo el equipo o a los jugadores que quieras seguir y te enviaremos un resumen semanal con las noticias, los resultados y los partidos ganados." />
        {enabled === false && <p className="follow__note" role="status">Estamos activando el envío de correos. Vuelve en unos días y podrás suscribirte.</p>}
        {status === 'sent' ? (
          <p className="follow__ok" role="status">
            ¡Casi listo! Te hemos enviado un correo a <strong>{email}</strong>. Abre el enlace que lleva para confirmar la suscripción (mira también en spam). Hasta que no lo confirmes, no recibirás nada.
          </p>
        ) : (
          <form className="follow__form" onSubmit={submit} noValidate>
            <label className="follow__field">
              <span>Tu correo electrónico</span>
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nombre@ejemplo.com" disabled={enabled !== true} />
            </label>
            <fieldset className="follow__who" disabled={enabled !== true}>
              <legend>¿A quién quieres seguir?</legend>
              <label><input type="radio" name="mode" checked={mode === 'all'} onChange={() => setMode('all')} /> Todo el equipo</label>
              <label><input type="radio" name="mode" checked={mode === 'some'} onChange={() => setMode('some')} /> Jugadores concretos</label>
              {mode === 'some' && (
                <ul className="follow__players">
                  {players.map((p) => (
                    <li key={p.id}>
                      <label><input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>
                    </li>
                  ))}
                  {players.length === 0 && <li className="follow__note">Cargando la lista de jugadores…</li>}
                </ul>
              )}
            </fieldset>
            <input className="follow__trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} />
            <label className="follow__consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required disabled={enabled !== true} />
              <span>
                Acepto que el Club Bádminton Universidad de Valladolid use mi correo para enviarme este resumen. Puedo darme de baja con un clic en cualquier correo. Más información en la <Link to="/legal">política de privacidad</Link>.
              </span>
            </label>
            {status === 'error' && <p className="follow__error" role="alert">{message}</p>}
            <button type="submit" className="btn btn--primary" disabled={!ready || !consent || !email}>
              {status === 'sending' ? 'Enviando…' : 'Suscribirme'}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
