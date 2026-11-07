import { createHash, getRandomValues } from 'node:crypto';
import { charRanges } from './text.mjs';

// Crockford base32 alphabet (32 characters, lowercase): 0-9, a-h, j-k, m-n, p-t, v-z.
const CROCKFORD = charRanges([48, 57], [97, 104], [106, 107], [109, 110], [112, 116], [118, 122]);

const VALID_PREFIXES = new Set(['p', 'c', 'n', 'r']);
const ID_PATTERN = new RegExp(`^[pcnr]-[${CROCKFORD}]{6}$`);

function defaultRandom(n) {
  return getRandomValues(new Uint8Array(n));
}

export function newId(prefix, random = defaultRandom) {
  if (!VALID_PREFIXES.has(prefix)) {
    throw new TypeError(`invalid prefix: ${prefix}`);
  }
  const bytes = random(6);
  if (!bytes || bytes.length < 6) {
    throw new RangeError('insufficient random bytes');
  }
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += CROCKFORD[bytes[i] % 32];
  }
  return `${prefix}-${suffix}`;
}

export function normalizeId(input) {
  if (typeof input !== 'string') return null;
  const s = input.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
  return ID_PATTERN.test(s) ? s : null;
}

export function isNoteKey(input) {
  return typeof input === 'string' && input.length === 18 && /^n-[0-9a-f]{16}$/u.test(input);
}

// Path-derived keys are selectors only: resolving one must look up an indexed note, never decode a path.
export function entityRef({ id, type, path }) {
  if (id != null) return id;
  return type === 'note'
    ? `n-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
    : `@${path.replace(/\.md$/iu, '')}`;
}

// Slug and path-key helpers live with the other text helpers; re-exported here as the plan's interface names them.
export { pathKey, slugify, uniqueName } from './text.mjs';
