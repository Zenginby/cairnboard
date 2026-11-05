import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./render-worker.mjs', import.meta.url);
const FAILED = Object.freeze({ html: null, tooLarge: false, failed: true, timedOut: false });
const TIMED_OUT = Object.freeze({ html: null, tooLarge: false, failed: false, timedOut: true });
const MAX_SLOW = 256;

/**
 * Renders Markdown in one worker thread, one page at a time. Some inputs of a few tens of kilobytes take the
 * Markdown parser seconds (deep emphasis, many wiki links); a page over the time limit stops the worker, which is
 * started again for the next page, and comes back as `{ html: null, timedOut: true }`. Such a page is remembered,
 * so asking for it again answers at once instead of stalling the queue for another full time limit.
 * `links` are `[key, { type, id } | null]` pairs keyed by JSON `[targetName, heading ?? '']`.
 */
export function createRenderPool({ timeoutMs = 5000, maxQueue = 64, workerUrl = WORKER, heapMb = 256 } = {}) {
  let worker = null;
  let active = null;
  let nextId = 0;
  const queue = [];
  const slow = new Set();

  function finish(result) {
    const job = active;
    if (!job) return;
    active = null;
    clearTimeout(job.timer);
    job.resolve(result);
    pump();
  }

  function stop() {
    const stopped = worker;
    worker = null;
    if (!stopped) return;
    stopped.removeAllListeners();
    // A late error from the stopped thread must not become an uncaught exception in the server.
    stopped.on('error', () => {});
    stopped.terminate().catch(() => {});
  }

  function start() {
    worker = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    worker.on('message', (message) => {
      if (!active || message.id !== active.id) return;
      finish({ html: message.html, tooLarge: message.tooLarge, failed: message.failed, timedOut: false });
    });
    const lost = () => {
      stop();
      finish(FAILED);
    };
    worker.on('error', lost);
    worker.on('exit', lost);
    // After the listeners: adding a message listener refs the worker again, and an idle pool must not keep the
    // process alive.
    worker.unref();
  }

  function remember(key) {
    slow.add(key);
    if (slow.size > MAX_SLOW) slow.delete(slow.values().next().value);
  }

  function pump() {
    while (!active && queue.length) {
      const job = queue.shift();
      if (slow.has(job.key)) { job.resolve(TIMED_OUT); continue; }
      active = job;
      try {
        if (!worker) start();
        job.timer = setTimeout(() => {
          remember(job.key);
          stop();
          finish(TIMED_OUT);
        }, timeoutMs);
        job.timer.unref();
        worker.postMessage({ id: job.id, markdown: job.markdown, links: job.links });
      } catch {
        // A worker that cannot start must fail this page, never leave the queue waiting forever.
        stop();
        finish(FAILED);
      }
    }
  }

  return {
    render(markdown, links = []) {
      if (queue.length >= maxQueue) return Promise.resolve(FAILED);
      const key = createHash('sha256').update(markdown).update('\0').update(JSON.stringify(links)).digest('hex');
      if (slow.has(key)) return Promise.resolve(TIMED_OUT);
      return new Promise((resolve) => {
        queue.push({ id: nextId++, key, markdown, links, resolve });
        pump();
      });
    },
    close() {
      stop();
      for (const job of queue.splice(0)) job.resolve(FAILED);
      finish(FAILED);
    },
  };
}
