import { icon } from './icons.js';
import * as db from './db.js';
import { el, esc, norm, ls, dayKey, dayLabel, monthKey, monthLabel, fmtDateTime, fmtSize, isVideo, plural, thumbURL, dropThumbURL, makeThumb, fmtDur, probeDuration, bridgeStage, monthName } from './util.js';
import { pushOverlay, dismiss, overlayCount, sheet, menuSheet, popover, dialog, toast } from './ui.js';
import { openViewer } from './viewer.js';

const $ = s => document.querySelector(s);
const app = $('#app'), scroll = $('#scroll'), body = $('#body');
const LEVELS = [3, 4, 7, 'm'];
const DAY = 864e5, PURGE_DAYS = 30;

// En Android (WebView con puente nativo) las fotos del teléfono se leen de MediaStore.
const AB = () => window.AndroidBridge;
const DEV = !!(window.AndroidBridge && window.AndroidBridge.hasMediaPermission);
const pid = s => typeof s === 'string' && s.startsWith('dev:') ? s : +s;
let devState = 'full', devMeta = new Map(), permAsked = false, permWant = false, booted = false;
let items = [], albums = new Map(), byId = new Map(), groups = new Map();
let aset = { sort: 'custom', cols: 3, essential: false };
const asel = new Set();
let level = Math.min(3, Math.max(0, +ls.get('gal.level') || 0));
let sel = new Set(), selecting = false, selEntry = null;
let view = { name: 'images', items: [] };
let query = '', lastKey = null;

// ---------- data
async function load() {
  const idb = await db.getItems();
  albums = new Map((await db.getAlbums()).map(a => [a.name, a]));
  groups = new Map((await db.getGroups()).map(g => [g.id, g]));
  aset = { sort: 'custom', cols: 3, essential: false, ...((await db.getMeta('albumPrefs')) || {}) };
  if (DEV) devMeta = new Map((await db.getDevMeta()).map(r => [r.id, r]));
  const old = idb.filter(i => i.trashedAt && Date.now() - i.trashedAt > PURGE_DAYS * DAY);
  if (old.length) { await db.deleteItems(old.map(i => i.id)); const s = new Set(old.map(i => i.id)); items = idb.filter(i => !s.has(i.id)); } else items = idb;
  if (DEV) items = items.concat(devKept);
  reindex();
}
// ----- fotos del dispositivo (fuente de solo lectura fusionada con las de IndexedDB)
const devKept = [];
function mkDev(r) {
  const id = 'dev:' + r.id, m = devMeta.get(id);
  return { id, dev: true, mid: r.id, name: r.name, date: r.date, size: r.size, mime: r.mime, width: r.width, height: r.height, duration: r.duration ? r.duration / 1000 : undefined,
    devAlbum: r.album, album: (m && m.album) || r.album, thumbUrl: '/media/thumb/' + r.id, fullUrl: '/media/full/' + r.id, favorite: !!(m && m.favorite), trashedAt: (m && m.trashedAt) || null };
}
const sameDev = (a, b) => a.name === b.name && a.date === b.date && a.size === b.size && a.devAlbum === b.devAlbum && a.width === b.width && a.height === b.height && a.duration === b.duration;
// Vuelve a pedir la lista; devuelve true si algo cambió (elementos o estado de permiso).
async function refreshDevice() {
  if (!DEV) return false;
  const before = devState;
  devState = AB().hasMediaPermission();
  let raw = null;
  if (devState === 'none') raw = [];
  else { try { const r = await fetch('/media/list.json', { cache: 'no-store' }); if (r.ok) raw = await r.json(); } catch (e) { console.warn('lista de medios', e); } }
  if (!raw) return devState !== before;
  const prev = new Map();
  for (const i of items) if (i.dev) prev.set(i.id, i);
  const next = [];
  let changed = devState !== before || prev.size !== raw.length;
  for (const r of raw) {
    const n = mkDev(r), o = prev.get(n.id);
    if (o && sameDev(o, n)) next.push(o); else { next.push(n); changed = true; }
  }
  if (devState === 'full' && raw.length) { // metadatos de ids que ya no existen
    const ids = new Set(next.map(i => i.id)), gone = [...devMeta.keys()].filter(k => !ids.has(k));
    if (gone.length) { gone.forEach(k => devMeta.delete(k)); db.deleteDevMeta(gone).catch(() => {}); }
  }
  const exp = next.filter(i => i.trashedAt && Date.now() - i.trashedAt > PURGE_DAYS * DAY);
  if (exp.length) { exp.forEach(i => { i.trashedAt = null; }); saveItems(exp).catch(() => {}); changed = true; }
  if (!changed) return false;
  items = items.filter(i => !i.dev).concat(next);
  reindex();
  return true;
}
// Guarda cambios de usuario: elementos propios en IndexedDB; metadatos (favorito, papelera, álbum) de los del dispositivo.
async function saveItems(list) {
  const loc = list.filter(i => !i.dev), dv = list.filter(i => i.dev);
  if (loc.length) await db.putItems(loc);
  if (!dv.length) return;
  const put = [], del = [];
  for (const i of dv) {
    const rec = { id: i.id, favorite: !!i.favorite, trashedAt: i.trashedAt || null, album: i.album !== i.devAlbum ? i.album : null };
    if (rec.favorite || rec.trashedAt || rec.album) { put.push(rec); devMeta.set(i.id, rec); } else { del.push(i.id); devMeta.delete(i.id); }
  }
  if (put.length) await db.putDevMeta(put);
  if (del.length) await db.deleteDevMeta(del);
}
let delRes = null;
function deleteDevice(mids) {
  return new Promise(res => {
    if (delRes) return res([]);
    delRes = res;
    try { AB().deleteMedia(JSON.stringify(mids)); } catch { delRes = null; res([]); }
  });
}
window.__onMediaDeleted = ids => { const r = delRes; delRes = null; if (r) r(Array.isArray(ids) ? ids : []); };
window.__onMediaPermission = async st => {
  try { await refreshDevice(); } catch (e) { console.error(e); }
  render(true);
  if (permWant && devState === 'partial') toast('Para ver todas tus fotos, actívalo en Ajustes', { label: 'Ajustes', fn: () => AB().openAppSettings() });
  permWant = false;
};
let refT = 0, refBusy = false;
window.__onMediaChanged = () => {
  if (!DEV || !booted) return;
  clearTimeout(refT);
  refT = setTimeout(async () => {
    if (refBusy) return; refBusy = true;
    try { if (await refreshDevice()) render(true); } catch (e) { console.error(e); } finally { refBusy = false; }
  }, 150);
};
function reindex() { byId = new Map(items.map(i => [i.id, i])); }
const live = () => items.filter(i => !i.trashedAt).sort((a, b) => b.date - a.date);
const trashed = () => items.filter(i => i.trashedAt).sort((a, b) => b.trashedAt - a.trashedAt);

function albumNames() {
  const m = new Map();
  albums.forEach((_, n) => m.set(n, []));
  live().forEach(i => { if (!m.has(i.album)) m.set(i.album, []); m.get(i.album).push(i); });
  return m;
}
function albumCover(name, list) {
  const c = albums.get(name);
  const ci = c && c.cover != null && byId.get(c.cover);
  return ci && !ci.trashedAt ? ci : list[0];
}

const savePrefs = () => db.setMeta('albumPrefs', aset);
const AUTO = [{ k: 'recent', name: 'Recientes', icon: 'clock' }, { k: 'fav', name: 'Favoritos', icon: 'heart' }, { k: 'videos', name: 'Vídeos', icon: 'play' }];
const autoList = k => { const l = live(); return k === 'recent' ? l.filter(i => i.date > Date.now() - 30 * DAY) : k === 'fav' ? l.filter(i => i.favorite) : l.filter(isVideo); };
const ESSENTIAL = ['camara', 'capturas de pantalla', 'descargas', 'camera', 'screenshots', 'download'];
const isEssential = n => ESSENTIAL.includes(norm(n)) || !!(albums.get(n) && albums.get(n).user);
const grpOf = n => { const r = albums.get(n); return r && r.group != null && groups.has(r.group) ? r.group : null; };
const shown = n => { const r = albums.get(n) || {}; return !r.hidden && (!aset.essential || isEssential(n)); };
// Mosaicos del nivel gid (null = raíz): álbumes y, en la raíz, grupos, ya ordenados.
function tilesFor(gid) {
  const m = albumNames(), out = [];
  m.forEach((l, name) => {
    if (!shown(name) || grpOf(name) !== gid) return;
    out.push({ kind: 'a', key: 'a:' + name, name, l, n: l.length, ord: (albums.get(name) || {}).ord, date: l[0] ? l[0].date : 0, c: albumCover(name, l) });
  });
  if (gid == null) groups.forEach(g => {
    const kids = [...m].filter(([n]) => shown(n) && grpOf(n) === g.id);
    out.push({ kind: 'g', key: 'g:' + g.id, name: g.name, gid: g.id, kids, n: kids.length, ord: g.ord, date: 0 });
  });
  const so = aset.sort, nm = (a, b) => a.name.localeCompare(b.name, 'es');
  const cmp = so === 'custom' ? (a, b) => ((a.ord ?? 1e9) - (b.ord ?? 1e9)) || (b.date - a.date)
    : (a, b) => (a.kind === 'g') !== (b.kind === 'g') ? (a.kind === 'g' ? -1 : 1)
      : a.kind === 'g' ? nm(a, b) : so === 'name' ? nm(a, b) : so === 'count' ? (b.n - a.n) || nm(a, b) : so === 'dateAsc' ? a.date - b.date : b.date - a.date;
  return out.sort(cmp);
}

