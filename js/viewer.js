import { icon } from './icons.js';
import { el, thumbURL, fmtDateTime, isVideo } from './util.js';
import { pushOverlay, dismiss, menuSheet } from './ui.js';

export function openViewer({ list, index, A }) {
  let items = list.slice(), idx = Math.max(0, Math.min(index, list.length - 1));
  const inTrash = A.inTrash;
  const root = el('div', 'viewer');
  root.innerHTML = `
    <div class="v-top"><button class="ib" data-a="back" aria-label="Cerrar">${icon('back')}</button><div class="v-title"></div><button class="ib" data-a="more" aria-label="Más opciones">${icon('more')}</button></div>
    <div class="v-stage"><div class="v-track"></div></div>
    <div class="v-bottom"><div class="v-strip"></div><div class="v-actions">${inTrash
      ? `<button data-a="restore">${icon('restore')}<span>Restaurar</span></button><button data-a="trash">${icon('trash')}<span>Eliminar</span></button>`
      : `<button data-a="fav">${icon('heart')}<span>Favorito</span></button><button data-a="edit">${icon('edit')}<span>Editar</span></button><button data-a="share">${icon('share')}<span>Compartir</span></button><button data-a="trash">${icon('trash')}<span>Eliminar</span></button>`}</div></div>`;
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('in'));
  const q = s => root.querySelector(s);
  const stage = q('.v-stage'), track = q('.v-track'), strip = q('.v-strip');
  const urls = new Map();
  const full = it => { let u = urls.get(it.id); if (!u) { u = URL.createObjectURL(it.blob); urls.set(it.id, u); } return u; };
  const panels = [0, 1, 2].map(k => { const p = el('div', 'v-panel'); p.style.left = k * 100 + '%'; track.append(p); return p; });
  let s = 1, tx = 0, ty = 0, dx = 0, animating = false, closed = false;
  const cur = () => items[idx];
  const media = () => panels[1].firstElementChild;

  function build() {
    panels.forEach((p, k) => {
      p.querySelectorAll('video').forEach(v => v.pause());
      p.innerHTML = ''; p.className = 'v-panel';
      const it = items[idx + k - 1];
      if (!it) return;
      if (isVideo(it) && k === 1) {
        p.classList.add('vid');
        p.innerHTML = `<video controls playsinline preload="metadata" src="${full(it)}" poster="${thumbURL(it)}"></video>`;
      } else {
        const i = new Image(); i.draggable = false; i.decoding = 'async';
        i.src = isVideo(it) ? thumbURL(it) : full(it);
        p.append(i);
      }
    });
    s = 1; tx = ty = 0; applyT(); applyTrack();
  }
  function applyT() { const m = media(); if (m && m.tagName === 'IMG') m.style.transform = `translate(${tx}px,${ty}px) scale(${s})`; }
  function applyTrack() { track.style.transform = `translate3d(calc(-100% + ${dx}px),0,0)`; }
  function bounds() {
    const W = stage.clientWidth, H = stage.clientHeight, m = media();
    let fw = W, fh = H;
    if (m && m.naturalWidth) { const r = Math.min(W / m.naturalWidth, H / m.naturalHeight); fw = m.naturalWidth * r; fh = m.naturalHeight * r; }
    return { x: Math.max(0, (fw * s - W) / 2), y: Math.max(0, (fh * s - H) / 2) };
  }
  function clampPan() { const b = bounds(); tx = Math.max(-b.x, Math.min(b.x, tx)); ty = Math.max(-b.y, Math.min(b.y, ty)); }
  function animT(fn) {
    const m = media(); if (!m) return;
    m.style.transition = 'transform .22s ease'; fn(); applyT();
    setTimeout(() => { m.style.transition = ''; }, 240);
  }
  function zoomAt(fx, fy, ns) {
    const qx = (fx - tx) / s, qy = (fy - ty) / s;
    s = ns; tx = fx - s * qx; ty = fy - s * qy; clampPan();
  }
  const center = (x, y) => { const r = stage.getBoundingClientRect(); return [x - r.left - r.width / 2, y - r.top - r.height / 2]; };

  function updateChrome() {
    const it = cur(); if (!it) return;
    q('.v-title').textContent = fmtDateTime(it.date);
    const f = q('[data-a=fav]');
    if (f) { f.innerHTML = icon(it.favorite ? 'heart-fill' : 'heart') + '<span>Favorito</span>'; f.classList.toggle('on', !!it.favorite); }
    const lo = Math.max(0, idx - 20), hi = Math.min(items.length, idx + 21);
    let h = '';
    for (let i = lo; i < hi; i++) h += `<button data-i="${i}" class="${i === idx ? 'cur' : ''}" aria-label="Elemento ${i + 1}"><img alt="" draggable="false" src="${thumbURL(items[i])}"></button>`;
    strip.innerHTML = h;
    const c = strip.querySelector('.cur');
    if (c) strip.scrollLeft = c.offsetLeft - strip.clientWidth / 2 + c.offsetWidth / 2;
  }
  function show() { build(); updateChrome(); }

  function go(dir) {
    if (animating) return;
    if (!items[idx + dir]) { track.style.transition = 'transform .2s'; dx = 0; applyTrack(); setTimeout(() => { track.style.transition = 'none'; }, 210); return; }
    animating = true;
    track.style.transition = 'transform .26s cubic-bezier(.2,.8,.2,1)';
    dx = -dir * stage.clientWidth; applyTrack();
    setTimeout(() => { idx += dir; dx = 0; track.style.transition = 'none'; animating = false; show(); }, 265);
  }
  function jump(i) { if (i === idx || animating) return; if (Math.abs(i - idx) === 1) return go(i - idx); idx = i; show(); }

  // ---- gestures
  const pts = new Map();
  let mode = null, start = null, pinch = null, lastTap = 0, tapT = 0;
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('video') || animating) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, t: performance.now(), tx, ty, moved: false }; mode = null; }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const [cx, cy] = center((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s, cx, cy, tx, ty };
      mode = 'pinch'; start.moved = true;
    }
  });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const [fx, fy] = center((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ns = Math.max(0.8, Math.min(6, pinch.s * d / pinch.d));
      const qx = (pinch.cx - pinch.tx) / pinch.s, qy = (pinch.cy - pinch.ty) / pinch.s;
      s = ns; tx = fx - s * qx; ty = fy - s * qy; applyT();
      return;
    }
    if (!start || pts.size !== 1) return;
    const ddx = e.clientX - start.x, ddy = e.clientY - start.y;
    if (!mode) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      start.moved = true;
      mode = s > 1.02 ? 'pan' : Math.abs(ddx) > Math.abs(ddy) ? 'swipe' : ddy > 0 ? 'close' : 'none';
      start.tx = tx; start.ty = ty; start.x = e.clientX - ddx; start.y = e.clientY - ddy;
    }
    if (mode === 'pan') {
      tx = start.tx + ddx; ty = start.ty + ddy;
      const b = bounds();
      // hand over to swipe when panned past the edge at horizontal bound
      tx = Math.max(-b.x, Math.min(b.x, tx)); ty = Math.max(-b.y, Math.min(b.y, ty)); applyT();
    } else if (mode === 'swipe') {
      let d = ddx; if ((d > 0 && !items[idx - 1]) || (d < 0 && !items[idx + 1])) d /= 3;
      dx = d; applyTrack();
    } else if (mode === 'close') {
      stage.style.transform = `translateY(${ddy}px) scale(${Math.max(0.6, 1 - ddy / 900)})`;
      root.style.setProperty('--vo', Math.max(0.2, 1 - ddy / 420));
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId); pts.delete(e.pointerId);
    if (mode === 'pinch') {
      if (pts.size < 2) {
        if (s < 1.05) animT(() => { s = 1; tx = ty = 0; }); else { clampPan(); applyT(); }
        mode = null; start = null;
        if (pts.size === 1) { const r = [...pts.values()][0]; start = { x: r.x, y: r.y, t: performance.now(), tx, ty, moved: true }; }
      }
      return;
    }
    if (pts.size) return;
    const dt = performance.now() - (start ? start.t : 0);
    if (mode === 'swipe') {
      const W = stage.clientWidth;
      if (e.type !== 'pointercancel' && (Math.abs(dx) > W * 0.22 || Math.abs(dx) / dt > 0.5) && Math.abs(dx) > 30) go(dx < 0 ? 1 : -1);
      else { track.style.transition = 'transform .2s'; dx = 0; applyTrack(); setTimeout(() => { track.style.transition = 'none'; }, 210); }
    } else if (mode === 'close') {
      const ddy = p.y - start.y;
      if (ddy > 110 && e.type !== 'pointercancel') { stage.style.transition = 'transform .2s'; stage.style.transform = 'translateY(40%) scale(.7)'; close(); }
      else { stage.style.transition = 'transform .2s'; stage.style.transform = ''; root.style.setProperty('--vo', 1); setTimeout(() => { stage.style.transition = ''; }, 210); }
    } else if (start && !start.moved && dt < 350 && e.type === 'pointerup') {
      const now = performance.now();
      if (now - lastTap < 300) {
        clearTimeout(tapT); lastTap = 0;
        const [fx, fy] = center(p.x, p.y);
        animT(() => { if (s > 1.05) { s = 1; tx = ty = 0; } else zoomAt(fx, fy, 2.6); });
      } else { lastTap = now; tapT = setTimeout(() => root.classList.toggle('hide'), 280); }
    }
    mode = null; start = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => {
    const [fx, fy] = center(e.clientX, e.clientY);
    zoomAt(fx, fy, Math.max(1, Math.min(6, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); applyT();
  }, { passive: true });
  const onKey = e => {
    if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  // ---- chrome actions
  strip.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) jump(+b.dataset.i); });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const it = cur(), a = b.dataset.a;
    if (a === 'back') close();
    else if (a === 'fav') { await A.fav(it); updateChrome(); }
    else if (a === 'share') A.share(it);
    else if (a === 'edit') A.edit(it, n => { if (closed) return; items.splice(idx + 1, 0, n); idx++; show(); });
    else if (a === 'restore') { await A.restore(it); removeCur(); }
    else if (a === 'trash') { if (await A.trash(it)) removeCur(); }
    else if (a === 'more') {
      menuSheet(inTrash ? [{ icon: 'info', label: 'Detalles', fn: () => A.details(it) }] : [
        { icon: 'info', label: 'Detalles', fn: () => A.details(it) },
        { icon: 'plus', label: 'Añadir a álbum', fn: () => A.album(it) },
        { icon: 'photo', label: 'Establecer como portada', fn: () => A.cover(it) },
        { icon: 'edit', label: 'Cambiar nombre', fn: async () => { await A.rename(it); updateChrome(); } },
      ]);
    }
  });
  function removeCur() {
    items.splice(idx, 1);
    if (!items.length) return close();
    idx = Math.min(idx, items.length - 1); show();
  }

  const entry = pushOverlay(() => {
    closed = true;
    document.removeEventListener('keydown', onKey);
    root.querySelectorAll('video').forEach(v => v.pause());
    root.classList.remove('in'); root.classList.add('out');
    setTimeout(() => { root.remove(); urls.forEach(u => URL.revokeObjectURL(u)); }, 260);
  });
  function close() { return dismiss(entry); }
  show();
}
