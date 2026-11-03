import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

function fail(file, key, message) {
  throw new Error(`${file}: ${key}: ${message}`);
}

function mapping(value, file, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(file, key, 'expected a mapping');
  return value;
}

function name(value, file, key) {
  if (!/^[a-z0-9-]+$/u.test(value)) fail(file, key, 'invalid token name');
}

function scalar(value, file, key) {
  if (!['string', 'number'].includes(typeof value)) fail(file, key, 'expected a flat string or number');
  if (/[;{}]|<\//u.test(String(value))) fail(file, key, 'unsafe CSS token value');
  return String(value);
}

function flat(value, file, key) {
  const result = mapping(value, file, key);
  for (const [token, entry] of Object.entries(result)) {
    name(token, file, `${key}.${token}`);
    scalar(entry, file, `${key}.${token}`);
  }
  return result;
}

function yaml(text, file, key) {
  try {
    return parse(text);
  } catch (error) {
    fail(file, key, error.message);
  }
}

const fontProperties = {
  fontFamily: 'family', fontSize: 'size', fontWeight: 'weight',
  lineHeight: 'line-height', letterSpacing: 'letter-spacing',
};

export function parseDesign({ file, text }) {
  const normalized = text.replaceAll('\r\n', '\n');
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!front) fail(file, 'front matter', 'expected YAML front matter');
  const data = mapping(yaml(front[1], file, 'front matter'), file, 'front matter');
  for (const group of ['colors', 'spacing', 'rounded']) {
    data[group] = flat(data[group] ?? {}, file, group);
  }
  data.typography = mapping(data.typography ?? {}, file, 'typography');
  for (const [token, properties] of Object.entries(data.typography)) {
    name(token, file, `typography.${token}`);
    for (const [property, value] of Object.entries(mapping(properties, file, `typography.${token}`))) {
      if (!Object.hasOwn(fontProperties, property)) fail(file, `typography.${token}.${property}`, 'unknown typography property');
      scalar(value, file, `typography.${token}.${property}`);
    }
  }
  const blocks = { Motion: {}, 'Elevation & Depth': {} };
  let section, fence, content = [], hasMotion = false;
  for (const line of normalized.slice(front[0].length).split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, 'u').test(line)) {
        if (fence.yaml && Object.hasOwn(blocks, section)) {
          const values = flat(yaml(content.join('\n'), file, section), file, section);
          for (const [key, value] of Object.entries(values)) {
            if (Object.hasOwn(blocks[section], key)) fail(file, `${section}.${key}`, 'duplicate token');
            blocks[section][key] = value;
          }
          if (section === 'Motion') hasMotion = true;
        }
        fence = undefined;
      } else content.push(line);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length, yaml: opening[2].trim() === 'yaml' };
      content = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading && heading[1].length <= 2) section = heading[1].length === 2 ? heading[2] : undefined;
  }
  if (fence) fail(file, section ?? 'body', 'unclosed fenced block');
  const motion = blocks.Motion;
  if (Object.hasOwn(motion, 'stagger-max-items') &&
      (!Number.isInteger(motion['stagger-max-items']) || motion['stagger-max-items'] < 0)) {
    fail(file, 'Motion.stagger-max-items', 'expected a unitless non-negative integer');
  }
  for (const key of ['ease-spring', 'ease-spring-bouncy']) {
    if (Object.hasOwn(motion, key) && !Object.hasOwn(motion, 'ease-spring-fallback')) {
      fail(file, 'Motion.ease-spring-fallback', 'required for spring easing');
    }
  }
  return { file, ...data, motion, shadows: blocks['Elevation & Depth'], hasMotion };
}

function sameKeys(root, theme, file, group) {
  for (const key of new Set([...Object.keys(root), ...Object.keys(theme)])) {
    if (Object.hasOwn(root, key) !== Object.hasOwn(theme, key)) fail(file, `${group}.${key}`, 'token key set differs from root');
  }
}

