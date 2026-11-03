import { resolve } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { CairnError } from '../core/errors.mjs';

export async function readBody(opts, io) {
  if (opts.body !== undefined && opts.body !== '-') throw new CairnError('usage', '--body accepts only -.');
  if (opts.body !== undefined && opts['body-file'] !== undefined) throw new CairnError('usage', 'Choose --body or --body-file.');
  if (opts['body-file'] !== undefined) {
    try { return fs.readFileSync(resolve(io.cwd, opts['body-file']), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new CairnError('not_found', 'Body file was not found.');
      if (['EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw new CairnError('validation', 'Body file cannot be read.');
      throw error;
    }
  }
  if (opts.body === undefined) return undefined;
  const chunks = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
