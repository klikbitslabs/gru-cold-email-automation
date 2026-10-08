// GRU Outreach — single page app (no build step). All dynamic values go through esc().

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [7, 'Dom']];
const STATUS_LABEL = {
  draft: 'Borrador', active: 'Activa', paused: 'Pausada', completed: 'Completada', error: 'Error',
  replied: 'Respondió', bounced: 'Rebotó', unsubscribed: 'Baja', finished: 'Secuencia terminada', stopped: 'Detenido',
};
const REPLY_LABEL = { interested: 'Interesado', not_interested: 'No interesado', referral: 'Referido', question: 'Pregunta/neutral', auto_reply: 'Auto-respuesta', bounce: 'Rebote' };
const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

let meta = {};
let currentUser = null;

// ---------------------------------------------------------------------------
// API + UI helpers
// ---------------------------------------------------------------------------
const token = {
  get: () => localStorage.getItem('gru_token'),
  set: (t) => localStorage.setItem('gru_token', t),
  clear: () => localStorage.removeItem('gru_token'),
};

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (token.get()) headers.Authorization = `Bearer ${token.get()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    token.clear();
    location.hash = '#/login';
    throw new Error('Sesión expirada');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3000);
}

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  return $('#modal-body');
}
function closeModal() { $('#modal').hidden = true; }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/** Runs an async action with a disabled button and error toast. */
async function guard(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/register$/, viewRegister],
  [/^#\/campaigns$/, viewCampaigns],
  [/^#\/campaigns\/(\d+)(?:\/(\w+))?$/, viewCampaign],
  [/^#\/senders/, viewSenders],
  [/^#\/tasks$/, viewTasks],
  [/^#\/integrations$/, viewIntegrations],
  [/^#\/brands/, viewBrands],
  [/^#\/companies/, viewCompanies],
  [/^#\/guide$/, viewGuide],
];

async function router() {
  const hash = location.hash || '#/campaigns';
  const isAuthPage = /^#\/(login|register)/.test(hash);
  if (!token.get() && !isAuthPage) { location.hash = '#/login'; return; }
  if (token.get() && !currentUser && !isAuthPage) {
    try {
      currentUser = (await api('/auth/me')).user;
    } catch { return; }
  }
  $('#topbar').hidden = isAuthPage;
  if (!isAuthPage) {
    $('#user-email').textContent = currentUser?.email || '';
    $('#nav-integrations').hidden = !currentUser?.is_admin;
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));
    const jev = $('#jev-badge');
    jev.textContent = meta.jev_configured ? `Jev activo · ${meta.jev_model}` : 'Jev sin API key · reglas';
    jev.className = `badge ${meta.jev_configured ? 'ok' : 'warn'}`;
    jev.title = meta.jev_configured ? 'Las decisiones usan TypeSafe Jev' : 'Carga la API key de Jev en Integraciones';
  }
  const path = hash.split('?')[0];
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (m) {
      app.innerHTML = '<p class="muted">Cargando…</p>';
      try {
        await view(...m.slice(1));
      } catch (err) {
        app.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
      }
      return;
    }
  }
  location.hash = '#/campaigns';
}
window.addEventListener('hashchange', router);
function syncThemeButton() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('#theme-toggle').textContent = dark ? '☀️' : '🌙';
  $('#theme-toggle').title = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
}
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('gru_theme', next); } catch { /* ignore */ }
  syncThemeButton();
});
syncThemeButton();
$('#logout').addEventListener('click', () => { token.clear(); currentUser = null; location.hash = '#/login'; });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function authForm({ title, submit, register }) {
  app.innerHTML = `
    <div class="auth card">
      <h1>GRU <span style="color:var(--accent)">Outreach</span></h1>
      <p class="muted">${esc(title)}</p>
      <form id="auth-form" class="stack">
        ${register ? '<div><label for="name">Nombre</label><input id="name" type="text" autocomplete="name"></div>' : ''}
        <div><label for="email">Correo</label><input id="email" type="email" required autocomplete="email"></div>
        <div><label for="password">Contraseña <span class="hint">${register ? '(mín. 8 caracteres)' : ''}</span></label>
          <input id="password" type="password" required minlength="${register ? 8 : 1}" autocomplete="${register ? 'new-password' : 'current-password'}"></div>
        <button class="btn" type="submit">${esc(submit)}</button>
      </form>
      <p class="small muted" style="margin-top:14px">${register ? '¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a>' : (meta.allow_registration ? '¿No tienes cuenta? <a href="#/register">Regístrate</a>' : '')}</p>
    </div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await guard(e.submitter, async () => {
      const body = { email: $('#email').value, password: $('#password').value };
      if (register) body.name = $('#name').value;
      const res = await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body });
      token.set(res.token);
      currentUser = res.user;
      location.hash = '#/campaigns';
    });
  });
}
function viewLogin() { authForm({ title: 'Inicia sesión para gestionar tus secuencias', submit: 'Entrar' }); }
function viewRegister() { authForm({ title: 'Crea tu cuenta', submit: 'Crear cuenta', register: true }); }

// ---------------------------------------------------------------------------
// Campaign list
// ---------------------------------------------------------------------------
const CHANNEL_LABEL = { email: 'Correo', call: 'Llamada (cold call)', linkedin: 'LinkedIn' };
const OUTCOME_LABEL = { interested: 'Interesado', meeting: 'Reunión', opportunity: 'Oportunidad', won: 'Cierre ganado', lost: 'Perdido' };
const VALIDATION_LABEL = { valid: 'Válido', risky: 'Riesgoso', invalid: 'Inválido' };
const APPROVAL_LABEL = {
  first: 'Aprobar el primer correo de cada prospecto (y cualquiera con advertencias)',
  all: 'Aprobar todos los correos',
  issues: 'Aprobar solo los que tengan advertencias de calidad',
  none: 'Envío automático (solo se detienen los que tengan errores)',
};
const ENGINE_LABEL = { jev: 'Jev', rules: 'reglas' };
const engineLabel = (e) => ENGINE_LABEL[e] || e || '—';
const LEAD_LABEL = { ready: 'Apto', research: 'Requiere investigación', excluded: 'Excluido' };
const leadBadge = (l) => `<span class="badge ${l === 'ready' ? 'ok' : l === 'research' ? 'warn' : 'bad'}">${esc(LEAD_LABEL[l] || l)}</span>`;
const validationBadge = (v) => `<span class="badge ${v === 'valid' ? 'ok' : v === 'risky' ? 'warn' : 'bad'}">${esc(VALIDATION_LABEL[v] || v)}</span>`;

async function viewCampaigns() {
  const { campaigns } = await api('/campaigns');
  app.innerHTML = `
    <div class="row between"><div><h1>Campañas</h1><p class="muted">Importación → validación → inteligencia comercial → generación y aprobación → orquestación → resultados.</p></div>
      <button class="btn" id="new-campaign">+ Nueva campaña</button></div>
    ${campaigns.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Campaña</th><th>Estado</th><th>Prospectos</th><th>Por aprobar</th><th>Tareas</th><th>Respuesta</th><th>Reuniones</th><th>Cierres</th></tr></thead>
      <tbody>${campaigns.map((c) => `
        <tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${badge(c.status)}</td>
        <td>${c.stats.prospects} <span class="muted small">(${c.stats.active} activos)</span></td>
        <td>${c.stats.pending_approval ? `<span class="badge warn">${c.stats.pending_approval}</span>` : '0'}</td><td>${c.stats.open_tasks}</td>
        <td>${c.stats.reply_rate}%</td><td>${c.stats.meetings}</td><td>${c.stats.won}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card empty"><p>Aún no tienes campañas.</p><p>1) Conecta un sender de Google Workspace · 2) Crea la campaña · 3) Importa tu base · 4) Revisa y aprueba · 5) Activa.</p></div>'}`;
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/campaigns/${tr.dataset.id}`; }));
  $('#new-campaign').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    const { campaign } = await api('/campaigns', { method: 'POST', body: defaultCampaign() });
    location.hash = `#/campaigns/${campaign.id}`;
  }));
}

