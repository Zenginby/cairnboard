import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { fixedClock } from '../../core/clock.mjs';

// Fresh temporary folders; callers pass them explicitly, process.env is never changed.
export const tempHome = () => mkdtempSync(join(tmpdir(), 'cairn-home-'));
export const tempData = () => mkdtempSync(join(tmpdir(), 'cairn-data-'));
