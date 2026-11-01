import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CairnError } from '../core/errors.mjs';
import {
  parseFile, setFields, sectionRange, appendToSection, replaceBody,
  acceptanceItems, acceptanceCounts, setAcceptance,
} from '../core/frontmatter.mjs';

const errorCode = (code) => (error) => error instanceof CairnError && error.code === code;

const cases = [
  ['title: A # not\nx-k: 1\n', { title: 'B' }, 'title: B # not\nx-k: 1\n'],
  ['tags:\n  - a\n  - b\nx-k: 1\n', { tags: ['a', 'c'] }, 'tags: [a, c]\nx-k: 1\n'],
  ['d: |\n  l1\n  l2\nx: 1\n', { d: 'z' }, 'd: z\nx: 1\n'],
  ['k:\nx: 1\n', { k: 'v' }, 'k: v\nx: 1\n'],
  ['k:\nx: 1\n', { x: undefined }, 'k:\n'],
];

for (const eol of ['\n', '\r\n']) {
  for (const bom of ['', '\uFEFF']) {
    test(`field edits preserve comments, boundaries, BOM=${!!bom}, EOL=${JSON.stringify(eol)}`, () => {
      const wrap = (yaml) => bom + `---\n${yaml}---\nbody\n`.replaceAll('\n', eol);
      for (const [yaml, patch, expected] of cases) {
        assert.equal(setFields(wrap(yaml), patch), wrap(expected));
      }
      const body = '# Örnek\nBody\r\nNo final newline';
      const text = bom + body;
      const expected = bom + `---${eol}id: c-acme12${eol}---${eol}` + body;
      // The first newline determines the EOL for a file without frontmatter.
      assert.equal(setFields(text.replace('# Örnek\n', `# Örnek${eol}`), { id: 'c-acme12' }),
        expected.replace('# Örnek\n', `# Örnek${eol}`));
    });
  }
}

test('parse reports UTF-16 offsets, body and absent frontmatter', () => {
  const text = '\uFEFF---\r\ntitle: 🪨 Örnek\r\n---\r\nbody';
  assert.deepEqual(parseFile(text), {
    bom: true, eol: '\r\n', hasFrontmatter: true, data: { title: '🪨 Örnek' },
    error: null, editable: true, yamlStart: 6, yamlEnd: text.indexOf('---', 6),
    bodyStart: text.indexOf('body'), body: 'body',
  });
  assert.deepEqual(parseFile('\uFEFFbody'), {
    bom: true, eol: '\n', hasFrontmatter: false, data: null, error: null,
    editable: false, yamlStart: 1, yamlEnd: 1, bodyStart: 1, body: 'body',
  });
  assert.equal(parseFile('--- later\nbody').hasFrontmatter, false);
  assert.equal(parseFile('---\nk: v\n---').body, '');
});

test('valid unsupported YAML is readable but cannot be edited', () => {
  for (const yaml of [
    '{title: A, x: 1}\n', 'title: &t A\nx-ref: *t\n', 'x: !!str 1\n',
    'x: {nested: &a value}\n', '- a\n', 'scalar\n', '', 'a: 1\n...\nb: 2\n',
  ]) {
    const text = `---\n${yaml}---\nbody`;
    const parsed = parseFile(text);
    assert.equal(parsed.error, null, yaml);
    assert.equal(parsed.editable, false, yaml);
    assert.throws(() => setFields(text, { title: 'B' }), errorCode('unsupported_frontmatter'));
  }
  assert.deepEqual(parseFile('---\ntitle: &t A\nx-ref: *t\n---\n').data,
    { title: 'A', 'x-ref': 'A' });
  assert.equal(parseFile('---\nx: "& * !" # &not-an-anchor\n---\n').editable, true);
});

test('malformed YAML never throws while parsing and fails validation on edits', () => {
  for (const text of ['---\nx: [\n---\n', '---\nx: 1\nx: 2\n---\n', '---\nx: 1']) {
    const parsed = parseFile(text);
    assert.equal(typeof parsed.error, 'string');
    assert.equal(parsed.editable, false);
    assert.throws(() => setFields(text, { x: 2 }), errorCode('validation'));
  }
});

test('writes single-line YAML values, including nested strings and special keys', () => {
  const text = '---\nx: 1 # keep\n---\n';
  for (const value of ['a\nb', 'a\r\nb', 'a: b', 'null', ['a\nb', 'c'], { nested: 'a\nb' }]) {
    const result = setFields(text, { x: value });
    assert.equal(result.split('\n').length, text.split('\n').length);
    assert.deepEqual(parseFile(result).data.x, value);
  }
  assert.equal(setFields(text, { x: 'a\nb' }), '---\nx: "a\\nb" # keep\n---\n');
  const patch = { 'a: b': 'yes', 'a\nb': 'value', 'x-new': ['a', 'b'] };
  assert.deepEqual(parseFile(setFields(text, patch)).data, { x: 1, ...patch });
  assert.equal(setFields('body', { missing: undefined }), 'body');
});

