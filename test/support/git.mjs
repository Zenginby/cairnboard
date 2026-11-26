import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function isolatedGitEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'config'),
  };
}

function run(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: isolatedGitEnv(dirname(cwd)),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

let templateRepo = null;

function baseRepo() {
  if (templateRepo) return templateRepo;
  const base = mkdtempSync(join(tmpdir(), 'cairn-git-tpl-'));
  const cwd = mkdtempSync(join(base, 'repo-'));
  run(cwd, ['init', '-q', '-b', 'main']);
  run(cwd, ['config', 'user.name', 't']);
  run(cwd, ['config', 'user.email', 't@users.noreply.github.com']);
  commit(cwd, { 'README.md': '# acme\n' }, 'init');
  process.once('exit', () => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  templateRepo = cwd;
  return cwd;
}

export function makeRepo({ home }) {
  const cwd = mkdtempSync(join(home, 'repo-'));
  cpSync(baseRepo(), cwd, { recursive: true });
  return cwd;
}

export function commit(cwd, files, message) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  run(cwd, ['add', '--all']);
  run(cwd, ['commit', '-q', '-m', message]);
  return run(cwd, ['rev-parse', 'HEAD']).trim();
}