async function seed() {
  if (DEV) return; // en Android no se generan fotos de ejemplo
  if (await db.getMeta('seeded')) return;
  try {
    const { generateSamples } = await import('./samples.js');
    const s = await generateSamples(40), out = [];
    for (const x of s) {
      const t = await makeThumb(x.blob);
      out.push({ blob: x.blob, thumb: t.thumb, duration: t.duration, name: x.name, date: x.date, album: x.album, width: x.width || t.width, height: x.height || t.height, favorite: false, trashedAt: null });
    }
    await db.putItems(out);
  } catch (e) { console.warn('No se pudieron generar ejemplos', e); }
  await db.setMeta('seeded', 1);
}

// ---------- routing & views
function route() {
  const p = location.hash.slice(2).split('/');
  return { name: p[0] || 'images', arg: decodeURIComponent(p.slice(1).join('/')) };
}
const hashOf = (...p) => '#/' + p.map((x, i) => i ? encodeURIComponent(x) : x).join('/');

const hays = new WeakMap(); // texto de búsqueda en caché (miles de elementos, una pulsación = un recorrido)
function matches(it, toks) {
  let h = hays.get(it);
  if (!h || h.f !== it.favorite || h.a !== it.album || h.n !== it.name) {
    h = { f: it.favorite, a: it.album, n: it.name, t: norm([it.name, it.album, monthName(it.date), dayLabel(it.date), it.favorite ? 'favorito' : '', isVideo(it) ? 'video' : 'foto imagen'].join(' ')) };
    hays.set(it, h);
  }
  const hay = h.t;
  return toks.every(t => hay.includes(t));
}

let origin = null; // pantalla de la que se abrió un tipo (Álbumes / Colecciones)
const isShot = i => ['capturas de pantalla', 'screenshots', 'screenshot'].includes(norm(i.album));
function buildView(r) {
  const n = r.name, v = { name: n, type: 'grid', parent: null, actions: [], items: [], sub: '' };
  if (n === 'albums') origin = '#/albums'; else if (n === 'collections') origin = '#/collections'; else if (n === 'images' || n === '' || n === 'trash') origin = null;
  const tabOf = () => origin === '#/albums' ? 'albums' : origin === '#/collections' ? 'collections' : undefined;
  const search = { icon: 'search', label: 'Buscar', fn: () => { location.hash = '#/search'; } };
  const cols = { cols: true };
  if (n === 'albums') {
    Object.assign(v, { title: 'Álbumes', type: 'albums', gid: null, tab: 'albums', actions: [search, { icon: 'plus', label: 'Crear', fn: createMenu }, { cols: 'alb' }, { icon: 'more', label: 'Más', fn: albumsMenu }] });
    v.sub = plural(tilesFor(null).length + AUTO.length, 'álbum', 'álbumes');
  } else if (n === 'group') {
    const g = groups.get(+r.arg);
    Object.assign(v, { title: g ? g.name : 'Grupo', type: 'albums', gid: g ? g.id : -1, tab: 'albums', parent: '#/albums', actions: [{ cols: 'alb' }, { icon: 'more', label: 'Más', fn: () => groupMenu(g) }] });
    v.sub = plural(g ? tilesFor(g.id).length : 0, 'álbum', 'álbumes');
  } else if (n === 'albumvis') {
    Object.assign(v, { title: 'Álbumes a mostrar', type: 'albumvis', tab: 'albums', parent: '#/albums', sub: 'Los álbumes ocultos siguen apareciendo en Imágenes' });
  } else if (n === 'recent') {
    Object.assign(v, { title: 'Recientes', items: autoList('recent'), parent: origin || '#/albums', tab: origin === '#/collections' ? 'collections' : 'albums', actions: [cols], empty: 'No hay elementos recientes' });
  } else if (n === 'collections') {
    Object.assign(v, { title: 'Colecciones', type: 'collections', tab: 'collections', actions: [search] });
  } else if (n === 'album') {
    const l = live().filter(i => i.album === r.arg);
    Object.assign(v, { title: r.arg, items: l, parent: grpOf(r.arg) != null ? hashOf('group', String(grpOf(r.arg))) : '#/albums', tab: 'albums', actions: [cols, { icon: 'more', label: 'Más', fn: () => albumMenu(r.arg, l) }], empty: 'Este álbum está vacío' });
  } else if (n === 'month') {
    const l = live().filter(i => monthKey(i.date) === r.arg);
    Object.assign(v, { title: l[0] ? monthLabel(l[0].date) : 'Historia', items: l, parent: '#/collections', tab: 'collections', actions: [cols] });
  } else if (n === 'fav') {
    Object.assign(v, { title: 'Favoritos', items: live().filter(i => i.favorite), parent: origin || '#/', tab: tabOf(), actions: [cols], empty: 'Aún no tienes favoritos' });
  } else if (n === 'videos') {
    Object.assign(v, { title: 'Vídeos', items: live().filter(isVideo), parent: origin || '#/', tab: tabOf(), actions: [cols], empty: 'No hay vídeos' });
  } else if (n === 'screens') {
    Object.assign(v, { title: 'Capturas de pantalla', items: live().filter(isShot), parent: '#/collections', tab: 'collections', actions: [cols], empty: 'No hay capturas de pantalla' });
  } else if (n === 'trash') {
    const l = trashed();
    Object.assign(v, { title: 'Papelera', items: l, parent: '#/', trash: true, sub: 'Los elementos se eliminan definitivamente tras 30 días', empty: 'La papelera está vacía', actions: [cols, { icon: 'more', label: 'Más', fn: () => menuSheet([{ icon: 'trash', label: 'Vaciar papelera', danger: true, fn: emptyTrash }]) }] });
  } else if (n === 'search') {
    const toks = norm(query).split(/\s+/).filter(Boolean);
    Object.assign(v, { title: 'Buscar', type: 'search', parent: '#/', items: toks.length ? live().filter(i => matches(i, toks)) : [], empty: toks.length ? 'Sin resultados' : 'Busca por nombre, álbum o mes' });
  } else {
    Object.assign(v, { name: 'images', title: 'Imágenes', tab: 'images', items: live(), actions: [search, { icon: 'plus', label: 'Crear', fn: createPop }, cols], empty: 'No hay imágenes. Impórtalas desde el menú.' });
  }
  if (v.type === 'grid' && !v.trash) v.sub = v.sub || plural(v.items.length, 'elemento', 'elementos');
  if (v.trash) v.sub = plural(v.items.length, 'elemento', 'elementos') + ' · se eliminan tras 30 días';
  if (v.type === 'search') v.sub = '';
  return v;
}

const colLabel = a => a === 'alb' ? aset.cols : LEVELS[level] === 'm' ? 'Mes' : LEVELS[level];
let io;
function lazy(root) {
  if (!io) io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const img = e.target; io.unobserve(img);
    const it = byId.get(pid(img.dataset.id)); if (!it) return;
    img.onload = () => img.classList.add('ld');
    img.src = thumbURL(it);
  }), { root: scroll, rootMargin: '900px 0px' });
  root.querySelectorAll('img[data-id]:not([src])').forEach(i => io.observe(i));
}

