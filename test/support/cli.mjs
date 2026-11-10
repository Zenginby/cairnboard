import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../../cli/main.mjs';

function environment({ home, data, env = {} }) {
  // The suite may itself run inside a coding agent; its markers would refuse every confirmation.
  return { ...process.env, CAIRN_DATA: undefined, CAIRN_ACTOR: undefined, CAIRN_DEBUG: undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_THREAD_ID: undefined,
    GEMINI_CLI: undefined, CURSOR_AGENT: undefined, CLAUDE_CONFIG_DIR: undefined,
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
  const tty = opts.isTTY ?? false;
  const stdin = typeof opts.stdin === 'object' && !Buffer.isBuffer(opts.stdin) ? opts.stdin
    : Object.assign(Readable.from([opts.stdin ?? '']), tty ? { isTTY: true } : {});
  const out = { ...(tty ? { isTTY: true } : {}), ...opts.stdout,
    write: (text) => { opts.stdout?.write?.(text); stdout += text; } };
  const code = await main(args, {
    env: environment(opts), cwd: opts.cwd ?? opts.home ?? process.cwd(), isTTY: tty, stdin, stdout: out,
    stderr: { write: (text) => { stderr += text; } }, clock: opts.clock, openBrowser: opts.openBrowser, isAlive: opts.isAlive,
  });
  return result(code, stdout, stderr);
}

export async function spawnCli(args, opts = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli/cairn.mjs', import.meta.url)), ...args], {
    cwd: opts.cwd ?? opts.home ?? process.cwd(), env: environment(opts), stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal,
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  opts.cleanup?.(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
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
    const timer = opts.timeout ? setTimeout(() => child.kill('SIGKILL'), opts.timeout) : null;
    timer?.unref();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve(result(code, stdout, stderr));
    });
  });
}