function defaultCampaign() {
  const body = 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}';
  return {
    name: `Campaña ${new Date().toLocaleDateString('es')}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Panama',
    approval_mode: 'all',
    segments: [],
    steps: [
      { channel: 'email', variants: [
        { label: 'A · Cargo', angle: 'Asunto centrado en el cargo de la persona', subject: 'pregunta sobre tu rol en {{company}}', body },
        { label: 'B · Empresa', angle: 'Asunto centrado en la empresa', subject: 'idea para el equipo de {{company}}', body },
      ] },
      { channel: 'email', delay_days: 3, same_thread: true, variants: [{ label: 'Prueba social', angle: 'Resultado medible de un cliente parecido', subject: '', body: '{{first_name}}, por contexto: un equipo parecido al de {{company}} redujo a la mitad el tiempo de prospección en un mes.\n\n{{cta}}' }] },
      { channel: 'call', delay_days: 2, variants: [{ label: 'Guion de llamada', body: 'Llamar a {{first_name}} ({{title}} en {{company}}). Referenciar el correo enviado. Objetivo: validar el problema y proponer 15 minutos.' }] },
      { channel: 'email', delay_days: 4, same_thread: true, variants: [{ label: 'Cierre', angle: 'Cierre respetuoso y fácil de responder', subject: '', body: '{{first_name}}, no quiero llenar tu bandeja. Si no es prioridad ahora, lo dejo aquí.\n\n¿Lo retomamos más adelante?' }] },
    ],
    hooks: [
      { label: 'Responsabilidad', description: 'Contexto real de su cargo y responsabilidad', text: 'Como {{title}} en {{company}}, imagino que buena parte de tu semana se va en coordinar al equipo y sus metas.' },
    ],
    problems: [
      { label: 'Prospección manual', description: 'El equipo pierde tiempo investigando leads a mano', text: 'En equipos parecidos vemos que se pierden varias horas por semana investigando prospectos a mano antes de cada contacto.' },
    ],
    ctas: [
      { label: 'Interés', description: 'Baja fricción: solo confirmar interés. Para prospectos sin interacción.', text: '¿Tiene sentido que te comparta cómo lo resolvieron?' },
      { label: 'Recurso', description: 'Ofrecer un recurso útil sin pedir reunión.', text: '¿Te envío un resumen de una página?' },
      { label: 'Llamada', description: 'Pedido directo de reunión corta. Solo para prospectos que abrieron varias veces o encajan muy bien.', text: '¿Te parece si lo vemos 15 minutos esta semana?' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Campaign detail (tabs)
// ---------------------------------------------------------------------------
const TABS = [['sequence', 'Secuencia'], ['library', 'Personalización'], ['settings', 'Configuración'], ['rules', 'Reglas de envío'], ['prospects', 'Prospectos'], ['approval', 'Aprobación'], ['ab', 'Pruebas A/B'], ['results', 'Resultados']];

async function viewCampaign(id, tab = 'sequence') {
  const [{ campaign, readiness }, { senders }, { brands }] = await Promise.all([api(`/campaigns/${id}`), api('/senders'), api('/brands')]);
  const canRun = campaign.status !== 'active';
  const s = campaign.stats;
  app.innerHTML = `
    <div class="row between">
      <div><a href="#/campaigns" class="small">← Campañas</a><h1>${esc(campaign.name)} ${badge(campaign.status)} ${campaign.brand ? `<span class="badge">${esc(campaign.brand.name)}</span>` : ''}</h1>
        <p class="muted small">${s.prospects} prospectos · ${s.sent} correos · ${s.reply_rate}% respuesta · ${s.meetings} reuniones · ${s.won} cierres</p></div>
      <div class="row">
        <button class="btn ${canRun ? 'ok' : 'ghost'}" id="toggle-status">${canRun ? '▶ Activar' : '⏸ Pausar'}</button>
        <button class="btn ghost" id="run-now" title="Ejecuta ahora: análisis, borradores y envíos (respeta ventanas y límites)">Procesar ahora</button>
        <button class="btn danger small" id="delete-campaign">Eliminar</button>
      </div>
    </div>
    ${readiness.problems.length ? `<div class="notice"><b>Antes de activar:</b><ul>${readiness.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    ${readiness.recommendations.length ? `<details class="notice info"><summary>${readiness.recommendations.length} recomendación(es)</summary><ul>${readiness.recommendations.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
    <div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}${k === 'approval' && s.pending_approval ? ` <span class="badge warn">${s.pending_approval}</span>` : ''}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/campaigns/${id}/${b.dataset.tab}`; }));
  $('#toggle-status').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    await api(`/campaigns/${id}/status`, { method: 'POST', body: { status: canRun ? 'active' : 'paused' } });
    toast(canRun ? 'Campaña activada' : 'Campaña pausada');
    router();
  }));
  $('#run-now').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    const r = await api('/scheduler/run', { method: 'POST' });
    toast(r.skipped ? 'El proceso ya está corriendo' : `Analizados: ${r.analyzed} · enviados: ${r.sent}`);
    router();
  }));
  $('#delete-campaign').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    if (!confirm('¿Eliminar la campaña con sus prospectos y resultados?')) return;
    await api(`/campaigns/${id}`, { method: 'DELETE' });
    location.hash = '#/campaigns';
  }));

  const el = $('#tab');
  if (tab === 'library') return renderLibrary(el, campaign);
  if (tab === 'settings') return renderSettings(el, campaign, senders, brands);
  if (tab === 'rules') return renderRules(el, campaign);
  if (tab === 'ab') return renderAB(el, campaign);
  if (tab === 'prospects') return renderProspects(el, campaign);
  if (tab === 'approval') return renderApproval(el, campaign);
  if (tab === 'results') return renderResults(el, campaign);
  return renderSequence(el, campaign);
}

function campaignPayload(c) {
  const snippet = ({ id, label, description, segment, text }) => ({ id, label, description, segment: segment || '', text });
  return {
    name: c.name, offer: c.offer, icp: c.icp, timezone: c.timezone, send_days: c.send_days,
    window_start: c.window_start, window_end: c.window_end, track_opens: c.track_opens,
    include_unsubscribe: c.include_unsubscribe, jev_enabled: c.jev_enabled, stop_on_reply: c.stop_on_reply,
    approval_mode: c.approval_mode, sender_ids: c.sender_ids, brand_id: c.brand_id || null,
    schedule: c.schedule, max_per_day: Number(c.max_per_day), delay_minutes: Number(c.delay_minutes),
    max_contacts_per_company: Number(c.max_contacts_per_company), company_gap_days: Number(c.company_gap_days),
    stop_on_company_reply: Boolean(c.stop_on_company_reply),
    segments: c.segments.map(({ id, name, description }) => ({ id, name, description })),
    steps: c.steps.map((s) => ({
      channel: s.channel, delay_days: Number(s.delay_days) || 0, same_thread: s.same_thread,
      variants: s.variants.map(({ id, status, origin, rationale, label, angle, segment, subject, body }) => ({ id, status: status || 'active', origin: origin || 'manual', rationale: rationale || '', label, angle: angle || '', segment: segment || '', subject: subject || '', body })),
    })),
    hooks: c.hooks.map(snippet),
    problems: c.problems.map(snippet),
    ctas: c.ctas.map(({ id, label, description, text }) => ({ id, label, description, text })),
  };
}

async function saveCampaign(c, button) {
  return guard(button, async () => {
    const res = await api(`/campaigns/${c.id}`, { method: 'PUT', body: campaignPayload(c) });
    toast(res.warning || 'Guardado', res.warning ? 'error' : 'info');
    return res.campaign;
  });
}

const segmentOptions = (segments, current) => `<option value="">Todos los segmentos</option>${segments.map((sg) => `<option ${sg.name === current ? 'selected' : ''}>${esc(sg.name)}</option>`).join('')}`;

function issuesHtml(issues, okText) {
  if (!issues.length) return `<ul class="lint ok"><li>✓ ${esc(okText)}</li></ul>`;
  const icon = { error: '⛔', warning: '⚠️', info: 'ℹ️' };
  return `<ul class="lint">${issues.map((i) => `<li class="sev-${i.severity}">${icon[i.severity] || ''} ${esc(i.message)}</li>`).join('')}</ul>`;
}

// --- Sequence editor ---------------------------------------------------------
async function renderSequence(el, campaign) {
  const c = structuredClone(campaign);
  let lastField = null;
  const fields = await api(`/campaigns/${c.id}/prospects?page=1`).then((r) => r.merge_fields).catch(() => []);
  const emailCount = () => c.steps.filter((s) => s.channel === 'email').length;

  function draw() {
    el.innerHTML = `
      <div class="card">
        <h2>Campos de personalización</h2>
        <p class="muted small">Estructura recomendada del primer correo: <code>{{gancho}}</code> (contexto real de la persona) → <code>{{problema}}</code> (hipótesis) → <code>{{cta}}</code> (una sola acción). Jev elige el gancho, el problema y el CTA de la pestaña <b>Personalización</b>; un gancho solo se usa si todos sus datos existen para ese prospecto. Usa <code>{{campo|alternativa}}</code> para datos opcionales.</p>
        <div class="chips">${[...new Set(fields)].map((f) => `<button class="chip" data-field="${esc(f)}">{{${esc(f)}}}</button>`).join('')}</div>
      </div>
      ${c.steps.map((s, i) => stepHtml(s, i)).join('')}
      <div class="row">
        ${c.steps.length < (meta.max_total_steps || 7) ? `<button class="btn ghost" data-add-step="email" ${emailCount() >= meta.max_steps ? 'disabled' : ''}>+ Correo de seguimiento</button>
          <button class="btn ghost" data-add-step="call">+ Tarea de llamada</button>
          <button class="btn ghost" data-add-step="linkedin">+ Tarea de LinkedIn</button>` : ''}
        <span class="muted small">${emailCount()}/${meta.max_steps} correos (buena práctica: ~4 toques por email).</span>
      </div>
      <div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0"><button class="btn" id="save">Guardar secuencia</button></div>`;
    bind();
    $$('[data-variant]', el).forEach((v) => lint(v));
  }

  function stepHtml(s, i) {
    const n = i + 1;
    const email = s.channel === 'email';
    const needsSubject = email && (n === 1 || !s.same_thread);
    return `<div class="card step ${email ? '' : 'step-task'}" data-step="${i}">
      <div class="step-head"><div class="step-num">${n}</div>
        <b>${email ? (n === 1 ? 'Primer correo' : 'Correo de seguimiento') : CHANNEL_LABEL[s.channel]}</b>
        ${n > 1 ? `<label class="check">Esperar <input type="number" min="1" max="60" style="width:70px" data-step-k="delay_days" value="${esc(s.delay_days)}"> días después del paso anterior</label>` : ''}
        ${email && n > 1 ? `<label class="check"><input type="checkbox" data-step-k="same_thread" ${s.same_thread ? 'checked' : ''}> En el mismo hilo (Re:)</label>` : ''}
        ${n > 1 ? `<button class="btn danger small" data-remove-step="${i}">Quitar paso</button>` : ''}
      </div>
      <p class="muted small">${email
        ? (n === 1 ? 'Crea 2–3 variantes por segmento: Jev elige la mejor para cada prospecto y aprende de los resultados.' : 'Variantes = ángulos distintos. Jev elige según perfil e interacción.')
        : 'Genera una tarea con este guion para una persona del equipo; la secuencia continúa al marcarla como hecha.'}</p>
      ${s.variants.map((v, j) => `
        <div class="variant ${v.status === 'proposed' ? 'variant-proposed' : v.status === 'paused' ? 'variant-paused' : ''}" data-variant="${j}">
          ${v.status && v.status !== 'active' || v.origin === 'ai' ? `<div class="row between small" style="margin-bottom:8px">
            <span>${v.origin === 'ai' ? '<span class="badge">IA</span> ' : ''}${v.status === 'proposed' ? '<span class="badge warn">Propuesta: no se envía hasta que la apruebes</span>' : v.status === 'paused' ? '<span class="badge">Pausada (fuera del A/B)</span>' : ''}${v.rationale ? ` <span class="muted">Hipótesis: ${esc(v.rationale)}</span>` : ''}</span>
            ${v.id && v.status === 'proposed' ? `<span class="row"><button class="btn ok small" data-variant-act="approve" data-vid="${v.id}">Aprobar</button><button class="btn danger small" data-variant-act="reject" data-vid="${v.id}">Descartar</button></span>` : ''}
            ${v.id && v.status === 'paused' ? `<button class="btn ghost small" data-variant-act="activate" data-vid="${v.id}">Reactivar</button>` : ''}
          </div>` : ''}
          <div class="grid3">
            <div><label>Nombre</label><input type="text" data-k="label" value="${esc(v.label)}"></div>
            ${email ? `<div><label>Ángulo <span class="hint">(lo lee Jev)</span></label><input type="text" data-k="angle" value="${esc(v.angle)}"></div>` : ''}
            ${c.segments.length ? `<div><label>Segmento</label><select data-k="segment">${segmentOptions(c.segments, v.segment)}</select></div>` : ''}
          </div>
          ${needsSubject ? `<div style="margin-top:8px"><label>Asunto <span class="hint">(3–7 palabras, conversacional, sin emojis)</span></label><input type="text" data-k="subject" data-lint value="${esc(v.subject)}"></div>` : ''}
          <div style="margin-top:8px"><label>${email ? `Cuerpo <span class="hint">(45–85 palabras renderizado; 3 párrafos; una acción)</span>` : 'Guion / mensaje'}</label>
            <textarea data-k="body" data-lint>${esc(v.body)}</textarea></div>
          <div data-lint-out></div>
          <div class="row" style="margin-top:6px">
            ${v.id ? `<button class="btn ghost small" data-preview="${v.id}" data-step-number="${n}">Vista previa con un prospecto</button>` : '<span class="muted small">Guarda para ver la vista previa</span>'}
            ${s.variants.length > 1 ? `<button class="btn danger small" data-remove-variant="${j}">Quitar variante</button>` : ''}
          </div>
        </div>`).join('')}
      <div class="row" style="margin-top:10px">
        ${s.variants.length < 12 ? '<button class="btn ghost small" data-add-variant>+ Variante</button>' : ''}
        ${s.id ? `<button class="btn ghost small" data-ai-step="${n}" ${meta.openai_configured && c.brand_id ? '' : `disabled title="${meta.openai_configured ? 'Asigna una marca a la campaña' : 'Configura OpenAI en Integraciones'}"`}>✨ Proponer variantes con IA</button>
          ${c.segments.length ? `<select data-ai-segment="${n}" style="width:auto">${segmentOptions(c.segments, '')}</select>` : ''}` : ''}
      </div>
    </div>`;
  }

  const lintTimers = new Map();
  function lint(variantEl) {
    const stepEl = variantEl.closest('[data-step]');
    const stepIndex = Number(stepEl.dataset.step);
    const step = c.steps[stepIndex];
    const out = $('[data-lint-out]', variantEl);
    if (step.channel !== 'email') { out.innerHTML = ''; return; }
    const v = step.variants[Number(variantEl.dataset.variant)];
    clearTimeout(lintTimers.get(variantEl));
    lintTimers.set(variantEl, setTimeout(async () => {
      const r = await api('/lint', { method: 'POST', body: { subject: v.subject || '', body: v.body || '', step_number: stepIndex + 1, thread_reply: stepIndex > 0 && step.same_thread } }).catch(() => null);
      if (r) out.innerHTML = issuesHtml(r.issues, 'La plantilla cumple las reglas (el largo final se revisa por prospecto)');
    }, 350));
  }

  function bind() {
    $$('[data-step]', el).forEach((stepEl) => {
      const s = c.steps[Number(stepEl.dataset.step)];
      $$('[data-step-k]', stepEl).forEach((inp) => inp.addEventListener('change', () => {
        s[inp.dataset.stepK] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
        if (inp.type === 'checkbox') draw();
      }));
      $$('[data-variant]', stepEl).forEach((vEl) => {
        const v = s.variants[Number(vEl.dataset.variant)];
        $$('[data-k]', vEl).forEach((inp) => {
          inp.addEventListener('focus', () => { if (inp.tagName !== 'SELECT') lastField = inp; });
          inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => { v[inp.dataset.k] = inp.value; if (inp.hasAttribute('data-lint')) lint(vEl); });
        });
      });
      $$('[data-remove-variant]', stepEl).forEach((b) => b.addEventListener('click', () => { s.variants.splice(Number(b.dataset.removeVariant), 1); draw(); }));
      $('[data-add-variant]', stepEl)?.addEventListener('click', () => {
        const base = s.variants[0];
        s.variants.push({ label: `${String.fromCharCode(65 + s.variants.length)} · nueva`, angle: '', segment: base.segment, subject: base.subject, body: base.body });
        draw();
      });
    });
    $$('[data-remove-step]', el).forEach((b) => b.addEventListener('click', () => { c.steps.splice(Number(b.dataset.removeStep), 1); draw(); }));
    $$('[data-add-step]', el).forEach((b) => b.addEventListener('click', () => {
      const channel = b.dataset.addStep;
      const body = channel === 'email' ? '{{first_name}}, \n\n{{cta}}'
        : channel === 'call' ? 'Llamar a {{first_name}} ({{title}} en {{company}}). Referenciar el último correo.'
          : 'Visitar el perfil de {{first_name}} y enviar invitación con nota breve (máx. 300 caracteres) mencionando {{company}}.';
      c.steps.push({ channel, delay_days: channel === 'email' ? 3 : 2, same_thread: true, variants: [{ label: channel === 'email' ? 'A' : 'Guion', angle: '', segment: '', subject: '', body }] });
      draw();
    }));
    $$('[data-field]', el).forEach((chip) => chip.addEventListener('click', () => {
      if (!lastField) return toast('Primero haz clic en un asunto o cuerpo');
      const tag = `{{${chip.dataset.field}}}`;
      const { selectionStart: a = lastField.value.length, selectionEnd: b = a } = lastField;
      lastField.value = lastField.value.slice(0, a) + tag + lastField.value.slice(b);
      lastField.dispatchEvent(new Event('input'));
      lastField.focus();
      lastField.setSelectionRange(a + tag.length, a + tag.length);
    }));
    $$('[data-preview]', el).forEach((b) => b.addEventListener('click', () => guard(b, () => showPreview(c, Number(b.dataset.stepNumber), Number(b.dataset.preview)))));
    $$('[data-variant-act]', el).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      await api(`/variants/${b.dataset.vid}/${b.dataset.variantAct}`, { method: 'POST', body: {} });
      toast(b.dataset.variantAct === 'approve' ? 'Variante aprobada: entra en la rotación A/B' : b.dataset.variantAct === 'reject' ? 'Variante descartada' : 'Variante reactivada');
      router();
    })));
    $$('[data-ai-step]', el).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      const n = Number(b.dataset.aiStep);
      const segment = $(`[data-ai-segment="${n}"]`, el)?.value || '';
      b.textContent = 'Escribiendo…';
      const r = await api(`/campaigns/${c.id}/ai/variants`, { method: 'POST', body: { step_number: n, segment, count: 2 } });
      toast(`${r.variants.length} variante(s) propuesta(s) por IA (${r.model}). Revísalas y apruébalas.`);
      router();
    })));
    $('#save', el).addEventListener('click', async (e) => {
      const saved = await saveCampaign(c, e.currentTarget);
      if (saved) { Object.assign(c, structuredClone(saved)); draw(); }
    });
  }
  draw();
}

