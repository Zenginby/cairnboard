import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCss, lintHtml, lintPrototypes } from '../scripts/lib/prototype-lint.mjs';
import { tempDir } from './support/env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = (found) => found.map((item) => item.rule);
const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';

test('css: raw colours, durations and easings fail; tokens, comments and selectors do not', () => {
  const css = `/* #fff rgb(0 0 0) 200ms cubic-bezier(0, 0, 1, 1) */
#add, a:hover { color: var(--color-text); background: var(--color-surface, #fff); }
.a { color: #fff; }
.b { border-color: #12345678; box-shadow: 0 0 0 1px rgb(0 0 0 / 10%); }
.c { background: hsl(10 20% 30%); fill: oklch(0.5 0.1 20); }
.d { transition: opacity 200ms ease; }
.e { animation: spin var(--motion-duration-slow) var(--motion-ease-out) 0.5s infinite; }
.f { transition-duration: 1s; transition-delay: calc(var(--motion-duration-stagger) * 2); }
.g { transition: transform var(--motion-duration-fast) cubic-bezier(.2, .8, .2, 1); }
.h { mask: url(#abc); width: 200ms; }
.i { transition: opacity var(--motion-duration-quick, 120ms) var(--motion-ease-out); }`;
  assert.deepEqual(lintCss(css).map((item) => [item.line, item.rule]), [
    [3, 'raw-color'], [4, 'raw-color'], [4, 'raw-color'], [5, 'raw-color'], [5, 'raw-color'],
    [6, 'raw-duration'], [7, 'raw-duration'], [8, 'raw-duration'], [9, 'raw-easing'],
  ]);
});

test('html: inline script, style, handlers and a missing CSP fail', () => {
  assert.deepEqual(lintHtml(`<!doctype html><head>${CSP}<script type="module" src="app.js"></script></head><body><p id="x">ok</p></body>`), []);
  assert.deepEqual(lintHtml(`<head><meta content="default-src 'self'" http-equiv="Content-Security-Policy"></head>`), []);
  assert.deepEqual(rules(lintHtml('<head></head><body></body>')), ['missing-csp']);
  assert.deepEqual(rules(lintHtml(`<head>${CSP}<script>alert(1)</script><style>a{}</style></head><body><p style="color:red" onclick="x()">t</p><button onmouseover = "y()">b</button></body>`)),
    ['inline-script', 'inline-style', 'inline-style', 'inline-handler', 'inline-handler']);
  assert.deepEqual(lintHtml(`<head>${CSP}<!-- <script>x</script> style="a" --></head>`), []);
});

test('lintPrototypes walks design/prototypes and reports file and line', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'design/prototypes/home'), { recursive: true });
  mkdirSync(join(dir, 'design/themes'), { recursive: true });
  writeFileSync(join(dir, 'design/prototypes/home/app.css'), '.a { color: var(--color-text); }\n.b { color: #abc; }\n');
  writeFileSync(join(dir, 'design/prototypes/home/index.html'), '<head></head>\n');
  writeFileSync(join(dir, 'design/themes/other.css'), '.c { color: #abc; }\n');
  assert.deepEqual(lintPrototypes(dir).map(({ file, line, rule }) => [file, line, rule]).sort(), [
    ['design/prototypes/home/app.css', 2, 'raw-color'],
    ['design/prototypes/home/index.html', 1, 'missing-csp'],
  ]);
});

test('the current prototypes pass, and npm run design:lint reports a violation', (t) => {
  assert.deepEqual(lintPrototypes(root), []);
  const dir = tempDir(t);
  mkdirSync(join(dir, 'design/prototypes/x'), { recursive: true });
  writeFileSync(join(dir, 'design/prototypes/x/app.css'), '.a { color: #fff; }\n');
  const result = spawnSync(process.execPath, [join(root, 'scripts/design-lint.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /design\/prototypes\/x\/app\.css:1 raw-color/u);
});
