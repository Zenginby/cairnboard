// Scene images for the Cam theme: a dithered pixel highland horizon with a cairn, dependency-free (node:zlib).
// Writes src/styles/scene/cam-<mode>.png (the 720x540 base) and the layers glass.css moves over it:
// cam-<mode>-clouds-far.png, -clouds-near.png and -mist.png (strips that tile sideways) and -twinkle-a.png,
// -twinkle-b.png (stars and lake glints that take turns). Layer pixels are fully opaque or fully transparent.
// Run with `npm run design:scene`; test/glass-contrast.test.mjs checks the glass tokens against every pixel color.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDTH = 720;
const HEIGHT = 540;

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function relLuminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ditherRamp(t, palette, x, y) {
  const scaled = clamp01(t) * (palette.length - 1);
  const idx = Math.floor(scaled);
  if (idx >= palette.length - 1) return palette[palette.length - 1];
  const frac = scaled - idx;
  const threshold = (BAYER_4[y & 3][x & 3] + 0.5) / 16;
  return frac > threshold ? palette[idx + 1] : palette[idx];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function encodePng(width, height, buffer, channels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 1;
    const rowOff = y * width * channels;
    const outOff = y * stride + 1;
    for (let x = 0; x < width * channels; x++) {
      const left = x >= channels ? buffer[rowOff + x - channels] : 0;
      raw[outOff + x] = (buffer[rowOff + x] - left) & 0xff;
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Strips that glass.css positions over the base; keep these in step with the --scene-* numbers there.
const CLOUD_TOP = 88; // Clouds stay below the header and board toolbar, which sit on calm sky.
const CLOUD_HEIGHT = 76;
const MIST_TOP = 228;
const MIST_HEIGHT = 40;

const bayer = (x, y) => (BAYER_4[y & 3][x & 3] + 0.5) / 16;
// Sideways distance on a strip that repeats every WIDTH pixels.
const wrapDx = (dx) => dx - WIDTH * Math.round(dx / WIDTH);

function buildCloudClusters(rand, anchors) {
  const clusters = [];
  for (const a of anchors) {
    for (let i = 0; i < a.count; i++) {
      const ox = (rand() - 0.5) * 44 * a.scale;
      const oy = (rand() - 0.5) * 14 * a.scale + Math.abs(ox) * 0.14;
      const rx = (15 + rand() * 14) * a.scale;
      const ry = (5.5 + rand() * 5) * a.scale;
      clusters.push({ x: a.cx + ox, y: a.cy + oy, rx, ry });
    }
  }
  return clusters;
}

function cloudDensity(x, y, clusters) {
  let maxD = 0;
  for (const c of clusters) {
    const dx = wrapDx(x - c.x) / c.rx;
    const dy = (y - c.y) / c.ry;
    const dyAdj = dy > 0 ? dy * 1.45 : dy;
    const d = 1 - (dx * dx + dyAdj * dyAdj);
    if (d > maxD) maxD = d;
  }
  return clamp01(maxD);
}

// A transparent RGBA layer; set() makes one pixel opaque.
function makeLayer(top, height) {
  const data = Buffer.alloc(WIDTH * height * 4);
  return {
    top,
    height,
    data,
    set(x, y, [r, g, b]) {
      const row = y - top;
      if (x < 0 || x >= WIDTH || row < 0 || row >= height) return;
      data.set([r, g, b, 255], (row * WIDTH + x) * 4);
    },
  };
}

// Height of a treeline above its ridge at every x: pines are stepped triangles.
function pineProfile(rand, groups) {
  const profile = new Float64Array(WIDTH);
  for (const { from, to, count, minH, maxH } of groups) {
    for (let i = 0; i < count; i++) {
      const cx = Math.round(from + rand() * (to - from));
      const h = Math.round(minH + rand() * (maxH - minH));
      const hw = Math.max(1, Math.round(h * 0.34));
      for (let dx = -hw; dx <= hw; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= WIDTH) continue;
        const rise = h - Math.floor((Math.abs(dx) * h) / (hw + 1));
        if (rise > profile[x]) profile[x] = rise;
      }
    }
  }
  return profile;
}

// Stacked stones, widest first, as a map of "x,y" to color.
function cairnPixels(centerX, baseY, stones, dark, lit) {
  const pixels = new Map();
  let curY = baseY;
  for (const { hw, h, xs } of stones) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = -hw; dx <= hw; dx++) {
        if (dy === h - 1 && Math.abs(dx) === hw && hw >= 3) continue;
        if (dy === 0 && Math.abs(dx) === hw && hw >= 5) continue;
        const isTopRim = dy === h - 1 && dx <= Math.floor(hw * 0.3);
        const isGlint = h >= 4 && dy === h - 2 && dx === -hw + 1;
        pixels.set(`${centerX + xs + dx},${curY - dy}`, isTopRim || isGlint ? lit : dark);
      }
    }
    curY -= h;
  }
  return pixels;
}

