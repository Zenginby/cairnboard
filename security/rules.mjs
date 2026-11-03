const emailDomains = new Set(['example.com', 'users.noreply.github.com']);
// Public bot identities that appear in commit trailers.
// GitHub's own committer identity on commits it creates (web merges); it never appears as an author.
export const GITHUB_COMMITTER = 'noreply@github.com';
const emailAddresses = new Set(['noreply@anthropic.com', GITHUB_COMMITTER]);
// GitHub no-reply identity as it appears in folded (dot-free) form inside the interim hook script.
const foldedNoreply = /^\d+\+[a-z0-9-]+@users$/i;
const placeholderUsers = new Set(['user', 'you', 'example']);

export const RULES = {
  email(line) {
    // Package scopes and pinned actions use @ without denoting an email address.
    line = line.replace(/((?:https?:\/\/[^\s/"'<>]+|node_modules)\/)@(?=[a-z0-9_-]+\/)/gi, '$1');
    line = line.replace(/^([+ -]?\s*-?\s*uses:\s+[\w.-]+\/[\w./-]+)@[0-9a-f]{40}(?=\s|$)/, '$1');
    const addresses = line.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)*[a-z0-9-]+/gi);
    // Quotes and other punctuation before the local part are not part of the address.
    return [...addresses].map(([raw]) => raw.replace(/^[^a-z0-9]+/i, ''))
      .filter((address) => /^[^@]+@/.test(address))
      .some((address) => !emailAddresses.has(address.toLowerCase()) && !foldedNoreply.test(address)
      && !emailDomains.has(address.split('@')[1].toLowerCase()));
  },
  ipv4(line) {
    const addresses = line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
    return [...addresses].some(([address]) => address.split('.').every((part) => Number(part) <= 255)
      && address !== '127.0.0.1' && address !== '0.0.0.0');
  },
  'home-path'(line) {
    // Only a path that starts at the root counts: a relative segment such as design/home/ or the key list
    // "arrow/Home/End" is not a home folder.
    const paths = line.matchAll(/(?:(?<![\w.-])\/(?:users|home|volumes)\/+|[a-z]:(?:\\+|\/)users(?:\\+|\/))([^/\\\s"'<>:]+)/gi);
    return [...paths].some(([, user]) => !placeholderUsers.has(user.toLowerCase()));
  },
  // Long base64/base64url/hex runs. Integrity hashes (sha1-/sha256-/sha384-/sha512-) are skipped per match,
  // and kebab/snake identifiers made only of plain words and numbers are not tokens (a word may carry one
  // short suffix after its digits, as in platform names like mips64el or s390x).
  token(line) {
    // Pinned GitHub Actions (owner/repo@<40-hex commit>) and sha256 checksum lines are public hashes.
    // A leading '+', '-' or ' ' is a diff marker: history scans see these lines inside patches.
    line = line.replace(/^([+ -]?\s*-?\s*uses:\s+[\w.-]+\/[\w./-]+)@[0-9a-f]{40}(?=\s|$)/, '$1');
    if (/sha256/i.test(line) && !/[0-9a-f]{65,}/i.test(line) && /\b[0-9a-f]{64}\b/.test(line)
      && ![...line.matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)].some(([v]) => !/^[0-9a-f]{64}$/.test(v) && !/^sha(?:1|256|384|512)-/.test(v))) return false;
    const tokens = line.matchAll(/(?:sha(?:1|256|384|512)-)?[A-Za-z0-9+/_-]{32,}={0,2}/g);
    // A diff marker glued to a path (+src/…) is not part of the identifier.
    return [...tokens].some(([value]) => !/^sha(?:1|256|384|512)-/.test(value)
      && !value.replace(/^[+-]+/, '').split(/[-_/]+/).filter(Boolean).every((part) => /^(?:[A-Z]?[a-z]+\d*|[A-Z]{2,10}\d*|\d+[a-z]*|[a-z]+\d+[a-z]{1,3})$/.test(part)));
  },

};