async function showPreview(c, stepNumber, variantId, prospectId) {
  const p = await api(`/campaigns/${c.id}/preview`, { method: 'POST', body: { step_number: stepNumber, variant_id: variantId, prospect_id: prospectId } });
  const body = openModal(`<h2>Vista previa · ${esc(p.variant.label)}</h2>
    <p class="muted small">Para ${esc(p.prospect.name || p.prospect.email)} &lt;${esc(p.prospect.email)}&gt; · ganchos disponibles para este prospecto: ${esc(p.available_hooks.join(', ') || 'ninguno')}</p>
    ${p.channel === 'email' ? `<p><b>Asunto:</b> ${esc(p.subject)}</p>` : `<p><b>${esc(CHANNEL_LABEL[p.channel])}</b></p>`}
    <div class="preview-mail">${esc(p.body)}</div>
    ${p.quality ? `<p class="small" style="margin-top:10px"><b>Control de calidad</b> · ${p.quality.wordCount} palabras</p>${issuesHtml(p.quality.issues, 'Cumple todas las reglas')}` : ''}
    ${p.channel === 'email' ? (p.signature_html ? '<p class="muted small">Firma del remitente:</p><iframe class="sig" sandbox></iframe>' : '<p class="notice">Asigna un sender con firma: es obligatoria.</p>') : ''}`);
  const frame = $('iframe.sig', body);
  if (frame) frame.srcdoc = `<div style="font-family:Arial,sans-serif;font-size:14px">${p.signature_html}</div>`;
}

// --- Personalization library: segments, hooks, problems, CTAs --------------
function renderLibrary(el, campaign) {
  const c = structuredClone(campaign);
  const lists = {
    segments: { title: 'Segmentos', help: 'Grupos comerciales (industria + cargo). Jev asigna cada prospecto al segmento que mejor lo describe; las variantes y bibliotecas pueden ser específicas de un segmento.', fields: ['name', 'description'], blank: { name: 'Nuevo segmento', description: '' } },
    hooks: { title: 'Ganchos de personalización {{gancho}}', help: 'Primer párrafo: contexto real y verificable de la persona. Usa campos del archivo (p. ej. {{noticia}}, {{title}}). Un gancho solo se ofrece a Jev si TODOS sus campos tienen dato para ese prospecto.', fields: ['label', 'description', 'segment', 'text'], blank: { label: 'Nuevo gancho', description: '', segment: '', text: '' } },
    problems: { title: 'Hipótesis de problema {{problema}}', help: 'Segundo párrafo: un problema probable para ese rol y sector, dicho con humildad ("en equipos parecidos vemos…").', fields: ['label', 'description', 'segment', 'text'], blank: { label: 'Nuevo problema', description: '', segment: '', text: '' } },
    ctas: { title: 'Llamados a la acción {{cta}}', help: 'Tercer párrafo: una sola pregunta o propuesta breve. Ordénalos de más suave a más directo; Jev escala según la interacción.', fields: ['label', 'description', 'text'], blank: { label: 'Nuevo CTA', description: '', text: '' } },
  };
  const labels = { name: 'Nombre', label: 'Nombre', description: 'Cuándo usarlo (lo lee Jev)', segment: 'Segmento', text: 'Texto' };

  function draw() {
    el.innerHTML = Object.entries(lists).map(([key, cfg]) => `
      <div class="card" data-list="${key}">
        <h2>${esc(cfg.title)}</h2><p class="muted small">${esc(cfg.help)}</p>
        ${c[key].map((item, i) => `<div class="variant" data-item="${i}">
          <div class="grid3">${cfg.fields.filter((f) => f !== 'text').map((f) => `<div><label>${labels[f]}</label>${f === 'segment'
            ? `<select data-k="segment">${segmentOptions(c.segments, item.segment)}</select>`
            : `<input type="text" data-k="${f}" value="${esc(item[f])}">`}</div>`).join('')}</div>
          ${cfg.fields.includes('text') ? `<div style="margin-top:8px"><label>Texto</label><textarea data-k="text" style="min-height:60px">${esc(item.text)}</textarea></div>` : ''}
          <button class="btn danger small" data-remove="${i}" style="margin-top:8px">Quitar</button></div>`).join('') || '<p class="muted small">Vacío.</p>'}
        <button class="btn ghost small" data-add style="margin-top:10px">+ Agregar</button>
      </div>`).join('') + '<button class="btn" id="save-library">Guardar personalización</button>';
    $$('[data-list]', el).forEach((listEl) => {
      const key = listEl.dataset.list;
      $$('[data-item]', listEl).forEach((itemEl) => {
        const item = c[key][Number(itemEl.dataset.item)];
        $$('[data-k]', itemEl).forEach((inp) => inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => { item[inp.dataset.k] = inp.value; }));
      });
      $$('[data-remove]', listEl).forEach((b) => b.addEventListener('click', () => { c[key].splice(Number(b.dataset.remove), 1); draw(); }));
      $('[data-add]', listEl).addEventListener('click', () => { c[key].push({ ...lists[key].blank }); draw(); });
    });
    $('#save-library').addEventListener('click', async (e) => {
      const saved = await saveCampaign(c, e.currentTarget);
      if (saved) { Object.assign(c, structuredClone(saved)); draw(); }
    });
  }
  draw();
}

