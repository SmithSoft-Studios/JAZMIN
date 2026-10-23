import fs from 'node:fs';
import { JazminError } from './errors.js';

function takeLock(path) {
  const lockPath = `${path}.lock`;
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new JazminError(`Another writer is changing ${path} (lock file ${lockPath} exists; delete it if no writer is running)`);
    }
    throw error;
  }
}

function releaseLock(path, fd) {
  fs.closeSync(fd);
  fs.rmSync(`${path}.lock`, { force: true });
}

/**
 * Runs `fn` while holding `<path>.lock`, so only one writer (append, update or compact) works on
 * a file at a time. Readers are never blocked.
 */
export function withLock(path, fn) {
  const fd = takeLock(path);
  try {
    return fn();
  } finally {
    releaseLock(path, fd);
  }
}

/** withLock for an async `fn`: the lock is held until its promise settles. */
export async function withLockAsync(path, fn) {
  const fd = takeLock(path);
  try {
    return await fn();
  } finally {
    releaseLock(path, fd);
  }
}
