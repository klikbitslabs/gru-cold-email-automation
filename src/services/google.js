import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { integrations } from './settings.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  // Send as the Workspace user.
  'https://www.googleapis.com/auth/gmail.send',
  // Read threads to detect replies/bounces and import the Gmail signature.
  'https://www.googleapis.com/auth/gmail.readonly',
];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const redirectUri = () => `${config.baseUrl}/api/senders/google/callback`;

function oauthClient() {
  const { clientId, clientSecret } = integrations.google();
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: redirectUri(),
  });
}

export function getAuthUrl(state, loginHint) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    // Force consent so Google always returns a refresh token.
    prompt: 'consent',
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
    login_hint: loginHint || undefined,
  });
}

/** Exchanges the OAuth code; returns the refresh token and the verified identity. */
export async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google no devolvió refresh token. Revoca el acceso y vuelve a conectar.');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: integrations.google().clientId });
  const payload = ticket.getPayload();
  return {
    refreshToken: tokens.refresh_token,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified,
    name: payload.name || '',
    hostedDomain: payload.hd || null,
  };
}

/** Checks the account is an allowed Google Workspace (G Suite) mailbox. */
export function validateWorkspaceAccount({ hostedDomain, emailVerified }) {
  if (!emailVerified) return 'El email de Google no está verificado.';
  const google = integrations.google();
  if (!hostedDomain && !google.allowConsumerGmail) {
    return 'Solo se aceptan cuentas de Google Workspace (G Suite). Las cuentas @gmail.com están deshabilitadas (ALLOW_CONSUMER_GMAIL).';
  }
  const allowed = google.allowedDomains;
  if (hostedDomain && allowed.length && !allowed.includes(hostedDomain.toLowerCase())) {
    return `El dominio ${hostedDomain} no está en ALLOWED_GOOGLE_DOMAINS.`;
  }
  return null;
}

/** Thin Gmail REST client for one sender mailbox. */
export function gmailForRefreshToken(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const call = async (url, options = {}) => (await client.request({ url, ...options })).data;

  return {
    async send({ raw, threadId }) {
      return call(`${GMAIL}/messages/send`, { method: 'POST', data: { raw, threadId: threadId || undefined } });
    },
    async getMessageIdHeader(messageId) {
      const msg = await call(`${GMAIL}/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`);
      const header = (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === 'message-id');
      return header?.value || null;
    },
    /** Returns [{ id, from, labelIds, snippet }] for every message in the thread. */
    async getThread(threadId) {
      const thread = await call(`${GMAIL}/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      return (thread.messages || []).map((m) => ({
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds || [],
        snippet: m.snippet || '',
        from: (m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'from')?.value || '',
      }));
    },
    /** Messages matching a Gmail search query, with From + snippet (used to catch replies in new threads). */
    async searchMessages(q, max = 10) {
      const list = await call(`${GMAIL}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
      const out = [];
      for (const { id } of list.messages || []) {
        const m = await call(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From`);
        out.push({
          id: m.id,
          threadId: m.threadId,
          labelIds: m.labelIds || [],
          snippet: m.snippet || '',
          from: (m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'from')?.value || '',
        });
      }
      return out;
    },
    async getSignature(email) {
      const res = await call(`${GMAIL}/settings/sendAs`);
      const entry = (res.sendAs || []).find((s) => s.sendAsEmail?.toLowerCase() === email.toLowerCase()) ||
        (res.sendAs || []).find((s) => s.isPrimary);
      return entry?.signature || '';
    },
  };
}

export const extractEmail = (fromHeader) => {
  const match = String(fromHeader).match(/<([^>]+)>/);
  return (match ? match[1] : String(fromHeader)).trim().toLowerCase();
};
