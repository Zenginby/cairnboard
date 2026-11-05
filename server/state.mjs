import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from '../core/roots.mjs';

export function isAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function readServerState(options = {}) {
  try {
    return JSON.parse(readFileSync(join(stateDir(options), 'server.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeServerState({ port, instance, pid = process.pid, startedAt = new Date().toISOString(), rename = renameSync, ...options }) {
  const dir = stateDir(options);
  // On Windows mode bits are ignored; privacy relies on the %LOCALAPPDATA% ACL.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const state = { v: 1, port, pid, instance, url: `http://127.0.0.1:${port}/`, startedAt };
  const temp = join(dir, `.server-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(temp, join(dir, 'server.json'));
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return state;
}

export function removeServerState({ pid = process.pid, ...options } = {}) {
  if (readServerState(options)?.pid === pid) unlinkSync(join(stateDir(options), 'server.json'));
}
