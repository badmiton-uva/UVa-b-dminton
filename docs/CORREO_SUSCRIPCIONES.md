# Suscripciones por correo: cómo activarlas

La web tiene la sección «Sigue al club» (Inicio → #sigue): la gente escribe su correo, elige a todo el equipo o a jugadores concretos y recibe, **como mucho, dos correos por torneo**: uno a media jornada (cómo van, contra quién juegan, si ganan) y otro al final (resultados, medallas y noticia). **No funciona hasta que se conecte un proveedor de correo**
(hoy el formulario sale con el aviso «Estamos activando el envío de correos»).

## Qué hace el sistema
1. La persona se suscribe → recibe un correo con un enlace → **no vale hasta que lo confirma** (doble confirmación; abrir el enlace muestra un botón, para que los escáneres de correo no confirmen solos).
2. **Pocos correos y agrupados:** por cada torneo en el que juegue alguien de lo que sigue (o cualquiera del equipo), UN correo a media jornada (cuando el día va entre el 40 y el 80 % de los partidos) y UNO al final; si coinciden varios torneos o avisos, van juntos en un solo correo. Máximo 2 al día por persona (`SUBSCRIBER_MAILS_PER_DAY`), solo de 9:00 a 23:00 (Madrid), y nada si ninguno de sus jugadores juega. Quien se suscribe con el torneo empezado no recibe el de media jornada, pero sí el final.
3. Cada correo lleva «Darme de baja» (y la cabecera `List-Unsubscribe` de baja con un clic). La baja **borra** la dirección. Las suscripciones sin confirmar se borran a los 7 días.
4. Cambiar lo que se sigue también pide confirmar por correo (nadie puede cambiar la suscripción de otra persona). Solo se puede seguir a jugadores públicos (con consentimiento).

## Activarlo (10 minutos)
FormSubmit no sirve para esto (solo reenvía a una dirección fija). Hace falta un servicio de envío con API. Recomendado: **Brevo** (gratis, 300 correos al día, no exige tener dominio propio).
1. Crea una cuenta en https://www.brevo.com y, en «Remitentes y IP», añade como remitente una dirección tuya (p. ej. la del club, cduvabad@gmail.com) y **verifícala** con el correo que te mandan.
2. En «SMTP y API» → «Claves API», crea una clave (v3).
3. En Render → el servicio → Environment, añade:
   - `MAIL_PROVIDER` = `brevo`
   - `BREVO_API_KEY` = la clave
   - `MAIL_FROM` = la dirección verificada (la misma del paso 1)
   - `MAIL_FROM_NAME` = `Club Bádminton UVa` (opcional)
   - (Opcional) `SUBSCRIBE_SECRET` = una frase larga y secreta; si no, el servidor genera una y la guarda.
4. Guarda: Render reinicia el servidor y el formulario se activa solo (`GET /api/public/subscribe` pasa a `{"enabled":true}`).
Alternativa: Resend (`MAIL_PROVIDER=resend`, `RESEND_API_KEY`), que exige verificar un dominio propio para escribir a cualquiera.

Consejo: con un remitente @gmail.com algunos buzones pueden mandar los correos a spam; con un dominio propio del club (p. ej. badmintonuva.es) y SPF/DKIM configurados en Brevo llegan mejor.

## Ajustes (variables de entorno)
`SUBSCRIBERS_MAX` (tope de personas, 3000), `SUBSCRIBER_MAILS_PER_DAY` (2), `SUBSCRIBE_COOLDOWN_MINUTES` (10 entre dos correos a la misma dirección).

## Privacidad
Tratamiento nuevo en `src/pages/LegalPage.tsx` (consentimiento, conservación hasta la baja, proveedor de envío como encargado). Las direcciones viven en la base de datos del servidor (y, por tanto, en su copia de seguridad en Upstash) y se borran al darse de baja. No se publican nunca; `/api/health?full=1` solo enseña el recuento (`subscribers`).
