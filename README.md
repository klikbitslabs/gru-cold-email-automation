# GRU Outreach — secuencias de cold email con Google Workspace + Jev

Herramienta para enviar secuencias de outreach (correo inicial + follow-ups, **máximo 4 envíos** por prospecto) desde buzones de **Google Workspace**, con personalización por prospecto, firma, rastreo de aperturas, detección de respuestas e importación de CSV. Las decisiones de **qué mensaje enviar, en qué momento y a qué prospectos** las toma **Jev** (modelo System One de TypeSafe).

## Funcionalidades

- **Login JWT** con correo y contraseña (bcrypt, tokens HS256, límite de intentos).
- **Senders de Google Workspace** conectados por OAuth 2.0; los correos salen por la **Gmail API** del propio buzón (aparecen en "Enviados"). Solo cuentas con dominio de Workspace (`hd`), opcionalmente restringidas a ciertos dominios. Refresh tokens cifrados (AES-256-GCM).
- **Firma** HTML por sender, editable con vista previa o **importada desde Gmail**.
- **Secuencias de hasta 4 envíos**: espera en días por paso, follow-ups en el **mismo hilo** (`Re:` + `In-Reply-To`, citando el correo anterior), **variantes A/B** por paso y librería de **CTAs**.
- **Importación CSV** (coma, punto y coma o tab; encabezados en español o inglés). Cualquier columna extra se vuelve campo `{{campo}}`; soporta alternativas `{{campo|texto}}`. Duplicados y correos dados de baja se omiten.
- **Personalización por follow-up**: cada paso se renderiza con los datos del prospecto, la variante y el CTA que Jev elige para ese prospecto en ese momento.
- **Aperturas** con pixel 1×1, filtrando escáneres de seguridad y aperturas en los primeros 60 s.
- **Respuestas y rebotes**: revisa el hilo y la bandeja del sender; Jev clasifica la respuesta (interesado, no interesado, referido, pregunta, auto-respuesta, rebote). Las auto-respuestas *no* detienen la secuencia; "no interesado" agrega a la lista de supresión.
- **Entregabilidad**: ventana horaria y días por campaña (con zona horaria), límite diario por sender, intervalo mínimo aleatorio entre envíos, rotación de senders, enlace + cabecera de baja de un clic (RFC 8058).
- **Linter de copy** basado en buenas prácticas (longitud, asunto, spam, links, CTA, enfoque en el prospecto). Ver [`docs/BEST_PRACTICES.md`](docs/BEST_PRACTICES.md).
- **Estadísticas** por campaña, paso, variante y CTA; auditoría de cada decisión de Jev por prospecto.

## Cómo decide Jev

Por cada prospecto cuyo siguiente paso está pendiente, se hace **una llamada** a `POST https://api.typesafe.ai/v1/systemone` con el estado (oferta, ICP, datos del CSV, interacción: aperturas por correo, franjas en que abrió, días desde el último correo) y cinco preguntas tipadas:

| Decisión | Pregunta Jev | Qué hace el código |
|---|---|---|
| **A quién** | `stop` (noul) y `fit` (score 0–4 contra el ICP) | Detiene si p(stop) ≥ 0.85; prioriza por encaje cuando el límite diario no alcanza |
| **Qué mensaje** | `variant` (choice entre los ángulos del paso) | Envía esa variante |
| **Qué petición** | `cta` (choice) | Baja fricción si no hay interacción; más directa si abrió varias veces |
| **Cuándo** | `send_slot` (choice: mañana/mediodía/tarde de tu ventana) | Si conviene otra franja, reprograma una vez y reutiliza la decisión |

Sin `TYPESAFE_API_KEY` (o si la API falla) se usan reglas: rotación A/B determinística, CTA según aperturas y franja con más aperturas previas. Cada decisión queda registrada con su motor y probabilidades (UI → Prospectos → detalle). También puedes "Simular decisión de Jev" sin enviar nada.

## Puesta en marcha

Requisitos: Node.js ≥ 20.

```bash
npm install
cp .env.example .env   # completa JWT_SECRET, ENCRYPTION_KEY, GOOGLE_*, TYPESAFE_API_KEY
npm start              # http://localhost:3000
npm test               # 15 pruebas (auth, CSV, plantillas, flujo completo de envío)
```

Crea tu cuenta en `/#/register` y luego pon `ALLOW_REGISTRATION=false`.

### 1. Cliente OAuth de Google (una vez)

