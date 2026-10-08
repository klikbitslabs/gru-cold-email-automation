# Buenas prácticas de cold email (investigación)

> **Reglas de la casa.** Las reglas de asunto y cuerpo definidas por el equipo (asunto de 3–7 palabras; cuerpo de 45–85 palabras con advertencia desde 110; estructura de 3 párrafos contexto → problema → pregunta; una sola acción; sin enlaces ni adjuntos en el primer correo; firma real; español natural) son las que aplica `src/lib/quality.js` y prevalecen sobre las cifras de la investigación de abajo cuando difieren. Ver el README para la tabla de severidades.

Resumen de la investigación usada para diseñar la herramienta. Cada práctica indica **dónde se aplica** en el código.

> **Nota sobre las fuentes.** Las URLs pedidas (ycombinator.com, news.ycombinator.com, clay.com, instantly.ai, typesafe.ai) estaban bloqueadas por el proxy de red del entorno donde se construyó esto. El contenido se obtuvo con búsqueda web (resúmenes de esas mismas páginas y de terceros que las citan). Para Jev se usó el **SDK oficial** (`typesafe-ai/typesafe-sdk-js`) y la skill oficial (`typesafe-ai/skills`), clonados desde GitHub: el contrato de la API está verificado contra el código fuente del SDK, no contra resúmenes. Las cifras que vienen de proveedores (Clay, Instantly, etc.) son su propio playbook, no estudios independientes.

## 1. Copy del correo

| Práctica | Fuente | Dónde se aplica |
|---|---|---|
| Corto: se lee en ≤ 60 s. Primer correo 50–125 palabras; Clay recomienda < 75. Follow-ups más cortos (30–90). | YC / Michael Seibel; Clay; Woodpecker, Lemlist | `src/lib/quality.js` (`too_long`, `above_target`, `too_short`) |
| Asunto corto (2–6 palabras), sin MAYÚSCULAS, sin "!" ni "Re:"/"Fwd:" falsos. | Lemlist, Folderly, Hyperise | `quality.js` (`subject_length`, `subject_caps`, `subject_exclamation`, `fake_reply`) |
| Personalización real: abrir con algo específico del prospecto (trigger, observación, hipótesis), no con quién eres. | Clay, Lemlist | `quality.js` (`personalization`); ganchos verificables `{{gancho}}`; campos del archivo → `{{campo}}` |
| Estructura: contexto específico → evidencia del problema → costo de no actuar → prueba social con resultado medible → CTA de baja fricción. | Clay (guía B2B copywriting) | Plantillas por defecto del editor (`public/app.js` → `defaultCampaign`) |
| Una sola petición, pequeña. No pedir reunión de 30 min en el primer correo; pedir interés, enviar info o consejo. | YC (Seibel: "no pidas reunión de entrada"), Clay | `quality.js` (`many_ctas`, `no_cta`); biblioteca de CTAs que Jev escala según interacción |
| Investor emails: qué haces, la señal más fuerte (tracción, equipo), una petición concreta. Sin historia de origen ni jerga. | YC (Seibel, "3 frases") | Guía en la UI |
| Escribir como colega, no como marketer. Texto plano, sin HTML pesado. | Clay, Instantly | Cuerpo en texto plano → HTML mínimo (`src/lib/template.js`) |
| Evitar palabras spam ("gratis", "garantizado", "urgente"…) y > 1 link; sin imágenes/adjuntos al inicio. | Lemlist, Instantly, Clay | `quality.js` (`hype`, `subject_hype`, `links_first_email`, `links`) |

## 1b. Un argumento por cargo (reglas de oro)

En una misma empresa pueden comprar un Demand Planner, un gerente de Supply Chain y un director financiero, pero cada uno tiene una motivación distinta. Mandarles el mismo correo desperdicia la cuenta: el mensaje solo le habla a uno de ellos y, si lo comparan, resta credibilidad.

