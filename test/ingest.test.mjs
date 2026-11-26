import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { ingest } from '../core/ingest.mjs';
import { recover } from '../core/store.mjs';
import { list as trashList } from '../core/trash.mjs';
import { readEvents } from '../core/events.mjs';
import { runCli, spawnCli } from './support/cli.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TODO = (path) => [`write a short source summary in ${path}`, 'update only pages this source directly changes',
  'leave deeper compilation for when a question needs it'];

function setup(t, preset = 'default') {
  const home = tempDir(t), data = tempDir(t);
  seedDataDir(data, { home, env: {}, clock, preset });
  const run = (args, extra = {}) => runCli([...args, '--json'], { home, data, clock, ...extra });
  const open = () => openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'cli:codex' });
  return { home, data, run, open };
}

// Every file under the data folder except the index cache: path -> sha256.
function files(root, dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (/^\.cairn\/index\.db/u.test(rel)) return [];
    return entry.isDirectory() ? files(root, rel) : [[rel, sha(readFileSync(join(root, rel)))]];
  }).sort();
}

test('ingest writes the raw source and an unprocessed research record in one operation', async (t) => {
  const f = setup(t);
  const note = await f.run(['note', 'add', '--title', 'Zorblax engine', '--actor', 'codex']);
  assert.equal(note.code, 0, note.stdout);
  const input = 'Zorblax engine notes\nSecond line\n';
  const response = await f.run(['ingest', '--title', 'Acme Report', '--body', '-', '--url', 'https://example.test/a',
    '--date', '2026-10-30', '--actor', 'codex'], { stdin: input });
  assert.equal(response.code, 0, response.stdout + response.stderr);
  const data = response.json.data;
  assert.equal(data.raw.path, 'raw/2026-10-30-acme-report.md');
  assert.equal(data.research.path, 'research/acme-report.md');
  assert.equal(data.duplicate, false);
  assert.equal(data.input_sha256, sha(input));
  assert.deepEqual(data.todo, TODO('research/acme-report.md'));
  assert.deepEqual(data.related, [{ path: note.json.data.path, content: { title: 'Zorblax engine' } }]);
  const stored = readFileSync(join(f.data, data.raw.path));
  assert.equal(stored.toString('utf8'), `Source: https://example.test/a\nDate: 2026-10-30\n\n${input}`);
  assert.equal(typeof data.raw.revision, 'string');
  assert.equal(typeof data.research.revision, 'string');
  const shown = await f.run(['research', 'show', '@research/acme-report']);
  assert.equal(shown.json.data.content.title, 'Acme Report');
  const fields = { ...shown.json.data.meta, ...shown.json.data.content };
  assert.equal(fields.kind, 'source');
  assert.equal(fields.raw, 'raw/2026-10-30-acme-report.md');
  assert.equal(fields.raw_sha256, sha(stored));
  assert.equal(fields.input_sha256, sha(input));
  assert.equal(fields.sourceDate, '2026-10-30');
  assert.equal(fields.processed, false);
  assert.equal(fields.source, 'web');
  const events = readEvents(f.open());
  assert.equal(events.at(-1).op, 'ingest');
  assert.deepEqual(events.at(-1).targets.map((item) => item.path), ['raw/2026-10-30-acme-report.md', 'research/acme-report.md']);
  // Raw text is searchable, but never a page.
  const found = await f.run(['search', 'second', '--type', 'raw']);
  assert.deepEqual(found.json.data.items.map((item) => item.path), ['raw/2026-10-30-acme-report.md']);
  const notes = await f.run(['note', 'list', '--all']);
  assert.ok(notes.json.data.items.every((item) => !item.path.startsWith('raw/')));
});

test('without a url there is no Source line and no source field; the date defaults to today', async (t) => {
  const f = setup(t);
  const response = await f.run(['ingest', '--title', 'Plain', '--body', '-', '--actor', 'codex'], { stdin: 'text' });
  assert.equal(response.code, 0, response.stdout);
  assert.equal(response.json.data.raw.path, 'raw/2026-11-01-plain.md');
  assert.equal(readFileSync(join(f.data, 'raw/2026-11-01-plain.md'), 'utf8'), 'Date: 2026-11-01\n\ntext');
  const text = readFileSync(join(f.data, response.json.data.research.path), 'utf8');
  assert.doesNotMatch(text, /^source:/mu);
  assert.match(text, /^processed: false$/mu);
});

