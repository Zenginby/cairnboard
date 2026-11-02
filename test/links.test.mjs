import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks, parseJournal } from '../core/links.mjs';
import { PRESETS } from '../core/presets.mjs';

test('wiki links keep fields and lines, excluding fenced and inline code', () => {
  const text = '---\nsources: ["[[source]]"]\n---\n[[a]] [[a|label]] [[a#Heading]] [[dir/a.md]]\n`[[hidden]]` ``code ` [[hidden]]`` [[visible]]\n~~~md\n[[hidden]]\n~~~\n';
  assert.deepEqual(parseLinks(text, { frontmatter: { sources: ['[[source]]'] }, frontmatterText: null }), [
    { field: 'sources', expr: '[[source]]', targetName: 'source', heading: null, line: 2 },
    { field: null, expr: '[[a]]', targetName: 'a', heading: null, line: 4 },
    { field: null, expr: '[[a|label]]', targetName: 'a', heading: null, line: 4 },
    { field: null, expr: '[[a#Heading]]', targetName: 'a', heading: 'Heading', line: 4 },
    { field: null, expr: '[[dir/a.md]]', targetName: 'dir/a', heading: null, line: 4 },
    { field: null, expr: '[[visible]]', targetName: 'visible', heading: null, line: 5 },
  ]);
});

test('invalid frontmatter links are recovered without assigning a field', () => {
  const text = '---\nsources: ["[[acme#part|label]]"\n---\n[[body]]';
  assert.deepEqual(parseLinks(text, { frontmatter: null, frontmatterText: 'sources: ["[[acme#part|label]]"\n' }).map((link) => [link.targetName, link.field, link.line]),
    [['acme', null, 2], ['body', null, 4]]);
});

test('journal entries recognize both languages, labels, continuation lines and processed lessons', () => {
  const text = '# Day\n## Topic: Work · acme\n- **Tuzak:** Trap → [[x]]\n- Ders: Learn\n- Discovery: Find\n  more [[y]]\n- Decision: Choose → [[x]]\n- Plain\n```\n- Lesson: Hidden\n```\n## No colon\n- **Keşif:** New\n';
  const entries = parseJournal(text, PRESETS.default.entryTypes);
  assert.deepEqual(entries.map(({ heading, label, type, line, processed, links }) => ({ heading, label, type, line, processed, links })), [
    { heading: 'Work', label: 'acme', type: 'pitfall', line: 3, processed: true, links: ['x'] },
    { heading: 'Work', label: 'acme', type: 'lesson', line: 4, processed: false, links: [] },
    { heading: 'Work', label: 'acme', type: 'discovery', line: 5, processed: false, links: ['y'] },
    { heading: 'Work', label: 'acme', type: 'decision', line: 7, processed: false, links: ['x'] },
    { heading: 'Work', label: 'acme', type: null, line: 8, processed: false, links: [] },
    { heading: 'No colon', label: null, type: 'discovery', line: 13, processed: false, links: [] },
  ]);
  assert.equal(entries[2].text, 'Find\nmore [[y]]');
});

test('backtick delimiters must match exactly, including code spans crossing lines', () => {
  const text = '`unclosed [[a]]\n\n``[[hidden]]`still hidden`` [[b]]\n`code\n[[hidden]]` [[c]]';
  assert.deepEqual(parseLinks(text).map((link) => [link.targetName, link.line]), [['b', 3], ['c', 5]]);
  assert.deepEqual(parseLinks('``unclosed [[a]] `code` [[b]]').map((link) => link.targetName), ['a', 'b']);
});

test('frontmatter values support nested collections and cyclic aliases safely', () => {
  const frontmatter = { sources: { pages: ['[[a]]'] } };
  frontmatter.loop = frontmatter;
  assert.equal(parseLinks('---\nsources:\n  pages: ["[[a]]"]\n---\n', { frontmatter })[0].line, 3);
});

test('aliases used in different fields retain each field attribution', () => {
  const pages = ['[[a]]'];
  assert.deepEqual(parseLinks('---\nsources: &pages ["[[a]]"]\nrelated: *pages\n---\n',
    { frontmatter: { sources: pages, related: pages } }).map((link) => link.field), ['sources', 'related']);
});