// ---------- cuadrícula por fechas virtualizada: solo hay DOM para las filas visibles (+ margen)
let VG = null;
const HEAD = 40;
const firstRow = (rows, y) => { let lo = 0, hi = rows.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rows[m].y <= y) lo = m; else hi = m - 1; } return lo; };
const bodyTop = () => body.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
function gridModel(list, v) {
  const L = LEVELS[level], cols = L === 'm' ? 7 : L, mon = L === 'm';
  const W = body.clientWidth || scroll.clientWidth || 390, cell = (W - (cols - 1) * 2) / cols;
  const groups = [], rows = [], idRow = new Map();
  let k = null, y = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i], kk = v.trash ? 'x' : mon ? monthKey(it.date) : dayKey(it.date);
    if (kk !== k) { groups.push([i, it.date]); k = kk; }
  }
  groups.forEach(([s0, ts], gi) => {
    const e = gi + 1 < groups.length ? groups[gi + 1][0] : list.length;
    if (!v.trash) { rows.push({ y, h: HEAD, t: 0, ts }); y += HEAD; }
    for (let a = s0; a < e; a += cols) {
      const b = Math.min(e, a + cols);
      rows.push({ y, h: cell, t: 1, a, b });
      for (let j = a; j < b; j++) idRow.set(list[j].id, rows.length - 1);
      y += cell + 2;
    }
  });
  return { rows, idRow, total: y, cols, mon };
}
function cellHTML(it, v) {
  const days = v.trash ? Math.max(0, Math.ceil(PURGE_DAYS - (Date.now() - it.trashedAt) / DAY)) : 0;
  return `<div class="cell${sel.has(it.id) ? ' sel' : ''}" data-id="${it.id}" role="button" aria-label="${esc(it.name)}"><img alt="" draggable="false" loading="lazy" decoding="async" data-id="${it.id}" src="${thumbURL(it)}">${isVideo(it) ? `<span class="vb">${icon('play', 14)}${it.duration ? `<i>${fmtDur(it.duration)}</i>` : ''}</span>` : ''}${it.favorite ? `<span class="fv">${icon('heart-fill', 14)}</span>` : ''}${v.trash ? `<span class="dl">${days} d</span>` : ''}<i class="ck">${icon('check', 15)}</i></div>`;
}
function rowHTML(G, i) {
  const r = G.rows[i];
  if (r.t === 0) return `<h3 class="vh" data-r="${i}" style="top:${r.y}px">${esc(G.mon ? monthLabel(r.ts) : dayLabel(r.ts))}</h3>`;
  let h = `<div class="vrow" data-r="${i}" style="top:${r.y}px;height:${r.h}px">`;
  for (let j = r.a; j < r.b; j++) h += cellHTML(G.list[j], G.v);
  return h + '</div>';
}
function paintGrid() {
  const G = VG; if (!G) return;
  const vh = scroll.clientHeight, rel = scroll.getBoundingClientRect().top - body.getBoundingClientRect().top;
  const buf = vh * (G.cols > 4 ? 0.8 : 1.2);
  const a = firstRow(G.rows, Math.max(0, rel - buf)), b = firstRow(G.rows, Math.max(0, rel + vh + buf));
  if (a === G.a && b === G.b) return;
  G.a = a; G.b = b;
  for (const [i, e] of G.dom) if (i < a || i > b) { e.remove(); G.dom.delete(i); }
  let h = '';
  for (let i = a; i <= b; i++) if (!G.dom.has(i)) h += rowHTML(G, i);
  if (!h) return;
  const t = document.createElement('template'); t.innerHTML = h;
  for (const e of t.content.children) G.dom.set(+e.dataset.r, e);
  body.append(t.content);
}
function setGrid(list, v) {
  VG = null; body.textContent = ''; body.style.height = ''; body.classList.remove('vbody');
  if (!list.length) { body.innerHTML = `<div class="empty">${icon('photo', 48)}<p>${esc(v.empty || '')}</p></div>`; return; }
  const m = gridModel(list, v);
  VG = { ...m, list, v, dom: new Map(), a: -1, b: -2 };
  body.classList.add('vbody'); body.style.height = m.total + 'px'; body.style.setProperty('--cols', m.cols);
  paintGrid();
}
// Elemento de referencia para conservar la posición de scroll al volver a pintar.
function gridAnchor() {
  if (!VG) return null;
  const rel = scroll.scrollTop - bodyTop();
  let i = firstRow(VG.rows, Math.max(0, rel));
  if (VG.rows[i].t === 0 && VG.rows[i + 1]) i++;
  const r = VG.rows[i];
  return r.t ? { id: VG.list[r.a].id, off: r.y - rel } : null;
}
function gridRestore(a) {
  if (!a || !VG || !VG.idRow.has(a.id)) return false;
  scroll.scrollTop = bodyTop() + VG.rows[VG.idRow.get(a.id)].y - a.off;
  return true;
}
body.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);

function render(keep) {
  const r = route(), key = location.hash;
  if (selecting && key !== lastKey) exitSelect();
  const sameKey = key === lastKey;
  const top = keep && sameKey ? scroll.scrollTop : 0;
  const anchor = keep && sameKey ? gridAnchor() : null;
  lastKey = key;
  const v = view = buildView(r);
  app.dataset.view = v.name;
  $('#lt h1').textContent = v.title;
  $('#lt .sub').textContent = v.sub || '';
  $('#tb-title').textContent = v.title;
  const back = $('#tb-back');
  back.hidden = !v.parent;
  back.onclick = () => { location.hash = v.parent; };
  $('#tb-actions').innerHTML = v.actions.map((a, i) => a.cols
    ? `<button class="pill" data-i="${i}" aria-label="Cambiar columnas">▦ ${colLabel(a.cols)}</button>`
    : `<button class="ib" data-i="${i}" aria-label="${esc(a.label)}">${icon(a.icon, 24)}</button>`).join('');
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.toggle('on', t.dataset.tab === v.tab));
  $('#tab-menu').classList.toggle('on', v.name === 'trash' || (['fav', 'videos'].includes(v.name) && !v.tab));
  const extra = $('#lt-extra'); extra.innerHTML = '';
  if (v.type === 'search') {
    extra.innerHTML = `<div class="searchbox">${icon('search', 20)}<input type="search" placeholder="Buscar en la galería" value="${esc(query)}" autocomplete="off"></div>`;
    const inp = extra.querySelector('input'); let t;
    inp.addEventListener('input', () => {
      query = inp.value; clearTimeout(t);
      t = setTimeout(() => { view = buildView(route()); setGrid(view.items, view); }, 120);
    });
    setTimeout(() => inp.focus(), 50);
  }
  if (v.type === 'albums' && v.gid == null) extra.innerHTML = `<div class="seg ess">${[[0, 'Ver todo'], [1, 'Solo esenciales']].map(([k, n]) => `<button data-ess="${k}" class="${!!k === aset.essential ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (DEV && devState === 'partial' && v.name === 'images') extra.insertAdjacentHTML('beforeend', `<div class="banner"><span>Solo tienes acceso a algunas fotos.</span><button data-perm>Permitir todas</button></div>`);
  VG = null; body.classList.remove('vbody'); body.style.height = '';
  if (v.type === 'albums') body.innerHTML = albumsHTML(v.gid);
  else if (v.type === 'albumvis') body.innerHTML = visHTML();
  else if (v.type === 'collections') body.innerHTML = collectionsHTML();
  else setGrid(v.items, v);
  if (v.type !== 'grid' && v.type !== 'search') lazy(body);
  if (selecting) { buildActionBar(); updateSel(); }
  scroll.scrollTop = top;
  if (anchor) gridRestore(anchor);
  renderPerm();
  onScroll();
}
function renderPerm() {
  const p = $('#perm'), need = DEV && devState === 'none' && !items.length;
  p.hidden = !need;
  if (!need) { p.innerHTML = ''; return; }
  if (p.firstChild) { p.querySelector('[data-pset]').hidden = !permAsked; return; }
  p.innerHTML = `${icon('photo', 64)}<h2>Permite el acceso a tus fotos</h2><p>Galería muestra las fotos y vídeos de tu teléfono sin copiarlos ni sacarlos de él.</p><button class="big" data-pgo>Permitir acceso</button><button class="big sec" data-pset ${permAsked ? '' : 'hidden'}>Abrir ajustes</button>`;
}
$('#perm').addEventListener('click', e => {
  if (e.target.closest('[data-pgo]')) { permAsked = true; AB().requestMediaPermission(); }
  else if (e.target.closest('[data-pset]')) AB().openAppSettings();
});

