import { resolve } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { CairnError } from '../core/errors.mjs';

const MAX_BODY = 1024 * 1024;

export async function readBody(opts, io) {
  if (opts.body !== undefined && opts.body !== '-') throw new CairnError('usage', '--body accepts only -.');
  if (opts.body !== undefined && opts['body-file'] !== undefined) throw new CairnError('usage', 'Choose --body or --body-file.');
  if (opts['body-file'] !== undefined) {
    let fd;
    try {
      // Only a regular file, read without blocking: a FIFO or /dev/stdin would hang an agent, /dev/zero would never end.
      fd = fs.openSync(resolve(io.cwd, opts['body-file']), fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new CairnError('validation', 'Body file must be a regular file.');
      if (stat.size > MAX_BODY) throw new CairnError('validation', 'Body file is larger than 1 MB.');
      return fs.readFileSync(fd, 'utf8');
    } catch (error) {
      if (error instanceof CairnError) throw error;
      if (error.code === 'ENOENT') throw new CairnError('not_found', 'Body file was not found.');
      if (['EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw new CairnError('validation', 'Body file cannot be read.');
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (opts.body === undefined) return undefined;
  const chunks = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
