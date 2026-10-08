// Merge-field rendering for plain-text cold emails.
// Syntax: {{field}} or {{field|fallback}}. Field names are snake_case CSV headers
// (e.g. "First Name" -> first_name). Unknown fields with no fallback render empty
// and are reported, so the scheduler can refuse to send a broken email.

const FIELD_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;

export function normalizeKey(header) {
  return String(header)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Builds the variable map available to templates for a prospect. */
export function prospectVariables(prospect, extra = {}) {
  let custom = {};
  try {
    custom = JSON.parse(prospect.fields_json || '{}');
  } catch {
    custom = {};
  }
  const vars = { ...custom };
  for (const key of ['email', 'first_name', 'last_name', 'company', 'title', 'industry', 'country', 'phone', 'linkedin_url']) {
    if (prospect[key]) vars[key] = prospect[key];
  }
  vars.full_name = [vars.first_name, vars.last_name].filter(Boolean).join(' ');
  return { ...vars, ...extra };
}

/** Renders {{fields}}; returns the text and the list of fields that were missing. */
export function renderTemplate(template, vars) {
  const missing = new Set();
  const text = String(template ?? '').replace(FIELD_RE, (_, name, fallback) => {
    const value = vars[normalizeKey(name)];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return '';
  });
  return { text: tidy(text), missing: [...missing] };
}

function tidy(text) {
  return text
    .replace(/[ \t]+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function templateFields(template) {
  return [...String(template ?? '').matchAll(FIELD_RE)].map((m) => normalizeKey(m[1]));
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Plain text -> minimal HTML that still looks like a personal email (no heavy markup). */
export function textToHtml(text) {
  return escapeHtml(text)
    .replace(URL_RE, (url) => `<a href="${url}">${url}</a>`)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Very small HTML -> text conversion for signatures in the text/plain part. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, label) =>
      label.replace(/<[^>]+>/g, '') === href ? href : `${label.replace(/<[^>]+>/g, '')} (${href})`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes scripts, event handlers and javascript: URLs from user-provided signature HTML. */
export function sanitizeSignature(html) {
  return String(html ?? '')
    .replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|meta|link)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .slice(0, 20000);
}

/**
 * Assembles the final email parts.
 * @returns {{ text: string, html: string }}
 */
export function buildEmailBody({ body, signatureHtml, trackingPixelUrl, unsubscribeUrl, quoted }) {
  const sigText = htmlToText(signatureHtml);
  let text = body;
  if (sigText) text += `\n\n${sigText}`;
  if (unsubscribeUrl) text += `\n\n--\nSi no quieres recibir más correos: ${unsubscribeUrl}`;

  let html = `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${textToHtml(body)}`;
  if (signatureHtml) html += `<div class="gmail_signature" style="margin-top:12px">${signatureHtml}</div>`;
  if (unsubscribeUrl) {
    html += `<p style="margin-top:24px;font-size:11px;color:#888">¿No es relevante? <a style="color:#888" href="${escapeHtml(unsubscribeUrl)}">No recibir más correos</a></p>`;
  }
  if (quoted) {
    html += `<div class="gmail_quote" style="margin-top:16px"><div style="color:#666">${escapeHtml(quoted.header)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(quoted.text)}</blockquote></div>`;
    text += `\n\n${quoted.header}\n${quoted.text.split('\n').map((l) => `> ${l}`).join('\n')}`;
  }
  if (trackingPixelUrl) {
    html += `<img src="${escapeHtml(trackingPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
  }
  html += '</div>';
  return { text, html };
}

/**
 * True when every field referenced by `template` has a real value for this prospect.
 * Used to only offer personalization hooks that are verifiable (no fallbacks, no blanks).
 */
export function allFieldsPresent(template, vars) {
  return [...String(template ?? '').matchAll(FIELD_RE)].every((m) => {
    const value = vars[normalizeKey(m[1])];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}
