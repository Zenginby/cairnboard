// Test worker: starts but never says it is ready and never answers.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {});
