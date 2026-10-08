import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { normalizeKey } from './template.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

// Common header spellings (ES/EN) mapped to the core prospect columns.
const ALIASES = {
  email: ['email', 'e_mail', 'correo', 'correo_electronico', 'email_address', 'work_email', 'mail', 'email_corporativo'],
  first_name: ['first_name', 'firstname', 'nombre', 'first', 'given_name', 'nombres'],
  last_name: ['last_name', 'lastname', 'apellido', 'apellidos', 'surname', 'family_name'],
  company: ['company', 'company_name', 'empresa', 'compania', 'organization', 'organizacion', 'account', 'razon_social'],
  title: ['title', 'job_title', 'cargo', 'puesto', 'position', 'role', 'rol'],
  industry: ['industry', 'industria', 'sector', 'vertical', 'rubro'],
  country: ['country', 'pais', 'país'],
  phone: ['phone', 'telefono', 'tel', 'celular', 'movil', 'mobile', 'phone_number', 'whatsapp'],
  linkedin_url: ['linkedin', 'linkedin_url', 'perfil_linkedin', 'linkedin_profile', 'url_linkedin'],
  source: ['source', 'fuente', 'origen', 'lead_source'],
  lawful_basis: ['lawful_basis', 'base_legal', 'consentimiento', 'consent'],
};
export const CORE_FIELDS = Object.keys(ALIASES).filter((k) => k !== 'email');

export const isValidEmail = (email) => EMAIL_RE.test(String(email || '').trim());

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

function parseCsvRows(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return parse(text, {
    columns: (headers) => headers.map(normalizeKey),
    delimiter: detectDelimiter(text),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text) return String(value.text); // hyperlink cell
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.result !== undefined) return String(value.result); // formula
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

/** First worksheet of an .xlsx file; the first non-empty row is the header. */
async function parseXlsxRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return [];
  const rows = [];
  let headers = null;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(cellText);
    if (!headers) {
      headers = values.map(normalizeKey);
      return;
    }
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = (values[i] || '').trim();
    });
    if (Object.values(obj).some(Boolean)) rows.push(obj);
  });
  return rows;
}

export function isExcel(filename = '', mimetype = '') {
  return /\.xlsx$/i.test(filename) || /spreadsheetml/.test(mimetype);
}

/** Maps raw rows (normalized headers) to prospects: core columns + custom merge fields. */
function mapRows(rows) {
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
  if (!mapping.email) throw new Error('El archivo no tiene una columna de email (email/correo).');

  const mappedHeaders = new Set(Object.values(mapping));
  const prospects = [];
  const invalid = [];
  rows.forEach((row, index) => {
    const email = String(row[mapping.email] || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      invalid.push({ row: index + 2, email, reason: 'formato de email inválido' });
      return;
    }
    const fields = {};
    for (const [key, value] of Object.entries(row)) {
      if (!mappedHeaders.has(key) && key && value !== '') fields[key] = value;
    }
    const prospect = { email, fields };
    for (const field of CORE_FIELDS) prospect[field] = mapping[field] ? row[mapping[field]] || '' : '';
    prospects.push(prospect);
  });
  return { headers, mapping, prospects, invalid };
}

/** Parses a prospects file: CSV (comma, semicolon or tab) or .xlsx (first sheet). */
export async function parseProspectsFile(buffer, { filename = '', mimetype = '' } = {}) {
  if (/\.xls$/i.test(filename)) throw new Error('Formato .xls antiguo no soportado: guarda el archivo como .xlsx o .csv.');
  return mapRows(isExcel(filename, mimetype) ? await parseXlsxRows(buffer) : parseCsvRows(buffer));
}

export const parseProspectsCsv = (buffer) => mapRows(parseCsvRows(buffer));