function albumsHTML(gid) {
  const ck = '<i class="ck">' + icon('check', 15) + '</i>';
  const tile = t => {
    const c = `${t.kind === 'g'
      ? `<div class="cov mosaic">${[0, 1, 2, 3].map(i => { const k = t.kids[i], cv = k && albumCover(k[0], k[1]); return `<div class="mz">${cv ? `<img alt="" draggable="false" data-id="${cv.id}">` : ''}</div>`; }).join('')}${ck}</div>`
      : `<div class="cov">${t.c ? `<img alt="" draggable="false" data-id="${t.c.id}">` : icon('album', 36)}${ck}</div>`}`;
    return `<a class="alb${t.kind === 'g' ? ' grp' : ''}${asel.has(t.key) ? ' sel' : ''}" data-k="${esc(t.key)}" draggable="false" href="${t.kind === 'g' ? hashOf('group', String(t.gid)) : hashOf('album', t.name)}">${c}<b>${t.kind === 'g' ? icon('folder', 14) + ' ' : ''}${esc(t.name)}</b><span>${t.kind === 'g' ? plural(t.n, 'álbum', 'álbumes') : t.n}</span></a>`;
  };
  const tiles = tilesFor(gid);
  const autos = gid == null ? AUTO.map(a => { const l = autoList(a.k); return `<a class="alb auto" data-k="auto:${a.k}" draggable="false" href="#/${a.k}"><div class="cov">${l[0] ? `<img alt="" draggable="false" data-id="${l[0].id}">` : icon(a.icon, 36)}<em class="ab">${icon(a.icon, 16)}</em></div><b>${a.name}</b><span>${l.length}</span></a>`; }) : [];
  if (!tiles.length && !autos.length) return `<div class="empty">${icon('album', 48)}<p>${gid === -1 ? 'Grupo no encontrado' : 'Este grupo está vacío. Arrastra álbumes hasta aquí o usa «Mover a grupo».'}</p></div>`;
  return `<div class="albums" style="--ac:${aset.cols}">${autos.join('')}${tiles.map(tile).join('')}</div>`;
}
function visHTML() {
  const rows = [...albumNames()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  if (!rows.length) return `<div class="empty">${icon('album', 48)}<p>No hay álbumes</p></div>`;
  return `<div class="rows vis">${rows.map(([n, l]) => { const c = albumCover(n, l), on = !(albums.get(n) || {}).hidden; return `<button class="row" data-vis="${esc(n)}" role="switch" aria-checked="${on}"><span class="ri">${c ? `<img alt="" data-id="${c.id}">` : icon('album', 22)}</span><span class="rl">${esc(n)}</span><span class="rn">${l.length}</span><span class="sw${on ? ' on' : ''}"></span></button>`; }).join('')}</div>`;
}
function collectionsHTML() {
  const m = albumNames(), mos = (kids) => `<div class="cov mosaic">${[0, 1, 2, 3].map(i => { const k = kids[i], cv = k && albumCover(k[0], k[1]); return `<div class="mz">${cv ? `<img alt="" draggable="false" data-id="${cv.id}">` : ''}</div>`; }).join('')}</div>`;
  const folders = [...groups.values()].sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9)).map(g => {
    const kids = [...m].filter(([n]) => shown(n) && grpOf(n) === g.id);
    return `<a class="alb" href="${hashOf('group', String(g.id))}" draggable="false">${mos(kids)}<b>${icon('folder', 14)} ${esc(g.name)}</b><span>${plural(kids.length, 'álbum', 'álbumes')}</span></a>`;
  });
  const newTile = `<button class="alb new" data-newfolder><div class="cov">${icon('plus', 36)}</div><b>Nueva carpeta</b><span>&nbsp;</span></button>`;
  const g = new Map();
  live().forEach(i => { const k = monthKey(i.date); if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  const stories = [...g].map(([k, l]) => `<a class="story" href="${hashOf('month', k)}"><img alt="" draggable="false" data-id="${l[Math.floor(l.length / 2)].id}"><div class="sc"><b>${esc(monthLabel(l[0].date))}</b><span>${plural(l.length, 'elemento', 'elementos')}</span></div></a>`);
  const types = [['videos', 'play', 'Vídeos', live().filter(isVideo).length], ['fav', 'heart', 'Favoritos', live().filter(i => i.favorite).length],
    ['screens', 'photo', 'Capturas de pantalla', live().filter(isShot).length], ['recent', 'clock', 'Recientes', autoList('recent').length]];
  return `<h2 class="chead">Carpetas</h2><div class="hrow">${folders.join('')}${newTile}</div>${folders.length ? '' : '<p class="chint">Agrupa tus álbumes en carpetas.</p>'}
<h2 class="chead">Historias</h2>${stories.length ? `<div class="hrow">${stories.join('')}</div>` : '<p class="chint">Aún no hay historias. Se crean a partir de tus fotos por mes.</p>'}
<h2 class="chead">Tipos</h2><div class="types">${types.map(([h, ic, n, c]) => `<a class="type" href="#/${h}"><span class="ri">${icon(ic, 20)}</span><div><b>${n}</b><span>${c}</span></div></a>`).join('')}</div>`;
}

// ---------- collapsing header
let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    paintGrid();
    const p = Math.min(1, scroll.scrollTop / 70), lt = $('#lt');
    lt.style.opacity = 1 - p;
    lt.style.transform = `translateY(${-p * 10}px) scale(${1 - p * 0.18})`;
    $('#tb-title').style.opacity = p;
    $('#topbar').classList.toggle('scrolled', p >= 1);
  });
}
scroll.addEventListener('scroll', onScroll, { passive: true });
$('#lt-extra').addEventListener('click', e => {
  if (e.target.closest('[data-perm]')) { permAsked = permWant = true; AB().requestMediaPermission(); return; }
  const b = e.target.closest('[data-ess]'); if (!b) return;
  aset.essential = b.dataset.ess === '1'; savePrefs(); render(true);
});
body.addEventListener('click', async e => {
  if (e.target.closest('[data-newfolder]')) { newFolderGo(); return; }
  const r = e.target.closest('[data-vis]'); if (!r) return;
  const n = r.dataset.vis, on = !(albums.get(n) || {}).hidden;
  await setHidden([n], on);
  r.setAttribute('aria-checked', !on); r.querySelector('.sw').classList.toggle('on', !on);
});
$('#tb-actions').addEventListener('click', e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const a = view.actions[+b.dataset.i];
  if (a.cols === 'alb') { aset.cols = aset.cols >= 4 ? 2 : aset.cols + 1; savePrefs(); render(true); }
  else if (a.cols) setLevel((level + 1) % LEVELS.length); else a.fn(b);
});

// ---------- column level (pinch / button)
function setLevel(n) {
  n = Math.max(0, Math.min(LEVELS.length - 1, n));
  if (n === level) return;
  const sr = scroll.getBoundingClientRect();
  const c = document.elementFromPoint(sr.left + sr.width / 2, sr.top + 110);
  const cell = c && c.closest && c.closest('.cell');
  const id = cell && cell.dataset.id, off = cell ? cell.getBoundingClientRect().top - sr.top : 0;
  level = n; ls.set('gal.level', n);
  render(true);
  if (id && VG && VG.idRow.has(pid(id))) { scroll.scrollTop = bodyTop() + VG.rows[VG.idRow.get(pid(id))].y - off; paintGrid(); }
}
let wheelT = 0;
scroll.addEventListener('wheel', e => {
  if (!e.ctrlKey || Date.now() - wheelT < 250 || (view.type !== 'grid' && view.type !== 'search')) return;
  e.preventDefault(); wheelT = Date.now();
  setLevel(level + (e.deltaY < 0 ? -1 : 1));
}, { passive: false });

