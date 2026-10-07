// The priority option: memory or speed first (user guide 20.4). Each choice sets thread counts only, so the file
// written and the rows read are the same whichever is chosen.
import os from 'node:os';
import { JazminValidationError } from './errors.js';

// Worker threads compressing chunks while writing. On a 300-column write, 4 threads were no faster than 2 (preparing
// rows on the main thread is the limit) and used 29 MB more, so speed uses 2 as well.
const WRITE_THREADS = { memory: 1, balanced: 2, speed: 2 };

// Worker threads decompressing (and decrypting) chunks ahead of a scan: speed only. Elsewhere chunks are decoded on
// the main thread as they are reached.
const READ_THREADS = { memory: 0, balanced: 0, speed: 4 };

/** Checks a priority option: 'memory', 'balanced' or 'speed'. */
export function checkPriority(priority) {
  if (typeof priority !== 'string' || !Object.hasOwn(WRITE_THREADS, priority)) {
    throw new JazminValidationError("priority must be 'memory', 'balanced' or 'speed'");
  }
}

const threads = (wanted) => (wanted ? Math.max(1, Math.min(os.availableParallelism() - 1, wanted)) : 0);

/** Default compression threads of a write: at most one fewer than the processors, at least 1. */
export function writeThreads(priority) {
  checkPriority(priority);
  return threads(WRITE_THREADS[priority]);
}

/** Threads decompressing chunks ahead of a scan: 0 for none (they are decoded on the main thread). */
export function readThreads(priority) {
  checkPriority(priority);
  return threads(READ_THREADS[priority]);
}
