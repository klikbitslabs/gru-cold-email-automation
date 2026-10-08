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
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));
    const jev = $('#jev-badge');
    jev.textContent = meta.jev_configured ? `Jev activo · ${meta.jev_model}` : 'Jev sin API key · reglas';
    jev.className = `badge ${meta.jev_configured ? 'ok' : 'warn'}`;
    jev.title = meta.jev_configured ? 'Las decisiones usan TypeSafe Jev' : 'Configura TYPESAFE_API_KEY para decisiones con Jev';
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
async function viewCampaigns() {
  const { campaigns } = await api('/campaigns');
  app.innerHTML = `
    <div class="row between"><div><h1>Campañas</h1><p class="muted">Secuencias de hasta ${meta.max_steps} envíos por prospecto.</p></div>
      <button class="btn" id="new-campaign">+ Nueva campaña</button></div>
    ${campaigns.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Campaña</th><th>Estado</th><th>Prospectos</th><th>Enviados</th><th>Apertura</th><th>Respuesta</th><th>Interesados</th></tr></thead>
      <tbody>${campaigns.map((c) => `
        <tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${badge(c.status)}</td>
        <td>${c.stats.prospects} <span class="muted small">(${c.stats.active} activos)</span></td><td>${c.stats.sent}</td>
        <td>${c.stats.open_rate}%</td><td>${c.stats.reply_rate}%</td><td>${c.stats.interested}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card empty"><p>Aún no tienes campañas.</p><p>1) Conecta un sender de Google Workspace · 2) Crea la secuencia · 3) Importa tu CSV · 4) Activa.</p></div>'}`;
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/campaigns/${tr.dataset.id}`; }));
  $('#new-campaign').addEventListener('click', async (e) => {
    await guard(e.currentTarget, async () => {
      const { campaign } = await api('/campaigns', { method: 'POST', body: defaultCampaign() });
      location.hash = `#/campaigns/${campaign.id}`;
    });
  });
}

function defaultCampaign() {
  return {
    name: `Campaña ${new Date().toLocaleDateString('es')}`,
    offer: '',
    icp: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Panama',
    steps: [
      { delay_days: 0, same_thread: true, variants: [{ label: 'A · Dolor', angle: 'Abre con un problema concreto del rol del prospecto y el costo de no resolverlo', subject: 'idea para {{company}}', body: 'Hola {{first_name}},\n\nvi que {{company}} está creciendo su equipo comercial. La mayoría de equipos así pierde horas investigando prospectos a mano.\n\nAyudamos a equipos similares a reducir ese tiempo a la mitad.\n\n{{cta}}' }] },
      { delay_days: 3, same_thread: true, variants: [{ label: 'A · Prueba social', angle: 'Aporta un resultado medible de un cliente parecido', subject: '', body: '{{first_name}}, por contexto: un equipo parecido a {{company}} pasó de 5 a 12 reuniones por semana en un mes.\n\n{{cta}}' }] },
      { delay_days: 4, same_thread: true, variants: [{ label: 'A · Nuevo ángulo', angle: 'Otro dolor distinto, muy corto', subject: '', body: '{{first_name}}, otra forma de verlo: ¿cuánto tiempo dedica tu equipo a hacer seguimiento manual?\n\n{{cta}}' }] },
      { delay_days: 7, same_thread: true, variants: [{ label: 'A · Cierre', angle: 'Breakup: cierre respetuoso y fácil de responder', subject: '', body: '{{first_name}}, no quiero llenar tu bandeja. ¿Lo dejo aquí o lo retomamos más adelante?' }] },
    ].slice(0, meta.max_steps || 4),
    ctas: [
      { label: 'Interés', description: 'Baja fricción: solo confirmar interés. Para prospectos sin interacción.', text: '¿Te interesa que te envíe más detalles?' },
      { label: 'Recurso', description: 'Ofrecer un recurso útil sin pedir reunión.', text: '¿Te comparto un video de 2 minutos con cómo lo hacemos?' },
      { label: 'Llamada', description: 'Pedido directo de reunión corta. Solo para prospectos que abrieron varias veces o encajan muy bien.', text: '¿Tienes 15 minutos esta semana para verlo?' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Campaign detail (tabs)
// ---------------------------------------------------------------------------
async function viewCampaign(id, tab = 'sequence') {
  const [{ campaign }, { senders }] = await Promise.all([api(`/campaigns/${id}`), api('/senders')]);
  const canRun = campaign.status !== 'active';
  app.innerHTML = `
    <div class="row between">
      <div><a href="#/campaigns" class="small">← Campañas</a><h1>${esc(campaign.name)} ${badge(campaign.status)}</h1>
        <p class="muted small">${campaign.stats.prospects} prospectos · ${campaign.stats.sent} enviados · ${campaign.stats.open_rate}% apertura · ${campaign.stats.reply_rate}% respuesta</p></div>
      <div class="row">
        <button class="btn ${canRun ? 'ok' : 'ghost'}" id="toggle-status">${canRun ? '▶ Activar' : '⏸ Pausar'}</button>
        <button class="btn ghost" id="run-now" title="Ejecuta el scheduler ahora (respeta ventanas y límites)">Procesar ahora</button>
        <button class="btn danger small" id="delete-campaign">Eliminar</button>
      </div>
    </div>
    <div class="tabs">${[['sequence', 'Secuencia'], ['settings', 'Configuración'], ['prospects', 'Prospectos'], ['stats', 'Estadísticas']]
      .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/campaigns/${id}/${b.dataset.tab}`; }));
  $('#toggle-status').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    await api(`/campaigns/${id}/status`, { method: 'POST', body: { status: canRun ? 'active' : 'paused' } });
    toast(canRun ? 'Campaña activada' : 'Campaña pausada');
    router();
  }));
  $('#run-now').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    const r = await api('/scheduler/run', { method: 'POST' });
    toast(r.skipped ? 'El scheduler ya está corriendo' : `Procesado: ${r.sent} correo(s) enviado(s)`);
    router();
  }));
  $('#delete-campaign').addEventListener('click', (e) => guard(e.currentTarget, async () => {
    if (!confirm('¿Eliminar la campaña con sus prospectos y estadísticas?')) return;
    await api(`/campaigns/${id}`, { method: 'DELETE' });
    location.hash = '#/campaigns';
  }));

  const el = $('#tab');
  if (tab === 'settings') return renderSettings(el, campaign, senders);
  if (tab === 'prospects') return renderProspects(el, campaign);
  if (tab === 'stats') return renderStats(el, campaign);
  return renderSequence(el, campaign);
}

