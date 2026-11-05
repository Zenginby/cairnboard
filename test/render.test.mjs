import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { renderMarkdown, RENDER_POLICY } from '../core/render.mjs';

const html = (markdown, resolveLink) => renderMarkdown(markdown, { resolveLink }).html;

test('raw HTML, comments, executable elements and attributes never reach the result', () => {
  for (const markdown of [
    '<script>alert(1)</script>', '<iframe src="https://example.com"></iframe>',
    '<object data="https://example.com"></object>', '<embed src="https://example.com">',
    '<svg><script>alert(1)</script></svg>', '<form><input autofocus onfocus="alert(1)"></form>',
    '<div style="color:red" onclick="alert(1)">raw block</div>',
    'Before <span style="color:red" onmouseover="alert(1)">inline</span> after',
    '<a id="location" name="document" href="javascript:alert(1)">raw</a>',
    '<!-- secret -->\n\nVisible <!-- inline secret --> end',
  ]) {
    const rendered = html(markdown);
    assert.doesNotMatch(rendered, /<(?:script|iframe|object|embed|svg|form|input|div|span|a)\b|\b(?:style|on\w+|id|name)=|<!--|secret/iu, markdown);
  }
  assert.equal(html('Before <b>inline</b> after'), '<p>Before inline after</p>');
  assert.equal(html('<div>raw block</div>'), '');
});

test('unsafe destinations become text, including obfuscated schemes and relative paths', () => {
  for (const url of [
    'javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'java&#x73;cript:alert%281%29',
    'java&#x09;script:alert%281%29', 'java&#x0a;script:alert%281%29',
    'javascript&colon;alert%281%29', 'java%73cript:alert%281%29',
    'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox%281%29',
    '//evil.test/a', '/%2fevil.test/a', '/%5cevil.test/a', 'foo.md', './foo', '../foo',
    'HTTPS://example.com', 'http%3A//example.com',
  ]) {
    assert.equal(html(`[label](${url})`), '<p>label</p>', url);
  }
  for (const url of ['java\tscript:alert(1)', 'java\nscript:alert(1)', 'javascript:\nalert(1)']) {
    assert.doesNotMatch(html(`[label](<${url}>)`), /<a\b|href=/u, url);
  }
  assert.equal(html('[**label**](javascript:bad)'), '<p>label</p>');
});

test('only supported destinations survive, with external rel and no target', () => {
  for (const url of ['http://example.com', 'https://example.com/a?q=1', 'mailto:reader@example.com', '/notes/n-000001', '#topic']) {
    const rendered = html(`[label](${url})`);
    assert.ok(rendered.includes(`href="${url}"`), url);
    assert.equal(rendered.includes('rel="noopener noreferrer"'), url.startsWith('http'));
    assert.doesNotMatch(rendered, /target=/u);
  }
});

test('Obsidian links require exactly the open endpoint and vault/file query keys', () => {
  assert.equal(html('[open](obsidian://open?vault=My%20Vault&file=notes%2Fpage)'),
    '<p><a href="obsidian://open?vault=My%20Vault&#x26;file=notes%2Fpage">open</a></p>');
  for (const url of ['obsidian://open', 'obsidian://open?vault=A', 'obsidian://open?file=B',
    'obsidian://other?vault=A&file=B', 'obsidian://open/?vault=A&file=B',
    'obsidian://open?vault=A&file=B&extra=C', 'obsidian://open?vault=A&file=B&file=C',
    'obsidian://open?vault=A&file=B#heading', 'obsidian://open?vault=&file=B',
    'obsidian://open@example.com?vault=A&file=B', 'OBSIDIAN://open?vault=A&file=B']) {
    assert.equal(html(`[open](${url})`), '<p>open</p>', url);
  }
});

test('images and reference images become safe links or plain alt text', () => {
  assert.equal(html('![remote](https://example.com/image.png)'),
    '<p><a href="https://example.com/image.png" rel="noopener noreferrer">remote</a></p>');
  assert.equal(html('![image][ref]\n\n[ref]: /image.png'), '<p><a href="/image.png">image</a></p>');
  for (const url of ['javascript:bad', 'data:image/png;base64,AA==', '//evil.test/image.png', 'image.png']) {
    assert.equal(html(`![alt](${url})`), '<p>alt</p>');
  }
  assert.doesNotMatch(html('<img src="https://example.com" onerror="alert(1)">'), /<img|onerror/u);
});

