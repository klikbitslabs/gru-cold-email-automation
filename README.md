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

## Marcas, empresas y decisiones antes de actuar

**Marcas (varias por cuenta).** Cada campaña usa una marca. La marca define:
1. **Industria y operación** (p. ej. Retail, distribución, farmacias, importadoras)
2. **Función del contacto** (p. ej. Demand Planning, Supply Chain, Compras, Dirección)
3. **Problema que queremos resolver** (p. ej. errores de pronóstico, faltantes, exceso, reposición)
4. **Mensaje específico de referencia** (asunto + correo + argumento de llamada)

más propuesta de valor, tono y palabras prohibidas. Ese contexto alimenta el análisis de Jev, la redacción con OpenAI y los guiones de llamada.

**Las 5 preguntas antes de actuar** (visibles en el detalle de cada prospecto):

| # | Pregunta | Quién responde |
|---|---|---|
| 1 | ¿Esta empresa realmente encaja con la marca? | Jev (score contra las industrias de la marca; infiere la industria si falta) |
| 2 | ¿Esta persona tiene responsabilidades relacionadas con lo que vendemos? | Jev (score contra las funciones de la marca) |
| 3 | ¿Qué problema podría importarle según su cargo e industria? | Jev (elige entre los problemas de la marca) |
| 4 | ¿Tenemos información suficiente y verificable para personalizar? | Código (ganchos con todos sus datos presentes) |
| 5 | ¿Cuál es la siguiente acción según su historial? | Código (paso siguiente, borrador, tarea, empresa que ya respondió…) |

Sin clave de Jev, 1–3 se responden por coincidencia de palabras clave y, ante la duda, el lead queda en investigación (nunca se excluye por suposición).

**Estados automáticos de los leads:**
- **Apto para campaña** — empresa y cargo relevantes, email verificado, datos suficientes, base legal permitida y sin exclusiones.
- **Requiere investigación** — falta cargo, industria, procedencia o verificación. No se programa. Desde el detalle del prospecto puedes completar los datos y se reanaliza al instante.
- **Excluido de campaña** — opt-out, rebote permanente, duplicado activo, contacto no apropiado, empresa que no encaja o base legal no permitida.

**Empresas.** Los leads se agrupan por dominio corporativo (o nombre). La vista *Empresas* muestra el estado de cada cuenta y sus contactos en todas las campañas. Reglas por campaña: máximo de contactos por empresa (por defecto 3; el resto queda en reserva), días entre el primer correo a colegas y detener a los colegas cuando alguien de la empresa responde.

## Reglas de envío

Pestaña *Reglas de envío* de cada campaña (como un "autopilot"): días y horario **por día** (p. ej. L–V 08:00–17:00, sábado 09:00–13:00, domingo apagado), zona horaria, **máximo de correos por día** de la campaña y **pausa entre correos** en minutos, con un resumen de cuánto tardan 100 correos. Los límites diarios y pausas de cada sender se siguen respetando.

## Redacción con IA y pruebas A/B supervisadas

- **OpenAI** (clave en *Integraciones*): en cada paso, *✨ Proponer variantes con IA* escribe asuntos y correos con el contexto de la marca, las reglas de calidad y los resultados de las variantes ganadoras (apertura y respuesta). Cada variante incluye la hipótesis que prueba.
- **Supervisión**: las variantes de IA entran como **propuestas** y no se envían hasta que las apruebas. Además, cada correo pasa por el control de calidad y por la cola de aprobación (modo por defecto: aprobar todos los correos).
- **A/B**: Jev reparte las variantes activas por prospecto y aprende de su historial. La pestaña *Pruebas A/B* compara variantes con una prueba estadística (mínimo 30 envíos por variante) y **recomienda** pausar perdedoras o generar retadores; tú apruebas cada acción.

## Analítica avanzada y centro de decisiones