export function colorScheme(canvas, file) {
  // Canvas is an opaque sRGB hex color in the design files.
  if (typeof canvas !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(canvas)) {
    fail(file, 'colors.canvas', 'expected an opaque #RGB or #RRGGBB color');
  }
  const hex = canvas.length === 4 ? [...canvas.slice(1)].map((c) => c + c).join('') : canvas.slice(1);
  const channels = hex.match(/../gu).map((c) => {
    const value = parseInt(c, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0) < 0.5 ? 'dark' : 'light';
}

function declarations(group, prefix) {
  return Object.entries(group).map(([key, value]) => `--${prefix}${key}: ${value};`);
}

function block(selector, lines) {
  return `${selector} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}`;
}

function nested(condition, selector, lines) {
  return `${condition} {\n${block(selector, lines).split('\n').map((line) => `  ${line}`).join('\n')}\n}`;
}

function themeDeclarations(theme, mode) {
  return [`color-scheme: ${mode};`, ...declarations(theme.colors, 'color-'), ...declarations(theme.shadows, '')];
}

export function buildTokens(sources) {
  const [root, ...themes] = sources.map(parseDesign);
  if (!root) throw new Error('DESIGN.md: missing root design');
  const rootLines = [
    ...themeDeclarations(root, 'light'), ...declarations(root.spacing, 'space-'), ...declarations(root.rounded, 'radius-'),
  ];
  for (const [token, properties] of Object.entries(root.typography)) {
    for (const [property, value] of Object.entries(properties)) {
      const fallback = value === 'ui-monospace'
        ? ", 'SF Mono', Menlo, Consolas, monospace"
        : ", system-ui, -apple-system, 'Segoe UI', sans-serif";
      rootLines.push(`--font-${token}-${fontProperties[property]}: ${value}${property === 'fontFamily' ? fallback : ''};`);
    }
  }
  const springs = ['ease-spring', 'ease-spring-bouncy'];
  rootLines.push(...Object.entries(root.motion).map(([key, value]) =>
    `--motion-${key}: ${springs.includes(key) ? root.motion['ease-spring-fallback'] : value};`));
  const output = [
    `/* Generated; do not edit. Sources: ${sources.map(({ file }) => file).join(', ')} */`,
    block(':root', rootLines),
    block(':root[data-theme="bento"]', themeDeclarations(root, 'light')),
  ];
  let dark;
  for (const theme of themes) {
    const id = basename(theme.file, '.md');
    name(id, theme.file, 'theme');
    if (id === 'bento') fail(theme.file, 'theme', 'bento is reserved for the root theme');
    sameKeys(root.colors, theme.colors, theme.file, 'colors');
    sameKeys(root.shadows, theme.shadows, theme.file, 'Elevation & Depth');
    for (const group of ['typography', 'rounded', 'spacing']) {
      for (const [key, value] of Object.entries(theme[group])) {
        if (!isDeepStrictEqual(value, root[group][key])) fail(theme.file, `${group}.${key}`, 'theme value differs from root');
      }
    }
    if (theme.hasMotion) fail(theme.file, 'Motion', 'themes cannot define motion');
    const lines = themeDeclarations(theme, colorScheme(theme.colors.canvas, theme.file));
    output.push(block(`:root[data-theme="${id}"]`, lines));
    if (id === 'bento-dark') dark = theme;
  }
  if (dark) output.push(nested('@media (prefers-color-scheme: dark)', ':root:not([data-theme])', themeDeclarations(dark, 'dark')));
  const springLines = springs.filter((key) => Object.hasOwn(root.motion, key))
    .map((key) => `--motion-${key}: ${root.motion[key]};`);
  if (springLines.length) output.push(nested('@supports (transition-timing-function: linear(0, 1))', ':root', springLines));
  // Reduced motion removes movement (distance, scale, stagger) but keeps durations, so fades still happen.
  const reduced = Object.keys(root.motion).flatMap((key) => {
    if (key === 'duration-stagger') return [`--motion-${key}: 0ms;`];
    if (key.startsWith('distance-')) return [`--motion-${key}: 0px;`];
    if (key.startsWith('scale-')) return [`--motion-${key}: 1;`];
    return [];
  });
  output.push(nested('@media (prefers-reduced-motion: reduce)', ':root', reduced));
  return output.join('\n\n') + '\n';
}

export async function readDesignSources(root) {
  const directory = join(root, 'design/themes');
  const names = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
  return Promise.all(['DESIGN.md', ...names.map((file) => `design/themes/${file}`)]
    .map(async (file) => ({ file, text: await readFile(join(root, file), 'utf8') })));
}
