import crypto from 'node:crypto';

// RFC 2047 encoded-word for non-ASCII header values.
export function encodeHeader(value) {
  const str = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

export function formatAddress(name, email) {
  if (!name) return email;
  const safe = String(name).replace(/["\\\r\n]/g, '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(safe) ? `"${safe}" <${email}>` : `${encodeHeader(safe)} <${email}>`;
}

const b64Lines = (str) => Buffer.from(str, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

/** Builds a multipart/alternative RFC 5322 message, ready for the Gmail API `raw` field. */
export function buildMime({ from, to, subject, text, html, inReplyTo, references, headers = {} }) {
  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  for (const [k, v] of Object.entries(headers)) {
    if (v) lines.push(`${k}: ${String(v).replace(/[\r\n]/g, '')}`);
  }
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
  lines.push(
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(html),
    `--${boundary}--`,
    '',
  );
  return lines.join('\r\n');
}

export const toBase64Url = (str) => Buffer.from(str, 'utf8').toString('base64url');
