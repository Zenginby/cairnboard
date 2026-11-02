import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { annotatedTags, git } from './git.mjs';
import { scanText, formatFindings } from './scan.mjs';

try {
  const findings = [];
  const scan = (text, file) => findings.push(...scanText(text, { file }));
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const [index, file] of files.entries()) {
    let stat;
    try {
      let parent = '.';
      for (const part of file.split('/').slice(0, -1)) {
        parent += `/${part}`;
        if (lstatSync(parent).isSymbolicLink()) throw new Error('unsafe parent');
      }
      stat = lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    // Scan link targets without reading outside the repository; skip submodules.
    if (stat.isSymbolicLink()) scan(readlinkSync(file), `file:${index}`);
    else if (stat.isFile()) scan(readFileSync(file, 'utf8'), `file:${index}`);
  }

  const patch = git(['-c', 'core.quotePath=false', 'log', '--all', '--root', '--full-history', '-m', '--format=',
    '--patch', '--text', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv']);
  let inHunk = false;
  // Keep source names and line positions, excluding Git's structural hashes.
  const payload = patch.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) inHunk = false;
    if (!inHunk && /^index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]+)?$/.test(line)) return '';
    if (line.startsWith('@@ ')) {
      inHunk = true;
      return line;
    }
    return inHunk && /^[ +\-]/.test(line) ? line.slice(1) : line;
  }).join('\n');
  scan(payload, 'history');
  const names = git(['log', '--all', '--root', '--full-history', '-m', '--format=', '--name-only', '-z']);
  for (const name of names.split('\0')) scan(name, 'history names');
  scan(git(['log', '--all', '--format=%B%n%an%n%cn', '--no-patch']), 'messages');
  scan(git(['for-each-ref', '--format=%(refname)']), 'refs');
  const tagEmails = [];
  for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/tags/']).split('\n').filter(Boolean)) {
    for (const tag of annotatedTags(ref)) {
      scan(tag.text, 'tags');
      findings.push(...scanText(tag.signature, { file: 'tags', patterns: false }));
      tagEmails.push(tag.email ?? '');
    }
  }

  const identities = git(['log', '--all', '--format=%ae%x00%ce%x00', '--no-patch']);
  const emails = identities.split('\0').slice(0, -1).map((identity) => identity.replace(/^\n/, ''));
  for (const [index, email] of [...emails, ...tagEmails].entries()) {
    const value = email.toLowerCase();
    if (!value.endsWith('@users.noreply.github.com') && value !== 'noreply@anthropic.com') {
      findings.push({ file: 'identities', line: index + 1, rule: 'identity' });
    }
  }

  if (findings.length) {
    process.stdout.write(`${formatFindings(findings)}\n`);
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('ci-scan failed\n');
  process.exitCode = 1;
}
