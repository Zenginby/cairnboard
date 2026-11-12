import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedLinkScheme, extractProjectLinks } from '../core/project-links.mjs';

test('isAllowedLinkScheme allows only https:, http: and obsidian:', () => {
  for (const url of [
    'https://example.com/docs',
    'http://localhost:4321/path?q=1',
    'obsidian://open?vault=Workspace&file=notes%2Findex',
  ]) {
    assert.equal(isAllowedLinkScheme(url), true, url);
  }
});

test('isAllowedLinkScheme allows only the open action of obsidian: with a vault and a file', () => {
  for (const url of [
    'obsidian://vault/Workspace/Note',
    'obsidian://open?vault=Workspace',
    'obsidian://open?vault=Workspace&file=Note&extra=1',
    'obsidian://open?vault=Workspace&file=Note#heading',
    'obsidian://open/path?vault=Workspace&file=Note',
    'obsidian://new?vault=Workspace&file=Note',
    'obsidian://advanced-uri?vault=Workspace&commandid=run',
  ]) {
    assert.equal(isAllowedLinkScheme(url), false, url);
  }
});

test('isAllowedLinkScheme handles mixed case and rejects disallowed schemes and whitespace', () => {
  for (const url of [
    'HTTPS://example.com/spec',
    'Http://example.com/a',
    'Obsidian://open?vault=Work&file=Home',
  ]) {
    assert.equal(isAllowedLinkScheme(url), true, url);
  }
  for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript://comment%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DaTa:text/plain,hello',
    'vbscript:msgbox(1)',
    'mailto:reader@example.com',
    'ftp://files.example.com/archive.zip',
    'file:///etc/passwd',
    ' https://example.com',
    '\thttps://example.com',
    '\nhttps://example.com',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'https:example.com',
    '//evil.test/path',
    '/notes/n-000001',
    './relative',
    '#anchor',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isAllowedLinkScheme(url), false, String(url));
  }
});

test('extractProjectLinks preserves order, deduplicates, strips disallowed schemes and ignores code', () => {
  const markdown = [
    '# Project',
    '',
    'Read [Architecture **Spec**](https://www.docs.example.com/spec) and '
      + '[Vault](obsidian://open?vault=Work&file=Plan).',
    'Duplicate [Spec again](https://www.docs.example.com/spec) and [Mixed](HTTPS://www.docs.example.com/spec).',
    'Plain autolink http://localhost:4000/status and [Ref link][r1].',
    'Bad [XSS](javascript:alert(1)), [Data](data:text/html,hi), [Mail](mailto:nobody), [Rel](/notes/n-000001).',
    'Code `[Ignored](https://ignored.example.com)` and fence:',
    '',
    '```md',
    '[Also ignored](https://fenced.example.com)',
    '```',
    '',
    '[r1]: https://api.example.org/v1',
  ].join('\n');

  assert.deepEqual(extractProjectLinks(markdown), [
    { href: 'https://www.docs.example.com/spec', label: 'Architecture Spec', host: 'docs.example.com', external: true },
    { href: 'obsidian://open?vault=Work&file=Plan', label: 'Vault', host: 'obsidian', external: false },
    { href: 'http://localhost:4000/status', label: 'http://localhost:4000/status', host: 'localhost', external: true },
    { href: 'https://api.example.org/v1', label: 'Ref link', host: 'api.example.org', external: true },
  ]);
  assert.deepEqual(extractProjectLinks('No links here.'), []);
});
