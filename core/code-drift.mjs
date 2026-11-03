import { dayOf } from './dates.mjs';
import * as fs from './fsx.mjs';
import { checkedPath, realRoot, safeRelative } from './paths.mjs';
import { repoFor } from './roots.mjs';

// Wiki spec §14: code files a page names, relative to its project's repository. Nothing is executed and no git is
// used; a path never leaves the repository root and a symlink is never followed.

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM', 'unsafe_path']);

/** The repository root of a project on this machine as a real path, or null when it is unlinked or gone. */
export function repoRoot(stateDir, projectId) {
  const recorded = projectId === null ? null : repoFor(stateDir, projectId);
  if (recorded === null) return null;
  try {
    return fs.statSync(recorded).isDirectory() ? realRoot(recorded) : null;
  } catch (error) {
    if (MISSING.has(error.code)) return null;
    throw error;
  }
}

/** `{ missing: true }` or `{ day }` (local day of the last change) of `rel` under `root`. */
export function codeFile(root, rel) {
  try {
    const stat = fs.lstatSync(checkedPath(root, safeRelative(String(rel).replace(/\\/gu, '/'))));
    return stat.isSymbolicLink() ? { missing: true } : { day: dayOf(new Date(stat.mtimeMs)) };
  } catch (error) {
    if (MISSING.has(error.code)) return { missing: true };
    throw error;
  }
}