test('hidden characters are removed while ZWJ and ZWNJ remain', () => {
  const hidden = '\u202e\u2066\u2067\u2068\u2069\u200b';
  assert.equal(html(`a${hidden}b`), '<p>ab</p>');
  assert.equal(html('a\u200cb\u200dc'), '<p>a\u200cb\u200dc</p>');
});

test('wiki links use typed routes, labels and safe heading slugs', () => {
  const calls = [];
  assert.equal(html('[[Page.md#A heading!|Label]]', (target) => {
    calls.push(target);
    return { type: 'note', id: 'n-000001' };
  }), '<p><a class="wikilink" href="/notes/n-000001#a-heading">Label</a></p>');
  assert.deepEqual(calls, [{ targetName: 'Page', heading: 'A heading!' }]);
  for (const [type, id, route] of [['card', 'c-000001', 'cards'], ['project', 'p-000001', 'projects'],
    ['research', 'r-000001', 'research'], ['journal', '2026-11-01', 'journal']]) {
    assert.match(html('[[Page]]', () => ({ type, id })), new RegExp(`href="/${route}/${id}"`, 'u'));
  }
  for (const resolution of [null, { status: 'ambiguous' }, { type: 'unknown', id: 'n-000001' },
    { type: 'note', id: '//evil.test' }, { type: '__proto__', id: 'n-000001' }]) {
    assert.equal(html('[[Missing#Heading|Ghost]]', () => resolution),
      '<p><span class="wikilink wikilink-ghost">Ghost</span></p>');
  }
  assert.equal(html('[[Missing]]'), '<p><span class="wikilink wikilink-ghost">Missing</span></p>');
  assert.doesNotMatch(html('[[Page#"><script>alert(1)</script>|safe]]', () => ({ type: 'note', id: 'n-000001' })), /<script/u);
});

test('wiki syntax in code and existing link labels never resolves or creates nested links', () => {
  const resolve = () => assert.fail('code must not resolve links');
  assert.equal(html('`[[Page]]`', resolve), '<p><code>[[Page]]</code></p>');
  assert.equal(html('```md\n[[Page]]\n```', resolve), '<pre><code>[[Page]]\n</code></pre>');
  assert.equal(html('[[[Page]]](https://example.com)', resolve),
    '<p><a href="https://example.com" rel="noopener noreferrer">[[Page]]</a></p>');
});

test('GFM tables and disabled task list checkboxes survive the allow-list', () => {
  const tasks = html('- [x] Done\n- [ ] Pending');
  assert.match(tasks, /<ul class="contains-task-list">/u);
  assert.match(tasks, /<li class="task-list-item"><input type="checkbox" checked disabled>/u);
  assert.match(tasks, /<input type="checkbox" disabled>/u);
  assert.doesNotMatch(tasks, /\b(?:style|id|name|on\w+)=/u);
  const table = html('| A | B |\n| - | - |\n| one | two |');
  assert.match(table, /<table>/u);
  assert.match(table, /<th>A<\/th>/u);
  assert.match(table, /<td>two<\/td>/u);
});

test('oversized UTF-8 inputs return before parsing or resolving', () => {
  const markdown = 'é'.repeat(5 * 1024 * 1024 / 2 + 1);
  const start = performance.now();
  assert.deepEqual(renderMarkdown(markdown, { resolveLink: () => assert.fail('must not parse') }), { html: null, tooLarge: true });
  assert.ok(performance.now() - start < 1000);
});

test('cached output is identical and changed or missing link resolutions invalidate it', () => {
  assert.equal(typeof RENDER_POLICY, 'string');
  const markdown = 'Cache [[Target]]';
  const first = renderMarkdown(markdown, { resolveLink: () => ({ type: 'note', id: 'n-000001' }) });
  assert.deepEqual(renderMarkdown(markdown, { resolveLink: () => ({ type: 'note', id: 'n-000001' }) }), first);
  const changed = html(markdown, () => ({ type: 'note', id: 'n-000002' }));
  assert.match(changed, /\/notes\/n-000002/u);
  assert.doesNotMatch(changed, /n-000001/u);
  assert.match(html(markdown), /wikilink-ghost/u);
  assert.match(html(markdown, () => ({ type: 'card', id: 'c-000001' })), /\/cards\/c-000001/u);
});
