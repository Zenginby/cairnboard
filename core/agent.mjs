import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { oneLine, stripHidden } from './text.mjs';

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
  // cmd and PowerShell still expand `%`, `!`, `$` and backticks inside double quotes; such a clone path is refused.
  if (/[\r\n]/u.test(root) || (platform === 'win32' && /[%!$`^]/u.test(root))) {
    throw new CairnError('validation', 'The repository path contains characters that cannot be quoted safely; move the clone.');
  }
  const path = (platform === 'win32' ? win32 : posix).join(root, 'dist', 'cairn.mjs');
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
    if (arg === '<q>') return "'<query>'";
    if (arg === '<project>') return '<project-id>';
    if (arg === '<id>') return '<trash-id>';
    if (arg === '[column]') return '<column>';
    if (arg === '[text]') return "'<text>'";
    if (arg === '[path]') return '"<path>"';
    if (arg === '<path|->') return '- --path <target-path>';
    return arg;
  });
  if (/ (?:add|update)$/u.test(command.name) && type !== 'journal') args.push('--title', "'<text>'");
  if (command.name === 'journal add') args.push('--title', "'<text>'", '--label', "'<text>'", '--date', '<date>', '--item', "'<text>'");
  if (command.name === 'ingest') args.push('--title', "'<text>'", '--body', '-');
  if (command.name === 'card done') args.push('--if-revision', '<revision>');
  // Agents read the board; writing board.md is left to a human.
  if (command.name === 'export board') args.push('--stdout');
  if (command.mode === 'write' && command.actor !== false) args.push('--actor', actor);
  if (command.name.endsWith(' list')) args.push('--compact');
  args.push('--json');
  return `${invocation} ${command.name} ${args.join(' ')}`;
}

export function renderSkill({ version, invocation, actor, commands }) {
  const name = actor ?? '<actor>';
  const reference = commands.filter((command) => !command.hidden).map((command) => {
    const line = commandLine(command, invocation, name);
    return command.dangerous === true
      ? `${command.summary} Human runs: ${line}\n`
      : `${command.summary}${command.dangerous ? ` Only a human runs it with --${command.dangerous.option}; agents run it without.` : ''}\n\n\`\`\`sh\n${line}\n\`\`\`\n`;
  }).join('\n');
  const text = fill(skillTemplate, { version, invocation, actor: name, reference,
    actorGuide: actor ? `Use \`--actor ${actor}\` for every write.`
      : 'Replace `<actor>` with your own tool name: codex, gemini, cursor, antigravity. Pass it as `--actor` on every write.' });
  if (Buffer.byteLength(text, 'utf8') > 24 * 1024) {
    throw new CairnError('validation', 'The generated skill exceeds 24 KB; move the clone to a shorter path and rebuild before installing.');
  }
  return text;
}

export function renderAgentsMd({ version, invocation, commands }) {
  return fill(agentsTemplate, { version, invocation });
}

function selected(targets) {
  const names = targets ?? ['claude', 'agents'];
  if (names.some((name) => !Object.hasOwn(TARGETS, name))) throw new CairnError('usage', 'Unknown agent target.');
  return [...new Set(names)];
}

// Resolve the trusted HOME once. The agent's own root (`~/.claude`) may be a symlink, as dotfile managers
// and relocated homes make it; it must resolve to a directory the user owns. Symlinks below it are rejected.
function targetPath(home, target) {
  if (!home) throw new CairnError('usage', 'HOME or USERPROFILE is required.');
  if (fs.lstatSync(home).isSymbolicLink()) throw new CairnError('unsafe_path', 'Agent home is a symlink.');
  const [first, ...parts] = TARGETS[target].path.slice(2).split('/');
  let path = join(fs.realpathSync(home), first);
  if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const real = fs.statSync(path, { throwIfNoEntry: false });
    const owned = process.platform === 'win32' || real?.uid === process.getuid();
    if (!real?.isDirectory() || !owned) throw new CairnError('unsafe_path', 'Agent root symlink does not lead to your own directory.');
    path = fs.realpathSync(path);
  }
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

function diffLines(before, text, safe) {
  const old = before.split('\n'), next = text.split('\n'), out = [];
  for (let i = 0; i < Math.max(old.length, next.length); i++) if (old[i] !== next[i]) {
    if (old[i] !== undefined) out.push(`-${safe(old[i])}\n`);
    if (next[i] !== undefined) out.push(`+${safe(next[i])}\n`);
  }
  return out.join('');
}

