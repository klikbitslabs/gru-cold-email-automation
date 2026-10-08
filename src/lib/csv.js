import { parse } from 'csv-parse/sync';
import { normalizeKey } from './template.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

// Common header spellings (EN/ES) mapped to the core prospect columns.
const ALIASES = {
  email: ['email', 'e_mail', 'correo', 'correo_electronico', 'email_address', 'work_email', 'mail'],
  first_name: ['first_name', 'firstname', 'nombre', 'first', 'given_name'],
  last_name: ['last_name', 'lastname', 'apellido', 'apellidos', 'surname', 'family_name'],
  company: ['company', 'company_name', 'empresa', 'compania', 'organization', 'organizacion', 'account'],
  title: ['title', 'job_title', 'cargo', 'puesto', 'position', 'role', 'rol'],
};

export const isValidEmail = (email) => EMAIL_RE.test(String(email || '').trim());

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

/**
 * Parses a prospects CSV. Every column is kept: core ones map to prospect fields,
 * the rest become custom merge fields (snake_case headers).
 */
export function parseProspectsCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const rows = parse(text, {
    columns: (headers) => headers.map(normalizeKey),
    delimiter: detectDelimiter(text),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const mapping = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const found = headers.find((h) => aliases.includes(h));
    if (found) mapping[field] = found;
  }
  if (!mapping.email) {
    const guess = headers.find((h) => rows.slice(0, 20).some((r) => isValidEmail(r[h])));
    if (guess) mapping.email = guess;
  }
  if (!mapping.email) throw new Error('El CSV no tiene una columna de email (email/correo).');

  const mappedHeaders = new Set(Object.values(mapping));
  const prospects = [];
  const invalid = [];
  rows.forEach((row, index) => {
    const email = String(row[mapping.email] || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      invalid.push({ row: index + 2, email, reason: 'email inválido' });
      return;
    }
    const fields = {};
    for (const [key, value] of Object.entries(row)) {
      if (!mappedHeaders.has(key) && key && value !== '') fields[key] = value;
    }
    prospects.push({
      email,
      first_name: mapping.first_name ? row[mapping.first_name] || '' : '',
      last_name: mapping.last_name ? row[mapping.last_name] || '' : '',
      company: mapping.company ? row[mapping.company] || '' : '',
      title: mapping.title ? row[mapping.title] || '' : '',
      fields,
    });
  });
  return { headers, mapping, prospects, invalid };
}
