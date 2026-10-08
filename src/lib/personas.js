// Buyer personas: the same company can buy for different reasons depending on who reads the
// email. A Demand Planner, a Supply Chain manager and a CFO share the problem but not the
// motivation, so each one gets its own argument, language and ask (golden rules of outreach).

const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Title keywords of a persona ("demand planner, planificador de demanda; S&OP"). */
export const personaKeywords = (persona) => String(persona.match_titles || '')
  .split(/[,;\n]+/).map(normalize).filter(Boolean);

/**
 * Best persona for a job title: the persona whose keyword matches the title with the most
 * characters (so "director financiero" beats "director"). Null when nothing matches.
 */
export function matchPersona(title, personas = []) {
  const t = ` ${normalize(title)} `;
  if (!t.trim()) return null;
  let best = null;
  let bestLen = 0;
  for (const p of personas) {
    for (const k of personaKeywords(p)) {
      if (t.includes(` ${k} `) && k.length > bestLen) {
        best = p;
        bestLen = k.length;
      }
    }
  }
  return best;
}

/** Word-set similarity (0–1) used to stop sending the same argument to two people of one account. */
export function similarity(a, b) {
  const words = (s) => new Set(normalize(s).split(' ').filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common += 1;
  return common / (A.size + B.size - common);
}

/** Removes the people's own data so two emails are compared by their argument only. */
export function stripPersonal(text, people = []) {
  let out = String(text || '');
  for (const p of people) {
    for (const v of [p.first_name, p.last_name, p.company, p.title, p.email]) {
      if (v && v.length > 1) out = out.split(v).join(' ');
    }
  }
  return out;
}

export const GOLDEN_RULES = [
  ['Una persona, un argumento', 'El mensaje responde a la motivación de su cargo, no a las funciones del producto.'],
  ['Mismo problema, distinto ángulo', 'Planner: precisión y horas manuales. Supply Chain: nivel de servicio e inventario. Finanzas: capital de trabajo, margen y riesgo.'],
  ['Nunca el mismo correo en la misma cuenta', 'Dos personas de una empresa no reciben el mismo argumento ni el mismo texto (se bloquea para revisión).'],
  ['El lenguaje del rol', 'Operativos: detalle concreto. Directivos: impacto en negocio, breve, sin jerga técnica.'],
  ['Un pedido acorde al nivel', 'Una sola petición, de bajo esfuerzo para directivos (¿tiene sentido?) y más concreta para operativos.'],
  ['Escalonar la cuenta', 'Máximo 2–3 contactos por empresa, separados por días; se empieza por quien sufre el problema.'],
  ['Si uno responde, la cuenta se detiene', 'Se atiende la conversación antes de seguir escribiendo a sus colegas.'],
  ['No mencionar a colegas en frío', 'Nombrar a otra persona de la empresa sin permiso resta confianza.'],
];

/**
 * Suggested personas for a demand planning / supply chain analytics offer (e.g. QuantraIQ).
 * Loaded from the brand form and edited by the user.
 */
export const SUGGESTED_PERSONAS = [
  {
    name: 'Demand Planner',
    match_titles: 'demand planner, planificador de demanda, planeador de demanda, analista de demanda, analista de planeacion, analista de planificacion, s&op, s op, forecast, pronostico',
    motivation: 'Acertar el pronóstico y dejar de pasar horas consolidando Excel; ser escuchado en la reunión de S&OP con datos confiables.',
    problem: 'Mucho del pronóstico todavía se arma a mano en hojas de cálculo y cada cambio de promoción o temporada obliga a rehacerlo.',
    argument: 'Pronósticos por SKU y ubicación que se actualizan solos y explican por qué cambian, para dedicar el tiempo al análisis y no a consolidar.',
    proof: '',
    cta: '¿Te sirve que te muestre cómo se vería con una muestra de tus SKUs?',
    avoid: 'Hablar de ROI financiero o de reemplazar su trabajo.',
  },
  {
    name: 'Gerente de Supply Chain',
    match_titles: 'supply chain, cadena de suministro, cadena de abastecimiento, abastecimiento, logistica, operaciones, inventario, inventarios, compras, procurement, planeacion, planificacion',
    motivation: 'Cumplir el nivel de servicio sin inflar el inventario; menos urgencias, quiebres y compras de último minuto.',
    problem: 'Conviven faltantes en los productos que más rotan con exceso de inventario en los que no se mueven.',
    argument: 'Reposición guiada por la demanda real que sube el nivel de servicio y libera inventario lento, con alertas antes del quiebre.',
    proof: '',
    cta: '¿Tiene sentido conversar 20 minutos sobre cómo están manejando la reposición hoy?',
    avoid: 'Detalle técnico del modelo estadístico.',
  },
  {
    name: 'Director Financiero',
    match_titles: 'cfo, director financiero, gerente financiero, finanzas, vp finance, finance director, controller, contralor, tesoreria, administracion y finanzas',
    motivation: 'Liberar capital de trabajo, proteger el margen y tener previsibilidad del flujo de caja; decisiones con retorno medible.',
    problem: 'Una parte importante del capital de trabajo suele quedar inmovilizada en inventario que no rota, mientras se pierden ventas por faltantes.',
    argument: 'Reducir inventario inmovilizado sin perder ventas, con un impacto en capital de trabajo y margen que se puede medir en el primer trimestre.',
    proof: '',
    cta: '¿Vale la pena revisar en 15 minutos cuánto capital podría liberarse?',
    avoid: 'Jerga operativa (SKU, MAPE, lead time) y textos largos.',
  },
  {
    name: 'Gerente Comercial',
    match_titles: 'gerente comercial, director comercial, ventas, sales, category manager, gerente de categoria, trade marketing, key account',
    motivation: 'Vender más sin quiebres en el punto de venta y que las promociones tengan el producto disponible.',
    problem: 'Las promociones y lanzamientos pierden ventas cuando el producto no llega a tiempo o llega en la cantidad equivocada.',
    argument: 'Anticipar la demanda de cada promoción y canal para que el producto esté donde se vende.',
    proof: '',
    cta: '¿Te interesa ver cómo se anticipa la demanda de una promoción?',
    avoid: 'Hablar de costos de inventario como argumento principal.',
  },
  {
    name: 'Dirección General',
    match_titles: 'ceo, gerente general, director general, country manager, presidente, fundador, founder, owner, dueno, socio director',
    motivation: 'Crecer con rentabilidad y que las áreas tomen decisiones con la misma información.',
    problem: 'Comercial, operaciones y finanzas suelen planificar con números distintos, y eso se paga en faltantes, exceso de inventario y margen.',
    argument: 'Un solo plan de demanda compartido que alinea ventas, operaciones y finanzas, con impacto visible en margen y capital.',
    proof: '',
    cta: '¿Quién de tu equipo sería la persona indicada para conversar sobre esto?',
    avoid: 'Detalle operativo y textos largos.',
  },
];
