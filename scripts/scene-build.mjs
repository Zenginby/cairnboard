// Scene images for the Cam theme: a dithered pixel highland horizon with a cairn, dependency-free (node:zlib).
// Writes src/styles/scene/cam-light.png and cam-dark.png (360x540, drawn at 4x) and prints luminance stats.
// Run with `npm run design:scene`; test/glass-contrast.test.mjs checks the glass tokens against every pixel color.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDTH = 360;
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

function encodePngRgb(width, height, rgbBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 1;
    const rowOff = y * width * 3;
    const outOff = y * stride + 1;
    for (let x = 0; x < width * 3; x++) {
      const left = x >= 3 ? rgbBuffer[rowOff + x - 3] : 0;
      raw[outOff + x] = (rgbBuffer[rowOff + x] - left) & 0xff;
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

function buildCloudClusters(rand) {
  // Placed below y=88 so header & board toolbar sit on calm sky
  const clusters = [];
  const anchors = [
    { cx: 52, cy: 112, count: 6, scale: 1.05 },
    { cx: 165, cy: 102, count: 5, scale: 0.92 },
    { cx: 292, cy: 108, count: 7, scale: 1.12 },
    { cx: 112, cy: 146, count: 6, scale: 1.15 },
    { cx: 232, cy: 140, count: 5, scale: 0.95 },
    { cx: 336, cy: 152, count: 4, scale: 0.85 },
  ];
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
    const dx = (x - c.x) / c.rx;
    const dy = (y - c.y) / c.ry;
    const dyAdj = dy > 0 ? dy * 1.45 : dy;
    const d = 1 - (dx * dx + dyAdj * dyAdj);
    if (d > maxD) maxD = d;
  }
  return clamp01(maxD);
}

function generateScene(mode, seed) {
  const rand = mulberry32(seed);
  const isDark = mode === 'dark';

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

  const ridgeFarColor = hexToRgb(isDark ? '#152033' : '#bac9d8');
  const ridgeMidColor = hexToRgb(isDark ? '#0f1827' : '#a7b8ca');
  const ridgeNearColor = hexToRgb(isDark ? '#0a101c' : '#93a6bb');
  const cairnDark = hexToRgb(isDark ? '#070b13' : '#7b8fa6');
  const cairnLit = hexToRgb(isDark ? '#2a3d5a' : '#bccad9');
  const starColor = hexToRgb(isDark ? '#4d6282' : '#f7f3ea');

  const clusters = buildCloudClusters(rand);

  const stars = new Set();
  if (isDark) {
    for (let i = 0; i < 64; i++) {
      const sx = Math.floor(rand() * WIDTH);
      const sy = 6 + Math.floor(rand() * 82);
      stars.add(`${sx},${sy}`);
    }
  }

  // Horizon ridges positioned in mid-upper screen so visible between Hero/Project/Board columns
  const ridgeFarY = (x) =>
    178 + Math.sin(x * 0.019 + 0.4) * 9 + Math.cos(x * 0.043) * 4;
  const ridgeMidY = (x) =>
    196 + Math.sin(x * 0.015 + 2.1) * 10 + Math.sin(x * 0.052) * 3.5;
  const ridgeNearY = (x) =>
    216 + Math.sin(x * 0.017 + 4.0) * 8 + Math.cos(x * 0.038 + 1.2) * 4;
  // Lower valley mist ridges (subtle texture behind lower cards on Home & Board)
  const valleyRollY = (x) =>
    315 + Math.sin(x * 0.014 + 1.1) * 14 + Math.cos(x * 0.032) * 5;
  const valleyLowY = (x) =>
    420 + Math.sin(x * 0.016 + 3.2) * 12 + Math.sin(x * 0.029) * 4;

  const cairnCenterX = 278;
  const cairnBaseY = Math.floor(ridgeMidY(cairnCenterX));
  const cairnStones = [
    { hw: 7, h: 3, xs: 0 },
    { hw: 5, h: 3, xs: -1 },
    { hw: 4, h: 2, xs: 1 },
    { hw: 3, h: 2, xs: 0 },
    { hw: 2, h: 2, xs: -1 },
  ];
  const cairnPixels = new Map();
  let curY = cairnBaseY;
  for (let s = 0; s < cairnStones.length; s++) {
    const { hw, h, xs } = cairnStones[s];
    for (let dy = 0; dy < h; dy++) {
      const py = curY - dy;
      for (let dx = -hw; dx <= hw; dx++) {
        if (dy === h - 1 && Math.abs(dx) === hw && hw >= 3) continue;
        if (dy === 0 && Math.abs(dx) === hw && hw >= 5) continue;
        const px = cairnCenterX + xs + dx;
        const isTopRim = dy === h - 1 && dx <= 0;
        cairnPixels.set(`${px},${py}`, isTopRim ? cairnLit : cairnDark);
      }
    }
    curY -= h;
  }

  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  let minLum = 1;
  let maxLum = 0;
  let topMinLum = 1;
  let topMaxLum = 0;
  let minRgb = null;
  let maxRgb = null;

  for (let y = 0; y < HEIGHT; y++) {
    const skyT = y / 196;

    for (let x = 0; x < WIDTH; x++) {
      let color = ditherRamp(skyT, skyRamp, x, y);

      if (isDark && stars.has(`${x},${y}`)) {
        color = starColor;
      }

      const cd = cloudDensity(x, y, clusters);
      if (cd > 0.08) {
        const threshold = (BAYER_4[y & 3][x & 3] + 0.5) / 16;
        if (cd > 0.28 || (cd - 0.08) / 0.2 > threshold) {
          const shadeT = clamp01((cd - 0.12) * 1.35 - (y % 18) * 0.015);
          color = ditherRamp(shadeT, cloudRamp, x, y);
        }
      }

      const yFar = ridgeFarY(x);
      const yMid = ridgeMidY(x);
      const yNear = ridgeNearY(x);
      const thresh = (BAYER_4[y & 3][x & 3] + 0.5) / 16;

      if (y >= yFar) {
        const mistMix = clamp01((y - yFar) / 12);
        if (mistMix > thresh * 0.55) {
          color = ridgeFarColor;
        }
      }

      const cairnPix = cairnPixels.get(`${x},${y}`);
      if (cairnPix) {
        color = cairnPix;
      }

      if (y >= yMid) {
        const mistMix = clamp01((y - yMid) / 6);
        if (mistMix > thresh * 0.45) {
          color = ridgeMidColor;
        }
      }

      if (y >= yNear) {
        const mistMix = clamp01((y - yNear) / 5);
        if (mistMix > thresh * 0.4) {
          color = ridgeNearColor;
        }
      }

      // Below near ridge: gentle misty valley dither bands + soft waves down to y=540
      if (y >= 235) {
        const vt = clamp01((y - 235) / (HEIGHT - 1 - 235));
        const wave1 = y >= valleyRollY(x) && y < valleyRollY(x) + 34 ? 0.12 : 0;
        const wave2 = y >= valleyLowY(x) && y < valleyLowY(x) + 38 ? -0.10 : 0;
        color = ditherRamp(clamp01(vt + wave1 + wave2), valleyRamp, x, y);
      }

      const idx = (y * WIDTH + x) * 3;
      rgb[idx] = color[0];
      rgb[idx + 1] = color[1];
      rgb[idx + 2] = color[2];

      const lum = relLuminance(color);
      if (lum < minLum) {
        minLum = lum;
        minRgb = color;
      }
      if (lum > maxLum) {
        maxLum = lum;
        maxRgb = color;
      }
      if (y < 88) {
        if (lum < topMinLum) topMinLum = lum;
        if (lum > topMaxLum) topMaxLum = lum;
      }
    }
  }

  return {
    png: encodePngRgb(WIDTH, HEIGHT, rgb),
    stats: {
      minLum: +minLum.toFixed(4),
      maxLum: +maxLum.toFixed(4),
      minRgb,
      maxRgb,
      topMinLum: +topMinLum.toFixed(4),
      topMaxLum: +topMaxLum.toFixed(4),
    },
  };
}

const outDir = join(__dirname, '..', 'src', 'styles', 'scene');
mkdirSync(outDir, { recursive: true });

for (const [mode, seed] of [['light', 20261113], ['dark', 20261114]]) {
  const { png, stats } = generateScene(mode, seed);
  const outPath = join(outDir, `cam-${mode}.png`);
  writeFileSync(outPath, png);
  console.log(`cam-${mode}.png: ${statSync(outPath).size} bytes`, JSON.stringify(stats));
}
