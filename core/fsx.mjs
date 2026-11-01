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

export function writeFileAtomic(path, data, beforeRename = () => {}) {
  const temp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
  const fd = openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeRename();
    rename(temp, path);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
