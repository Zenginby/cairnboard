import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../security/rules.mjs';
import { fixtureLines, scanLines, scanText, formatFindings } from '../security/scan.mjs';

const hexToken = '0123456789abcdef'.repeat(2) + '01234567'; // gitleaks:allow (fake test token)
const base64Token = 'AcmeZorblax0123456789+/'.repeat(2) + '=='; // gitleaks:allow (fake test token)
const identity = '1+zorblax@users.noreply.github.com';
const repository = 'github.com/zorblax/cairnboard';

test('RULES exposes the four built-in rule names', () => {
  assert.deepEqual(Object.keys(RULES), ['email', 'ipv4', 'home-path', 'token']);
});

const cases = [
  ['private email', 'mail me at a@b.com', ['email']], // cairn-scan:allow-fixture
  ['single-label localhost email', 'a@localhost', ['email']], // cairn-scan:allow-fixture
  ['single-label intranet email', 'a@intranet', ['email']], // cairn-scan:allow-fixture
  ['folded GitHub no-reply identity', 'ALLOW="111437340+someone@users noreply"', []], // cairn-scan:allow-fixture
  ['single-label email with slash in local part', 'a/b@intranet', ['email']], // cairn-scan:allow-fixture
  ['single-label email in URL credentials', 'https://a@localhost/x', ['email']], // cairn-scan:allow-fixture
  ['scoped package path', 'node_modules/@esbuild/linux-x64', []],
  ['example email', 'x@example.com', []],
  ['noreply email', identity, []],
  ['case-insensitive email domain', 'x@EXAMPLE.COM', []],
  ['email domain suffix', 'x@example.com.acme', ['email']], // cairn-scan:allow-fixture
  ['allowed and private emails together', 'x@example.com a@b.com', ['email']], // cairn-scan:allow-fixture
  ['private IPv4 address', '10.0.0.5', ['ipv4']], // cairn-scan:allow-fixture
  ['loopback IPv4 address', '127.0.0.1', []],
  ['unspecified IPv4 address', '0.0.0.0', []],
  ['invalid IPv4 address', '999.0.0.5', []],
  ['allowed and private IPv4 addresses together', '127.0.0.1 10.0.0.5', ['ipv4']], // cairn-scan:allow-fixture
  ['macOS home path', '/Users/acme/x', ['home-path']], // cairn-scan:allow-fixture
  ['Linux home path', '/home/acme/x', ['home-path']], // cairn-scan:allow-fixture
  ['volume path', '/Volumes/acme/x', ['home-path']], // cairn-scan:allow-fixture
  ['Windows home path', 'C:\\Users\\acme', ['home-path']], // cairn-scan:allow-fixture
  ['placeholder home path', '/Users/you/x', []],
  ['other placeholder home paths', '/home/user/x /Volumes/example/x C:\\Users\\you', []],
  ['placeholder prefix in real username', '/Users/youacme/x', ['home-path']], // cairn-scan:allow-fixture
  ['hex token', hexToken, ['token']],
  ['base64 token', base64Token, ['token']],
  ['minimum token length', 'a1'.repeat(16), ['token']],
  ['single long lowercase word is not a token', 'a'.repeat(40), []],
  ['short token', 'a'.repeat(31), []],
  ['SHA-256 integrity prefix', `sha256-${base64Token}`, []],
  ['SHA-512 integrity prefix', `"integrity": "sha512-${base64Token}"`, []],
  ['integrity prefix followed by another token', `sha512-${base64Token} ${hexToken}`, ['token']],
  ['unprefixed value in a lockfile integrity line is still scanned', `"integrity": "${base64Token}"`, ['token'], { file: 'package-lock.json' }],
  ['legacy sha1 integrity prefix', `"integrity": "sha1-${base64Token}"`, [], { file: 'package-lock.json' }],
  ['integrity field in ordinary source', `"integrity": "${base64Token}"`, ['token']],
  ['lockfile token outside integrity line', hexToken, ['token'], { file: 'package-lock.json' }],
  ['denylist term', 'Zorblax notes', ['denylist:0'], { terms: ['zorblax'] }],
  ['allowed email identity', identity, [], { terms: ['zorblax'], allowIdentities: [identity] }],
  ['allowed identity and separate term', `${identity} zorblax`, ['denylist:0'], { terms: ['zorblax'], allowIdentities: [identity] }],
  ['allowed repository identity', repository, [], { terms: ['zorblax'], allowIdentities: [repository] }],
  ['identity removal preserves word boundaries', `zor${repository}blax`, [], { terms: ['zorblax'], allowIdentities: [repository] }],
  ['allowed identity does not exempt personal data', 'a@b.com', ['email'], { allowIdentities: ['a@b.com'] }], // cairn-scan:allow-fixture
  ['multiple rules on one line', 'a@b.com 10.0.0.5 Zorblax zorblax', ['email', 'ipv4', 'denylist:0'], { terms: ['zorblax'] }], // cairn-scan:allow-fixture
  ['empty text', '', []],
];

