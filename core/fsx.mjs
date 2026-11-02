import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export * from 'node:fs';

let hooks = {};

export function __setFsHooks(next = {}) {
  hooks = { ...next };
}

export function rename(from, to) {
  return (hooks.rename ?? fs.renameSync)(from, to);
}

export function afterCheck(path) {
  hooks.afterCheck?.(path);
}

export const openSync = fs.openSync;
export const realpathSync = fs.realpathSync;

// The rename is durable only once its directory entry is flushed; Windows cannot open directories for this.
function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  hooks.syncDirectory?.(dir);
}

// `durable: false` keeps the atomic replace but skips both flushes, for hints that can be rebuilt after a crash.
export function writeFileAtomic(path, data, beforeRename = () => {}, { durable = true } = {}) {
  const temp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
  const fd = openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeRename();
    rename(temp, path);
    if (durable) syncDirectory(dirname(path));
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
