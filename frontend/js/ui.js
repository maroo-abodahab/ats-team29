// Small UI helpers shared by every page.
// SECURITY: h() builds elements with textContent, never innerHTML, so any text that came
// from a user (names, cover letters, job titles...) is shown as text and cannot run as code.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const view = () => document.getElementById('view');
function render(...nodes) {
  const v = view();
  v.replaceChildren(...nodes.flat());
  v.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function toast(message, type = 'info') {
  const t = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4500);
}

// Shows an API error: field errors next to the inputs, the rest as a message.
function showError(err, form) {
  if (form) {
    form.querySelectorAll('.field-error').forEach((e) => e.remove());
    form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
  }
  const unplaced = [];
  for (const d of err.details || []) {
    const name = d.field.split(/[.[]/)[0];
    const input = form?.querySelector(`[name="${CSS.escape(name)}"]`);
    if (input) {
      input.classList.add('invalid');
      input.closest('label, .field')?.append(h('span', { class: 'field-error' }, `${d.message}`));
    } else unplaced.push(`${d.field} ${d.message}`);
  }
  const prefix = err.status ? `${err.status} ` : '';
  toast(`${prefix}${err.message}${unplaced.length ? ` (${unplaced.join('; ')})` : ''}`, 'error');
}

// Wraps a form submit: disables the button, collects values, shows errors.
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await handler(formValues(form));
    } catch (err) {
      showError(err, form);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return form;
}

// Reads a form. Empty fields are left out; number inputs become numbers.
function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.type === 'submit') continue;
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    const v = el.value.trim();
    if (v === '') continue;
    out[el.name] = el.type === 'number' ? Number(v) : v;
  }
  return out;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
const input = (name, props = {}) => h('input', { name, ...props });
const textarea = (name, props = {}) => h('textarea', { name, rows: 4, ...props });
function select(name, options, { selectedValue, ...props } = {}) {
  return h('select', { name, ...props }, options.map(([value, text]) => h('option', { value, selected: selectedValue === value || undefined }, text)));
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const badge = (value, kind = value) => h('span', { class: `badge badge-${String(kind).replace(/[^a-z_]/gi, '')}` }, label(value));

function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
}
function emptyState(text) { return h('p', { class: 'empty' }, text); }
function pageHeader(title, subtitle, ...actions) {
  return h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null), h('div', { class: 'actions' }, ...actions));
}
function button(text, onClick, cls = 'btn') { return h('button', { type: 'button', class: cls, onClick }, text); }
const link = (text, href, cls) => h('a', { href, class: cls }, text);

async function guarded(fn) {
  try { await fn(); } catch (err) {
    if (err.status === 401) return;
    render(card('Something went wrong', h('p', { class: 'error-text' }, `${err.status || ''} ${err.message}`), link('Back to jobs', '#/jobs', 'btn')));
  }
}

function confirmAction(message) { return window.confirm(message); }