for (const [name, text, rules, options] of cases) {
  test(`scanText detects or exempts ${name}`, () => {
    const opts = { file: 'fixture.txt', ...options };
    assert.deepEqual(scanText(text, opts), rules.map((rule) => ({ file: opts.file, line: 1, rule })));
  });
}

test('scanText counts CRLF and blank lines correctly', () => {
  assert.deepEqual(scanText('a\r\nb@c.com\r\n\r\nZorblax', { file: 'fixture.txt', terms: ['zorblax'] }), [ // cairn-scan:allow-fixture
    { file: 'fixture.txt', line: 2, rule: 'email' },
    { file: 'fixture.txt', line: 4, rule: 'denylist:0' },
  ]);
});

test('formatFindings emits only file, line and rule without matched text', () => {
  const findings = scanText('zorblax a@b.com', { file: 'fixture.txt', terms: ['zorblax'] }); // cairn-scan:allow-fixture
  const output = formatFindings(findings);
  assert.equal(output, 'fixture.txt:1 email\nfixture.txt:1 denylist:0');
  assert.equal(output.includes('zorblax'), false);
  assert.equal(output.includes('a@b.com'), false); // cairn-scan:allow-fixture
  assert.equal(formatFindings([]), '');
});

test('denylist terms next to punctuation are found and only their index is reported', () => {
  for (const line of ['"zorblax",', '(Zorblax)', 'zorblax: notes', "it's zorblax'", '[zorblax]']) {
    const findings = scanText(line, { file: 'a.json', terms: ['zorblax'] });
    assert.deepEqual(findings.map((f) => f.rule), ['denylist:0'], line);
  }
  const out = formatFindings(scanText('acme and zorblax', { file: 'a.md', terms: ['acme', 'zorblax'] }));
  assert.equal(out, 'a.md:1 denylist:0\na.md:1 denylist:1');
  assert.doesNotMatch(out, /zorblax|acme/);
});

test('commit trailer bot address is allowed, other anthropic addresses are not', () => {
  assert.deepEqual(scanText('Co-Authored-By: Claude <noreply@anthropic.com>', { file: 'msg' }), []);
  assert.equal(scanText('ali@anthropic.com', { file: 'msg' })[0].rule, 'email'); // cairn-scan:allow-fixture
});

test('security review regressions', () => {
  const rules = (line, opts = {}) => scanText(line, { file: 'x', ...opts }).map((f) => f.rule);
  // one malformed percent sequence does not stop the rest from decoding, double encoding unwraps
  assert.deepEqual(rules('100% off %7A%6F%72%62%6C%61%78', { terms: ['zorblax'] }), ['denylist:0']);
  assert.deepEqual(rules('%257A%256F%2572blax', { terms: ['zorblax'] }), ['denylist:0']);
  // compatibility forms fold before lowercasing
  assert.deepEqual(rules('ＺＯＲＢＬＡＸ', { terms: ['zorblax'] }), ['denylist:0']);
  // home paths in any case and with either separator
  for (const p of ['/users/ali/x', 'c:/Users/ali', 'C:\\\\users\\\\ali', '/HOME/ali']) assert.deepEqual(rules(p), ['home-path'], p); // cairn-scan:allow-fixture
  assert.deepEqual(rules('/Users/You/x'), []);
  // base64url and underscore tokens are caught, integrity hashes and plain identifiers are not
  assert.deepEqual(rules('key=AbCdEf0123_GhIjKl4567-MnOpQr89StUvWx'), ['token']); // gitleaks:allow (fake test token) cairn-scan:allow-fixture
  assert.deepEqual(rules('"integrity": "sha512-AbCdEf0123GhIjKl4567MnOpQr89StUvWxYz0123456789==" x=AbCdEf0123_GhIjKl4567-MnOpQr89StUvWx'), ['token']); // gitleaks:allow (fake test token) cairn-scan:allow-fixture
  assert.deepEqual(rules('"integrity": "sha512-AbCdEf0123GhIjKl4567MnOpQr89StUvWxYz0123456789=="'), []); // gitleaks:allow (fake test token)
  assert.deepEqual(rules('cairnboard-a0-repository-skeleton-and-leak-gate-plan'), []);
  assert.deepEqual(rules('2026-11-01-cairnboard-design-document-version-two'), []);
});