test('multiline pairs are replaced through the next key line, including old comments', () => {
  const text = '---\n# header\n"title": "A" # inline\ntags: [\n  a, b\n] # old\n# old block comment\nx: 1\n---\nbody';
  assert.equal(setFields(text, { title: 'B', tags: ['c'] }),
    '---\n# header\n"title": B # inline\ntags: [c]\nx: 1\n---\nbody');
  assert.equal(setFields('---\nk: # keep\nx: 1\n---\n', { k: 'v' }),
    '---\nk: v # keep\nx: 1\n---\n');
  assert.equal(setFields('---\nk:\n  nested: 1\nx: 2\n---\n', { k: false }),
    '---\nk: false\nx: 2\n---\n');
});

test('root indentation and adjacent edits preserve a valid mapping', () => {
  assert.equal(setFields('---\n  tags:\n    - a\n  x: 1\n---\nbody', { tags: ['b'], z: 2 }),
    '---\n  tags: [b]\n  x: 1\n  z: 2\n---\nbody');
  assert.equal(setFields('---\na: 1\nb: 2\nc: 3\n---\nbody',
    { a: undefined, b: ['x'], c: undefined, d: true }), '---\nb: [x]\nd: true\n---\nbody');
  assert.equal(setFields('---\na: 1\n---\nbody', { a: undefined }), '---\n---\nbody');
});

test('a document end marker permits scalar edits but rejects appending a second document', () => {
  const text = '---\nx: 1\n...\n---\nbody';
  assert.equal(setFields(text, { x: 2 }), text.replace('x: 1', 'x: 2'));
  assert.throws(() => setFields(text, { y: 2 }), errorCode('unsupported_frontmatter'));
});

test('mixed line endings and a missing final newline survive scalar patches', () => {
  const text = '\uFEFF---\r\ntitle: 🪨 A # keep\nx: 1\r\n---\nbody';
  assert.equal(setFields(text, { title: 'B' }), text.replace('🪨 A', 'B'));
  assert.equal(replaceBody(text, 'new\r\nbody'), text.slice(0, text.indexOf('body')) + 'new\r\nbody');
  assert.equal(replaceBody('\uFEFFbody', 'new'), '\uFEFFnew');
});

test('section ranges include the heading and ignore fenced headings', () => {
  const text = '---\nx: |\n  ## Comments\n---\n## Acceptance\n- [ ] one\n```md\n## Comments\n```\n~~~\n## Comments\n~~~\n## Comments\nlast';
  const start = text.indexOf('## Acceptance');
  const end = text.lastIndexOf('## Comments');
  assert.deepEqual(sectionRange(text, 'Acceptance'), [start, end]);
  assert.deepEqual(sectionRange(text, 'Comments'), [end, text.length]);
  assert.equal(sectionRange(text, 'Missing'), null);
});

test('section appends use file EOL and preserve all existing text', () => {
  assert.equal(appendToSection('## Comments\nold\n## Next\nnext', 'Comments', ['new']),
    '## Comments\nold\nnew\n## Next\nnext');
  assert.equal(appendToSection('body', 'Comments', ['new']), 'body\n\n## Comments\n\nnew\n');
  assert.equal(appendToSection('', 'Comments', ['new']), '## Comments\n\nnew\n');
  assert.equal(appendToSection('\uFEFF---\r\nx: 1\r\n---\r\nbody', 'Comments', ['a', 'b']),
    '\uFEFF---\r\nx: 1\r\n---\r\nbody\r\n\r\n## Comments\r\n\r\na\r\nb\r\n');
  assert.equal(appendToSection('body', 'Comments', []), 'body');
  assert.equal(appendToSection('---\nx: 1\n---', 'Comments', ['new']),
    '---\nx: 1\n---\n## Comments\n\nnew\n');
});

test('acceptance items have body line numbers and exclude fences and other sections', () => {
  const body = '# Title\r\n## Acceptance\r\n- [ ] first\r\n````md\r\n- [ ] hidden\r\n```\r\n## Comments\r\n````\r\n- [x] second\r\n~~~\r\n- [ ] hidden\r\n~~~\r\n## Comments\r\n- [ ] other';
  assert.deepEqual(acceptanceItems(body), [
    { line: 3, checked: false, text: 'first' },
    { line: 9, checked: true, text: 'second' },
  ]);
  assert.deepEqual(acceptanceCounts(body), { done: 1, total: 2 });
  const text = '\uFEFF---\r\nx: 1\r\n---\r\n' + body;
  const result = setAcceptance(text, 2, false);
  const index = text.indexOf('[x]') + 1;
  assert.equal(result, text.slice(0, index) + ' ' + text.slice(index + 1));
  assert.equal(setAcceptance(result, 2, false), result);
  for (const n of [0, -1, 3, 1.5, NaN]) {
    assert.throws(() => setAcceptance(text, n, true), errorCode('validation'));
  }
  assert.deepEqual(acceptanceCounts('## Comments\n- [ ] other'), { done: 0, total: 0 });
  assert.deepEqual(acceptanceItems('## Acceptance\n- [ ]\n- [X] done'), [
    { line: 2, checked: false, text: '' }, { line: 3, checked: true, text: 'done' },
  ]);
  assert.deepEqual(acceptanceCounts('---\n## Acceptance\n- [ ] item\n---'), { done: 0, total: 1 });
});