test('the same input with another date or url is a duplicate and writes nothing', async (t) => {
  const f = setup(t);
  const first = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--date', '2026-10-01', '--actor', 'codex'], { stdin: 'same bytes' });
  assert.equal(first.code, 0, first.stdout);
  const before = files(f.data);
  const again = await f.run(['ingest', '--title', 'Other title', '--body', '-', '--date', '2026-10-02', '--url', 'https://example.test/b',
    '--actor', 'codex'], { stdin: 'same bytes' });
  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.json.data.duplicate, true);
  assert.ok(again.json.warnings.includes('duplicate_source'));
  assert.equal(again.json.data.research.path, first.json.data.research.path);
  assert.equal(again.json.data.raw.path, first.json.data.raw.path);
  assert.equal(again.json.data.input_sha256, first.json.data.input_sha256);
  assert.deepEqual(files(f.data), before);
});

test('tr-wiki writes the physical field names and value aliases', async (t) => {
  const f = setup(t, 'tr-wiki');
  const response = await f.run(['ingest', '--title', 'Örnek Kaynak', '--body', '-', '--date', '2026-10-30', '--actor', 'codex'],
    { stdin: 'metin' });
  assert.equal(response.code, 0, response.stdout);
  assert.equal(response.json.data.research.path, 'wiki/kaynaklar/ornek-kaynak.md');
  const text = readFileSync(join(f.data, 'wiki/kaynaklar/ornek-kaynak.md'), 'utf8');
  assert.match(text, /^tur: kaynak$/mu);
  assert.match(text, /^ham: raw\/2026-10-30-ornek-kaynak\.md$/mu);
  assert.match(text, /^kaynak_tarihi: ["']?2026-10-30["']?$/mu);
  assert.doesNotMatch(text, /^(?:kind|raw|sourceDate):/mu);
  const shown = await f.run(['research', 'show', '@wiki/kaynaklar/ornek-kaynak']);
  assert.equal(shown.json.data.meta.kind, 'source');
  assert.equal(shown.json.data.meta.sourceDate, '2026-10-30');
  assert.ok(!Object.hasOwn(shown.json.data.content, 'ham') && !Object.hasOwn(shown.json.data.meta, 'tur'));
});

test('binary, invalid UTF-8, oversized and over --max-bytes input are validation errors', async (t) => {
  const f = setup(t);
  const dir = tempDir(t);
  const cases = {
    'nul.txt': Buffer.from('text\0more'), 'latin1.txt': Buffer.from([0x61, 0xe7, 0xfe]),
    'big.md': Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), 'image.png': Buffer.from('plain'),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    writeFileSync(join(dir, name), bytes);
    const response = await f.run(['ingest', '--title', 'X', '--file', join(dir, name), '--actor', 'codex']);
    assert.equal(response.code, 5, `${name}: ${response.stdout}`);
    assert.equal(response.json.error.code, 'validation');
  }
  const stdin = await f.run(['ingest', '--title', 'X', '--body', '-', '--actor', 'codex'], { stdin: Buffer.from([0xc3, 0x28]) });
  assert.equal(stdin.code, 5);
  const capped = await f.run(['ingest', '--title', 'X', '--body', '-', '--max-bytes', '10', '--actor', 'codex'], { stdin: '01234567890' });
  assert.equal(capped.code, 5);
  const big = await f.run(['ingest', '--title', 'X', '--body', '-', '--actor', 'codex'], { stdin: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61) });
  assert.equal(big.code, 5);
  const fits = await f.run(['ingest', '--title', 'X', '--body', '-', '--max-bytes', '10', '--actor', 'codex'], { stdin: '0123456789' });
  assert.equal(fits.code, 0, fits.stdout);
  for (const args of [['--title', 'X'], ['--title', 'X', '--body', '-', '--file', join(dir, 'nul.txt')], ['--body', '-']]) {
    const response = await f.run(['ingest', ...args, '--actor', 'codex']);
    assert.ok([2, 5].includes(response.code), `${args.join(' ')}: ${response.stdout}`);
  }
  for (const extra of [['--date', '2026-02-30'], ['--url', 'https://example.test/a\nDate: 1999-01-01'], ['--into', 'notes'],
    ['--into', '../raw'], ['--project', 'p-000000']]) {
    const response = await f.run(['ingest', '--title', 'Y', '--body', '-', ...extra, '--actor', 'codex'], { stdin: 'unique ' + extra[1] });
    assert.ok([3, 5].includes(response.code), `${extra.join(' ')}: ${response.stdout}`);
  }
  const missing = await f.run(['ingest', '--title', 'X', '--file', join(dir, 'absent.md'), '--actor', 'codex']);
  assert.equal(missing.code, 3);
  const actorless = await f.run(['ingest', '--title', 'X', '--body', '-']);
  assert.equal(actorless.json.error.code, 'actor_required');
});

