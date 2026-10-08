# GRU Outreach — secuencias de cold email con Google Workspace + Jev

Herramienta para enviar secuencias de outreach (correo inicial + follow-ups, **máximo 4 envíos** por prospecto) desde buzones de **Google Workspace**, con personalización por prospecto, firma, rastreo de aperturas, detección de respuestas e importación de CSV. Las decisiones de **qué mensaje enviar, en qué momento y a qué prospectos** las toma **Jev** (modelo System One de TypeSafe).

## Arquitectura de decisión

```
Importación de leads (CSV / Excel, origen y base legal)
        │
        ├── Validación ............ formato, MX del dominio, cuentas genéricas/personales,
        │                           desechables, duplicados, lista de baja
        └── Inteligencia comercial  Jev: segmento, encaje con el ICP, exclusión
        │
Motor de generación + control de calidad
        Jev elige variante, gancho verificable, hipótesis de problema y CTA →
        control de calidad (reglas de asunto y cuerpo) → cola de aprobación o auto-aprobado
        │
Orquestador comercial
        correos (ventana, límites por sender, mismo hilo) · tareas de llamada · tareas de LinkedIn
        │
Resultados y aprendizaje
        respuestas, interés, reuniones, oportunidades y cierres → rendimiento por variante
        y CTA que vuelve a Jev como evidencia
```

| Etapa | Qué hace | Código |
|---|---|---|
| **Importación** | CSV (`,` `;` tab) o `.xlsx`. Reconoce encabezados ES/EN (nombre, empresa, cargo, industria/sector, país, teléfono, LinkedIn). Toda otra columna es un campo `{{campo}}`. Exige **origen** y **base legal**. | `src/lib/csv.js` |
| **Validación** | Inválido (sin MX, desechable, formato) → se detiene. Riesgoso (genérica tipo `info@`, correo personal, dominio no verificable) → pasa por aprobación. Duplicados, lista de baja y "ya está en otra campaña". | `src/lib/validate.js` |
| **Inteligencia comercial** | Jev asigna **segmento**, puntúa **encaje con el ICP** (0–100 %) y **excluye** a quien claramente no encaja. Se ejecuta justo después de importar, antes de enviar. | `analyzeProspect` en `src/services/jev.js` |
| **Generación + calidad** | Plantilla de 3 párrafos: `{{gancho}}` (contexto real) → `{{problema}}` (hipótesis) → `{{cta}}` (una acción). Jev elige de bibliotecas por segmento; **un gancho solo se ofrece si todos sus datos existen** para ese prospecto (verificable). Control de calidad con las reglas de abajo; modos de aprobación: todos, primer correo, solo con advertencias, automático. | `decide`, `src/lib/quality.js`, `createDraft` |
| **Orquestador** | Correos dentro de la ventana horaria, límite diario y pausa aleatoria por sender, rotación de buzones, seguimientos en el mismo hilo; pasos de **llamada** y **LinkedIn** generan tareas con guion. | `src/services/scheduler.js` |
| **Resultados** | Respuestas clasificadas por Jev (interesado, no interesado, referido, pregunta, auto-respuesta, rebote), resultados manuales (reunión, oportunidad, cierre, perdido), embudo por segmento y por variante. | `src/routes/work.js`, pestaña Resultados |

### Reglas del control de calidad

| Asunto | Regla | Severidad |
|---|---|---|
| Longitud | 3–7 palabras | advertencia |
| Mayúsculas | sin bloques en MAYÚSCULAS (siglas como CEO/CRM permitidas) | advertencia |
| Signos | sin exclamaciones ni puntuación repetida | advertencia |
| Emojis | prohibidos en el primer contacto | **error** |
| Re: / Fwd: | solo en un hilo real | **error** |
| Estilo | sin lenguaje publicitario exagerado | advertencia |
| Variantes | 2–3 por segmento en el primer correo | recomendación |

| Cuerpo | Regla | Severidad |
|---|---|---|
| Longitud | objetivo 45–85 palabras; desde 110 | info / advertencia |
| Estructura | 3 párrafos: contexto → problema → pregunta | advertencia |
| CTA | máximo una acción principal | advertencia |
| Personalización | ≥ 1 elemento verificable y no trivial | advertencia |
| Enlaces | ninguno en el primer correo (la baja va aparte) | **error** |
| Emojis | ninguno en el primer contacto | **error** |
| Firma | nombre real y firma del remitente | **error** |
| Datos | ningún campo faltante | **error** |
| Lead | inválido = error, riesgoso = advertencia | — |

Los **errores** siempre requieren a una persona (editar o confirmar). Las **advertencias** van a la cola de aprobación según el modo de la campaña.

## Funcionalidades de la plataforma

