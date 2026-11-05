import type { ReactNode } from 'react';
import { PageHeader, PendingTag } from '../components/ui';
import { club } from '../config/site';
import { usePageTitle } from '../hooks/usePageTitle';

const Data = ({ label, value }: { label: string; value: string | null }) => (
  <li>
    <strong>{label}:</strong> {value ?? <PendingTag>Pendiente de facilitar</PendingTag>}
  </li>
);

const Block = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section id={id} className="legal" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
  </section>
);

export function LegalPage() {
  usePageTitle('Información legal');
  const { legal } = club;
  const mail = legal.email ?? club.email;
  const dpo = legal.dpoEmail ?? mail;

  return (
    <>
      <PageHeader title="Información legal" lead="Aviso legal, política de privacidad y política de cookies de la web del club." />
      <div className="section">
        <div className="container container--narrow">
          <p className="legal__updated">Última actualización: {new Date(legal.updated).toLocaleDateString('es-ES', { dateStyle: 'long' })}</p>

          <Block id="aviso-legal" title="Aviso legal">
            <p>
              En cumplimiento del artículo 10 de la Ley 34/2002, de Servicios de la Sociedad de la Información y de Comercio Electrónico
              (LSSI-CE), se facilitan los datos de identificación del titular de esta web.
            </p>
            <ul>
              <Data label="Titular" value={legal.holder} />
              <Data label="Domicilio" value={legal.address} />
              <Data label="Sede del club" value={club.address} />
              <Data label="Correo electrónico" value={mail} />
            </ul>
            <h3>Objeto y condiciones de uso</h3>
            <p>
              Esta web ofrece información del {club.name} de la {club.university}: presentación, historia, calendario de competiciones y
              seguimiento de torneos. El acceso es gratuito. Quien la utiliza se compromete a hacerlo de forma lícita, sin dañar el sitio ni
              intentar acceder a zonas restringidas (como el panel de administración).
            </p>
            <h3>Propiedad intelectual</h3>
            <p>
              Los textos, el diseño y el código de la web pertenecen a su titular. El nombre y el logotipo de la Universidad de Valladolid son
              marcas de la Universidad y se usan para identificar al club; no se pueden reutilizar fuera de ese fin sin su autorización. Se
              permite citar contenidos indicando la fuente.
            </p>
            <h3>Datos deportivos de terceros</h3>
            <p>
              Los calendarios, cuadros, horarios y resultados proceden de las páginas públicas de la Federación Española de Bádminton
              (badminton.es) y de las federaciones territoriales. La web los presenta con fines informativos y sin vínculo oficial con ellas.
              Las horas marcadas como <strong>EST (estimación)</strong> son cálculos estadísticos y pueden cambiar: los horarios oficiales son
              los de la organización de cada torneo.
            </p>
            <h3>Responsabilidad y enlaces</h3>
            <p>
              El titular procura que la información sea exacta y esté actualizada, pero no garantiza la ausencia de errores ni la disponibilidad
              continua del servicio, y no responde de las decisiones tomadas a partir de datos informativos o estimados. Los enlaces a webs de
              terceros se ofrecen como referencia; su contenido es responsabilidad de sus titulares.
            </p>
            <h3>Legislación aplicable</h3>
            <p>Este aviso se rige por la legislación española. Para cualquier controversia serán competentes los juzgados y tribunales que correspondan conforme a la ley.</p>
          </Block>

          <Block id="privacidad" title="Política de privacidad">
            <p>
              Información sobre el tratamiento de datos personales conforme al Reglamento (UE) 2016/679 (RGPD) y a la Ley Orgánica 3/2018
              (LOPDGDD).
            </p>
            <h3>Responsable</h3>
            <ul>
              <Data label="Responsable del tratamiento" value={legal.holder} />
              <Data label="Contacto en materia de protección de datos" value={dpo} />
            </ul>

            <h3>Qué datos tratamos, para qué y con qué base</h3>
            <div className="legal__table" role="region" aria-label="Tratamientos de datos" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Tratamiento</th>
                    <th scope="col">Datos</th>
                    <th scope="col">Finalidad</th>
                    <th scope="col">Base jurídica</th>
                    <th scope="col">Conservación</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Formulario de contacto</td>
                    <td>Nombre, apellidos, correo y mensaje</td>
                    <td>Atender tu consulta o petición</td>
                    <td>Consentimiento (art. 6.1.a RGPD), al marcar la casilla</td>
                    <td>El tiempo necesario para responder y, después, durante los plazos legales de posibles responsabilidades</td>
                  </tr>
                  <tr>
                    <td>Seguimiento de jugadores en Directo</td>
                    <td>Nombre, club, torneos, partidos, horarios y resultados de jugadores del club</td>
                    <td>Informar de la participación del club en torneos</td>
                    <td>Consentimiento de la persona (o de sus tutores si es menor de edad). Sin consentimiento no se publica nada</td>
                    <td>Mientras se mantenga el consentimiento; se borran en cuanto lo retires o lo solicites</td>
                  </tr>
                  <tr>
                    <td>Avisos en el navegador (notificaciones push)</td>
                    <td>Identificador técnico de suscripción del navegador y jugador elegido</td>
                    <td>Enviarte un aviso antes de un partido</td>
                    <td>Consentimiento (lo das al activar el aviso)</td>
                    <td>Hasta que desactives el aviso o el navegador deje de recibirlos</td>
                  </tr>
                  <tr>
                    <td>Suscripción por correo («Sigue al club»)</td>
                    <td>Correo electrónico y a qué jugadores (o a todo el equipo) quieres seguir</td>
                    <td>Enviarte un resumen semanal con noticias, resultados y partidos ganados</td>
                    <td>Consentimiento (art. 6.1.a RGPD), al marcar la casilla y confirmar el correo que te enviamos (doble confirmación)</td>
                    <td>Hasta que te des de baja con el enlace de cada correo (se borra tu dirección) o lo solicites; las suscripciones sin confirmar se borran a los 7 días</td>
                  </tr>
                  <tr>
                    <td>Registros técnicos del servidor</td>
                    <td>Datos técnicos de la conexión (dirección IP, fecha, página) en los registros del proveedor de alojamiento</td>
                    <td>Seguridad y funcionamiento del servicio</td>
                    <td>Interés legítimo (art. 6.1.f RGPD)</td>
                    <td>El plazo breve que aplique el proveedor</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>Menores de edad</h3>
            <p>
              No se publica ningún dato de menores sin el consentimiento expreso de sus padres o tutores. Los menores se ocultan por defecto en
              la parte pública.
            </p>

            <h3>Origen de los datos deportivos</h3>
            <p>
              Los datos de torneos, cuadros y resultados se obtienen de las páginas públicas de las federaciones de bádminton. Solo se muestran
              en esta web los de las personas del club que han dado su consentimiento. En los partidos de las personas del club figura también el nombre y el primer apellido de la persona rival, tal como aparece en la información
              pública de la federación; no se nombra a rivales en pruebas o torneos con categorías de menores. Cualquier persona puede pedir que se retire su nombre desde el formulario de contacto.
            </p>

            <h3>Destinatarios y encargados del tratamiento</h3>
            <p>No se venden ni ceden datos a terceros con fines comerciales. Para prestar el servicio intervienen proveedores técnicos que actúan como encargados del tratamiento:</p>
            <ul>
              <li>GitHub Pages (alojamiento de la web estática).</li>
              <li>Render (alojamiento del servidor del seguimiento en directo) y Upstash (copia de seguridad de la lista de jugadores y los partidos).</li>
              <li>FormSubmit (formsubmit.co), que recibe el mensaje del formulario de contacto y lo reenvía por correo al responsable de la web.</li>
              <li>Anthropic (API de Claude), que redacta borradores de crónicas de torneos a partir de los resultados ya públicos de las personas del club con consentimiento; no recibe datos de contacto ni de rivales, y ningún texto se publica sin aprobación del responsable.</li>
              <li>El proveedor de envío de correo (Brevo o Resend), que envía los correos de confirmación y los resúmenes a las personas suscritas.</li>
              <li>El servicio de notificaciones del navegador (Google, Mozilla o Apple, según tu navegador) para los avisos push.</li>
            </ul>
            <p>
              Alguno de estos proveedores puede tratar datos fuera del Espacio Económico Europeo (por ejemplo, en EE. UU.). En ese caso se
              apoyan en las garantías previstas en el RGPD, como las cláusulas contractuales tipo o el Marco de Privacidad de Datos UE‑EE. UU.
            </p>

            <h3>Tus derechos</h3>
            <p>
              Puedes ejercer los derechos de acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad, y retirar
              tu consentimiento en cualquier momento (sin que afecte a lo ya realizado), escribiendo a{' '}
              {dpo ? <a href={`mailto:${dpo}`}>{dpo}</a> : <PendingTag>correo pendiente de facilitar</PendingTag>} e identificándote.
              Atenderemos la solicitud en el plazo de un mes. Si crees que se han vulnerado tus derechos, puedes reclamar ante la{' '}
              <a href="https://www.aepd.es" target="_blank" rel="noopener noreferrer">
                Agencia Española de Protección de Datos
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
              .
            </p>
            <p>
              Si una persona del club pide dejar de aparecer, se oculta de inmediato y, si lo solicita, se borran del servidor todos sus datos y
              partidos guardados.
            </p>

            <h3>Seguridad</h3>
            <p>
              La web usa conexión cifrada (HTTPS). El panel de administración está protegido por un código secreto y los datos personales no se
              incluyen en las respuestas públicas salvo consentimiento.
            </p>
          </Block>

          <Block id="cookies" title="Política de cookies y almacenamiento local">
            <p>
              Esta web <strong>no utiliza cookies</strong> ni herramientas de analítica o publicidad, y las fuentes tipográficas se sirven desde el
              propio sitio, sin conexión a terceros. Por eso el aviso que ves al entrar es meramente informativo: no hay cookies opcionales que aceptar o rechazar.
            </p>
            <p>
              Únicamente, si activas un aviso de partido, el navegador guarda en su almacenamiento local una preferencia (qué jugador y con cuántos
              minutos de antelación) y registra un <em>service worker</em> para recibir la notificación. Es un almacenamiento técnico necesario
              para el servicio que has solicitado, exento de consentimiento previo, y puedes borrarlo desde los ajustes del navegador o
              desactivando el aviso.
            </p>
          </Block>
        </div>
      </div>
    </>
  );
}
