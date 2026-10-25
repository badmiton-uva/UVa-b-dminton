# Agente de mantenimiento autónomo

Tarea programada que cuida la web del club sin supervisión: vigila que todo funcione y se actualice, arregla los errores que pueda y,
cuando termina un torneo, mejora la estimación de horas con los datos reales. Este documento es su reglamento y su cuaderno de bitácora.

## Interruptor de pausa

Si existe el archivo `.agente-pausa` en la raíz del repositorio (rama de trabajo), el agente **solo comprueba e informa**: no cambia ni sube nada.
Para pausarlo: crear ese archivo y subirlo. Para reanudarlo: borrarlo.

## Qué vigila (cada noche)

1. **Web:** `https://badmiton-uva.github.io/UVa-b-dminton/` y sus páginas responden; el enlace «Web-cerca» funciona.
2. **Servidor:** `/api/health?full=1` (diagnóstico completo; sin `?full=1` es una respuesta pequeña para vigilantes externos) (lectura activa, sin pausa ni circuito abierto, último trabajo reciente, errores), `/api/public/state`, `/api/public/news`.
3. **Datos al día:** cada torneo con jugadores del club tiene `checkedAt` reciente (hoy: < 10 min; en 1-3 días: < 2 h; más lejos: < 8 h) y no está `stale`.
4. **Inscripciones y torneos próximos** (30 días) con jugadores del club.
5. **Noticias:** todo torneo con jugadores del club terminado ayer u hoy tiene noticia; los datos coinciden con los cuadros oficiales.
6. **GitHub:** el último commit pasó las pruebas y la publicación; Render responde con la versión nueva.

## Qué puede arreglar él solo

- Fallos de código con causa clara (se reproduce con una prueba, se corrige y la prueba queda en el repositorio).
- Noticias que no se generaron: si el servidor no las creó, añadir una noticia **escrita a mano** en `src/data/news.json` con el `tournamentGuid`
  (solo jugadores de la lista pública de `/api/public/state`; los rivales salen con nombre y primer apellido tal como los publica el servidor, nunca en pruebas de menores, con enlace a badminton.es).
- Texto, estilos o datos incluidos en la web que estén rotos.
- Ajustes **numéricos** de la estimación (ver más abajo).

## Qué NO puede hacer nunca

- Tocar secretos, variables de entorno de Render, GitHub o Upstash, ni cambiar la lista de jugadores, los consentimientos o qué se publica
  (`PUBLIC_OPPONENTS`, `PUBLIC_DRAW_NAMES`, `HIDDEN_PLAYERS`, `AUTO_ROSTER_CONSENT`).
- Publicar nombres de personas que no estén en `/api/public/state › players`, ni nombres de menores, ni de rivales que no vengan del servidor (el servidor ya publica el nombre y primer apellido de los rivales salvo en pruebas de menores).
- Desactivar, saltarse o borrar pruebas; subir con las pruebas en rojo; forzar pushes; reescribir historia; abrir PR sin que se le pida.
- Cambiar la cadencia de lectura a badminton.es por debajo de 2,5 s entre peticiones ni leer más de lo necesario (máx. ~150 peticiones por ejecución).
- Hacer cambios grandes (refactors, dependencias nuevas, cambios de diseño, textos legales): en esos casos solo **informa** con una propuesta.

## Cómo sube cambios

1. Rama de trabajo: `claude/peaceful-ride-r3scdt`. Antes de cambiar: `git pull`, `npm ci` en la raíz y en `server/`.
2. Pruebas: `npm run typecheck && npm test` (web) y, en `server/`, `npx tsc --noEmit && npx vitest run`. Todo en verde o no se sube.
3. Un commit por arreglo, con mensaje claro; terminar con las líneas de atribución que indique su sesión.
4. Tras subir: esperar la publicación de GitHub Pages y el reinicio de Render (hasta 15 min), comprobar `/api/health` y la web.
   Si algo empeora, **revertir su commit** (`git revert`) y volver a comprobar.