// ---------- selection & grid gestures
const idOf = c => pid(c.dataset.id);
function setSel(cell, on) {
  const id = idOf(cell);
  if (on) sel.add(id); else sel.delete(id);
  cell.classList.toggle('sel', on);
}
function enterSelect() {
  if (selecting) return;
  selecting = true;
  selEntry = pushOverlay(() => endSelectUI());
  app.classList.add('selecting');
  buildActionBar(); updateSel();
}
function endSelectUI() {
  selecting = false; sel.clear(); asel.clear();
  app.classList.remove('selecting');
  scroll.querySelectorAll('.cell.sel, .alb.sel').forEach(c => c.classList.remove('sel'));
}
function exitSelect() { return selecting ? dismiss(selEntry) : Promise.resolve(); }
function selItems() { return [...sel].map(i => byId.get(i)).filter(Boolean); }
function updateSel() {
  if (view.type === 'albums') {
    const n = asel.size, ks = [...asel], onlyA = n > 0 && ks.every(k => k[0] === 'a');
    $('#sel-count').textContent = n ? (n === 1 ? '1 seleccionado' : n + ' seleccionados') : 'Seleccionar álbumes';
    $('#sel-all').classList.toggle('on', n > 0 && n === tilesFor(view.gid).length);
    $('#actionbar').classList.toggle('empty', n === 0);
    const dis = { rename: n !== 1, trash: !n, move: !onlyA, hide: !onlyA, cover: !(n === 1 && onlyA) };
    $('#actionbar').querySelectorAll('button').forEach(b => { b.disabled = !!dis[b.dataset.k]; });
    return;
  }
  const n = sel.size;
  const sv = $('#actionbar [data-k=save]'); if (sv) sv.hidden = n > 0 && selItems().every(i => i.dev);
  $('#sel-count').textContent = n ? (n === 1 ? '1 seleccionado' : n + ' seleccionados') : 'Seleccionar elementos';
  $('#sel-all').classList.toggle('on', n > 0 && n === view.items.length);
  $('#actionbar').classList.toggle('empty', n === 0);
}
function buildActionBar() {
  if (view.type === 'albums') {
    $('#actionbar').innerHTML = [['rename', 'edit', 'Renombrar'], ['trash', 'trash', 'Eliminar'], ['move', 'folder', 'Mover a grupo'], ['hide', 'eyeoff', 'Ocultar'], ['cover', 'photo', 'Cambiar portada']].map(r => `<button data-k="${r[0]}">${icon(r[1], 24)}<span>${r[2]}</span></button>`).join('');
    return;
  }
  const T = view.trash;
  const rows = T ? [['restore', 'restore', 'Restaurar'], ['trash', 'trash', 'Eliminar']]
    : [['share', 'share', 'Compartir'], ...(DEV && !items.some(i => !i.dev) ? [] : [['save', 'download', 'Guardar']]), ['trash', 'trash', 'Eliminar'], ['album', 'plus', 'Álbum'], ['fav', 'heart', 'Favorito']];
  $('#actionbar').innerHTML = rows.map(r => `<button data-k="${r[0]}">${icon(r[1], 24)}<span>${r[2]}</span></button>`).join('');
}
$('#actionbar').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (b && view.type === 'albums') { if (!b.disabled && asel.size) albumAction(b.dataset.k); return; }
  if (!b || !sel.size) return;
  const l = selItems(), k = b.dataset.k;
  if (k === 'share') { await share(l); }
  else if (k === 'save') { await saveFiles(l); }
  else if (k === 'trash') { if (view.trash) { if (await confirmDelete(l)) { await exitSelect(); await destroy(l); } } else { await exitSelect(); await trashItems(l); } }
  else if (k === 'restore') { await exitSelect(); await restore(l); }
  else if (k === 'album') { if (await addToAlbum(l)) await exitSelect(); }
  else if (k === 'fav') { const on = !l.every(i => i.favorite); l.forEach(i => i.favorite = on); await saveItems(l); toast(on ? 'Añadido a favoritos' : 'Quitado de favoritos'); await exitSelect(); render(true); }
});
$('#sel-close').onclick = () => exitSelect();
$('#sel-all').onclick = () => {
  if (view.type === 'albums') {
    const ks = tilesFor(view.gid).map(t => t.key), all = asel.size !== ks.length;
    asel.clear(); if (all) ks.forEach(k => asel.add(k));
    scroll.querySelectorAll('.alb[data-k]').forEach(c => c.classList.toggle('sel', asel.has(c.dataset.k)));
    updateSel(); return;
  }
  const all = sel.size !== view.items.length;
  sel.clear();
  if (all) view.items.forEach(i => sel.add(i.id));
  scroll.querySelectorAll('.cell').forEach(c => c.classList.toggle('sel', all));
  updateSel();
};

(function gridGestures() {
  const pts = new Map();
  let lp = 0, down = null, dragging = false, dragOn = true, suppress = false, pinchD = 0, edge = 0, lastY = 0;
  const cancelLP = () => { clearTimeout(lp); lp = 0; };
  scroll.addEventListener('pointerdown', e => {
    suppress = false;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { cancelLP(); const [a, b] = [...pts.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); down = null; return; }
    if (pts.size > 2) return;
    const cell = e.target.closest && e.target.closest('.cell');
    if (!cell) { down = null; return; }
    down = { x: e.clientX, y: e.clientY, cell };
    lp = setTimeout(() => {
      lp = 0; suppress = true;
      if (!selecting) { enterSelect(); setSel(cell, true); dragOn = true; }
      else { dragOn = !cell.classList.contains('sel'); setSel(cell, dragOn); }
      dragging = true; updateSel();
      navigator.vibrate && navigator.vibrate(12);
    }, selecting ? 280 : 420);
  }, { passive: true });
  scroll.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2 && pinchD) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), r = d / pinchD;
      if (r > 1.3) { pinchD = d; setLevel(level - 1); }
      else if (r < 0.77) { pinchD = d; setLevel(level + 1); }
      return;
    }
    if (dragging) {
      lastY = e.clientY;
      const t = document.elementFromPoint(e.clientX, e.clientY), c = t && t.closest && t.closest('.cell');
      if (c && c.classList.contains('sel') !== dragOn) { setSel(c, dragOn); updateSel(); }
      const sr = scroll.getBoundingClientRect();
      edge = e.clientY < sr.top + 90 ? -1 : e.clientY > sr.bottom - 110 ? 1 : 0;
      if (edge && !edgeRAF) edgeLoop();
    } else if (down && lp && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) cancelLP();
  }, { passive: true });
  let edgeRAF = 0;
  function edgeLoop() {
    edgeRAF = requestAnimationFrame(() => {
      edgeRAF = 0;
      if (!dragging || !edge) return;
      scroll.scrollTop += edge * 14; edgeLoop();
    });
  }
  const up = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchD = 0;
    if (!pts.size) { cancelLP(); dragging = false; edge = 0; down = null; }
  };
  scroll.addEventListener('pointerup', up, { passive: true });
  scroll.addEventListener('pointercancel', up, { passive: true });
  scroll.addEventListener('touchmove', e => { if (dragging) e.preventDefault(); }, { passive: false });
  scroll.addEventListener('contextmenu', e => { if (e.target.closest('.cell')) e.preventDefault(); });
  scroll.addEventListener('click', e => {
    if (suppress) { suppress = false; return; }
    const cell = e.target.closest('.cell'); if (!cell) return;
    if (selecting) { setSel(cell, !cell.classList.contains('sel')); updateSel(); return; }
    const list = view.items, i = list.findIndex(x => x.id === idOf(cell));
    if (i >= 0) openViewer({ list, index: i, A });
  });
})();

