export const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
export const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
export const monthKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
export function dayLabel(ts) {
  const d = new Date(ts), n = new Date();
  if (dayKey(d) === dayKey(n)) return 'Hoy';
  if (dayKey(d) === dayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return 'Ayer';
  const o = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== n.getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('es-ES', o);
}
export const monthLabel = ts => cap(new Date(ts).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
export const fmtDateTime = ts => new Date(ts).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });
export const fmtTime = ts => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
export const isVideo = it => (it.blob && it.blob.type || '').startsWith('video/');
export const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);

const urls = new Map();
export function thumbURL(it) {
  let u = urls.get(it.id);
  if (!u) { u = URL.createObjectURL(it.thumb || it.blob); urls.set(it.id, u); }
  return u;
}
export function dropThumbURL(id) { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } }

function loadImg(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob), i = new Image();
    i.onload = () => res({ src: i, w: i.naturalWidth, h: i.naturalHeight, close: () => URL.revokeObjectURL(u) });
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('img')); };
    i.src = u;
  });
}
function videoFrame(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob), v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    let done = false;
    const fail = e => { if (done) return; done = true; clearTimeout(t); URL.revokeObjectURL(u); rej(e); };
    const ok = () => { if (done) return; done = true; clearTimeout(t); res({ src: v, w: v.videoWidth, h: v.videoHeight, duration: v.duration, close: () => { URL.revokeObjectURL(u); v.removeAttribute('src'); v.load(); } }); };
    const t = setTimeout(() => fail(new Error('timeout')), 6000);
    v.onloadeddata = () => {
      if (!v.videoWidth) return fail(new Error('sin imagen'));
      const d = isFinite(v.duration) ? v.duration : 0;
      try { v.currentTime = Math.min(0.1, d / 2 || 0.1); } catch { ok(); }
    };
    v.onseeked = ok;
    v.onerror = () => fail(new Error('video'));
    v.src = u;
  });
}
export const fmtDur = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
export function probeDuration(blob) {
  return new Promise(res => {
    const u = URL.createObjectURL(blob), v = document.createElement('video');
    const end = d => { clearTimeout(t); URL.revokeObjectURL(u); res(isFinite(d) ? d : 0); };
    const t = setTimeout(() => end(0), 4000);
    v.preload = 'metadata'; v.onloadedmetadata = () => end(v.duration); v.onerror = () => end(0); v.src = u;
  });
}
// Base64 por trozos (<=512 KB por trozo) hacia el puente nativo de Android.
export async function bridgeStage(blob, name) {
  const B = window.AndroidBridge, id = B.beginFile(name, blob.type || 'application/octet-stream'), STEP = 384 * 1024;
  for (let o = 0; o < blob.size; o += STEP) {
    const d = await new Promise((r, j) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1] || ''); f.onerror = () => j(f.error); f.readAsDataURL(blob.slice(o, o + STEP)); });
    B.appendChunk(id, d);
  }
  return id;
}
export async function makeThumb(blob) {
  let m = null;
  try {
    if (blob.type.startsWith('video/')) m = await videoFrame(blob);
    else {
      try { const bm = await createImageBitmap(blob); m = { src: bm, w: bm.width, h: bm.height, close: () => bm.close() }; }
      catch { m = await loadImg(blob); }
    }
  } catch {}
  const S = 300, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const isVid = blob.type.startsWith('video/');
  g.fillStyle = isVid ? '#2b2e35' : '#888'; g.fillRect(0, 0, S, S);
  let w = 0, h = 0;
  if (m) {
    w = m.w; h = m.h;
    const r = Math.max(S / w, S / h);
    g.drawImage(m.src, (S - w * r) / 2, (S - h * r) / 2, w * r, h * r);
    m.close();
  } else if (isVid) { // decodificación fallida: tile neutro con icono de reproducción
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.moveTo(112, 92); g.lineTo(112, 208); g.lineTo(212, 150); g.closePath(); g.fill();
  }
  const thumb = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  return { thumb, width: w, height: h, duration: m && m.duration };
}
