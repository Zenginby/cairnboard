import { execFileSync } from 'node:child_process';

const maxBuffer = 512 * 1024 * 1024;

// Runs git without a shell; throws on a non-zero exit.
// `unset` drops inherited variables for this call only.
export function git(args, { cwd, input, unset = [] } = {}) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of unset) delete env[name];
  return execFileSync('git', args, { cwd, input, env, encoding: 'utf8', maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function gitBuffer(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
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
    // Everything but the structural object hash is scanned: the embedded tag name, unknown headers and the message.
    // Signature blocks are base64, so callers check them against the denylist only (no token rule).
    const signatures = /^-----BEGIN (?:PGP|SSH) SIGNATURE-----\n[\s\S]*?^-----END (?:PGP|SSH) SIGNATURE-----$/gm;
    const message = split < 0 ? '' : raw.slice(split + 2);
    tags.push({
      text: [header.replace(/^object [0-9a-f]+\n/, ''), message.replace(signatures, '')].join('\n'),
      signature: (message.match(signatures) ?? []).join('\n'),
      email: tagger?.[2],
    });
    sha = /^object ([0-9a-f]+)$/m.exec(header)[1];
  }
  return tags;
}
