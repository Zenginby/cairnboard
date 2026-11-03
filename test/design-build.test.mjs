import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTokens, colorScheme, readDesignSources } from '../scripts/lib/design-tokens.mjs';
import { tempDir } from './support/env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const front = `colors:
  canvas: "#ffffff"
  text: "#123456"
spacing:
  sm: 8px
rounded:
  sm: 12px
typography:
  body: { fontFamily: Inter Variable, fontSize: 16px, fontWeight: 400, lineHeight: 1.7, letterSpacing: -0.01em }
  code: { fontFamily: ui-monospace }
`;
const elevation = `## Elevation & Depth

\`\`\`yaml
shadow-box: 0 1px 2px black
shadow-box-raised: 0 2px 4px black
\`\`\`
`;
const motion = `## Motion

\`\`\`yaml
duration-stagger: 40ms
duration-fast: 250ms
duration-highlight: 700ms
distance-base: 8px
scale-press: 0.97
blur-small: 2px
stagger-max-items: 5
ease-spring: linear(0, 0.5, 1)
ease-spring-bouncy: linear(0, 1.1, 1)
ease-spring-fallback: ease-out
\`\`\`
`;
const source = (file = 'DESIGN.md', metadata = front, body = elevation + motion) =>
  ({ file, text: `---\n${metadata}---\n${body}` });
const theme = (metadata = front, body = elevation, file = 'design/themes/bento-dark.md') => source(file, metadata, body);

