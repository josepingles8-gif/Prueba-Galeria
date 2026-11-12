// Editor de fotos a pantalla completa (módulo ES sin dependencias).
//
//   import { openEditor } from './editor.js';
//   openEditor(blob, { onSave(newBlob) {}, onCancel() {} });
//
// Canal no destructivo: el estado (geometría + filtro + ajustes) se aplica
// siempre sobre la imagen original. La vista previa se dibuja sobre una copia
// reducida; al guardar se procesa la imagen a resolución completa y se
// devuelve un JPEG (calidad 0.92).

import { icon } from './icons.js';

/* ───────────────────────── Utilidades ───────────────────────── */

const CSS_ID = 'pe-editor-css';
const PREVIEW_MAX = 1600;          // lado mayor de la copia de trabajo
const SAVE_MAX_AREA = 16_000_000;  // límite de píxeles (canvas de iOS)
const THUMB = 112;                 // miniaturas de filtros (px reales)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const raf = window.requestAnimationFrame.bind(window);
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = new URL('../css/editor.css', import.meta.url).href;
  document.head.appendChild(link);
}

async function decode(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) { /* sigue */ }
    try { return await createImageBitmap(blob); } catch (_) { /* sigue */ }
  }
  // Último recurso: <img> (los navegadores modernos ya respetan EXIF).
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const dimsOf = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const ctx2d = (c, opts) => c.getContext('2d', opts);

/* ───────────────────── Matrices de color 3×4 ───────────────────── */
// [r' g' b'] = M · [r g b 1], valores en 0..1. Formato plano de 12 números.

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Composición: primero B, después A. */
function mul(A, B) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i * 4 + k] * B[k * 4 + j];
      o[i * 4 + j] = s + (j === 3 ? A[i * 4 + 3] : 0);
    }
  }
  return o;
}
const lerpM = (A, B, t) => A.map((a, i) => a + (B[i] - a) * t);
const diag = (r, g, b) => [r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0];
function satM(s) {
  const lr = 0.2126, lg = 0.7152, lb = 0.0722, i = 1 - s;
  return [
    lr * i + s, lg * i, lb * i, 0,
    lr * i, lg * i + s, lb * i, 0,
    lr * i, lg * i, lb * i + s, 0,
  ];
}
const SEPIA = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];

/* ───────────────────────── Filtros ───────────────────────── */

const FILTERS = [
  { id: 'original', name: 'Original', m: ID },
  { id: 'calido', name: 'Cálido', m: mul(diag(1.1, 1.02, 0.86), satM(1.1)), bright: 0.02 },
  { id: 'frio', name: 'Frío', m: mul(diag(0.9, 1.0, 1.12), satM(0.95)), contrast: 0.05 },
  { id: 'bn', name: 'B/N', m: satM(0), contrast: 0.1 },
  { id: 'sepia', name: 'Sepia', m: SEPIA, contrast: -0.03 },
  { id: 'vivido', name: 'Vívido', m: satM(1.5), contrast: 0.15 },
  { id: 'desvanecido', name: 'Desvanecido', m: satM(0.7), contrast: -0.15, fade: 0.12, bright: 0.03 },
  { id: 'noir', name: 'Noir', m: satM(0), contrast: 0.45, bright: -0.05, vignette: 0.35 },
  { id: 'retro', name: 'Retro', m: mul(diag(1.08, 1.0, 0.82), lerpM(ID, SEPIA, 0.35)), contrast: -0.05, fade: 0.08, vignette: 0.25 },
  { id: 'suave', name: 'Suave', m: satM(0.88), contrast: -0.12, bright: 0.04, fade: 0.04 },
];
const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

/* ───────────────────────── Ajustes ───────────────────────── */

const ADJUSTMENTS = [
  { id: 'brightness', label: 'Brillo', min: -100, max: 100 },
  { id: 'exposure', label: 'Exposición', min: -100, max: 100 },
  { id: 'contrast', label: 'Contraste', min: -100, max: 100 },
  { id: 'saturation', label: 'Saturación', min: -100, max: 100 },
  { id: 'temperature', label: 'Temperatura', min: -100, max: 100 },
  { id: 'sharpness', label: 'Nitidez', min: 0, max: 100 },
  { id: 'vignette', label: 'Viñeta', min: -100, max: 100 },
];
const ZERO_ADJ = Object.fromEntries(ADJUSTMENTS.map((a) => [a.id, 0]));