function writeDiff(stderr, before, text, safe) {
  stderr?.write(diffLines(before, text, safe));
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
  // A tampered SKILL.md must not drive the terminal (escape sequences) while a human reads the diff.
  const safe = (line) => oneLine(stripHidden(line).text);
  for (const { target, path, before, text, status } of plans) {
    stderr?.write(`${target}: ${safe(path)} (${status})\n`);
    if (status === 'changed') writeDiff(stderr, before, text, safe);
  }
  const apply = () => {
    for (const { target, path, before, text, status } of plans) {
      if (status === 'unchanged') continue;
      // A re-pointed agent root symlink must not move the write away from the reviewed path.
      const recheck = () => {
        if (targetPath(home, target) !== path) throw new CairnError('conflict', 'Agent target moved during installation.');
      };
      recheck();
      fs.mkdirSync(dirname(path), { recursive: true });
      recheck();
      fs.writeFileAtomic(path, text, () => {
        recheck();
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

// Claude Code's PreToolUse write hook (wiki spec §10) lives in the user's settings.json, which belongs to the user:
// only the one cairnboard entry is added or replaced, the old file is backed up first, and anything unexpected is refused.
const HOOK_MATCHER = 'Write|Edit';
const HOOK_SUFFIX = ' wiki hook';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeLine = (line) => oneLine(stripHidden(line).text);
const ours = (hook) => plain(hook) && typeof hook.command === 'string' && hook.command.startsWith('node "') && hook.command.endsWith(HOOK_SUFFIX);

// `CLAUDE_CONFIG_DIR` wins; otherwise `~/.claude`, which may be a symlink to a directory the user owns (as for skills).
function settingsPath(home, env = {}) {
  let dir;
  if (env.CLAUDE_CONFIG_DIR) {
    if (!isAbsolute(env.CLAUDE_CONFIG_DIR)) throw new CairnError('validation', 'CLAUDE_CONFIG_DIR must be an absolute path.');
    dir = resolve(env.CLAUDE_CONFIG_DIR);
  } else {
    if (!home) throw new CairnError('usage', 'HOME or USERPROFILE is required.');
    if (fs.lstatSync(home).isSymbolicLink()) throw new CairnError('unsafe_path', 'Agent home is a symlink.');
    dir = join(fs.realpathSync(home), '.claude');
  }
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const real = fs.statSync(dir, { throwIfNoEntry: false });
    const owned = process.platform === 'win32' || real?.uid === process.getuid();
    if (!real?.isDirectory() || !owned) throw new CairnError('unsafe_path', 'Agent root symlink does not lead to your own directory.');
    dir = fs.realpathSync(dir);
  }
  const path = join(dir, 'settings.json');
  if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new CairnError('unsafe_path', 'Claude settings.json is a symlink.');
  return path;
}

function readSettings(path) {
  const text = readSkill(path);
  if (text === null) return { text: null, settings: {} };
  let settings;
  try { settings = JSON.parse(text.replace(/^﻿/u, '')); } catch { settings = undefined; }
  if (!plain(settings)) throw new CairnError('validation', 'Claude settings.json is not a valid JSON object; fix it first.');
  const { hooks } = settings;
  if (hooks !== undefined && (!plain(hooks) || (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)))) {
    throw new CairnError('validation', 'Claude settings.json has an unexpected hooks section; fix it first.');
  }
  if (hooks?.PreToolUse?.some((group) => !plain(group) || (group.hooks !== undefined && !Array.isArray(group.hooks)))) {
    throw new CairnError('validation', 'Claude settings.json has an unexpected hooks section; fix it first.');
  }
  return { text, settings };
}

const groupHooks = (group) => group.hooks ?? [];

export function hookStatus({ home = process.env.HOME ?? process.env.USERPROFILE, invocation = cliInvocation(repoRoot), env = process.env } = {}) {
  const { settings } = readSettings(settingsPath(home, env));
  const found = (settings.hooks?.PreToolUse ?? []).flatMap((group) => groupHooks(group).filter(ours).map((hook) => ({ group, hook })));
  const command = `${invocation}${HOOK_SUFFIX}`;
  return { installed: found.length > 0,
    current: found.length === 1 && found[0].hook.command === command && found[0].group.matcher === HOOK_MATCHER };
}

function withHook(settings, command) {
  const next = structuredClone(settings);
  const groups = next.hooks?.PreToolUse ?? [];
  let at = -1;
  const rest = [];
  for (const [index, group] of groups.entries()) {
    const kept = groupHooks(group).filter((hook) => !ours(hook));
    if (kept.length === groupHooks(group).length) { rest.push(group); continue; }
    if (at === -1) at = rest.length;
    if (kept.length) rest.push({ ...group, hooks: kept });
  }
  rest.splice(at === -1 ? rest.length : at, 0, { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command }] });
  next.hooks = { ...next.hooks, PreToolUse: rest };
  return next;
}

// Reserve each backup exclusively: even two installs with the same clock must preserve the original bytes.
function backupSettings(path, stamp, text) {
  for (let n = 0; ; n++) {
    const backup = join(dirname(path), `settings.json.cairnboard-${stamp}${n ? `-${n}` : ''}.bak`);
    let fd;
    try {
      fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.syncDirectory(dirname(path));
    return;
  }
}

export function prepareHook({ home, invocation, io = {}, dryRun = false }) {
  const env = io.env ?? {};
  const path = settingsPath(home, env);
  const { text: before, settings } = readSettings(path);
  const text = `${JSON.stringify(withHook(settings, `${invocation}${HOOK_SUFFIX}`), null, 2)}\n`;
  let unchanged = false;
  try { unchanged = before !== null && JSON.stringify(JSON.parse(before.replace(/^﻿/u, ''))) === JSON.stringify(JSON.parse(text)); } catch {}
  const status = before === null ? 'new' : unchanged ? 'unchanged' : 'changed';
  const diff = status === 'unchanged' ? '' : diffLines(before ?? '', text, safeLine);
  io.stderr?.write(`claude-hook: ${safeLine(path)} (${status})\n${diff}`);
  const apply = () => {
    if (status === 'unchanged' || dryRun) return;
    const recheck = () => {
      if (settingsPath(home, env) !== path) throw new CairnError('conflict', 'Claude settings moved during installation.');
    };
    recheck();
    fs.mkdirSync(dirname(path), { recursive: true });
    if (before !== null) {
      const stamp = (io.clock ?? { now: () => new Date() }).now().toISOString().replace(/\D/gu, '').slice(0, 14);
      backupSettings(path, stamp, before);
    }
    fs.writeFileAtomic(path, text, () => {
      recheck();
      if (readSkill(path) !== before) throw new CairnError('conflict', 'Claude settings changed during installation.');
    });
  };
  return { path, diff, status, data: { target: 'claude-hook', path, status }, apply };
}

export function installHook(options) {
  const plan = prepareHook(options);
  plan.apply();
  return { path: plan.path, diff: plan.diff, status: plan.status };
}