1. En [Google Cloud Console](https://console.cloud.google.com/) crea un proyecto y **habilita la Gmail API**.
2. **Pantalla de consentimiento OAuth**: tipo **Interno** si todos los senders son de tu organización de Workspace (no requiere verificación de Google). Scopes: `openid`, `email`, `profile`, `gmail.send`, `gmail.readonly`.
3. **Credenciales → ID de cliente OAuth → Aplicación web**. URI de redirección autorizada: `{BASE_URL}/api/senders/google/callback` (p. ej. `https://outreach.tudominio.com/api/senders/google/callback`).
4. Copia el ID y el secreto a `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. En la app: **Senders → Conectar cuenta de Google Workspace**. La firma de Gmail se importa automáticamente.

`gmail.readonly` se usa para detectar respuestas/rebotes y leer la firma. Si la pantalla es *Externa*, Google exige verificación para scopes restringidos.

### 2. Dominio de envío

- Configura **SPF, DKIM (Admin de Google Workspace → Gmail → Autenticar correo) y DMARC**.
- Idealmente usa un **dominio secundario** con 2–3 buzones calentados 2–3 semanas; 20–50 envíos/día por buzón.

### 3. Jev

Pide acceso en [typesafe.ai](https://typesafe.ai) y pon la clave en `TYPESAFE_API_KEY` (modelo por defecto `jev-latest`). El badge superior de la UI indica si Jev está activo.

### 4. Deploy (Render o Railway)

La app necesita **un servidor siempre encendido** (el scheduler revisa cada 30 s qué correos tocan) y **disco persistente** para la base SQLite. Por eso **no funciona en Vercel** ni en otras plataformas serverless: el disco es de solo lectura/efímero y no hay procesos permanentes (da `500 FUNCTION_INVOCATION_FAILED`).

**Render (recomendado)**
1. En Render: **New → Blueprint** y elige este repositorio. Usa `render.yaml`: plan Starter, disco de 1 GB en `/data`, `JWT_SECRET` y `ENCRYPTION_KEY` generados automáticamente.
2. Completa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TYPESAFE_API_KEY` (y opcionalmente `ALLOWED_GOOGLE_DOMAINS`).
3. La URL pública se detecta sola (`RENDER_EXTERNAL_URL`). Si usas dominio propio, define `BASE_URL=https://tu-dominio`.
4. En Google Cloud agrega el redirect `https://<tu-app>.onrender.com/api/senders/google/callback`.

**Railway**
1. **New Project → Deploy from GitHub repo** (usa `Dockerfile` y `railway.json`).
2. Agrega un **Volume** montado en `/data`.
3. Variables: `JWT_SECRET` y `ENCRYPTION_KEY` (genera cada una con `openssl rand -hex 32`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TYPESAFE_API_KEY`.
4. **Settings → Networking → Generate Domain**. La URL se detecta sola (`RAILWAY_PUBLIC_DOMAIN`). Agrega el redirect de Google como arriba.

Notas:
- Ejecuta **una sola instancia** (el scheduler corre dentro del proceso).
- La URL pública debe ser **HTTPS**: la usan el pixel de aperturas, los enlaces de baja y el redirect de OAuth.
- `GET /healthz` responde `{"ok":true}` para los health checks. Respalda `/data/outreach.db` periódicamente.
- Si ya creaste el proyecto en Vercel, puedes eliminarlo o desconectarlo del repositorio para que no siga intentando desplegar.

## Flujo de uso

1. **Senders**: conecta buzones, revisa firma, límite diario y segundos entre envíos; envía una prueba.
2. **Campaña → Configuración**: oferta e ICP (Jev los usa), senders, zona horaria, ventana y días, opciones.
3. **Campaña → Secuencia**: hasta 4 pasos; varias variantes por paso con su "ángulo"; CTAs ordenados de suave a directo. Revisa el linter y la vista previa.
4. **Campaña → Prospectos**: importa el CSV (columna `email`/`correo` obligatoria).
5. **Activar**. El scheduler revisa cada 30 s; "Procesar ahora" fuerza un ciclo.

## Arquitectura

```
src/
  server.js            arranque + scheduler
  app.js               Express (helmet/CSP, rutas, errores)
  config.js / db.js    configuración y esquema SQLite
  middleware/auth.js   JWT
  routes/              auth, senders (OAuth), campaigns + prospects, tracking (pixel, baja)
  services/
    google.js          OAuth + Gmail REST (send, threads, search, firma)
    jev.js             decisiones y clasificación de respuestas (TypeSafe SDK + reglas)
    scheduler.js       ventanas, límites, rotación, hilos, respuestas, envío
  lib/                 plantillas, MIME, CSV, linter, zonas horarias, cifrado
public/                SPA sin build (HTML/CSS/JS)
test/                  node:test + supertest con Gmail y Jev simulados
```

## Limitaciones conocidas

- Las aperturas son orientativas: Apple Mail Privacy Protection precarga imágenes y algunos clientes las bloquean.
- Las respuestas se detectan en el hilo y por búsqueda `from:` en el buzón del sender; si el prospecto responde desde otra dirección, puede no detectarse.
- El límite diario es una ventana móvil de 24 h por sender (compartida entre campañas).
- No se probó contra Google ni contra la API de TypeSafe reales en este entorno (sin credenciales); las pruebas usan dobles que siguen el contrato del SDK oficial `@typesafe-ai/sdk` y de la Gmail API.
