import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export * from 'node:fs';

const requested = process.env.CAIRN_TEST_NO_FSYNC === '1';
let skipTestFsync = requested && Boolean(process.env.NODE_TEST_CONTEXT);
if (requested && !skipTestFsync) {
  // The server can load both core and the app bundle's copy of this module.
  const warned = Symbol.for('cairn.testFsyncWarning');
  if (!process[warned]) {
    process[warned] = true;
    process.stderr.write('Ignoring CAIRN_TEST_NO_FSYNC outside the Node test runner.\n');
  }
}

let hooks = {};

export function testFsyncSkipped() {
  return skipTestFsync;
}

export function __setTestFsync(skip = requested) {
  skipTestFsync = skip && Boolean(process.env.NODE_TEST_CONTEXT);
}

export function syncFile(fd) {
  if (!skipTestFsync) fs.fsyncSync(fd);
}

export function isFilesystemError(error) {
  return Number.isInteger(error?.errno) || (typeof error?.code === 'string'
    && /^(?:E[A-Z0-9]+|ERR_FS_[A-Z_]+)$/u.test(error.code));
}

export function isPersistentFilesystemError(error) {
  return ['ENOSPC', 'EIO', 'EROFS', 'EDQUOT'].includes(error?.code);
}

export function __setFsHooks(next = {}) {
  hooks = { ...next };
}

export function rename(from, to) {
  return (hooks.rename ?? fs.renameSync)(from, to);
}

export function afterCheck(path) {
  hooks.afterCheck?.(path);
}

// Tests inject Windows-only failures (a delete-pending file answers EPERM) through this hook.
export function openSync(...args) {
  return (hooks.openSync ?? fs.openSync)(...args);
}
export function readFileSync(...args) {
  return (hooks.readFileSync ?? fs.readFileSync)(...args);
}
export const realpathSync = fs.realpathSync;

// The rename is durable only once its directory entry is flushed; Windows cannot open directories for this.
export function syncDirectory(dir) {
  if (process.platform === 'win32' || skipTestFsync) return;
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
      if (durable) syncFile(fd);
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
