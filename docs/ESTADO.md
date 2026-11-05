# Estado del proyecto (v0.1)

## Terminado

- Páginas **Inicio**, **Historia**, **Calendario**, **Contacto** y **Legal** (esta última como estructura pendiente).
- Inicio: portada con superposición azul oscuro, presentación, logros, equipo, próximas 3 competiciones, contacto rápido y pie.
- Calendario: vista mensual y vista de lista con los mismos datos; filtros por mes, estado y categoría
  (la categoría aparece solo si hay datos); ficha detallada de cada torneo (enlazable: `/calendario?torneo=<id>`).
- Equipo, torneos, logros e historia se editan en `src/data/` sin tocar componentes.
- Navegación responsive (menú móvil accesible), teclado, foco visible, enlace "Saltar al contenido",
  `prefers-reduced-motion`, fuentes autoalojadas.
- Formulario con validación, antispam básico, prevención de envíos duplicados y estado de
  configuración visible. Tests de la lógica (`npm test`).
- Paleta tomada del logotipo UVa facilitado (`#2F2C64`) con azules complementarios.

- Calendario oficial absoluto (136 torneos, nacionales y territoriales) con fecha de última comprobación, y filtro
  «Solo con jugadores de la UVa» activo por defecto. Script `npm run calendario:actualizar` (solo rutas permitidas).

## Entrada manual y despliegue (listo)

- Panel `/admin`: torneos, partidos, «en juego», resultados por sets y cifras de la jornada → hora estimada de fin. Probado de
  punta a punta en navegador y con 104 pruebas. Guía de puesta en marcha en `docs/MANANA.md`.
- Despliegue en un comando (`npm run setup`, `docker compose up -d`), copia de seguridad diaria, comprobado con una instalación limpia.

## Servidor en directo (`server/`)

Hecho y probado con una fuente simulada y con los lectores oficiales conectados (falta la primera ejecución en vivo, ver abajo):

- Lista de jugadores con consentimiento + panel `/admin`; descubrimiento de torneos desde el perfil oficial.
- Lectura de una vez por torneo, frecuencias por fase (orden de juego cada 3 min en jornada), confirmación de cambios con
  2 lecturas, registro de cambios, antigüedad de los datos.
- Estimación de la hora de fin del torneo y de cada partido; cuadros; avisos push N min antes; enlaces para compartir.
- Web: página **Directo** (en juego / próximos / resultados, hora de fin en grande, cuadros, avisos, compartir).

Importante:

- **Lectores de páginas de torneo: conectados** (`server/src/officialReaders.ts`). Reutilizan, con permiso de su autor, los lectores
  de «Badminton Live», verificados allí con páginas oficiales reales (42 pruebas de lectores y cliente HTTP, todas en verde).
  En este repositorio hay 121 pruebas, incluido el ciclo completo con el motor real contra un servidor simulado.
- **Para que lea los datos hace falta el enlace al perfil oficial de cada jugador** (campo «Perfil» del panel `/admin` o columna
  `perfil` del CSV): de ahí descubre sus torneos. Sin enlaces no hay descubrimiento. Hoy los 8 jugadores no tienen enlace.
- **La lectura en directo está DESACTIVADA por defecto** (`OFFICIAL_READ_ENABLED=false`): las rutas de inscritos, cuadros,
  partidos y perfiles están excluidas por el `robots.txt` de badminton.es. Activarla es decisión del club; se recomienda
  autorización de la FESBA / Federación de Castilla y León. **No se ha ejecutado contra badminton.es en vivo** más que el calendario.
- Requiere alojar el servidor (ver `server/README.md`) y definir `VITE_API_URL` en la web.

## Inscripción y admisión en torneos futuros

- El servidor lee la lista de inscritos de cada prueba (una prueba por lectura, cada 6 h / 3 h / 1 h según la cercanía) de los torneos
  futuros en los que figura alguien del club, y guarda solo el estado de las personas con consentimiento: admitido, reserva, baja o
  inscrito sin confirmar. No se guardan parejas ni rivales.
- En el Calendario (tarjeta y ficha) y en Directo se ve «Inscripción y admisión». Cuando se publican, aparecen solos los cuadros
  y el orden de juego en la misma ficha.
- Torneos de los próximos 30 días (`FOLLOW_CALENDAR_DAYS`), aunque aún no tengan cuadros: se lee la lista de jugadores (solo nombres) y se
  reconoce a la gente del club por nombre; cada coincidencia se confirma con el perfil oficial que enlaza su ficha en el torneo, así que un
  homónimo de otro club no se atribuye al club. Después se lee su estado de admisión por prueba.
