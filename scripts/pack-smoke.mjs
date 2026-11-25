import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the package smoke test with npm run test:pack.');
const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const bin = windows ? 'node_modules\\.bin\\cairnboard.cmd' : './node_modules/.bin/cairnboard';
const command = (args) => windows ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', bin, ...args]] : [bin, args];

function waitForUrl(stdout) {
  const lines = createInterface({ input: stdout });
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
    lines.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('The installed command exited before announcing its URL.'));
    });
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

async function stop(child, closed) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (windows) {
      const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      if (result.status !== 0 && child.exitCode === null) child.kill();
    } else {
      child.kill('SIGTERM');
    }
  }
  const timeout = setTimeout(() => {
    if (windows) child.kill();
    else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }, 5000);
  try { await closed; } finally { clearTimeout(timeout); }
}

const scratch = mkdtempSync(join(tmpdir(), 'cairn-pack-'));
try {
  const pack = join(scratch, 'pack'), install = join(scratch, 'install'), home = join(scratch, 'home');
  for (const dir of [pack, install, home]) mkdirSync(dir);
  const cache = ['--cache', join(scratch, 'npm-cache')];
  // The repo disables lifecycle scripts (.npmrc), so prepack never runs here: build first, as a release does.
  for (const script of ['build:cli', 'build:app']) {
    execFileSync(process.execPath, [npm, 'run', script], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  const [{ filename, version }] = JSON.parse(execFileSync(process.execPath, [
    npm, 'pack', '--json', '--pack-destination', pack, ...cache,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  execFileSync(process.execPath, [
    npm, 'install', '--prefix', install, '--no-audit', '--no-fund', join(pack, filename), ...cache,
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
  child.on('error', (error) => console.error(error));
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const status = await statusAt(await waitForUrl(child.stdout));
    assert.ok((status >= 200 && status < 400) || status === 401, `Unexpected HTTP status: ${status}`);
    console.log(`Installed Cairnboard ${version} answered HTTP ${status}.`);
  } finally {
    await stop(child, closed);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
