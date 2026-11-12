import { icon } from './icons.js';
import * as db from './db.js';
import { el, esc, norm, ls, dayKey, dayLabel, monthKey, monthLabel, fmtDateTime, fmtSize, isVideo, plural, thumbURL, dropThumbURL, makeThumb, fmtDur, probeDuration, bridgeStage } from './util.js';
import { pushOverlay, dismiss, overlayCount, sheet, menuSheet, dialog, toast } from './ui.js';
import { openViewer } from './viewer.js';

const $ = s => document.querySelector(s);
const app = $('#app'), scroll = $('#scroll'), body = $('#body');
const LEVELS = [3, 4, 7, 'm'];
const DAY = 864e5, PURGE_DAYS = 30;

let items = [], albums = new Map(), byId = new Map(), groups = new Map();
let aset = { sort: 'custom', cols: 3, essential: false };
const asel = new Set();
let level = Math.min(3, Math.max(0, +ls.get('gal.level') || 0));
let sel = new Set(), selecting = false, selEntry = null;
let view = { name: 'images', items: [] };
let query = '', lastKey = null;

// ---------- data
async function load() {
  items = await db.getItems();
  albums = new Map((await db.getAlbums()).map(a => [a.name, a]));
  groups = new Map((await db.getGroups()).map(g => [g.id, g]));
  aset = { sort: 'custom', cols: 3, essential: false, ...((await db.getMeta('albumPrefs')) || {}) };
  const old = items.filter(i => i.trashedAt && Date.now() - i.trashedAt > PURGE_DAYS * DAY);
  if (old.length) { await db.deleteItems(old.map(i => i.id)); const s = new Set(old.map(i => i.id)); items = items.filter(i => !s.has(i.id)); }
  reindex();
}
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
const ESSENTIAL = ['camara', 'capturas de pantalla', 'descargas'];
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
  if (await db.getMeta('seeded')) return;
  try {
    const { generateSamples } = await import('./samples.js');
    const s = await generateSamples(40), out = [];
    for (const x of s) {
      const t = await makeThumb(x.blob);
      out.push({ blob: x.blob, thumb: t.thumb, name: x.name, date: x.date, album: x.album, width: x.width || t.width, height: x.height || t.height, favorite: false, trashedAt: null });
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

function matches(it, toks) {
  const d = new Date(it.date);
  const hay = norm([it.name, it.album, d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }), dayLabel(it.date), it.favorite ? 'favorito' : '', isVideo(it) ? 'video' : 'foto imagen'].join(' '));
  return toks.every(t => hay.includes(t));
}

function buildView(r) {
  const n = r.name, v = { name: n, type: 'grid', parent: null, actions: [], items: [], sub: '' };
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
    Object.assign(v, { title: 'Recientes', items: autoList('recent'), parent: '#/albums', tab: 'albums', actions: [cols], empty: 'No hay elementos recientes' });
  } else if (n === 'stories') {
    Object.assign(v, { title: 'Historias', type: 'stories', tab: 'stories', actions: [search] });
  } else if (n === 'album') {
    const l = live().filter(i => i.album === r.arg);
    Object.assign(v, { title: r.arg, items: l, parent: grpOf(r.arg) != null ? hashOf('group', String(grpOf(r.arg))) : '#/albums', tab: 'albums', actions: [cols, { icon: 'more', label: 'Más', fn: () => albumMenu(r.arg, l) }], empty: 'Este álbum está vacío' });
  } else if (n === 'month') {
    const l = live().filter(i => monthKey(i.date) === r.arg);
    Object.assign(v, { title: l[0] ? monthLabel(l[0].date) : 'Historia', items: l, parent: '#/stories', tab: 'stories', actions: [cols] });
  } else if (n === 'fav') {
    Object.assign(v, { title: 'Favoritos', items: live().filter(i => i.favorite), parent: '#/', actions: [cols], empty: 'Aún no tienes favoritos' });
  } else if (n === 'videos') {
    Object.assign(v, { title: 'Vídeos', items: live().filter(isVideo), parent: '#/', actions: [cols], empty: 'No hay vídeos' });
  } else if (n === 'trash') {
    const l = trashed();
    Object.assign(v, { title: 'Papelera', items: l, parent: '#/', trash: true, sub: 'Los elementos se eliminan definitivamente tras 30 días', empty: 'La papelera está vacía', actions: [cols, { icon: 'more', label: 'Más', fn: () => menuSheet([{ icon: 'trash', label: 'Vaciar papelera', danger: true, fn: emptyTrash }]) }] });
  } else if (n === 'search') {
    const toks = norm(query).split(/\s+/).filter(Boolean);
    Object.assign(v, { title: 'Buscar', type: 'search', parent: '#/', items: toks.length ? live().filter(i => matches(i, toks)) : [], empty: toks.length ? 'Sin resultados' : 'Busca por nombre, álbum o mes' });
  } else {
    Object.assign(v, { name: 'images', title: 'Imágenes', tab: 'images', items: live(), actions: [search, cols], empty: 'No hay imágenes. Impórtalas desde el menú.' });
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
    const it = byId.get(+img.dataset.id); if (!it) return;
    img.onload = () => img.classList.add('ld');
    img.src = thumbURL(it);
  }), { root: scroll, rootMargin: '900px 0px' });
  root.querySelectorAll('img[data-id]:not([src])').forEach(i => io.observe(i));
}

