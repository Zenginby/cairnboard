import { parentPort } from 'node:worker_threads';
import { renderMarkdown } from '../core/render.mjs';

// Runs off the main thread so a slow page cannot stall other requests; the pool stops it when time runs out.
parentPort.on('message', ({ id, markdown, links, headings }) => {
  const resolved = new Map(links);
  try {
    const { html, toc = [], tooLarge = false, failed = false } = renderMarkdown(markdown, {
      headings: headings === true,
      resolveLink: ({ targetName, heading }) => resolved.get(JSON.stringify([targetName, heading ?? ''])) ?? null,
    });
    parentPort.postMessage({ id, html, toc, tooLarge, failed });
  } catch {
    parentPort.postMessage({ id, html: null, tooLarge: false, failed: true });
  }
});

// Static imports have loaded by now; the pool starts a page's time limit from this message.
parentPort.postMessage({ ready: true });