function campaignPayload(c) {
  return {
    name: c.name, offer: c.offer, icp: c.icp, timezone: c.timezone, send_days: c.send_days,
    window_start: c.window_start, window_end: c.window_end, track_opens: c.track_opens,
    include_unsubscribe: c.include_unsubscribe, jev_enabled: c.jev_enabled, stop_on_reply: c.stop_on_reply,
    sender_ids: c.sender_ids,
    steps: c.steps.map((s) => ({ delay_days: Number(s.delay_days) || 0, same_thread: s.same_thread, variants: s.variants })),
    ctas: c.ctas,
  };
}

async function saveCampaign(c, button) {
  return guard(button, async () => {
    const res = await api(`/campaigns/${c.id}`, { method: 'PUT', body: campaignPayload(c) });
    toast(res.warning || 'Guardado', res.warning ? 'error' : 'info');
    return res.campaign;
  });
}

// --- Sequence editor -------------------------------------------------------
async function renderSequence(el, campaign) {
  const c = structuredClone(campaign);
  let lastField = null;
  const fields = await api(`/campaigns/${c.id}/prospects?page=1`).then((r) => r.merge_fields).catch(() => []);

  function draw() {
    el.innerHTML = `
      <div class="card"><div class="row between"><div>
        <h2>Campos de personalización</h2>
        <p class="muted small">Haz clic para insertar en el último campo editado. Usa <code>{{campo|alternativa}}</code> para cuando el dato falte en el CSV; si falta sin alternativa, ese prospecto se detiene en vez de enviar un correo roto.</p></div></div>
        <div class="chips">${[...new Set(fields)].map((f) => `<button class="chip" data-field="${esc(f)}">{{${esc(f)}}}</button>`).join('')}</div>
      </div>
      ${c.steps.map((s, i) => stepHtml(s, i)).join('')}
      <div class="row">
        ${c.steps.length < meta.max_steps ? '<button class="btn ghost" id="add-step">+ Agregar follow-up</button>' : `<span class="muted small">Máximo ${meta.max_steps} envíos por secuencia (buena práctica: ~4 toques).</span>`}
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Llamados a la acción ({{cta}})</h2>
        <p class="muted small">Jev elige el CTA según la interacción del prospecto: baja fricción para quien no ha abierto, más directo para quien abrió varias veces. Ordénalos de más suave a más directo (el modo reglas usa el primero y el último).</p>
        ${c.ctas.map((cta, i) => `
          <div class="variant" data-cta="${i}"><div class="grid2">
            <div><label>Nombre</label><input type="text" data-k="label" value="${esc(cta.label)}"></div>
            <div><label>Cuándo usarlo <span class="hint">(lo lee Jev)</span></label><input type="text" data-k="description" value="${esc(cta.description)}"></div>
          </div><div style="margin-top:8px"><label>Texto</label><input type="text" data-k="text" value="${esc(cta.text)}"></div>
          <button class="btn danger small" data-remove-cta="${i}" style="margin-top:8px">Quitar</button></div>`).join('')}
        <button class="btn ghost small" id="add-cta" style="margin-top:10px">+ CTA</button>
      </div>
      <div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0"><button class="btn" id="save">Guardar secuencia</button></div>`;
    bind();
    $$('[data-lint]', el).forEach((box) => lint(box));
  }

  function stepHtml(s, i) {
    const n = i + 1;
    const needsSubject = n === 1 || !s.same_thread;
    return `<div class="card step" data-step="${i}">
      <div class="step-head"><div class="step-num">${n}</div>
        <b>${n === 1 ? 'Correo inicial' : `Follow-up ${n - 1}`}</b>
        ${n > 1 ? `<label class="check">Esperar <input type="number" min="1" max="60" style="width:70px" data-step-k="delay_days" value="${esc(s.delay_days)}"> días después del anterior</label>
          <label class="check"><input type="checkbox" data-step-k="same_thread" ${s.same_thread ? 'checked' : ''}> Responder en el mismo hilo (Re:)</label>` : ''}
        ${n > 1 && n === c.steps.length ? `<button class="btn danger small" data-remove-step="${i}">Quitar paso</button>` : ''}
      </div>
      <p class="muted small">Variantes = ángulos de mensaje. Si hay más de una, Jev elige la mejor para cada prospecto (o se rota A/B sin Jev).</p>
      ${s.variants.map((v, j) => `
        <div class="variant" data-variant="${j}">
          <div class="grid2">
            <div><label>Nombre de variante</label><input type="text" data-k="label" value="${esc(v.label)}"></div>
            <div><label>Ángulo <span class="hint">(descripción para Jev)</span></label><input type="text" data-k="angle" value="${esc(v.angle)}" placeholder="p. ej. caso de éxito con métrica"></div>
          </div>
          ${needsSubject ? `<div style="margin-top:8px"><label>Asunto <span class="hint">(2–6 palabras, minúsculas)</span></label><input type="text" data-k="subject" data-lint value="${esc(v.subject)}"></div>` : ''}
          <div style="margin-top:8px"><label>Cuerpo <span class="hint">(texto plano, ${n === 1 ? '50–125' : '30–90'} palabras, una sola pregunta)</span></label>
            <textarea data-k="body" data-lint>${esc(v.body)}</textarea></div>
          <ul class="lint" data-lint-out></ul>
          <div class="row" style="margin-top:6px">
            ${v.id ? `<button class="btn ghost small" data-preview="${v.id}" data-step-number="${n}">Vista previa</button>` : '<span class="muted small">Guarda para ver la vista previa</span>'}
            ${s.variants.length > 1 ? `<button class="btn danger small" data-remove-variant="${j}">Quitar variante</button>` : ''}
          </div>
        </div>`).join('')}
      ${s.variants.length < 5 ? '<button class="btn ghost small" data-add-variant style="margin-top:10px">+ Variante (A/B)</button>' : ''}
    </div>`;
  }

  const lintTimers = new Map();
  function lint(input) {
    const variantEl = input.closest('[data-variant]');
    const stepIndex = Number(input.closest('[data-step]').dataset.step);
    const v = c.steps[stepIndex].variants[Number(variantEl.dataset.variant)];
    clearTimeout(lintTimers.get(variantEl));
    lintTimers.set(variantEl, setTimeout(async () => {
      const r = await api('/lint', { method: 'POST', body: { subject: v.subject || '', body: v.body || '', step_number: stepIndex + 1 } }).catch(() => null);
      if (!r) return;
      const out = $('[data-lint-out]', variantEl);
      out.className = `lint ${r.warnings.length ? '' : 'ok'}`;
      out.innerHTML = r.warnings.length
        ? r.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')
        : `<li>✓ ${r.wordCount} palabras · cumple las buenas prácticas</li>`;
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
          inp.addEventListener('focus', () => { lastField = inp; });
          inp.addEventListener('input', () => { v[inp.dataset.k] = inp.value; if (inp.hasAttribute('data-lint')) lint(inp); });
        });
      });
      $$('[data-remove-variant]', stepEl).forEach((b) => b.addEventListener('click', () => { s.variants.splice(Number(b.dataset.removeVariant), 1); draw(); }));
      $('[data-add-variant]', stepEl)?.addEventListener('click', () => {
        const base = s.variants[0];
        s.variants.push({ label: `${String.fromCharCode(65 + s.variants.length)} · nueva`, angle: '', subject: base.subject, body: base.body });
        draw();
      });
    });
    $$('[data-remove-step]', el).forEach((b) => b.addEventListener('click', () => { c.steps.splice(Number(b.dataset.removeStep), 1); draw(); }));
    $('#add-step', el)?.addEventListener('click', () => {
      c.steps.push({ delay_days: 3, same_thread: true, variants: [{ label: 'A', angle: '', subject: '', body: '{{first_name}}, ' }] });
      draw();
    });
    $$('[data-cta]', el).forEach((ctaEl) => {
      const cta = c.ctas[Number(ctaEl.dataset.cta)];
      $$('[data-k]', ctaEl).forEach((inp) => inp.addEventListener('input', () => { cta[inp.dataset.k] = inp.value; }));
    });
    $$('[data-remove-cta]', el).forEach((b) => b.addEventListener('click', () => { c.ctas.splice(Number(b.dataset.removeCta), 1); draw(); }));
    $('#add-cta', el).addEventListener('click', () => { c.ctas.push({ label: 'Nuevo', description: '', text: '' }); draw(); });
    $$('[data-field]', el).forEach((chip) => chip.addEventListener('click', () => {
      if (!lastField) return toast('Primero haz clic en un asunto o cuerpo');
      const tag = `{{${chip.dataset.field}}}`;
      const { selectionStart: a = lastField.value.length, selectionEnd: b = a } = lastField;
      lastField.value = lastField.value.slice(0, a) + tag + lastField.value.slice(b);
      lastField.dispatchEvent(new Event('input'));
      lastField.focus();
      lastField.setSelectionRange(a + tag.length, a + tag.length);
    }));
    $$('[data-preview]', el).forEach((b) => b.addEventListener('click', () => guard(b, async () => {
      const p = await api(`/campaigns/${c.id}/preview`, { method: 'POST', body: { step_number: Number(b.dataset.stepNumber), variant_id: Number(b.dataset.preview) } });
      openModal(`<h2>Vista previa · ${esc(p.variant.label)}</h2>
        <p class="muted small">Para ${esc(p.prospect.name || p.prospect.email)} &lt;${esc(p.prospect.email)}&gt; ${p.missing.length ? `· <b style="color:var(--bad)">faltan: ${esc(p.missing.join(', '))}</b>` : ''}</p>
        <p><b>Asunto:</b> ${esc(p.subject)}</p>
        <div class="preview-mail">${esc(p.body)}</div>
        ${p.signature_html ? '<p class="muted small" style="margin-top:10px">Firma del sender:</p><iframe class="sig" sandbox></iframe>' : '<p class="muted small">Asigna un sender con firma para verla aquí.</p>'}`);
      const frame = $('#modal-body iframe.sig');
      if (frame) frame.srcdoc = `<div style="font-family:Arial,sans-serif;font-size:14px">${p.signature_html}</div>`;
    })));
    $('#save', el).addEventListener('click', async (e) => {
      const saved = await saveCampaign(c, e.currentTarget);
      if (saved) { Object.assign(c, structuredClone(saved)); draw(); }
    });
  }
  draw();
}

