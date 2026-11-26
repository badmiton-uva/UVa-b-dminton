# Publicación en Instagram (@uva_bad): procedimiento

Estado a 26-11-2026. Lo siguen las tareas programadas «Panel redes: peticiones y publicaciones programadas» (en punto) y «Panel redes: publicaciones programadas (y media)» (a y media). Solo se publica lo que el usuario dejó en **Aprobada** con día y hora en el panel (artefacto 76d42d80-b8b8-4c1b-97ef-a636eae2419d). Probado: story publicada desde GitHub el 22-11 y el 26-11 (Instagram acepta las URL raw.githubusercontent.com).

**Dónde están los archivos del procedimiento.** Las tareas programadas NO tienen la herramienta Projects. Todo vive en la rama `redes-media` del repo `badmiton-uva/UVa-b-dminton`, carpeta `claude/`: este documento, `render-story.html`, `render_story.py` y `registro-piezas-redes.md`. La copia del proyecto UVA BAD en claude.ai es solo de consulta; si se cambia una, hay que cambiar la otra.

## Datos de cada pieza (colección `piezas` de la base del artefacto)
- `tipo`: Story (1080x1920), Post (1080x1350, 4:5) o Carrusel (1080x1350, 2 a 10 diapositivas).
- Story y Post: `datos`, `ajustes`, `foto_id` (o `fondo_img`), `dia_filtro` en la propia pieza.
- Carrusel: lista `slides`, cada una con `datos`, `ajustes`, `foto_id`/`fondo_img`, `dia_filtro`.
- `pie_texto`: pie de foto de Post y Carrusel (las stories no llevan texto).
- Las fotos están en la colección `fotos` (documento con campo `data`: JPEG en base64 como data URL). `foto_id` es el id del documento.
- Estados: Borrador, Solicitud, Aprobada, Publicando (reclamada por una ejecución), Publicada. `aviso` guarda el motivo de un fallo.

## Alojamiento público del JPG
- Repo público `badmiton-uva/UVa-b-dminton`, rama **`redes-media`** (solo imágenes y esta carpeta `claude/`; no activa el despliegue de la web).
- Ficheros en `redes/<id-pieza>-<n>-<AAAAMMDDHHMM>.jpg`. Las comprobaciones, `redes/comprobacion-<AAAAMMDDHHMM>.jpg`.
- URL pública: `https://raw.githubusercontent.com/badmiton-uva/UVa-b-dminton/redes-media/redes/<archivo>.jpg`
- Para escribir: el repo debe estar en la sesión (add_repo con acceso push, o ya clonado). Clona la rama: `git clone --depth 1 -b redes-media https://github.com/badmiton-uva/uva-b-dminton <carpeta>`; commit y `git push origin redes-media` (con `-c push.negotiate=true` si hace falta).
- El shell no puede leer raw.githubusercontent.com: comprueba que el archivo existe con `gh api "repos/badmiton-uva/UVa-b-dminton/contents/redes?ref=redes-media"` (debe salir con el tamaño esperado; un «JPG» de unos cientos de bytes es texto, no imagen).

## Generar cada JPG igual que la previa del panel
1. Por cada diapositiva escribe un `pieza.json`: `{"alto":1920|1350,"datos":{...},"ajustes":{...},"fondo_img":"<data URL de la foto, si hay>","dia_filtro":""}` (alto 1920 para Story, 1350 para Post y Carrusel; la foto se lee de `fotos/<foto_id>`.data).
2. Usa `claude/render-story.html` y `claude/render_story.py` de la rama clonada (déjalos juntos con esos nombres).
3. `python3 -I claude/render_story.py pieza.json salida.jpg` (Chrome sin interfaz + Pillow; sale 1080 x alto, RGB, calidad 92). Si falta `google-chrome`, el render falla: no improvises con otro método, avisa.
4. Abre cada imagen y revísala (Read): texto sin cortar ni solapado, menos de 8 MB. Fuente: Anton si Oswald no está instalada.

## Publicar (conector Windsor, cuenta Instagram uva_bad id 17841454032545298, acción por `execute_action`, connector `instagram`)
- Story: `create_story` con `{"image_url": URL}`.
- Post: `create_image_post` con `{"image_url": URL, "caption": pie_texto}`.
- Carrusel: `create_carousel_post` con `{"image_urls": [URL1, URL2, ...], "caption": pie_texto}` (2 a 10, en orden).
- Si sale bien: estado `Publicada`, `publicada_en` (ISO), `media_id`; anota una fila en `claude/registro-piezas-redes.md` de la rama (commit y push); borra de la rama `redes-media` los JPG de esa pieza (`git rm` + push) y borra los documentos de `fotos` usados.
- Si falla: no reintentar en bucle; vuelve a `Aprobada` y escribe `aviso` con el motivo.

## Reglas
- Nunca publicar piezas en Borrador o Solicitud, sin fecha o sin `aprobada_en`. «Vencida» = `fecha_pub` (hora de Madrid) <= ahora.
- Nunca publicar una pieza con texto entre corchetes `[ ]` en `ajustes`, `datos`, `slides` o `pie_texto` (son huecos por rellenar): escribe `aviso` «Faltan textos entre [ ]».
- Un carrusel con menos de 2 diapositivas no se publica (aviso).
- Antes de generar nada, reclama la pieza: estado `Publicando` con `ifVersion` (evita que dos ejecuciones la publiquen a la vez). Si lleva más de 30 min en `Publicando` sin `publicada_en`, devuélvela a `Aprobada` con aviso.
- Los datos con `editado_manual:true` los escribió el usuario: respetarlos tal cual.
- Fotos de menores: la responsabilidad es de quien las sube; en rivales menores no se ponen nombres.
- No tocar otras ramas del repo.

## Fotos que llegan por el chat de Claude
Cuando el usuario manda fotos de podio o de grupo por el chat: recortar/ajustar a 1080 x alto (cover), guardarlas en `fotos` y crear la pieza como Borrador con `foto_id`; el usuario revisa en el panel y la aprueba. También puede adjuntarlas en el chat del panel («✦ Claude»).

## Limitación conocida
Una sesión de chat normal puede leer el panel (db_get, db_query) pero no escribir en su base de datos (error `network_off`). Solo las ejecuciones programadas (y los chats abiertos desde la página del panel) pueden cambiar estados.
