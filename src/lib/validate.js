// Lead validation before anything is sent: protects sender reputation (bounces > 3%
// damage the domain) and keeps outreach on real, reachable business contacts.
import dns from 'node:dns/promises';

const ROLE_LOCAL_PARTS = new Set([
  'info', 'informacion', 'contacto', 'contact', 'hola', 'hello', 'hi', 'ventas', 'sales', 'admin', 'administracion',
  'soporte', 'support', 'ayuda', 'help', 'rrhh', 'hr', 'talento', 'jobs', 'empleo', 'careers', 'marketing', 'prensa',
  'press', 'office', 'oficina', 'recepcion', 'team', 'equipo', 'facturacion', 'billing', 'cobros', 'pagos',
  'compras', 'webmaster', 'postmaster', 'abuse', 'noreply', 'no-reply', 'no_reply', 'notificaciones', 'newsletter',
]);

export const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.es', 'ymail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
]);

/**
 * Resolves whether a domain can receive mail. Returns 'ok' | 'none' | 'unknown'.
 * 'unknown' (timeouts, resolver errors) never invalidates a lead on its own.
 */
export function createMxChecker({ resolveMx = dns.resolveMx, timeoutMs = 4000 } = {}) {
  const cache = new Map();
  return (domain) => {
    if (!cache.has(domain)) {
      const lookup = Promise.race([
        resolveMx(domain).then((records) => (records?.length ? 'ok' : 'none')),
        new Promise((resolve) => setTimeout(() => resolve('unknown'), timeoutMs).unref?.()),
      ]).catch((err) => (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code) ? 'none' : 'unknown'));
      cache.set(domain, lookup);
    }
    return cache.get(domain);
  };
}

/**
 * @returns {{ status: 'valid'|'risky'|'invalid', notes: string[] }}
 */
export async function validateLead(prospect, { mx }) {
  const notes = [];
  const [local, domain] = prospect.email.split('@');
  if (DISPOSABLE_DOMAINS.has(domain)) return { status: 'invalid', notes: ['dominio de correo desechable'] };

  const mxResult = mx ? await mx(domain) : 'unknown';
  if (mxResult === 'none') return { status: 'invalid', notes: ['el dominio no recibe correo (sin registros MX)'] };
  if (mxResult === 'unknown') notes.push('no se pudo verificar el dominio');

  if (ROLE_LOCAL_PARTS.has(local.replace(/[.+].*$/, ''))) notes.push('cuenta genérica (no es una persona)');
  if (FREE_DOMAINS.has(domain)) notes.push('correo personal, no corporativo');
  if (!prospect.first_name) notes.push('sin nombre');
  if (!prospect.company && !FREE_DOMAINS.has(domain)) notes.push('sin empresa');

  const risky = notes.some((n) => /genérica|personal|verificar/.test(n));
  return { status: risky ? 'risky' : 'valid', notes };
}

/** Validates many leads with bounded concurrency (MX lookups are cached per domain). */
export async function validateLeads(prospects, { mx = createMxChecker(), concurrency = 16 } = {}) {
  const results = new Array(prospects.length);
  let next = 0;
  async function worker() {
    while (next < prospects.length) {
      const i = next;
      next += 1;
      results[i] = await validateLead(prospects[i], { mx });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, prospects.length) }, worker));
  return results;
}

export const LAWFUL_BASES = {
  interes_legitimo: 'Interés legítimo (B2B, cargo relacionado con la oferta)',
  consentimiento: 'Consentimiento explícito',
  cliente: 'Cliente o relación comercial existente',
};
