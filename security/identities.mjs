import { git } from './git.mjs';

const path = 'security/identity-allowlist.txt';
const noreply = /^(?:\d+\+)?[a-z0-9_-]+(?:\[bot\])?@users\.noreply\.github\.com$/i;

export class InvalidIdentityList extends Error {}

export function envIdentities() {
  return (process.env.CAIRN_ALLOW_IDENTITIES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

// The hook accepts the identity Git commits with (any scope); release:check reads only the repository's own setting.
export function loadIdentities({ cwd, extra = [], anyScope = false } = {}) {
  let local = '';
  try {
    local = git(['config', ...(anyScope ? [] : ['--local']), '--get', 'user.email'], { cwd }).trim();
  } catch (error) {
    if (error.status !== 1 || error.stderr) throw error;
  }
  const allowed = new Set(extra);
  if (local) allowed.add(local);
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