- Además se incluyen los torneos que enlaza el perfil oficial de cada jugador o jugadora, hasta 90 días antes (`ENTRIES_DAYS`).

## Noticias automáticas

- Cuando un torneo con resultados del club termina (pasa su último día o no quedan partidos), el servidor crea solo una noticia en el
  carrusel de la portada: medallas por prueba con el marcador de la final, o dónde cayó cada jugador/a si no hubo medallas. Solo salen
  personas con consentimiento y no se publican rivales. Se mantiene 45 días y se actualiza sola con cada lectura de resultados.
- Una noticia escrita a mano en `src/data/news.json` con el mismo `tournamentGuid` sustituye a la automática.
- Una tarea programada (sábados y domingos por la noche) comprueba que se han generado y avisa si algo no cuadra.

## Compartir y SEO

- Botón «Compartir» en cada partido, en cada torneo y en sus resultados (WhatsApp, enviar desde el móvil, copiar enlace e imágenes para
  Instagram: cuadrada para publicación y vertical para historia). El enlace enseña en WhatsApp, Telegram o X una tarjeta deportiva con el
  «vs» y el marcador (o la hora estimada si aún no se juega); la imagen cambia sola cuando cambia el partido.
- Las tarjetas las dibuja el servidor (`/og/...png`, `/compartir/...`) con la misma tipografía de la web y solo con datos públicos:
  jugadores con consentimiento y rivales únicamente si `PUBLIC_OPPONENTS=names` (si no, sale «Rival»).
- Etiquetas Open Graph y Twitter, enlace canónico, datos estructurados, `robots.txt`, `sitemap.xml` y título/descripción por página.
  La dirección pública está en `.env.production` (`VITE_SITE_URL`): cambiarla si se compra un dominio, y actualizar `public/sitemap.xml` y `robots.txt`.

## Estimación, cuadros y rendimiento

- Estimación calibrada con 1.299 partidos reales y probada con 10 torneos terminados (ver `docs/ESTIMACION.md`).
- Directo: «En juego ahora», agenda por horas (hora estimada **EST**), fin estimado del torneo, y grupos (clasificación + partidos)
  y esquema del cuadro final por prueba, todo actualizado cada minuto si hay partidos hoy.
- Rendimiento web (móvil con conexión lenta): imágenes WebP en varios tamaños (portada de 165 KB a 28–91 KB según pantalla) con la principal
  precargada, logotipos pequeños, calendario oficial incluido en la web solo bajo demanda (el código inicial pasa de 18 a 14 KB comprimido),
  una fuente menos, conexión y primeras peticiones al servidor desde el arranque, y últimos datos guardados en el navegador (30 min) para pintar
  al instante. Medido con 4G lento y CPU 4× más lenta: la portada pasa de 3,7 s a 2,1 s hasta mostrar la imagen principal y de 550 a 417 KB.
- Rendimiento: lectura de cuadros solo donde juega el club tras la primera pasada; estado público calculado una vez (caché, ETag y 304);
  caché HTTP acotada; web dividida por páginas.

## Pendiente

| Elemento | Qué hay que aportar / hacer |
| --- | --- |
| Fotografía de grupo | Portada con la foto del equipo (hecha). Falta confirmar el consentimiento de las personas que aparecen para publicar su imagen. |
| Presentación del club | Texto del informe e imagen UVa + volante (hechos). Confirmar con la UVa el uso del logotipo y el nombre. |
| Integrantes | Sección retirada de la portada por ahora (`TeamSection` sigue en el código). Volver a mostrarla cuando haya nombres, funciones y fotos **con autorización**. |
| Logros | Incorporados desde el informe del club (`achievements.json`). Cifras no respaldadas (p. ej. «17 medallas») no se muestran. |
| Historia | Cronología y fuentes incorporadas (`history.json`). Pendiente: fotos históricas. |
| Participación de la UVa | Torneos donde juegan personas de la UVa (`uva-torneos.json`), con nº de jugadores y nombres autorizados. |
| Correo y redes | Instagram @uva_bad añadido (contacto y pie). Falta el correo oficial del club en `club.json › email` (mientras esté vacío no se muestra). |
| Formulario | Envía por correo a pablitocastaneda06@gmail.com mediante FormSubmit. **Hay que pulsar «Activate Form» en el correo de activación** (una sola vez). Para cambiar de destinatario: `VITE_CONTACT_ENDPOINT`. |
| Textos legales | Versión de prueba redactada (aviso legal, privacidad, cookies). Faltan los datos del titular en `club.json › legal` (titular, NIF, domicilio, correo, contacto de protección de datos) y una revisión por la Universidad o un asesor jurídico. |
| Servidor | Alojarlo (Fly.io/VPS con disco), `ADMIN_TOKEN`, claves VAPID, `VITE_API_URL` en la web. |
| Lectura en directo | Activada por defecto. El `robots.txt` de badminton.es excluye esas rutas; el club asume la decisión. Se recomienda la autorización de la FESBA (`docs/SOLICITUD-AUTORIZACION.md`). |

