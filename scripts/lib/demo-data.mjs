// A small, fictional English data folder for the README screenshots. Built through the real CLI, so it always
// matches the current format; sample-data/ stays the test fixture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../cli/cairn.mjs', import.meta.url));

export function buildDemoData(dataDir, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: join(home, 'state') };
  delete env.CAIRN_DATA;
  delete env.CAIRN_ACTOR;
  mkdirSync(home, { recursive: true });
  const run = (args, actor = 'owner', input) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--actor', actor, '--data', dataDir, '--json'],
      { env, input, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`cairn ${args.slice(0, 2).join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout).data;
  };
  const init = spawnSync(process.execPath, [cli, 'init', dataDir, '--language', 'en', '--actor', 'owner', '--json'],
    { env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`cairn init failed: ${init.stderr || init.stdout}`);

  const project = (title, tone, body) => run(['project', 'add', '--title', title, '--tone', String(tone),
    '--body', '-'], 'owner', body).id;
  const atlas = project('Atlas API', 2, 'REST API for the Atlas mobile app. Node 22, Postgres.\n');
  const lumen = project('Lumen site', 5, 'Marketing site and docs, built with Astro.\n');
  const agents = project('Agent queue', 7, 'Work handed to coding agents. Review before merging.\n');

  const card = (title, projectId, column, extra = []) => run(['card', 'add', '--title', title, '--project', projectId,
    '--column', column, ...extra]).id;
  card('Rate limit the login endpoint', atlas, 'backlog', ['--priority', 'urgent',
    '--needs', 'Pick the limit: 5 or 10 tries per minute']);
  card('Paginate the orders list', atlas, 'backlog', ['--priority', 'important']);
  card('Move secrets to the vault', atlas, 'doing', ['--priority', 'important',
    '--now', 'Staging done; production keys next', '--next', 'Rotate the old tokens']);
  card('Health check returns build hash', atlas, 'done');
  card('Pricing page copy', lumen, 'backlog', ['--priority', 'low']);
  card('Dark mode for the docs', lumen, 'doing', ['--now', 'Tokens defined; code blocks still light']);
  card('Fix broken links after the move', lumen, 'done');

  const accept = '## Acceptance\n- [ ] Tests cover the change\n- [ ] Changelog entry\n';
  const task = (title, extra = []) => run(['card', 'add', '--title', title, '--project', agents, '--column', 'backlog',
    '--body', '-', ...extra], 'owner', `${title}.\n\n${accept}`).id;
  const upgrade = task('Upgrade the test runner');
  const typo = task('Add types to the date helpers');
  task('Write a migration for order notes', ['--priority', 'important']);
  run(['card', 'claim', upgrade], 'agent');
  run(['card', 'check', upgrade, '1'], 'agent');
  run(['card', 'update', upgrade, '--now', 'Runner upgraded; 2 snapshot tests to update',
    '--next', 'Update snapshots, then changelog'], 'agent');
  run(['card', 'claim', typo], 'agent');
  run(['card', 'check', typo, '1'], 'agent');
  run(['card', 'check', typo, '2'], 'agent');
  const done = run(['card', 'show', typo], 'agent');
  run(['card', 'done', typo, '--if-revision', String(done.revision)], 'agent');

  run(['note', 'add', '--title', 'Release checklist', '--project', lumen, '--body', '-'], 'owner',
    'Steps before a release of [[Lumen site]].\n\n1. Run the link check.\n2. Build the docs.\n3. Tag and push.\n');
  run(['note', 'add', '--title', 'API error format', '--project', atlas, '--body', '-'], 'owner',
    'Every error returns `{ "error": { "code", "message" } }`.'
    + ' See [[release-checklist|Release checklist]] for the release steps.\n');

  // One date source for entries and the caller's journal page, so a run near midnight cannot split them.
  const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  run(['journal', 'add', '--date', day(0), '--label', 'Atlas API', '--title', 'Secrets move',
    '--item', 'Staging keys moved to the vault',
    '--decision', 'Rotate tokens on every release']);
  run(['journal', 'add', '--date', day(0), '--label', 'Agent queue', '--title', 'Date helpers typed',
    '--item', 'Added types to 14 helpers',
    '--discovery', 'Two helpers were unused; removed'], 'agent');
  run(['journal', 'add', '--date', day(1), '--label', 'Lumen site', '--title', 'Link check', '--item',
    'Fixed 9 links after the docs move', '--lesson', 'Run the link check before every release']);
  run(['journal', 'add', '--date', day(3), '--label', 'Atlas API', '--title', 'Orders API review', '--item',
    'Listed slow queries', '--pitfall', 'The orders list loads every row; paginate it']);
  run(['journal', 'add', '--date', day(6), '--label', 'Agent queue', '--title', 'Agent setup',
    '--item', 'Installed the Cairnboard skill for the agents'], 'agent');

  const configPath = join(dataDir, '.cairn', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.agents = { project: agents };
  config.home = { ...(config.home ?? {}), featuredProject: atlas };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { atlas, lumen, agents, today: day(0) };
}
