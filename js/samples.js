// Generador de fotos de ejemplo (sin dependencias).
// Dibuja degradados y formas abstractas en un canvas y las exporta como JPEG.

const ALBUMS = ["Cámara", "Cámara", "Cámara", "Capturas de pantalla", "Descargas", "WhatsApp"];
const SIZES = [
  [1200, 900],
  [900, 1200],
  [1200, 1200],
  [1600, 900],
  [900, 1600],
  [1200, 800],
];
const DAY = 24 * 60 * 60 * 1000;
const MONTHS_BACK_MS = 540 * DAY; // ~18 meses
const BASE_SEED = 20261112;

/** PRNG determinista (mulberry32). Devuelve números en [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, "0");

function formatName(d) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`
  );
}

const hsla = (h, s, l, a = 1) => `hsla(${Math.round(h) % 360},${s}%,${l}%,${a})`;

function drawBackground(ctx, w, h, rnd, hue) {
  const g = ctx.createLinearGradient(0, 0, w * (0.3 + rnd() * 0.4), h);
  g.addColorStop(0, hsla(hue, 70, 75));
  g.addColorStop(1, hsla(hue + 40 + rnd() * 60, 75, 55));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawSun(ctx, w, h, rnd, hue) {
  const r = Math.min(w, h) * (0.07 + rnd() * 0.07);
  const x = w * (0.2 + rnd() * 0.6);
  const y = h * (0.15 + rnd() * 0.2);
  const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 3.2);
  glow.addColorStop(0, hsla(hue + 30, 100, 88, 0.7));
  glow.addColorStop(1, hsla(hue + 30, 100, 88, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hsla(hue + 25, 100, 92, 0.95);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawMountains(ctx, w, h, rnd, hue) {
  const layers = 3;
  for (let i = 0; i < layers; i++) {
    const baseY = h * (0.5 + i * 0.12);
    const peak = h * (0.12 + rnd() * 0.14);
    const steps = 4 + Math.floor(rnd() * 4);
    ctx.fillStyle = hsla(hue + 180 + i * 25, 45 - i * 8, 38 + i * 12, 0.9);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, baseY);
    for (let s = 1; s <= steps; s++) {
      const x = (w / steps) * s;
      const y = baseY - rnd() * peak;
      ctx.lineTo(x, s === steps ? baseY : y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
}

function drawWaves(ctx, w, h, rnd, hue) {
  const bands = 2;
  for (let b = 0; b < bands; b++) {
    const baseY = h * (0.78 + b * 0.08);
    const amp = h * (0.02 + rnd() * 0.03);
    const freq = (Math.PI * 2) / (w * (0.4 + rnd() * 0.6));
    const phase = rnd() * Math.PI * 2;
    ctx.fillStyle = hsla(hue + 200 + b * 30, 60, 45 + b * 10, 0.55);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) {
      ctx.lineTo(x, baseY + Math.sin(x * freq + phase) * amp);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBlobs(ctx, w, h, rnd, hue) {
  const count = 2 + Math.floor(rnd() * 3);
  for (let k = 0; k < count; k++) {
    const cx = w * (0.1 + rnd() * 0.8);
    const cy = h * (0.1 + rnd() * 0.7);
    const r = Math.min(w, h) * (0.08 + rnd() * 0.14);
    const pts = [];
    const n = 7;
    for (let p = 0; p < n; p++) {
      const ang = (p / n) * Math.PI * 2;
      const rad = r * (0.7 + rnd() * 0.6);
      pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
    }
    // Curva cerrada suave: los puntos medios son los extremos de cuadráticas.
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(pts[n - 1], pts[0]);
    ctx.fillStyle = hsla(hue + 120 + k * 50, 85, 60, 0.35 + rnd() * 0.25);
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    for (let p = 0; p < n; p++) {
      const m = mid(pts[p], pts[(p + 1) % n]);
      ctx.quadraticCurveTo(pts[p][0], pts[p][1], m[0], m[1]);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawPicture(ctx, w, h, seed) {
  const rnd = mulberry32(seed);
  const hue = rnd() * 360;
  drawBackground(ctx, w, h, rnd, hue);
  drawSun(ctx, w, h, rnd, hue);
  drawBlobs(ctx, w, h, rnd, hue);
  drawMountains(ctx, w, h, rnd, hue);
  drawWaves(ctx, w, h, rnd, hue);
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo generar el JPEG"))),
      "image/jpeg",
      0.85
    );
  });
}

/**
 * Genera fotos de ejemplo.
 * @param {number} n  Número de imágenes (por defecto 40).
 * @returns {Promise<Array<{blob: Blob, name: string, date: number, album: string, width: number, height: number}>>}
 */
export async function generateSamples(n = 40) {
  const rnd = mulberry32(BASE_SEED);
  const now = Date.now();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const todayStart = startToday.getTime();

  // Fechas: algunas de hoy, algunas de ayer y el resto repartidas ~18 meses.
  const dates = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (i < 4) {
      t = todayStart + rnd() * Math.max(now - todayStart, 1);
    } else if (i < 8) {
      t = todayStart - DAY + rnd() * DAY;
    } else {
      t = now - rnd() * MONTHS_BACK_MS;
    }
    dates.push(Math.floor(t));
  }
  dates.sort((a, b) => b - a);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const usedNames = new Set();
  const items = [];

  for (let i = 0; i < n; i++) {
    const rnd2 = mulberry32(BASE_SEED + 1 + i * 7919);
    const [width, height] = SIZES[Math.floor(rnd2() * SIZES.length)];
    canvas.width = width;
    canvas.height = height;
    drawPicture(ctx, width, height, BASE_SEED + 1000 + i * 31);

    const blob = await canvasToJpeg(canvas);
    const date = new Date(dates[i]);

    let name = formatName(date);
    if (usedNames.has(name)) {
      name = name.replace(/\.jpg$/, `_${i}.jpg`);
    }
    usedNames.add(name);

    items.push({
      blob,
      name,
      date: dates[i],
      album: ALBUMS[Math.floor(rnd2() * ALBUMS.length)],
      width,
      height,
    });
  }

  return items;
}