const ASPECTS = [
  { id: 'free', label: 'Libre', r: null },
  { id: 'orig', label: 'Original', r: 'orig' },
  { id: '1:1', label: '1:1', r: 1 },
  { id: '4:3', label: '4:3', r: 4 / 3 },
  { id: '3:4', label: '3:4', r: 3 / 4 },
  { id: '16:9', label: '16:9', r: 16 / 9 },
  { id: '9:16', label: '9:16', r: 9 / 16 },
];

const defaultState = () => ({
  rot: 0, flipH: false, flipV: false, straighten: 0,
  crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free',
  filter: 'original', intensity: 100,
  adj: { ...ZERO_ADJ },
});

/* ───────────────────── Procesado de color ───────────────────── */

/** Calcula LUT tonal + matriz + viñeta + nitidez para un estado. */
function colorParams(st, filterId = st.filter, intensity = st.intensity, withAdj = true) {
  const f = FILTER_MAP[filterId] || FILTERS[0];
  const t = intensity / 100;
  const a = withAdj ? st.adj : ZERO_ADJ;

  const ev = Math.pow(2, (a.exposure / 100) * 1.5);
  const gamma = Math.pow(2, (-a.brightness / 100) * 0.9);
  const c = a.contrast / 100;
  const cf = c >= 0 ? 1 + c * 0.9 : 1 + c * 0.7;
  const pc = 1 + (f.contrast || 0) * t;
  const pb = (f.bright || 0) * t;
  const fade = (f.fade || 0) * t;

  const lut = new Float32Array(256);
  let lutId = true;
  for (let v = 0; v < 256; v++) {
    let x = Math.min(1, (v / 255) * ev);
    if (gamma !== 1) x = Math.pow(x, gamma);
    x = (x - 0.5) * cf + 0.5;
    x = (x - 0.5) * pc + 0.5 + pb;
    x = clamp(x, 0, 1);
    x = fade + x * (1 - fade);
    lut[v] = x;
    if (Math.abs(x * 255 - v) > 0.01) lutId = false;
  }

  const tt = a.temperature / 100;
  const temp = diag(1 + 0.18 * tt, 1 + 0.03 * tt, 1 - 0.18 * tt);
  const m = mul(lerpM(ID, f.m, t), mul(temp, satM(1 + a.saturation / 100)));
  const mId = m.every((v, i) => Math.abs(v - ID[i]) < 1e-6);

  return {
    lut, m,
    identity: lutId && mId,
    vig: a.vignette / 100 + (f.vignette || 0) * t, // >0 oscurece bordes, <0 aclara
    sharp: (a.sharpness / 100) * 1.2,
  };
}

/**
 * Aplica LUT + matriz + viñeta sobre un bloque de filas RGBA.
 * yOff/totalH sitúan el bloque en la imagen completa (para la viñeta).
 * Las primeras `skip` filas se dejan intactas (ya procesadas).
 */
function applyColor(d, w, rows, cp, yOff = 0, totalH = rows, skip = 0) {
  const vig = cp.vig;
  if (cp.identity && !vig) return;
  const L = cp.lut, M = cp.m;
  const m0 = M[0] * 255, m1 = M[1] * 255, m2 = M[2] * 255, m3 = M[3] * 255;
  const m4 = M[4] * 255, m5 = M[5] * 255, m6 = M[6] * 255, m7 = M[7] * 255;
  const m8 = M[8] * 255, m9 = M[9] * 255, m10 = M[10] * 255, m11 = M[11] * 255;

  let nx2 = null;
  if (vig) {
    nx2 = new Float32Array(w);
    const hw = w / 2;
    for (let x = 0; x < w; x++) { const n = (x + 0.5 - hw) / hw; nx2[x] = (n * n) / 2; }
  }
  const hh = totalH / 2;
  const dark = vig > 0 ? vig * 0.85 : 0;
  const light = vig < 0 ? -vig * 0.6 : 0;

  for (let y = skip; y < rows; y++) {
    let ny2 = 0;
    if (vig) { const n = (yOff + y + 0.5 - hh) / hh; ny2 = (n * n) / 2; }
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const r = L[d[i]], g = L[d[i + 1]], b = L[d[i + 2]];
      let nr = m0 * r + m1 * g + m2 * b + m3;
      let ng = m4 * r + m5 * g + m6 * b + m7;
      let nb = m8 * r + m9 * g + m10 * b + m11;
      if (vig) {
        let q = (nx2[x] + ny2 - 0.12) / 0.88;
        if (q > 0) {
          if (q > 1) q = 1;
          const f = q * q * (3 - 2 * q);
          if (dark) { const k = 1 - dark * f; nr *= k; ng *= k; nb *= k; } else {
            const k = light * f;
            nr += (255 - nr) * k; ng += (255 - ng) * k; nb += (255 - nb) * k;
          }
        }
      }
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; // Uint8ClampedArray recorta y redondea
    }
  }
}

