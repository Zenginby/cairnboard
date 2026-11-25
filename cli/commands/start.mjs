import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, statSync } from 'node:fs';
import { constants, homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { repoRoot } from '../../core/agent.mjs';
import { loadConfig } from '../../core/config.mjs';
import { CairnError } from '../../core/errors.mjs';
import { realRoot } from '../../core/paths.mjs';
import { findDataDir, initDataDir } from '../../core/roots.mjs';
import { oneLine } from '../../core/text.mjs';
import { clean } from '../output.mjs';

export function serverHome(env) {
  // On POSIX, os.homedir() can return the empty HOME it inherited; on Windows it throws when USERPROFILE is empty.
  let home = env.HOME || env.USERPROFILE;
  try { home ||= homedir(); } catch { /* fall back to the account database below */ }
  return home || userInfo().homedir;
}

function initDefault(path, settings, language, stdout) {
  let created = true;
  try {
    // Reserve the name before initializing so a directory created by someone else is checked first.
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    created = false;
    try {
      loadConfig(realRoot(path));
    } catch {
      throw new CairnError('validation',
        `The default folder ${path} already exists and is not a Cairnboard data folder. Choose another with --data.`);
    }
  }
  initDataDir(path, { ...settings, language, register: 'if-unset' });
  if (created) {
    stdout.write(`Created the data folder at ${oneLine(clean(path))}. Use --data <path> to choose another.\n`);
  }
}

export async function runStart(ctx, args, opts, io) {
  if (opts.json || opts['dry-run']) throw new CairnError('usage', 'Start does not support --json or --dry-run.');
  if (opts.language !== undefined && !['en', 'tr'].includes(opts.language)) {
    throw new CairnError('usage', '--language must be en or tr.');
  }
  if (opts.data === '') throw new CairnError('usage', '--data needs a folder path.');
  if (!statSync(join(repoRoot, 'dist/app/server/entry.mjs'), { throwIfNoEntry: false })?.isFile()) {
    throw new CairnError('validation', 'The web app is missing. Build it first with npm run build:app.');
  }

  const home = serverHome(io.env);
  const env = { ...io.env, HOME: home, USERPROFILE: home,
    ...(io.env.CAIRN_DATA ? { CAIRN_DATA: resolve(io.cwd, io.env.CAIRN_DATA) } : {}) };
  const settings = { home, env };
  const found = findDataDir({ ...settings, flag: opts.data && resolve(io.cwd, opts.data) });
  if (found.source === 'default') {
    const language = opts.language ?? (Intl.DateTimeFormat().resolvedOptions().locale.startsWith('tr') ? 'tr' : 'en');
    initDefault(found.path, settings, language, io.stdout);
  }

  // A separate POSIX process group ensures that only the launcher gets terminal Ctrl-C.
  // On Windows both share the console and Node's child.kill() would forcibly terminate the server.
  const detached = process.platform !== 'win32';
  const child = spawn(process.execPath, [join(repoRoot, 'server/start.mjs'), ...(opts['no-open'] ? ['--no-open'] : [])],
    { cwd: io.cwd, env: { ...env, CAIRN_DATA: found.path }, stdio: 'inherit', detached });
  const forceStop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (detached) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  let interrupted = false;
  const interrupt = () => {
    if (!detached) return;
    if (interrupted) process.exit(130); // The exit handler kills the server and its group.
    interrupted = true;
    child.kill('SIGINT');
  };
  const terminate = () => child.kill('SIGTERM');
  process.on('exit', forceStop);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  if (detached) process.on('SIGHUP', terminate);
  try {
    const [code, signal] = await once(child, 'exit');
    return { data: null, stdout: '', exit: code ?? 128 + constants.signals[signal] };
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (detached) process.off('SIGHUP', terminate);
    process.off('exit', forceStop);
    forceStop();
  }
}