**Analítica** (menú *Analítica*): filtros por periodo (7/30/90 días), marca y campaña.
- KPIs con variación contra el periodo anterior: enviados, apertura, respuesta, respuestas positivas, reuniones, rebote, bajas y tiempo medio hasta abrir/responder.
- Actividad diaria (enviados, aperturas, respuestas) con tooltip y vista de tabla.
- **¿Cuándo abren tus prospectos?** Mapa de calor día × hora de aperturas humanas (se excluyen los escáneres de seguridad), en la zona horaria de cada campaña.
- **¿Qué funciona mejor?** Desglose por campaña, paso, asunto/variante, sender, segmento, industria y cargo. Las respuestas se atribuyen al último correo que recibió cada persona.
- Respuestas por tipo y estado de los leads (apto / investigación / excluido).

**Decisiones** (menú *Decisiones*, con contador): cada hora (o con *Analizar ahora*) la plataforma revisa los resultados y propone qué cambiar, con la evidencia:

| Recomendación | Cuándo |
|---|---|
| Pausar variante perdedora | Prueba estadística con ≥30 envíos por variante |
| Proponer textos nuevos con IA | Apertura < 20% con ≥40 envíos (asuntos nuevos), seguimiento con 0 respuestas en ≥40 envíos, o retador para la ganadora |
| Activar variantes propuestas | Propuestas de IA que pasan el control de calidad |
| Aprobar borradores | Borradores sin errores esperando más de 2 h (o ≥10) |
| Pausar sender | Rebote > 5% con ≥20 envíos en 14 días |
| Ajustar ventana de envío | < 60% de las aperturas cae en la ventana actual y otra ventana cubre ≥15 pp más |
| Subir límite diario | El límite se alcanza, hay ≥20 leads aptos esperando, rebote < 3% y los buzones tienen capacidad |
| Avisos | Leads en investigación, bajas > 2%, segmento con respuesta muy baja, sender desconectado, buzones al máximo |

Cada recomendación se **aprueba** (se aplica en el momento) o se **descarta** (se silencia 14 días). En *Permisos de automatización* eliges qué tipos puede aplicar la plataforma sola: **Supervisado** (nada), **Recomendado** (pausar perdedoras, proponer textos, pausar senders, ajustar ventana) o **Autopiloto** (todo). Los borradores y variantes con errores de calidad siempre esperan a una persona, y todo lo automático queda en el historial.

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
cp .env.example .env   # completa JWT_SECRET y ENCRYPTION_KEY; el resto se carga en Integraciones
npm start              # http://localhost:3000
npm test               # 32 pruebas (auth, integraciones, marcas, empresas, reglas de envío, IA, A/B, flujo completo)
```

Crea tu cuenta en `/#/register` y luego pon `ALLOW_REGISTRATION=false`.

### 1. Claves desde el panel de Integraciones

El primer usuario que se registra es el **administrador** y ve el menú **Integraciones**. Desde ahí se cargan las claves sin tocar el servidor:

| Clave | Dónde | Notas |
|---|---|---|
| Google Client ID y Client Secret | Integraciones → Google Workspace | El panel muestra la **URI de redireccionamiento** y el **origen** exactos para copiarlos en Google Cloud; **Probar conexión** verifica las credenciales y la URI con Google. |
| Dominios permitidos / cuentas @gmail.com | Integraciones → Google Workspace | Opcional. |
| API key y modelo de Jev | Integraciones → Jev | **Probar conexión** hace una pregunta mínima a la API. |
| API key y modelo de OpenAI | Integraciones → OpenAI | Para proponer textos; **Probar conexión** hace una llamada mínima. |
| `JWT_SECRET`, `ENCRYPTION_KEY` | Variables de Railway | **Solo aquí**: protegen las sesiones y cifran las claves del panel. No cambies `ENCRYPTION_KEY` después de guardar claves. |

Las claves del panel se guardan cifradas (AES-256-GCM) y nunca se devuelven completas al navegador. Un valor del panel tiene prioridad sobre la variable de entorno del mismo nombre (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `ALLOWED_GOOGLE_DOMAINS`, `ALLOW_CONSUMER_GMAIL`), que siguen funcionando como alternativa.