/** Máscara de enfoque 3×3; las filas primera y última sólo se usan como vecinas. */
function sharpen(d, w, rows, amt) {
  if (amt <= 0 || w < 3 || rows < 3) return;
  const s = d.slice();
  const stride = w * 4, k = 1 + 4 * amt;
  for (let y = 1; y < rows - 1; y++) {
    let i = y * stride + 4;
    for (let x = 1; x < w - 1; x++, i += 4) {
      d[i] = s[i] * k - amt * (s[i - 4] + s[i + 4] + s[i - stride] + s[i + stride]);
      d[i + 1] = s[i + 1] * k - amt * (s[i - 3] + s[i + 5] + s[i + 1 - stride] + s[i + 1 + stride]);
      d[i + 2] = s[i + 2] * k - amt * (s[i - 2] + s[i + 6] + s[i + 2 - stride] + s[i + 2 + stride]);
    }
  }
}

/* ───────────────────────── Geometría ───────────────────────── */

/** Zoom necesario para que la imagen enderezada cubra el marco sin esquinas vacías. */
function straightenZoom(deg, FW, FH) {
  const a = Math.abs(deg) * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return Math.max((FW * c + FH * s) / FW, (FW * s + FH * c) / FH);
}

/**
 * Dibuja la imagen transformada. Coordenadas del "marco" en píxeles originales;
 * k = píxeles de salida por píxel original; tx/ty = desplazamiento de salida.
 */
function drawGeometry(ctx, src, st, W0, H0, k, tx, ty) {
  const FW = st.rot % 180 ? H0 : W0, FH = st.rot % 180 ? W0 : H0;
  const z = straightenZoom(st.straighten, FW, FH);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(k, 0, 0, k, tx, ty);
  ctx.translate(FW / 2, FH / 2);
  ctx.rotate(st.straighten * Math.PI / 180);
  ctx.scale(z * (st.flipH ? -1 : 1), z * (st.flipV ? -1 : 1));
  ctx.rotate(st.rot * Math.PI / 180);
  ctx.drawImage(src, -W0 / 2, -H0 / 2, W0, H0);
  ctx.restore();
}

/** Redimensiona un rectángulo de recorte (coordenadas normalizadas 0..1). */
function resizeRect(hd, s, dx, dy, A) {
  const MIN = 0.06;
  let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
  const W = hd.includes('w'), E = hd.includes('e'), N = hd.includes('n'), S = hd.includes('s');
  if (W) l = clamp(l + dx, 0, r - MIN);
  if (E) r = clamp(r + dx, l + MIN, 1);
  if (N) t = clamp(t + dy, 0, b - MIN);
  if (S) b = clamp(b + dy, t + MIN, 1);
  if (!A) return { x: l, y: t, w: r - l, h: b - t };

  let w = r - l, h = b - t;
  const horiz = W || E, vert = N || S;
  if (horiz && !vert) h = w / A;
  else if (vert && !horiz) w = h * A;
  else if (w / A > h) h = w / A;
  else w = h * A;
  if (w < MIN) { w = MIN; h = w / A; }
  if (h < MIN) { h = MIN; w = h * A; }

  let ax, ay, maxW, maxH;
  if (W) { ax = s.x + s.w; maxW = ax; } else if (E) { ax = s.x; maxW = 1 - ax; } else { ax = s.x + s.w / 2; maxW = 2 * Math.min(ax, 1 - ax); }
  if (N) { ay = s.y + s.h; maxH = ay; } else if (S) { ay = s.y; maxH = 1 - ay; } else { ay = s.y + s.h / 2; maxH = 2 * Math.min(ay, 1 - ay); }
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k; h *= k;
  const x = W ? ax - w : E ? ax : ax - w / 2;
  const y = N ? ay - h : S ? ay : ay - h / 2;
  return { x, y, w, h };
}