## Antes de publicar

1. **Logotipo UVa:** se usa el archivo facilitado (`public/images/logo-uva.png`, 554×554 px, sin modificar).
   Confirmar con la Universidad las condiciones de uso de la marca y, si es posible, sustituirlo por la
   versión vectorial oficial de https://imagencorporativa.uva.es/.
2. Sustituir todo el contenido provisional (imágenes, torneos de ejemplo) y completar los textos legales.
3. Activar y probar el formulario con el correo de destino real.
4. Elegir dominio y hosting (con reescritura a `index.html` para todas las rutas) — no se ha publicado nada.
5. Revisión final de accesibilidad con el contenido definitivo.

## Notas de diseño

- Referencias de estética y estructura: web del Club Bádminton Burgos (cabecera, hero con imagen oscurecida,
  bloques de estadísticas, tarjetas) y composición de noticias de portales deportivos. No se han
  copiado textos ni lemas.
- Los datos provisionales se marcan siempre con la etiqueta discontinua "Provisional" / "Pendiente".

## Detección de cambios en badminton.es

badminton.es no avisa cuando publica algo, así que el servidor lo detecta con lecturas baratas y, al verlo, adelanta lo que depende de ello (`SyncEngine.kick`, mínimo 2 min entre lecturas adelantadas de lo mismo, `KICK_MIN_GAP_MINUTES`):
- Un partido que acaba de terminar (orden de juego, cada 3 min en jornada) → se leen ya los cuadros y clasificaciones.
- La lista de jugadores de un torneo cercano cambia (huella `listHash`; se mira cada 30/15/10 min según lo cerca que esté, `WATCH_LIST_*_MINUTES`) → se vuelven a leer ya las listas de cada prueba (admisión, cabezas de serie).
- El torneo cambia de fechas o jornadas → se releen cuadros e inscripciones.
- Comprobado de extremo a extremo (`server/tests/endToEnd.test.ts`): un resultado nuevo en badminton.es llega al navegador por el flujo de avisos y el estado público en ≈ 3 min (lectura cada 3 min + segunda lectura de confirmación 45 s después; `CONFIRM_GAP_SECONDS`), y los cuadros se releen justo después. En una jornada de 8 h con un partido terminado cada 8 min el servidor hace ≈ 50 lecturas/hora (el espaciado de 2,5 s permitiría 1440).
- Arranque más rápido: el servidor abre el puerto lo primero (responde `/api/health` con `starting:true` y 503 «reintenta» al resto) mientras restaura la base desde Upstash; el contenedor arranca con `node --import tsx` (sin `npx`). En local: listo en ≈ 0,5 s. La espera de Render al despertar del plan gratuito (~30-60 s) y la del despliegue (CI + construcción) no dependen del código; el aviso de keepalive de cron-job.org evita que se duerma.
- `/api/health` devuelve por defecto una respuesta pequeña (< 1 KB): cron-job.org marcaba «Fallido (salida demasiado grande)» con la completa (4,4 KB). El diagnóstico completo, con la lista de torneos, está en `/api/health?full=1` (lo usa el agente Mantenedor).

## Trayectoria del club (Directo, al final de la página) — vista mensual desde enero de 2025
- Gráfica con los partidos ganados por los jugadores públicos de la UVa en cada torneo (barras) y el total acumulado en el tiempo (línea), con medallas (oro/plata/bronce), cifras (ganados, perdidos, torneos con medalla, oros), tooltip, tabla accesible y deslizable en móvil (`src/components/live/TrajectoryChart.tsx`).
- Datos: el servidor calcula `record` por torneo (`uvaRecord` en `server/src/results.ts`: grupos + cuadros finales, sin «pasa directo»).
- Histórico: una sola lectura de los cuadros de cada torneo ya terminado de los últimos `BACKFILL_DAYS` (400) días, un torneo cada 10 min como mucho y solo cuando no hay ningún torneo en juego, para que la gráfica arranque con la temporada y no solo desde ahora.
- Vista mensual desde enero de 2025 (`START` en `TrajectoryChart.tsx`) hasta el mes actual: barras = partidos ganados en el mes, línea = acumulado, punto de color = mes con medalla. Los meses sin datos se marcan como «Sin datos publicados».
- Fuentes: (1) torneos del servidor con cuadros leídos (`record`), (2) histórico por perfil oficial: el servidor lee una vez al día `/profile/matches.aspx` de cada persona pública (≈ 100 últimos partidos, ≈ 2 temporadas; un partido de dobles cuenta una vez; la Liga Nacional se excluye; `HISTORY_ENABLED=false` lo desactiva) y lo publica como `history`; (3) `src/data/trayectoria.json` (`entradas: [{date, name, won, lost, gold, silver, bronze}]`) para que el club aporte a mano temporadas anteriores.
- Límite real: badminton.es solo publica en los perfiles las últimas ~2 temporadas, por eso la gráfica empieza en enero de 2025; para ampliarla hacia atrás, cambiar `START` y completar `trayectoria.json` con datos del club.

