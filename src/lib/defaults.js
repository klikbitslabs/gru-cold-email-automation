// Defaults for the light campaign flow: everything the user doesn't need to decide.
// 2026 standards: plain text, short, no links or open tracking, 4 touches in ~2–3 weeks,
// group approval, stop the whole account when someone replies.

const FIRST = 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}';

export const QUICK_SEQUENCE = [
  { channel: 'email', delay_days: 0, same_thread: false, variants: [{ label: 'Primer correo', angle: 'Contexto real + problema de su cargo + una pregunta', subject: 'pregunta sobre {{company}}', body: FIRST }] },
  { channel: 'email', delay_days: 3, same_thread: true, variants: [{ label: 'Seguimiento 1', angle: 'Otro ángulo del mismo problema', subject: '', body: 'Hola {{first_name}}, te escribo de nuevo por si mi correo se perdió.\n\nLo pregunto porque es un tema que suele aparecer justo cuando se planifica el próximo trimestre.\n\n{{cta}}' }] },
  { channel: 'email', delay_days: 4, same_thread: true, variants: [{ label: 'Seguimiento 2', angle: 'Algo útil, sin presión', subject: '', body: '{{first_name}}, una idea corta: en empresas parecidas a {{company}} el primer paso suele ser revisar dónde se pierde más tiempo o dinero en este proceso.\n\n{{cta}}' }] },
  { channel: 'email', delay_days: 5, same_thread: true, variants: [{ label: 'Cierre', angle: 'Cierre respetuoso y fácil de responder', subject: '', body: '{{first_name}}, no quiero llenar tu bandeja. Si no es prioridad ahora, lo dejo aquí.\n\n¿Lo retomamos más adelante?' }] },
];

export const QUICK_HOOKS = [{ label: 'Cargo', description: 'Contexto real de su cargo', text: 'Vi que en {{company}} trabajas como {{title}}.' }];
export const QUICK_PROBLEMS = [{ label: 'Genérico', description: 'Se reemplaza por el problema del perfil de comprador', text: 'En empresas parecidas vemos que este proceso consume más tiempo y dinero del que debería.' }];
export const QUICK_CTAS = [{ label: 'Interés', description: 'Baja fricción', text: '¿Tiene sentido que lo conversemos?' }];

const WEEKDAYS = { on: true, start: '08:00', end: '17:00' };
export const QUICK_SCHEDULE = { 1: WEEKDAYS, 2: WEEKDAYS, 3: WEEKDAYS, 4: WEEKDAYS, 5: WEEKDAYS, 6: { on: false, start: '09:00', end: '13:00' }, 7: { on: false, start: '09:00', end: '13:00' } };

export const QUICK_SETTINGS = {
  approval_mode: 'group',
  group_by: 'industry_persona',
  track_opens: false,
  include_unsubscribe: true,
  jev_enabled: true,
  stop_on_reply: true,
  max_per_day: 150,
  delay_minutes: 2,
  max_contacts_per_company: 3,
  company_gap_days: 2,
  stop_on_company_reply: true,
};