// ---------- album tiles: long-press = select, hold + move = drag & drop (reorder / group)
(function albumGestures() {
  let lp = 0, dn = null, drag = null, suppress = false, edge = 0, raf2 = 0;
  const tileOf = t => t && t.closest && t.closest('.alb[data-k]');
  const clearMarks = () => scroll.querySelectorAll('.drop-in,.drop-l,.drop-r').forEach(x => x.classList.remove('drop-in', 'drop-l', 'drop-r'));
  scroll.addEventListener('pointerdown', e => {
    suppress = false;
    if (view.type !== 'albums' || (e.pointerType === 'mouse' && e.button)) return;
    const t = tileOf(e.target); if (!t || t.classList.contains('auto')) return;
    dn = { x: e.clientX, y: e.clientY, t, armed: false };
    lp = setTimeout(() => {
      lp = 0; suppress = true; dn.armed = true;
      if (!selecting) enterSelect();
      asel.add(t.dataset.k); t.classList.add('sel'); updateSel();
      navigator.vibrate && navigator.vibrate(12);
    }, 420);
  }, { passive: true });
  function startDrag(e) {
    const r = dn.t.getBoundingClientRect(), k = dn.t.dataset.k;
    const keys = asel.has(k) ? [...asel] : [k];
    const g = dn.t.cloneNode(true); g.classList.add('ghost'); g.style.cssText = `width:${r.width}px;left:0;top:0`;
    document.body.append(g);
    drag = { keys, g, ox: e.clientX - r.left, oy: e.clientY - r.top, tk: null, zone: null };
    keys.forEach(x => { const t = scroll.querySelector(`.alb[data-k="${CSS.escape(x)}"]`); t && t.classList.add('dragging'); });
  }
  function moveDrag(e) {
    drag.g.style.transform = `translate(${e.clientX - drag.ox}px,${e.clientY - drag.oy}px) scale(1.06)`;
    clearMarks(); drag.tk = drag.zone = null;
    const t = tileOf(document.elementFromPoint(e.clientX, e.clientY));
    if (t && !t.classList.contains('auto') && !drag.keys.includes(t.dataset.k)) {
      const r = t.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const allA = drag.keys.every(k => k[0] === 'a');
      const into = fx > .28 && fx < .72 && fy > .1 && fy < .9 && allA && (t.dataset.k[0] === 'g' || drag.keys.length === 1);
      drag.tk = t.dataset.k; drag.zone = into ? 'into' : fx < .5 ? 'before' : 'after';
      t.classList.add(into ? 'drop-in' : fx < .5 ? 'drop-l' : 'drop-r');
    }
    const sr = scroll.getBoundingClientRect();
    edge = e.clientY < sr.top + 90 ? -1 : e.clientY > sr.bottom - 110 ? 1 : 0;
    if (edge && !raf2) { const loop = () => { raf2 = requestAnimationFrame(() => { raf2 = 0; if (drag && edge) { scroll.scrollTop += edge * 12; loop(); } }); }; loop(); }
  }
  async function endDrag(ok) {
    const d = drag; drag = null; dn = null; edge = 0;
    if (!d) return;
    d.g.remove(); clearMarks();
    scroll.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
    if (ok && d.tk) await dropAlbums(d.keys, d.tk, d.zone);
  }
  scroll.addEventListener('pointermove', e => {
    if (!dn) return;
    const mv = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
    if (!dn.armed) { if (lp && mv > 10) { clearTimeout(lp); lp = 0; dn = null; } return; }
    if (!drag && mv > 6) startDrag(e);
    if (drag) moveDrag(e);
  }, { passive: true });
  scroll.addEventListener('pointerup', () => { clearTimeout(lp); lp = 0; if (drag) endDrag(true); else dn = null; }, { passive: true });
  scroll.addEventListener('pointercancel', () => { clearTimeout(lp); lp = 0; if (drag) endDrag(false); else dn = null; }, { passive: true });
  scroll.addEventListener('touchmove', e => { if (drag || (dn && dn.armed)) e.preventDefault(); }, { passive: false });
  scroll.addEventListener('contextmenu', e => { if (e.target.closest('.alb')) e.preventDefault(); });
  scroll.addEventListener('click', e => {
    const t = e.target.closest('.alb[data-k]'); if (!t) return;
    if (suppress) { suppress = false; e.preventDefault(); return; }
    if (!selecting) return;
    e.preventDefault();
    if (t.classList.contains('auto')) return;
    const k = t.dataset.k, on = !asel.has(k);
    if (on) asel.add(k); else asel.delete(k);
    t.classList.toggle('sel', on); updateSel();
  });
  scroll.addEventListener('dragstart', e => { if (e.target.closest && e.target.closest('.alb')) e.preventDefault(); });
})();

