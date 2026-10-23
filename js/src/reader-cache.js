// Keeps readers open across requests (issue #275): one encrypted file per tenant, dashboards, published views.
import crypto from 'node:crypto';
import path from 'node:path';
import { JazminValidationError } from './errors.js';
import { toMs } from './expiry.js';
import { parseAnyKey } from './keys.js';
import { ACCESS_EXPIRES, IDLE, JazminReader } from './reader.js';

/**
 * Open readers, kept for the next request, least recently used closed first. open() leases a reader: a reader can't
 * run two async queries at once, and closing or replacing one that another request is using would break it, so a
 * reader is replaced or closed only when no lease holds it.
 *
 * - An idle cached reader is checked with changed() on each open(); when its file changed it is replaced by refresh()
 *   and the old one closed.
 * - A reader in use gets a separate reader for that lease only, closed when the lease is released.
 * - Entries are matched by path and an HMAC of the key, password, unlock token, table and priority, under a secret made
 *   for this cache: no key or password is a map key.
 * - Each open() checks whether the cached reader's key has expired; if so the reader is dropped and the file opened
 *   again, which fails as open() would.
 */
export class JazminReaderCache {
  #max;
  #secret = crypto.randomBytes(32);
  #entries = new Map(); // id -> { reader, leases, retired }, least recently used first
  #closed = false;

  constructor({ max = 100 } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new JazminValidationError('max must be a whole number of readers, at least 1');
    this.#max = max;
  }

  /** How many readers are cached (readers of leases opened separately are not counted). */
  get size() {
    return this.#entries.size;
  }

  get max() {
    return this.#max;
  }

  /**
   * Leases a reader of the file at `file`, opened with `options` as open() takes them. Release the lease when the
   * request is done (`release()`, or `using`): the reader stays open for the next request.
   */
  open(file, options = {}) {
    if (this.#closed) throw new JazminValidationError('This reader cache is closed');
    if (typeof file !== 'string') throw new JazminValidationError('The reader cache opens files by path');
    const where = path.resolve(file);
    const id = this.#id(where, options);
    if (id === null) return this.#lease(null, new JazminReader(where, options)); // a key that can't be read: refused as open() refuses it
    let entry = this.#entries.get(id);
    if (entry) {
      this.#entries.delete(id);
      const expires = entry.reader[ACCESS_EXPIRES];
      if (expires !== undefined && toMs(options.now) > expires) {
        this.#retire(entry); // opened again below: refused as open() refuses an expired key
        entry = undefined;
      } else {
        this.#entries.set(id, entry); // the most recently used
      }
    }
    if (!entry) {
      const reader = new JazminReader(where, options);
      entry = { reader, leases: 0, retired: false };
      this.#entries.set(id, entry);
      this.#evict();
      return this.#lease(entry, reader);
    }
    if (entry.leases > 0) return this.#lease(null, new JazminReader(where, options));
    let fresh;
    try {
      fresh = entry.reader.refresh();
    } catch (error) {
      this.#entries.delete(id);
      this.#retire(entry);
      throw error;
    }
    if (fresh !== entry.reader) {
      entry.reader.close();
      entry.reader = fresh;
    }
    return this.#lease(entry, fresh);
  }

  /** Closes every cached reader; those leased now close when their leases are released. The cache stays usable. */
  clear() {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) this.#retire(entry);
  }

  /** clear(), and open() refuses from now on. */
  close() {
    this.#closed = true;
    this.clear();
  }

  [Symbol.dispose]() {
    this.close();
  }

  /** The entry's id: the path and an HMAC of what the reader was opened with; null for a key that can't be read. */
  #id(where, { key, password, unlockToken, table, priority = 'balanced' }) {
    let keyText = null;
    if (key !== undefined && key !== null) {
      try {
        keyText = parseAnyKey(key).export();
      } catch {
        return null;
      }
    }
    const mac = crypto.createHmac('sha256', this.#secret)
      .update(JSON.stringify([keyText, password ?? null, unlockToken ?? null, table ?? null, priority]))
      .digest('base64url');
    return `${where}\n${mac}`;
  }

  #lease(entry, reader) {
    if (entry) entry.leases++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!entry) reader.close();
      else if (--entry.leases === 0) {
        if (entry.retired) entry.reader.close();
        else entry.reader[IDLE](); // waiting for the next request: only what the next query needs again is kept
      }
    };
    return { reader, release, [Symbol.dispose]: release };
  }

  /** Out of the cache: closed now, or when its last lease is released. */
  #retire(entry) {
    entry.retired = true;
    if (entry.leases === 0) entry.reader.close();
  }

  #evict() {
    while (this.#entries.size > this.#max) {
      const [id, entry] = this.#entries.entries().next().value;
      this.#entries.delete(id);
      this.#retire(entry);
    }
  }
}
