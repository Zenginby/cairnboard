import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTokens, readDesignSources } from './lib/design-tokens.mjs';

try {
  const css = buildTokens(await readDesignSources(process.cwd()));
  const target = 'src/styles/tokens.css';
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (current !== css) throw new Error(`${target} is missing or stale; run npm run design:build`);
  } else {
    await mkdir(join('src', 'styles'), { recursive: true });
    await writeFile(target, css, 'utf8');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
