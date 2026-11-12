import { el, esc } from './util.js';
import { icon } from './icons.js';

// ---- Overlay stack bound to browser history (back button closes top overlay)
const stack = [];
let ignore = 0, waiters = [];
// guard (opcional): se consulta al pulsar «atrás»; si devuelve true, el cierre se veta y se restaura la entrada de historial.
export function pushOverlay(close, guard) {
  const e = { close, guard };
  stack.push(e);
  history.pushState({ ov: stack.length }, '');
  return e;
}
export function dismiss(e) {
  const i = stack.indexOf(e);
  if (i < 0) return Promise.resolve();
  if (i !== stack.length - 1) { stack.splice(i, 1); e.close(); return Promise.resolve(); }
  stack.pop(); e.close(); ignore++;
  history.back();
  return new Promise(r => waiters.push(r));
}
addEventListener('popstate', () => {
  if (ignore > 0) { ignore--; waiters.splice(0).forEach(f => f()); return; }
  const top = stack[stack.length - 1];
  if (top && top.guard && top.guard()) { history.pushState({ ov: stack.length }, ''); return; }
  const e = stack.pop();
  if (e) e.close(true);
});
export const overlayCount = () => stack.length;

// ---- Bottom sheet
export function sheet({ title, content, onClose }) {
  const back = el('div', 'sheet-back'), s = el('div', 'sheet');
  s.innerHTML = '<div class="grab"></div>' + (title ? `<h2>${esc(title)}</h2>` : '');
  if (content) s.append(content);
  back.append(s);
  document.body.append(back);
  requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('open')));
  const entry = pushOverlay(() => {
    back.classList.remove('open');
    setTimeout(() => back.remove(), 260);
    onClose && onClose();
  });
  back.addEventListener('click', e => { if (e.target === back) api.close(); });
  const api = { el: s, close: () => dismiss(entry) };
  return api;
}
export function menuSheet(rows, title) {
  const c = el('div', 'rows');
  rows.filter(Boolean).forEach(r => {
    const b = el('button', 'row' + (r.danger ? ' danger' : ''), `<span class="ri">${icon(r.icon || 'info', 22)}</span><span class="rl">${esc(r.label)}</span>${r.note ? `<span class="rn">${esc(r.note)}</span>` : ''}`);
    b.onclick = async () => { await s.close(); r.fn && r.fn(); };
    c.append(b);
  });
  const s = sheet({ title, content: c });
  return s;
}

// ---- Dialog (confirm / prompt)
export function dialog({ title, message, input, ok = 'Aceptar', cancel = 'Cancelar', danger }) {
  return new Promise(res => {
    const back = el('div', 'dlg-back'), d = el('div', 'dlg');
    d.innerHTML = `<h2>${esc(title || '')}</h2>${message ? `<p>${esc(message)}</p>` : ''}${input ? `<input type="text" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" maxlength="80">` : ''}<div class="dlg-btns">${cancel ? `<button data-k="c">${esc(cancel)}</button>` : ''}<button data-k="o" class="${danger ? 'danger' : 'pri'}">${esc(ok)}</button></div>`;
    back.append(d);
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add('open'));
    let done = false;
    const entry = pushOverlay(() => {
      back.classList.remove('open');
      setTimeout(() => back.remove(), 220);
      if (!done) { done = true; res(null); }
    });
    const inp = d.querySelector('input');
    const finish = async v => { if (done) return; done = true; await dismiss(entry); res(v); };
    const accept = () => finish(inp ? inp.value.trim() || null : true);
    d.addEventListener('click', e => { const k = e.target.dataset && e.target.dataset.k; if (k === 'o') accept(); else if (k === 'c') finish(null); });
    back.addEventListener('click', e => { if (e.target === back) finish(null); });
    if (inp) { inp.addEventListener('keydown', e => { if (e.key === 'Enter') accept(); }); setTimeout(() => { inp.focus(); inp.select(); }, 60); }
  });
}

// ---- Toast
let toastEl, toastT;
export function toast(msg, action) {
  if (!toastEl) { toastEl = el('div', 'toast'); document.body.append(toastEl); }
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  const b = toastEl.querySelector('button');
  if (b) b.onclick = () => { toastEl.classList.remove('show'); action.fn(); };
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), action ? 5000 : 2600);
}
