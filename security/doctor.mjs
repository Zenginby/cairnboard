// Checks the developer setup that the leak gate depends on. Never prints denylist content.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadDenylist } from './denylist.mjs';
import { MIN_NODE, nodeAtLeast } from '../core/runtime.mjs';


function run(exec, cmd, args) {
  try {
    return exec(cmd, args).trim();
  } catch {
    return null;
  }
}

function sqliteFts5() {
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    db.close();
    return true;
  } catch {
    return false;
  }
}

export function doctor({ env = process.env, exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }), nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (name, ok, hint) => checks.push({ name, ok, hint: ok ? '' : hint });

  add('node-version', nodeAtLeast(nodeVersion), `Node ${MIN_NODE.join('.')} or newer is required (found ${nodeVersion}).`);
  add('hooks-path', run(exec, 'git', ['config', 'core.hooksPath']) === 'security/hooks', 'Run: npm run hooks:install');

  let listOk = false;
  let listHint = 'Set CAIRN_DENYLIST to your private denylist file (kept outside the repository).';
  if (env.CAIRN_DENYLIST) {
    try {
      loadDenylist(env.CAIRN_DENYLIST);
      listOk = true;
    } catch (error) {
      // Error messages carry only line numbers, never terms.
      listHint = error.code ? `Cannot read CAIRN_DENYLIST (${error.code}).` : `Invalid denylist: ${error.message}.`;
    }
  }
  add('denylist', listOk, listHint);

  add('gitleaks', run(exec, 'gitleaks', ['version']) !== null, 'Install gitleaks and put it on PATH.');
  const email = run(exec, 'git', ['config', 'user.email']) ?? '';
  add('git-identity', email.endsWith('@users.noreply.github.com'), 'Set a GitHub noreply address: git config --local user.email <id>+<login>@users.noreply.github.com');
  add('sqlite', sqliteFts5(), `node:sqlite with FTS5 is required (Node ${MIN_NODE.join('.')}+).`);
  return checks;
}

// pathToFileURL encodes spaces and non-ASCII characters the same way import.meta.url does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = doctor();
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.hint}`}`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