function gridHTML(list, v) {
  if (!list.length) return `<div class="empty">${icon('photo', 48)}<p>${esc(v.empty || '')}</p></div>`;
  const L = LEVELS[level], cols = L === 'm' ? 7 : L, mon = L === 'm';
  const W = scroll.clientWidth || 390, cell = (W - (cols - 1) * 2) / cols;
  const groups = [];
  let k = null;
  for (const it of list) {
    const kk = v.trash ? 'x' : mon ? monthKey(it.date) : dayKey(it.date);
    if (kk !== k) { groups.push({ label: v.trash ? '' : mon ? monthLabel(it.date) : dayLabel(it.date), l: [] }); k = kk; }
    groups[groups.length - 1].l.push(it);
  }
  return groups.map(g => {
    const h = Math.ceil(g.l.length / cols) * (cell + 2) + (g.label ? 40 : 0);
    return `<section class="sec" style="contain-intrinsic-size:auto ${Math.round(h)}px">${g.label ? `<h3>${esc(g.label)}</h3>` : ''}<div class="grid" style="--cols:${cols}">${g.l.map(it => {
      const days = v.trash ? Math.max(0, Math.ceil(PURGE_DAYS - (Date.now() - it.trashedAt) / DAY)) : 0;
      return `<div class="cell${sel.has(it.id) ? ' sel' : ''}" data-id="${it.id}" role="button" aria-label="${esc(it.name)}"><img alt="" draggable="false" data-id="${it.id}">${isVideo(it) ? `<span class="vb">${icon('play', 14)}</span>` : ''}${it.favorite ? `<span class="fv">${icon('heart-fill', 14)}</span>` : ''}${v.trash ? `<span class="dl">${days} d</span>` : ''}<i class="ck">${icon('check', 15)}</i></div>`;
    }).join('')}</div></section>`;
  }).join('');
}
function fillGrid(container, list, v) { container.innerHTML = gridHTML(list, v); lazy(container); }