/** Rectángulo máximo centrado con proporción A (normalizada). */
function aspectRect(A) {
  let w = 1, h = 1 / A;
  if (h > 1) { h = 1; w = A; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/* ───────────────────────── Editor ───────────────────────── */

export function openEditor(blob, { onSave, onCancel } = {}) {
  ensureCss();

  let st = defaultState();
  let history = [JSON.stringify(st)];
  let hIdx = 0;
  let tab = 'transform';
  let curAdj = 'brightness';
  let bitmap = null, W0 = 0, H0 = 0;
  let preview = null; // copia reducida
  let comparing = false;
  let finished = false;
  let renderQueued = false;
  let thumbsKey = '';
  let drag = null;
  let holdTimer = 0;
  let lastTap = { id: '', t: 0 };
  let disp = { left: 0, top: 0, w: 0, h: 0 };

  /* ── DOM ── */
  const root = document.createElement('div');
  root.className = 'pe-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Editor de fotos');
  root.innerHTML = `
    <header class="pe-top">
      <button type="button" class="pe-txtbtn" data-act="cancel">Cancelar</button>
      <div class="pe-top-mid">
        <button type="button" class="pe-iconbtn" data-act="undo" aria-label="Deshacer" title="Deshacer">${icon('undo', 22)}</button>
        <button type="button" class="pe-iconbtn pe-mirror" data-act="redo" aria-label="Rehacer" title="Rehacer">${icon('undo', 22)}</button>
        <button type="button" class="pe-iconbtn" data-act="reset" aria-label="Restablecer" title="Restablecer">${icon('restore', 22)}</button>
      </div>
      <button type="button" class="pe-save" data-act="save">${icon('check', 18)}<span>Guardar</span></button>
    </header>
    <div class="pe-stage">
      <canvas class="pe-canvas"></canvas>
      <div class="pe-crop" hidden>
        <div class="pe-shade"><div class="pe-hole"></div></div>
        <div class="pe-box" data-h="move">
          <i class="pe-gl pe-v1"></i><i class="pe-gl pe-v2"></i><i class="pe-gl pe-h1"></i><i class="pe-gl pe-h2"></i>
          ${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="pe-hd pe-hd-${h}" data-h="${h}"></span>`).join('')}
        </div>
      </div>
      <div class="pe-badge" hidden>Original</div>
      <div class="pe-loading"><div class="pe-spinner"></div></div>
    </div>
    <div class="pe-panel">
      <section class="pe-sec" data-panel="transform">
        <div class="pe-sliderrow">
          <button type="button" class="pe-sliderlabel" data-reset="straighten" title="Doble toque para restablecer">Enderezar <b class="pe-val" data-val="straighten">0°</b></button>
          <input type="range" class="pe-range" data-range="straighten" min="-45" max="45" step="0.5" value="0" aria-label="Enderezar">
        </div>
        <div class="pe-actions">
          <button type="button" class="pe-tool" data-act="rotate">${icon('rotate', 22)}<span>Girar</span></button>
          <button type="button" class="pe-tool" data-act="flipH">${icon('flip', 22)}<span>Voltear H</span></button>
          <button type="button" class="pe-tool pe-rot90" data-act="flipV">${icon('flip', 22)}<span>Voltear V</span></button>
        </div>
        <div class="pe-chips" role="radiogroup" aria-label="Proporción">
          ${ASPECTS.map((a) => `<button type="button" class="pe-chip" role="radio" data-aspect="${a.id}">${a.label}</button>`).join('')}
        </div>
      </section>
      <section class="pe-sec" data-panel="filters" hidden>
        <div class="pe-sliderrow pe-intensity">
          <span class="pe-sliderlabel">Intensidad <b class="pe-val" data-val="intensity">100</b></span>
          <input type="range" class="pe-range" data-range="intensity" min="0" max="100" step="1" value="100" aria-label="Intensidad del filtro">
        </div>
        <div class="pe-filters" role="radiogroup" aria-label="Filtros">
          ${FILTERS.map((f) => `<button type="button" class="pe-filter" role="radio" data-filter="${f.id}"><canvas width="${THUMB}" height="${THUMB}"></canvas><span>${f.name}</span></button>`).join('')}
        </div>
      </section>
      <section class="pe-sec" data-panel="adjust" hidden>
        <div class="pe-sliderrow">
          <span class="pe-sliderlabel"><span data-adjname>Brillo</span> <b class="pe-val" data-val="adj">0</b></span>
          <input type="range" class="pe-range" data-range="adj" min="-100" max="100" step="1" value="0" aria-label="Valor del ajuste">
        </div>
        <div class="pe-chips" role="radiogroup" aria-label="Ajustes">
          ${ADJUSTMENTS.map((a) => `<button type="button" class="pe-chip" role="radio" data-adj="${a.id}" title="Doble toque para restablecer">${a.label}<i class="pe-dot"></i></button>`).join('')}
        </div>
      </section>
    </div>
    <nav class="pe-tabs" role="tablist">
      <button type="button" class="pe-tab" role="tab" data-tab="transform">${icon('crop', 22)}<span>Transformar</span></button>
      <button type="button" class="pe-tab" role="tab" data-tab="filters">${icon('filter', 22)}<span>Filtros</span></button>
      <button type="button" class="pe-tab" role="tab" data-tab="adjust">${icon('tune', 22)}<span>Ajustes</span></button>
    </nav>
    <div class="pe-dialog" hidden>
      <div class="pe-dialog-card" role="alertdialog" aria-label="Descartar cambios">
        <p>¿Descartar los cambios?</p>
        <div class="pe-dialog-btns">
          <button type="button" class="pe-txtbtn" data-act="keep">Seguir editando</button>
          <button type="button" class="pe-txtbtn pe-danger" data-act="discard">Descartar</button>
        </div>
      </div>
    </div>
    <div class="pe-busy" hidden><div class="pe-spinner"></div><span>Guardando…</span></div>
    <div class="pe-toast" hidden></div>
  `;

  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const stage = $('.pe-stage');
  const canvas = $('.pe-canvas');
  const ctx = ctx2d(canvas, { willReadFrequently: true });
  const cropEl = $('.pe-crop');
  const boxEl = $('.pe-box');
  const holeEl = $('.pe-hole');
  const badge = $('.pe-badge');
  const ranges = {
    straighten: $('[data-range="straighten"]'),
    intensity: $('[data-range="intensity"]'),
    adj: $('[data-range="adj"]'),
  };

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.body.appendChild(root);

  /* ── Geometría derivada ── */
  const frame = () => (st.rot % 180 ? { FW: H0, FH: W0 } : { FW: W0, FH: H0 });
  function aspectNorm(id = st.aspect) {
    const a = ASPECTS.find((x) => x.id === id);
    if (!a || !a.r) return null;
    if (a.r === 'orig') return 1;
    const { FW, FH } = frame();
    return (a.r * FH) / FW;
  }
  function applyAspect() {
    const A = aspectNorm();
    if (A) st.crop = aspectRect(A);
  }

  /* ── Historial ── */
  const snapshot = () => JSON.stringify(st);
  function commit() {
    const s = snapshot();
    if (s === history[hIdx]) return;
    history = history.slice(0, hIdx + 1);
    history.push(s);
    if (history.length > 80) history.shift();
    hIdx = history.length - 1;
    syncUI();
  }
  function goto(i) {
    if (i < 0 || i >= history.length) return;
    hIdx = i;
    st = JSON.parse(history[i]);
    syncUI();
    requestRender();
  }
  const isDirty = () => snapshot() !== JSON.stringify(defaultState());

  /* ── Render ── */
  function requestRender() {
    if (renderQueued || finished) return;
    renderQueued = true;
    raf(() => { renderQueued = false; if (!finished) render(); });
  }

  function render() {
    if (!preview) return;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const full = tab === 'transform';
    let rw, rh, cr = null;
    if (comparing) { rw = W0; rh = H0; } else {
      const { FW, FH } = frame();
      cr = full ? { x: 0, y: 0, w: 1, h: 1 } : st.crop;
      rw = cr.w * FW; rh = cr.h * FH;
    }
    const pad = full ? 28 : 12;
    const scale = Math.max(0.01, Math.min((sw - 2 * pad) / rw, (sh - 2 * pad) / rh));
    const dw = rw * scale, dh = rh * scale;
    const cw = Math.max(1, Math.round(dw * dpr)), ch = Math.max(1, Math.round(dh * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    disp = { left: (sw - dw) / 2, top: (sh - dh) / 2, w: dw, h: dh };
    Object.assign(canvas.style, { width: dw + 'px', height: dh + 'px', left: disp.left + 'px', top: disp.top + 'px' });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (comparing) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(preview, 0, 0, cw, ch);
    } else {
      const { FW, FH } = frame();
      const k = cw / rw;
      drawGeometry(ctx, preview, st, W0, H0, k, -cr.x * FW * k, -cr.y * FH * k);
      const cp = colorParams(st);
      if (!cp.identity || cp.vig || cp.sharp > 0) {
        const img = ctx.getImageData(0, 0, cw, ch);
        applyColor(img.data, cw, ch, cp);
        sharpen(img.data, cw, ch, cp.sharp);
        ctx.putImageData(img, 0, 0);
      }
    }
    cropEl.hidden = !full || comparing;
    badge.hidden = !comparing;
    if (full) updateOverlay();
    if (tab === 'filters') updateThumbs();
  }

  function updateOverlay() {
    Object.assign(cropEl.style, { left: disp.left + 'px', top: disp.top + 'px', width: disp.w + 'px', height: disp.h + 'px' });
    const c = st.crop;
    Object.assign(holeEl.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' });
    Object.assign(boxEl.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' });
  }

  function updateThumbs() {
    const key = JSON.stringify([st.rot, st.flipH, st.flipV, st.straighten, st.crop]);
    if (key === thumbsKey || !preview) return;
    thumbsKey = key;
    const { FW, FH } = frame();
    const cr = st.crop;
    const rw = cr.w * FW, rh = cr.h * FH;
    const k = THUMB / Math.min(rw, rh);
    const base = makeCanvas(THUMB, THUMB);
    const bctx = ctx2d(base, { willReadFrequently: true });
    bctx.fillStyle = '#000';
    bctx.fillRect(0, 0, THUMB, THUMB);
    drawGeometry(bctx, preview, st, W0, H0, k, -cr.x * FW * k - (rw * k - THUMB) / 2, -cr.y * FH * k - (rh * k - THUMB) / 2);
    const data = bctx.getImageData(0, 0, THUMB, THUMB).data;
    for (const btn of $$('.pe-filter')) {
      const img = new ImageData(new Uint8ClampedArray(data), THUMB, THUMB);
      applyColor(img.data, THUMB, THUMB, colorParams(st, btn.dataset.filter, 100, false));
      ctx2d(btn.querySelector('canvas')).putImageData(img, 0, 0);
    }
  }

  /* ── Sincronizar controles ── */
  function paintRange(inp) {
    const min = +inp.min, max = +inp.max, v = +inp.value;
    const p = ((v - min) / (max - min)) * 100;
    const z = min < 0 ? ((0 - min) / (max - min)) * 100 : 0;
    inp.style.setProperty('--a', Math.min(p, z) + '%');
    inp.style.setProperty('--b', Math.max(p, z) + '%');
  }
  const fmt = (v) => (v > 0 ? '+' : '') + Math.round(v);

  function syncUI() {
    $('[data-act="undo"]').disabled = hIdx <= 0;
    $('[data-act="redo"]').disabled = hIdx >= history.length - 1;
    $('[data-act="reset"]').disabled = !isDirty();

    for (const t of $$('.pe-tab')) { const on = t.dataset.tab === tab; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', on); }
    for (const s of $$('.pe-sec')) s.hidden = s.dataset.panel !== tab;

    ranges.straighten.value = st.straighten;
    $('[data-val="straighten"]').textContent = (st.straighten > 0 ? '+' : '') + st.straighten.toFixed(1).replace('.0', '') + '°';
    for (const c of $$('[data-aspect]')) { const on = c.dataset.aspect === st.aspect; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', on); }

    for (const f of $$('.pe-filter')) { const on = f.dataset.filter === st.filter; f.classList.toggle('is-on', on); f.setAttribute('aria-checked', on); }
    ranges.intensity.value = st.intensity;
    $('[data-val="intensity"]').textContent = st.intensity;
    $('.pe-intensity').classList.toggle('is-off', st.filter === 'original');
    ranges.intensity.disabled = st.filter === 'original';

    const def = ADJUSTMENTS.find((a) => a.id === curAdj);
    ranges.adj.min = def.min; ranges.adj.max = def.max;
    ranges.adj.value = st.adj[curAdj];
    $('[data-adjname]').textContent = def.label;
    $('[data-val="adj"]').textContent = fmt(st.adj[curAdj]);
    for (const c of $$('[data-adj]')) {
      const on = c.dataset.adj === curAdj;
      c.classList.toggle('is-on', on);
      c.classList.toggle('is-set', st.adj[c.dataset.adj] !== 0);
      c.setAttribute('aria-checked', on);
    }
    Object.values(ranges).forEach(paintRange);
  }

  /* ── Acciones ── */
  function rotate() {
    const oneFlip = st.flipH !== st.flipV;
    st.rot = (st.rot + (oneFlip ? 270 : 90)) % 360; // giro visual de 90° en sentido horario
    const c = st.crop;
    st.crop = { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w };
    if (st.aspect !== 'free') applyAspect();
  }
  function flip(axis) {
    const c = st.crop;
    if (axis === 'h') { st.flipH = !st.flipH; st.crop = { ...c, x: 1 - c.x - c.w }; } else { st.flipV = !st.flipV; st.crop = { ...c, y: 1 - c.y - c.h }; }
    st.straighten = -st.straighten;
  }

  function toast(msg) {
    const t = $('.pe-toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function finish(cb, arg) {
    if (finished) return;
    finished = true;
    clearTimeout(holdTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    document.body.style.overflow = prevOverflow;
    if (bitmap && bitmap.close) try { bitmap.close(); } catch (_) { /* nada */ }
    bitmap = preview = null;
    if (typeof cb === 'function') cb(arg);
  }

  function requestCancel() {
    if (finished) return;
    if (!$('.pe-dialog').hidden) return;
    if (isDirty() && bitmap) $('.pe-dialog').hidden = false;
    else finish(onCancel);
  }

  async function save() {
    if (!bitmap || finished) return;
    const busy = $('.pe-busy');
    busy.hidden = false;
    await nextFrame();
    try {
      const { FW, FH } = frame();
      const cr = st.crop;
      const ow = cr.w * FW, oh = cr.h * FH;
      const lim = ow * oh > SAVE_MAX_AREA ? Math.sqrt(SAVE_MAX_AREA / (ow * oh)) : 1;
      const W = Math.max(1, Math.round(ow * lim)), H = Math.max(1, Math.round(oh * lim));
      const out = makeCanvas(W, H);
      const octx = ctx2d(out, { willReadFrequently: true });
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, W, H);
      const k = W / ow;
      drawGeometry(octx, bitmap, st, W0, H0, k, -cr.x * FW * k, -cr.y * FH * k);

      const cp = colorParams(st);
      if (!cp.identity || cp.vig || cp.sharp > 0) {
        const STRIP = 256;
        for (let y = 0; y < H; y += STRIP) {
          const y0 = Math.max(0, y - 1);
          const y1 = Math.min(H, y + STRIP + 1);
          const img = octx.getImageData(0, y0, W, y1 - y0);
          // La fila superior solapada ya se procesó en la franja anterior.
          applyColor(img.data, W, y1 - y0, cp, y0, H, y - y0);
          sharpen(img.data, W, y1 - y0, cp.sharp);
          octx.putImageData(img, 0, y0, 0, y - y0, W, Math.min(STRIP, H - y));
          if ((y / STRIP) % 8 === 7) await nextFrame();
        }
      }
      const out_blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.92));
      out.width = out.height = 0;
      finish(onSave, out_blob);
    } catch (err) {
      console.warn('[editor] error al guardar', err);
      busy.hidden = true;
      toast('No se pudo guardar la imagen');
    }
  }

  /* ── Eventos ── */
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || finished) return;

    const act = b.dataset.act;
    if (act) {
      switch (act) {
        case 'cancel': requestCancel(); return;
        case 'keep': $('.pe-dialog').hidden = true; return;
        case 'discard': finish(onCancel); return;
        case 'save': save(); return;
        case 'undo': goto(hIdx - 1); return;
        case 'redo': goto(hIdx + 1); return;
        case 'reset': st = defaultState(); break;
        case 'rotate': rotate(); break;
        case 'flipH': flip('h'); break;
        case 'flipV': flip('v'); break;
      }
      commit(); requestRender(); return;
    }
    if (b.dataset.tab) { tab = b.dataset.tab; syncUI(); requestRender(); return; }
    if (b.dataset.aspect) { st.aspect = b.dataset.aspect; if (st.aspect === 'free') st.crop = { x: 0, y: 0, w: 1, h: 1 }; else applyAspect(); commit(); requestRender(); return; }
    if (b.dataset.filter) {
      if (st.filter !== b.dataset.filter) { st.filter = b.dataset.filter; st.intensity = 100; commit(); requestRender(); }
      b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      return;
    }

    // Doble toque: restablecer el valor.
    const tapId = b.dataset.adj || b.dataset.reset;
    if (tapId) {
      const now = performance.now();
      const dbl = lastTap.id === tapId && now - lastTap.t < 350;
      lastTap = dbl ? { id: '', t: 0 } : { id: tapId, t: now };
      if (b.dataset.adj) {
        curAdj = b.dataset.adj;
        if (dbl) { st.adj[curAdj] = 0; commit(); requestRender(); }
        syncUI();
      } else if (dbl && b.dataset.reset === 'straighten') {
        st.straighten = 0; commit(); syncUI(); requestRender();
      }
    }
  });

  // Doble clic de ratón sobre etiquetas o barras: también restablece.
  ranges.adj.addEventListener('dblclick', () => { st.adj[curAdj] = 0; commit(); syncUI(); requestRender(); });
  ranges.straighten.addEventListener('dblclick', () => { st.straighten = 0; commit(); syncUI(); requestRender(); });

  for (const [name, inp] of Object.entries(ranges)) {
    inp.addEventListener('input', () => {
      const v = +inp.value;
      if (name === 'straighten') st.straighten = v;
      else if (name === 'intensity') st.intensity = v;
      else st.adj[curAdj] = v;
      // Actualización ligera de etiquetas; el lienzo va por rAF.
      paintRange(inp);
      const lbl = $(`[data-val="${name}"]`);
      lbl.textContent = name === 'straighten' ? (v > 0 ? '+' : '') + v + '°' : name === 'adj' ? fmt(v) : v;
      if (name === 'adj') $(`[data-adj="${curAdj}"]`).classList.toggle('is-set', v !== 0);
      requestRender();
    });
    inp.addEventListener('change', () => commit());
  }

  // Recorte: arrastrar el cuadro o sus asas.
  cropEl.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-h]');
    if (!h || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { h: h.dataset.h, sx: e.clientX, sy: e.clientY, start: { ...st.crop }, id: e.pointerId };
    cropEl.setPointerCapture(e.pointerId);
    cropEl.classList.add('is-drag');
  });
  cropEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.sx) / disp.w, dy = (e.clientY - drag.sy) / disp.h;
    const s = drag.start;
    if (drag.h === 'move') st.crop = { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
    else st.crop = resizeRect(drag.h, s, dx, dy, aspectNorm());
    updateOverlay();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    cropEl.classList.remove('is-drag');
    commit();
  };
  cropEl.addEventListener('pointerup', endDrag);
  cropEl.addEventListener('pointercancel', endDrag);

  // Mantener pulsado sobre la imagen: ver el original.
  const stopCompare = () => {
    clearTimeout(holdTimer);
    if (comparing) { comparing = false; requestRender(); }
  };
  stage.addEventListener('pointerdown', (e) => {
    if (drag || e.button > 0 || !preview) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { comparing = true; requestRender(); }, 180);
  });
  stage.addEventListener('pointerup', stopCompare);
  stage.addEventListener('pointercancel', stopCompare);
  stage.addEventListener('pointerleave', stopCompare);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  function onResize() { requestRender(); }
  function onKey(e) {
    if (finished) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!$('.pe-dialog').hidden) $('.pe-dialog').hidden = true; else requestCancel(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); goto(e.shiftKey ? hIdx + 1 : hIdx - 1); } else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); goto(hIdx + 1); }
  }
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey, true);

  syncUI();
  $('.pe-save').disabled = true;

  /* ── Carga ── */
  (async () => {
    try {
      bitmap = await decode(blob);
      if (finished) { if (bitmap.close) bitmap.close(); return; }
      ({ w: W0, h: H0 } = dimsOf(bitmap));
      if (!W0 || !H0) throw new Error('Imagen vacía');
      const s = Math.min(1, PREVIEW_MAX / Math.max(W0, H0));
      preview = makeCanvas(W0 * s, H0 * s);
      const pctx = ctx2d(preview);
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
      $('.pe-loading').hidden = true;
      $('.pe-save').disabled = false;
      render();
    } catch (err) {
      console.warn('[editor] no se pudo abrir la imagen', err);
      $('.pe-loading').hidden = true;
      toast('No se pudo abrir la imagen');
    }
  })();

  return { close: () => finish(onCancel) };
}
