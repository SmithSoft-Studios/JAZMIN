import fs from 'node:fs';

// On Windows, update() and compact() replace a file that readers have open in two steps (update.js replaceOpenFile):
// the open file is moved aside and the new version renamed in, so for an instant the path is missing. Opening it is
// tried again after these waits (about 0.1 s in all) before the system's "not found" error is given.
const MISSING_WAITS_MS = [1, 3, 6, 12, 25, 50];

const tryAgain = (error, attempt) => process.platform === 'win32' && error.code === 'ENOENT' && attempt < MISSING_WAITS_MS.length;

/** fs.openSync, waiting briefly on Windows for a path that is missing while the file is replaced. */
export function openFileSync(path, flags) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.openSync(path, flags);
    } catch (error) {
      if (!tryAgain(error, attempt)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MISSING_WAITS_MS[attempt]);
    }
  }
}

/** openFileSync, or null when the path is still missing (reader.changed(): a file that is gone has changed). */
export function openFileOrNull(path, flags) {
  try {
    return openFileSync(path, flags);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** fs.open as a promise, waiting briefly on Windows for a path that is missing while the file is replaced. */
export async function openFileAsync(path, flags) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => fs.open(path, flags, (error, fd) => (error ? reject(error) : resolve(fd))));
    } catch (error) {
      if (!tryAgain(error, attempt)) throw error;
      await new Promise((resolve) => setTimeout(resolve, MISSING_WAITS_MS[attempt]));
    }
  }
}