// --- Settings ------------------------------------------------------------------
function renderSettings(el, campaign, senders, brands = []) {
  const c = structuredClone(campaign);
  el.innerHTML = `
    <div class="card stack">
      <div class="grid2">
        <div><label>Nombre</label><input type="text" id="s-name" value="${esc(c.name)}"></div>
        <div><label>Marca <span class="hint">— su contexto guía el análisis de leads y la redacción con IA</span></label>
          <select id="s-brand"><option value="">Sin marca</option>${brands.map((b) => `<option value="${b.id}" ${b.id === c.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
          ${brands.length ? '' : '<p class="small muted">Aún no tienes marcas. <a href="#/brands">Crea una</a>.</p>'}</div>
      </div>
      <div><label>Oferta <span class="hint">— qué resuelves y para quién. Jev la usa para elegir ángulo, problema y CTA.</span></label>
        <textarea id="s-offer" style="min-height:80px">${esc(c.offer)}</textarea></div>
      <div><label>Perfil de cliente ideal (ICP) <span class="hint">— industria, tamaño, cargos, país. Jev puntúa el encaje, prioriza y excluye a quien claramente no encaja.</span></label>
        <textarea id="s-icp" style="min-height:80px">${esc(c.icp)}</textarea></div>
    </div>
    <div class="card">
      <h2>Aprobación</h2>
      ${Object.entries(APPROVAL_LABEL).map(([k, l]) => `<label class="check"><input type="radio" name="approval" value="${k}" ${c.approval_mode === k ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
      <p class="muted small">Los errores de calidad (enlaces en el primer correo, emojis, datos faltantes, remitente sin firma, lead inválido) siempre requieren revisión humana.</p>
    </div>
    <div class="card">
      <h2>Senders (Google Workspace)</h2>
      ${senders.length ? senders.map((s) => `<label class="check"><input type="checkbox" data-sender="${s.id}" ${c.sender_ids.includes(s.id) ? 'checked' : ''}>
        ${esc(s.display_name || s.email)} &lt;${esc(s.email)}&gt; ${badge(s.status)} <span class="muted small">límite ${s.daily_limit}/día${s.signature_html ? '' : ' · <b style="color:var(--bad)">sin firma</b>'}</span></label>`).join('')
        : '<p class="muted">No tienes senders. <a href="#/senders">Conecta uno</a>.</p>'}
      <p class="muted small">Con varios senders los prospectos nuevos se reparten; cada seguimiento sale del mismo buzón que el primer correo.</p>
    </div>
    <p class="notice info">Días, horarios, límite diario, pausa entre correos y reglas por empresa: pestaña <a href="#/campaigns/${c.id}/rules">Reglas de envío</a>.</p>
    <div class="card stack">
      <h2>Opciones</h2>
      <label class="check"><input type="checkbox" id="s-jev" ${c.jev_enabled ? 'checked' : ''}> Usar Jev para segmentar, decidir mensaje, gancho, problema, CTA y momento ${meta.jev_configured ? '' : '<span class="badge warn">falta TYPESAFE_API_KEY → reglas</span>'}</label>
      <label class="check"><input type="checkbox" id="s-opens" ${c.track_opens ? 'checked' : ''}> Rastrear aperturas (pixel). <span class="muted small">Afecta un poco la entregabilidad; Apple Mail infla aperturas.</span></label>
      <label class="check"><input type="checkbox" id="s-unsub" ${c.include_unsubscribe ? 'checked' : ''}> Incluir enlace y cabecera de baja (cumplimiento)</label>
      <label class="check"><input type="checkbox" id="s-reply" ${c.stop_on_reply ? 'checked' : ''}> Detener la secuencia cuando el prospecto responde (las auto-respuestas no la detienen)</label>
    </div>
    <button class="btn" id="save-settings">Guardar configuración</button>`;
  $('#save-settings').addEventListener('click', async (e) => {
    Object.assign(c, {
      name: $('#s-name').value, offer: $('#s-offer').value, icp: $('#s-icp').value,
      brand_id: Number($('#s-brand').value) || null,
      sender_ids: $$('[data-sender]').filter((x) => x.checked).map((x) => Number(x.dataset.sender)),
      approval_mode: $('input[name=approval]:checked')?.value || 'all',
      jev_enabled: $('#s-jev').checked, track_opens: $('#s-opens').checked, include_unsubscribe: $('#s-unsub').checked, stop_on_reply: $('#s-reply').checked,
    });
    if (await saveCampaign(c, e.currentTarget)) router();
  });
}

// --- Sending rules ("autopilot") -------------------------------------------------
const DAY_NAMES = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

/** Rough duration to send N emails with the current rules (weekly sending minutes, cap and delay). */
function sendingSummary(c, emails = 100) {
  const days = Object.values(c.schedule).filter((d) => d.on);
  if (!days.length) return 'No hay días de envío activos.';
  const perDayMinutes = days.map((d) => Math.max(0, toMin(d.end) - toMin(d.start)));
  const avgMinutes = perDayMinutes.reduce((a, b) => a + b, 0) / days.length;
  const byDelay = Number(c.delay_minutes) > 0 ? Math.floor(avgMinutes / Number(c.delay_minutes)) : Infinity;
  const perDay = Math.max(1, Math.min(Number(c.max_per_day) || Infinity, byDelay));
  const sendingDays = emails / perDay;
  const hours = Number(c.delay_minutes) > 0 ? (Math.min(emails, perDay) * Number(c.delay_minutes)) / 60 : 0;
  if (sendingDays <= 1) {
    return `Con esta configuración, ${emails} correos tardan unas <b>${hours < 1 ? `${Math.round(hours * 60)} minutos` : `${Math.round(hours * 10) / 10} horas`}</b> de envío (máx. ${perDay === Infinity ? '—' : perDay} por día).`;
  }
  return `Con esta configuración, ${emails} correos tardan unos <b>${Math.ceil(sendingDays)} días de envío</b> (hasta ${perDay} por día en esta campaña).`;
}

function renderRules(el, campaign) {
  const c = structuredClone(campaign);
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zones = known.includes(c.timezone) ? known : [c.timezone, ...known];
  el.innerHTML = `
    <div class="card">
      <h2>Reglas de envío</h2>
      <p class="muted small">Mejora la entregabilidad: los correos solo salen en estos horarios, con un máximo diario y una pausa entre envíos. Los límites de cada sender (pestaña Senders) también se respetan.</p>
      <div class="rules-grid">
        <div>
          <div class="rules-head"><span>Enviar solo los</span><span>Desde</span><span></span><span>Hasta</span></div>
          ${[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const day = c.schedule[d];
            return `<div class="rules-row ${day.on ? '' : 'off'}" data-day="${d}">
              <label class="check"><input type="checkbox" data-k="on" ${day.on ? 'checked' : ''}> ${DAY_NAMES[d]}</label>
              <input type="time" data-k="start" value="${esc(day.start)}" ${day.on ? '' : 'disabled'}>
              <span class="muted">a</span>
              <input type="time" data-k="end" value="${esc(day.end)}" ${day.on ? '' : 'disabled'}>
            </div>`;
          }).join('')}
          <div style="margin-top:12px"><label>🌐 Zona horaria</label><select id="r-tz">${zones.map((z) => `<option ${z === c.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
        </div>
        <div>
          <div class="rules-head"><span>Ritmo de envío</span></div>
          <div class="rules-rate"><label for="r-max">Máximo de correos por día (campaña)</label><input type="number" id="r-max" min="1" max="2000" value="${esc(c.max_per_day)}"></div>
          <div class="rules-rate"><label for="r-delay">Pausa entre correos</label><div class="input-suffix"><input type="number" id="r-delay" min="0" max="240" value="${esc(c.delay_minutes)}"><span>minutos</span></div></div>
          <div class="rules-head" style="margin-top:18px"><span>Resumen</span></div>
          <p id="r-summary"></p>
          <div class="rules-head" style="margin-top:18px"><span>Reglas por empresa</span></div>
          <p class="muted small">Contactar a 2–3 personas de una misma empresa mejora la probabilidad de respuesta por cuenta, con rendimientos decrecientes.</p>
          <div class="rules-rate"><label for="r-company-max">Máximo de contactos por empresa</label><input type="number" id="r-company-max" min="1" max="20" value="${esc(c.max_contacts_per_company)}"></div>
          <div class="rules-rate"><label for="r-company-gap">Días entre el primer correo a colegas</label><input type="number" id="r-company-gap" min="0" max="30" value="${esc(c.company_gap_days)}"></div>
          <label class="check" style="margin-top:8px"><input type="checkbox" id="r-company-stop" ${c.stop_on_company_reply ? 'checked' : ''}> Si alguien de la empresa responde, detener a sus colegas</label>
        </div>
      </div>
    </div>
    <button class="btn" id="save-rules">Aplicar reglas</button>`;

  const read = () => {
    $$('.rules-row', el).forEach((row) => {
      const day = c.schedule[row.dataset.day];
      day.on = $('[data-k=on]', row).checked;
      day.start = $('[data-k=start]', row).value;
      day.end = $('[data-k=end]', row).value;
      row.classList.toggle('off', !day.on);
      $$('input[type=time]', row).forEach((i) => { i.disabled = !day.on; });
    });
    Object.assign(c, {
      timezone: $('#r-tz').value,
      max_per_day: Number($('#r-max').value),
      delay_minutes: Number($('#r-delay').value),
      max_contacts_per_company: Number($('#r-company-max').value),
      company_gap_days: Number($('#r-company-gap').value),
      stop_on_company_reply: $('#r-company-stop').checked,
    });
    $('#r-summary').innerHTML = sendingSummary(c);
  };
  $$('input, select', el).forEach((i) => i.addEventListener('input', read));
  read();
  $('#save-rules').addEventListener('click', async (e) => {
    read();
    if (await saveCampaign(c, e.currentTarget)) router();
  });
}

// --- Supervised A/B tests ---------------------------------------------------------
async function renderAB(el, campaign) {
  const data = await api(`/campaigns/${campaign.id}/ab`);
  const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
  const statusBadge = (v) => (v.status === 'active' ? '<span class="badge ok">activa</span>'
    : v.status === 'proposed' ? '<span class="badge warn">propuesta · por aprobar</span>' : '<span class="badge">pausada</span>');
  const icon = { pause: '⏸', challenge: '✨', collect: '⏳' };
  el.innerHTML = `
    <div class="card">
      <h2>Recomendaciones</h2>
      <p class="muted small">El sistema compara variantes con una prueba estadística (mínimo 30 envíos por variante) y <b>recomienda</b>; nada cambia hasta que tú lo apruebas. Las variantes nuevas (incluidas las de IA) entran como <b>propuestas</b> y solo se envían cuando las apruebas.</p>
      ${data.recommendations.map((r, i) => `
        <div class="variant row between" data-rec="${i}">
          <div><b>${icon[r.type]} ${esc(r.title)}</b><br><span class="small muted">${esc(r.reason)}${r.confidence ? ` · confianza: ${esc(r.confidence)}` : ''}</span></div>
          <div>${r.type === 'pause' ? '<button class="btn small" data-act="pause">Aprobar: pausar</button>' : ''}
            ${r.type === 'challenge' ? `<button class="btn small" data-act="challenge" ${data.openai ? '' : 'disabled title="Configura OpenAI en Integraciones"'}>✨ Generar retador con IA</button>` : ''}</div>
        </div>`).join('') || '<p class="muted">Sin recomendaciones todavía.</p>'}
      ${data.openai ? '' : '<p class="small muted">Para generar variantes con IA, carga la API key de OpenAI en Integraciones.</p>'}
    </div>
    ${data.groups.map((g) => `
      <div class="card">
        <h2>Paso ${g.step_number}${g.segment ? ` · ${esc(g.segment)}` : ''}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Variante</th><th>Estado</th><th>Enviados</th><th>Apertura</th><th>Respuesta</th><th>Positivas</th><th></th></tr></thead>
          <tbody>${g.variants.map((v) => `
            <tr data-variant-id="${v.id}">
              <td><b>${esc(v.label)}</b>${v.origin === 'ai' ? ' <span class="badge">IA</span>' : ''}<br><span class="small muted">${esc(v.subject || '(mismo hilo)')}</span>${v.rationale ? `<br><span class="small muted">Hipótesis: ${esc(v.rationale)}</span>` : ''}</td>
              <td>${statusBadge(v)}</td><td>${v.sent}</td><td>${pct(v.opened, v.sent)}</td><td>${pct(v.replied, v.sent)}</td><td>${v.positive}</td>
              <td class="row" style="flex-wrap:nowrap">${v.status === 'proposed' ? '<button class="btn ok small" data-v="approve">Aprobar</button><button class="btn danger small" data-v="reject">Descartar</button>'
                : v.status === 'active' ? '<button class="btn ghost small" data-v="pause">Pausar</button>' : '<button class="btn ghost small" data-v="activate">Reactivar</button>'}
                <button class="btn ghost small" data-v="view">Ver</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('')}`;
  $$('[data-rec]', el).forEach((row) => {
    const r = data.recommendations[Number(row.dataset.rec)];
    $$('[data-act]', row).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      if (b.dataset.act === 'pause') await api(`/variants/${r.variant_id}/pause`, { method: 'POST', body: {} });
      else {
        const res = await api(`/campaigns/${campaign.id}/ai/variants`, { method: 'POST', body: { step_number: r.step_number, segment: r.segment || '', count: 2, base_variant_id: r.variant_id } });
        toast(`${res.variants.length} variante(s) propuesta(s) por IA: revísalas y apruébalas`);
      }
      renderAB(el, campaign);
    })));
  });
  $$('[data-variant-id]', el).forEach((row) => {
    const id = Number(row.dataset.variantId);
    const v = data.groups.flatMap((g) => g.variants).find((x) => x.id === id);
    $$('[data-v]', row).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      if (b.dataset.v === 'view') {
        openModal(`<h2>${esc(v.label)}</h2><p><b>Asunto:</b> ${esc(v.subject || '(mismo hilo)')}</p><div class="preview-mail">${esc(v.body)}</div>${v.rationale ? `<p class="small muted">Hipótesis: ${esc(v.rationale)}</p>` : ''}`);
        return;
      }
      await api(`/variants/${id}/${b.dataset.v}`, { method: 'POST', body: {} });
      toast({ approve: 'Variante aprobada: entra en la rotación', reject: 'Variante descartada', pause: 'Variante pausada', activate: 'Variante reactivada' }[b.dataset.v]);
      renderAB(el, campaign);
    })));
  });
}

// --- Prospects -------------------------------------------------------------------
async function renderProspects(el, campaign, filters = {}) {
  const { page = 1, status = '', validation = '', segment = '', lead = '', q = '' } = filters;
  const data = await api(`/campaigns/${campaign.id}/prospects?${new URLSearchParams({ page, status, validation, segment, lead, q })}`);
  const bases = meta.lawful_bases || {};
  el.innerHTML = `
    <div class="card">
      <h2>Importar leads (CSV o Excel)</h2>
      <p class="muted small">Columna obligatoria: <code>email</code>/<code>correo</code>. Reconoce nombre, apellido, empresa, cargo, industria/sector, país, teléfono y LinkedIn. Cualquier otra columna se vuelve un campo (<code>noticia</code> → <code>{{noticia}}</code>). Cada lead se valida: formato, dominio con MX, cuentas genéricas o personales, desechables, duplicados y lista de baja.</p>
      <form id="import-form" class="stack">
        <div class="grid3">
          <div><label>Archivo</label><input type="file" id="csv" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></div>
          <div><label>Origen de los datos <span class="hint">(fuente autorizada)</span></label><input type="text" id="imp-source" required placeholder="p. ej. CRM propio, evento, Apollo"></div>
          <div><label>Base legal</label><select id="imp-basis" required><option value="">Selecciona…</option>${Object.entries(bases).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></div>
        </div>
        <div><button class="btn" type="submit">Importar y validar</button></div>
      </form>
      <div id="import-result"></div>
    </div>
    <div class="card">
      <div class="row between">
        <h2>${data.total} prospectos</h2>
        <div class="row">
          <input type="text" id="p-q" placeholder="Buscar…" value="${esc(q)}" style="width:160px">
          <select id="p-status" style="width:auto"><option value="">Estado</option>${['active', 'finished', 'replied', 'bounced', 'unsubscribed', 'stopped'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
          <select id="p-lead" style="width:auto"><option value="">Estado del lead</option>${Object.entries(LEAD_LABEL).map(([k, l]) => `<option value="${k}" ${k === lead ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select id="p-validation" style="width:auto"><option value="">Validación</option>${Object.entries(VALIDATION_LABEL).map(([k, l]) => `<option value="${k}" ${k === validation ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${campaign.segments.length ? `<select id="p-segment" style="width:auto"><option value="">Segmento</option>${campaign.segments.map((sg) => `<option value="${sg.id}" ${String(sg.id) === String(segment) ? 'selected' : ''}>${esc(sg.name)}</option>`).join('')}<option value="none" ${segment === 'none' ? 'selected' : ''}>Sin segmento</option></select>` : ''}
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Prospecto</th><th>Empresa</th><th>Lead</th><th>Segmento / encaje</th><th>Estado</th><th>Paso</th><th>Próximo</th></tr></thead>
        <tbody>${data.prospects.map((p) => `
          <tr class="clickable" data-prospect="${p.id}">
            <td><b>${esc([p.first_name, p.last_name].filter(Boolean).join(' ') || '—')}</b><br><span class="muted small">${esc(p.email)}</span></td>
            <td>${esc(p.company)}<br><span class="muted small">${esc(p.title)}${p.industry ? ` · ${esc(p.industry)}` : ''}</span></td>
            <td>${p.intel_at || p.lead_status === 'excluded' ? leadBadge(p.lead_status) : '<span class="muted small">analizando…</span>'}${p.lead_status !== 'ready' && p.lead_status_reasons && p.lead_status_reasons !== 'pendiente de análisis' ? `<br><span class="small muted">${esc(p.lead_status_reasons)}</span>` : ''}${p.validation_status !== 'valid' ? `<br>${validationBadge(p.validation_status)}` : ''}</td>
            <td>${p.intel_at ? `${esc(p.segment || 'Sin segmento')}<br><span class="small muted">${p.fit_score === null ? '' : `encaje ${Math.round(p.fit_score * 100)}%`}</span>` : (p.status === 'active' ? '<span class="muted small">analizando…</span>' : '—')}</td>
            <td>${badge(p.status)}${p.outcome ? ` <span class="badge ok">${esc(OUTCOME_LABEL[p.outcome])}</span>` : ''}${p.pending_drafts ? ' <span class="badge warn">por aprobar</span>' : ''}
              ${p.reply_category ? `<br><span class="small">${esc(REPLY_LABEL[p.reply_category] || p.reply_category)}</span>` : ''}${p.stop_reason && p.status === 'stopped' ? `<br><span class="small muted">${esc(p.stop_reason)}</span>` : ''}${p.last_error ? `<br><span class="small" style="color:var(--bad)">${esc(p.last_error)}</span>` : ''}</td>
            <td>${p.current_step}/${campaign.steps.length}</td>
            <td class="small">${p.status === 'active' && p.next_send_at ? fmtDate(p.next_send_at) : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">Sin prospectos</td></tr>'}</tbody>
      </table></div>
      ${data.pages > 1 ? `<div class="row" style="margin-top:10px">${page > 1 ? '<button class="btn ghost small" id="prev">← Anterior</button>' : ''}<span class="muted small">Página ${page} de ${data.pages}</span>${page < data.pages ? '<button class="btn ghost small" id="next">Siguiente →</button>' : ''}</div>` : ''}
    </div>`;
  const reload = (opts) => renderProspects(el, campaign, { page, status, validation, segment, lead, q, ...opts });
  $('#import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(e.submitter, async () => {
      const form = new FormData();
      form.append('source', $('#imp-source').value);
      form.append('lawful_basis', $('#imp-basis').value);
      form.append('file', $('#csv').files[0]);
      const r = await api(`/campaigns/${campaign.id}/prospects/import`, { method: 'POST', form });
      toast(`${r.imported} importados`);
      await reload({ page: 1 });
      $('#import-result').innerHTML = `
        <div class="grid4" style="margin-top:12px">${[['Importados', r.imported], ['Válidos', r.valid], ['Riesgosos', r.risky], ['Inválidos', r.invalid], ['Duplicados', r.duplicates], ['En lista de baja', r.suppressed], ['En otra campaña', r.contacted_elsewhere]]
          .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
        <p class="small muted">Columnas detectadas: ${Object.entries(r.mapping).map(([k, v]) => `${esc(k)} ← ${esc(v)}`).join(', ')}. Los inválidos quedan detenidos; los riesgosos pasan por aprobación. La inteligencia comercial (segmento y encaje) se calcula en el próximo ciclo o con "Procesar ahora".</p>
        ${r.invalid_rows.length ? `<details><summary class="small">Ver inválidos</summary><ul class="small">${r.invalid_rows.slice(0, 100).map((i) => `<li>${esc(i.email || `fila ${i.row}`)}: ${esc(i.reason)}</li>`).join('')}</ul></details>` : ''}
        ${r.risky_rows.length ? `<details><summary class="small">Ver riesgosos</summary><ul class="small">${r.risky_rows.map((i) => `<li>${esc(i.email)}: ${esc(i.reason)}</li>`).join('')}</ul></details>` : ''}`;
    });
  });
  let searchTimer;
  $('#p-q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => reload({ q: e.target.value, page: 1 }), 300); });
  $('#p-status').addEventListener('change', (e) => reload({ status: e.target.value, page: 1 }));
  $('#p-validation').addEventListener('change', (e) => reload({ validation: e.target.value, page: 1 }));
  $('#p-lead').addEventListener('change', (e) => reload({ lead: e.target.value, page: 1 }));
  $('#p-segment')?.addEventListener('change', (e) => reload({ segment: e.target.value, page: 1 }));
  $('#prev')?.addEventListener('click', () => reload({ page: page - 1 }));
  $('#next')?.addEventListener('click', () => reload({ page: page + 1 }));
  $$('[data-prospect]', el).forEach((tr) => tr.addEventListener('click', () => showProspect(campaign, Number(tr.dataset.prospect), reload)));
}

async function showProspect(campaign, id, reload) {
  const { prospect: p, messages, opens, decisions, tasks, drafts, questions } = await api(`/prospects/${id}`);
  const body = openModal(`
    <h2>${esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email)} ${badge(p.status)} ${p.outcome ? `<span class="badge ok">${esc(OUTCOME_LABEL[p.outcome])}</span>` : ''}</h2>
    <p class="muted">${esc(p.email)} · ${esc(p.title)} ${p.company ? `en ${esc(p.company)}` : ''} ${p.phone ? `· ${esc(p.phone)}` : ''} ${p.linkedin_url ? `· <a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</p>
    <p class="small">${validationBadge(p.validation_status)} ${esc(p.validation_notes)} · Segmento: <b>${esc(p.segment || 'sin segmento')}</b>${p.fit_score !== null ? ` · encaje ${Math.round(p.fit_score * 100)}%` : ''} · Origen: ${esc(p.source || '—')} (${esc((meta.lawful_bases || {})[p.lawful_basis] || p.lawful_basis || '—')})</p>
    <p class="small">${leadBadge(p.lead_status)} ${p.lead_status !== 'ready' ? esc(p.lead_status_reasons) : ''} ${p.company_info ? `· Empresa: <a href="#/companies?id=${p.company_info.id}">${esc(p.company_info.name || p.company_info.domain)}</a>` : ''}</p>
    ${p.stop_reason ? `<p class="notice">${esc(p.stop_reason)}</p>` : ''}
    <h3>Antes de actuar</h3>
    <ol class="questions">${questions.map((q) => `<li class="${q.ok ? 'q-ok' : 'q-no'}"><b>${esc(q.question)}</b><br>${q.ok ? '✅' : '⚠️'} ${esc(q.answer)}${q.detail ? ` <span class="muted small">· ${esc(q.detail)}</span>` : ''}</li>`).join('')}</ol>
    ${p.lead_status !== 'ready' && p.status !== 'replied' ? `<details class="card" ${p.lead_status === 'research' ? 'open' : ''}><summary><b>Completar datos y volver a analizar</b></summary>
      <form id="p-data" class="grid3" style="margin-top:10px">
        ${[['title', 'Cargo'], ['industry', 'Industria'], ['company', 'Empresa'], ['source', 'Procedencia del dato'], ['linkedin_url', 'LinkedIn'], ['phone', 'Teléfono']].map(([k, l]) => `<div><label>${l}</label><input type="text" name="${k}" value="${esc(p[k] || '')}"></div>`).join('')}
        <div><button class="btn small" type="submit">Guardar y analizar</button></div>
      </form></details>` : ''}
    <div class="row">
      <span class="small"><b>Resultado:</b></span>
      ${Object.entries(OUTCOME_LABEL).map(([k, l]) => `<button class="btn ${p.outcome === k ? '' : 'ghost'} small" data-outcome="${k}">${l}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:8px">
      ${p.status === 'active' ? '<button class="btn danger small" id="p-stop">Detener secuencia</button>' : ''}
      ${p.status === 'stopped' && p.validation_status !== 'invalid' ? '<button class="btn small" id="p-resume">Reanudar</button>' : ''}
      ${p.status === 'active' ? '<button class="btn ghost small" id="p-sim">Simular decisión de Jev</button>' : ''}
      <button class="btn danger small" id="p-delete">Eliminar</button>
    </div>
    <div id="p-sim-out"></div>
    <h3 style="margin-top:16px">Datos del archivo</h3>
    <pre class="json">${esc(JSON.stringify(p.fields, null, 2))}</pre>
    ${drafts.length ? `<h3>Borradores</h3>${drafts.map((d) => `<p class="small">Paso ${d.step_number} · ${esc(d.subject)} · ${d.status === 'pending' ? '<span class="badge warn">por aprobar</span>' : '<span class="badge ok">aprobado</span>'}</p>`).join('')}` : ''}
    <h3>Correos enviados</h3>
    ${messages.map((m) => `<div class="variant"><div class="row between"><b>Paso ${m.step_number} · ${esc(m.subject)}</b><span class="small muted">${fmtDate(m.sent_at)} · ${esc(m.sender_email || '')}</span></div>
      <p class="small muted">Variante: ${esc(m.variant_label || '—')} · CTA: ${esc(m.cta_label || '—')} · Aperturas: ${m.open_count}${m.last_opened_at ? ` (última ${fmtDate(m.last_opened_at)})` : ''}</p>
      <div class="preview-mail small">${esc(m.body_text)}</div></div>`).join('') || '<p class="muted">Aún no se ha enviado nada.</p>'}
    ${tasks.length ? `<h3 style="margin-top:16px">Tareas</h3><table><tbody>${tasks.map((t) => `<tr><td class="small">Paso ${t.step_number} · ${esc(CHANNEL_LABEL[t.channel])}</td><td class="small">${esc(t.status)}${t.outcome ? ` · ${esc(t.outcome)}` : ''}</td><td class="small muted">${esc(t.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="margin-top:16px">Aperturas</h3>
    ${opens.length ? `<table><tbody>${opens.map((o) => `<tr><td class="small">${fmtDate(o.opened_at)}</td><td class="small">${o.suspected_bot ? '<span class="badge warn">bot/escáner</span>' : '<span class="badge ok">humano</span>'}</td><td class="small muted">${esc(o.user_agent)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin aperturas.</p>'}
    <h3 style="margin-top:16px">Decisiones (Jev / reglas)</h3>
    ${decisions.map((d) => `<details><summary>${d.step_number ? `Paso ${d.step_number}` : 'Análisis'} · ${esc(engineLabel(d.engine))} · <b>${esc(d.action)}</b> · ${fmtDate(d.created_at)}</summary><pre class="json">${esc(JSON.stringify(d.detail, null, 2))}</pre></details>`).join('') || '<p class="muted">Sin decisiones aún.</p>'}`);
  const act = (selector, fn) => $$(selector, body).forEach((b) => b.addEventListener('click', (e) => guard(e.currentTarget, () => fn(e.currentTarget))));
  act('[data-outcome]', async (b) => { await api(`/prospects/${id}`, { method: 'PATCH', body: { outcome: b.dataset.outcome } }); closeModal(); reload(); });
  $('#p-data', body)?.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(e.submitter, async () => {
      const data = Object.fromEntries([...new FormData(e.target).entries()].filter(([, v]) => String(v).trim()));
      const r = await api(`/prospects/${id}`, { method: 'PATCH', body: { data } });
      toast(`Analizado: ${LEAD_LABEL[r.lead_status]}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`);
      await showProspect(campaign, id, reload);
      reload();
    });
  });
  act('#p-stop', async () => { await api(`/prospects/${id}`, { method: 'PATCH', body: { status: 'stopped' } }); closeModal(); reload(); });
  act('#p-resume', async () => { await api(`/prospects/${id}`, { method: 'PATCH', body: { status: 'active' } }); closeModal(); reload(); });
  act('#p-delete', async () => { if (!confirm('¿Eliminar prospecto?')) return; await api(`/prospects/${id}`, { method: 'DELETE' }); closeModal(); reload(); });
  act('#p-sim', async () => {
    const r = await api(`/campaigns/${campaign.id}/simulate-decision`, { method: 'POST', body: { prospect_id: id } });
    const d = r.decision;
    $('#p-sim-out', body).innerHTML = `<div class="notice info" style="margin-top:10px">
      <b>Análisis</b> (${esc(engineLabel(r.analysis.engine))}): segmento <b>${esc(r.analysis.segment || 'ninguno')}</b>${r.analysis.fitScore !== null && r.analysis.fitScore !== undefined ? ` · encaje ${Math.round(r.analysis.fitScore * 100)}%` : ''}${r.analysis.exclude ? ' · <b>se excluiría</b>' : ''}<br>
      ${d ? `<b>Paso ${r.step_number}</b> (${esc(engineLabel(d.engine))}): variante <b>${esc(d.labels.variant || '—')}</b> · gancho ${esc(d.labels.hook || '—')} · problema ${esc(d.labels.problem || '—')} · CTA ${esc(d.labels.cta || '—')} · franja ${esc(d.slot || 'cualquiera')}` : `El siguiente paso no es un correo.`}</div>
      <details><summary class="small">Detalle</summary><pre class="json">${esc(JSON.stringify({ analysis: r.analysis.detail, decision: d?.detail }, null, 2))}</pre></details>`;
  });
}

// --- Approval queue ------------------------------------------------------------
async function renderApproval(el, campaign) {
  const { drafts } = await api(`/campaigns/${campaign.id}/drafts?status=pending`);
  el.innerHTML = `
    <div class="row between"><p class="muted">Cada correo pasa por el control de calidad. Edita, aprueba o descarta. Al aprobar, se envía dentro de la ventana de envío respetando los límites del sender.</p>
      ${drafts.length ? '<button class="btn ok" id="approve-all">Aprobar todos los que no tienen errores</button>' : ''}</div>
    ${drafts.map((d) => `
      <div class="card" data-draft="${d.id}">
        <div class="row between"><div><b>${esc([d.first_name, d.last_name].filter(Boolean).join(' ') || d.email)}</b> · <span class="muted small">${esc(d.email)} · ${esc(d.title)} ${d.company ? `en ${esc(d.company)}` : ''}</span></div>
          <span class="small muted">Paso ${d.step_number} · ${esc(d.segment || 'sin segmento')} · ${validationBadge(d.validation_status)} · desde ${esc(d.sender_email || '—')}</span></div>
        <div style="margin-top:8px"><label>Asunto</label><input type="text" data-k="subject" value="${esc(d.subject)}" ${d.same_thread ? 'readonly' : ''}></div>
        <div style="margin-top:8px"><label>Cuerpo <span class="hint">(${d.quality.wordCount} palabras)</span></label><textarea data-k="body" style="min-height:170px;font-family:inherit;font-size:14px">${esc(d.body)}</textarea></div>
        <div data-quality>${issuesHtml(d.quality.issues, 'Cumple todas las reglas de calidad')}</div>
        <p class="small muted">Elegido por ${esc(engineLabel(d.decision.engine))}${d.decision.detail?.variant?.confidence ? ` (confianza ${Math.round(d.decision.detail.variant.confidence * 100)}%)` : ''}</p>
        <div class="row">
          <button class="btn ok small" data-act="approve">Aprobar</button>
          <button class="btn ghost small" data-act="save">Guardar cambios y revisar</button>
          <button class="btn ghost small" data-act="regenerate">Regenerar</button>
          <button class="btn danger small" data-act="stop">Descartar prospecto</button>
        </div>
      </div>`).join('') || '<div class="card empty">No hay correos pendientes de aprobación. 🎉</div>'}`;
  $('#approve-all')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
    const r = await api(`/campaigns/${campaign.id}/drafts/approve-all`, { method: 'POST', body: {} });
    toast(`${r.approved} aprobados${r.skipped_with_errors ? ` · ${r.skipped_with_errors} con errores siguen pendientes` : ''}`);
    router();
  }));
  $$('[data-draft]', el).forEach((card) => {
    const id = card.dataset.draft;
    const values = () => ({ subject: $('[data-k=subject]', card).value, body: $('[data-k=body]', card).value });
    $$('[data-act]', card).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      const act = b.dataset.act;
      if (act === 'save' || act === 'approve') {
        const r = await api(`/drafts/${id}`, { method: 'PATCH', body: values() });
        $('[data-quality]', card).innerHTML = issuesHtml(r.quality.issues, 'Cumple todas las reglas de calidad');
        if (act === 'save') return toast('Revisado');
        if (r.quality.errors && !confirm(`Este correo tiene ${r.quality.errors} error(es) de calidad. ¿Enviarlo igualmente?`)) return;
        await api(`/drafts/${id}/approve`, { method: 'POST', body: { force: Boolean(r.quality.errors) } });
        toast('Aprobado');
      } else {
        await api(`/drafts/${id}/reject`, { method: 'POST', body: { action: act } });
        toast(act === 'stop' ? 'Prospecto descartado' : 'Se generará un nuevo borrador');
      }
      card.remove();
    })));
  });
}

// --- Results -----------------------------------------------------------------------
async function renderResults(el, campaign) {
  const s = await api(`/campaigns/${campaign.id}/stats`);
  const t = s.totals;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  const funnel = [['Prospectos', t.prospects], ['Contactados', t.contacted], ['Respondieron', t.replied], ['Interesados', t.interested], ['Reuniones', t.meetings], ['Oportunidades', t.opportunities], ['Cierres', t.won]];
  const max = Math.max(1, t.prospects);
  el.innerHTML = `
    <div class="card"><h2>Embudo</h2>
      ${funnel.map(([l, v]) => `<div class="funnel-row"><span>${l}</span><div class="funnel-bar"><div style="width:${Math.max(2, (v / max) * 100)}%"></div></div><b>${v}</b></div>`).join('')}
      <p class="muted small">Apertura ${t.open_rate}% · respuesta ${t.reply_rate}% · reuniones ${t.meeting_rate}% de los contactados · rebote ${t.bounce_rate}% · ${t.unsubscribed} bajas</p>
      ${t.bounce_rate > 3 ? '<p class="notice">Rebote superior al 3%: revisa la calidad de la base antes de seguir enviando.</p>' : ''}
    </div>
    <div class="card"><h2>Por segmento</h2><div class="table-wrap"><table><thead><tr><th>Segmento</th><th>Prospectos</th><th>Contactados</th><th>Respuestas</th><th>Reuniones</th><th>Encaje medio</th></tr></thead>
      <tbody>${s.by_segment.map((r) => `<tr><td>${esc(r.segment)}</td><td>${r.prospects}</td><td>${r.contacted}</td><td>${r.replied} (${pct(r.replied, r.contacted)})</td><td>${r.meetings}</td><td>${r.avg_fit === null ? '—' : `${Math.round(r.avg_fit * 100)}%`}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h2>Variantes (aprendizaje)</h2><p class="muted small">Jev recibe estos resultados como evidencia al elegir la variante; en modo reglas se favorece la mejor tras 20 envíos por variante.</p>
      <div class="table-wrap"><table><thead><tr><th>Paso</th><th>Variante</th><th>Segmento</th><th>Enviados</th><th>Apertura</th><th>Respuesta</th><th>Positivas</th></tr></thead>
      <tbody>${s.by_variant.map((v) => `<tr><td>${v.step_number}</td><td>${esc(v.label)}</td><td>${esc(v.segment || 'todos')}</td><td>${v.sent}</td><td>${pct(v.opened, v.sent)}</td><td>${pct(v.replied, v.sent)}</td><td>${v.positive} (${pct(v.positive, v.sent)})</td></tr>`).join('')}</tbody></table></div></div>
    <div class="grid2">
      <div class="card"><h2>CTAs</h2><table><thead><tr><th>CTA</th><th>Enviados</th><th>Respuesta</th><th>Positivas</th></tr></thead>
        <tbody>${s.by_cta.map((v) => `<tr><td>${esc(v.label)}</td><td>${v.sent}</td><td>${pct(v.replied, v.sent)}</td><td>${v.positive}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin CTAs</td></tr>'}</tbody></table></div>
      <div class="card"><h2>Respuestas y calidad de la base</h2><table><tbody>
        ${s.replies.map((r) => `<tr><td>${esc(REPLY_LABEL[r.category] || r.category)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td class="muted">Sin respuestas aún</td></tr>'}
        ${s.validation.map((r) => `<tr><td>Leads ${esc({ valid: 'válidos', risky: 'riesgosos', invalid: 'inválidos' }[r.status] || r.status)}</td><td>${r.n}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Decisiones: ${s.engines.map((e) => `${esc(engineLabel(e.engine))} (${e.n})`).join(', ') || '—'}</p></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tasks (cold call / LinkedIn)
// ---------------------------------------------------------------------------
async function viewTasks() {
  const { tasks, outcomes } = await api('/tasks?status=open');
  app.innerHTML = `
    <h1>Tareas</h1><p class="muted">Pasos de llamada y LinkedIn de tus secuencias. Al completarlas, la secuencia continúa; una reunión agendada o un "no interesado" la detienen.</p>
    ${tasks.map((t) => `
      <div class="card" data-task="${t.id}">
        <div class="row between"><div><span class="badge">${esc(CHANNEL_LABEL[t.channel])}</span> <b>${esc([t.first_name, t.last_name].filter(Boolean).join(' ') || t.email)}</b> · <span class="muted small">${esc(t.title)} ${t.company ? `en ${esc(t.company)}` : ''}</span></div>
          <span class="small muted">${esc(t.campaign_name)} · paso ${t.step_number} · ${fmtDate(t.created_at)}</span></div>
        <p class="small">${t.phone ? `📞 <a href="tel:${esc(t.phone)}">${esc(t.phone)}</a>` : ''} ${t.linkedin_url ? `· <a href="${esc(t.linkedin_url)}" target="_blank" rel="noopener">Perfil de LinkedIn</a>` : ''} · ✉️ ${esc(t.email)}</p>
        <div class="preview-mail small">${esc(t.instructions)}</div>
        <div class="row" style="margin-top:10px">
          <select data-outcome style="width:auto">${Object.entries(outcomes).filter(([k]) => t.channel === 'linkedin' || k !== 'connected').map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
          <input type="text" data-note placeholder="Nota (opcional)" style="max-width:280px">
          <button class="btn small" data-act="done">Completar</button>
          <button class="btn ghost small" data-act="skip">Omitir</button>
        </div>
      </div>`).join('') || '<div class="card empty">No hay tareas pendientes.</div>'}`;
  $$('[data-task]').forEach((card) => {
    $$('[data-act]', card).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      await api(`/tasks/${card.dataset.task}/complete`, { method: 'POST', body: { outcome: $('[data-outcome]', card).value, note: $('[data-note]', card).value, skip: b.dataset.act === 'skip' } });
      card.remove();
      toast('Tarea cerrada');
    })));
  });
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------
async function viewSenders() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const { senders } = await api('/senders');
  app.innerHTML = `
    <div class="row between"><div><h1>Senders</h1><p class="muted">Buzones de Google Workspace desde los que se envían los correos (vía Gmail API).</p></div>
      <button class="btn" id="connect" ${meta.google_configured ? '' : 'disabled'}>+ Conectar cuenta de Google Workspace</button></div>
    ${params.get('connected') ? `<p class="notice info">Conectado: ${esc(params.get('connected'))}. Revisa la firma importada desde Gmail.</p>` : ''}
    ${params.get('error') ? `<p class="notice">${esc(params.get('error'))}</p>` : ''}
    ${meta.google_configured ? '' : `<p class="notice">Falta configurar Google OAuth. ${currentUser?.is_admin ? '<a href="#/integrations">Ve a Integraciones</a> y carga el Client ID y el Client Secret.' : 'Pide al administrador que lo configure en Integraciones.'}</p>`}
    <div class="notice info">Entregabilidad: calienta cada buzón 2–3 semanas antes de usarlo, configura SPF, DKIM y DMARC, y mantén 20–50 envíos/día por buzón. Idealmente usa un dominio secundario para cold email.</div>
    ${senders.map((s) => `
      <div class="card" data-sender="${s.id}" data-email="${esc(s.email)}">
        <div class="row between"><div><h2 style="margin:0">${esc(s.display_name || s.email)} ${badge(s.status)}</h2>
          <p class="muted small">${esc(s.email)} · ${esc(s.google_domain || 'gmail')} · ${s.sent_last_24h}/${s.daily_limit} en las últimas 24 h · último envío ${fmtDate(s.last_sent_at)}</p>
          ${s.last_error ? `<p class="small" style="color:var(--bad)">${esc(s.last_error)}</p>` : ''}</div>
          <div class="row">
            <button class="btn ghost small" data-act="${s.status === 'active' ? 'pause' : 'activate'}">${s.status === 'active' ? 'Pausar' : 'Activar'}</button>
            ${s.status === 'error' ? '<button class="btn small" data-act="reconnect">Reconectar</button>' : ''}
            <button class="btn danger small" data-act="delete">Eliminar</button>
          </div></div>
        <div class="grid2" style="margin-top:12px">
          <div><label>Nombre para mostrar</label><input type="text" data-k="display_name" value="${esc(s.display_name)}"></div>
          <div class="row">
            <div><label>Límite diario</label><input type="number" min="1" max="500" data-k="daily_limit" value="${s.daily_limit}"></div>
            <div><label>Segundos mín. entre envíos</label><input type="number" min="30" max="3600" data-k="min_delay_seconds" value="${s.min_delay_seconds}"></div>
          </div>
        </div>
        <div style="margin-top:12px"><label>Firma (HTML) <span class="hint">— se agrega a cada correo de este sender</span></label>
          <textarea data-k="signature_html" style="min-height:90px">${esc(s.signature_html)}</textarea>
          <p class="small muted">Vista previa:</p><iframe class="sig" sandbox></iframe></div>
        <div class="row" style="margin-top:10px">
          <button class="btn small" data-act="save">Guardar</button>
          <button class="btn ghost small" data-act="import-signature">Importar firma de Gmail</button>
          <input type="email" placeholder="tu@correo.com" data-test-to style="width:200px">
          <button class="btn ghost small" data-act="test">Enviar prueba</button>
        </div>
      </div>`).join('') || '<div class="card empty">Aún no hay senders conectados.</div>'}`;

  $('#connect').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    location.href = (await api('/senders/google/connect')).url;
  }));
  $$('[data-sender]').forEach((card) => {
    const id = card.dataset.sender;
    const sigInput = $('[data-k="signature_html"]', card);
    const frame = $('iframe.sig', card);
    const updatePreview = () => { frame.srcdoc = `<div style="font-family:Arial,sans-serif;font-size:14px">${sigInput.value}</div>`; };
    sigInput.addEventListener('input', updatePreview);
    updatePreview();
    const patch = (body) => api(`/senders/${id}`, { method: 'PATCH', body });
    $$('[data-act]', card).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      const act = b.dataset.act;
      if (act === 'save') {
        await patch({
          display_name: $('[data-k="display_name"]', card).value,
          daily_limit: Number($('[data-k="daily_limit"]', card).value),
          min_delay_seconds: Number($('[data-k="min_delay_seconds"]', card).value),
          signature_html: sigInput.value,
        });
        toast('Sender guardado');
      } else if (act === 'pause' || act === 'activate') {
        await patch({ status: act === 'pause' ? 'paused' : 'active' });
        viewSenders();
      } else if (act === 'import-signature') {
        sigInput.value = (await api(`/senders/${id}/import-signature`, { method: 'POST' })).signature_html;
        updatePreview();
        toast('Firma importada de Gmail');
      } else if (act === 'test') {
        await api(`/senders/${id}/test`, { method: 'POST', body: { to: $('[data-test-to]', card).value } });
        toast('Correo de prueba enviado');
      } else if (act === 'reconnect') {
        location.href = (await api(`/senders/google/connect?email=${encodeURIComponent(card.dataset.email)}`)).url;
      } else if (act === 'delete') {
        if (!confirm('¿Eliminar este sender? Sus prospectos pasarán a otro sender de la campaña.')) return;
        await api(`/senders/${id}`, { method: 'DELETE' });
        viewSenders();
      }
    })));
  });
}

// ---------------------------------------------------------------------------
// Integrations (admin): API keys for Google Workspace and Jev
// ---------------------------------------------------------------------------
async function viewIntegrations() {
  if (!currentUser?.is_admin) {
    app.innerHTML = '<div class="card"><p>Solo el administrador puede gestionar las integraciones.</p></div>';
    return;
  }
  const data = await api('/admin/integrations');
  const s = data.settings;
  const env = data.environment;
  const source = (item) => (item.source === 'panel' ? '<span class="badge ok">guardado aquí</span>'
    : item.source === 'env' ? '<span class="badge">variable de Railway</span>' : '<span class="badge warn">sin configurar</span>');
  const copyField = (label, value) => `<div><label>${esc(label)}</label><div class="row" style="flex-wrap:nowrap"><input type="text" readonly value="${esc(value)}"><button class="btn ghost small" data-copy="${esc(value)}">Copiar</button></div></div>`;
  const secretInput = (key, placeholder) => `<input type="password" data-key="${key}" autocomplete="new-password" placeholder="${esc(s[key].configured ? `Actual: ${s[key].value} — escribe para reemplazar` : placeholder)}">`;
  const check = (ok, good, bad) => `<li>${ok ? '✅' : '⚠️'} ${ok ? good : bad}</li>`;

  app.innerHTML = `
    <h1>Integraciones</h1>
    <p class="muted">Las claves se guardan cifradas (AES-256-GCM) en la base de datos y nunca se vuelven a mostrar completas. Un valor guardado aquí tiene prioridad sobre la variable de Railway del mismo nombre.</p>
    <div class="grid4" style="margin:16px 0">
      <div class="stat"><b>${meta.google_configured ? '✅' : '—'}</b><span>Google Workspace (senders)</span></div>
      <div class="stat"><b>${meta.jev_configured ? '✅' : '—'}</b><span>Jev ${meta.jev_configured ? `· ${esc(meta.jev_model)}` : '(sin clave: decisiones por reglas)'}</span></div>
      <div class="stat"><b>${meta.openai_configured ? '✅' : '—'}</b><span>OpenAI ${meta.openai_configured ? `· ${esc(meta.openai_model)}` : '(sin clave: sin redacción con IA)'}</span></div>
      <div class="stat"><b>${env.persistent_volume && env.https ? '✅' : '⚠️'}</b><span>Servidor y almacenamiento</span></div>
    </div>

    <div class="card" id="google-card">
      <div class="row between"><h2 style="margin:0">Google Workspace (OAuth)</h2><div>${source(s.google_client_id)} ${source(s.google_client_secret)}</div></div>
      <details style="margin:10px 0"><summary class="small"><b>Cómo obtener las credenciales (5 minutos)</b></summary><ol class="small guide">
        <li>En <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> crea un proyecto y habilita la <b>Gmail API</b>.</li>
        <li><b>Pantalla de consentimiento OAuth</b>: tipo <b>Interno</b> (si los senders son de tu organización de Workspace).</li>
        <li><b>Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web</b>.</li>
        <li>Pega en <b>Orígenes de JavaScript autorizados</b> y <b>URI de redireccionamiento autorizados</b> los valores de abajo.</li>
        <li>Copia aquí el <b>Client ID</b> y el <b>Client Secret</b>, guarda y pulsa <b>Probar conexión</b>.</li></ol></details>
      <div class="grid2">
        ${copyField('URI de redireccionamiento autorizado', data.google.redirect_uri)}
        ${copyField('Origen de JavaScript autorizado', data.google.javascript_origin)}
      </div>
      <div class="grid2" style="margin-top:12px">
        <div><label>Client ID</label><input type="text" data-key="google_client_id" value="${esc(s.google_client_id.source === 'panel' ? s.google_client_id.value : '')}" placeholder="${esc(s.google_client_id.source === 'env' ? s.google_client_id.value : '123-abc.apps.googleusercontent.com')}"></div>
        <div><label>Client Secret</label>${secretInput('google_client_secret', 'GOCSPX-…')}</div>
        <div><label>Dominios permitidos <span class="hint">(opcional, separados por coma)</span></label><input type="text" data-key="allowed_google_domains" value="${esc(s.allowed_google_domains.value)}" placeholder="tuempresa.com"></div>
        <div><label>Cuentas @gmail.com</label><select data-key="allow_consumer_gmail"><option value="false" ${s.allow_consumer_gmail.value !== 'true' ? 'selected' : ''}>No permitir (solo Workspace)</option><option value="true" ${s.allow_consumer_gmail.value === 'true' ? 'selected' : ''}>Permitir</option></select></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-save="google">Guardar</button>
        <button class="btn ghost" data-test="google">Probar conexión</button>
        ${s.google_client_secret.source === 'panel' ? '<button class="btn danger small" data-clear="google_client_id,google_client_secret">Quitar credenciales</button>' : ''}
        <span data-result="google" class="small"></span>
      </div>
    </div>

    <div class="card" id="jev-card">
      <div class="row between"><h2 style="margin:0">Jev (TypeSafe)</h2><div>${source(s.typesafe_api_key)}</div></div>
      <p class="muted small">Obtén la clave en <a href="https://typesafe.ai" target="_blank" rel="noopener">typesafe.ai</a>. Sin clave, la herramienta funciona con reglas (segmentación por palabras clave, rotación A/B).</p>
      <div class="grid2">
        <div><label>API key</label>${secretInput('typesafe_api_key', 'Pega tu API key de TypeSafe')}</div>
        <div><label>Modelo</label><input type="text" data-key="typesafe_model" value="${esc(s.typesafe_model.value)}" placeholder="jev-latest"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-save="jev">Guardar</button>
        <button class="btn ghost" data-test="jev">Probar conexión</button>
        ${s.typesafe_api_key.source === 'panel' ? '<button class="btn danger small" data-clear="typesafe_api_key">Quitar clave</button>' : ''}
        <span data-result="jev" class="small"></span>
      </div>
    </div>

    <div class="card" id="openai-card">
      <div class="row between"><h2 style="margin:0">OpenAI (redacción de textos)</h2><div>${source(s.openai_api_key)}</div></div>
      <p class="muted small">Se usa para <b>proponer</b> asuntos y correos con el contexto de la marca y los resultados de las variantes ganadoras. Lo que genera la IA entra como propuesta: nada se envía sin tu aprobación. Obtén la clave en <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>.</p>
      <div class="grid2">
        <div><label>API key</label>${secretInput('openai_api_key', 'sk-…')}</div>
        <div><label>Modelo</label><input type="text" data-key="openai_model" value="${esc(s.openai_model.value)}" placeholder="gpt-4.1-mini"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-save="openai">Guardar</button>
        <button class="btn ghost" data-test="openai">Probar conexión</button>
        ${s.openai_api_key.source === 'panel' ? '<button class="btn danger small" data-clear="openai_api_key">Quitar clave</button>' : ''}
        <span data-result="openai" class="small"></span>
      </div>
    </div>

    <div class="card">
      <h2>Servidor (variables de Railway)</h2>
      <p class="muted small">Estas no se editan aquí: protegen las sesiones y cifran las claves de arriba.</p>
      <ul class="guide small">
        ${check(env.jwt_secret, '<code>JWT_SECRET</code> configurado', 'Falta <code>JWT_SECRET</code>')}
        ${check(env.encryption_key, '<code>ENCRYPTION_KEY</code> configurado (no lo cambies: las claves guardadas dejarían de poder leerse)', 'Falta <code>ENCRYPTION_KEY</code>')}
        ${check(env.persistent_volume, `Base de datos en volumen persistente (<code>${esc(env.database_path)}</code>)`, `La base está en <code>${esc(env.database_path)}</code>: monta un Volume en <code>/data</code> o perderás los datos en cada deploy`)}
        ${check(env.https, `URL pública HTTPS: <code>${esc(env.base_url)}</code>`, `La URL pública no es HTTPS (<code>${esc(env.base_url)}</code>): el pixel de aperturas y el login de Google la necesitan`)}
        ${check(env.scheduler, 'Programador de envíos activo', 'Programador de envíos desactivado (SCHEDULER_ENABLED=false)')}
      </ul>
    </div>`;

  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Copiado');
    } catch {
      toast('Selecciona el texto y cópialo manualmente');
    }
  }));
  const groups = { google: ['google_client_id', 'google_client_secret', 'allowed_google_domains', 'allow_consumer_gmail'], jev: ['typesafe_api_key', 'typesafe_model'], openai: ['openai_api_key', 'openai_model'] };
  // Reload meta and re-render through the router so the top bar (Jev badge) updates too.
  const refresh = async () => {
    meta = await fetch('/api/meta').then((r) => r.json());
    await router();
  };
  $$('[data-save]').forEach((b) => b.addEventListener('click', () => guard(b, async () => {
    const patch = {};
    for (const key of groups[b.dataset.save]) {
      const input = $(`[data-key="${key}"]`);
      // Empty secret inputs mean "keep the current value".
      if (input.type === 'password' && !input.value.trim()) continue;
      patch[key] = input.value.trim();
    }
    await api('/admin/integrations', { method: 'PUT', body: patch });
    toast('Guardado');
    await refresh();
  })));
  $$('[data-clear]').forEach((b) => b.addEventListener('click', () => guard(b, async () => {
    if (!confirm('¿Quitar estas credenciales? Se usará la variable de Railway si existe.')) return;
    await api('/admin/integrations', { method: 'PUT', body: Object.fromEntries(b.dataset.clear.split(',').map((k) => [k, null])) });
    await refresh();
  })));
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => guard(b, async () => {
    const out = $(`[data-result="${b.dataset.test}"]`);
    out.textContent = 'Probando…';
    const r = await api(`/admin/integrations/test-${b.dataset.test}`, { method: 'POST' });
    out.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    out.textContent = r.ok
      ? (r.message || `Conectado · modelo ${r.model} · ${r.latency_ms} ms`)
      : r.error;
  })));
}

// ---------------------------------------------------------------------------
// Brands: commercial context per brand
// ---------------------------------------------------------------------------
const BRAND_FIELDS = [
  { key: 'industries', n: 1, title: 'Industria y operación', example: 'Retail, distribución, farmacias, importadoras', help: 'A qué tipo de empresas vendemos. Jev lo usa para responder "¿esta empresa encaja con la marca?" e inferir la industria cuando falta.' },
  { key: 'functions', n: 2, title: 'Función del contacto', example: 'Demand Planning, Supply Chain, Compras, Dirección', help: 'Qué responsabilidades tiene la persona correcta. Responde "¿esta persona tiene responsabilidades relacionadas con lo que vendemos?".' },
  { key: 'problems', n: 3, title: 'Problema que queremos resolver', example: 'Errores de pronóstico, faltantes, exceso, reposición', help: 'Separados por coma. Jev elige el que más probablemente le importa a cada persona según su cargo e industria.' },
];

async function viewBrands() {
  const { brands } = await api('/brands');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const selected = brands.find((b) => String(b.id) === params.get('id')) || null;
  const editing = params.get('id') === 'new' ? {} : selected;
  app.innerHTML = `
    <div class="row between"><div><h1>Marcas</h1><p class="muted">El contexto de cada marca guía el análisis de leads (Jev), la redacción con IA y los guiones de llamada. Cada campaña usa una marca.</p></div>
      <a class="btn" href="#/brands?id=new">+ Nueva marca</a></div>
    <div class="brands-layout">
      <div class="card brand-list">${brands.map((b) => `<a href="#/brands?id=${b.id}" class="${selected?.id === b.id ? 'active' : ''}"><b>${esc(b.name)}</b><span class="small muted">${b.campaigns} campaña(s)</span></a>`).join('') || '<p class="muted small">Aún no hay marcas.</p>'}</div>
      <div>${editing ? brandForm(editing) : '<div class="card empty">Selecciona o crea una marca.</div>'}</div>
    </div>`;
  if (!editing) return;
  $('#brand-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(e.submitter, async () => {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const res = editing.id
        ? await api(`/brands/${editing.id}`, { method: 'PUT', body: data })
        : await api('/brands', { method: 'POST', body: data });
      toast('Marca guardada');
      location.hash = `#/brands?id=${res.brand.id}`;
      if (editing.id) viewBrands();
    });
  });
  $('#brand-delete')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
    if (!confirm('¿Eliminar la marca? Las campañas que la usan quedarán sin marca.')) return;
    await api(`/brands/${editing.id}`, { method: 'DELETE' });
    location.hash = '#/brands';
  }));
}

function brandForm(b) {
  const field = (key, label, { area = false, placeholder = '', rows = 3 } = {}) => `<div><label>${label}</label>${area
    ? `<textarea name="${key}" rows="${rows}" style="min-height:${rows * 24}px;font-family:inherit;font-size:14px" placeholder="${esc(placeholder)}">${esc(b[key] || '')}</textarea>`
    : `<input type="text" name="${key}" value="${esc(b[key] || '')}" placeholder="${esc(placeholder)}">`}</div>`;
  return `<form id="brand-form" class="stack">
    <div class="card stack">
      <div class="grid2">${field('name', 'Nombre de la marca', { placeholder: 'Previsio' })}${field('website', 'Sitio web', { placeholder: 'https://…' })}</div>
      ${field('value_proposition', 'Propuesta de valor', { area: true, placeholder: 'Qué resolvemos, para quién y con qué resultado medible' })}
      <div class="grid2">${field('tone', 'Tono', { placeholder: 'Cercano, consultivo, sin tecnicismos' })}${field('avoid', 'Nunca decir', { placeholder: 'gratis, garantizado, revolucionario' })}</div>
    </div>
    ${BRAND_FIELDS.map((f) => `<div class="card brand-q">
      <div class="brand-q-num">${f.n}</div>
      <div><h3>${f.title}</h3><p class="muted small">${f.help}</p>${field(f.key, '', { area: true, placeholder: `Ejemplo: ${f.example}`, rows: 2 })}</div>
    </div>`).join('')}
    <div class="card brand-q">
      <div class="brand-q-num">4</div>
      <div class="stack" style="width:100%"><h3>Mensaje específico de referencia</h3>
        <p class="muted small">Subject + email + argumento de llamada. La IA lo toma como referencia de estilo y contenido; los guiones de llamada parten del argumento.</p>
        ${field('ref_subject', 'Asunto', { placeholder: 'faltantes en {{company}}' })}
        ${field('ref_email', 'Correo', { area: true, rows: 6, placeholder: 'Hola {{first_name}},\n\n…' })}
        ${field('ref_call', 'Argumento de llamada', { area: true, rows: 3, placeholder: 'Validar cómo planifican la reposición hoy y cuántos faltantes tienen por mes…' })}
      </div>
    </div>
    <div class="row"><button class="btn" type="submit">Guardar marca</button>${b.id ? '<button class="btn danger small" type="button" id="brand-delete">Eliminar</button>' : ''}</div>
  </form>`;
}

// ---------------------------------------------------------------------------
// Companies (accounts)
// ---------------------------------------------------------------------------
const ACCOUNT_LABEL = { meeting: 'Reunión', replied: 'Respondió', in_progress: 'En contacto', ready: 'Lista', research: 'Requiere investigación', excluded: 'Excluida' };
const accountBadge = (s) => `<span class="badge ${['meeting', 'replied'].includes(s) ? 'ok' : s === 'research' ? 'warn' : s === 'excluded' ? 'bad' : ''}">${esc(ACCOUNT_LABEL[s] || s)}</span>`;

async function viewCompanies() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const { companies } = await api(`/companies?${new URLSearchParams({ q })}`);
  app.innerHTML = `
    <div class="row between"><div><h1>Empresas</h1><p class="muted">Trabajamos por cuenta, no solo por dirección de correo: contactar a 2–3 personas de una empresa aumenta la probabilidad de respuesta. Las reglas por empresa se configuran en cada campaña (Reglas de envío).</p></div>
      <input type="text" id="c-q" placeholder="Buscar empresa, dominio o industria…" value="${esc(q)}" style="max-width:280px"></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Empresa</th><th>Estado de la cuenta</th><th>Contactos</th><th>Contactados</th><th>Respuestas</th><th>Reuniones</th><th>Leads</th><th>Último contacto</th></tr></thead>
      <tbody>${companies.map((co) => `
        <tr class="clickable" data-company="${co.id}">
          <td><b>${esc(co.name || co.domain)}</b><br><span class="small muted">${esc(co.domain)}${co.industry ? ` · ${esc(co.industry)}` : ''}</span></td>
          <td>${accountBadge(co.account_status)}</td><td>${co.contacts}</td><td>${co.contacted}</td><td>${co.replied}</td><td>${co.meetings}</td>
          <td class="small">${co.ready ? `${co.ready} aptos ` : ''}${co.research ? `· ${co.research} a investigar ` : ''}${co.excluded ? `· ${co.excluded} excluidos` : ''}</td>
          <td class="small">${fmtDate(co.last_contact)}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">Aún no hay empresas: se crean al importar leads.</td></tr>'}</tbody>
    </table></div>`;
  let timer;
  $('#c-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { location.hash = `#/companies?q=${encodeURIComponent(e.target.value)}`; }, 400); });
  $$('[data-company]').forEach((tr) => tr.addEventListener('click', () => showCompany(Number(tr.dataset.company))));
  if (params.get('id')) showCompany(Number(params.get('id')));
}

async function showCompany(id) {
  const { company, contacts } = await api(`/companies/${id}`);
  openModal(`<h2>${esc(company.name || company.domain)}</h2>
    <p class="muted">${esc(company.domain)}${company.industry ? ` · ${esc(company.industry)}` : ''} · ${contacts.length} contacto(s)</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Contacto</th><th>Campaña</th><th>Lead</th><th>Estado</th><th>Paso</th><th>Último contacto</th></tr></thead>
      <tbody>${contacts.map((ct) => `<tr>
        <td><b>${esc([ct.first_name, ct.last_name].filter(Boolean).join(' ') || ct.email)}</b><br><span class="small muted">${esc(ct.title || '—')} · ${esc(ct.email)}</span></td>
        <td class="small"><a href="#/campaigns/${ct.campaign_id}/prospects">${esc(ct.campaign)}</a></td>
        <td>${leadBadge(ct.lead_status)}${ct.lead_status !== 'ready' && ct.lead_status_reasons ? `<br><span class="small muted">${esc(ct.lead_status_reasons)}</span>` : ''}</td>
        <td>${badge(ct.status)}${ct.outcome ? ` <span class="badge ok">${esc(OUTCOME_LABEL[ct.outcome])}</span>` : ''}</td>
        <td>${ct.current_step}</td><td class="small">${fmtDate(ct.last_contact)}</td></tr>`).join('')}</tbody>
    </table></div>`);
}

// ---------------------------------------------------------------------------
// Rules & architecture guide (summary of docs/BEST_PRACTICES.md)
// ---------------------------------------------------------------------------
function viewGuide() {
  const rows = (list) => list.map(([a, b]) => `<tr><td><b>${a}</b></td><td>${b}</td></tr>`).join('');
  app.innerHTML = `
    <h1>Reglas y arquitectura</h1>
    <p class="muted">Cómo decide la herramienta y qué revisa el control de calidad en cada correo. Detalle y fuentes en <code>docs/BEST_PRACTICES.md</code>.</p>
    <div class="card"><h2>Arquitectura de decisión</h2><ol class="guide">
      <li><b>Importación</b> — CSV o Excel, con origen y base legal obligatorios.</li>
      <li><b>Validación</b> — formato, dominio con MX, cuentas genéricas/personales, desechables, duplicados y lista de baja. Inválidos se detienen; riesgosos pasan por aprobación.</li>
      <li><b>Inteligencia comercial</b> — Jev asigna segmento, puntúa el encaje con el ICP y excluye a quien claramente no encaja.</li>
      <li><b>Generación + control de calidad</b> — Jev elige variante, gancho verificable, hipótesis de problema y CTA; el control de calidad aplica las reglas y decide si va a aprobación.</li>
      <li><b>Orquestador</b> — correos dentro de la ventana con límites por sender, tareas de llamada y LinkedIn, seguimientos en el mismo hilo.</li>
      <li><b>Resultados y aprendizaje</b> — respuestas, interés, reuniones, oportunidades y cierres; los resultados por variante vuelven a Jev como evidencia.</li></ol></div>
    <div class="grid2">
      <div class="card"><h2>Reglas del asunto</h2><table><tbody>${rows([
        ['Longitud', 'Preferentemente 3–7 palabras'], ['Personalización', 'Cargo, problema o empresa, cuando sea relevante'],
        ['Estilo', 'Conversacional, profesional, sin publicidad exagerada'], ['Mayúsculas', 'Escritura normal, sin bloques en MAYÚSCULAS'],
        ['Signos', 'Sin exclamaciones ni puntuación repetida'], ['Preguntas', 'Permitidas cuando sean naturales'],
        ['Emojis', 'Desactivados en el primer contacto B2B (error)'], ['Re: / Fwd:', 'Solo en un hilo o reenvío real (error)'],
        ['Variantes', '2–3 por segmento; Jev elige una por prospecto'],
      ])}</tbody></table></div>
      <div class="card"><h2>Reglas del cuerpo</h2><table><tbody>${rows([
        ['Longitud', 'Objetivo 45–85 palabras; advertencia desde 110'], ['Primer párrafo', 'Contexto real de la persona o su responsabilidad ({{gancho}})'],
        ['Segundo párrafo', 'Una hipótesis de problema relevante ({{problema}})'], ['Tercer párrafo', 'Una pregunta o propuesta breve ({{cta}})'],
        ['CTA', 'Máximo una acción principal'], ['Tono', 'Humano, directo, respetuoso, sin exageraciones'],
        ['Personalización', 'Al menos un elemento relevante, verificable y no trivial'], ['Enlaces', 'Ninguno en el primer correo (error), salvo la baja'],
        ['Adjuntos', 'No se envían adjuntos'], ['Firma', 'Nombre e identidad reales del remitente (error si falta)'],
        ['Idioma', 'Español natural adaptado al país y sector'],
      ])}</tbody></table></div>
    </div>
    <div class="card"><h2>Severidades</h2><ul class="guide">
      <li>⛔ <b>Error</b>: bloquea el envío hasta que una persona edite o confirme.</li>
      <li>⚠️ <b>Advertencia</b>: el correo va a la cola de aprobación (según el modo de la campaña).</li>
      <li>ℹ️ <b>Info</b>: sugerencia, no detiene nada.</li></ul></div>`;
}

// ---------------------------------------------------------------------------
(async function init() {
  meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({ max_steps: 4 }));
  router();
}());
