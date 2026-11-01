import { execFileSync } from 'node:child_process';

const maxBuffer = 512 * 1024 * 1024;

// Runs git without a shell; throws on a non-zero exit.
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function gitBuffer(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}
