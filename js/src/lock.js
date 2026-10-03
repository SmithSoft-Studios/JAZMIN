import fs from 'node:fs';
import { JazminError } from './errors.js';

/**
 * Runs `fn` while holding `<path>.lock`, so only one writer (append, update or compact) works on
 * a file at a time. Readers are never blocked.
 */
export function withLock(path, fn) {
  const lockPath = `${path}.lock`;
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new JazminError(`Another writer is changing ${path} (lock file ${lockPath} exists; delete it if no writer is running)`);
    }
    throw error;
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}
