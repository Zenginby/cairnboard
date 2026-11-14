import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseDesign, readDesignSources } from '../scripts/lib/design-tokens.mjs';

// The design.md contrast lint reads a translucent color as if it were opaque, so the glass tokens are checked here:
// each glass layer is composited over every color of its theme's scene image (and over the layers it sits on),
// and every text color used on it must keep 4.5:1. Text never sits on the bare scene.
const root = fileURLToPath(new URL('../', import.meta.url));
const sceneDir = new URL('../src/styles/scene/', import.meta.url);

// Which glass layers sit under each glass background, nearest first.
const under = {
  'glass-surface': [],
  'glass-material': [],
  'glass-column': [],
  'glass-surface-inset': ['glass-surface'],
  'glass-surface-inset-2': ['glass-surface'],
  'glass-row-hover': ['glass-surface'],
  'glass-card': ['glass-column'],
  'glass-pill-bg': ['glass-material'],
  'glass-pill-indicator': ['glass-pill-bg', 'glass-material'],
};
// Text pairs that have no component of their own because their background is a mark.
const extraPairs = [['glass-row-hover', 'text'], ['glass-row-hover', 'text-3']];

function parseColor(value) {
  const hex = /^#([\da-f]{6})$/iu.exec(value);
  if (hex) return [...hex[1].match(/../gu).map((c) => parseInt(c, 16)), 1];
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/u.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unsupported color ${value}`);
}

function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Unique colors of an 8-bit RGB or RGBA PNG without interlacing (what scripts/scene-build.mjs writes).
export function pngColors(buffer) {
  let offset = 8;
  let width; let height; let channels;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[12] !== 0) throw new Error('unsupported PNG format');
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a
        : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      if (predictor === undefined) throw new Error(`unknown PNG filter ${filter}`);
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  const colors = new Map();
  for (let i = 0; i < pixels.length; i += channels) {
    colors.set((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2], [pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  return [...colors.values()];
}

const themes = (await readDesignSources(root)).map(parseDesign);
const glassThemes = themes.filter(({ colors }) =>
  parseColor(colors['glass-surface'])[3] < 1);

test('only themes with a scene image use translucent glass backgrounds', () => {
  assert.deepEqual(glassThemes.map(({ file }) => basename(file, '.md')).sort(), ['cam', 'cam-dark']);
  for (const { file } of glassThemes) {
    const mode = basename(file, '.md').endsWith('-dark') ? 'dark' : 'light';
    assert.ok(existsSync(new URL(`cam-${mode}.png`, sceneDir)), `${file}: scene image cam-${mode}.png is missing`);
  }
});

for (const theme of glassThemes) {
  test(`${theme.file}: text on glass keeps 4.5:1 over every scene color`, () => {
    const mode = basename(theme.file, '.md').endsWith('-dark') ? 'dark' : 'light';
    const scene = pngColors(readFileSync(new URL(`cam-${mode}.png`, sceneDir)));
    const token = (ref) => parseColor(theme.colors[ref.replace(/^\{colors\.|\}$/gu, '')]);
    const pairs = Object.values(theme.components)
      .filter(({ backgroundColor, textColor }) => textColor && /^\{colors\.glass-/u.test(backgroundColor))
      .map(({ backgroundColor, textColor }) => [backgroundColor.slice(8, -1), textColor.slice(8, -1)]);
    assert.ok(pairs.length >= 10, 'glass component pairs are missing');
    const failures = [];
    for (const [background, text] of [...pairs, ...extraPairs]) {
      assert.ok(Object.hasOwn(under, background), `${background}: unknown glass layer stack`);
      let worst = Infinity;
      for (const pixel of scene) {
        const backdrop = [...under[background]].reverse().reduce((color, layer) => over(token(layer), color), pixel);
        const surface = over(token(background), backdrop);
        worst = Math.min(worst, contrast(over(token(text), surface), surface));
      }
      if (worst < 4.5) failures.push(`${text} on ${background}: ${worst.toFixed(2)}:1`);
    }
    assert.deepEqual(failures, []);
  });
}