## Imagen de «compartir torneo»: jornada por horas con rivales
- La tarjeta del torneo lista todos los partidos de la jornada por hora (los terminados con V/D y marcador, el que se juega como AHORA, los pendientes con hora estimada) y el rival con **nombre y primer apellido** (`server/src/shareRivals.ts`), con el consentimiento expreso del club (Pablo, 22/10/2026).
- Desde el 24/10/2026, por decisión del club, los rivales también salen en la web, la API pública, Directo, Inicio, las imágenes, las capturas del itinerario y los avisos push (`PUBLIC_OPPONENTS=names` por defecto; `none` los oculta). Siempre nombre y primer apellido (`shareRivals.ts › nameAndFirstSurname`) y en los cuadros solo los rivales de gente del club; nunca en pruebas o torneos de menores (`rivalVisible`).
- Salvaguardas: no se nombra a rivales de pruebas de menores (Sub-xx, infantil, juvenil… en el nombre de la prueba) ni en torneos solo de menores (`SHARE_RIVAL_YOUTH=true` lo permite); `SHARE_RIVAL_NAMES=off` lo quita del todo. El texto de privacidad lo recoge.

## Imágenes para Instagram por correo (agente Publicista)
- Las tarjetas llevan el logotipo oficial de la UVa (`server/src/assets/logo-uva.png`). La tarjeta del torneo, en la víspera y sin orden de juego, lista a las personas del club con prueba, nivel y cabeza de serie.
- Dos tareas programadas envían por correo (FormSubmit) los enlaces de las imágenes (cuadrada 1080×1080 y vertical 1080×1920 para stories) y un pie de foto propuesto: **Publicista · Previa** (cada día a las 18:00, solo si mañana empieza un torneo con jugadores del club) y **Publicista · Resultados** (domingos a las 22:00, torneos del fin de semana con resultados).

## Autocorrección de la estimación de horas (`server/src/calibration.ts`)
- El modelo base (`estimate.ts`) se mide en cada jornada terminada (registro de acierto). Si de forma sistemática llega pronto o tarde, la hora publicada se corrige en sentido contrario: desvío mediano de las jornadas medidas × n/(n+4), con mínimo de 3 jornadas y topes de ±20 min (fin) y ±8 min (inicio). Se registra siempre la estimación en bruto, así que corregir no falsea el aprendizaje.
- `/api/public/accuracy` incluye `calibration` (`endMin`, `startMin`, `days`) con el desvío aplicado. Hasta tener 3 jornadas terminadas con estimaciones guardadas es 0.
- Probado en el banco con 11 jornadas reales: añadir regresión por fase de torneo, o dar más peso a los últimos partidos al medir el ritmo, no mejoró (la duración apenas cambia entre grupo y cuadro final: 28,7 vs 29,1 min), por eso no se añadieron.

## Patrones de seguimiento: la estimación aprende de cada torneo (`server/src/patterns.ts`)
- Al terminar una jornada con estimaciones guardadas se guarda su **patrón** (tabla `day_patterns`, solo cifras anónimas): partidos, jugados, W.O., duración por prueba (n, suma y logaritmos), ritmo frente a lo habitual, retraso medio sobre el horario, pistas, fin real frente a la última hora programada, error de la hora de fin a 120/60/30 min con la anchura del margen, y sesgo de inicio a 30 min. No se borra con el registro de estimaciones (que se limpia a los 60 días), así que se aprende de todo el histórico.
- **Valores de partida aprendidos** (`learnedPriors`): desde 3 jornadas (≥20 partidos jugados cada una) la duración media de cada prueba, la proporción de W.O., la dispersión (`cv`) y la variación del ritmo entre torneos (`paceTau`) se reajustan mezclando lo de fábrica (medido en 1.299 partidos) con lo observado, con pesos prudentes (150 partidos por prueba, 300 para W.O. y dispersión). Lo que no se ha visto no se toca. Se usan en cada recálculo de la estimación.
- **Calibración** (`calibration.ts`), ahora sobre los patrones: además del desvío de fin/inicio, aprende `spread`, el factor que ensancha o estrecha el margen probable para que acierte ≈80 % (el factor más pequeño, entre 0,75 y 1,5, que cubre el 80 % ya corregido el sesgo, reducido por n/(n+4)). Se sigue registrando la estimación en bruto, así que corregir no falsea el aprendizaje.
- `/api/public/accuracy` incluye `learning`: nº de patrones, jornadas y partidos de los que aprende, valores de fábrica frente a aprendidos, y el patrón de cada jornada en orden cronológico. El informe del **Agente Estadístico** (sáb/dom 21:00) añade una sección de seguimiento: tabla por jornada, si el error baja con los torneos, qué ha cambiado en los valores de partida, estado del margen y patrones repetidos.
- Con menos de 3 jornadas guardadas todo queda como antes (valores de fábrica, sin corrección).