// ---------- actions
async function trashItems(list) {
  const t = Date.now();
  list.forEach(i => { i.trashedAt = t; });
  await saveItems(list);
  render(true);
  toast(list.length === 1 ? 'Movido a la papelera' : `${list.length} elementos movidos a la papelera`, { label: 'Deshacer', fn: () => restore(list, true) });
}
async function restore(list, quiet) {
  list.forEach(i => { i.trashedAt = null; });
  await saveItems(list);
  render(true);
  if (!quiet) toast(list.length === 1 ? 'Elemento restaurado' : `${list.length} elementos restaurados`);
}
const confirmDelete = l => dialog({ title: 'Eliminar definitivamente', message: `${plural(l.length, 'elemento se eliminará', 'elementos se eliminarán')} para siempre.${l.some(i => i.dev) ? ' Android te pedirá confirmación.' : ''} Esta acción no se puede deshacer.`, ok: 'Eliminar', danger: true });
async function destroy(list) {
  const gone = new Set(), loc = list.filter(i => !i.dev), dv = list.filter(i => i.dev);
  if (loc.length) { await db.deleteItems(loc.map(i => i.id)); loc.forEach(i => { gone.add(i.id); dropThumbURL(i.id); }); }
  if (dv.length) {
    // solo se quitan del modelo los ids que el sistema confirma como borrados
    const del = await deleteDevice(dv.map(i => i.mid));
    const ok = dv.filter(i => del.includes(i.mid));
    ok.forEach(i => { gone.add(i.id); devMeta.delete(i.id); });
    if (ok.length) db.deleteDevMeta(ok.map(i => i.id)).catch(() => {});
  }
  if (gone.size) { items = items.filter(i => !gone.has(i.id)); reindex(); }
  render(true);
  toast(gone.size ? 'Eliminado definitivamente' : 'No se eliminó nada');
  return gone.size === list.length;
}
async function emptyTrash() {
  const l = trashed(); if (!l.length) return toast('La papelera está vacía');
  if (await confirmDelete(l)) destroy(l);
}
function fileName(it, blob = it.blob) {
  const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split('+')[0];
  return /\.[a-z0-9]{2,4}$/i.test(it.name) ? it.name : it.name + '.' + ext;
}
async function share(list) {
  if (AB()) {
    if (list.every(i => i.dev) && AB().shareMedia) { AB().shareMedia(JSON.stringify(list.map(i => i.mid))); return; }
    try {
      const ids = [];
      for (const i of list) { const b = i.dev ? await (await fetch(i.fullUrl)).blob() : i.blob; ids.push(await bridgeStage(b, fileName(i, b))); }
      AB().shareFiles(JSON.stringify(ids));
    } catch (e) { toast('No se pudo compartir'); }
    return;
  }
  const files = list.map(i => new File([i.blob], fileName(i), { type: i.blob.type }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  download(files);
  toast('Compartir no disponible: descargando');
}
function download(files) {
  files.forEach((f, k) => setTimeout(() => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, k * 250));
}
async function saveFiles(list) {
  list = list.filter(i => !i.dev); // las del dispositivo ya están en él
  if (!list.length) return;
  if (AB()) {
    try { for (const i of list) AB().saveFile(await bridgeStage(i.blob, fileName(i))); toast(list.length === 1 ? 'Guardado en Pictures/Galería' : `${list.length} elementos guardados en Pictures/Galería`); } catch (e) { toast('No se pudo guardar'); }
    return;
  }
  download(list.map(i => new File([i.blob], fileName(i), { type: i.blob.type })));
  toast(list.length === 1 ? 'Guardando en el dispositivo…' : `Guardando ${list.length} elementos…`);
}
async function createAlbum() {
  const name = await dialog({ title: 'Nuevo álbum', input: { placeholder: 'Nombre del álbum' }, ok: 'Crear' });
  if (!name) return null;
  if (!albumNames().has(name)) { const a = { name, user: true, group: view.gid > 0 ? view.gid : undefined }; albums.set(name, a); await db.putAlbum(a); }
  render(true);
  return name;
}
function addToAlbum(list) {
  return new Promise(res => {
    let mode = 'move', done = false;
    const c = el('div');
    const names = [...albumNames()];
    c.innerHTML = `<div class="seg"${list.every(i => i.dev) ? ' hidden' : ''}><button data-m="move" class="on">Mover</button><button data-m="copy">Copiar</button></div>${list.some(i => i.dev) ? '<p class="hint">Las fotos del dispositivo no se mueven de su carpeta: el álbum solo cambia dentro de la app.</p>' : ''}<div class="rows"><button class="row" data-n="">${'<span class="ri">' + icon('plus', 22) + '</span>'}<span class="rl">Álbum nuevo</span></button>${names.map(([n, l], i) => `<button class="row" data-i="${i}"><span class="ri alb-t">${l[0] ? `<img alt="" src="${thumbURL(l[0])}">` : icon('album', 22)}</span><span class="rl">${esc(n)}</span><span class="rn">${l.length}</span></button>`).join('')}</div>`;
    const s = sheet({ title: 'Añadir a álbum', content: c, onClose: () => { if (!done) res(false); } });
    c.addEventListener('click', async e => {
      const m = e.target.closest('[data-m]');
      if (m) { mode = m.dataset.m; c.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b === m)); return; }
      const r = e.target.closest('.row'); if (!r) return;
      done = true;
      await s.close();
      let name = r.dataset.i != null ? names[+r.dataset.i][0] : await createAlbum();
      if (!name) return res(false);
      await applyAlbum(list, name, mode);
      res(true);
    });
  });
}
async function applyAlbum(list, name, mode) {
  if (!albums.has(name) && !live().some(i => i.album === name)) { const a = { name }; albums.set(name, a); await db.putAlbum(a); }
  const dv = list.filter(i => i.dev), loc = list.filter(i => !i.dev);
  if (mode === 'copy' && loc.length) {
    const cp = loc.map(i => ({ ...i, id: undefined, album: name, trashedAt: null }));
    await db.putItems(cp); items.push(...cp); reindex();
  } else loc.forEach(i => { i.album = name; });
  dv.forEach(i => { i.album = name; }); // las del dispositivo no se copian: solo cambia el álbum en la app
  await saveItems(mode === 'copy' ? dv : list);
  render(true);
  toast(`${mode === 'copy' ? 'Copiado' : 'Movido'} a «${name}»`);
}
// ----- álbumes y grupos
const nextOrd = () => Math.max(0, ...[...albums.values(), ...groups.values()].map(x => x.ord || 0)) + 10;
async function putAlb(n, f) { const a = albums.get(n) || { name: n }; f(a); albums.set(n, a); await db.putAlbum(a); }
async function newGroup(name, ord) { const g = await db.putGroup({ name, ord: ord ?? nextOrd() }); groups.set(g.id, g); return g; }
async function createGroup() {
  const name = await dialog({ title: 'Nueva carpeta', input: { placeholder: 'Nombre de la carpeta' }, ok: 'Crear' });
  if (!name) return null;
  const g = await newGroup(name); render(true);
  return g;
}
const newAlbumGo = async () => { const n = await createAlbum(); if (n) { toast(`Álbum «${n}» creado`); location.hash = hashOf('album', n); } };
const newFolderGo = async () => { const g = await createGroup(); if (g) { toast(`Carpeta «${g.name}» creada`); location.hash = hashOf('group', String(g.id)); } };
function createPop(btn) { popover(btn, [{ icon: 'album', label: 'Nuevo álbum', fn: newAlbumGo }, { icon: 'folder', label: 'Nueva carpeta', fn: newFolderGo }]); }
const createMenu = createPop;
const SORTS = [['custom', 'Personalizado'], ['name', 'Nombre'], ['count', 'Número de elementos'], ['dateDesc', 'Fecha (más recientes primero)'], ['dateAsc', 'Fecha (más antiguos primero)']];
function sortMenu() {
  menuSheet(SORTS.map(([k, n]) => ({ icon: k === aset.sort ? 'check' : 'sort', label: n, fn: () => { aset.sort = k; savePrefs(); render(true); } })), 'Ordenar álbumes');
}
function albumsMenu() {
  menuSheet([
    { icon: 'folder', label: 'Nueva carpeta', fn: newFolderGo },
    { icon: 'sort', label: 'Ordenar', note: SORTS.find(x => x[0] === aset.sort)[1].replace(/ \(.*/, ''), fn: sortMenu },
    { icon: 'eye', label: 'Seleccionar álbumes para mostrar', fn: () => { location.hash = '#/albumvis'; } },
    { icon: 'album', label: aset.essential ? 'Ver todo' : 'Solo esenciales', fn: () => { aset.essential = !aset.essential; savePrefs(); render(true); } },
  ]);
}
async function groupMenu(g) {
  if (!g) return;
  menuSheet([
    { icon: 'edit', label: 'Cambiar nombre', fn: async () => { const n = await dialog({ title: 'Renombrar grupo', input: { value: g.name }, ok: 'Guardar' }); if (n) { g.name = n; await db.putGroup(g); render(true); } } },
    { icon: 'trash', label: 'Eliminar grupo', danger: true, fn: async () => { if (await removeTiles(['g:' + g.id])) location.hash = '#/albums'; } },
  ]);
}
async function renameAlbum(name) {
  const n = await dialog({ title: 'Cambiar nombre', input: { value: name }, ok: 'Guardar' });
  if (!n || n === name) return null;
  if (albumNames().has(n)) { toast('Ya existe un álbum con ese nombre'); return null; }
  const l = items.filter(i => i.album === name);
  l.forEach(i => { i.album = n; });
  await saveItems(l);
  const a = albums.get(name); albums.delete(name); await db.deleteAlbum(name);
  const na = { ...(a || {}), name: n }; albums.set(n, na); await db.putAlbum(na);
  return n;
}
// Elimina álbumes (sus fotos pasan a la papelera) y/o grupos (sus álbumes vuelven a la raíz).
async function removeTiles(keys) {
  const names = keys.filter(k => k[0] === 'a').map(k => k.slice(2)), gids = keys.filter(k => k[0] === 'g').map(k => +k.slice(2));
  const lists = names.map(n => live().filter(i => i.album === n)), cnt = lists.reduce((x, l) => x + l.length, 0);
  const msg = [cnt ? `${plural(cnt, 'elemento pasará', 'elementos pasarán')} a la papelera.` : '', gids.length ? 'Los álbumes de los grupos volverán a la raíz.' : ''].filter(Boolean).join(' ') || (names.length ? 'El álbum está vacío.' : '');
  if (!(await dialog({ title: gids.length && !names.length ? 'Eliminar grupo' : 'Eliminar', message: msg, ok: 'Eliminar', danger: true }))) return false;
  const t = Date.now(), moved = lists.flat();
  if (moved.length) { moved.forEach(i => { i.trashedAt = t; }); await saveItems(moved); }
  for (const n of names) { albums.delete(n); await db.deleteAlbum(n); }
  for (const id of gids) {
    for (const [n, a] of albums) if (a.group === id) { delete a.group; await db.putAlbum(a); }
    groups.delete(id); await db.deleteGroup(id);
  }
  return true;
}
async function setGroup(names, gid) {
  for (const n of names) await putAlb(n, a => { if (gid == null) delete a.group; else a.group = gid; delete a.ord; });
}
function moveToGroup(names) {
  return new Promise(res => {
    const rows = [{ icon: 'album', label: 'Sin grupo', fn: async () => { await setGroup(names, null); res(true); } },
      ...[...groups.values()].map(g => ({ icon: 'folder', label: g.name, fn: async () => { await setGroup(names, g.id); res(true); } })),
      { icon: 'plus', label: 'Grupo nuevo', fn: async () => {
        const name = await dialog({ title: 'Crear grupo', input: { placeholder: 'Nombre del grupo' }, ok: 'Crear' });
        if (!name) return res(false);
        const g = await newGroup(name); await setGroup(names, g.id); res(true);
      } }];
    menuSheet(rows, 'Mover a grupo', sh => { if (!sh.picked) res(false); });
  });
}
async function setHidden(names, on) {
  for (const n of names) await putAlb(n, a => { if (on) a.hidden = true; else delete a.hidden; });
}
function pickCover(name) {
  const l = live().filter(i => i.album === name).slice(0, 300);
  if (!l.length) return toast('El álbum no tiene fotos');
  const c = el('div', 'cover-grid', l.map(i => `<button data-id="${i.id}" aria-label="${esc(i.name)}"><img alt="" src="${thumbURL(i)}"></button>`).join(''));
  const s = sheet({ title: 'Elegir portada', content: c });
  c.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    await s.close(); await putAlb(name, a => { a.cover = pid(b.dataset.id); });
    render(true); toast('Portada actualizada');
  };
}
async function albumAction(k) {
  const keys = [...asel], names = keys.filter(x => x[0] === 'a').map(x => x.slice(2));
  if (k === 'rename') {
    const x = keys[0];
    if (x[0] === 'g') { const g = groups.get(+x.slice(2)), n = await dialog({ title: 'Renombrar grupo', input: { value: g.name }, ok: 'Guardar' }); if (!n) return; g.name = n; await db.putGroup(g); }
    else if (!(await renameAlbum(x.slice(2)))) return;
  } else if (k === 'trash') { if (!(await removeTiles(keys))) return; }
  else if (k === 'move') { if (!(await moveToGroup(names))) return; }
  else if (k === 'hide') { await setHidden(names, true); toast(plural(names.length, 'álbum oculto', 'álbumes ocultos'), { label: 'Deshacer', fn: async () => { await setHidden(names, false); render(true); } }); }
  else if (k === 'cover') { const n = names[0]; await exitSelect(); return pickCover(n); }
  await exitSelect(); render(true);
}
// Suelta álbumes/grupos arrastrados sobre una ficha (agrupar) o junto a ella (reordenar).
async function dropAlbums(keys, tk, zone) {
  if (zone === 'into') {
    const names = keys.map(k => k.slice(2));
    if (tk[0] === 'g') { await setGroup(names, +tk.slice(2)); toast(`Movido a «${groups.get(+tk.slice(2)).name}»`); }
    else {
      const other = tk.slice(2), name = await dialog({ title: 'Crear grupo', input: { placeholder: 'Nombre del grupo' }, ok: 'Crear' });
      if (!name) return;
      const g = await newGroup(name, (albums.get(other) || {}).ord);
      await setGroup([other, ...names], g.id);
    }
  } else {
    const gid = view.gid ?? null, order = tilesFor(gid).map(t => t.key).filter(k => !keys.includes(k));
    order.splice(order.indexOf(tk) + (zone === 'after' ? 1 : 0), 0, ...keys);
    for (let i = 0; i < order.length; i++) {
      const k = order[i], o = (i + 1) * 10;
      if (k[0] === 'g') { const g = groups.get(+k.slice(2)); g.ord = o; await db.putGroup(g); } else await putAlb(k.slice(2), a => { a.ord = o; });
    }
    if (aset.sort !== 'custom') { aset.sort = 'custom'; savePrefs(); toast('Orden personalizado'); }
  }
  if (selecting) await exitSelect();
  render(true);
}
function albumMenu(name, list) {
  menuSheet([
    { icon: 'edit', label: 'Cambiar nombre', fn: async () => { const n = await renameAlbum(name); if (n) location.replace(hashOf('album', n)); } },
    { icon: 'photo', label: 'Cambiar portada', fn: () => pickCover(name) },
    { icon: 'folder', label: 'Mover a grupo', fn: async () => { if (await moveToGroup([name])) render(true); } },
    { icon: 'eyeoff', label: 'Ocultar álbum', fn: async () => { await setHidden([name], true); toast('Álbum oculto', { label: 'Deshacer', fn: async () => { await setHidden([name], false); render(true); } }); location.hash = '#/albums'; } },
    { icon: 'trash', label: 'Eliminar álbum', danger: true, fn: async () => { if (await removeTiles(['a:' + name])) location.hash = '#/albums'; } },
  ]);
}