function render(keep) {
  const r = route(), key = location.hash;
  if (selecting && key !== lastKey) exitSelect();
  const sameKey = key === lastKey;
  const top = keep && sameKey ? scroll.scrollTop : 0;
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
  $('#tab-menu').classList.toggle('on', ['fav', 'trash', 'videos'].includes(v.name));
  const extra = $('#lt-extra'); extra.innerHTML = '';
  if (v.type === 'search') {
    extra.innerHTML = `<div class="searchbox">${icon('search', 20)}<input type="search" placeholder="Buscar en la galería" value="${esc(query)}" autocomplete="off"></div>`;
    const inp = extra.querySelector('input'); let t;
    inp.addEventListener('input', () => {
      query = inp.value; clearTimeout(t);
      t = setTimeout(() => { view = buildView(route()); fillGrid(body, view.items, view); }, 120);
    });
    setTimeout(() => inp.focus(), 50);
  }
  if (v.type === 'albums' && v.gid == null) extra.innerHTML = `<div class="seg ess">${[[0, 'Ver todo'], [1, 'Solo esenciales']].map(([k, n]) => `<button data-ess="${k}" class="${!!k === aset.essential ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (v.type === 'albums') body.innerHTML = albumsHTML(v.gid);
  else if (v.type === 'albumvis') body.innerHTML = visHTML();
  else if (v.type === 'stories') body.innerHTML = storiesHTML();
  else { body.innerHTML = ''; fillGrid(body, v.items, v); }
  if (v.type !== 'grid' && v.type !== 'search') lazy(body);
  if (selecting) { buildActionBar(); updateSel(); }
  scroll.scrollTop = top;
  onScroll();
}

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
function storiesHTML() {
  const g = new Map();
  live().forEach(i => { const k = monthKey(i.date); if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  if (!g.size) return `<div class="empty">${icon('star', 48)}<p>Aún no hay historias</p></div>`;
  return `<div class="stories">${[...g].map(([k, l]) => `<a class="story" href="${hashOf('month', k)}"><img alt="" draggable="false" data-id="${l[Math.floor(l.length / 2)].id}"><div class="sc"><b>${esc(monthLabel(l[0].date))}</b><span>${plural(l.length, 'elemento', 'elementos')}</span></div></a>`).join('')}</div>`;
}

// ---------- collapsing header
let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const p = Math.min(1, scroll.scrollTop / 70), lt = $('#lt');
    lt.style.opacity = 1 - p;
    lt.style.transform = `translateY(${-p * 10}px) scale(${1 - p * 0.18})`;
    $('#tb-title').style.opacity = p;
    $('#topbar').classList.toggle('scrolled', p >= 1);
  });
}
scroll.addEventListener('scroll', onScroll, { passive: true });
$('#tb-actions').addEventListener('click', e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const a = view.actions[+b.dataset.i];
  if (a.cols) setLevel((level + 1) % LEVELS.length); else a.fn();
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
  if (id) {
    const nc = scroll.querySelector(`.cell[data-id="${id}"]`);
    if (nc) scroll.scrollTop += nc.getBoundingClientRect().top - scroll.getBoundingClientRect().top - off;
  }
}
let wheelT = 0;
scroll.addEventListener('wheel', e => {
  if (!e.ctrlKey || Date.now() - wheelT < 250 || (view.type !== 'grid' && view.type !== 'search')) return;
  e.preventDefault(); wheelT = Date.now();
  setLevel(level + (e.deltaY < 0 ? -1 : 1));
}, { passive: false });