test('emits root tokens in source order with font fallbacks and LF output', () => {
  const css = buildTokens([source()]);
  assert.ok(css.startsWith('/* Generated; do not edit. Sources: DESIGN.md */\n'));
  assert.match(css, /:root \{\n  color-scheme: light;\n  --color-canvas: #ffffff;\n  --color-text: #123456;/u);
  for (const declaration of [
    '--space-sm: 8px;', '--radius-sm: 12px;', '--shadow-box: 0 1px 2px black;',
    '--shadow-box-raised: 0 2px 4px black;',
    "--font-body-family: Inter Variable, system-ui, -apple-system, 'Segoe UI', sans-serif;",
    "--font-code-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;",
    '--font-body-size: 16px;', '--font-body-weight: 400;', '--font-body-line-height: 1.7;',
    '--font-body-letter-spacing: -0.01em;', '--motion-duration-fast: 250ms;',
    '--motion-stagger-max-items: 5;', '--motion-scale-press: 0.97;', '--motion-blur-small: 2px;',
  ]) assert.ok(css.includes(declaration), declaration);
  assert.ok(!css.includes('--font-code-size'));
  assert.ok(!css.includes('\r'));
  assert.ok(css.endsWith('\n'));
  assert.equal(buildTokens([{ file: 'DESIGN.md', text: source().text.replaceAll('\n', '\r\n') }]), css);
});

test('emits spring fallbacks, feature overrides and reduced motion exceptions', () => {
  const css = buildTokens([source()]);
  const base = css.slice(0, css.indexOf('@supports'));
  assert.ok(base.includes('--motion-ease-spring: ease-out;'));
  assert.ok(base.includes('--motion-ease-spring-bouncy: ease-out;'));
  assert.match(css, /@supports \(transition-timing-function: linear\(0, 1\)\) \{\n  :root \{\n    --motion-ease-spring: linear\(0, 0.5, 1\);\n    --motion-ease-spring-bouncy: linear\(0, 1.1, 1\);\n  \}\n\}/u);
  assert.equal(css.slice(css.indexOf('@media (prefers-reduced-motion')), `@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-duration-stagger: 0ms;
    --motion-distance-base: 0px;
    --motion-scale-press: 1;
  }
}
`);
});

test('theme blocks change only colors and shadows, including a full bento reset', () => {
  const dark = theme(front.replace('#ffffff', '#111111'), elevation.replace('2px black', '2px white'));
  const paper = theme(front, elevation, 'design/themes/paper.md');
  const css = buildTokens([source(), dark, paper]);
  assert.match(css, /:root\[data-theme="bento"\] \{\n  color-scheme: light;[\s\S]*?--shadow-box-raised: 0 2px 4px black;/u);
  const darkBlock = css.match(/:root\[data-theme="bento-dark"\] \{([^}]+)\}/u)[1];
  assert.ok(darkBlock.includes('color-scheme: dark;'));
  assert.ok(darkBlock.includes('--color-canvas: #111111;'));
  assert.ok(darkBlock.includes('--shadow-box: 0 1px 2px white;'));
  assert.ok(!/--(?:font|space|radius|motion)-/u.test(darkBlock));
  assert.match(css, /:root\[data-theme="paper"\] \{\n  color-scheme: light;/u);
  assert.ok(css.includes(`@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --color-canvas: #111111;
    --color-text: #123456;
    --shadow-box: 0 1px 2px white;
    --shadow-box-raised: 0 2px 4px black;
  }
}`));
});

test('mode uses linearized relative luminance, not the hex midpoint', () => {
  assert.equal(colorScheme('#bbb', 'theme.md'), 'dark');
  assert.equal(colorScheme('#ccc', 'theme.md'), 'light');
  assert.equal(colorScheme('#00ff00', 'theme.md'), 'light');
});

for (const [label, changed, key] of [
  ['missing color', theme(front.replace('  text: "#123456"\n', '')), 'colors.text'],
  ['extra color', theme(front.replace('spacing:', '  extra: red\nspacing:')), 'colors.extra'],
  ['missing shadow', theme(front, elevation.replace('shadow-box-raised: 0 2px 4px black\n', '')), 'Elevation & Depth.shadow-box-raised'],
  ['extra shadow', theme(front, elevation.replace('shadow-box:', 'shadow-extra: none\nshadow-box:')), 'Elevation & Depth.shadow-extra'],
  ['changed spacing', theme(front.replace('sm: 8px', 'sm: 9px')), 'spacing.sm'],
  ['changed radius', theme(front.replace('sm: 12px', 'sm: 13px')), 'rounded.sm'],
  ['changed typography', theme(front.replace('fontSize: 16px', 'fontSize: 17px')), 'typography.body'],
  ['theme motion', theme(front, elevation + motion), 'Motion'],
  ['empty theme motion', theme(front, elevation + '## Motion\n```yaml\n{}\n```\n'), 'Motion'],
]) {
  test(`rejects ${label} with file and key`, () => {
    assert.throws(() => buildTokens([source(), changed]), (error) =>
      error.message.includes(changed.file) && error.message.includes(key));
  });
}

for (const section of ['Motion', 'Elevation & Depth']) {
  for (const value of ['{ nested: 1 }', '[1, 2]', 'null']) {
    test(`rejects non-flat ${section} value ${value}`, () => {
      const body = `## ${section}\n\`\`\`yaml\nbad: ${value}\n\`\`\`\n`;
      assert.throws(() => buildTokens([source('DESIGN.md', front, body)]), /DESIGN\.md: (Motion|Elevation & Depth)\.bad: expected a flat/u);
    });
  }
}

for (const value of ['red; color: blue', 'red{', 'red}', '</style>']) {
  test(`rejects CSS injection ${value}`, () => {
    for (const changed of [
      source('DESIGN.md', front.replace('#123456', value)),
      source('DESIGN.md', front.replace('Inter Variable', JSON.stringify(value))),
      source('DESIGN.md', front, elevation + motion.replace('250ms', `"${value}"`)),
      source('DESIGN.md', front, elevation.replace('0 1px 2px black', `"${value}"`)),
    ]) assert.throws(() => buildTokens([changed]), /DESIGN\.md: .+: unsafe CSS token value/u);
  });
}

for (const [from, to] of [['canvas:', 'Canvas:'], ['sm: 8px', 'bad_name: 8px'], ['sm: 12px', 'bad.name: 12px'], ['body:', 'Body:']]) {
  test(`rejects invalid front matter token ${to}`, () => {
    assert.throws(() => buildTokens([source('DESIGN.md', front.replace(from, to))]), /DESIGN\.md: .+: invalid token name/u);
  });
}
for (const section of ['Motion', 'Elevation & Depth']) {
  test(`rejects invalid ${section} token name`, () => {
    assert.throws(() => buildTokens([source('DESIGN.md', front, `## ${section}\n\`\`\`yaml\nbad_name: 1\n\`\`\`\n`)]), /DESIGN\.md: .+bad_name: invalid token name/u);
  });
}

test('allows omitted shared groups and reordered identical copies in themes', () => {
  const reordered = front.replace('fontFamily: Inter Variable, fontSize: 16px', 'fontSize: 16px, fontFamily: Inter Variable');
  assert.doesNotThrow(() => buildTokens([source(), theme(reordered)]));
  assert.doesNotThrow(() => buildTokens([source(), theme('colors:\n  canvas: "#000"\n  text: white\n')]));
});

test('--check rejects missing and stale output without writing, and accepts current output', (t) => {
  const cwd = tempDir(t);
  mkdirSync(join(cwd, 'design/themes'), { recursive: true });
  writeFileSync(join(cwd, 'DESIGN.md'), source().text);
  const cli = join(root, 'scripts/design-build.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  let result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/styles\/tokens.css is missing or stale; run npm run design:build/u);
  assert.equal(run().status, 0);
  const target = join(cwd, 'src/styles/tokens.css');
  const generated = readFileSync(target);
  assert.equal(run().status, 0);
  assert.deepEqual(readFileSync(target), generated);
  assert.equal(run('--check').status, 0);
  writeFileSync(target, 'stale\n');
  result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or stale/u);
  assert.equal(readFileSync(target, 'utf8'), 'stale\n');
});

test('real design sources match the checked-in generated tokens', async () => {
  assert.equal(buildTokens(await readDesignSources(root)), readFileSync(join(root, 'src/styles/tokens.css'), 'utf8'));
});