function generateScene(mode, seed) {
  const isDark = mode === 'dark';
  const rng = (n) => mulberry32(seed + n);

  const skyRamp = (
    isDark
      ? ['#0a101b', '#0e1626', '#142035', '#1b2a44', '#233554']
      : ['#c6d5e6', '#d0ddeb', '#dae4ef', '#e4e8ec', '#edeae2']
  ).map(hexToRgb);

  const cloudRamp = (
    isDark
      ? ['#1d2c44', '#273a58', '#334a6e', '#3f5980']
      : ['#dfe5ec', '#e9ecea', '#f2efe7', '#f7f3ea']
  ).map(hexToRgb);

  const valleyRamp = (
    isDark
      ? ['#0a101c', '#0e1626', '#131e32', '#0d1524', '#0a101c']
      : ['#93a6bb', '#9eb0c4', '#aabbd0', '#b7c6d9', '#a1b3c7']
  ).map(hexToRgb);

  // The lake mirrors the ridge at its far shore, then the sky.
  const lakeRamp = (
    isDark
      ? ['#0f1827', '#152033', '#1b2a44', '#142035']
      : ['#a7b8ca', '#b7c6d9', '#c6d5e6', '#bac9d8']
  ).map(hexToRgb);

  const ridgeFarColor = hexToRgb(isDark ? '#152033' : '#bac9d8');
  const ridgeMidColor = hexToRgb(isDark ? '#0f1827' : '#a7b8ca');
  const ridgeNearColor = hexToRgb(isDark ? '#0a101c' : '#93a6bb');
  const cairnDark = hexToRgb(isDark ? '#070b13' : '#7b8fa6');
  const cairnLit = hexToRgb(isDark ? '#2a3d5a' : '#bccad9');
  const starColor = hexToRgb(isDark ? '#4d6282' : '#f7f3ea');
  // Moon at night, a pale sun by day; both stay inside the luminance range of the rest of the scene.
  const discColor = hexToRgb(isDark ? '#4d6282' : '#f7f3ea');
  const discShade = hexToRgb(isDark ? '#3f5980' : '#f2efe7');
  const haloColor = hexToRgb(isDark ? '#233554' : '#edeae2');
  const glintColor = hexToRgb(isDark ? '#334a6e' : '#e4e8ec');
  const mistColor = hexToRgb(isDark ? '#1b2a44' : '#dae4ef');
  const tuftColor = hexToRgb(isDark ? '#131e32' : '#93a6bb');

  const stars = new Set();
  if (isDark) {
    const rand = rng(1);
    for (let i = 0; i < 128; i++) {
      stars.add(`${Math.floor(rand() * WIDTH)},${6 + Math.floor(rand() * 82)}`);
    }
  }

  // Horizon ridges positioned in mid-upper screen so visible between Hero/Project/Board columns
  const ridgeFarY = (x) =>
    178 + Math.sin(x * 0.019 + 0.4) * 9 + Math.cos(x * 0.043) * 4;
  const ridgeMidY = (x) =>
    196 + Math.sin(x * 0.015 + 2.1) * 10 + Math.sin(x * 0.052) * 3.5;
  const ridgeNearY = (x) =>
    216 + Math.sin(x * 0.017 + 4.0) * 8 + Math.cos(x * 0.038 + 1.2) * 4;
  // Lake between the near ridge and the foreground shore
  const lakeTopY = (x) => 246 + Math.sin(x * 0.021 + 0.7) * 2.5;
  const shoreY = (x) =>
    322 + Math.sin(x * 0.014 + 1.1) * 9 + Math.cos(x * 0.032) * 4;
  // Lower valley mist ridges (subtle texture behind lower cards on Home & Board)
  const valleyLowY = (x) =>
    420 + Math.sin(x * 0.016 + 3.2) * 12 + Math.sin(x * 0.029) * 4;

  const midPines = pineProfile(rng(2), [
    { from: 20, to: 92, count: 14, minH: 4, maxH: 8 },
    { from: 168, to: 232, count: 11, minH: 4, maxH: 7 },
    { from: 352, to: 398, count: 8, minH: 4, maxH: 7 },
    { from: 470, to: 556, count: 15, minH: 4, maxH: 8 },
    { from: 640, to: 704, count: 11, minH: 4, maxH: 7 },
  ]);
  const nearPines = pineProfile(rng(3), [
    { from: 0, to: 58, count: 9, minH: 7, maxH: 13 },
    { from: 120, to: 196, count: 12, minH: 6, maxH: 12 },
    { from: 286, to: 344, count: 9, minH: 7, maxH: 12 },
    { from: 500, to: 586, count: 13, minH: 6, maxH: 13 },
    { from: 668, to: 719, count: 8, minH: 7, maxH: 12 },
  ]);
  const shorePines = pineProfile(rng(4), [
    { from: 0, to: 96, count: 11, minH: 10, maxH: 20 },
    { from: 214, to: 300, count: 9, minH: 9, maxH: 17 },
    { from: 452, to: 540, count: 9, minH: 9, maxH: 18 },
    { from: 628, to: 719, count: 11, minH: 10, maxH: 20 },
  ]);
  // The sun or moon and the cairn stand toward the sides: the middle of a wide screen is covered by the page.
  // Boulders beside the cairn
  for (const [cx, h, hw] of [[628, 4, 4], [668, 3, 3], [675, 2, 2], [92, 3, 3], [398, 4, 4], [407, 2, 2]]) {
    for (let dx = -hw; dx <= hw; dx++) {
      const rise = Math.abs(dx) === hw ? h - 1 : h;
      if (rise > nearPines[cx + dx]) nearPines[cx + dx] = rise;
    }
  }

  // The cairn stands on the near ridge; a smaller one marks the path on the ridge behind.
  const cairnX = 648;
  const cairn = cairnPixels(cairnX, Math.floor(ridgeNearY(cairnX)) + 1, [
    { hw: 11, h: 5, xs: 0 },
    { hw: 9, h: 4, xs: -1 },
    { hw: 7, h: 4, xs: 1 },
    { hw: 6, h: 3, xs: 0 },
    { hw: 4, h: 3, xs: -1 },
    { hw: 3, h: 2, xs: 1 },
    { hw: 2, h: 2, xs: 0 },
  ], cairnDark, cairnLit);
  const farCairnX = 590;
  const farCairn = cairnPixels(farCairnX, Math.floor(ridgeMidY(farCairnX)), [
    { hw: 4, h: 2, xs: 0 },
    { hw: 3, h: 2, xs: -1 },
    { hw: 2, h: 2, xs: 1 },
    { hw: 1, h: 1, xs: 0 },
  ], cairnDark, cairnLit);

  const disc = { x: 62, y: 112, r: 9 };
  const tufts = new Set();
  {
    const rand = rng(5);
    for (let i = 0; i < 180; i++) {
      const tx = 2 + Math.floor(rand() * (WIDTH - 4));
      const ty = 350 + Math.floor(rand() * (HEIGHT - 356));
      tufts.add(`${tx - 1},${ty}`).add(`${tx},${ty - 1}`).add(`${tx + 1},${ty}`);
      if (rand() > 0.5) tufts.add(`${tx},${ty - 2}`);
    }
  }

  const inLake = (x, y) => y >= lakeTopY(x) && y < shoreY(x) - shorePines[x];

  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const skyT = y / 196;

    for (let x = 0; x < WIDTH; x++) {
      const thresh = bayer(x, y);
      let color = ditherRamp(skyT, skyRamp, x, y);

      if (stars.has(`${x},${y}`)) color = starColor;

      const discD = Math.hypot(x - disc.x, y - disc.y);
      if (discD <= disc.r) {
        const crater = Math.hypot(x - disc.x - 3, y - disc.y + 2) < 2.4
          || Math.hypot(x - disc.x + 3, y - disc.y - 3) < 1.8;
        color = crater ? discShade : discColor;
      } else if (discD <= disc.r + 5 && (disc.r + 5 - discD) / 5 > thresh) {
        color = haloColor;
      }

      const yFar = ridgeFarY(x);
      if (y >= yFar && clamp01((y - yFar) / 12) > thresh * 0.55) color = ridgeFarColor;

      const yMid = ridgeMidY(x);
      if (y >= yMid - midPines[x] && (midPines[x] > 0 || clamp01((y - yMid) / 6) > thresh * 0.45)) {
        color = ridgeMidColor;
      }
      color = farCairn.get(`${x},${y}`) ?? color;

      const yNear = ridgeNearY(x);
      if (y >= yNear - nearPines[x] && (nearPines[x] > 0 || clamp01((y - yNear) / 5) > thresh * 0.4)) {
        color = ridgeNearColor;
      }
      color = cairn.get(`${x},${y}`) ?? color;

      const yLake = lakeTopY(x);
      const yShore = shoreY(x);
      if (y >= yShore - shorePines[x]) {
        // Foreground shore and valley: darkest at the waterline, then soft dither bands down to y=540
        const vt = clamp01((y - 235) / (HEIGHT - 1 - 235));
        const rim = -0.34 * clamp01(1 - (y - yShore) / 16);
        const wave = y >= valleyLowY(x) && y < valleyLowY(x) + 38 ? -0.10 : 0;
        color = y < yShore ? valleyRamp[0] : ditherRamp(clamp01(vt + rim + wave), valleyRamp, x, y);
        if (y >= yShore + 6 && tufts.has(`${x},${y}`)) color = tuftColor;
      } else if (y >= yLake) {
        const lt = clamp01((y - yLake) / (yShore - yLake));
        color = ditherRamp(lt * 1.25, lakeRamp, x, y);
        // Ripples: broken lighter lines, longer toward the near shore
        const row = Math.floor(y);
        if (row % 5 === 2 && Math.sin(x * 0.11 + row * 1.7) > 0.55 - lt * 0.5) color = lakeRamp[2];
        // The moon or sun leaves a broken column of light on the water
        const reach = 2 + lt * 5;
        if (Math.abs(x - disc.x) <= reach && row % 3 === 0 && ((x + row) & 3) !== 0 && lt > 0.08) color = glintColor;
      }

      rgb.set(color, (y * WIDTH + x) * 3);
    }
  }

  // Cloud strips repeat every WIDTH pixels so they can drift sideways forever.
  const cloudLayer = (rand, anchors) => {
    const clusters = buildCloudClusters(rand, anchors);
    const layer = makeLayer(CLOUD_TOP, CLOUD_HEIGHT);
    for (let y = CLOUD_TOP; y < CLOUD_TOP + CLOUD_HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const cd = cloudDensity(x, y, clusters);
        if (cd <= 0.08) continue;
        if (cd > 0.28 || (cd - 0.08) / 0.2 > bayer(x, y)) {
          layer.set(x, y, ditherRamp(clamp01((cd - 0.12) * 1.35 - (y % 18) * 0.015), cloudRamp, x, y));
        }
      }
    }
    return layer;
  };
  const cloudsFar = cloudLayer(rng(6), [
    { cx: 132, cy: 110, count: 5, scale: 0.8 },
    { cx: 262, cy: 104, count: 4, scale: 0.72 },
    { cx: 418, cy: 106, count: 5, scale: 0.8 },
    { cx: 548, cy: 110, count: 6, scale: 0.85 },
    { cx: 664, cy: 103, count: 4, scale: 0.72 },
  ]);
  const cloudsNear = cloudLayer(rng(7), [
    { cx: 178, cy: 138, count: 6, scale: 1.12 },
    { cx: 318, cy: 144, count: 4, scale: 0.88 },
    { cx: 462, cy: 136, count: 6, scale: 1.08 },
    { cx: 596, cy: 142, count: 5, scale: 0.95 },
    { cx: 676, cy: 140, count: 4, scale: 0.8 },
  ]);

  // Mist: long thin wisps over the far shore of the lake
  const mist = makeLayer(MIST_TOP, MIST_HEIGHT);
  {
    const rand = rng(8);
    const wisps = Array.from({ length: 14 }, () => ({
      x: rand() * WIDTH,
      y: MIST_TOP + 9 + rand() * (MIST_HEIGHT - 18),
      rx: 34 + rand() * 40,
      ry: 2.2 + rand() * 2.4,
    }));
    for (let y = MIST_TOP; y < MIST_TOP + MIST_HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        let d = 0;
        for (const w of wisps) {
          const dx = wrapDx(x - w.x) / w.rx;
          const dy = (y - w.y) / w.ry;
          d = Math.max(d, 1 - (dx * dx + dy * dy));
        }
        if (d * 0.8 > bayer(x, y)) mist.set(x, y, mistColor);
      }
    }
  }

  // Two sets of stars and lake glints that take turns
  const twinkle = (rand) => {
    const layer = makeLayer(0, HEIGHT);
    if (isDark) {
      for (let i = 0; i < 44; i++) {
        layer.set(Math.floor(rand() * WIDTH), 6 + Math.floor(rand() * 82), starColor);
      }
    }
    for (let i = 0, placed = 0; i < 800 && placed < 68; i++) {
      const gx = Math.floor(rand() * (WIDTH - 4));
      const gy = 252 + Math.floor(rand() * 70);
      const length = 2 + Math.floor(rand() * 2);
      if (!inLake(gx, gy - 3) || !inLake(gx + length, gy + 3)) continue;
      for (let dx = 0; dx < length; dx++) layer.set(gx + dx, gy, glintColor);
      placed++;
    }
    return layer;
  };

  const layers = {
    'clouds-far': cloudsFar,
    'clouds-near': cloudsNear,
    mist,
    'twinkle-a': twinkle(rng(9)),
    'twinkle-b': twinkle(rng(10)),
  };

  // Luminance range over the base and every opaque layer pixel; the top band is where the header sits.
  const stats = { minLum: 1, maxLum: 0, minRgb: null, maxRgb: null, topMinLum: 1, topMaxLum: 0 };
  const measure = (color, y) => {
    const lum = relLuminance(color);
    if (lum < stats.minLum) { stats.minLum = lum; stats.minRgb = color; }
    if (lum > stats.maxLum) { stats.maxLum = lum; stats.maxRgb = color; }
    if (y < CLOUD_TOP) {
      stats.topMinLum = Math.min(stats.topMinLum, lum);
      stats.topMaxLum = Math.max(stats.topMaxLum, lum);
    }
  };
  for (let i = 0; i < WIDTH * HEIGHT; i++) measure([...rgb.subarray(i * 3, i * 3 + 3)], Math.floor(i / WIDTH));
  for (const { top, data } of Object.values(layers)) {
    for (let i = 0; i < data.length / 4; i++) {
      if (data[i * 4 + 3]) measure([...data.subarray(i * 4, i * 4 + 3)], top + Math.floor(i / WIDTH));
    }
  }
  for (const key of ['minLum', 'maxLum', 'topMinLum', 'topMaxLum']) stats[key] = +stats[key].toFixed(4);

  const files = { '': encodePng(WIDTH, HEIGHT, rgb, 3) };
  for (const [name, { height, data }] of Object.entries(layers)) {
    files[`-${name}`] = encodePng(WIDTH, height, data, 4);
  }
  return { files, stats };
}

const outDir = join(__dirname, '..', 'src', 'styles', 'scene');
mkdirSync(outDir, { recursive: true });

for (const [mode, seed] of [['light', 20261113], ['dark', 20261114]]) {
  const { files, stats } = generateScene(mode, seed);
  for (const [suffix, png] of Object.entries(files)) {
    const outPath = join(outDir, `cam-${mode}${suffix}.png`);
    writeFileSync(outPath, png);
    console.log(`cam-${mode}${suffix}.png: ${statSync(outPath).size} bytes`);
  }
  console.log(`cam-${mode}:`, JSON.stringify(stats));
}