test('--into places the raw file in a raw subfolder and --project links the record', async (t) => {
  const f = setup(t);
  const project = await f.run(['project', 'add', '--title', 'ornek-proje', '--actor', 'codex']);
  const response = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--into', 'raw/arastirma', '--date', '2026-10-30',
    '--project', project.json.data.id, '--actor', 'codex'], { stdin: 'deep' });
  assert.equal(response.code, 0, response.stdout);
  assert.equal(response.json.data.raw.path, 'raw/arastirma/2026-10-30-acme.md');
  assert.ok(existsSync(join(f.data, 'raw/arastirma/2026-10-30-acme.md')));
  const shown = await f.run(['research', 'show', response.json.data.research.path.replace(/^/u, '@').replace(/\.md$/u, '')]);
  assert.equal({ ...shown.json.data.meta, ...shown.json.data.content }.project, project.json.data.id);
  // A second source with the same title and date gets its own raw file.
  const second = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--into', 'raw/arastirma', '--date', '2026-10-30',
    '--actor', 'codex'], { stdin: 'other' });
  assert.equal(second.json.data.raw.path, 'raw/arastirma/2026-10-30-acme-2.md');
  assert.equal(second.json.data.research.path, 'research/acme-2.md');
});

test('--dry-run returns both paths, the input digest and the duplicate flag, and writes nothing', async (t) => {
  const f = setup(t);
  const before = files(f.data);
  const response = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--date', '2026-10-30', '--dry-run', '--actor', 'codex'],
    { stdin: 'preview' });
  assert.equal(response.code, 0, response.stdout);
  assert.equal(response.json.data.raw.path, 'raw/2026-10-30-acme.md');
  assert.equal(response.json.data.research.path, 'research/acme.md');
  assert.equal(response.json.data.input_sha256, sha('preview'));
  assert.equal(response.json.data.duplicate, false);
  assert.deepEqual(files(f.data), before);
  await f.run(['ingest', '--title', 'Acme', '--body', '-', '--actor', 'codex'], { stdin: 'preview' });
  const after = files(f.data);
  const duplicate = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--dry-run', '--actor', 'codex'], { stdin: 'preview' });
  assert.equal(duplicate.json.data.duplicate, true);
  assert.deepEqual(files(f.data), after);
});

test('Review Focus 5: BOM and CRLF stdin bytes are stored exactly and --file with the same bytes is a duplicate', async (t) => {
  const f = setup(t);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Başlık\r\nikinci satır\r\n\r\nson')]);
  const response = await f.run(['ingest', '--title', 'Bom', '--body', '-', '--date', '2026-10-30', '--actor', 'codex'], { stdin: bytes });
  assert.equal(response.code, 0, response.stdout);
  const stored = readFileSync(join(f.data, response.json.data.raw.path));
  assert.ok(stored.equals(Buffer.concat([Buffer.from('Date: 2026-10-30\n\n'), bytes])));
  assert.equal(response.json.data.input_sha256, sha(bytes));
  // A real process reads stdin as bytes too.
  const spawned = await spawnCli(['ingest', '--title', 'Bom spawned', '--body', '-', '--dry-run', '--actor', 'codex', '--json'],
    { home: f.home, data: f.data, stdin: bytes });
  assert.equal(spawned.json.data.input_sha256, sha(bytes));
  assert.equal(spawned.json.data.duplicate, true);
  const dir = tempDir(t);
  writeFileSync(join(dir, 'source.md'), bytes);
  const again = await f.run(['ingest', '--title', 'Bom again', '--file', join(dir, 'source.md'), '--actor', 'codex']);
  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.json.data.input_sha256, sha(bytes));
  assert.equal(again.json.data.duplicate, true);
});

