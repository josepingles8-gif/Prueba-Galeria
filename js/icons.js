// Iconos de línea originales en SVG inline (viewBox 24x24).
// Cada icono usa stroke="currentColor", así que hereda el color del texto.

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  more: '<circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  'heart-fill': '<path fill="currentColor" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  edit: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="M14 6l3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.8" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path fill="currentColor" d="M8 5.5v13l11-6.5z"/>',
  album: '<rect x="3" y="4" width="14" height="14" rx="2"/><path d="M7 20h12a2 2 0 0 0 2-2V8"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  tune: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  flip: '<path d="M12 3v18"/><path d="M4 7l5 5-5 5z"/><path d="M20 7l-5 5 5 5z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.6 1-5.8-4.2-4.1 5.8-.8z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  sort: '<path d="M4 7h10M4 12h7M4 17h4M17 6v12M14 15l3 3 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

// Icono de reserva: círculo vacío.
const FALLBACK = '<circle cx="12" cy="12" r="9"/>';

/**
 * Devuelve el SVG (string) del icono indicado.
 * @param {string} name  Nombre del icono (p. ej. "heart-fill").
 * @param {number} size  Tamaño en píxeles (ancho y alto).
 * @returns {string}
 */
export function icon(name, size = 24) {
  const body = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : FALLBACK;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
}
