import { execFileSync } from 'node:child_process';

const maxBuffer = 512 * 1024 * 1024;

// Runs git without a shell; throws on a non-zero exit.
export function git(args, { cwd, input } = {}) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function gitBuffer(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}