test('undo moves both files to the trash; raw files stay otherwise untouchable', async (t) => {
  const f = setup(t);
  const response = await f.run(['ingest', '--title', 'Acme', '--body', '-', '--actor', 'codex'], { stdin: 'undo me' });
  const { raw, research } = response.json.data;
  const undone = await f.run(['undo', '--actor', 'codex']);
  assert.equal(undone.code, 0, undone.stdout);
  assert.equal(existsSync(join(f.data, raw.path)), false);
  assert.equal(existsSync(join(f.data, research.path)), false);
  assert.deepEqual(trashList(f.open()).map((item) => item.path).sort(), [raw.path, research.path]);
  // A raw file changed after its ingest is no longer the ingest's own file: undo refuses and leaves it alone.
  const second = await f.run(['ingest', '--title', 'Kept', '--body', '-', '--actor', 'codex'], { stdin: 'keep me' });
  writeFileSync(join(f.data, second.json.data.raw.path), 'edited by hand');
  const refused = await f.run(['undo', '--actor', 'codex']);
  assert.equal(refused.json.error.code, 'conflict');
  assert.equal(readFileSync(join(f.data, second.json.data.raw.path), 'utf8'), 'edited by hand');
  assert.ok(existsSync(join(f.data, second.json.data.research.path)));
  // Raw paths are never entities: update and rm through them are refused.
  for (const args of [['research', 'update', `@${second.json.data.raw.path.slice(0, -3)}`, '--title', 'x'],
    ['note', 'rm', `@${second.json.data.raw.path.slice(0, -3)}`]]) {
    const result = await f.run([...args, '--actor', 'codex']);
    assert.ok(['validation', 'not_found'].includes(result.json.error.code), args.join(' '));
  }
  assert.equal(readFileSync(join(f.data, second.json.data.raw.path), 'utf8'), 'edited by hand');
});

test('a crash recovers both files together', async (t) => {
  for (const point of ['after-check', 'before-rename', 'after-rename']) {
    const f = setup(t);
    const crashed = await spawnCli(['ingest', '--title', 'Acme', '--body', '-', '--date', '2026-10-30', '--actor', 'codex', '--json'],
      { home: f.home, data: f.data, stdin: 'crash', env: { CAIRN_TEST_CRASH: point } });
    assert.notEqual(crashed.code, 0, point);
    const ctx = f.open();
    const present = ['raw/2026-10-30-acme.md', 'research/acme.md'].map((path) => existsSync(join(f.data, path)));
    assert.deepEqual(present, point === 'after-rename' ? [true, true] : [false, false], point);
    assert.deepEqual(readdirSync(join(f.data, '.cairn/pending')).filter((name) => name.endsWith('.json')), [], point);
    assert.equal(readEvents(ctx).filter((event) => event.op === 'ingest').length, point === 'after-rename' ? 1 : 0);
  }
  // A crash between the two renames: one file in place, then recovery rolls both back.
  const f = setup(t);
  const ctx = f.open();
  let count = 0;
  ctx.faults = (point) => { if (point === 'before-rename' && ++count === 2) throw new Error('crashed'); };
  assert.throws(() => ingest(ctx, { title: 'Acme', bytes: Buffer.from('half'), date: '2026-10-30' }), /crashed/u);
  assert.ok(existsSync(join(f.data, 'raw/2026-10-30-acme.md')));
  delete ctx.faults;
  assert.equal(recover(ctx).rolledBack, 1);
  assert.equal(existsSync(join(f.data, 'raw/2026-10-30-acme.md')), false);
  assert.equal(existsSync(join(f.data, 'research/acme.md')), false);
});

test('core ingest validates its input and bounds related results', (t) => {
  const f = setup(t);
  const ctx = f.open();
  for (const input of [{ title: '', bytes: Buffer.from('x') }, { title: 'X', bytes: 'not a buffer' },
    { title: 'X', bytes: Buffer.from('x'), maxBytes: 0 }, { title: 'X', bytes: Buffer.from('x'), into: 'raw/.hidden' }]) {
    assert.throws(() => ingest(ctx, input), { code: 'validation' });
  }
  for (let i = 0; i < 12; i++) {
    const created = ingest(ctx, { title: `Zorblax page ${i}`, bytes: Buffer.from(`word ${i}`), date: '2026-10-30' });
    assert.equal(created.duplicate, false);
  }
  const result = ingest(ctx, { title: 'Zorblax summary', bytes: Buffer.from('zorblax\nsecond\nthird\nfourth'), date: '2026-10-30' },
    { dryRun: true });
  assert.ok(result.related.length <= 10 && result.related.length > 0);
  assert.ok(result.related.every((item) => Object.keys(item).join() === 'path,content' && typeof item.content.title === 'string'));
});
