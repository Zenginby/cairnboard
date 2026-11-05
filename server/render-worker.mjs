import { parentPort } from 'node:worker_threads';
import { renderMarkdown } from '../core/render.mjs';

// Runs off the main thread so a slow page cannot stall other requests; the pool stops it when time runs out.
parentPort.on('message', ({ id, markdown, links }) => {
  const resolved = new Map(links);
  try {
    const { html, tooLarge = false, failed = false } = renderMarkdown(markdown, {
      resolveLink: ({ targetName, heading }) => resolved.get(JSON.stringify([targetName, heading ?? ''])) ?? null,
    });
    parentPort.postMessage({ id, html, tooLarge, failed });
  } catch {
    parentPort.postMessage({ id, html: null, tooLarge: false, failed: true });
  }
});