1. **Una persona, un argumento**: el correo responde a la motivación del cargo, no a las funciones del producto.
2. **Mismo problema, distinto ángulo**: Planner → precisión del pronóstico y horas manuales; Supply Chain → nivel de servicio, faltantes e inventario; Finanzas → capital de trabajo, margen y riesgo; Dirección → alineación entre áreas y rentabilidad.
3. **Nunca el mismo correo en la misma cuenta**: la plataforma compara cada primer correo con los que ya recibieron sus colegas (similitud ≥60% = error, va a revisión) y no repite la variante que usó un colega.
4. **El lenguaje del rol**: operativos, detalle concreto; directivos, impacto en negocio, más breve y sin jerga.
5. **Un pedido acorde al nivel**: directivos, una pregunta de bajo esfuerzo ("¿tiene sentido?" o "¿quién de tu equipo?"); operativos, algo más concreto (ver una muestra).
6. **Escalonar la cuenta**: 2–3 contactos por empresa, separados por días; empezar por quien sufre el problema.
7. **Si uno responde, la cuenta se detiene**.
8. **No mencionar colegas en frío**.

Implementación: *Marcas → 5. Perfiles de comprador* (cargos que lo identifican, motivación, problema → `{{problema}}`, argumento, prueba, pedido → `{{cta}}`, qué evitar). Cada lead se asigna a un perfil por su cargo (palabras clave y, si no hay coincidencia, Jev); sin perfil queda en *Requiere investigación*. Las variantes pueden escribirse para un perfil y la IA redacta para el perfil elegido.

## 2. Secuencia y follow-ups

| Práctica | Fuente | Dónde se aplica |
|---|---|---|
| ~4 correos en total en un periodo de varias semanas (Clay: "about four emails over six weeks"); otros: 3–5 follow-ups espaciados 3–7 días. | Clay; Folderly; Instantly | `MAX_SEQUENCE_STEPS=4`; espera configurable por paso |
| Cada follow-up aporta algo nuevo (prueba social, otro ángulo, recurso, breakup). | Folderly, Clay | Variantes con "ángulo" por paso; plantillas por defecto |
| La mayoría de respuestas positivas llegan en el correo 1 o 2: invertir ahí. | Clay | Fit score de Jev prioriza a los mejores prospectos |
| Follow-ups en el mismo hilo ("Re:"), citando el correo anterior. | Práctica común (Instantly, Clay sequencer) | `scheduler.js` (`In-Reply-To`, `References`, `threadId`, cita) |
| Detener al responder; no perseguir con varios follow-ups seguidos. | YC (Seibel), todos | Detección de respuestas vía Gmail + clasificación (auto-respuesta no detiene) |
| Rastrear aperturas. | YC (Seibel lo sugiere) | Pixel `/t/o/:token.gif`, filtro de bots/escáneres |

## 3. Entregabilidad

| Práctica | Fuente | Dónde se aplica |
|---|---|---|
| SPF, DKIM y DMARC configurados. | Instantly | README (configuración del dominio) |
| Calentar buzones; 30–50 envíos/día por buzón al inicio. | Instantly | `daily_limit` por sender (por defecto 30, ventana móvil de 24 h) |
| Dominios secundarios para cold email, para proteger el dominio principal. | Instantly | README / aviso en la UI |
| Enviar desde dirección del dominio de la empresa con tu nombre. | YC (Seibel) | Solo cuentas Google Workspace (`hd`), `display_name` |
| Envíos espaciados, horario laboral, mejores días mar–jue (8–10 y 14–16 h). | Instantly | Ventana/días por campaña, intervalo mínimo aleatorio (1×–1.5×) por sender, 1 envío por sender por ciclo |
| Baja de un clic. | RFC 8058, requisitos de Gmail/Yahoo para remitentes | `List-Unsubscribe` + `List-Unsubscribe-Post`, página `/u/:token`, lista de supresión |
| Rebote > 3% daña el dominio: verificar la lista. | Práctica común | Aviso en estadísticas; los rebotes detienen la secuencia |
| El pixel de aperturas puede afectar ligeramente la entregabilidad y Apple Mail Privacy infla aperturas. | Instantly / práctica común | Toggle por campaña; aperturas en < 60 s y UAs de escáneres marcadas como bot |

