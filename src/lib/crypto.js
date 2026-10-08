import crypto from 'node:crypto';
import { config } from '../config.js';

/** 32-byte key from 64 hex chars or base64 of 32 bytes; any other secret is hashed with SHA-256. */
function key() {
  const raw = config.encryptionKey;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return b64;
  if (raw.length < 32) throw new Error('ENCRYPTION_KEY is too short: use at least 32 random characters');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** AES-256-GCM; output is iv.tag.ciphertext in base64url. */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, data] = String(payload).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
