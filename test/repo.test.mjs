import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const oku = (yol) => readFileSync(new URL(`../${yol}`, import.meta.url), 'utf8');

test('package.json is private, ESM, MIT, Node >= 22.23.4 with exactly pinned dependencies', () => {
  const p = JSON.parse(oku('package.json'));
  assert.equal(p.private, true);
  assert.equal(p.type, 'module');
  assert.equal(p.engines.node, '>=22.23.4');
  assert.equal(p.license, 'MIT');
  assert.ok(Array.isArray(p.files));
  assert.deepEqual(p.dependencies, { '@astrojs/node': '11.1.9', astro: '7.4.5',
    'rehype-sanitize': '6.0.0', 'rehype-stringify': '10.0.1', 'remark-gfm': '4.0.1',
    'remark-parse': '11.0.0', 'remark-rehype': '11.1.2', unified: '11.0.5', yaml: '2.9.1' });
  assert.deepEqual(p.devDependencies, { '@google/design.md': '0.4.0', 'axe-core': '4.14.0', esbuild: '0.28.2', 'playwright-core': '1.64.1' });
  for (const version of [...Object.values(p.dependencies), ...Object.values(p.devDependencies)]) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
  }
});

test('.npmrc disables install scripts', () => {
  assert.match(oku('.npmrc'), /^ignore-scripts=true$/m);
});

test('app builds disable telemetry before importing Astro and never invoke its binary', () => {
  const { scripts } = JSON.parse(oku('package.json'));
  for (const script of Object.values(scripts)) assert.doesNotMatch(script, /\bastro(?:\.cmd)?(?:\s|$)/u);
  assert.equal(scripts['build:app'], 'node scripts/build-app.mjs');
  assert.equal(scripts.start, 'node scripts/build-app.mjs && node server/start.mjs');
  const source = oku('scripts/build-app.mjs');
  const setting = source.indexOf("process.env.ASTRO_TELEMETRY_DISABLED = '1'");
  const importing = source.indexOf("await import('astro')");
  assert.ok(setting >= 0 && importing > setting);
  assert.doesNotMatch(source, /^import\s/mu);
  assert.match(source, /const \{ build \} = await import\('astro'\);\s*await build\(\{\}\);/u);
});

test('license and readme', () => {
  assert.equal(oku('LICENSE').split('\n')[0], 'MIT License');
  assert.match(oku('README.md'), /^## Türkçe$/m);
  assert.match(oku('README.md'), /^## English$/m);
});

test('.gitignore keeps local data and secrets out', () => {
  const g = oku('.gitignore').split('\n');
  for (const s of ['node_modules/', '.env*', '*.local.*', '.cairn/', 'dist/', '.DS_Store']) assert.ok(g.includes(s), s);
});

test('AGENTS.md carries the privacy rule', () => {
  assert.match(oku('AGENTS.md'), /Never write private project, person, organisation or machine names into files, commit messages or PR descriptions/);
});