const A = {
  get inTrash() { return route().name === 'trash'; },
  async fav(it) { it.favorite = !it.favorite; await saveItems([it]); render(true); },
  async trash(it) {
    if (this.inTrash) { if (!(await confirmDelete([it]))) return false; return destroy([it]); }
    await trashItems([it]); return true;
  },
  async restore(it) { await restore([it]); },
  share: it => share([it]),
  save: it => saveFiles([it]),
  album: it => addToAlbum([it]),
  async cover(it) {
    const a = albums.get(it.album) || { name: it.album };
    a.cover = it.id; albums.set(a.name, a); await db.putAlbum(a);
    toast(`Portada de «${it.album}» actualizada`);
  },
  async rename(it) {
    const n = await dialog({ title: 'Cambiar nombre', input: { value: it.name }, ok: 'Guardar' });
    if (!n) return;
    it.name = n; await db.putItem(it); render(true);
  },
  details(it) {
    const rows = [['Nombre', it.name], ['Fecha', fmtDateTime(it.date)], ['Tamaño', fmtSize(it.dev ? it.size : it.blob.size)],
      ['Resolución', it.width ? `${it.width} × ${it.height} (${(it.width * it.height / 1e6).toFixed(1)} MP)` : 'Desconocida'],
      ['Tipo', (it.dev ? it.mime : it.blob.type) || '—'], ['Álbum', it.album || '—']];
    sheet({ title: 'Detalles', content: el('div', 'details', rows.map(r => `<div><span>${r[0]}</span><b>${esc(r[1])}</b></div>`).join('')) });
  },
  async edit(it, done) {
    if (isVideo(it)) return toast('No se pueden editar vídeos');
    let src = it.blob;
    if (it.dev) { try { src = await (await fetch(it.fullUrl)).blob(); } catch { return toast('No se pudo abrir la foto'); } }
    let openEditor;
    try { ({ openEditor } = await import('./editor.js')); } catch { return toast('Editor no disponible'); }
    // El editor es una entrada de historial propia: «atrás» = cancelar (con confirmación si hay cambios).
    let ed = null;
    const guard = pushOverlay(() => { if (ed) ed.abort(); }, () => !!(ed && ed.blocked()));
    ed = openEditor(src, {
      async onSave(blob) {
        dismiss(guard);
        const base = it.name.replace(/\.[a-z0-9]{2,4}$/i, '');
        if (it.dev) { // copia nueva en el dispositivo (MediaStore); aparecerá sola en la lista
          try { AB().saveFile(await bridgeStage(blob, base + ' (editado).' + (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg'))); toast('Copia editada guardada en el dispositivo'); } catch { toast('No se pudo guardar'); }
          return;
        }
        const m = await makeThumb(blob);
        const n = { blob, thumb: m.thumb, name: base + ' (editado)', date: Date.now(), album: it.album, width: m.width, height: m.height, favorite: false, trashedAt: null };
        await db.putItem(n); items.push(n); reindex(); render(true);
        toast('Copia editada guardada');
        done && done(n);
      },
      onCancel() { dismiss(guard); },
    });
  },
};

// ---------- menu, settings, import
function menu() {
  menuSheet([
    { icon: 'heart', label: 'Favoritos', fn: () => { location.hash = '#/fav'; } },
    { icon: 'trash', label: 'Papelera', note: trashed().length || '', fn: () => { location.hash = '#/trash'; } },
    { icon: 'play', label: 'Vídeos', fn: () => { location.hash = '#/videos'; } },
    { icon: 'tune', label: 'Ajustes', fn: settings },
    { icon: 'plus', label: 'Importar', fn: () => $('#file-input').click() },
  ]);
}
function applyTheme() {
  const t = ls.get('gal.theme') || 'system', r = document.documentElement;
  if (t === 'light' || t === 'dark') r.dataset.theme = t; else r.removeAttribute('data-theme');
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#000000' : '#f5f6f8';
  try { AB() && AB().setTheme(dark); } catch {}
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function settings() {
  const c = el('div', 'settings'), cur = ls.get('gal.theme') || 'system';
  c.innerHTML = `<div class="lbl">Tema</div><div class="seg">${[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, n]) => `<button data-t="${k}" class="${k === cur ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${DEV ? '' : `<button class="row" data-x="samples"><span class="ri">${icon('photo', 22)}</span><span class="rl">Añadir fotos de ejemplo</span></button>`}
    <p class="hint">Galería · ${plural(items.length, 'elemento', 'elementos')} guardados en este dispositivo</p>`;
  c.addEventListener('click', async e => {
    const t = e.target.closest('[data-t]');
    if (t) { ls.set('gal.theme', t.dataset.t); applyTheme(); c.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b === t)); }
    if (e.target.closest('[data-x]')) {
      s.close();
      await db.setMeta('seeded', 0); await seed(); await load(); render(true); toast('Fotos de ejemplo añadidas');
    }
  });
  const s = sheet({ title: 'Ajustes', content: c });
}
$('#tab-menu').onclick = menu;
$('#file-input').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const out = [];
  for (let i = 0; i < files.length; i++) {
    toast(`Importando ${i + 1} de ${files.length}…`);
    const f = files[i];
    const m = await makeThumb(f);
    out.push({ blob: f, thumb: m.thumb, duration: m.duration, name: f.name, date: f.lastModified || Date.now(), album: 'Cámara', width: m.width, height: m.height, favorite: false, trashedAt: null });
  }
  await db.putItems(out); items.push(...out); reindex(); render(true);
  toast(plural(out.length, 'elemento importado', 'elementos importados'));
});

// ---------- boot
let lastW = 0;
addEventListener('resize', () => { const w = scroll.clientWidth; if (w !== lastW) { lastW = w; if (VG) render(true); } });
addEventListener('hashchange', () => { if (location.hash !== lastKey) render(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && selecting) exitSelect(); });
document.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon, e.classList.contains('ti') ? 24 : 24); });
applyTheme();
// El host nativo llama a history.back(); si esto devuelve false (raíz sin nada abierto), sale de la app.
window.__galleryCanGoBack = () => overlayCount() > 0 || !['', '#', '#/', '#/images'].includes(location.hash);
(async function boot() {
  try {
    await seed(); await load();
    if (DEV) await refreshDevice();
  } catch (e) { console.error(e); }
  render();
  $('#boot').classList.add('gone');
  booted = true;
  const noDur = items.filter(i => !i.dev && isVideo(i) && i.duration == null);
  if (noDur.length) (async () => { for (const i of noDur) i.duration = await probeDuration(i.blob); await db.putItems(noDur); render(true); })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
