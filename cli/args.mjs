import { parseArgs } from 'node:util';
import { CairnError } from '../core/errors.mjs';
import { commands, commonOptions } from './registry.mjs';

const usage = (message) => new CairnError('usage', message);

function options(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([name, { type, multiple }]) => [name, { type, ...(multiple ? { multiple } : {}) }]));
}

export function parse(argv) {
  try {
    const all = Object.assign({}, commonOptions, ...commands.map((command) => command.options));
    const { positionals } = parseArgs({ args: argv, options: options(all), strict: true, allowPositionals: true });
    const command = [...commands].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length)
      .find((item) => item.name.split(' ').every((word, index) => positionals[index] === word));
    if (!command) throw usage('Unknown or missing command.');
    const { values, tokens } = parseArgs({ args: argv, options: options({ ...commonOptions, ...command.options }), strict: true, allowPositionals: true, tokens: true });
    const args = positionals.slice(command.name.split(' ').length);
    const required = command.args.filter((arg) => !arg.startsWith('[')).length;
    if (args.length < required || args.length > command.args.length) throw usage(`Invalid arguments for ${command.name}.`);
    const maxBytes = values['max-bytes'] ?? '65536';
    if (!/^\d+$/u.test(maxBytes) || !Number.isSafeInteger(Number(maxBytes))) throw usage('Invalid --max-bytes.');
    if (values.body !== undefined && values.body !== '-') throw usage('--body accepts only -.');
    if (values.body !== undefined && values['body-file'] !== undefined) throw usage('Choose --body or --body-file.');
    if (values.renew && values.steal) throw usage('Choose --renew or --steal.');
    if (command.name === 'journal add') values.entries = tokens
      .filter((token) => token.kind === 'option' && ['decision', 'discovery', 'pitfall', 'lesson', 'item'].includes(token.name))
      .map(({ name, value }) => ({ type: name === 'item' ? null : name, text: value }));
    return { command, args, opts: { ...values, 'max-bytes': Number(maxBytes) } };
  } catch (error) {
    if (error instanceof CairnError) throw error;
    if (error.code?.startsWith('ERR_PARSE_ARGS')) throw usage('Invalid command options.');
    throw error;
  }
}
