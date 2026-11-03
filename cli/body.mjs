import { resolve } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { CairnError } from '../core/errors.mjs';

const MAX_BODY = 1024 * 1024;
const tooLarge = () => new CairnError('validation', 'Body is larger than 1 MB.');

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
      if (stat.size > MAX_BODY) throw tooLarge();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_BODY) throw tooLarge();
      return bytes.toString('utf8');
    } catch (error) {
      if (error instanceof CairnError) throw error;
      if (error.code === 'ENOENT') throw new CairnError('not_found', 'Body file was not found.');
      if (['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'ENXIO'].includes(error.code)) {
        throw new CairnError('validation', 'Body file cannot be read.');
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (opts.body === undefined) return undefined;
  return readStdin(io);
}

// Standard input as text, at most 1 MB.
export async function readStdin(io) {
  const chunks = [];
  let size = 0;
  for await (const chunk of io.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw tooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
