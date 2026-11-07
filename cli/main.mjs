import { platform } from 'node:os';
import { resolve } from 'node:path';
import { checkRuntime } from '../core/runtime.mjs';
import { CairnError, ERRORS } from '../core/errors.mjs';
import { findDataDir, findProjectLink } from '../core/roots.mjs';
import { oneLine } from '../core/text.mjs';
import { confirm } from './confirm.mjs';
import { actorPattern, clean, human, okEnvelope, errorEnvelope } from './output.mjs';

export async function main(argv, io) {
  let json = argv.includes('--json'), ctx = null, opts = {};
  try {
    await checkRuntime();
    // Core readers load SQLite at import time, so the runtime check must precede their imports.
    const { parse } = await import('./args.mjs');
    const parsed = parse(argv);
    const { command, args } = parsed;
    opts = parsed.opts;
    json = opts.json === true;
    const actor = opts.actor ?? io.env.CAIRN_ACTOR;
    const mode = command.writeOption && opts[command.writeOption] !== undefined ? 'write' : command.mode;
    if ((mode === 'write' && command.actor !== false) || opts.assignee === 'me') {
      if (!actor) throw new CairnError('actor_required', 'An actor is required.');
      if (!actorPattern.test(actor)) throw new CairnError('usage', 'Invalid actor name.');
    }
    if (opts.assignee === 'me') opts.assignee = actor;
    const prepared = await command.prepare?.(args, opts, io);
    const dangerous = command.dangerous === true || (command.dangerous
      && opts[command.dangerous.option] !== undefined && opts[command.dangerous.option] !== false);
    if (dangerous && !opts['dry-run'] && !await confirm(io, `Confirm ${describe(command, args, opts, io)}?`)) {
      throw new CairnError('confirmation_required', 'Confirmation was declined.');
    }
    if (command.needsData) {
      const { openContext } = await import('../core/context.mjs');
      ctx = openContext({ mode: mode === 'write' && opts['dry-run'] ? 'dry-run' : mode,
        dataDir: opts.data, preset: opts.preset, env: io.env, home: io.env.HOME ?? io.env.USERPROFILE,
        platform: platform(), cwd: io.cwd, clock: io.clock,
        actor: actor && actorPattern.test(actor) ? `cli:${actor}` : null });
      // The repository link is only a default for new items and list filters; updates never inherit it.
      // A broken link fails only the commands that would use it, so `link` can still repair it.
      if (opts.project === undefined) {
        try {
          opts.linkedProject = findProjectLink(io.cwd) ?? undefined;
        } catch (error) {
          opts.linkedProjectError = error;
          if (mode !== 'write') ctx.warnings.push('invalid_project_link');
        }
      }
      if (!opts['dry-run'] && !ctx.ephemeral && (mode === 'write' || ['changes', 'context'].includes(command.name))) {
        const { reconcileBeforeRun } = await import('../core/changes.mjs');
        ctx.warnings.push(...reconcileBeforeRun(ctx));
      }
    }
    const result = await command.run(ctx, args, opts, io, prepared);
    // A command that speaks another protocol (the Claude Code hook) writes its own stdout, without the envelope.
    if (typeof result.stdout === 'string') {
      if (result.stdout) io.stdout.write(result.stdout);
      return result.exit ?? 0;
    }
    const warnings = [...new Set([...(ctx?.warnings ?? []), ...(result.warnings ?? [])])];
    const envelope = okEnvelope(result.data, warnings, opts);
    const output = json ? JSON.stringify(envelope) : human(envelope.data);
    if (!json && envelope.warnings.length) io.stderr.write(`warning: ${envelope.warnings.map((item) => oneLine(item)).join(', ')}\n`);
    io.stdout.write(output + (!json && typeof envelope.data === 'string' && output.endsWith('\n') ? '' : '\n'));
    return result.exit ?? 0;
  } catch (error) {
    const known = error instanceof CairnError;
    const envelope = errorEnvelope(error, ctx?.warnings ?? [], opts);
    const { code, message } = envelope.error;
    if (json) io.stdout.write(`${JSON.stringify(envelope)}\n`);
    else {
      io.stderr.write(`${code}: ${message}\n`);
      const last = envelope.error.current?.last;
      if (last) io.stderr.write(`Changed by ${oneLine(clean(last.actor ?? 'unknown'))} `
        + `at ${oneLine(clean(last.ts))} (${oneLine(clean(last.op))}).\n`);
    }
    if (!known && io.env.CAIRN_DEBUG === '1') io.stderr.write(`${error?.stack ?? error}\n`);
    return ERRORS[code];
  }
}

// The prompt names what will change and where, so a human can tell what an agent asked for.
function describe(command, args, opts, io) {
  const words = [command.name, ...args, ...(command.writeOption ? [`--${command.writeOption}`, opts[command.writeOption]] : [])]
    .map((part) => oneLine(clean(part))).join(' ');
  const env = { ...io.env, ...(io.env.CAIRN_DATA ? { CAIRN_DATA: resolve(io.cwd, io.env.CAIRN_DATA) } : {}) };
  const where = command.name === 'init' && args[0] ? resolve(io.cwd, args[0])
    : command.needsData || command.name === 'init'
      ? findDataDir({ flag: opts.data && resolve(io.cwd, opts.data), env, home: io.env.HOME ?? io.env.USERPROFILE, platform: platform() }).path
      : null;
  return where ? `${words} (data: ${oneLine(clean(where))})` : words;
}
