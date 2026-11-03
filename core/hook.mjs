import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import * as fs from './fsx.mjs';
import { readChecked } from './paths.mjs';
import { classify } from './schema.mjs';
import { parseFile } from './frontmatter.mjs';
import { checkPage } from './check.mjs';
import { oneLine, stripHidden } from './text.mjs';

// Wiki spec §10, the Claude Code PreToolUse hook. It reads, never writes (the index cache aside) and fails open:
// whatever it cannot judge is allowed, and an unexpected failure is reported as a `hook_error` warning.
const MAX_ITEMS = 20;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const allow = (...warnings) => ({ decision: 'allow', warnings });
const fold = (path) => (process.platform === 'darwin' || process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path);

// The path of `target` relative to the (real) data root, or null when it lies outside. Only existing ancestors are
// resolved, so `/var` and `/private/var` agree and a symlink out of the root never counts as inside.
function rootRelative(root, target) {
  let existing = resolve(target);
  const tail = [];
  let real;
  for (;;) {
    try {
      real = fs.realpathSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(existing);
      if (parent === existing) return null;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  const full = join(real, ...tail);
  let rel = null;
  if (full.startsWith(root + sep)) rel = full.slice(root.length + 1);
  else if (fold(full).startsWith(fold(root) + sep)) rel = full.slice(fold(root).length + 1);
  return rel === null || !rel ? null : rel.split(sep).join('/');
}

function describe(item) {
  const target = object(item.content) && typeof item.content.target === 'string' ? ` "${item.content.target}"` : '';
  const text = `${item.rule}${item.line === undefined ? '' : ` (line ${item.line})`}: ${item.detail}${target}`;
  return oneLine(stripHidden(text).text);
}

function lines(items) {
  const shown = items.slice(0, MAX_ITEMS).map(describe);
  if (items.length > MAX_ITEMS) shown.push(`${items.length - MAX_ITEMS} more not listed.`);
  return shown;
}

function newText(ctx, rel, name, input) {
  if (name === 'Write') {
    if (typeof input.content !== 'string') throw new TypeError('Write content must be text.');
    return { text: input.content };
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') throw new TypeError('Edit needs old_string and new_string.');
  const current = readChecked(ctx.root, rel, 'utf8');
  if (current === null) return { skip: 'The edited file does not exist yet; the wiki rules were not checked.' };
  const { old_string: old, new_string: next } = input;
  if (!old || !current.includes(old)) return { skip: 'old_string was not found in the file; the wiki rules were not checked.' };
  if (input.replace_all === true) return { text: current.split(old).join(next) };
  const at = current.indexOf(old);
  if (current.indexOf(old, at + 1) !== -1) return { skip: 'old_string is not unique in the file; the wiki rules were not checked.' };
  return { text: current.slice(0, at) + next + current.slice(at + old.length) };
}

function evaluate(ctx, input) {
  if (!object(input)) throw new TypeError('Hook input must be an object.');
  const name = input.tool_name;
  if (name !== 'Write' && name !== 'Edit') return allow();
  if (!ctx) return allow();
  const given = object(input.tool_input) ? input.tool_input : null;
  if (!given || typeof given.file_path !== 'string' || !isAbsolute(given.file_path)) throw new TypeError('Hook input has no absolute file_path.');
  const rel = rootRelative(ctx.root, given.file_path);
  if (rel === null) return allow();
  const { text, skip } = newText(ctx, rel, name, given);
  if (skip !== undefined) return allow(skip);
  let entity;
  try {
    entity = classify(ctx.schema, rel, parseFile(text).data).entity;
  } catch (error) {
    if (error.code === 'unsafe_path') return allow();
    throw error;
  }
  if (entity !== 'note' && entity !== 'research') return allow();
  const { errors, warnings } = checkPage(ctx, { path: rel, text, lenient: true });
  if (errors.length) {
    return { decision: 'deny', warnings: lines(warnings),
      reason: `Cairnboard wiki rules failed for ${oneLine(stripHidden(rel).text)}: ${lines(errors).join(' | ')} Fix the page and write it again.` };
  }
  return allow(...lines(warnings));
}

/** `{ decision: 'allow'|'deny', reason?, warnings: string[] }` for one hook input; never throws. */
export function evaluateHook(ctx, input) {
  try {
    return evaluate(ctx, input);
  } catch {
    return allow('hook_error');
  }
}

/** The JSON Claude Code reads on stdout (exit 0), or '' for a plain allow. */
export function hookOutput({ decision, reason, warnings }) {
  const output = { hookEventName: 'PreToolUse' };
  if (decision === 'deny') {
    output.permissionDecision = 'deny';
    output.permissionDecisionReason = reason;
  }
  if (warnings.length) output.additionalContext = `Cairnboard wiki check:\n${warnings.join('\n')}`;
  return decision === 'deny' || warnings.length ? `${JSON.stringify({ hookSpecificOutput: output })}\n` : '';
}