## Directo: panel «Siguiente partido de la UVa»
- Arriba de Directo (`src/components/live/NextMatch.tsx`): partidos que van antes (`ahead`, de cualquiera, sin W.O. ni los ya empezados; lo calcula el servidor en `publicView.ts › addAhead` con el orden estimado), tiempo estimado hasta que empiece (se actualiza cada 30 s), hora oficial, hora estimada con su diferencia, y partidos que quedan por jugar hoy en el torneo. Las horas estimadas salen del modelo estadístico, que se mide y se corrige solo (ver «Patrones de seguimiento»).

## Captura del itinerario en vivo por correo (`server/src/itinerary.ts`)
- Dos formatos: **historias** (páginas verticales 1080×1920; si hay muchos partidos se reparten en varias, con la hora repetida al empezar página) y la versión ancha como la web. El correo lista los enlaces de cada página de historia y el de la ancha.
- 15 min antes del primer partido del día de cada torneo con jugadores públicos del club (`ITINERARY_MINUTES_BEFORE`), el servidor dibuja la sección «Partidos por horas» de Directo como imagen (horas, tarjetas con estado, marcadores, EST, línea de «ahora») y la guarda en la tabla `captures` (una por torneo y día; se borra a los 30 días). Se comprueba cada minuto; ventana de envío: de 15 min antes a 30 min después, por si el servidor se reinicia.
- El correo (asunto fijo «HISTORIAS RRSS DIRECTO TORNEOS JORNADA»; el torneo va en el texto; FormSubmit, a `ITINERARY_EMAIL`, por defecto pablitocastaneda06@gmail.com; `off` lo desactiva) lleva el enlace `/captura/<id>.png` de la imagen congelada y el de Directo. FormSubmit no admite adjuntos: es un enlace, igual que el Publicista. Solo datos públicos, sin rivales.

## Inicio: «Así vamos en los torneos» (`src/components/home/LiveNow.tsx`)
- Encima de las noticias, una tarjeta por cada torneo que se juega hoy con jugadores del club (varios a la vez si coinciden): quién juega ahora, los próximos con hora estimada, el balance de hoy (victorias/derrotas), partidos que quedan y avance del torneo con fin estimado. Enlaza a Directo con ese torneo (`/directo?torneo=<id>`).
- Se quita sola cuando el torneo acaba (último día y todos los partidos terminados, o la estimación del servidor lo da por terminado), si sus datos están desactualizados o si no hay torneos en juego. Lógica en `src/lib/live.ts` (`liveTournaments`, `summarize`).

## Tarjeta «Medallas confirmadas» (compartir resultados)
- La imagen de resultados (cuadrada y vertical; la panorámica sigue siendo lista) usa la plantilla «MEDALLAS CONFIRMADAS»: fondo de pabellón, logotipo, un panel por oro/plata/bronce con la prueba, quién y el marcador de la final («Semifinal» en el bronce), el total y el volante. Las parejas con alguien de otro club salen como «(con Nombre Apellido)» (misma norma que los rivales). Si hay muchas medallas, las filas se comprimen y se resume el resto («+N medallas más»). Código: `podiumSvg` en `server/src/share.ts`.