- **Login JWT** con correo y contraseña (bcrypt, HS256, límite de intentos).
- **Senders de Google Workspace** por OAuth 2.0; envío por la **Gmail API** del propio buzón. Solo cuentas de Workspace (`hd`), opcionalmente restringidas por dominio. Refresh tokens cifrados (AES-256-GCM).
- **Firma** HTML por sender, editable o **importada desde Gmail** (obligatoria para activar).
- **Secuencias** de hasta 4 correos + tareas de llamada/LinkedIn (7 pasos en total).
- **Aperturas** con pixel 1×1 filtrando escáneres; **respuestas y rebotes** detectados en Gmail; auto-respuestas no detienen la secuencia.
- **Baja de un clic** (RFC 8058) y lista de supresión.
- **Auditoría**: cada decisión (Jev o reglas) queda registrada con probabilidades; "Simular decisión de Jev" sin enviar.

## Cómo usa la herramienta a Jev

Dos llamadas tipadas a `POST https://api.typesafe.ai/v1/systemone` (SDK oficial `@typesafe-ai/sdk`):

1. **Análisis** (una vez por lead): `exclude` (noul), `segment` (choice entre tus segmentos), `fit` (score 0–4 contra el ICP).
2. **Decisión del mensaje** (cada correo): `variant`, `hook`, `problem`, `cta` y `send_slot` (choice). El estado incluye los datos del lead, su segmento, su interacción (aperturas, franjas, tareas) y el **historial de resultados de cada variante y CTA**, para que Jev aprenda de lo que funciona.

El código solo ofrece opciones válidas (variantes del segmento, ganchos con datos completos) y aplica la política: exclusión si p ≥ 0,85, franja horaria solo con confianza ≥ 0,5. Sin `TYPESAFE_API_KEY` se usan reglas: coincidencia de palabras clave para el segmento, rotación A/B que favorece la mejor variante tras 20 envíos, CTA según aperturas.

## Puesta en marcha

Requisitos: Node.js ≥ 20.

```bash
npm install
cp .env.example .env   # completa JWT_SECRET, ENCRYPTION_KEY, GOOGLE_*, TYPESAFE_API_KEY
npm start              # http://localhost:3000
npm test               # 23 pruebas (auth, importación, validación, calidad, Jev, flujo completo)
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

1. **Senders**: conecta buzones, revisa nombre, firma, límite diario y pausa entre envíos; envía una prueba.
2. **Campaña → Configuración**: oferta, ICP, modo de aprobación, senders, ventana horaria.
3. **Campaña → Personalización**: segmentos, ganchos (usa columnas de tu base, p. ej. `{{noticia}}`), hipótesis de problema y CTAs.
4. **Campaña → Secuencia**: 2–3 variantes del primer correo por segmento, seguimientos y tareas de llamada/LinkedIn. Revisa la vista previa y el control de calidad.
5. **Campaña → Prospectos**: importa CSV/Excel con origen y base legal; revisa el reporte de validación y los segmentos asignados.
6. **Activar** → **Aprobación**: revisa/edita los borradores y apruébalos. **Tareas**: completa llamadas y LinkedIn. **Resultados**: marca reuniones, oportunidades y cierres.

## Estructura del código

```
src/
  server.js            arranque + scheduler
  app.js               Express (helmet/CSP, rutas, errores)
  config.js / db.js    configuración y esquema SQLite
  middleware/auth.js   JWT
  routes/              auth, senders (OAuth), campaigns (CRUD, importación, vista previa, resultados),
                       work (aprobación, tareas, resultados por prospecto), tracking (pixel, baja)
  services/
    google.js          OAuth + Gmail REST (send, threads, search, firma)
    jev.js             análisis comercial, decisión del mensaje y clasificación de respuestas
    scheduler.js       orquestador: análisis, borradores, aprobación, envío, tareas, respuestas
  lib/                 csv (CSV/Excel), validate (leads), quality (reglas), plantillas, MIME, zonas horarias, cifrado
public/                SPA sin build (HTML/CSS/JS)
test/                  node:test + supertest con Gmail y Jev simulados
```

## Limitaciones conocidas

- Las aperturas son orientativas: Apple Mail Privacy Protection precarga imágenes y algunos clientes las bloquean.
- Las respuestas se detectan en el hilo y por búsqueda `from:` en el buzón del sender; si el prospecto responde desde otra dirección, puede no detectarse.
- El límite diario es una ventana móvil de 24 h por sender (compartida entre campañas).
- La generación es por **selección** (plantillas + bibliotecas elegidas por Jev), no por texto libre: Jev no redacta, decide. Así cada frase es revisable y cada dato es verificable. Si más adelante quieres redacción libre por prospecto, se puede agregar un modelo generativo detrás del mismo control de calidad y aprobación.
- La integración con CRM (importación directa) no está incluida aún; se importa por CSV/Excel.
- No se probó contra Google ni contra la API de TypeSafe reales en este entorno (sin credenciales); las pruebas usan dobles que siguen el contrato del SDK oficial `@typesafe-ai/sdk` y de la Gmail API.
