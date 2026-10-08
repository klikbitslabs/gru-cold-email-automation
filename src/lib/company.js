// Account (company) identity for a lead: corporate email domain first, then normalized name.
import { normalizeKey } from './template.js';
import { FREE_DOMAINS } from './validate.js';

export function companyIdentity(prospect) {
  const domain = String(prospect.email || '').split('@')[1]?.toLowerCase() || '';
  if (domain && !FREE_DOMAINS.has(domain)) return { key: `d:${domain}`, domain };
  const name = normalizeKey(prospect.company || '');
  if (name) return { key: `n:${name}`, domain: '' };
  return null; // personal address without company: not grouped
}

/** Finds or creates the company row for a lead; returns its id (or null). */
export function upsertCompany(db, userId, prospect) {
  const identity = companyIdentity(prospect);
  if (!identity) return null;
  const existing = db.prepare('SELECT * FROM companies WHERE user_id = ? AND key = ?').get(userId, identity.key);
  if (existing) {
    // Fill gaps with the best data seen so far.
    if ((!existing.name && prospect.company) || (!existing.industry && prospect.industry)) {
      db.prepare('UPDATE companies SET name = COALESCE(NULLIF(name, \'\'), ?), industry = COALESCE(NULLIF(industry, \'\'), ?) WHERE id = ?')
        .run(prospect.company || '', prospect.industry || '', existing.id);
    }
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO companies (user_id, key, name, domain, industry) VALUES (?, ?, ?, ?, ?)')
    .run(userId, identity.key, prospect.company || identity.domain, identity.domain, prospect.industry || '').lastInsertRowid);
}