test('git commit references in messages are not tokens; a bare 40-hex value still is', () => {
  const rules = (line) => scanText(line, { file: 'x' }).map((f) => f.rule);
  assert.deepEqual(rules('This reverts commit e8b987e9fef9a07bcb8ec04a99336ae436dc8513.'), []);
  assert.deepEqual(rules('(cherry picked from commit e8b987e9fef9a07bcb8ec04a99336ae436dc8513)'), []);
  assert.deepEqual(rules('key e8b987e9fef9a07bcb8ec04a99336ae436dc8513'), ['token']); // cairn-scan:allow-fixture
});

test('identifier filter does not hide alternating letter-digit tokens', () => {
  assert.deepEqual(scanText('x7k2m9qz4f-p3w8r1t6y0-a9s2d5f8g1h4', { file: 'x' }).map((f) => f.rule), ['token']); // gitleaks:allow (fake test token) cairn-scan:allow-fixture
});

test('package registry paths with platform names are not tokens', () => {
  for (const arch of ['linux-mips64el', 'linux-s390x', 'linux-loong64', 'win32-arm64']) {
    const line = `"resolved": "https://registry.npmjs.org/@esbuild/${arch}/-/${arch}-0.28.2.tgz",`;
    assert.deepEqual(scanText(line, { file: 'x' }), [], line);
  }
});

test('nested node_modules paths are not tokens', () => {
  const line = '"node_modules/parse-entities/node_modules/@types/unist": {';
  assert.deepEqual(scanText(line, { file: 'x' }), [], line);
});

