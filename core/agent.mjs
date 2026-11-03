import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
export const packageVersion = typeof __CAIRN_VERSION__ === 'undefined'
  ? JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version : __CAIRN_VERSION__;
const skillTemplate = typeof __CAIRN_SKILL__ === 'undefined'
  ? fs.readFileSync(new URL('../agents/skill-template.md', import.meta.url), 'utf8') : __CAIRN_SKILL__;
const agentsTemplate = typeof __CAIRN_AGENTS__ === 'undefined'
  ? fs.readFileSync(new URL('../agents/agents-md-template.md', import.meta.url), 'utf8') : __CAIRN_AGENTS__;

export const TARGETS = {
  claude: { path: '~/.claude/skills/cairnboard/SKILL.md', actor: 'claude' },
  agents: { path: '~/.agents/skills/cairnboard/SKILL.md', actor: null },
  'antigravity-cli': { path: ['~/.gemini', 'antigravity-cli/skills', 'cairnboard/SKILL.md'].join('/'), actor: 'antigravity' },
};

export function cliInvocation(root, platform = process.platform) {
  const path = platform === 'win32' ? win32.join(root, 'dist', 'cairn.mjs') : join(root, 'dist', 'cairn.mjs');
  return `node "${platform === 'win32' ? path : path.replace(/["$`\\]/gu, '\\$&')}"`;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/gu, (match, key) => values[key] ?? match);
}

function commandLine(command, invocation, actor) {
  const [type] = command.name.split(' ');
  const ref = `<${type}-id>`;
  const args = command.args.map((arg) => {
    if (arg === '<ref>') return ref;
    if (arg === '<date|ref>') return '<date>';
    if (arg === '<q>') return '"<query>"';
    if (arg === '<project>') return '<project-id>';
    if (arg === '<id>') return '<trash-id>';
    if (arg === '[column]') return '<column>';
    if (arg === '[text]') return '"<text>"';
    if (arg === '[path]') return '"<path>"';
    return arg;
  });
  if (/ (?:add|update)$/u.test(command.name) && type !== 'journal') args.push('--title', '"<text>"');
  if (command.name === 'journal add') args.push('--title', '"<text>"', '--label', '"<text>"', '--date', '<date>', '--item', '"<text>"');
  if (command.name === 'card done') args.push('--if-revision', '<revision>');
  if (command.mode === 'write' && command.actor !== false) args.push('--actor', actor);
  if (command.name.endsWith(' list')) args.push('--compact');
  args.push('--json');
  return `${invocation} ${command.name} ${args.join(' ')}`;
}

export function renderSkill({ version, invocation, actor, commands }) {
  const name = actor ?? '<actor>';
  const reference = commands.map((command) => {
    const line = commandLine(command, invocation, name);
    return command.dangerous === true
      ? `${command.summary} Human runs: ${line}\n`
      : `${command.summary}${command.dangerous ? ' Human runs --steal; agents may claim without it.' : ''}\n\n\`\`\`sh\n${line}\n\`\`\`\n`;
  }).join('\n');
  return fill(skillTemplate, { version, invocation, actor: name, reference,
    actorGuide: actor ? `Use \`--actor ${actor}\` for every write.`
      : 'Replace `<actor>` with your own tool name: codex, gemini, cursor, antigravity. Pass it as `--actor` on every write.' });
}

export function renderAgentsMd({ version, invocation, commands }) {
  return fill(agentsTemplate, { version, invocation });
}

function selected(targets) {
  const names = targets ?? ['claude', 'agents'];
  if (names.some((name) => !Object.hasOwn(TARGETS, name))) throw new CairnError('usage', 'Unknown agent target.');
  return [...new Set(names)];
}

// Resolve the trusted HOME once; reject symlinks in every installation component below it.
function targetPath(home, target) {
  if (!home) throw new CairnError('usage', 'HOME or USERPROFILE is required.');
  if (fs.lstatSync(home).isSymbolicLink()) throw new CairnError('unsafe_path', 'Agent home is a symlink.');
  const root = fs.realpathSync(home);
  const parts = TARGETS[target].path.slice(2).split('/');
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new CairnError('unsafe_path', 'Agent target contains a symlink.');
    }
  }
  return path;
}

function readSkill(path) {
  try { return fs.readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function prepareInstall({ home, repoRoot: root = repoRoot, targets, commands, stderr }) {
  const names = selected(targets);
  if (!fs.statSync(join(root, 'dist/cairn.mjs'), { throwIfNoEntry: false })?.isFile()) {
    throw new CairnError('validation', 'Build the CLI first: npm run build:cli');
  }
  const plans = names.map((target) => {
    const path = targetPath(home, target);
    const before = readSkill(path);
    const text = renderSkill({ version: packageVersion, invocation: cliInvocation(resolve(root)), actor: TARGETS[target].actor, commands });
    const status = before === null ? 'new' : before === text ? 'unchanged' : 'changed';
    return { target, path, before, text, status };
  });
  for (const { target, path, before, text, status } of plans) {
    stderr?.write(`${target}: ${path} (${status})\n`);
    if (status === 'changed') {
      const old = before.split('\n'), next = text.split('\n');
      for (let i = 0; i < Math.max(old.length, next.length); i++) if (old[i] !== next[i]) {
        if (old[i] !== undefined) stderr?.write(`-${old[i]}\n`);
        if (next[i] !== undefined) stderr?.write(`+${next[i]}\n`);
      }
    }
  }
  const apply = () => {
    for (const { target, path, before, text, status } of plans) {
      if (status === 'unchanged') continue;
      targetPath(home, target);
      fs.mkdirSync(dirname(path), { recursive: true });
      targetPath(home, target);
      fs.writeFileAtomic(path, text, () => {
        targetPath(home, target);
        if (readSkill(path) !== before) throw new CairnError('conflict', 'Agent skill changed during installation.');
      });
    }
  };
  return { data: plans.map(({ target, path, status }) => ({ target, path, status })), apply };
}

export function installAgent(options) {
  const plan = prepareInstall(options);
  if (!options.dryRun) plan.apply();
  return plan.data;
}

export function checkAgents({ home = process.env.HOME ?? process.env.USERPROFILE } = {}) {
  return Object.keys(TARGETS).map((target) => {
    const path = targetPath(home, target), text = readSkill(path);
    const installed = text?.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n<!-- cairnboard-skill ([^\s<>]+) -->\r?\n/u)?.[1] ?? null;
    const match = text?.match(/^node "((?:\\.|[^"\r\n])*)" /mu);
    const invocationPath = match && (process.platform === 'win32' ? match[1] : match[1].replace(/\\(["$`\\])/gu, '$1'));
    const invocationOk = !!invocationPath && fs.statSync(invocationPath, { throwIfNoEntry: false })?.isFile() === true;
    return { target, path, installed, current: packageVersion, invocationOk, ok: installed === packageVersion && invocationOk };
  });
}
