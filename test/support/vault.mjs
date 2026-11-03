import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tempDir } from './env.mjs';

export const VAULT = fileURLToPath(new URL('../fixtures/tr-wiki-vault', import.meta.url));

// The commit scan reads an all-caps path of 32+ characters as a token, so these two root files are stored under
// lowercase template names and get their real names when the vault is copied.
const TEMPLATES = { 'claude.md.tpl': 'CLAUDE.md', 'agents.md.tpl': 'AGENTS.md' };

// Copies the fictional vault into a fresh temporary folder (removed when the test ends).
export function copyVault(t) {
  const dir = tempDir(t, 'cairn-vault-');
  cpSync(VAULT, dir, { recursive: true });
  for (const [from, to] of Object.entries(TEMPLATES)) renameSync(join(dir, from), join(dir, to));
  return dir;
}

// Relative path (forward slashes) -> sha256 of the file bytes; directories are not listed.
export function snapshot(dir) {
  const map = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = full.slice(dir.length + 1).replaceAll('\\', '/');
    map.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
  return map;
}

// Same file set, same bytes, and no `.cairn/` directory appeared.
export function assertUnchanged(before, dir) {
  const hasCairn = readdirSync(dir, { withFileTypes: true }).some((entry) => entry.name === '.cairn');
  assert.equal(hasCairn, false, 'a .cairn directory appeared in the vault');
  const after = snapshot(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'file set changed');
  for (const [path, hash] of before) assert.equal(after.get(path), hash, `${path} changed`);
}
