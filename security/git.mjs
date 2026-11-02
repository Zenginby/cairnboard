import { execFileSync } from 'node:child_process';

const maxBuffer = 512 * 1024 * 1024;

// Runs git without a shell; throws on a non-zero exit.
export function git(args, { cwd, input } = {}) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function gitBuffer(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}

// Peels a tag chain (a tag may point at another tag) and returns each tag's tagger and message.
// A tag without a tagger line yields an undefined email, which callers treat as a disallowed identity.
export function annotatedTags(sha, { cwd } = {}) {
  const tags = [];
  while (git(['cat-file', '-t', sha], { cwd }).trim() === 'tag') {
    const raw = git(['cat-file', 'tag', sha], { cwd });
    const split = raw.indexOf('\n\n');
    const header = split < 0 ? raw : raw.slice(0, split);
    const tagger = /^tagger (.*) <([^>]*)> \d+ [+-]\d{4}$/m.exec(header);
    tags.push({ text: [tagger?.[1] ?? '', tagger?.[2] ?? '', split < 0 ? '' : raw.slice(split + 2)].join('\n'), email: tagger?.[2] });
    sha = /^object ([0-9a-f]+)$/m.exec(header)[1];
  }
  return tags;
}