## 4. Ideas tomadas de herramientas (Mocke – YC, Clay sequencer, Instantly)

- **Agente que decide por prospecto** (Mocke): aquí lo hace Jev con decisiones tipadas, no generación libre de texto.
- **Variantes / A/B por paso** y **rotación de buzones** (Clay sequencer, Instantly): variantes por paso, rotación entre senders con buzón fijo por prospecto.
- **Detección de respuestas y categorización** (Instantly "Unibox"): Jev clasifica interesado / no interesado / referido / pregunta / auto-respuesta / rebote.

## 5. Jev (TypeSafe System One)

Jev no genera texto: recibe un **estado** (texto/JSON) y **preguntas tipadas** y devuelve respuestas con probabilidades en ~70–500 ms.

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, cuerpo `{ model, state, questions }`.
- Tipos: `noul` (sí/no → `noul` = probabilidad de sí), `choice` (→ `choice`, `confidence`, `probabilities`), `score` (rúbrica ordenada → `score` esperado, `confidence`).
- Modelo por defecto del SDK: `jev-latest`.
- Principio de la skill oficial: *"Code owns the workflow; the model supplies programmable common sense"* y *"Select instead of generate"*.

Cómo lo usa esta herramienta (`src/services/jev.js`), en **una sola llamada por prospecto y paso** (preguntas en paralelo):

| Pregunta | Tipo | Política en código |
|---|---|---|
| `stop` — ¿el prospecto claramente no puede beneficiarse de la oferta? | noul | Detener solo si p ≥ 0.85 (los datos faltantes no son motivo) |
| `variant` — qué ángulo de mensaje tiene más probabilidad de respuesta | choice | Se envía la variante elegida |
| `cta` — tamaño de la petición según interacción | choice | Se inserta en `{{cta}}` |
| `send_slot` — franja de la ventana (mañana / mediodía / tarde) | choice | Si confianza ≥ 0.5 y no es la franja actual, se reprograma **una vez** y se reutiliza la decisión |
| `fit` — encaje con el ICP (0–4) | score | Prioriza la cola cuando el límite diario aprieta |

Además, `classifyReply` clasifica cada respuesta entrante. Sin `TYPESAFE_API_KEY` (o si la API falla) se usan reglas deterministas y el motor queda registrado en cada decisión.

## Fuentes

- YC — How to cold email investors (Michael Seibel): https://www.ycombinator.com/blog/how-to-cold-email-investors-michael-seibel/ · https://www.ycombinator.com/library/65-how-to-cold-email-investors
- YC Library — How to convert customers with cold emails: http://ycombinator.com/library/LZ-how-to-convert-customers-with-cold-emails
- YC Launch — Mocke, cold email AI agent: https://www.ycombinator.com/launches/PYH-mocke-cold-email-ai-agent
- Hacker News discussion: https://news.ycombinator.com/item?id=42357273
- Clay — B2B cold email copywriting: https://www.clay.com/blog/b2b-cold-email-copywriting · Clay email sequencer: https://www.clay.com/blog/clay-email-sequencer
- Instantly — Cold email guide: https://instantly.ai/blog/cold-email/
- TypeSafe — Introducing System One models & Jev: https://typesafe.ai/blog/introducing-system-one-models-and-jev · Docs: https://docs.typesafe.ai · SDK: https://github.com/typesafe-ai/typesafe-sdk-js · Skill: https://github.com/typesafe-ai/skills
- Complementarias: Woodpecker (longitud), Lemlist (47 tips), Folderly (asuntos, follow-ups), resúmenes del framework de 3 frases de Seibel.
