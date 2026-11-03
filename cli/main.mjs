import { platform } from 'node:os';
import { checkRuntime } from '../core/runtime.mjs';
import { CairnError, ERRORS } from '../core/errors.mjs';
import { findProjectLink } from '../core/roots.mjs';
import { oneLine } from '../core/text.mjs';
import { confirm } from './confirm.mjs';
import { actorPattern, clean, human } from './output.mjs';

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
    if ((command.mode === 'write' && command.actor !== false) || opts.assignee === 'me') {
      if (!actor) throw new CairnError('actor_required', 'An actor is required.');
      if (!actorPattern.test(actor)) throw new CairnError('usage', 'Invalid actor name.');
    }
    if (opts.assignee === 'me') opts.assignee = actor;
    const prepared = await command.prepare?.(args, opts, io);
    const dangerous = command.dangerous === true || (command.dangerous && opts[command.dangerous.option]);
    const target = [command.name, ...args].map((part) => oneLine(clean(part))).join(' ');
    if (dangerous && !opts['dry-run'] && !await confirm(io, `Confirm ${target}?`)) {
      throw new CairnError('confirmation_required', 'Confirmation was declined.');
    }
    if (command.needsData) {
      const { openContext } = await import('../core/context.mjs');
      ctx = openContext({ mode: command.mode === 'write' && opts['dry-run'] ? 'dry-run' : command.mode,
        dataDir: opts.data, preset: opts.preset, env: io.env, home: io.env.HOME ?? io.env.USERPROFILE,
        platform: platform(), cwd: io.cwd, clock: io.clock,
        actor: actor && actorPattern.test(actor) ? `cli:${actor}` : null });
      // The repository link is only a default for new items and list filters; updates never inherit it.
      if (opts.project === undefined) {
        try {
          opts.linkedProject = findProjectLink(io.cwd) ?? undefined;
        } catch (error) {
          if (command.mode === 'write') throw error;
          ctx.warnings.push('invalid_project_link');
        }
      }
    }
    const result = await command.run(ctx, args, opts, io, prepared);
    const warnings = [...new Set([...(ctx?.warnings ?? []), ...(result.warnings ?? [])])];
    const envelope = clean({ v: 1, ok: true, data: result.data, warnings }, opts);
    const output = json ? JSON.stringify(envelope) : human(envelope.data);
    io.stdout.write(output + (!json && typeof envelope.data === 'string' && output.endsWith('\n') ? '' : '\n'));
    return result.exit ?? 0;
  } catch (error) {
    const known = error instanceof CairnError;
    const code = known ? error.code : 'internal';
    const message = oneLine(clean(known ? error.message : 'An internal error occurred.'));
    const current = known ? error.details.current : undefined;
    const envelope = { v: 1, ok: false, error: { code, message,
      ...(current === undefined ? {} : { current: clean(current, opts) }) }, warnings: [...new Set(ctx?.warnings ?? [])] };
    if (json) io.stdout.write(`${JSON.stringify(envelope)}\n`);
    else io.stderr.write(`${code}: ${message}\n`);
    if (!known && io.env.CAIRN_DEBUG === '1') io.stderr.write(`${error?.stack ?? error}\n`);
    return ERRORS[code];
  }
}