// --- Settings --------------------------------------------------------------
function renderSettings(el, campaign, senders) {
  const c = structuredClone(campaign);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [c.timezone];
  el.innerHTML = `
    <div class="card stack">
      <div><label>Nombre</label><input type="text" id="s-name" value="${esc(c.name)}"></div>
      <div><label>Oferta <span class="hint">— qué resuelves y para quién. Jev lo usa para decidir ángulo, CTA y si el prospecto encaja.</span></label>
        <textarea id="s-offer" style="min-height:80px">${esc(c.offer)}</textarea></div>
      <div><label>Perfil de cliente ideal (ICP) <span class="hint">— industria, tamaño, cargos. Jev puntúa el encaje y prioriza a los mejores.</span></label>
        <textarea id="s-icp" style="min-height:80px">${esc(c.icp)}</textarea></div>
    </div>
    <div class="card">
      <h2>Senders (Google Workspace)</h2>
      ${senders.length ? senders.map((s) => `<label class="check"><input type="checkbox" data-sender="${s.id}" ${c.sender_ids.includes(s.id) ? 'checked' : ''}>
        ${esc(s.display_name || s.email)} &lt;${esc(s.email)}&gt; ${badge(s.status)} <span class="muted small">límite ${s.daily_limit}/día</span></label>`).join('')
        : '<p class="muted">No tienes senders. <a href="#/senders">Conecta uno</a>.</p>'}
      <p class="muted small">Con varios senders los prospectos nuevos se reparten (rotación); cada follow-up sale del mismo buzón que el primer correo.</p>
    </div>
    <div class="card">
      <h2>Ventana de envío</h2>
      <div class="grid2">
        <div><label>Zona horaria</label><select id="s-tz">${zones.map((z) => `<option ${z === c.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
        <div class="row"><div><label>Desde</label><input type="time" id="s-start" value="${esc(c.window_start)}"></div><div><label>Hasta</label><input type="time" id="s-end" value="${esc(c.window_end)}"></div></div>
      </div>
      <div class="row" style="margin-top:10px">${DAYS.map(([d, l]) => `<label class="check"><input type="checkbox" data-day="${d}" ${c.send_days.includes(d) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      <p class="muted small">Mejores resultados: martes a jueves, en horario laboral del prospecto. Jev divide la ventana en tres franjas y elige la mejor según cuándo abrió cada prospecto.</p>
    </div>
    <div class="card stack">
      <h2>Opciones</h2>
      <label class="check"><input type="checkbox" id="s-jev" ${c.jev_enabled ? 'checked' : ''}> Usar Jev para decidir mensaje, CTA, momento y a quién contactar ${meta.jev_configured ? '' : '<span class="badge warn">falta TYPESAFE_API_KEY → reglas</span>'}</label>
      <label class="check"><input type="checkbox" id="s-opens" ${c.track_opens ? 'checked' : ''}> Rastrear aperturas (pixel). <span class="muted small">Puede afectar ligeramente la entregabilidad; Apple Mail infla aperturas.</span></label>
      <label class="check"><input type="checkbox" id="s-unsub" ${c.include_unsubscribe ? 'checked' : ''}> Incluir enlace y cabecera de baja (recomendado / requerido en muchos países)</label>
      <label class="check"><input type="checkbox" id="s-reply" ${c.stop_on_reply ? 'checked' : ''}> Detener la secuencia cuando el prospecto responde (las auto-respuestas no la detienen)</label>
    </div>
    <button class="btn" id="save-settings">Guardar configuración</button>`;
  $('#save-settings').addEventListener('click', async (e) => {
    Object.assign(c, {
      name: $('#s-name').value, offer: $('#s-offer').value, icp: $('#s-icp').value, timezone: $('#s-tz').value,
      window_start: $('#s-start').value, window_end: $('#s-end').value,
      send_days: $$('[data-day]').filter((x) => x.checked).map((x) => Number(x.dataset.day)),
      sender_ids: $$('[data-sender]').filter((x) => x.checked).map((x) => Number(x.dataset.sender)),
      jev_enabled: $('#s-jev').checked, track_opens: $('#s-opens').checked, include_unsubscribe: $('#s-unsub').checked, stop_on_reply: $('#s-reply').checked,
    });
    if (await saveCampaign(c, e.currentTarget)) router();
  });
}

// --- Prospects ---------------------------------------------------------------
async function renderProspects(el, campaign, { page = 1, status = '', q = '' } = {}) {
  const params = new URLSearchParams({ page, status, q });
  const data = await api(`/campaigns/${campaign.id}/prospects?${params}`);
  el.innerHTML = `
    <div class="card">
      <h2>Importar CSV</h2>
      <p class="muted small">Columna obligatoria: <code>email</code> (o <code>correo</code>). Reconoce nombre/first_name, apellido, empresa/company, cargo/title. Cualquier otra columna se vuelve un campo de personalización (p. ej. <code>ciudad</code> → <code>{{ciudad}}</code>). Se omiten duplicados y correos dados de baja.</p>
      <form id="import-form" class="row"><input type="file" id="csv" accept=".csv,text/csv" required><button class="btn" type="submit">Importar</button></form>
      <div id="import-result"></div>
    </div>
    <div class="card">
      <div class="row between">
        <h2>${data.total} prospectos</h2>
        <div class="row">
          <input type="text" id="p-q" placeholder="Buscar…" value="${esc(q)}" style="width:180px">
          <select id="p-status" style="width:auto"><option value="">Todos</option>${['active', 'finished', 'replied', 'bounced', 'unsubscribed', 'stopped'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Prospecto</th><th>Empresa</th><th>Estado</th><th>Paso</th><th>Aperturas</th><th>Encaje</th><th>Próximo envío</th></tr></thead>
        <tbody>${data.prospects.map((p) => `
          <tr class="clickable" data-prospect="${p.id}">
            <td><b>${esc([p.first_name, p.last_name].filter(Boolean).join(' ') || '—')}</b><br><span class="muted small">${esc(p.email)}</span></td>
            <td>${esc(p.company)}<br><span class="muted small">${esc(p.title)}</span></td>
            <td>${badge(p.status)}${p.reply_category ? `<br><span class="small">${esc(REPLY_LABEL[p.reply_category] || p.reply_category)}</span>` : ''}${p.stop_reason && p.status === 'stopped' ? `<br><span class="small muted">${esc(p.stop_reason)}</span>` : ''}${p.last_error ? `<br><span class="small" style="color:var(--bad)">${esc(p.last_error)}</span>` : ''}</td>
            <td>${p.current_step}/${campaign.steps.length}</td><td>${p.opens}</td>
            <td>${p.fit_score === null ? '—' : `${Math.round(p.fit_score * 100)}%`}</td>
            <td class="small">${p.status === 'active' ? fmtDate(p.next_send_at) : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">Sin prospectos</td></tr>'}</tbody>
      </table></div>
      ${data.pages > 1 ? `<div class="row" style="margin-top:10px">${page > 1 ? '<button class="btn ghost small" id="prev">← Anterior</button>' : ''}<span class="muted small">Página ${page} de ${data.pages}</span>${page < data.pages ? '<button class="btn ghost small" id="next">Siguiente →</button>' : ''}</div>` : ''}
    </div>`;
  const reload = (opts) => renderProspects(el, campaign, { page, status, q, ...opts });
  $('#import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(e.submitter, async () => {
      const form = new FormData();
      form.append('file', $('#csv').files[0]);
      const r = await api(`/campaigns/${campaign.id}/prospects/import`, { method: 'POST', form });
      toast(`${r.imported} importados`);
      await reload({ page: 1 });
      $('#import-result').innerHTML = `<p class="notice info">${r.imported} importados · ${r.duplicates} duplicados · ${r.suppressed} en lista de baja · ${r.invalid.length} inválidos.
        Columnas detectadas: ${Object.entries(r.mapping).map(([k, v]) => `${esc(k)} ← ${esc(v)}`).join(', ')}</p>
        ${r.invalid.length ? `<p class="small muted">Inválidos: ${r.invalid.slice(0, 20).map((i) => `fila ${i.row} (${esc(i.email || 'vacío')})`).join(', ')}</p>` : ''}`;
    });
  });
  let searchTimer;
  $('#p-q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => reload({ q: e.target.value, page: 1 }), 300); });
  $('#p-status').addEventListener('change', (e) => reload({ status: e.target.value, page: 1 }));
  $('#prev')?.addEventListener('click', () => reload({ page: page - 1 }));
  $('#next')?.addEventListener('click', () => reload({ page: page + 1 }));
  $$('[data-prospect]', el).forEach((tr) => tr.addEventListener('click', () => showProspect(campaign, Number(tr.dataset.prospect), reload)));
}

async function showProspect(campaign, id, reload) {
  const { prospect: p, messages, opens, decisions } = await api(`/prospects/${id}`);
  const body = openModal(`
    <h2>${esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email)} ${badge(p.status)}</h2>
    <p class="muted">${esc(p.email)} · ${esc(p.title)} ${p.company ? `en ${esc(p.company)}` : ''}</p>
    ${p.stop_reason ? `<p class="notice">${esc(p.stop_reason)}</p>` : ''}
    <div class="row">
      ${p.status === 'active' ? '<button class="btn danger small" id="p-stop">Detener secuencia</button>' : ''}
      ${p.status === 'stopped' ? '<button class="btn small" id="p-resume">Reanudar</button>' : ''}
      ${p.status === 'active' ? '<button class="btn ghost small" id="p-sim">Simular decisión de Jev</button>' : ''}
      <button class="btn danger small" id="p-delete">Eliminar</button>
    </div>
    <div id="p-sim-out"></div>
    <h3 style="margin-top:16px">Datos</h3>
    <pre class="json">${esc(JSON.stringify(p.fields, null, 2))}</pre>
    <h3>Correos enviados</h3>
    ${messages.map((m) => `<div class="variant"><div class="row between"><b>Paso ${m.step_number} · ${esc(m.subject)}</b><span class="small muted">${fmtDate(m.sent_at)} · ${esc(m.sender_email || '')}</span></div>
      <p class="small muted">Variante: ${esc(m.variant_label || '—')} · CTA: ${esc(m.cta_label || '—')} · Aperturas: ${m.open_count}${m.last_opened_at ? ` (última ${fmtDate(m.last_opened_at)})` : ''}</p>
      <div class="preview-mail small">${esc(m.body_text)}</div></div>`).join('') || '<p class="muted">Aún no se ha enviado nada.</p>'}
    <h3 style="margin-top:16px">Aperturas</h3>
    ${opens.length ? `<table><tbody>${opens.map((o) => `<tr><td class="small">${fmtDate(o.opened_at)}</td><td class="small">${o.suspected_bot ? '<span class="badge warn">bot/escáner</span>' : '<span class="badge ok">humano</span>'}</td><td class="small muted">${esc(o.user_agent)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin aperturas.</p>'}
    <h3 style="margin-top:16px">Decisiones (Jev / reglas)</h3>
    ${decisions.map((d) => `<details><summary>Paso ${d.step_number} · ${esc(d.engine)} · <b>${esc(d.action)}</b> · ${fmtDate(d.created_at)}</summary><pre class="json">${esc(JSON.stringify(d.detail, null, 2))}</pre></details>`).join('') || '<p class="muted">Sin decisiones aún.</p>'}`);
  const act = (selector, fn) => $(selector, body)?.addEventListener('click', (e) => guard(e.currentTarget, fn));
  act('#p-stop', async () => { await api(`/prospects/${id}`, { method: 'PATCH', body: { status: 'stopped' } }); closeModal(); reload(); });
  act('#p-resume', async () => { await api(`/prospects/${id}`, { method: 'PATCH', body: { status: 'active' } }); closeModal(); reload(); });
  act('#p-delete', async () => { if (!confirm('¿Eliminar prospecto?')) return; await api(`/prospects/${id}`, { method: 'DELETE' }); closeModal(); reload(); });
  act('#p-sim', async () => {
    const r = await api(`/campaigns/${campaign.id}/simulate-decision`, { method: 'POST', body: { prospect_id: id } });
    const step = campaign.steps.find((s) => s.step_number === r.step_number);
    const variant = step?.variants.find((v) => v.id === r.decision.variantId);
    const cta = campaign.ctas.find((x) => x.id === r.decision.ctaId);
    $('#p-sim-out', body).innerHTML = `<div class="notice info" style="margin-top:10px">Paso ${r.step_number} · motor <b>${esc(r.decision.engine)}</b> → <b>${r.decision.action === 'stop' ? 'detener' : 'enviar'}</b>
      · variante: ${esc(variant?.label || '—')} · CTA: ${esc(cta?.label || '—')} · franja: ${esc(r.decision.slot || 'cualquiera')}
      ${r.decision.fitScore !== null && r.decision.fitScore !== undefined ? `· encaje ${Math.round(r.decision.fitScore * 100)}%` : ''}</div>
      <details><summary class="small">Detalle</summary><pre class="json">${esc(JSON.stringify(r.decision.detail, null, 2))}</pre></details>`;
  });
}

// --- Stats -------------------------------------------------------------------
async function renderStats(el, campaign) {
  const s = await api(`/campaigns/${campaign.id}/stats`);
  const t = s.totals;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  el.innerHTML = `
    <div class="grid4">
      ${[['Prospectos', t.prospects], ['Contactados', t.contacted], ['Correos enviados', t.sent], ['Apertura', `${t.open_rate}%`], ['Respuesta', `${t.reply_rate}%`], ['Interesados', t.interested], ['Rebote', `${t.bounce_rate}%`], ['Bajas', t.unsubscribed]]
        .map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('')}
    </div>
    ${t.bounce_rate > 3 ? '<p class="notice" style="margin-top:12px">Rebote superior al 3%: verifica los correos de tu lista antes de seguir enviando para proteger tu dominio.</p>' : ''}
    <div class="grid2" style="margin-top:16px">
      <div class="card"><h2>Por paso</h2><table><thead><tr><th>Paso</th><th>Enviados</th><th>Abiertos</th></tr></thead>
        <tbody>${s.by_step.map((r) => `<tr><td>${r.step_number}</td><td>${r.sent}</td><td>${r.opened} (${pct(r.opened, r.sent)})</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin envíos</td></tr>'}</tbody></table></div>
      <div class="card"><h2>Respuestas</h2><table><tbody>${s.replies.map((r) => `<tr><td>${esc(REPLY_LABEL[r.category] || r.category)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td class="muted">Sin respuestas aún</td></tr>'}</tbody></table>
        <p class="muted small">Motor de decisiones: ${s.engines.map((e) => `${esc(e.engine)} (${e.n})`).join(', ') || '—'}</p></div>
    </div>
    <div class="card"><h2>Variantes (A/B elegido por Jev)</h2><div class="table-wrap"><table><thead><tr><th>Paso</th><th>Variante</th><th>Enviados</th><th>Apertura</th><th>Respuestas</th></tr></thead>
      <tbody>${s.by_variant.map((v) => `<tr><td>${v.step_number}</td><td>${esc(v.label)}</td><td>${v.sent}</td><td>${pct(v.opened, v.sent)}</td><td>${v.replied} (${pct(v.replied, v.sent)})</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h2>CTAs</h2><table><thead><tr><th>CTA</th><th>Enviados</th><th>Prospectos que respondieron</th></tr></thead>
      <tbody>${s.by_cta.map((v) => `<tr><td>${esc(v.label)}</td><td>${v.sent}</td><td>${v.replied}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin CTAs</td></tr>'}</tbody></table></div>`;
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
    ${meta.google_configured ? '' : '<p class="notice">El servidor no tiene GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Sigue la guía del README para crear el cliente OAuth.</p>'}
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
// Best-practice guide (summary of docs/BEST_PRACTICES.md)
// ---------------------------------------------------------------------------
function viewGuide() {
  app.innerHTML = `
    <h1>Buenas prácticas de cold email</h1>
    <p class="muted">Resumen aplicado en la herramienta (linter, límites y decisiones de Jev). Detalle y fuentes en <code>docs/BEST_PRACTICES.md</code>.</p>
    <div class="grid2" style="margin-top:16px">
      <div class="card guide"><h2>Copy</h2><ul>
        <li>Corto: 50–125 palabras el primero, menos en follow-ups. Que se lea en menos de 60 segundos.</li>
        <li>Asunto de 2–6 palabras, en minúsculas, sin "Re:" falsos ni palabras spam.</li>
        <li>Abre con algo específico del prospecto, no con quién eres tú.</li>
        <li>Estructura: contexto específico → problema → costo de no actuar → prueba social con métrica → CTA.</li>
        <li>Una sola petición de baja fricción ("¿te interesa?"), no una reunión de 30 min en el primer correo.</li>
        <li>Texto plano, como entre colegas. Máximo 1 link; sin imágenes ni adjuntos al inicio.</li></ul></div>
      <div class="card guide"><h2>Secuencia</h2><ul>
        <li>~4 toques en total en 2–4 semanas; espaciados de 2–7 días, cada vez más separados.</li>
        <li>Cada follow-up aporta algo nuevo: prueba social, otro ángulo, recurso, y un cierre (breakup) respetuoso.</li>
        <li>Los follow-ups van en el mismo hilo (Re:) para dar contexto.</li>
        <li>Se detiene automáticamente al responder, rebotar o darse de baja.</li>
        <li>La mayoría de respuestas llegan en el 1.º o 2.º correo: invierte ahí el mayor esfuerzo.</li></ul></div>
      <div class="card guide"><h2>Entregabilidad</h2><ul>
        <li>SPF, DKIM y DMARC configurados en el dominio de Google Workspace.</li>
        <li>Calentamiento del buzón 2–3 semanas; 20–50 envíos/día por buzón; varios buzones para escalar.</li>
        <li>Envíos espaciados y aleatorios, solo en horario laboral del prospecto.</li>
        <li>Verifica la lista: rebote &gt; 3% daña tu dominio.</li>
        <li>Enlace y cabecera de baja de un clic.</li></ul></div>
      <div class="card guide"><h2>Cómo usa Jev la herramienta</h2><ul>
        <li><b>A quién:</b> puntúa el encaje con tu ICP (prioriza) y detiene contactos que claramente no encajan.</li>
        <li><b>Qué mensaje:</b> elige la variante (ángulo) por prospecto y paso según su perfil e interacción.</li>
        <li><b>Qué CTA:</b> baja fricción para quien no abre; más directo para quien abrió varias veces.</li>
        <li><b>Cuándo:</b> elige la franja (mañana, mediodía, tarde) según cuándo abrió antes.</li>
        <li><b>Respuestas:</b> clasifica interesado / no interesado / referido / auto-respuesta / rebote.</li></ul></div>
    </div>`;
}

// ---------------------------------------------------------------------------
(async function init() {
  meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({ max_steps: 4 }));
  router();
}());