## Medidor de fin de torneo: revisión del 24/10/2026 (partidos fantasma)
- **Fallo hallado:** al revisar los torneos del sábado, el medidor no los daba por terminados (Estella: 214 partidos en el servidor frente a 173 publicados por la federación; Viladecans 263 frente a 185; Utrillas 123 frente a 101; TOP Máster 101 frente a 90). Los sobrantes eran partidos que la fuente dejó de publicar (cambian de clave al asignarse jugadores, se suspenden o se reordenan) y que quedaban «por jugar» para siempre: la hora estimada de fin seguía en el futuro, el torneo no se cerraba, su acierto no se medía y el panel de Inicio no se quitaba.
- **Arreglo** (`engine.ts › readDay`): en cada lectura del orden de juego se retiran los partidos pendientes que ya no figuran (y los «en pista» sin ver en 30 min). Red de seguridad (`estimate.ts`): jornada abandonada = nada en pista y sin actividad en 2 h, con todos los pendientes programados hace más de 1 h → se da por terminada a la hora del último partido.
- **Cierre en todos los torneos** (24/10, segunda pasada): (1) cada 5 min el motor recalcula con lo ya guardado el último día de todo torneo que no figure como terminado (`sweepEstimates`), sin pedir nada a la federación; (2) un día anterior que quedó «por jugar» se publica ya como terminado, con la hora del último partido visto (`closeIfOver` en `publicView.ts`) y con `total = terminados`; (3) los partidos del club pendientes que la fuente deja de publicar se retiran también de la tabla `matches` (antes seguían como «siguiente partido»); (4) al arrancar, las estimaciones se recalculan por fecha para que la guardada de cada torneo sea la del último día.
- **Migración única** (`patterns.ts › purgeGhostEra`, clave `ghostfix`): las estimaciones guardadas hasta ese día estaban infladas por los fantasmas (errores de fin de +50…+100 min), así que se descartan junto con los patrones, para que el modelo no «aprenda» ese sesgo. El acierto se mide desde la siguiente jornada.
- **Optimización con datos nuevos:** 3 jornadas más en `tests/data/real-days.json` (ya son 14, 1.522 partidos jugados). Los valores de partida apenas cambian (IM 28,7 · IF 26,2 · DM 31,5 · DF 31,1 · DX 29,1 · cv 0,326 · W.O. 7,6 % · ritmo 7,1 %), y se actualizaron. Barrido de `endQuantile`, `startQuantile`, `changeoverMin` y `spread` con validación dejando uno fuera: error de fin 15,9 min; la mejor combinación (cambio de pista 4 min) sube solo un 2,2 % (<3 %) y empeora la hora de inicio, así que **no se cambia** (regla del agente Estadístico). El margen probable acierta el 80 % (objetivo). Las mejoras que sí aplican llegan solas con el aprendizaje de cada jornada (ver «Patrones de seguimiento»).

## Directo: «A qué hora juega cada jugador de la UVa» (`src/components/live/PlayerTimes.tsx`)
- Arriba de Directo, una tarjeta por torneo (todos los que tienen partidos de hoy en adelante, no solo el seleccionado) y, dentro, cada jugador con sus partidos ordenados por hora: la hora estimada (EST) con la oficial al lado cuando difiere, «desde HH:MM» si hay hora más temprana posible, la pista, el rival, «AHORA» si está en juego y el resultado si ya terminó. Los dobles salen bajo cada persona del club.
- Se refresca con los datos en directo (cada minuto con partidos hoy, y al avisar el servidor) e indica la hora de la última actualización y la última lectura de cada torneo. Lógica en `src/lib/live.ts › playerSchedule` (días pasados fuera; torneos por fecha).

## Torneos de esta semana: lectura más rápida (02/11/2026)
- Para un torneo con gente del club que empieza en ≤ 7 días (`DAY_LOOKAHEAD_DAYS`), el orden de juego se lee ya (antes, solo desde 3 días antes) y cada 10 min (`NEAR_DAY_MINUTES`); el día antes, cada 5 min. Cuadros cada 15 y 10 min, información cada 20 y 15, inscripciones cada ≤ 30 min y, si aún no hay cuadros, se mira cada 30 min (antes 2 h). Sin nadie del club el comportamiento es el de siempre. El ritmo sigue respetando ≥ 2,5 s entre peticiones.
- La web se refresca cada 2 min cuando hay partidos de la UVa pendientes en los próximos 7 días (cada minuto el día de juego, cada 5 min sin nada cerca), y al instante cuando el servidor avisa de un cambio.

## Previa del finde por correo (`server/src/weekendPreview.ts`)
- Cada jueves a las 15:00 (Madrid), el servidor envía a `WEEKEND_PREVIEW_EMAIL` (por defecto pablitocastaneda06@gmail.com; `off` lo desactiva) un correo por cada torneo con jugadores de la UVa que empieza en 1-4 días: el primer partido del club, el primer partido de cada jugador por orden de hora (estimada y oficial, prueba, pista, rival y «con quién» en dobles) y cuántos más tiene programados. Si aún no hay orden de juego, lo dice y lista a los inscritos.
- Se comprueba cada minuto y vale hasta 3 h después de las 15:00 (por si Render reinicia); una sola vez por torneo (`kv weekend-preview:<torneo>:<fecha>`, visible en `/api/health?full=1 › mail`). Día y hora configurables (`WEEKEND_PREVIEW_WEEKDAY`, `WEEKEND_PREVIEW_HOUR`). FormSubmit: la dirección debe estar activada (ya lo está para el Publicista).