// ---------- selection & grid gestures
const idOf = c => +c.dataset.id;
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
  selecting = false; sel.clear();
  app.classList.remove('selecting');
  scroll.querySelectorAll('.cell.sel').forEach(c => c.classList.remove('sel'));
}
function exitSelect() { return selecting ? dismiss(selEntry) : Promise.resolve(); }
function selItems() { return [...sel].map(i => byId.get(i)).filter(Boolean); }
function updateSel() {
  const n = sel.size;
  $('#sel-count').textContent = n ? (n === 1 ? '1 seleccionado' : n + ' seleccionados') : 'Seleccionar elementos';
  $('#sel-all').classList.toggle('on', n > 0 && n === view.items.length);
  $('#actionbar').classList.toggle('empty', n === 0);
}
function buildActionBar() {
  const T = view.trash;
  const rows = T ? [['restore', 'restore', 'Restaurar'], ['trash', 'trash', 'Eliminar']]
    : [['share', 'share', 'Compartir'], ['trash', 'trash', 'Eliminar'], ['album', 'plus', 'Álbum'], ['fav', 'heart', 'Favorito']];
  $('#actionbar').innerHTML = rows.map(r => `<button data-k="${r[0]}">${icon(r[1], 24)}<span>${r[2]}</span></button>`).join('');
}
$('#actionbar').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !sel.size) return;
  const l = selItems(), k = b.dataset.k;
  if (k === 'share') { await share(l); }
  else if (k === 'trash') { if (view.trash) { if (await confirmDelete(l)) { await exitSelect(); await destroy(l); } } else { await exitSelect(); await trashItems(l); } }
  else if (k === 'restore') { await exitSelect(); await restore(l); }
  else if (k === 'album') { if (await addToAlbum(l)) await exitSelect(); }
  else if (k === 'fav') { const on = !l.every(i => i.favorite); l.forEach(i => i.favorite = on); await db.putItems(l); toast(on ? 'Añadido a favoritos' : 'Quitado de favoritos'); await exitSelect(); render(true); }
});
$('#sel-close').onclick = () => exitSelect();
$('#sel-all').onclick = () => {
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

// ---------- actions
async function trashItems(list) {
  const t = Date.now();
  list.forEach(i => { i.trashedAt = t; });
  await db.putItems(list);
  render(true);
  toast(list.length === 1 ? 'Movido a la papelera' : `${list.length} elementos movidos a la papelera`, { label: 'Deshacer', fn: () => restore(list, true) });
}
async function restore(list, quiet) {
  list.forEach(i => { i.trashedAt = null; });
  await db.putItems(list);
  render(true);
  if (!quiet) toast(list.length === 1 ? 'Elemento restaurado' : `${list.length} elementos restaurados`);
}
const confirmDelete = l => dialog({ title: 'Eliminar definitivamente', message: `${plural(l.length, 'elemento se eliminará', 'elementos se eliminarán')} para siempre. Esta acción no se puede deshacer.`, ok: 'Eliminar', danger: true });
async function destroy(list) {
  const ids = new Set(list.map(i => i.id));
  await db.deleteItems([...ids]);
  items = items.filter(i => !ids.has(i.id));
  ids.forEach(dropThumbURL);
  reindex(); render(true);
  toast('Eliminado definitivamente');
}
async function emptyTrash() {
  const l = trashed(); if (!l.length) return toast('La papelera está vacía');
  if (await confirmDelete(l)) destroy(l);
}
function fileName(it) {
  const ext = (it.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split('+')[0];
  return /\.[a-z0-9]{2,4}$/i.test(it.name) ? it.name : it.name + '.' + ext;
}
async function share(list) {
  const files = list.map(i => new File([i.blob], fileName(i), { type: i.blob.type }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  files.forEach((f, k) => setTimeout(() => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, k * 250));
  toast('Compartir no disponible: descargando');
}
async function createAlbum() {
  const name = await dialog({ title: 'Crear álbum', input: { placeholder: 'Nombre del álbum' }, ok: 'Crear' });
  if (!name) return null;
  if (!albumNames().has(name)) { const a = { name }; albums.set(name, a); await db.putAlbum(a); }
  render(true);
  return name;
}
function addToAlbum(list) {
  return new Promise(res => {
    let mode = 'move', done = false;
    const c = el('div');
    const names = [...albumNames()];
    c.innerHTML = `<div class="seg"><button data-m="move" class="on">Mover</button><button data-m="copy">Copiar</button></div><div class="rows"><button class="row" data-n="">${'<span class="ri">' + icon('plus', 22) + '</span>'}<span class="rl">Álbum nuevo</span></button>${names.map(([n, l], i) => `<button class="row" data-i="${i}"><span class="ri alb-t">${l[0] ? `<img alt="" src="${thumbURL(l[0])}">` : icon('album', 22)}</span><span class="rl">${esc(n)}</span><span class="rn">${l.length}</span></button>`).join('')}</div>`;
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
  if (mode === 'copy') {
    const cp = list.map(i => ({ ...i, id: undefined, album: name, trashedAt: null }));
    await db.putItems(cp); items.push(...cp); reindex();
  } else { list.forEach(i => { i.album = name; }); await db.putItems(list); }
  render(true);
  toast(`${mode === 'copy' ? 'Copiado' : 'Movido'} a «${name}»`);
}
function albumMenu(name, list) {
  menuSheet([
    { icon: 'edit', label: 'Cambiar nombre', fn: async () => {
      const n = await dialog({ title: 'Cambiar nombre', input: { value: name }, ok: 'Guardar' });
      if (!n || n === name) return;
      const l = items.filter(i => i.album === name);
      l.forEach(i => { i.album = n; });
      await db.putItems(l);
      const a = albums.get(name); albums.delete(name); await db.deleteAlbum(name);
      const na = { ...(a || {}), name: n }; albums.set(n, na); await db.putAlbum(na);
      location.replace(hashOf('album', n));
    } },
    { icon: 'trash', label: 'Eliminar álbum', danger: true, fn: async () => {
      const ok = await dialog({ title: 'Eliminar álbum', message: list.length ? `Los ${list.length} elementos pasarán a la papelera.` : 'El álbum está vacío.', ok: 'Eliminar', danger: true });
      if (!ok) return;
      if (list.length) { const t = Date.now(); list.forEach(i => { i.trashedAt = t; }); await db.putItems(list); }
      albums.delete(name); await db.deleteAlbum(name);
      location.hash = '#/albums';
    } },
  ]);
}

const A = {
  get inTrash() { return route().name === 'trash'; },
  async fav(it) { it.favorite = !it.favorite; await db.putItem(it); render(true); },
  async trash(it) {
    if (this.inTrash) { if (!(await confirmDelete([it]))) return false; await destroy([it]); return true; }
    await trashItems([it]); return true;
  },
  async restore(it) { await restore([it]); },
  share: it => share([it]),
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
    const rows = [['Nombre', it.name], ['Fecha', fmtDateTime(it.date)], ['Tamaño', fmtSize(it.blob.size)],
      ['Resolución', it.width ? `${it.width} × ${it.height} (${(it.width * it.height / 1e6).toFixed(1)} MP)` : 'Desconocida'],
      ['Tipo', it.blob.type || '—'], ['Álbum', it.album || '—']];
    sheet({ title: 'Detalles', content: el('div', 'details', rows.map(r => `<div><span>${r[0]}</span><b>${esc(r[1])}</b></div>`).join('')) });
  },
  async edit(it, done) {
    if (isVideo(it)) return toast('No se pueden editar vídeos');
    let openEditor;
    try { ({ openEditor } = await import('./editor.js')); } catch { return toast('Editor no disponible'); }
    // El editor es una entrada de historial propia: «atrás» = cancelar (con confirmación si hay cambios).
    let ed = null;
    const guard = pushOverlay(() => { if (ed) ed.abort(); }, () => !!(ed && ed.blocked()));
    ed = openEditor(it.blob, {
      async onSave(blob) {
        dismiss(guard);
        const m = await makeThumb(blob);
        const base = it.name.replace(/\.[a-z0-9]{2,4}$/i, '');
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
function theme(t) {
  const r = document.documentElement;
  if (t === 'light' || t === 'dark') r.dataset.theme = t; else r.removeAttribute('data-theme');
}
function settings() {
  const c = el('div', 'settings'), cur = ls.get('gal.theme') || 'system';
  c.innerHTML = `<div class="lbl">Tema</div><div class="seg">${[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, n]) => `<button data-t="${k}" class="${k === cur ? 'on' : ''}">${n}</button>`).join('')}</div>
    <button class="row" data-x="samples"><span class="ri">${icon('photo', 22)}</span><span class="rl">Añadir fotos de ejemplo</span></button>
    <p class="hint">Galería · ${plural(items.length, 'elemento', 'elementos')} guardados en este dispositivo</p>`;
  c.addEventListener('click', async e => {
    const t = e.target.closest('[data-t]');
    if (t) { ls.set('gal.theme', t.dataset.t); theme(t.dataset.t); c.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b === t)); }
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
    out.push({ blob: f, thumb: m.thumb, name: f.name, date: f.lastModified || Date.now(), album: 'Cámara', width: m.width, height: m.height, favorite: false, trashedAt: null });
  }
  await db.putItems(out); items.push(...out); reindex(); render(true);
  toast(plural(out.length, 'elemento importado', 'elementos importados'));
});

// ---------- boot
addEventListener('hashchange', () => { if (location.hash !== lastKey) render(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && selecting) exitSelect(); });
document.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon, e.classList.contains('ti') ? 24 : 24); });
theme(ls.get('gal.theme') || 'system');
(async function boot() {
  try {
    await seed(); await load();
  } catch (e) { console.error(e); }
  render();
  $('#boot').classList.add('gone');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
