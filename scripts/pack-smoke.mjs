import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isAlive, readServerState } from '../server/state.mjs';
import { assertNoPaths } from './lib/package-paths.mjs';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the package smoke test with npm run test:pack.');
const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const bin = windows ? 'node_modules\\.bin\\cairnboard.cmd' : './node_modules/.bin/cairnboard';
const command = (args) => windows ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', bin, ...args]] : [bin, args];

function waitForUrl(child) {
  const lines = createInterface({ input: child.stdout });
  let exited;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for the installed server.'));
      lines.close();
    }, 60_000);
    lines.on('line', (line) => {
      console.log(line);
      const match = /^Cairnboard: (http:\/\/\S+)$/u.exec(line);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    exited = () => {
      clearTimeout(timeout);
      reject(new Error('The installed command exited before announcing its URL.'));
      lines.close();
    };
    child.once('exit', exited);
    child.once('error', exited);
    lines.once('close', exited);
  }).finally(() => {
    child.off('exit', exited);
    child.off('error', exited);
  });
}

function statusAt(url) {
  return new Promise((resolve, reject) => {
    // Preserve the guarded Host header while avoiding platform-specific DNS for *.localhost.
    const request = get(url, { family: 4, lookup: (_host, _opts, done) => done(null, '127.0.0.1', 4) }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Timed out requesting the installed server.')));
    request.once('error', reject);
  });
}

function taskkill(pid, required = false) {
  const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'],
    { stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL', windowsHide: true });
  if (result.status !== 0 && (required || isAlive(pid))) {
    throw new Error(`taskkill failed for installed process ${pid}.`, { cause: result.error });
  }
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function stop(child, closed, where) {
  const running = child.pid && child.exitCode === null && child.signalCode === null;
  const server = () => readServerState(where)?.pid;
  let timer, failure;
  try {
    if (windows) {
      try { if (running) taskkill(child.pid, true); } catch (error) { failure = error; }
      // A cmd shim can exit before its descendants. The isolated state records the actual server PID.
      const pid = server();
      if (isAlive(pid)) {
        if (!running) failure = new Error('The installed command exited before its server.');
        taskkill(pid);
      }
    } else if (running) child.kill('SIGTERM');
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out stopping the installed server.')), 5000);
    })]);
    if (windows && isAlive(server())) throw new Error('The installed server survived taskkill.');
    if (failure) throw failure;
  } catch (error) {
    if (!windows) {
      killGroup(server());
      killGroup(child.pid);
    }
    child.stdout?.destroy();
    child.unref();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function packInto(dir, cache) {
  const [{ filename }] = JSON.parse(execFileSync(process.execPath, [
    npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', dir, ...cache,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  return join(dir, filename);
}

function verifyTarball(tarball, scratch) {
  const unpack = join(scratch, 'unpacked');
  mkdirSync(unpack);
  execFileSync('tar', ['-xf', tarball, '-C', unpack], { stdio: 'inherit' });
  const pkg = join(unpack, 'package');
  for (const path of ['dist/cairn.mjs', 'dist/cairnboard.mjs', 'dist/app/server/entry.mjs']) {
    assert.ok(lstatSync(join(pkg, path), { throwIfNoEntry: false })?.isFile(), `Tarball is missing ${path}.`);
  }
  assertNoPaths(unpack, [root, homedir(), process.env.HOME, process.env.USERPROFILE]);
  return JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
}

async function installAndRun(tarball, version, scratch, cache) {
  const install = join(scratch, 'install'), home = join(scratch, 'home');
  for (const dir of [install, home]) mkdirSync(dir);
  execFileSync(process.execPath, [
    npm, 'install', '--prefix', install, '--no-audit', '--no-fund', tarball, ...cache,
  ], { cwd: install, stdio: 'inherit' });

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: home, LOCALAPPDATA: home,
    CAIRN_DATA: '', CAIRN_NO_OPEN: '1', NODE_DISABLE_COMPILE_CACHE: '1' };
  const run = (args) => {
    const [file, argv] = command(args);
    return execFileSync(file, argv, { cwd: install, env, encoding: 'utf8' });
  };
  assert.equal(run(['--version']).trim(), version);
  run(['init', 'data', '--actor', 'owner']);
  const [file, args] = command(['start', '--no-open', '--data', 'data']);
  const child = spawn(file, args, {
    cwd: install, env, stdio: ['ignore', 'pipe', 'inherit'], detached: !windows,
  });
  const closed = new Promise((resolve) => {
    child.once('close', resolve);
    child.once('error', (error) => { console.error(error); resolve(); });
  });
  try {
    const status = await statusAt(await waitForUrl(child));
    assert.ok((status >= 200 && status < 400) || status === 401, `Unexpected HTTP status: ${status}`);
    console.log(`Installed Cairnboard ${version} answered HTTP ${status}.`);
  } finally {
    await stop(child, closed, { home, env });
  }
}

const [mode, path, ...extra] = process.argv.slice(2);
if (mode && (!['--pack', '--tarball'].includes(mode) || !path || extra.length)) {
  throw new Error('Usage: npm run test:pack [-- --pack <file> | --tarball <file>]');
}

const scratch = mkdtempSync(join(tmpdir(), 'cairn-pack-'));
try {
  const cache = ['--cache', join(scratch, 'npm-cache')];
  if (!mode) {
    for (const script of ['build:cli', 'build:app']) {
      execFileSync(process.execPath, [npm, 'run', script], { cwd: root, stdio: 'inherit' });
    }
  }
  const tarball = mode === '--tarball' ? resolve(path) : packInto(scratch, cache);
  const version = verifyTarball(tarball, scratch);
  if (mode === '--pack') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    copyFileSync(tarball, path);
  } else {
    await installAndRun(tarball, version, scratch, cache);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