## Homónimos: el perfil oficial decide (05/11/2026)
- Fallo: en Guadarrama figuraba «Javier Gonzalez» (otro club; perfil oficial distinto del de nuestro Javier González Martín) y se asoció por nombre corto: salían partidos, resultados y una noticia automática que no eran del club.
- Una primera corrección demasiado agresiva (borrar toda asociación por nombre corto) se llevó también a jugadores legítimos (Eduardo en Estella, Cantabria…): muchos cuadros oficiales traen nombres sin segundo apellido y sin club. Se rehízo así:
  - Un participante asociado por nombre corto (el oficial es más corto que el de la lista), sin club de la UVA, queda «por verificar» (`engine.ts › suspectEntrants`).
  - El trabajo `verify` lee la ficha de ese participante en el torneo y compara su **perfil oficial** con el de la persona de la lista: si es otro, es un homónimo y se retira su vínculo, sus partidos e inscripciones (`unlinkEntrant`, queda anotado en `verified:<torneo>:<id>` y no se vuelve a asociar); si coincide o no se puede comprobar, se deja.
  - Reconstrucción: lo asociado de nuevo en la primera pasada tras el cambio se marca (`needs-rebuild`) y, si el torneo terminó hace ≤ 30 días, se releen sus días una vez (`rebuilt:`) para recuperar los partidos borrados.
- Pruebas en `tests/homonyms.test.ts`.

## Resultados del finde por correo (`server/src/weekendResults.ts`)
- Cada domingo a las 15:00 (Madrid) el servidor envía a `WEEKEND_RESULTS_EMAIL` (por defecto pablitocastaneda06@gmail.com; `off` lo desactiva) un correo por cada torneo del fin de semana con jugadores de la UVa y algún partido jugado: balance del club, medallas, otras pruebas, partido a partido por jugador (con rival y pista) y un **mensaje listo para redes** (el pie de foto de `social.ts`, versión corta para stories y enlaces a las imágenes cuadrada y vertical). Si el torneo sigue en juego lo avisa como provisional.
- Se comprueba cada minuto, vale hasta 3 h después de las 15:00 y se envía una sola vez por torneo y día (`kv weekend-results:…`, visible en `/api/health?full=1 › mail`). Día/hora configurables (`WEEKEND_RESULTS_WEEKDAY`, `WEEKEND_RESULTS_HOUR`). Depende de FormSubmit: si está caído (05/11 dio error 522 durante horas), no sale; se recomienda un respaldo (ver abajo).

## Suscripciones por correo: «Sigue al club» (06/11/2026)
- Sección en Inicio (`src/components/home/FollowSection.tsx`, ancla `#sigue`): correo + todo el equipo o jugadores concretos + casilla de consentimiento (con campo trampa anti-robots). Servidor: `server/src/subscribers.ts` (alta, confirmación, baja; tokens HMAC; doble confirmación), `updates.ts` (avisos de torneo: UN correo a media jornada y UNO al final por torneo con quién juega, contra quién y si ganan; agrupados si coinciden varios; máx. 2 al día por persona, de 9:00 a 23:00; tabla `subscriber_mails` evita repetir). **Avisos importantes** (`keyEvents`): a quien sigue a jugadores concretos se le avisa, una sola vez por hecho y mientras el torneo está en juego, de que un jugador queda eliminado de una prueba, llega a la final o gana/queda en el podio (tope 3 correos distintos al día; si el torneo termina, va en el correo final), `mailer.ts` (Brevo o Resend por API). Rutas: `GET/POST /api/public/subscribe`, páginas `/suscripcion/confirmar` y `/suscripcion/baja` (con botón; POST = baja con un clic).
- Activado el 06/11/2026 con Brevo (`MAIL_PROVIDER`, `BREVO_API_KEY`, `MAIL_FROM` en Render; el bloqueo de IP de Brevo hay que tenerlo desactivado porque Render no tiene IP fija). Guía en `docs/CORREO_SUSCRIPCIONES.md`; el diagnóstico está en `/api/health?full=1 › mailConfig`. Los correos automáticos al club (previa del jueves, resultados del domingo, capturas del itinerario) usan también este proveedor si está configurado y, si no, FormSubmit (`notify.ts`). Texto legal actualizado.