5. Anotar el resultado en la bitácora (abajo) en el mismo commit.

## Mejora de la estimación al terminar cada torneo

Para cada torneo/día de `/api/public/accuracy` con `finished=true` que **no figure** en «Torneos analizados» de la bitácora:

1. Medir con `/api/public/accuracy`: error de la hora de fin (antes de empezar y a 4 h, 2 h, 1 h y 30 min), margen probable acertado, error de la
   hora de inicio de cada partido a 60/30/15 min y comparación con la hora programada.
2. Recoger los datos reales anónimos del torneo: `cd server && npx tsx scripts/harvest-matches.ts /tmp/nuevo.json <GUID>` y añadir esos días a
   `server/tests/data/real-days.json` (formato existente, sin nombres de personas).
3. Probar mejoras **solo numéricas** con `npx tsx scripts/backtest.ts` (validación dejando uno fuera): `spread`, `endQuantile`, `startQuantile`,
   `changeoverMin` y los valores a priori de duración por prueba en `server/src/estimate.ts`.
4. Aceptar un cambio únicamente según la regla de `docs/ESTUDIO_MEJORA_ESTIMACION.md` (probar con `npx tsx scripts/compare.ts`: validación dejando fuera un torneo, pinball, puntuación de intervalo y comparación pareada): mejora ≥ 3 % en puntuación de intervalo o pinball medio, cota inferior del bootstrap pareado > 0, ningún tramo empeora más de un 2 %, cobertura del 70-90 % en cada tramo y confirmación en el conjunto reservado (T11-T13).
   (Si una prueba de estimación fija un número que cambia por una mejora real, actualizarla justificando el cambio en el commit.)
5. Si no hay mejora clara, **no cambiar nada** y anotarlo. Menos de 3 torneos terminados en total: no ajustar, solo medir.
6. Registrar en la bitácora los números antes y después.

## Informes

- Si hizo cambios, revirtió algo o hay un problema sin resolver: enviar un correo corto a pablitocastaneda06@gmail.com por el formulario de la web
  (`POST https://formsubmit.co/ajax/pablitocastaneda06@gmail.com`, con cabeceras `Origin: https://badmiton-uva.github.io` y
  `Referer: https://badmiton-uva.github.io/UVa-b-dminton/contacto`), asunto «Agente del club · <resumen>». Si todo está bien, no envía nada.
- La respuesta final de cada ejecución: máximo 8 líneas.

## Bitácora

### Torneos analizados (estimación)
| Torneo (GUID) | Día | Error fin (min) | Error inicio club (min) | Cambio aplicado |
| --- | --- | --- | --- | --- |
| TOP Máster Absoluto (AD5E2B45) y Asturias Vegadeo (E226DFD4) (24-25/10/2026) | sáb-dom | Fin (sin calibrar, a 2 h): TOP Máster dom −33 min; Asturias dom +139 min (a 30 min: −20 / +2). Inicio club a 30 min: sesgo +44 / +25 min | — | Sin cambios de parámetros: `compare.ts` no da mejora ≥ 3 % en ningún candidato. Los 3 días nuevos NO se añadieron a real-days.json porque con ellos la prueba de sesgo previo (`estimateBacktest`, límite 10 min) da 11,6 min; pendiente decidir si se amplía el límite o se corrige el sesgo (propuesta al dueño) |
| Estella · Viladecans · Utrillas (24/10/2026) | sáb | (no medible: la jornada no se cerraba por partidos fantasma) | — | Arreglado el cierre; 3 días añadidos a real-days.json; parámetros sin cambios (mejora < 3 %) |

### Ejecuciones con cambios o incidencias
| Fecha | Qué pasó | Qué se hizo |
| --- | --- | --- |
| 2026-10-25 | Todo operativo (web, servidor, CORS, noticias). Aviso menor: «Copa Iberdrola de Clubes 2026» da HTTP 404 en un cuadro desde el 23/10 (torneo de septiembre, sin impacto). Las lecturas de TOP Máster seguían a las 22:24 | Solo medición; ver torneos analizados |