test('paths with short upper-case words are not tokens, long upper-case runs still are', () => {
  assert.deepEqual(scanText('design/experiments/01-cssom-csp/README.md', { file: 'x' }), []);
  assert.deepEqual(scanText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', { file: 'x' }).map((f) => f.rule), ['token']); // gitleaks:allow (fake test token) cairn-scan:allow-fixture
});

test('a diff marker before a repository path is not part of a token', () => {
  for (const line of ['+src/styles/fonts/inter-latin-ext-wght-normal.woff2', '    -src/styles/fonts/inter-latin-wght-normal.woff2', "['+src/styles/fonts/inter-latin-ext-wght-normal.woff2']"]) {
    assert.deepEqual(scanText(line, { file: 'x' }), [], line);
  }
  assert.deepEqual(scanText('+AbCdEf0123_GhIjKl4567-MnOpQr89StUvWx', { file: 'x' }).map((f) => f.rule), ['token']); // gitleaks:allow (fake test token) cairn-scan:allow-fixture
});

test('home paths count only from the root, not as a relative segment', () => {
  for (const line of ['design/prototypes/home/README.md', 'arrow/Home/End keys', 'docs/users/guide.md']) {
    assert.deepEqual(scanText(line, { file: 'x' }), [], line);
  }
  for (const line of ['/home/acme/x', 'file:///home/acme/x', "cd '/Users/acme'", 'x=/Volumes/acme/y', '(/home/acme)']) { // cairn-scan:allow-fixture
    assert.deepEqual(scanText(line, { file: 'x' }).map((f) => f.rule), ['home-path'], line);
  }
});

test('quoted allowed addresses stay allowed', () => {
  for (const line of ["'noreply@anthropic.com'", '"x@example.com"', '`1+zorblax@users.noreply.github.com`']) {
    assert.deepEqual(scanText(line, { file: 'x' }), [], line);
  }
  assert.equal(scanText("'ali@corp.test'", { file: 'x' })[0].rule, 'email'); // cairn-scan:allow-fixture
});

test('punctuation-only local parts are not addresses and do not crash', () => {
  assert.deepEqual(scanText("'@example.org `@corp.test", { file: 'x' }), []);
});

test('fixture marker skips generic rules but never the denylist', () => {
  const marker = ['cairn-scan', 'allow-fixture'].join(':');
  assert.deepEqual(scanText(`ali@corp.test 10.0.0.5 // ${marker}`, { file: 'x', fixtures: true }), []); // cairn-scan:allow-fixture
  assert.deepEqual(scanText(`zorblax // ${marker}`, { file: 'x', terms: ['zorblax'], fixtures: true }).map((f) => f.rule), ['denylist:0']);
});

test('fixture marker is ignored unless the caller marks the text as a test fixture', () => {
  const line = `ali@corp.test // ${['cairn-scan', 'allow-fixture'].join(':')}`; // cairn-scan:allow-fixture
  assert.deepEqual(scanText(line, { file: 'test/x.mjs' }).map((f) => f.rule), ['email']);
  assert.deepEqual(scanText(line, { file: 'x', fixtures: false }).map((f) => f.rule), ['email']);
  assert.deepEqual(scanText(line, { file: 'x', fixtures: true }), []);
});

test('fixture marker applies only to hunk lines of files under test/ in git log -p output', () => {
  const marked = `${['ali', 'corp.test'].join('@')} // ${['cairn-scan', 'allow-fixture'].join(':')}`;
  const diff = (minus, plus, hunk, body) => ['diff --git a/x b/x', 'index 1a2b..3c4d 100644', `--- ${minus}`, `+++ ${plus}`, hunk, ...body];
  const log = [
    '', 'T <t@example.com>', 'T <t@example.com>', `subject ${marked}`, '', // commit header and message: 1-5
    ...diff('a/test/x.mjs', 'b/test/x.mjs', '@@ -1,2 +1,2 @@', [' a', `-${marked}`, `+${marked}`, '\\ No newline at end of file']), // 6-14
    ...diff('a/src/x.mjs', 'b/src/x.mjs', '@@ -1,2 +1,2 @@', [' a', `-${marked}`, `+${marked}`]), // 15-22
    '', 'T <t@example.com>', 'T <t@example.com>', `next ${marked}`, '', // next commit right after a hunk: 23-27
    ...diff('a/test/old file.mjs', '/dev/null', '@@ -1,2 +0,0 @@', [`-${marked}`, `-${marked}`]), // 28-34
    ...diff('/dev/null', '"b/test/new\\tfile.mjs"', '@@ -0,0 +1,2 @@', [`+${marked}`, `+${marked}`]), // 35-41
    `+${marked}`, // past the hunk counts: commit text again, 42
  ].join('\n');
  const flags = fixtureLines(log);
  assert.deepEqual(flags.flatMap((flag, index) => (flag ? [index + 1] : [])), [11, 12, 13, 33, 34, 40, 41]);
  const findings = scanLines(log, flags, { file: 'push ref #1', terms: ['zorblax'] });
  assert.deepEqual(findings.map((f) => f.line), [4, 21, 22, 26, 42]);
  assert.ok(findings.every((f) => f.file === 'push ref #1' && f.rule === 'email'));
});

test('scanLines keeps line numbers and finds terms wrapped across fixture runs', () => {
  const text = 'a@b.com\nZorblax\nStudio\nx@c.com'; // cairn-scan:allow-fixture
  assert.deepEqual(scanLines(text, [false, false, true, true], { file: 'f', terms: ['zorblax studio'] }), [
    { file: 'f', line: 1, rule: 'email' },
    { file: 'f', line: 2, rule: 'denylist:0' },
    { file: 'f', line: 4, rule: 'email' },
  ]);
});

test('pinned actions and sha256 checksum lines are not tokens, other hex is', () => {
  const sha = '1a2b'.repeat(10);
  const sum = '3c4d'.repeat(16);
  const rules = (line) => scanText(line, { file: 'x' }).map((f) => f.rule);
  assert.deepEqual(rules(`      - uses: actions/checkout@${sha} # v7`), []);
  assert.deepEqual(rules(`+      - uses: actions/checkout@${sha} # v7`), []);
  assert.deepEqual(rules(`+token: ${sha}`), ['token']);
  assert.deepEqual(rules(`echo "${sum}  gitleaks.tar.gz" | sha256sum -c -`), []);
  assert.deepEqual(rules(`token: ${sha}`), ['token']);
  assert.deepEqual(rules(`sha256 ${sum} key=${'Ab9'.repeat(12)}`), ['token']);
});

test('malformed percent bytes cannot hide a denylist term', () => {
  assert.deepEqual(scanText('%FF%7A%6F%72%62%6C%61%78', { file: 'x', terms: ['zorblax'] }), [
    { file: 'x', line: 1, rule: 'denylist:0' },
  ]);
});

test('scanText finds split terms once on their first line', () => {
  const terms = ['zorblax studio'];
  assert.deepEqual(scanText('Zorblax\nStudio', { file: 'x', terms }), [
    { file: 'x', line: 1, rule: 'denylist:0' },
  ]);
  assert.deepEqual(scanText('Zorblax Studio\nacme', { file: 'x', terms }), [
    { file: 'x', line: 1, rule: 'denylist:0' },
  ]);
  assert.deepEqual(scanText('acme\nZorblax Studio', { file: 'x', terms }), [
    { file: 'x', line: 2, rule: 'denylist:0' },
  ]);
});

test('pinned action hashes exempt only the hash', () => {
  for (const prefix of ['', '+', '-']) {
    const line = `${prefix}  - uses: actions/checkout@${'1a2b'.repeat(10)} # key=${'Ab9'.repeat(12)}`;
    assert.deepEqual(scanText(line, { file: 'x' }), [{ file: 'x', line: 1, rule: 'token' }]);
  }
});

test('email exemptions leave single-label addresses beside package URLs and pinned actions visible', () => {
  for (const prefix of ['https://registry.npmjs.org/@scope/package', `  - uses: actions/checkout@${'1a2b'.repeat(10)} #`]) {
    assert.equal(RULES.email(`${prefix} ${['a', 'localhost'].join('@')}`), true);
  }
});

test('terms wrapped over several lines or blank lines are found once', () => {
  const terms = ['zorblax studio labs', 'zorblax studio'];
  const findings = scanText('Zorblax\nStudio\nLabs\n\nzorblax\n\nStudio\n', { file: 'f', terms });
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`).sort(), ['1:denylist:0', '1:denylist:1', '5:denylist:1']);
});

test('pattern rules can be skipped while the denylist still applies', () => {
  const token = 'A'.repeat(48); // cairn-scan:allow-fixture
  assert.deepEqual(scanText(`${token}\nzorblax`, { file: 'f', terms: ['zorblax'], patterns: false }).map((f) => f.rule), ['denylist:0']);
});

test('scanText detects denylist terms split by invisible characters', () => {
  for (const sample of ['zor\u200Bblax', 'zor\u00ADblax', 'zo\u200Cr\u200Dblax', 'Zor\uFEFFblax', 'zor%E2%80%8Bblax']) {
    const findings = scanText(sample, { file: 'x', terms: ['zorblax'] });
    assert.deepEqual(findings.map((f) => f.rule), ['denylist:0'], sample);
  }
});

test('scanText detects denylist terms written with escapes', () => {
  for (const sample of ['\\u0041cme', '\\u{41}cme', '\\x41cme', '&#65;cme', '&#65cme', '&#x41;cme', '&amp;#x41;cme', '%5Cu0041cme', 'acme&amp;zorblax']) {
    const findings = scanText(sample, { file: 'x', terms: ['acme'] });
    assert.deepEqual(findings.map((f) => f.rule), ['denylist:0'], sample);
  }
});

test('scanText detects bitişik yazım (camelCase, letter-digit, suffixes)', () => {
  for (const sample of ['ZorblaxClient', 'zorblax2', '2zorblax', 'Zorblaxlar', 'zorblaxian', 'Zor\u200BblaxClient']) {
    const findings = scanText(sample, { file: 'x', terms: ['zorblax'] });
    assert.deepEqual(findings.map((f) => f.rule), ['denylist:0'], sample);
  }
});

test('scanText avoids false positives on unrelated words and short substrings', () => {
  for (const sample of ['pacemaker', 'acmes', 'cacme', 'acmeist', 'zorba', 'an unrelated sentence']) {
    const findings = scanText(sample, { file: 'x', terms: ['acme', 'zorblax'] });
    assert.deepEqual(findings, [], sample);
  }
});