## Cambio de nombre de la cuenta de GitHub (22/10/2026)
- La cuenta pasó de `Pablo06Casta` a `badmiton-uva`: la web está ahora en https://badmiton-uva.github.io/UVa-b-dminton/ (la dirección antigua da 404) y Web-cerca en https://badmiton-uva.github.io/PABLO-APP/.
- El servidor autoriza siempre las dos direcciones (`CLUB_ORIGINS` en `server/src/config.ts`); antes solo la antigua y por eso la web nueva no recibía noticias ni datos en vivo.
- Pendiente del dueño: en Render, `SITE_URL=https://badmiton-uva.github.io/UVa-b-dminton` y `CORS_ORIGINS=https://badmiton-uva.github.io` (los enlaces de compartir usan `SITE_URL`).

## Crónicas de torneos con IA y aprobación por correo (`server/src/chronicle.ts`)
- Al terminar un torneo con resultados del club, el servidor pide a la API de Anthropic (`ANTHROPIC_API_KEY`, modelo `CHRONICLE_MODEL`, por defecto claude-sonnet-5-5) una crónica corta solo con datos públicos (jugadores con consentimiento, resultados, medallas, balance; nunca rivales). Se descarta si trae cifras que no están en los datos.
- El borrador se envía por FormSubmit a `CHRONICLE_EMAIL` con un enlace `/aprobar-cronica/<torneo>?code=…` (código secreto por borrador, guardado con hash). Sin aprobar, la noticia sigue con el texto de plantilla. Al pulsar «Publicar», la crónica sustituye título, resumen y cuerpo de la noticia automática de ese torneo (campo `body`).
- Sin `ANTHROPIC_API_KEY` o sin `CHRONICLE_EMAIL` la función está apagada. Revisión cada 15 min; un torneo se redacta una sola vez. Aparece en el texto de privacidad (Anthropic como encargado).
- Tarjeta de resultados con podio (formatos cuadrado y vertical, solo si hay medallas): titular «EL TALENTO UVA SUBE AL PODIO», podio 2-1-3 con el nombre y la prueba de cada medallista (parejas en dos líneas), «+N medallas más» si hay más de tres, fondo claro con pista y volante, y llamada a la acción. Sin medallas o en panorámico se mantiene la lista.

## Paquete para redes (`GET /api/public/social?when=previa|resultados`, `server/src/social.ts`)
- El servidor calcula solo qué toca publicar (torneos de mañana con gente del club, o torneos jugados el fin de semana con resultados) y devuelve imágenes (generadas por el propio servidor, sin leer la web ni usar generadores externos), pie de foto de partida con datos reales, versión corta, jugadores (nombre y primer apellido), medallas y si los resultados son provisionales.
- Las tareas programadas «Publicista · Previa» y «Publicista · Resultados» usan este paquete como base y lo envían por correo mejorando el texto.

## Sección LIGA (`/liga`, `server/src/liga.ts`, `ligaParse.ts`)
- Liga Nacional de Clubes, división Primera PLATA (donde juega el CD Universidad de Valladolid en 2026-27): clasificación, jornadas con sus encuentros (fecha, hora, resultado, enlace al acta en badminton.es), calendario del club y lista de clubes. El club se marca en amarillo.
- El servidor busca solo la última edición («Liga Nacional de Clubes edición 2026-2027») en el buscador de badminton.es una vez al día y lee la división (`LIGA_DIVISION`, por defecto «plata»; `LIGA_TOURNAMENT_ID` fija una edición a mano; `LIGA_ENABLED=false` lo apaga). Cadencia: cada 5 min el día de jornada, cada hora si hay encuentros en los próximos 3 días, cada 12 h el resto.
- Endpoint `GET /api/public/liga` (con ETag). La web lo pide al abrir y se renueva sola (1 min en día de jornada, 5 min si no).
- Estado a 23/10/2026: edición 2026-27 publicada con 12 clubes y 66 encuentros en 11 jornadas, sin fechas ni resultados; la web lo indica y se rellena sola.
- Dirección de la sede (`club.json`): Universidad de Valladolid (UVa) · Calle Ruiz Hernández, Valladolid (se muestra en Contacto y en el aviso legal como «Sede del club»).

## Sección «Nuestros jugadores» (Inicio, `PlayersSection.tsx`)
- Lista a las personas públicas del servidor (consentimiento) con tarjeta (foto o silueta, nombre, función, categoría) y sus medallas de los torneos leídos (las parejas cuentan para las dos personas). Para poner foto, función o información: añadir la ficha en `src/data/players.json` (`{ id, name, role, photo: "/images/jugadores/nombre.webp", info, consent: true }`) y subir la foto a `public/images/jugadores/`; se une por nombre con el del servidor.
