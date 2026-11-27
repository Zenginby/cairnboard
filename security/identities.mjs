import { git } from './git.mjs';

const path = 'security/identity-allowlist.txt';
const noreply = /^(?:\d+\+)?[a-z0-9_-]+(?:\[bot\])?@users\.noreply\.github\.com$/i;

export class InvalidIdentityList extends Error {}

export function envIdentities() {
  return (process.env.CAIRN_ALLOW_IDENTITIES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

// The hook accepts the identity Git commits with (any scope); release:check reads only the repository's own setting.
export function loadIdentities({ cwd, extra = [], anyScope = false } = {}) {
  // GIT_CONFIG only redirects `git config`, not what `git commit` uses; ignore an inherited one for both lookups.
  const read = (scope) => {
    try {
      return git(['config', ...scope, '--get', 'user.email'], { cwd, unset: ['GIT_CONFIG'] }).trim();
    } catch (error) {
      if (error.status !== 1 || error.stderr) throw error;
      return '';
    }
  };
  // --local skips includes unless asked.
  const repository = read(['--local', '--includes']);
  // The effective address can come from a worktree, global or system setting; keep the repository's own as well.
  const local = anyScope ? read([]) : repository;
  const allowed = new Set(extra);
  for (const address of [repository, local]) if (address) allowed.add(address);
  if (git(['ls-files', '--full-name', '-z', '--', `:(top,literal)${path}`], { cwd })) {
    const content = git(['show', `:${path}`], { cwd });
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      if (!noreply.test(value)) throw new InvalidIdentityList(`${path}:${index + 1} invalid GitHub noreply address`);
      allowed.add(value);
    }
  }
  return { local, allowed };
}
