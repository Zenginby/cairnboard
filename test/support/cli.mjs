import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../../cli/main.mjs';

function environment({ home, data, env = {} }) {
  return { ...process.env, CAIRN_DATA: undefined, CAIRN_ACTOR: undefined, CAIRN_DEBUG: undefined,
    ...(home ? { HOME: home, USERPROFILE: home, XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined } : {}),
    ...(data ? { CAIRN_DATA: data } : {}), ...env };
}

function result(code, stdout, stderr) {
  let json = null;
  try { json = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, json };
}

export async function runCli(args, opts = {}) {
  let stdout = '', stderr = '';
  const code = await main(args, {
    env: environment(opts), cwd: opts.cwd ?? opts.home ?? process.cwd(), isTTY: opts.isTTY ?? false,
    stdin: typeof opts.stdin === 'object' ? opts.stdin : Readable.from([opts.stdin ?? '']),
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } }, clock: opts.clock,
  });
  return result(code, stdout, stderr);
}

export async function spawnCli(args, opts = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli/cairn.mjs', import.meta.url)), ...args], {
    cwd: opts.cwd ?? opts.home ?? process.cwd(), env: environment(opts), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => { stdout += text; });
  child.stderr.on('data', (text) => { stderr += text; });
  child.stdin.on('error', () => {});
  if (!opts.keepStdinOpen) child.stdin.end(opts.stdin ?? '');
  else if (opts.stdin) child.stdin.write(opts.stdin);
  return new Promise((resolve, reject) => {
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null;
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve(result(code, stdout, stderr));
    });
  });
}