**Crear el cliente OAuth en Google Cloud (una vez):**
1. En [Google Cloud Console](https://console.cloud.google.com/) crea un proyecto y **habilita la Gmail API**.
2. **Pantalla de consentimiento OAuth**: tipo **Interno** si todos los senders son de tu organización de Workspace (no requiere verificación). Scopes: `openid`, `email`, `profile`, `gmail.send`, `gmail.readonly`.
3. **Credenciales → ID de cliente OAuth → Aplicación web**, con la URI y el origen que muestra el panel.
4. Pega el Client ID y el Secret en **Integraciones**, guarda y pulsa **Probar conexión**.
5. **Senders → Conectar cuenta de Google Workspace**. La firma de Gmail se importa automáticamente.

### 2. Dominio de envío

- Configura **SPF, DKIM (Admin de Google Workspace → Gmail → Autenticar correo) y DMARC**.
- Idealmente usa un **dominio secundario** con 2–3 buzones calentados 2–3 semanas; 20–50 envíos/día por buzón.

### 3. Jev

Pide acceso en [typesafe.ai](https://typesafe.ai) y carga la clave en **Integraciones** (modelo por defecto `jev-latest`). El indicador de la barra superior muestra si Jev está activo.

### 4. Deploy (Render o Railway)

La app necesita **un servidor siempre encendido** (el scheduler revisa cada 30 s qué correos tocan) y **disco persistente** para la base SQLite. Por eso **no funciona en Vercel** ni en otras plataformas serverless: el disco es de solo lectura/efímero y no hay procesos permanentes (da `500 FUNCTION_INVOCATION_FAILED`).

**Render (recomendado)**
1. En Render: **New → Blueprint** y elige este repositorio. Usa `render.yaml`: plan Starter, disco de 1 GB en `/data`, `JWT_SECRET` y `ENCRYPTION_KEY` generados automáticamente.
2. Las claves de Google y Jev se cargan después en **Integraciones** (o como variables de entorno, si prefieres).
3. La URL pública se detecta sola (`RENDER_EXTERNAL_URL`). Si usas dominio propio, define `BASE_URL=https://tu-dominio`.
4. En Google Cloud agrega el redirect `https://<tu-app>.onrender.com/api/senders/google/callback`.

**Railway**
1. **New Project → Deploy from GitHub repo** (usa `Dockerfile` y `railway.json`).
2. Agrega un **Volume** montado en `/data`.
3. Variables: solo `JWT_SECRET` y `ENCRYPTION_KEY` (genera cada una con `openssl rand -hex 32`). Las claves de Google y Jev se cargan después en **Integraciones**.
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
                       work (aprobación, tareas, resultados por prospecto), tracking (pixel, baja),
                       analytics (analítica avanzada + centro de decisiones)
  services/
    google.js          OAuth + Gmail REST (send, threads, search, firma)
    jev.js             análisis comercial, decisión del mensaje y clasificación de respuestas
    scheduler.js       orquestador: análisis, borradores, aprobación, envío, tareas, respuestas
    decisions.js       recomendaciones, permisos de automatización y ejecución de acciones
  lib/                 analytics (KPIs, mapa de calor, desgloses), csv (CSV/Excel), validate (leads), quality (reglas), plantillas, MIME, zonas horarias, cifrado
public/                SPA sin build (HTML/CSS/JS)
test/                  node:test + supertest con Gmail y Jev simulados
```

## Limitaciones conocidas

- Las aperturas son orientativas: Apple Mail Privacy Protection precarga imágenes y algunos clientes las bloquean.
- Las respuestas se detectan en el hilo y por búsqueda `from:` en el buzón del sender; si el prospecto responde desde otra dirección, puede no detectarse.
- El límite diario es una ventana móvil de 24 h por sender (compartida entre campañas).
- Jev decide (no redacta). La redacción con IA es de OpenAI y solo **propone** variantes a nivel de plantilla, que una persona aprueba; la personalización por prospecto sigue siendo verificable (ganchos con datos reales) y cada correo pasa por calidad y aprobación.
- El modelo de OpenAI por defecto es `gpt-4.1-mini`; cámbialo en Integraciones si tu cuenta usa otro.
- La integración con CRM (importación directa) no está incluida aún; se importa por CSV/Excel.
- No se probó contra Google ni contra la API de TypeSafe reales en este entorno (sin credenciales); las pruebas usan dobles que siguen el contrato del SDK oficial `@typesafe-ai/sdk` y de la Gmail API.
