import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { scanText, formatFindings } from './scan.mjs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  const findings = [];
  const scan = (text, file) => findings.push(...scanText(text, { file }));
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
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

  const patch = git('log', '--all', '--root', '--full-history', '-m', '--format=',
    '--patch', '--text', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv');
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
  scan(git('log', '--all', '--format=%B%n%an%n%cn', '--no-patch'), 'messages');
  scan(git('for-each-ref', '--format=%(refname)'), 'refs');

  const identities = git('log', '--all', '--format=%ae%x00%ce%x00', '--no-patch');
  for (const [index, identity] of identities.split('\0').slice(0, -1).entries()) {
    const email = identity.replace(/^\n/, '');
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
