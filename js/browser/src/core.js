  const PREAMBLE = 64;
  const TRAILER = 44;
  const ENVELOPE = 16;
  const FLAG_ENCRYPTED = 0x1;
  const FLAG_PASSWORD = 0x2;
  const FLAG_ACCESS = 0x4;
  const KNOWN_FLAGS = 0xf;
  const CODEC_NONE = 0;
  const CODEC_DEFLATE = 1;
  const CODEC_BROTLI = 2;
  const MIN_KDF_ITERATIONS = 1000;
  const MAX_KDF_ITERATIONS = 10000000;
  const TYPE_NAMES = ['', 'bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json', 'list', 'object'];
  const ENCODING = { plain: 0, delta: 1, dictionary: 2, bitmap: 3, scaled: 4, nested: 5 };
  const NESTED_COLUMNS = 'nested-columns'; // reader feature (spec 5.4): list and object columns
  const MAX_NESTING_DEPTH = 64;
  const isNested = (type) => type === 'list' || type === 'object';
  const HAS_NULLS = 0x10;
  const POW10 = Array.from({ length: 23 }, (_, s) => 10 ** s);
  const SLOT_ID = 8;
  const SLOT_ENTRY = SLOT_ID + 8;
  const PAGE_ENTRY = SLOT_ID + 8 + 4 + 32;
  const ONLINE_SLOT = 0x80000000;
  const WHOLE_TABLE = '*';
  const EVERYONE = '*';
  const subtle = global.crypto.subtle;
  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8', { fatal: false });

  class JazminError extends Error {
    constructor(message) {
      super(message);
      this.name = 'JazminError';
    }
  }

  class JazminFormatError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminFormatError';
    }
  }

  class JazminKeyError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminKeyError';
    }
  }

  /** An online key needs an unlock token from the owner's key service: send fileId and keyId to it. */
  class JazminUnlockRequiredError extends JazminKeyError {
    constructor(message, fileId, keyId) {
      super(message);
      this.name = 'JazminUnlockRequiredError';
      this.fileId = fileId;
      this.keyId = keyId;
    }
  }

  /** A stored file is locked (spec 6.8.1): reader.unlock(lock, { password, unlockToken }) opens it. */
  class JazminFileLockedError extends JazminKeyError {
    constructor(message, path, lock, kind) {
      super(message);
      this.name = 'JazminFileLockedError';
      this.path = path;
      this.lock = lock;
      this.kind = kind;
    }
  }

  /**
   * A File is a snapshot: once the file changes on disk (rewritten, appended to, replaced), the browser refuses to read
   * it. Choosing the file again gives a File that reads. `cause`: the browser's own error.
   */
  class JazminFileChangedError extends JazminError {
    constructor(cause) {
      super('The file changed on disk since it was opened: open it again.');
      this.name = 'JazminFileChangedError';
      this.cause = cause;
    }
  }

  // ---- bytes -------------------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }

  function base64ToBytes(text) {
    const bin = global.atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const base64UrlToBytes = (text) => base64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

  function bytesToBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return global.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // A section is a read and several WebCrypto calls, each answered on another thread: sections read together overlap
  // those waits, which a key spanning thousands of partitions otherwise pays one after another (issue #258).
  const PARALLEL_SECTIONS = 16;
  const MERGE_GAP = 16 * 1024; // sections read together when this close (readSections)
  const MERGE_SPAN = 1024 * 1024; // and up to this many bytes at a time
  const MERGE_ITEMS = 256; // sections read and decoded at a time (inBatches)
  const STATS_LOADED = Promise.resolve();

  /**
   * Items in consecutive batches of at most MERGE_ITEMS whose sections (refOf(item)) add up to at most MERGE_SPAN bytes:
   * what is read and decoded at once.
   */
  function inBatches(items, refOf) {
    const batches = [];
    let bytes = Infinity;
    for (const item of items) {
      const length = refOf(item)?.length ?? 0;
      if (bytes + length > MERGE_SPAN || batches.at(-1).length >= MERGE_ITEMS) {
        batches.push([]);
        bytes = 0;
      }
      batches.at(-1).push(item);
      bytes += length;
    }
    return batches;
  }

  /** run(fn): calls fn() when fewer than `limit` calls are still running; a promise of its result. */
  function limiter(limit) {
    let active = 0;
    const waiting = [];
    let first = 0;
    const next = () => {
      while (active < limit && first < waiting.length) {
        active++;
        const start = waiting[first];
        waiting[first++] = null;
        start();
      }
      if (first === waiting.length) waiting.length = first = 0;
    };
    return (fn) => new Promise((resolve, reject) => {
      waiting.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        next();
      }));
      next();
    });
  }

  // ---- cryptography (WebCrypto only) ---------------------------------------------------------------

  async function sha256(...parts) {
    return new Uint8Array(await subtle.digest('SHA-256', parts.length === 1 ? parts[0] : concat(...parts)));
  }

  const SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  /** SHA-256 (FIPS 180-4) fed in pieces, { update(bytes), digest() }: WebCrypto hashes only whole buffers. */
  function sha256Stream() {
    const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Int32Array(64);
    const block = new Uint8Array(64);
    const blockView = view(block);
    let filled = 0;
    let total = 0;
    const compress = (dv, at) => {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(at + 4 * i, false);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7]
          + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
      }
      let a = h[0];
      let b2 = h[1];
      let c = h[2];
      let d = h[3];
      let e = h[4];
      let f = h[5];
      let g = h[6];
      let hh = h[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
        const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b2) ^ (a & c) ^ (b2 & c))) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b2;
        b2 = a;
        a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b2) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    };
    return {
      update(bytes) {
        total += bytes.length;
        let i = 0;
        if (filled) {
          const n = Math.min(64 - filled, bytes.length);
          block.set(bytes.subarray(0, n), filled);
          filled += n;
          i = n;
          if (filled < 64) return;
          compress(blockView, 0);
          filled = 0;
        }
        const dv = view(bytes);
        for (; i + 64 <= bytes.length; i += 64) compress(dv, i);
        if (i < bytes.length) {
          block.set(bytes.subarray(i), 0);
          filled = bytes.length - i;
        }
      },
      digest() {
        block[filled++] = 0x80;
        if (filled > 56) {
          block.fill(0, filled);
          compress(blockView, 0);
          filled = 0;
        }
        block.fill(0, filled, 56);
        blockView.setUint32(56, Math.floor(total / 0x20000000), false);
        blockView.setUint32(60, (total * 8) >>> 0, false);
        compress(blockView, 0);
        const out = new Uint8Array(32);
        const v = view(out);
        for (let i = 0; i < 8; i++) v.setUint32(4 * i, h[i], false);
        return out;
      },
    };
  }

  async function hkdf(ikm, salt, info, bits = 256) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, base, bits));
  }

  async function hmacSha256(key, data) {
    const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, data));
  }

  async function pbkdf2(password, salt, iterations) {
    const base = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }

  async function decrypt(keyBytes, payload, aad) {
    if (payload.length < 28) throw new JazminKeyError('Encrypted section is too short');
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12), additionalData: aad }, key, payload.subarray(12)));
    } catch {
      throw new JazminKeyError('Decryption failed - wrong key or password, or the file was tampered with');
    }
  }

  async function inflateRaw(bytes, rawLength) {
    // Written into the stream as they are: a Blob made of them would be another trip to the browser's blob store.
    const inflate = new DecompressionStream('deflate-raw');
    const input = inflate.writable.getWriter();
    input.write(bytes).catch(() => {}); // a failure is the reader's to report
    input.close().catch(() => {});
    const reader = inflate.readable.getReader();
    const out = new Uint8Array(rawLength);
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > rawLength) throw new JazminFormatError('A section is longer than its declared length'); // stops a decompression bomb
        out.set(value, at);
        at += value.length;
      }
    } catch (error) {
      if (error instanceof JazminError) throw error;
      throw new JazminFormatError('A section could not be decompressed');
    } finally {
      reader.cancel().catch(() => {});
    }
    if (at !== rawLength) throw new JazminFormatError('A section has the wrong decompressed length');
    return out;
  }

  /**
   * Whether `publicKey` (from the file's signature section) belongs to this owner key. The signing key is derived as in
   * spec 7.6.1: d = (HKDF(owner key, "", "JAZMIN/1/owner-signing", 48) mod (n - 1)) + 1. WebCrypto cannot compute d's
   * public point in every browser, so d is imported with the file's point and a challenge is signed: the signature
   * verifies against that point only when the point is d's.
   */
  async function verifySignature(publicKey, message, signature) {
    let key;
    try {
      key = await subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      return false; // not a point on the curve: a signature that doesn't verify
    }
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
  }

  // ---- keys ---------------------------------------------------------------------------------------

  // A master (owner) key controls the whole of a shared file: in a page it could be stolen, so browsers never take one.
  const MASTER_KEY_REFUSED = "A master key can't be used in a browser for a shared file: it controls the whole file, and a page could leak it. "
    + "Open the file with an access key. To see everything, the owner can create a full-read access key "
    + "(grantAccess(file, ownerKey, key, { rows: '*', columns: '*' }) in the library).";

  async function checksum(bytes) {
    return (await sha256(bytes)).subarray(0, 4);
  }

  /** A key's text: { kind: 'owner', bytes } (jzk1-) or { kind: 'access', secret, fingerprint } (jza1-); checksums are verified. */
  async function parseKey(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t.startsWith('jzk1-')) {
      const raw = base64UrlToBytes(t.slice(5));
      if (raw.length !== 36) throw new JazminKeyError('Key text has the wrong length');
      if (!equal(await checksum(raw.subarray(0, 32)), raw.subarray(32))) throw new JazminKeyError('Key checksum mismatch - the key is mistyped or incomplete');
      return { kind: 'owner', bytes: raw.slice(0, 32) };
    }
    if (t.startsWith('jza1-')) {
      const raw = base64UrlToBytes(t.slice(5));
      if (raw.length !== 44) throw new JazminKeyError('Access key text has the wrong length');
      if (!equal(await checksum(raw.subarray(0, 40)), raw.subarray(40))) throw new JazminKeyError('Key checksum mismatch - the key is mistyped or incomplete');
      return { kind: 'access', secret: raw.slice(0, 32), fingerprint: raw.slice(32, 40) };
    }
    throw new JazminKeyError("A key starts with 'jzk1-' (master or owner key) or 'jza1-' (access key)");
  }

  /** Key text ("jzk1-...") of 32 key bytes. */
  async function keyText(bytes) {
    return `jzk1-${bytesToBase64Url(concat(bytes, await checksum(bytes)))}`;
  }

  async function parseUnlockToken(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t.startsWith('jzu1-')) throw new JazminKeyError("An unlock token starts with 'jzu1-'");
    const raw = base64UrlToBytes(t.slice(5));
    if (raw.length !== 36 || !equal(await checksum(raw.subarray(0, 32)), raw.subarray(32))) {
      throw new JazminKeyError('Unlock token checksum mismatch - the token is mistyped or corrupted');
    }
    return raw.slice(0, 32);
  }

  const slotId = async (secret) => (await sha256(utf8.encode('JAZMIN/1/slot-id'), secret)).subarray(0, SLOT_ID);

  // ---- locked stored files (spec 6.8.1) ------------------------------------------------------------

  const LOCK_KINDS = ['password', 'online', 'both'];

  /** An online lock's secret from its unlock token: "jzf1-" + base64url(S || SHA-256(S)[0..3]). */
  async function parseFileUnlockToken(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t.startsWith('jzf1-')) throw new JazminKeyError("A file unlock token starts with 'jzf1-'");
    const raw = base64UrlToBytes(t.slice(5));
    if (raw.length !== 36) throw new JazminKeyError('Unlock token has the wrong length');
    if (!equal(await checksum(raw.subarray(0, 32)), raw.subarray(32))) throw new JazminKeyError('Unlock token checksum mismatch - the token is mistyped or corrupted');
    return raw.slice(0, 32);
  }

  /** What a lock needs to open, in words. */
  function lockNeeds(kind) {
    const token = "an unlock token from the file owner's key service";
    return kind === 'password' ? 'its password' : kind === 'online' ? token : `its password and ${token}`;
  }

  /** The lock key L from its password and/or secret S. */
  async function lockKey(lock, password, secret) {
    const fromPassword = lock.kind === 'online' ? null : await pbkdf2(password, lock.salt, lock.iterations);
    if (lock.kind === 'password') return fromPassword;
    return hkdf(lock.kind === 'online' ? secret : concat(fromPassword, secret), lock.salt, `JAZMIN/1/lock/${lock.id}`);
  }

  const sealAad = (id, contentId) => utf8.encode(`JAZMIN/1/lock/${id}/${contentId}`);
  const groupAad = (id, group) => utf8.encode(`JAZMIN/1/lock/${id}/column-group/${group}`);

  /**
   * A key slot's masked columns (spec 7.6.8): { locks: Map(id -> lock), groups: Map(group -> { lock, sealed, column }) };
   * empty when the slot has none. A member that isn't well-formed is refused.
   */
  function readBundleMasks(masks) {
    const out = { locks: new Map(), groups: new Map() };
    if (masks === undefined) return out;
    const ok = (test) => {
      if (!test) throw new JazminFormatError("The key slot's masked columns are malformed");
    };
    ok(masks && typeof masks === 'object' && masks.locks && typeof masks.locks === 'object' && masks.groups && typeof masks.groups === 'object');
    for (const [id, l] of Object.entries(masks.locks)) {
      ok(l && LOCK_KINDS.includes(l.kind) && typeof l.salt === 'string');
      out.locks.set(id, { id, kind: l.kind, salt: base64ToBytes(l.salt), iterations: l.iterations, keys: new Map(), keyService: keyServiceAddress(l.keyService) });
    }
    for (const [group, g] of Object.entries(masks.groups)) {
      const c = g?.column;
      ok(g && out.locks.has(g.lock) && typeof g.sealed === 'string' && c && Number.isSafeInteger(c.table) && Number.isSafeInteger(c.position)
        && typeof c.name === 'string' && typeof c.type === 'string');
      out.groups.set(group, { lock: g.lock, sealed: g.sealed, column: c });
    }
    return out;
  }

  /** A key service's address (spec 6.8.2): an https URL without a user name, password or fragment; else undefined. */
  function keyServiceAddress(value) {
    if (typeof value !== 'string') return undefined;
    let url;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password && !url.hash ? url.href : undefined;
  }

  // ---- binary readers -----------------------------------------------------------------------------

  /** Little-endian reader over a Uint8Array, mirroring the library's ByteReader. */
  class Reader {
    constructor(bytes, pos = 0) {
      this.buf = bytes;
      this.view = view(bytes);
      this.pos = pos;
    }

    need(n) {
      if (!(n >= 0) || this.pos + n > this.buf.length) throw new JazminFormatError('Unexpected end of data');
    }

    get remaining() {
      return this.buf.length - this.pos;
    }

    byte() {
      this.need(1);
      return this.buf[this.pos++];
    }

    bytes(n) {
      this.need(n);
      const out = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }

    u16() {
      this.need(2);
      const v = this.view.getUint16(this.pos, true);
      this.pos += 2;
      return v;
    }

    float64() {
      this.need(8);
      const v = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    }

    /** Unsigned varint as a BigInt (up to `max` bytes). */
    bigVarUint(max = 10) {
      let result = 0n;
      let shift = 0n;
      for (let count = 0; ; count++) {
        if (count === max) throw new JazminFormatError('Varint too long');
        const b = this.byte();
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) return result;
      }
    }

    /**
     * Unsigned varint: read with numbers when it has at most 7 bytes (49 bits, exact as a double), as the library
     * reads it, else as a BigInt. BigInt arithmetic for every value made decoding several times slower.
     */
    numberVarUint() {
      const start = this.pos;
      let result = 0;
      let multiplier = 1;
      for (let count = 0; ; count++) {
        if (count === 10) throw new JazminFormatError('Varint too long');
        const b = this.byte();
        result += (b & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(b & 0x80)) {
          if (count < 7) return result;
          this.pos = start;
          return this.bigVarUint();
        }
      }
    }

    /** Unsigned varint that must fit a safe integer (lengths, counts, offsets). */
    varUint() {
      const v = this.numberVarUint();
      if (typeof v === 'number') return v;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new JazminFormatError('Value out of range');
      return Number(v);
    }

    /** Zigzag varint: a Number when it is safe, else a BigInt (as the library returns). */
    varInt() {
      const z = this.numberVarUint();
      if (typeof z === 'number') return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      const v = z & 1n ? -((z + 1n) >> 1n) : z >> 1n;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }

    string() {
      return fromUtf8.decode(this.bytes(this.varUint()));
    }

    get eof() {
      return this.pos === this.buf.length;
    }
  }

  const text = (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return fromUtf8.decode(bytes);
  };
  const num = (v) => {
    if (typeof v !== 'number') throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return v;
  };
  const bytesOf = (v) => {
    if (!(v instanceof Uint8Array)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return v;
  };

  /** As the library's parseJsonText: uniqueNames for the JSON the reader uses itself (spec 2). */
  function parseJson(textValue, what, uniqueNames = false) {
    let value;
    try {
      value = JSON.parse(textValue);
    } catch {
      throw new JazminFormatError(`${what} is not valid JSON`);
    }
    if (uniqueNames && repeatsName(textValue)) throw new JazminFormatError(`${what} is not valid JSON: a name appears twice in one object`);
    return value;
  }

  /** Whether valid JSON text repeats a name in one object, comparing names with their escapes decoded. */
  function repeatsName(text) {
    const open = []; // per open object: the names seen in it; null for an open array
    let name = false; // the next string is a name
    let slash = text.indexOf('\\'); // the next backslash: there are none in most strings
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) { // '"': a string, which ends at the first quote unless a backslash comes before it
        let end = text.indexOf('"', i + 1);
        const escaped = slash !== -1 && slash < end;
        if (escaped) for (end = i + 1; text.charCodeAt(end) !== 34; end++) if (text.charCodeAt(end) === 92) end++;
        if (name) {
          const names = open[open.length - 1];
          const key = escaped ? JSON.parse(text.slice(i, end + 1)) : text.slice(i + 1, end);
          if (names.has(key)) return true;
          names.add(key);
          name = false;
        }
        i = end;
        if (escaped) slash = text.indexOf('\\', end);
      } else if (c === 123) { // '{'
        open.push(new Set());
        name = true;
      } else if (c === 91) open.push(null); // '['
      else if (c === 125 || c === 93) open.pop(); // '}' ']'
      else if (c === 44) name = open[open.length - 1] !== null; // ','
    }
    return false;
  }

  function dateFromMs(ms) {
    return new Date(msFromFile(ms));
  }

  /** A datetime read from a file, as milliseconds since 1970, checked as dateFromMs() does. */
  function msFromFile(ms) {
    const n = Number(ms);
    if (!(Math.abs(n) <= 8.64e15)) throw new JazminFormatError('A datetime value is out of range');
    return n;
  }

  // ---- catalog (Protocol Buffers wire format, spec/jazmin.proto) ----------------------------------

  /** Calls onField(field, value) for each field: varints as Numbers, length-delimited fields as bytes. */
  function readMessage(bytes, onField) {
    const r = new Reader(bytesOf(bytes));
    while (!r.eof) {
      const tag = r.varUint();
      const field = Math.floor(tag / 8);
      if (field === 0) throw new JazminFormatError('Catalog message has an invalid field');
      switch (tag & 7) {
        case 0: onField(field, r.varUint()); break;
        case 1: r.bytes(8); break;
        case 2: onField(field, r.bytes(r.varUint())); break;
        case 5: r.bytes(4); break;
        default: throw new JazminFormatError(`Catalog: unsupported wire type ${tag & 7}`);
      }
    }
  }

  function readPacked(value) {
    if (typeof value === 'number') return [value];
    const r = new Reader(bytesOf(value));
    const out = [];
    while (!r.eof) out.push(r.varUint());
    return out;
  }

  const cumulative = (values) => {
    let total = 0;
    return values.map((v) => (total += v));
  };

  function readRef(bytes) {
    const ref = { offset: 0, length: 0, digest: null };
    readMessage(bytes, (f, v) => {
      if (f === 1) ref.offset = num(v);
      else if (f === 2) ref.length = num(v);
      else if (f === 3) ref.digest = bytesOf(v).slice();
    });
    return ref;
  }

  function readColumn(bytes, depth = 0) {
    if (depth > MAX_NESTING_DEPTH) throw new JazminFormatError(`Columns are nested more than ${MAX_NESTING_DEPTH} levels deep`);
    const c = { position: 0, name: '', type: '', nullable: true };
    readMessage(bytes, (f, v) => {
      if (f === 1) c.position = num(v);
      else if (f === 2) c.name = text(v);
      else if (f === 3) c.type = TYPE_NAMES[num(v)] || '';
      else if (f === 4) c.nullable = num(v) === 0;
      else if (f === 5) c.description = text(v);
      else if (f === 6) c.attributes = parseJson(text(v), 'Column attributes', true);
      else if (f === 7 && num(v) !== 0) throw new JazminFormatError(`Column '${c.name}' uses an unknown time unit`);
      else if (f === 8) (c.fields ??= []).push(readColumn(v, depth + 1)); // objects: their fields (spec 5.4)
      else if (f === 9) c.item = readColumn(v, depth + 1); // lists: their items
    });
    if (!c.type) throw new JazminFormatError(`Column '${c.name}' has an unknown type`);
    // A list has exactly its item, an object its fields (positions in order, names unique), nothing else.
    const shaped = c.type === 'list' ? c.item !== undefined && c.fields === undefined
      : c.type === 'object' ? c.item === undefined && c.fields?.length > 0 && c.fields.every((f, i) => f.position === i)
        && new Set(c.fields.map((f) => f.name)).size === c.fields.length
        : c.item === undefined && c.fields === undefined;
    if (!shaped) throw new JazminFormatError(`Column '${c.name}' has an invalid structure`);
    return c;
  }

  function readPartition(bytes) {
    const p = { id: new Uint8Array(0), segments: [] };
    readMessage(bytes, (f, v) => {
      if (f === 1) p.id = bytesOf(v).slice();
      else if (f === 2) p.segments.push(readRef(v));
    });
    return p;
  }

  function readIndexRef(bytes) {
    const ix = { column: '', kind: '', section: null, segment: 0 };
    readMessage(bytes, (f, v) => {
      if (f === 1) ix.column = text(v);
      else if (f === 2) ix.kind = text(v);
      else if (f === 3) ix.section = readRef(v);
      else if (f === 4) ix.segment = num(v);
    });
    return ix;
  }

  function readTable(bytes) {
    const t = {
      name: '', columnCount: 0, groups: [], sortedBy: [], partitionBy: '', rowCount: 0, deletedCount: 0, chunkCount: 0,
      partitions: [], partitionTable: null, deletes: null, indexes: [], sort: [],
    };
    readMessage(bytes, (f, v) => {
      switch (f) {
        case 1: t.name = text(v); break;
        case 2: t.columnCount = num(v); break;
        case 3: {
          const g = { name: '', columns: [], columnCount: 0, definitions: null };
          readMessage(v, (gf, gv) => {
            if (gf === 1) g.name = text(gv);
            else if (gf === 2) g.columns.push(readColumn(gv));
            else if (gf === 3) g.columnCount = num(gv);
            else if (gf === 4) g.definitions = readRef(gv);
          });
          t.groups.push(g);
          break;
        }
        case 4: t.sortedBy.push(text(v)); break;
        case 5: t.partitionBy = text(v); break;
        case 6: t.rowCount = num(v); break;
        case 7: t.deletedCount = num(v); break;
        case 8: t.chunkCount = num(v); break;
        case 9: t.partitions.push(readPartition(v)); break;
        case 10: t.partitionTable = readRef(v); break;
        case 11: t.indexes.push(readIndexRef(v)); break;
        case 12: t.deletes = readRef(v); break;
        case 13: { // other text orders (spec 6.7)
          const k = { column: '' };
          readMessage(v, (kf, kv) => {
            if (kf === 1) k.column = text(kv);
            else if (kf === 2 && num(kv)) k.nocase = true;
            else if (kf === 3 && num(kv)) k.natural = true;
          });
          t.sort.push(k);
          break;
        }
        default: break;
      }
    });
    return t;
  }

  // ---- limits per key on what a key may send back (spec 7.9.1), as the library reads them ------------------------

  /** Whether package.edit is well formed enough to use: a key and columns of names. */
  function editSettings(edit) {
    return edit !== null && typeof edit === 'object' && Array.isArray(edit.key) && edit.key.length > 0
      && (edit.columns === undefined || (Array.isArray(edit.columns) && edit.columns.every((c) => typeof c === 'string')));
  }

  /**
   * A key's stored limit: { edit, lost }. In a file with limits, none means an older release lost it; a limit with other
   * members or of another type can't be read; either way the key may send nothing. {} is no limit.
   */
  function readEditLimit(value, limitsFile) {
    if (value === undefined) return { edit: undefined, lost: limitsFile };
    const bad = { edit: undefined, lost: true };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad;
    const out = {};
    for (const [name, v] of Object.entries(value)) {
      if (name === 'columns') {
        if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.length) || new Set(v).size !== v.length) return bad;
        out.columns = [...v];
      } else if (name === 'add' || name === 'delete') {
        if (typeof v !== 'boolean') return bad;
        out[name] = v;
      } else return bad;
    }
    const ordered = Object.fromEntries(['columns', 'add', 'delete'].filter((k) => k in out).map((k) => [k, out[k]]));
    return { edit: Object.keys(ordered).length ? ordered : undefined, lost: false };
  }

  /** The document's settings narrowed by a key's limit and the columns it sees (null: not known here). */
  function effectiveEdit(edit, limit, visible, lost) {
    if (lost) return { ...edit, columns: [], add: false, delete: false };
    return {
      ...edit,
      columns: (edit.columns ?? []).filter((c) => (!limit?.columns || limit.columns.includes(c)) && (!visible || visible.has(c))),
      add: edit.add === true && limit?.add !== false,
      delete: edit.delete === true && limit?.delete !== false,
    };
  }

  function readHeader(bytes) {
    const h = { readerFeatures: [], writerFeatures: [], metadata: '', tables: [], keyring: {}, files: null, access: null, deltas: [], appendCount: 0, created: 0, modified: 0 };
    readMessage(bytes, (f, v) => {
      switch (f) {
        case 1: h.readerFeatures.push(text(v)); break;
        case 2: h.writerFeatures.push(text(v)); break;
        case 3: h.created = num(v); break;
        case 4: h.modified = num(v); break;
        case 5: h.appendCount = num(v); break;
        case 6: h.metadata = text(v); break;
        case 7: h.tables.push(readTable(v)); break;
        case 8:
          readMessage(v, (kf, kv) => {
            const group = ['', 'data', 'index', 'files'][kf];
            if (group) h.keyring[group] = bytesOf(kv).slice();
          });
          break;
        case 9: {
          const files = { directories: [], package: '', segment: 0 };
          readMessage(v, (ff, fv) => {
            if (ff === 1) {
              const d = { group: '', section: null };
              readMessage(fv, (df, dv) => {
                if (df === 1) d.group = text(dv);
                else if (df === 2) d.section = readRef(dv);
              });
              files.directories.push(d);
            } else if (ff === 3) files.package = text(fv);
            else if (ff === 4) files.segment = num(fv);
          });
          h.files = files;
          break;
        }
        case 10: {
          const access = { ownerDirectory: null };
          readMessage(v, (af, av) => {
            if (af === 1) access.ownerDirectory = readRef(av);
          });
          h.access = access;
          break;
        }
        case 11: h.deltas.push(readRef(v)); break;
        default: break;
      }
    });
    return h;
  }

  /**
   * A chunk-directory segment (spec 6.3): one entry per chunk, with its parts (one per column group), and its
   * statistics blocks ({ columns, section }).
   */
  function readDirectory(bytes, groupCount) {
    let ordinals = [];
    let rowStarts = [];
    let rowCounts = [];
    let offsets = [];
    let lengths = [];
    let digests = null;
    const statistics = [];
    readMessage(bytes, (f, v) => {
      if (f === 1) ordinals = cumulative(readPacked(v));
      else if (f === 2) rowStarts = cumulative(readPacked(v));
      else if (f === 3) rowCounts = readPacked(v);
      else if (f === 4) offsets = cumulative(readPacked(v));
      else if (f === 5) lengths = readPacked(v);
      else if (f === 6) digests = bytesOf(v);
      else if (f === 7) {
        const block = { columns: [], section: null };
        readMessage(v, (bf, bv) => {
          if (bf === 1) block.columns = readPacked(bv);
          else if (bf === 2) block.section = readRef(bv);
        });
        statistics.push(block);
      }
    });
    const n = ordinals.length;
    if (rowStarts.length !== n || rowCounts.length !== n || offsets.length !== n * groupCount || lengths.length !== n * groupCount
      || (digests && digests.length !== n * groupCount * 32)) {
      throw new JazminFormatError('Chunk directory lists are inconsistent');
    }
    const chunks = ordinals.map((ordinal, i) => ({
      ordinal,
      rowStart: rowStarts[i],
      rowCount: rowCounts[i],
      parts: Array.from({ length: groupCount }, (_, g) => {
        const k = i * groupCount + g;
        return { offset: offsets[k], length: lengths[k], digest: digests ? digests.slice(k * 32, k * 32 + 32) : null };
      }),
    }));
    return { chunks, statistics };
  }

  /** A statistics section (spec 6.4): per column, null counts and bounds (key-form bytes) for each chunk. */
  function readStatistics(bytes) {
    const columns = [];
    readMessage(bytes, (f, v) => {
      if (f !== 1) return;
      const c = { nulls: [], min: [], max: [], leaves: [] };
      readMessage(v, (cf, cv) => {
        if (cf === 1) c.nulls = readPacked(cv);
        else if (cf === 2) c.min.push(bytesOf(cv));
        else if (cf === 3) c.max.push(bytesOf(cv));
        else if (cf === 4) { // a nested column's leaf (spec 6.4)
          const leaf = { path: [], counts: [], nulls: [], min: [], max: [] };
          readMessage(cv, (lf, lv) => {
            if (lf === 1) leaf.path = readPacked(lv);
            else if (lf === 2) leaf.counts = readPacked(lv);
            else if (lf === 3) leaf.nulls = readPacked(lv);
            else if (lf === 4) leaf.min.push(bytesOf(lv));
            else if (lf === 5) leaf.max.push(bytesOf(lv));
          });
          c.leaves.push(leaf);
        }
      });
      columns.push(c);
    });
    return columns;
  }

  /**
   * What viewers may do with a file (spec 6.8): the actions this reader knows, of the right types (as the library's
   * readActions): open, save, print, image, list (true or false), pdf (true, false, or the page settings).
   */
  const FILE_FLAGS = ['open', 'save', 'print', 'image', 'list'];

  function fileActions(actions) {
    if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) return undefined;
    const out = {};
    for (const name of FILE_FLAGS) if (typeof actions[name] === 'boolean') out[name] = actions[name];
    if (typeof actions.pdf === 'boolean' || (actions.pdf !== null && typeof actions.pdf === 'object' && !Array.isArray(actions.pdf))) out.pdf = actions.pdf;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * A page in a file group's directory (spec 6.8), as the library's readPage: members of the wrong type left out; none
   * without a title.
   */
  function pageOf(page) {
    if (page === null || typeof page !== 'object' || Array.isArray(page) || typeof page.title !== 'string') return undefined;
    const out = { title: page.title };
    if (page.online === 'required' || page.online === 'optional') out.online = page.online;
    if (typeof page.table === 'string') out.table = page.table;
    if (page.pdf !== null && typeof page.pdf === 'object' && !Array.isArray(page.pdf)) out.pdf = page.pdf;
    if (page.actions !== null && typeof page.actions === 'object' && !Array.isArray(page.actions)) {
      const actions = Object.fromEntries(['print', 'pdf', 'image'].filter((a) => typeof page.actions[a] === 'boolean').map((a) => [a, page.actions[a]]));
      if (Object.keys(actions).length) out.actions = actions;
    }
    if (Number.isInteger(page.order)) out.order = page.order;
    return out;
  }

  /**
   * Actions seen through two file groups, as one (as the library's mergeActions): allowed when either allows (an action
   * left out is allowed); page settings for PDFs are the first's that allows them.
   */
  function mergeActions(a, b) {
    if (!a || !b) return undefined;
    const out = {};
    for (const name of FILE_FLAGS) if (name in a && name in b) out[name] = a[name] || b[name];
    if ('pdf' in a && 'pdf' in b) out.pdf = a.pdf === false ? b.pdf : a.pdf;
    return Object.keys(out).length ? out : undefined;
  }

  /** A sorted index's directory (spec 8.1): its pages ({ first, count, offset, length, digest }) and null postings. */
  function readIndexDirectory(bytes) {
    const firsts = [];
    let counts = [];
    let offsets = [];
    let lengths = [];
    let digests = null;
    let nulls = null;
    readMessage(bytes, (f, v) => {
      if (f === 1) firsts.push(bytesOf(v));
      else if (f === 2) counts = readPacked(v);
      else if (f === 3) offsets = cumulative(readPacked(v));
      else if (f === 4) lengths = readPacked(v);
      else if (f === 5) digests = bytesOf(v);
      else if (f === 6) nulls = readRef(v);
    });
    const n = firsts.length;
    if (counts.length !== n || offsets.length !== n || lengths.length !== n || (digests && digests.length !== n * 32)) {
      throw new JazminFormatError('Index directory lists are inconsistent');
    }
    return {
      pages: firsts.map((first, i) => ({ first, count: counts[i], offset: offsets[i], length: lengths[i], digest: digests ? digests.slice(i * 32, i * 32 + 32) : null })),
      nulls,
    };
  }

  function readPartitionList(bytes) {
    const partitions = [];
    readMessage(bytes, (f, v) => {
      if (f === 1) partitions.push(readPartition(v));
    });
    return partitions;
  }

  function readDelta(bytes) {
    const tables = [];
    readMessage(bytes, (f, v) => {
      if (f !== 1) return;
      const t = { table: 0, partitions: [] };
      readMessage(v, (tf, tv) => {
        if (tf === 1) t.table = num(tv);
        else if (tf === 2) t.partitions.push(readPartition(tv));
      });
      tables.push(t);
    });
    return tables;
  }

  /** Postings: count, then differences between ascending row ids. */
  function readPostings(r) {
    const count = r.varUint();
    if (count > r.remaining) throw new JazminFormatError('Postings are truncated');
    const ids = new Array(count);
    let previous = 0;
    for (let i = 0; i < count; i++) {
      previous += r.varUint();
      if (previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      ids[i] = previous;
    }
    return ids;
  }

  /** A postings section (deleted rows, null cells): encoding byte, then postings. */
  function readPostingsSection(bytes, what = 'Deleted rows') {
    const r = new Reader(bytes);
    if (r.byte() !== 0) throw new JazminFormatError(`${what} use an encoding this reader does not support`);
    const ids = readPostings(r);
    if (!r.eof) throw new JazminFormatError(`${what} have trailing bytes`);
    return ids;
  }

  /** A file directory's saved export shapes (spec 6.8): its well-formed entries; others are ignored, as other members. */
  function directoryShapes(d) {
    if (!Array.isArray(d.shapes)) return [];
    return d.shapes.filter((s) => s !== null && typeof s === 'object' && typeof s.name === 'string' && s.name !== ''
      && s.shape !== null && typeof s.shape === 'object' && !Array.isArray(s.shape)
      && (s.description === undefined || typeof s.description === 'string') && (s.default === undefined || typeof s.default === 'boolean')
      && (s.table === undefined || typeof s.table === 'string')
      && (s.groups === undefined || (Array.isArray(s.groups) && s.groups.every((g) => typeof g === 'string'))));
  }

  function checkFileDirectory(d) {
    const ok = (test) => {
      if (!test) throw new JazminFormatError('An embedded-file directory is malformed');
    };
    const count = (v) => Number.isSafeInteger(v) && v >= 0;
    ok(d && typeof d === 'object' && Array.isArray(d.files) && Array.isArray(d.contents));
    for (const c of d.contents) {
      ok(c && count(c.id) && count(c.size) && typeof c.sha256 === 'string' && Array.isArray(c.blocks));
      ok(count(c.blockSize) && c.blockSize > 0 && c.blocks.length === Math.ceil(c.size / c.blockSize));
      ok(c.key === undefined || typeof c.key === 'string');
      ok(c.lock === undefined || (typeof c.lock === 'string' && c.key === undefined));
      for (const b of c.blocks) ok(b && count(b.offset) && count(b.length) && (b.digest === undefined || typeof b.digest === 'string'));
    }
    for (const f of d.files) {
      ok(f && typeof f.path === 'string' && typeof f.type === 'string' && count(f.content));
      ok(f.groups === undefined || (Array.isArray(f.groups) && f.groups.every((g) => typeof g === 'string')));
    }
    ok(d.locks === undefined || Array.isArray(d.locks));
    for (const l of d.locks ?? []) {
      ok(l && typeof l.id === 'string' && LOCK_KINDS.includes(l.kind) && typeof l.salt === 'string');
      ok(l.keys && typeof l.keys === 'object' && Object.values(l.keys).every((k) => typeof k === 'string'));
    }
    return d;
  }

  // ---- columnar chunks (spec 5.4) --------------------------------------------------------------

  function formatDecimal(m, s) {
    const negative = m < 0n;
    const digits = (negative ? -m : m).toString().padStart(s + 1, '0');
    const t = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
    return negative ? `-${t}` : t;
  }

  /** A decimal: varint scale, then the integer m as a zigzag varint of any size (spec 5.1). */
  function readDecimal(r) {
    const s = r.varUint();
    if (s > 255) throw new JazminFormatError('Decimal scale is invalid');
    const z = r.bigVarUint(132);
    return formatDecimal(z & 1n ? -((z + 1n) >> 1n) : z >> 1n, s);
  }

  function readPlain(r, type) {
    switch (type) {
      case 'bool': return r.byte() !== 0;
      case 'int': return r.varInt();
      case 'datetime': return dateFromMs(r.varInt());
      case 'float': return r.float64();
      case 'binary': return r.bytes(r.varUint()).slice();
      case 'json': return parseJson(r.string(), 'A json value');
      case 'decimal': return readDecimal(r);
      default: return r.string();
    }
  }

  /** Passes over one plain value of a type, making nothing. */
  function skipPlain(r, type) {
    if (type !== 'decimal') {
      r.bytes(r.varUint()); // string, json and binary: a length, then bytes
      return undefined;
    }
    if (r.varUint() > 255) throw new JazminFormatError('Decimal scale is invalid');
    for (let n = 1; (r.byte() & 0x80) !== 0; n++) if (n >= 19) throw new JazminFormatError('Decimal is too long'); // up to 132 bits
    return undefined;
  }

  const MADE_PER_ROW = new Set(['string', 'decimal', 'json', 'binary']); // values worth skipping for rows not returned

  /**
   * Decodes a columnar chunk payload into one array of values per column (null for null). `wanted[j] === false`
   * skips column j (left undefined) without decoding it. With `datesAsMs`, datetimes are milliseconds since 1970
   * instead of Date objects (for column arrays: no object per value). With `rows` (by row: truthy for the rows a query
   * returns), plain text, decimal, json and binary values are made only for those rows; the others are left undefined.
   */
  function decodeColumnar(raw, types, rowCount, ordinal, wanted, datesAsMs = false, rows = null) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (rowCount > 0 && rowCount > raw.length * 8)) {
      throw new JazminFormatError(`Chunk ${ordinal}: row count does not match its size`);
    }
    const reader = new Reader(raw);
    const columns = new Array(types.length);
    for (let j = 0; j < types.length; j++) {
      const length = reader.varUint();
      const end = reader.pos + length;
      if (length < 1 || end > raw.length) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
      if (!wanted || wanted[j]) columns[j] = decodeStream(raw, reader.pos, end, types[j], rowCount, ordinal, datesAsMs, rows);
      reader.pos = end;
    }
    if (!reader.eof) throw new JazminFormatError(`Chunk ${ordinal} has trailing bytes`);
    return columns;
  }

  /**
   * decodeColumnar for a few rows of a chunk (as the library's decodeColumnarAt): the rows at `positions` (ascending,
   * distinct), one array per wanted column with one value per position.
   */
  function decodeColumnarAt(raw, types, rowCount, ordinal, wanted, positions, datesAsMs = false) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (rowCount > 0 && rowCount > raw.length * 8)) {
      throw new JazminFormatError(`Chunk ${ordinal}: row count does not match its size`);
    }
    const reader = new Reader(raw);
    const columns = new Array(types.length);
    for (let j = 0; j < types.length; j++) {
      const length = reader.varUint();
      const end = reader.pos + length;
      if (length < 1 || end > raw.length) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
      if (!wanted || wanted[j]) columns[j] = decodeAt(raw, reader.pos, end, types[j], rowCount, positions, ordinal, datesAsMs);
      reader.pos = end;
    }
    if (!reader.eof) throw new JazminFormatError(`Chunk ${ordinal} has trailing bytes`);
    return columns;
  }

  /** Passes over one plain value of a type, making nothing. */
  function skipValue(r, type) {
    switch (type) {
      case 'bool': r.byte(); break;
      case 'int': case 'datetime': r.varInt(); break;
      case 'float': r.float64(); break;
      default: skipPlain(r, type); // string, json, binary and decimal
    }
  }

  /**
   * The entries at `positions` (ascending, distinct, each under `entries`) of one stream at raw[start, end), one value
   * each, null for null (as the library's decodeAt): the values between them are passed over without being made, and
   * those after the last are not read. The rest of the stream is not checked (decodeStream checks whole streams).
   * Lists and objects are decoded whole.
   */
  function decodeAt(raw, start, end, type, entries, positions, ordinal, datesAsMs) {
    if (typeof type === 'object') {
      const all = decodeStream(raw, start, end, type, entries, ordinal, datesAsMs);
      return positions.map((e) => all[e]);
    }
    const r = new Reader(raw.subarray(0, end), start);
    const flags = r.byte();
    if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
    if ((flags & 0x0f) === ENCODING.nested) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${flags & 0x0f} is not valid for a ${type} column`);
    const nulls = flags & HAS_NULLS ? r.bytes((entries + 7) >> 3) : null;
    const isNull = (e) => nulls !== null && (nulls[e >> 3] & (1 << (e & 7))) !== 0;
    const out = new Array(positions.length).fill(null);
    const last = positions.length ? positions[positions.length - 1] : -1;
    const date = datesAsMs ? msFromFile : dateFromMs;
    let p = 0; // the next position
    switch (flags & 0x0f) {
      case ENCODING.plain:
        for (let e = 0; e <= last; e++) {
          if (isNull(e)) {
            if (e === positions[p]) p++;
          } else if (e !== positions[p]) skipValue(r, type);
          else out[p++] = type === 'datetime' ? date(r.varInt()) : readPlain(r, type);
        }
        break;
      case ENCODING.delta: {
        let prev = 0;
        for (let e = 0, i = 0; e <= last; e++) {
          if (isNull(e)) {
            if (e === positions[p]) p++;
            continue;
          }
          const d = r.varInt();
          let v;
          if (i++ === 0) v = d;
          else if (typeof prev === 'number' && typeof d === 'number' && Number.isSafeInteger(prev + d)) v = prev + d;
          else {
            const big = BigInt(prev) + BigInt(d);
            v = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
          }
          prev = v;
          if (e === positions[p]) out[p++] = type === 'datetime' ? date(v) : v;
        }
        break;
      }
      case ENCODING.dictionary: {
        // Where each entry starts; only the entries these values use are made, once each.
        const k = r.varUint();
        if (k < 1 || k > end - r.pos) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
        const offsets = new Array(k);
        for (let i = 0; i < k; i++) {
          offsets[i] = r.pos;
          skipPlain(r, type === 'decimal' ? 'decimal' : 'string');
        }
        const made = new Array(k); // entry -> its value, made when first used
        for (let e = 0; e <= last; e++) {
          if (isNull(e)) {
            if (e === positions[p]) p++;
            continue;
          }
          const id = r.varUint();
          if (id >= k) throw new JazminFormatError(`Chunk ${ordinal}: dictionary index out of range`);
          if (e !== positions[p]) continue;
          let value = made[id];
          if (value === undefined) {
            const entry = new Reader(r.buf, offsets[id]);
            made[id] = value = type === 'decimal' ? readDecimal(entry) : entry.string();
          }
          out[p++] = value;
        }
        break;
      }
      case ENCODING.bitmap: {
        let count = entries;
        if (nulls) for (let e = 0; e < entries; e++) if (isNull(e)) count--;
        const bits = r.bytes((count + 7) >> 3);
        for (let e = 0, i = 0; e <= last; e++) {
          if (isNull(e)) {
            if (e === positions[p]) p++;
            continue;
          }
          if (e === positions[p]) out[p++] = (bits[i >> 3] & (1 << (i & 7))) !== 0;
          i++;
        }
        break;
      }
      case ENCODING.scaled:
        for (let e = 0; e <= last; e++) {
          if (isNull(e)) {
            if (e === positions[p]) p++;
            continue;
          }
          const s = r.byte();
          let v;
          if (s === 255) v = r.float64();
          else if (s <= 22) v = Number(r.varInt()) / POW10[s];
          else throw new JazminFormatError(`Chunk ${ordinal}: invalid scale ${s}`);
          if (e === positions[p]) out[p++] = v;
        }
        break;
      default:
        throw new JazminFormatError(`Chunk ${ordinal}: unknown encoding ${flags & 0x0f}`);
    }
    return out;
  }

  /** What decodeColumnar needs for a column: its type, or a list's or object's definition. */
  const streamType = (c) => (isNested(c.type) ? c : c.type);

  /** One stream at raw[start, end) (after its length) over `rowCount` entries: one value per entry, null for null. */
  function decodeStream(raw, start, end, type, rowCount, ordinal, datesAsMs, rows = null) {
    const r = new Reader(raw.subarray(0, end), start);
    const flags = r.byte();
    if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
    const nulls = flags & HAS_NULLS ? r.bytes((rowCount + 7) >> 3) : null;
    if (typeof type === 'object' || (flags & 0x0f) === ENCODING.nested) {
      if (typeof type !== 'object' || (flags & 0x0f) !== ENCODING.nested) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${flags & 0x0f} is not valid for a ${type.type ?? type} column`);
      return decodeNested(r, end, type, rowCount, nulls, ordinal);
    }
    const isNull = (i) => nulls !== null && (nulls[i >> 3] & (1 << (i & 7))) !== 0;
    let count = rowCount;
    if (nulls) for (let i = 0; i < rowCount; i++) if (isNull(i)) count--;
    const values = new Array(count);
    switch (flags & 0x0f) {
      case ENCODING.plain:
        if (datesAsMs && type === 'datetime') for (let i = 0; i < count; i++) values[i] = msFromFile(r.varInt());
        else if (rows && MADE_PER_ROW.has(type)) {
          for (let e = 0, i = 0; i < count; e++) {
            if (isNull(e)) continue;
            values[i++] = rows[e] ? readPlain(r, type) : skipPlain(r, type);
          }
        } else for (let i = 0; i < count; i++) values[i] = readPlain(r, type);
        break;
      case ENCODING.delta: {
        // Numbers while the running sum stays exact; BigInt beyond ±2^53 (as the library's decoder).
        let prev = 0;
        for (let i = 0; i < count; i++) {
          const d = r.varInt();
          let v;
          if (typeof prev === 'number' && typeof d === 'number' && Number.isSafeInteger(prev + d)) v = prev + d;
          else {
            const big = BigInt(prev) + BigInt(d);
            v = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
          }
          prev = v;
          values[i] = type !== 'datetime' ? v : datesAsMs ? msFromFile(v) : dateFromMs(v);
        }
        break;
      }
      case ENCODING.dictionary: {
        const k = r.varUint();
        if (k < 1 || k > end - r.pos) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
        const entries = Array.from({ length: k }, () => (type === 'decimal' ? readDecimal(r) : r.string()));
        for (let i = 0; i < count; i++) {
          const id = r.varUint();
          if (id >= entries.length) throw new JazminFormatError(`Chunk ${ordinal}: dictionary index out of range`);
          values[i] = entries[id];
        }
        break;
      }
      case ENCODING.bitmap: {
        const bits = r.bytes((count + 7) >> 3);
        for (let i = 0; i < count; i++) values[i] = (bits[i >> 3] & (1 << (i & 7))) !== 0;
        break;
      }
      case ENCODING.scaled:
        for (let i = 0; i < count; i++) {
          const s = r.byte();
          if (s === 255) values[i] = r.float64();
          else if (s <= 22) values[i] = Number(r.varInt()) / POW10[s];
          else throw new JazminFormatError(`Chunk ${ordinal}: invalid scale ${s}`);
        }
        break;
      default:
        throw new JazminFormatError(`Chunk ${ordinal}: unknown encoding ${flags & 0x0f}`);
    }
    if (r.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
    if (!nulls) return values;
    const full = new Array(rowCount);
    for (let i = 0, k = 0; i < rowCount; i++) full[i] = isNull(i) ? null : values[k++];
    return full;
  }

  /** Where the part stream that starts at `r.pos` (its length first) ends; `r` is moved to its start. */
  function partEnd(r, end, ordinal) {
    const length = r.varUint();
    if (typeof length !== 'number' || length < 1 || r.pos + length > end) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
    return r.pos + length;
  }

  /**
   * A list or object column's values (spec 5.4), from its body at `r.pos`: after its own nulls, a list holds a lengths
   * stream (ints without nulls, one per list that is not null) and an items stream; an object one stream per field.
   */
  function decodeNested(r, end, column, entries, nulls, ordinal) {
    const raw = r.buf;
    const isNull = (e) => nulls !== null && (nulls[e >> 3] & (1 << (e & 7))) !== 0;
    let present = entries;
    if (nulls) for (let e = 0; e < entries; e++) if (isNull(e)) present--;
    const part = (child, count) => {
      if (r.pos === end) { // a field added after this chunk was written (spec 5.4): null for each entry
        if (!child.nullable) throw new JazminFormatError(`Chunk ${ordinal}: field '${child.name}' may not be null but has no stream`);
        return child.unread ? null : new Array(count).fill(null);
      }
      const at = partEnd(r, end, ordinal);
      if (count > (at - r.pos) * 8 + 8) throw new JazminFormatError(`Chunk ${ordinal}: entry count does not match its size`);
      // A field a filter does not read (unread) is passed over: its stream has its length.
      const values = child.unread ? null : decodeStream(raw, r.pos, at, streamType(child), count, ordinal, false);
      r.pos = at;
      return values;
    };
    const out = new Array(entries);
    if (column.type === 'list') {
      const at = partEnd(r, end, ordinal);
      const lr = new Reader(raw.subarray(0, at), r.pos);
      const flags = lr.byte();
      if ((flags & 0xf0) !== 0 || ((flags & 0x0f) !== ENCODING.plain && (flags & 0x0f) !== ENCODING.delta) || present > at - lr.pos) {
        throw new JazminFormatError(`Chunk ${ordinal}: list lengths are not valid`);
      }
      const lengths = new Array(present);
      let total = 0;
      for (let k = 0, previous = 0; k < present; k++) {
        let v = lr.varInt();
        if (typeof v !== 'number') throw new JazminFormatError(`Chunk ${ordinal}: list lengths are not valid`);
        if ((flags & 0x0f) === ENCODING.delta && k > 0) v += previous;
        if (!Number.isSafeInteger(v) || v < 0) throw new JazminFormatError(`Chunk ${ordinal}: list lengths are not valid`);
        lengths[k] = previous = v;
        total += v;
      }
      if (lr.pos !== at) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
      if (total > 2 ** 31 - 1) throw new JazminFormatError(`Chunk ${ordinal}: too many list items`);
      r.pos = at;
      const items = part(column.item, total);
      for (let e = 0, k = 0, i = 0; e < entries; e++) {
        if (isNull(e)) out[e] = null;
        else {
          out[e] = items.slice(i, i + lengths[k]);
          i += lengths[k++];
        }
      }
    } else {
      const parts = column.fields.map((f) => part(f, present));
      const read = column.fields.flatMap((f, i) => (f.unread ? [] : [i])); // unread fields are left out of the objects
      for (let e = 0, k = 0; e < entries; e++) {
        if (isNull(e)) {
          out[e] = null;
          continue;
        }
        const object = {};
        for (const i of read) setField(object, column.fields[i].name, parts[i][k]);
        out[e] = object;
        k++;
      }
    }
    if (r.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
    return out;
  }

  // ---- filters (spec 9) ----------------------------------------------------------------------------

  const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'icontains', 'startsWith', 'isNull', 'any', 'all', 'match']);
  const STRING_OPS = new Set(['contains', 'icontains', 'startsWith']);

  /** A comparable form of a value of a column type: numbers and BigInts, ms for dates, [m, s] for decimals, text, booleans. */
  function keyOf(type, value) {
    switch (type) {
      case 'int': {
        const n = typeof value === 'bigint' ? value : typeof value === 'string' ? BigInt(value) : BigInt(Math.trunc(Number(value)));
        return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
      }
      case 'float': return Number(value);
      case 'datetime': return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
      case 'decimal': {
        const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
        if (!m) throw new JazminError(`'${value}' is not a decimal`);
        return { sign: m[1] ? -1n : 1n, digits: BigInt(m[2] + (m[3] ?? '')), scale: (m[3] ?? '').length };
      }
      case 'bool': return Boolean(value);
      default: return String(value);
    }
  }

  /** A key's identity for hash sets: equal keys share it (decimals by value: 7.5 and 7.50 alike). */
  function keyHash(type, key) {
    if (type !== 'decimal') return key;
    let { digits, scale } = key;
    while (scale > 0 && digits % 10n === 0n) {
      digits /= 10n;
      scale--;
    }
    return digits === 0n ? '0' : `${key.sign < 0n ? '-' : ''}${digits}e${scale}`;
  }

  /**
   * An `in` list's keys as a hash set (to check rows) and in order (to check chunk statistics), as in the library's
   * filter.js. Null and NaN are left out: they equal nothing.
   */
  function inKeys(type, operand) {
    const usable = new Map();
    for (const v of operand) {
      if (v === null || v === undefined) continue;
      const key = keyOf(type, v);
      if (typeof key === 'number' && Number.isNaN(key)) continue;
      usable.set(keyHash(type, key), key);
    }
    return { set: new Set(usable.keys()), sorted: [...usable.values()].sort((a, b) => compare(type, a, b)) };
  }

  function compare(type, a, b) {
    if (type === 'decimal') {
      const scale = Math.max(a.scale, b.scale);
      const x = a.sign * a.digits * 10n ** BigInt(scale - a.scale);
      const y = b.sign * b.digits * 10n ** BigInt(scale - b.scale);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const x = BigInt(a);
      const y = BigInt(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Compiles a filter (spec 9) for these columns into a predicate over row objects. */
  function compileFilter(filter, columns) {
    if (filter === null || filter === undefined) return () => true;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw new JazminError('A filter must be an object');
    const byName = new Map(columns.map((c) => [c.name, c]));
    const parts = [];
    for (const [key, spec] of Object.entries(filter)) {
      if (key === 'and' || key === 'or') {
        if (!Array.isArray(spec)) throw new JazminError(`'${key}' takes an array of filters`);
        const items = spec.map((f) => compileFilter(f, columns));
        parts.push(key === 'and' ? (row) => items.every((p) => p(row)) : (row) => items.some((p) => p(row)));
      } else if (key === 'not') {
        const inner = compileFilter(spec, columns);
        parts.push((row) => !inner(row));
      } else {
        const column = byName.get(key);
        if (!column) throw new JazminError(`unknown column '${key}'`);
        const conditions = spec === null ? { isNull: true }
          : typeof spec === 'object' && !(spec instanceof Date) && !Array.isArray(spec) ? spec : { eq: spec };
        for (const [op, operand] of Object.entries(conditions)) {
          if (!OPS.has(op)) throw new JazminError(`unknown operator '${op}'`);
          if (STRING_OPS.has(op) && column.type !== 'string') throw new JazminError(`'${op}' applies to string columns only`);
          parts.push(condition(column, op, operand));
        }
      }
    }
    return (row) => parts.every((p) => p(row));
  }

  function condition(column, op, operand) {
    const { name, type } = column;
    if (op === 'any' || op === 'all' || op === 'match') {
      // Nested columns (spec 9.2): match on an object's fields; any / all on a list's items (the same item meets every
      // condition of one filter). A null list or object matches nothing; an empty list fails any, passes all.
      const isMatch = op === 'match';
      if (type !== (isMatch ? 'object' : 'list')) throw new JazminError(`'${op}' only applies to ${isMatch ? 'object' : 'list'} columns, and '${name}' is a ${type}`);
      const part = isMatch ? column : column.item;
      const objects = part.type === 'object';
      const test = objects ? compileFilter(operand, part.fields) : compileFilter({ '': operand }, [{ ...part, name: '' }]);
      if (isMatch) return (row) => row[name] != null && test(row[name]);
      const probe = { '': null }; // the item itself, filled again for each item (no object per item)
      const check = objects ? (item) => item != null && test(item) : (item) => {
        probe[''] = item ?? null;
        return test(probe);
      };
      return (row) => Array.isArray(row[name]) && (op === 'any' ? row[name].some(check) : row[name].every(check));
    }
    if ((op === 'eq' || op === 'ne') && (operand === null || operand === undefined)) return condition(column, 'isNull', op === 'eq');
    if (op === 'isNull') return (row) => (row[name] === null || row[name] === undefined) === Boolean(operand);
    if (op === 'contains') return (row) => row[name] != null && row[name].includes(operand);
    if (op === 'icontains') {
      const lower = String(operand).toLowerCase();
      return (row) => row[name] != null && row[name].toLowerCase().includes(lower);
    }
    if (op === 'startsWith') return (row) => row[name] != null && row[name].startsWith(operand);
    if (op === 'in') {
      if (!Array.isArray(operand)) throw new JazminError(`'in' takes an array`);
      const { set } = inKeys(type, operand);
      return (row) => row[name] != null && set.has(keyHash(type, keyOf(type, row[name])));
    }
    const key = keyOf(type, operand);
    const test = { eq: (c) => c === 0, ne: (c) => c !== 0, gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0 }[op];
    return (row) => row[name] != null && test(keyCompare(type, keyOf(type, row[name]), key)); // NaN matches no comparison but ne
  }

  // ---- query planning: statistics, sort order and indexes (as the library does, spec 6.4, 8, 9) --------

  const ORDERED_TYPES = new Set(['int', 'float', 'decimal', 'string', 'datetime', 'bool']);
  const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
  // A few rows of a chunk (index candidates, or matching rows) are decoded on their own when they are at most this share
  // of its rows. The library's reader uses 1/8; here decoding row by row costs relatively more, and at 1/8 queries were
  // a little slower than decoding whole columns.
  const FEW_ROWS = 1 / 32;
  const SMALL_LOOKUP_BYTES = 8 * 1024; // index lookups this small are always made: the bytes are negligible
  const PAGES_CACHED = 8; // decoded pages kept per sorted index

  /** Compares two keys of a column type; NaN when a float key is NaN (NaN matches nothing). */
  function keyCompare(type, a, b) {
    if (type === 'float' && (Number.isNaN(a) || Number.isNaN(b))) return NaN;
    return compare(type, a, b);
  }

  /** A value in the value encoding (spec 5.1), as a key. */
  function readKey(r, type) {
    switch (type) {
      case 'bool': return r.byte() !== 0;
      case 'int': return r.varInt();
      case 'float': return r.float64();
      case 'decimal': return keyOf('decimal', readDecimal(r));
      case 'datetime': return r.varInt();
      default: return r.string();
    }
  }

  /** A statistics or index-directory bound (spec 6.5): strings are bare UTF-8; empty means unbounded. */
  function decodeBound(type, bytes) {
    if (bytes.length === 0) return undefined;
    if (type === 'string') return fromUtf8.decode(bytes);
    return readKey(new Reader(bytes), type);
  }

  /**
   * A filter as a tree for planning, parsed by the same rules as compileFilter (which checks it first):
   * { kind: 'and' | 'or', items } | { kind: 'not', item } | { kind: 'leaf', column, op, value } (values as keys)
   * | { kind: 'nested', column, op: 'any' | 'all' | 'match', inner, part } (inner: a plan of `part`, the object's fields
   * or the list's item, by position; the item itself at position 0).
   */
  function planOf(filter, columns) {
    if (filter === null || filter === undefined) return null;
    const byName = new Map(columns.map((c) => [c.name, c]));
    const node = (f) => {
      const items = [];
      for (const [key, spec] of Object.entries(f)) {
        if (key === 'and' || key === 'or') items.push({ kind: key, items: spec.map(node) });
        else if (key === 'not') items.push({ kind: 'not', item: node(spec) });
        else {
          const column = byName.get(key);
          const conditions = spec === null ? { isNull: true }
            : typeof spec === 'object' && !(spec instanceof Date) && !Array.isArray(spec) ? spec : { eq: spec };
          for (const [op, operand] of Object.entries(conditions)) items.push(planLeaf(column, op, operand));
        }
      }
      return items.length === 1 ? items[0] : { kind: 'and', items };
    };
    return node(filter);
  }

  function planLeaf(column, op, operand) {
    if (op === 'any' || op === 'all' || op === 'match') {
      const part = op === 'match' ? column : column.item;
      const inner = part.type === 'object'
        ? planOf(operand, part.fields.map((f, i) => ({ ...f, position: i })))
        : planOf({ '': operand }, [{ ...part, name: '', position: 0 }]);
      return { kind: 'nested', column, op, inner, part };
    }
    const leaf = { kind: 'leaf', column, op };
    if ((op === 'eq' || op === 'ne') && (operand === null || operand === undefined)) return { ...leaf, op: 'isNull', value: op === 'eq' };
    if (op === 'isNull') return { ...leaf, value: Boolean(operand) };
    if (STRING_OPS.has(op)) return { ...leaf, value: String(operand) };
    if (!ORDERED_TYPES.has(column.type)) return { ...leaf, op: 'opaque' }; // binary / json: not planned
    if (op === 'in') return { ...leaf, value: operand.filter((v) => v !== null && v !== undefined).map((v) => keyOf(column.type, v)), ...inKeys(column.type, operand) };
    return { ...leaf, value: keyOf(column.type, operand) };
  }

  /** As answeredExactly in the library's filter.js: whether the rows sorted indexes return are exactly the matches. */
  function answeredExactly(plan) {
    const leaves = plan.kind === 'leaf' ? [plan] : plan.kind === 'and' && plan.items.every((i) => i.kind === 'leaf') ? plan.items : [];
    const nan = (l) => (Array.isArray(l.value) ? l.value : [l.value]).some((v) => typeof v === 'number' && Number.isNaN(v));
    if (!leaves.length || leaves.some((l) => !['eq', 'in', 'isNull', ...RANGE_OPS].includes(l.op) || !ORDERED_TYPES.has(l.column.type) || nan(l))) return false;
    return leaves.length === 1 || leaves.every((l) => RANGE_OPS.has(l.op) && l.column.position === leaves[0].column.position);
  }

  /** As setField in the library's schema.js: a column named `__proto__` becomes a field, not the prototype (#68). */
  function setField(target, name, value) {
    if (name === '__proto__') Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
    else target[name] = value;
  }

  /**
   * As columnCollector in the library's reader.js: one column's values for columnArrays(). add(column, from, to) takes
   * a decoded column's rows from..to-1 in one loop.
   */
  function columnCollector({ name, type }) {
    const PIECE = 8192; // values per piece: pieces are joined once, at the end
    const Typed = type === 'int' || type === 'float' || type === 'datetime' ? Float64Array : type === 'bool' ? Uint8Array : null;
    if (!Typed) {
      const values = [];
      return {
        add(column, from, to) {
          for (let r = from; r < to; r++) values.push(column[r]);
        },
        finish: () => ({ values }),
      };
    }
    const pieces = [];
    let piece = new Typed(PIECE);
    let used = 0;
    let count = 0;
    const nullRows = [];
    return {
      add(column, from, to) {
        for (let r = from; r < to; r++) {
          if (used === PIECE) {
            pieces.push(piece);
            piece = new Typed(PIECE);
            used = 0;
          }
          const v = column[r];
          if (v === null || v === undefined) {
            nullRows.push(count);
            piece[used] = Typed === Float64Array ? NaN : 0;
          } else if (type === 'datetime') piece[used] = typeof v === 'number' ? v : v.getTime();
          else if (type === 'bool') piece[used] = v ? 1 : 0;
          else if (typeof v === 'bigint') throw new JazminError(`Column '${name}' holds ${v}, beyond ±2^53: a Float64Array cannot hold it exactly (use find())`);
          else piece[used] = v;
          used++;
          count++;
        }
      },
      finish() {
        const values = new Typed(count);
        let at = 0;
        for (const p of pieces) {
          values.set(p, at);
          at += p.length;
        }
        values.set(piece.subarray(0, used), at);
        if (!nullRows.length) return { values };
        const nulls = new Uint8Array((count + 7) >> 3);
        for (const r of nullRows) nulls[r >> 3] |= 1 << (r & 7);
        return { values, nulls };
      },
    };
  }

  function planColumns(plan, into = new Set()) {
    if (!plan) return into;
    if (plan.kind === 'leaf' || plan.kind === 'nested') into.add(plan.column.position);
    else (plan.items ?? [plan.item]).forEach((n) => planColumns(n, into));
    return into;
  }

  /**
   * Nested column `column` with only the fields a plan's conditions on it read: the others are copies marked `unread`,
   * whose streams decoding passes over (as filterReads in the library's filter.js). The same definition when the
   * conditions read every field.
   */
  function filterReads(column, plan) {
    const innerOf = (nodes, position) => {
      const found = [];
      const walk = (n) => {
        if (n.kind === 'nested') {
          if (n.column.position === position) found.push(n.inner);
        } else if (n.kind === 'not') walk(n.item);
        else n.items?.forEach(walk);
      };
      nodes.forEach(walk);
      return found;
    };
    const reads = (nodes, position) => {
      const walk = (n) => (n.kind === 'leaf' || n.kind === 'nested' ? n.column.position === position : n.kind === 'not' ? walk(n.item) : (n.items?.some(walk) ?? false));
      return nodes.some(walk);
    };
    const fieldsRead = (part, nodes) => {
      if (part.type === 'list') {
        const item = part.item;
        const read = item.type === 'object' ? fieldsRead(item, nodes) : isNested(item.type) ? fieldsRead(item, innerOf(nodes, 0)) : item;
        return read === item ? part : { ...part, item: read };
      }
      let same = true;
      const fields = part.fields.map((f, i) => {
        const read = !reads(nodes, i) ? { ...f, unread: true } : isNested(f.type) ? fieldsRead(f, innerOf(nodes, i)) : f;
        if (read !== f) same = false;
        return read;
      });
      return same ? part : { ...part, fields };
    };
    return fieldsRead(column, innerOf([plan], column.position));
  }

  /** The type of the leaf at `path` (field positions; a list's item adds none) in a nested column, or null when none. */
  function leafType(column, path) {
    let node = column;
    for (const step of path) {
      while (node.type === 'list') node = node.item;
      if (node.type !== 'object' || !(Number.isInteger(step) && step >= 0 && step < node.fields.length)) return null;
      node = node.fields[step];
    }
    while (node.type === 'list') node = node.item;
    return isNested(node.type) ? null : node.type;
  }

  /**
   * Whether a nested condition may match in a chunk, from the statistics of the leaves its filter reads (spec 6.4):
   * `any` and `match` need an item or object that may match each condition; `all` may always match (an empty list does).
   */
  function nestedMayMatch(node, leafOf, path) {
    if (node.op === 'all') return true;
    const step = (position) => (node.part.type !== 'object' ? path : path === '' ? String(position) : `${path},${position}`);
    const partMayMatch = (n) => {
      switch (n.kind) {
        case 'and': return n.items.every(partMayMatch);
        case 'or': return n.items.some(partMayMatch);
        case 'not': return true;
        case 'nested': return nestedMayMatch(n, leafOf, step(n.column.position));
        default: {
          const stat = leafOf(step(n.column.position));
          return !stat || leafMayMatch(n, stat, stat.count);
        }
      }
    };
    return partMayMatch(node.inner);
  }

  function leafMayMatch(leaf, stat, rowCount) {
    if (!stat) return true;
    if (leaf.op === 'isNull') return leaf.value ? stat.nulls > 0 : stat.nulls < rowCount;
    if (stat.nulls === rowCount) return false;
    const { min, max } = stat;
    const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
    const belowMax = (v, inclusive) => max === undefined || (inclusive ? cmp(v, max) <= 0 : cmp(v, max) < 0);
    const aboveMin = (v, inclusive) => min === undefined || (inclusive ? cmp(v, min) >= 0 : cmp(v, min) > 0);
    switch (leaf.op) {
      case 'eq': return aboveMin(leaf.value, true) && belowMax(leaf.value, true);
      case 'in': { // the first listed key at or above the minimum, if it is not above the maximum
        let lo = 0;
        let hi = leaf.sorted.length;
        if (min !== undefined) {
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cmp(leaf.sorted[mid], min) < 0) lo = mid + 1;
            else hi = mid;
          }
        }
        return lo < leaf.sorted.length && belowMax(leaf.sorted[lo], true);
      }
      case 'gt': return max === undefined || cmp(max, leaf.value) > 0;
      case 'gte': return max === undefined || cmp(max, leaf.value) >= 0;
      case 'lt': return min === undefined || cmp(min, leaf.value) < 0;
      case 'lte': return min === undefined || cmp(min, leaf.value) <= 0;
      default: return true;
    }
  }

  /**
   * False when chunk statistics prove no row can match; `stats(col)` gives a column's statistics or undefined, and
   * `leaves(col, path)` a nested column's leaf's (path: field positions, as "1,0").
   */
  function mayMatch(node, stats, rowCount, leaves) {
    switch (node.kind) {
      case 'and': return node.items.every((n) => mayMatch(n, stats, rowCount, leaves));
      case 'or': return node.items.some((n) => mayMatch(n, stats, rowCount, leaves));
      case 'not': return true;
      case 'nested': {
        const stat = stats(node.column.position);
        if (stat && stat.nulls === rowCount) return false; // every list or object of the chunk is null: none matches
        return !leaves || nestedMayMatch(node, (path) => leaves(node.column.position, path), '');
      }
      default: return leafMayMatch(node, stats(node.column.position), rowCount);
    }
  }

  function leafMustMatch(leaf, stat, rowCount) {
    // Float statistics leave NaN values out, so they cannot prove that every row matches.
    if (!stat || leaf.column.type === 'float') return false;
    if (leaf.op === 'isNull') return leaf.value ? stat.nulls === rowCount : stat.nulls === 0;
    const { min, max } = stat;
    if (stat.nulls !== 0 || min === undefined || max === undefined) return false;
    const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
    switch (leaf.op) {
      case 'eq': return cmp(min, leaf.value) === 0 && cmp(max, leaf.value) === 0;
      case 'ne': return cmp(max, leaf.value) < 0 || cmp(min, leaf.value) > 0;
      case 'in': return cmp(min, max) === 0 && leaf.set.has(keyHash(leaf.column.type, min));
      case 'gt': return cmp(min, leaf.value) > 0;
      case 'gte': return cmp(min, leaf.value) >= 0;
      case 'lt': return cmp(max, leaf.value) < 0;
      case 'lte': return cmp(max, leaf.value) <= 0;
      default: return false;
    }
  }

  /** True when chunk statistics prove that every row matches (an offset can then skip the chunk by its row count). */
  function mustMatch(node, stats, rowCount) {
    switch (node.kind) {
      case 'and': return node.items.every((n) => mustMatch(n, stats, rowCount));
      case 'or': return node.items.some((n) => mustMatch(n, stats, rowCount));
      case 'not': return !mayMatch(node.item, stats, rowCount);
      case 'nested': return false; // statistics bound values, not whether every list has a matching item
      default: return leafMustMatch(node, stats(node.column.position), rowCount);
    }
  }

  /** Bounds the top-level AND of a filter puts on one column: { low, lowInclusive, high, highInclusive } or null. */
  function sortBounds(plan, position) {
    const leaves = plan.kind === 'and' ? plan.items : [plan];
    let bounds = null;
    for (const leaf of leaves) {
      if (leaf.kind !== 'leaf' || leaf.column.position !== position || !['eq', ...RANGE_OPS].includes(leaf.op)) continue;
      if (typeof leaf.value === 'number' && Number.isNaN(leaf.value)) continue;
      const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
      bounds ??= {};
      if (leaf.op !== 'lt' && leaf.op !== 'lte' && (bounds.low === undefined || cmp(leaf.value, bounds.low) > 0)) {
        Object.assign(bounds, { low: leaf.value, lowInclusive: leaf.op !== 'gt' });
      }
      if (leaf.op !== 'gt' && leaf.op !== 'gte' && (bounds.high === undefined || cmp(leaf.value, bounds.high) < 0)) {
        Object.assign(bounds, { high: leaf.value, highInclusive: leaf.op !== 'lt' });
      }
    }
    return bounds;
  }

  /*
   * Index lookups (as the library's indexes.js): { op: 'eq', value } | { op: 'in', values }
   * | { op: 'range', low, lowInclusive, high, highInclusive } | { op: 'prefix', text } | { op: 'nulls' }
   * | { op: 'contains', text, ci }. cost(lookup): bytes of index data still to read (nothing is read to answer),
   * null when the index cannot answer it; rows(lookup): the sorted row ids.
   */
  const unionAll = (lists) => [...new Set(lists.flat())].sort((a, b) => a - b);
  function intersectSorted(a, b) {
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) {
        out.push(a[i]);
        i++;
        j++;
      } else if (a[i] < b[j]) i++;
      else j++;
    }
    return out;
  }

  /**
   * The keys of a sorted index page with encoding 1 (reader feature 'index-deltas', spec 8.1), read in order: an int or
   * datetime key as the difference from the previous key, a string key as the number of UTF-8 bytes it shares with the
   * previous key and the bytes after them. Keys of other types are as in encoding 0.
   */
  class PageKeys {
    constructor(type) {
      this.type = type;
      this.previous = undefined;
      this.bytes = new Uint8Array(64); // the previous string key's UTF-8 bytes
      this.length = 0;
    }

    read(r) {
      if (this.type === 'int' || this.type === 'datetime') {
        let key;
        if (this.previous === undefined) key = r.varInt();
        else {
          const step = r.numberVarUint();
          if (!(step >= 1)) throw new JazminFormatError('Index page keys are not ascending');
          if (typeof this.previous === 'number' && typeof step === 'number' && Number.isSafeInteger(this.previous + step)) key = this.previous + step;
          else {
            const big = BigInt(this.previous) + BigInt(step);
            key = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
          }
        }
        if (this.type === 'datetime') msFromFile(key);
        else if (typeof key === 'bigint' && (key > 2n ** 63n - 1n || key < -(2n ** 63n))) throw new JazminFormatError('An index key is out of range');
        this.previous = key;
        return key;
      }
      if (this.type === 'string') {
        const shared = r.varUint();
        const rest = r.varUint();
        if (shared > this.length || rest > r.remaining) throw new JazminFormatError('Index page is truncated');
        const length = shared + rest;
        if (this.bytes.length < length) {
          const grown = new Uint8Array(Math.max(length, this.bytes.length * 2));
          grown.set(this.bytes.subarray(0, shared));
          this.bytes = grown;
        }
        this.bytes.set(r.bytes(rest), shared);
        this.length = length;
        return fromUtf8.decode(this.bytes.subarray(0, length));
      }
      return readKey(r, this.type);
    }
  }

  /** Postings of an entry in a page with encoding 1: the first row id is a zigzag difference from `previousFirst`. */
  function readRowIds(r, previousFirst) {
    const count = r.varUint();
    if (count < 1 || count > r.remaining) throw new JazminFormatError('Postings are truncated');
    const step = r.varInt();
    let previous = previousFirst + step;
    if (typeof step !== 'number' || !(previous >= 0) || previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
    const ids = new Array(count);
    ids[0] = previous;
    for (let i = 1; i < count; i++) {
      previous += r.varUint();
      if (previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      ids[i] = previous;
    }
    return ids;
  }

  /** A sorted index (spec 8.1): its directory is read up front; pages as lookups need them (a few kept). */
  class PagedIndex {
    /** `deltas`: the file has reader feature 'index-deltas', so pages may use encoding 1. */
    constructor(directory, type, load, deltas = false) {
      this.deltas = deltas;
      this.type = type;
      // Every page has a first key: for text, no bytes are the empty text (in statistics they mean "no bound").
      this.pages = directory.pages.map((p) => ({ ...p, first: type === 'string' ? fromUtf8.decode(p.first) : decodeBound(type, p.first) }));
      if (this.pages.some((p) => p.first === undefined)) throw new JazminFormatError('Index page has no first key');
      this.nullsAt = directory.nulls;
      this.load = load;
      this.cache = new Map();
    }

    async page(i) {
      let page = this.cache.get(i);
      if (page) {
        this.cache.delete(i);
      } else {
        const r = new Reader(await this.load(`page/${i}`, this.pages[i]));
        const encoding = r.byte();
        const keys = this.deltas && encoding === 1 ? new PageKeys(this.type) : null;
        if (encoding !== 0 && !keys) throw new JazminFormatError('Index page uses an encoding this reader does not support');
        const count = r.varUint();
        if (count > r.remaining || count !== this.pages[i].count) throw new JazminFormatError('Index page does not match its directory');
        page = { keys: new Array(count), postings: new Array(count) };
        let previousFirst = 0;
        for (let k = 0; k < count; k++) {
          if (keys) {
            page.keys[k] = keys.read(r);
            page.postings[k] = readRowIds(r, previousFirst);
            previousFirst = page.postings[k][0];
          } else {
            page.keys[k] = readKey(r, this.type);
            page.postings[k] = readPostings(r);
          }
        }
        if (!r.eof) throw new JazminFormatError('Index page has trailing bytes');
        if (this.cache.size >= PAGES_CACHED) this.cache.delete(this.cache.keys().next().value);
      }
      this.cache.set(i, page);
      return page;
    }

    /** Last page whose first key is <= value, or -1. */
    pageFor(value) {
      let lo = 0;
      let hi = this.pages.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keyCompare(this.type, this.pages[mid].first, value) <= 0) lo = mid + 1;
        else hi = mid;
      }
      return lo - 1;
    }

    span(lookup) {
      const last = this.pages.length - 1;
      const isNaNKey = (v) => typeof v === 'number' && Number.isNaN(v);
      switch (lookup.op) {
        case 'eq': {
          if (isNaNKey(lookup.value)) return [0, -1];
          const i = this.pageFor(lookup.value);
          return [Math.max(i, 0), i];
        }
        case 'range':
          if (isNaNKey(lookup.low) || isNaNKey(lookup.high)) return [0, -1];
          return [lookup.low === undefined ? 0 : Math.max(this.pageFor(lookup.low), 0), lookup.high === undefined ? last : this.pageFor(lookup.high)];
        case 'prefix': {
          const from = Math.max(this.pageFor(lookup.text), 0);
          let to = from;
          while (to < last && this.pages[to + 1].first.startsWith(lookup.text)) to++;
          return [from, Math.min(to, last)];
        }
        default: return [0, -1];
      }
    }

    cost(lookup) {
      if (lookup.op === 'contains') return null;
      if (lookup.op === 'nulls') return this.nullsAt ? this.nullsAt.length : 0;
      const pages = new Set();
      const add = ([from, to]) => {
        for (let i = from; i <= to; i++) if (!this.cache.has(i)) pages.add(i);
      };
      if (lookup.op === 'in') for (const value of lookup.values) add(this.span({ op: 'eq', value }));
      else add(this.span(lookup));
      let bytes = 0;
      for (const i of pages) bytes += this.pages[i].length;
      return bytes;
    }

    /** First position in a page whose key is >= value (> value when strict). */
    bound(page, value, strict) {
      let lo = 0;
      let hi = page.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const c = keyCompare(this.type, page.keys[mid], value);
        if (c < 0 || (strict && c === 0)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    async rows(lookup) {
      switch (lookup.op) {
        case 'eq': case 'in': {
          const lists = [];
          for (const value of lookup.op === 'eq' ? [lookup.value] : lookup.values) {
            const [from, to] = this.span({ op: 'eq', value });
            if (to < from) continue;
            const page = await this.page(from);
            const i = this.bound(page, value, false);
            if (i < page.keys.length && keyCompare(this.type, page.keys[i], value) === 0) lists.push(page.postings[i]);
          }
          return unionAll(lists);
        }
        case 'nulls': return this.nullsAt ? readPostingsSection(await this.load('nulls', this.nullsAt), 'Index null postings') : [];
        case 'range': case 'prefix': {
          const [from, to] = this.span(lookup);
          const lists = [];
          for (let j = from; j <= to; j++) {
            const page = await this.page(j);
            let start;
            let end;
            if (lookup.op === 'prefix') {
              start = this.bound(page, lookup.text, false);
              end = start;
              while (end < page.keys.length && page.keys[end].startsWith(lookup.text)) end++;
            } else {
              start = lookup.low === undefined ? 0 : this.bound(page, lookup.low, !lookup.lowInclusive);
              end = lookup.high === undefined ? page.keys.length : this.bound(page, lookup.high, lookup.highInclusive);
            }
            for (let k = start; k < end; k++) lists.push(page.postings[k]);
          }
          return unionAll(lists);
        }
        default: return [];
      }
    }
  }

  /** Whether a trigram index can narrow a search: not under 3 characters, nor case-insensitive non-ASCII. */
  function trigramsOf(text) {
    const lower = text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    const grams = new Set();
    for (let i = 0; i + 3 <= lower.length; i++) grams.add(lower.substring(i, i + 3));
    return grams;
  }
  const trigramAnswers = (text, ci) => !(ci && /[^\x00-\x7f]/.test(text)) && trigramsOf(text).size > 0;

  /** Steps over postings without making the row ids, eight bytes at a time (as the library's skipPostings). */
  function skipPostings(r) {
    const count = r.varUint();
    if (count > r.remaining) throw new JazminFormatError('Postings are truncated');
    const { buf, view } = r;
    let pos = r.pos;
    let left = count;
    // A window of 8 bytes ends at most 8 varints (bytes with the high bit clear): while 8 are left, step over it whole.
    for (const end = buf.length - 8; left >= 8 && pos <= end; pos += 8) {
      const low = (view.getUint32(pos, true) & 0x80808080) >>> 7;
      const high = (view.getUint32(pos + 4, true) & 0x80808080) >>> 7;
      left -= 8 - (Math.imul(low, 0x01010101) >>> 24) - (Math.imul(high, 0x01010101) >>> 24);
    }
    for (; left > 0; pos++) {
      if (pos >= buf.length) throw new JazminFormatError('Postings are truncated');
      if ((buf[pos] & 0x80) === 0) left--;
    }
    r.pos = pos;
  }

  /** Postings intersected with the sorted row ids `ids` (kept in place in `ids`) as they are read: no list is made. */
  function intersectPostings(r, ids) {
    const count = r.varUint();
    if (count > r.remaining) throw new JazminFormatError('Postings are truncated');
    let kept = 0;
    let j = 0;
    let previous = 0;
    for (let i = 0; i < count && j < ids.length; i++) {
      previous += r.varUint();
      if (previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      while (j < ids.length && ids[j] < previous) j++;
      if (ids[j] === previous) ids[kept++] = ids[j++];
    }
    ids.length = kept;
    return ids;
  }

  const GRAM_HIGH = 4294967296; // a gram (c0, c1, c2) is held as c0·2³² + c1·2¹⁶ + c2: numeric order is code-unit order

  /**
   * One segment of a trigram index (spec 8.2), as the library's TrigramIndex: where each gram's postings are, in two
   * typed arrays. Row ids are made only for the grams a lookup uses.
   */
  class TrigramSegment {
    constructor(bytes) {
      const r = new Reader(bytes);
      if (r.byte() !== 0) throw new JazminFormatError('Trigram index uses an encoding this reader does not support');
      const count = r.varUint();
      if (count > r.remaining / 7) throw new JazminFormatError('Trigram index is truncated');
      let grams = new Float64Array(count);
      let offsets = bytes.length > 0xffffffff ? new Float64Array(count) : new Uint32Array(count);
      let ascending = true;
      for (let i = 0; i < count; i++) {
        const c0 = r.u16();
        const c1 = r.u16();
        const gram = c0 * GRAM_HIGH + c1 * 65536 + r.u16();
        if (i > 0 && gram <= grams[i - 1]) ascending = false;
        grams[i] = gram;
        offsets[i] = r.pos;
        skipPostings(r);
      }
      if (!r.eof) throw new JazminFormatError('Trigram index has trailing bytes');
      if (!ascending) {
        // Spec 8.2 orders the grams; an index that does not is still read.
        const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => grams[x] - grams[y]);
        grams = Float64Array.from(order, (i) => grams[i]);
        offsets = offsets.constructor.from(order, (i) => offsets[i]);
      }
      this.bytes = bytes;
      this.grams = grams;
      this.offsets = offsets;
    }

    /** Where a gram's postings start, or -1 when no row has it. */
    find(gram) {
      let lo = 0;
      let hi = this.grams.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (this.grams[mid] < gram) lo = mid + 1;
        else if (this.grams[mid] > gram) hi = mid - 1;
        else return this.offsets[mid];
      }
      return -1;
    }

    /** The postings of each gram of `text`, rarest first, as { at, count }; or null when a gram is in no row. */
    lists(text) {
      const lists = [];
      for (const gram of trigramsOf(text)) {
        const at = this.find(gram.charCodeAt(0) * GRAM_HIGH + gram.charCodeAt(1) * 65536 + gram.charCodeAt(2));
        if (at < 0) return null;
        lists.push({ at, count: new Reader(this.bytes, at).varUint() });
      }
      return lists.sort((x, y) => x.count - y.count);
    }

    /** At most how many rows rows() returns: those of the text's rarest gram. */
    bound(lookup) {
      const lists = this.lists(lookup.text);
      return lists === null ? 0 : lists.length ? lists[0].count : Infinity;
    }

    /** How far apart the rows of the text's rarest gram are: from its first row id to its last, inclusive. */
    span(lookup) {
      const lists = this.lists(lookup.text);
      if (lists === null) return 0;
      if (!lists.length) return Infinity;
      const r = new Reader(this.bytes, lists[0].at);
      const count = r.varUint();
      let first = 0;
      let last = 0;
      for (let i = 0; i < count; i++) {
        last += r.varUint();
        if (last > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
        if (i === 0) first = last;
      }
      return count ? last - first + 1 : 0;
    }

    /** Superset of the rows that may contain the text, from its rarest gram; the others intersected as read. */
    rows(lookup) {
      const lists = this.lists(lookup.text);
      if (!lists?.length) return [];
      let result = readPostings(new Reader(this.bytes, lists[0].at));
      for (let i = 1; i < lists.length && result.length; i++) result = intersectPostings(new Reader(this.bytes, lists[i].at), result);
      return result;
    }
  }

  const COMMON_SHARE = 1 / 4; // see LazyTrigramIndex.rows

  /** A trigram index, read only when a lookup is made: until then a lookup costs its whole size. */
  class LazyTrigramIndex {
    constructor(bytes, load) {
      this.bytes = bytes;
      this.load = load;
      this.segments = null;
    }

    cost(lookup) {
      if (lookup.op !== 'contains' || !trigramAnswers(lookup.text, lookup.ci)) return null;
      return this.segments ? 0 : this.bytes;
    }

    /**
     * Row ids that may match; or null, given `scanRows` (the rows a scan would read), when the text is common (as the
     * library's LazyTrigramIndex.rows): its rarest gram is in over a quarter of them, spread over three quarters.
     */
    async rows(lookup, scanRows) {
      this.segments ??= (await this.load()).map((bytes) => new TrigramSegment(bytes));
      const sum = (measure) => this.segments.reduce((n, segment) => n + segment[measure](lookup), 0);
      if (scanRows !== undefined && sum('bound') > scanRows * COMMON_SHARE && sum('span') > scanRows * (1 - COMMON_SHARE)) return null;
      // Segments hold different rows: each one's candidates are found apart, then united.
      const lists = this.segments.map((segment) => segment.rows(lookup));
      return lists.length === 1 ? lists[0] : unionAll(lists);
    }
  }

  /** Several index segments of one column (the original rows, and each append's): costs add up, rows unite. */
  class CompositeIndex {
    constructor(parts) {
      this.parts = parts;
    }

    cost(lookup) {
      let bytes = 0;
      for (const part of this.parts) {
        const c = part.cost(lookup);
        if (c === null) return null;
        bytes += c;
      }
      return bytes;
    }

    async rows(lookup) {
      const lists = [];
      for (const part of this.parts) lists.push(await part.rows(lookup));
      return unionAll(lists);
    }
  }

  /** The index lookup a condition can use - [kind, lookup] - or null. */
  function leafLookup(leaf) {
    switch (leaf.op) {
      case 'contains': case 'icontains': return ['trigram', { op: 'contains', text: leaf.value, ci: leaf.op === 'icontains' }];
      case 'eq': return ['sorted', { op: 'eq', value: leaf.value }];
      case 'in': return ['sorted', { op: 'in', values: leaf.value }];
      case 'startsWith': return ['sorted', { op: 'prefix', text: leaf.value }];
      case 'isNull': return leaf.value ? ['sorted', { op: 'nulls' }] : null;
      case 'gt': case 'gte': return ['sorted', { op: 'range', low: leaf.value, lowInclusive: leaf.op === 'gte' }];
      case 'lt': case 'lte': return ['sorted', { op: 'range', high: leaf.value, highInclusive: leaf.op === 'lte' }];
      default: return null;
    }
  }

  /**
   * How indexes can narrow a filter: { cost, rows() } or null (as the library's indexPlan). Range conditions on one
   * column (in an AND) become one bounded lookup; lookups are taken cheapest first within `budget` bytes. Given
   * `scanRows`, a text search for common text narrows nothing, and rows() may then return null: scan.
   */
  async function indexPlan(node, indexes, budget, scanRows) {
    const lookupPlan = async (leaf, kind, lookup) => {
      const index = await indexes(leaf.column.name, kind);
      const cost = index ? index.cost(lookup) : null;
      return cost === null || cost > budget ? null : { cost, rows: () => index.rows(lookup, scanRows) };
    };
    switch (node.kind) {
      case 'and': {
        const parts = [];
        const ranges = new Map(); // column position -> [leaf, merged range lookup]
        for (const item of node.items) {
          if (item.kind === 'leaf' && RANGE_OPS.has(item.op) && !(typeof item.value === 'number' && Number.isNaN(item.value))) {
            const [, add] = leafLookup(item);
            const [, merged] = ranges.get(item.column.position) ?? [item, { op: 'range' }];
            const cmp = (a, b) => keyCompare(item.column.type, a, b);
            if (add.low !== undefined && (merged.low === undefined || cmp(add.low, merged.low) > 0 || (cmp(add.low, merged.low) === 0 && !add.lowInclusive))) {
              Object.assign(merged, { low: add.low, lowInclusive: add.lowInclusive });
            }
            if (add.high !== undefined && (merged.high === undefined || cmp(add.high, merged.high) < 0 || (cmp(add.high, merged.high) === 0 && !add.highInclusive))) {
              Object.assign(merged, { high: add.high, highInclusive: add.highInclusive });
            }
            ranges.set(item.column.position, [item, merged]);
          } else {
            parts.push(await indexPlan(item, indexes, budget, scanRows));
          }
        }
        for (const [leaf, lookup] of ranges.values()) parts.push(await lookupPlan(leaf, 'sorted', lookup));
        const usable = parts.filter(Boolean).sort((a, b) => a.cost - b.cost);
        const chosen = [];
        let cost = 0;
        for (const part of usable) {
          if (cost + part.cost > budget) break;
          chosen.push(part);
          cost += part.cost;
        }
        if (!chosen.length) return null;
        return {
          cost,
          rows: async () => {
            let result = null;
            for (let i = 0; i < chosen.length && result?.length !== 0; i++) {
              const rows = await chosen[i].rows();
              if (rows !== null) result = result === null ? rows : intersectSorted(result, rows);
            }
            return result;
          },
        };
      }
      case 'or': {
        const parts = [];
        let cost = 0;
        for (const item of node.items) {
          const part = await indexPlan(item, indexes, budget, scanRows);
          if (part === null) return null;
          parts.push(part);
          cost += part.cost;
        }
        const rows = async () => {
          const lists = await Promise.all(parts.map((p) => p.rows()));
          return lists.includes(null) ? null : unionAll(lists);
        };
        return cost > budget ? null : { cost, rows };
      }
      case 'not': case 'nested': return null;
      default: {
        const lookup = leafLookup(node);
        return lookup ? lookupPlan(node, lookup[0], lookup[1]) : null;
      }
    }
  }

  // ---- sources: a File / Blob read in slices, or bytes in memory -------------------------------------

  const FILE_CHANGED = new Set(['NotReadableError', 'NotFoundError']);

  function sourceOf(input) {
    if (input instanceof Uint8Array) {
      return { size: input.length, read: async (offset, length) => input.subarray(offset, offset + length) };
    }
    if (input instanceof ArrayBuffer) return sourceOf(new Uint8Array(input));
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      // A File whose disk content can't be read fails with a DOMException (File API: NotReadableError, NotFoundError);
      // a Blob made in memory always reads. Other errors (out of memory) are passed on as they are.
      return {
        size: input.size,
        read: async (offset, length) => {
          try {
            return new Uint8Array(await input.slice(offset, offset + length).arrayBuffer());
          } catch (error) {
            throw typeof DOMException !== 'undefined' && error instanceof DOMException ? new JazminFileChangedError(error) : error;
          }
        },
      };
    }
    // Any other source: { size, read(offset, length) -> Uint8Array or a promise of one }.
    if (input && Number.isSafeInteger(input.size) && input.size >= 0 && typeof input.read === 'function') {
      return {
        size: input.size,
        read: async (offset, length) => {
          let bytes;
          try {
            bytes = await input.read(offset, length);
          } catch (error) {
            // What browsers throw when a File changed (NotReadableError) or is gone (NotFoundError): a source that
            // reads a File gets the same error as the File itself.
            throw FILE_CHANGED.has(error?.name) && !(error instanceof JazminError) ? new JazminFileChangedError(error) : error;
          }
          if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new JazminFormatError('The source returned the wrong number of bytes');
          return bytes;
        },
      };
    }
    throw new JazminError('Open a File, Blob, ArrayBuffer, Uint8Array or { size, read(offset, length) }');
  }

  const BLOCK_SIZE = 64 * 1024; // bytes fetched per range request, at least
  const BLOCKS_CACHED = 64; // fetched blocks kept per file (4 MiB with the default block size)

  /**
   * A file on a web server read with HTTP range requests. The first request fetches the last block (the trailer,
   * header and directories of most files, and the size from Content-Range); later reads fetch whole aligned blocks,
   * kept in a small cache, and reads of the same block wait for one request. A server that answers with the whole
   * file instead (no range support) is read from memory. Cross-origin servers must expose Content-Range (CORS).
   */
  async function urlSource(url, { headers = {}, blockSize = BLOCK_SIZE } = {}) {
    if (!(Number.isSafeInteger(blockSize) && blockSize >= 1024)) throw new JazminError('blockSize must be at least 1024 bytes');
    const get = async (range) => {
      let response;
      try {
        response = await fetch(url, { headers: { ...headers, Range: range } });
      } catch (error) {
        throw new JazminError(`Could not read ${url}: ${error.message}`);
      }
      if (response.status !== 206 && response.status !== 200) throw new JazminError(`Could not read ${url}: HTTP ${response.status}`);
      return response;
    };
    const tail = await get(`bytes=-${blockSize}`);
    const body = new Uint8Array(await tail.arrayBuffer());
    if (tail.status === 200) return sourceOf(body); // no range support: the whole file came back
    const total = /\/(\d+)\s*$/.exec(tail.headers.get('Content-Range') ?? '');
    if (!total) throw new JazminError(`${url}: the server's answer has no readable Content-Range header (cross-origin servers must expose it)`);
    const size = Number(total[1]);
    const blocks = new Map(); // block number -> bytes (least recently used first), or a pending fetch
    const keep = (n, bytes) => {
      blocks.delete(n);
      blocks.set(n, bytes);
      if (blocks.size > BLOCKS_CACHED) blocks.delete(blocks.keys().next().value);
    };
    // The tail block: the bytes it holds, cut at block boundaries (its start need not be one).
    const tailStart = size - body.length;
    for (let n = Math.ceil(tailStart / blockSize); n * blockSize < size; n++) {
      const start = n * blockSize - tailStart;
      keep(n, body.subarray(start, Math.min(start + blockSize, body.length)));
    }
    const fetchBlocks = async (first, last) => {
      const start = first * blockSize;
      const end = Math.min((last + 1) * blockSize, size) - 1;
      const response = await get(`bytes=${start}-${end}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const from = response.status === 200 ? start : 0; // a server may answer a range with the whole file
      if (bytes.length < from + end - start + 1) throw new JazminFormatError(`${url}: the server returned fewer bytes than asked for`);
      for (let n = first; n <= last; n++) keep(n, bytes.subarray(from + (n - first) * blockSize, from + Math.min((n - first + 1) * blockSize, end - start + 1)));
    };
    return {
      size,
      async read(offset, length) {
        const first = Math.floor(offset / blockSize);
        const last = Math.floor((offset + Math.max(length, 1) - 1) / blockSize);
        if (last - first + 1 > BLOCKS_CACHED / 2) {
          // A large read (a big index, say) would push its own blocks out of the cache: fetch it as it is.
          const response = await get(`bytes=${offset}-${offset + length - 1}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const from = response.status === 200 ? offset : 0;
          if (bytes.length < from + length) throw new JazminFormatError(`${url}: the server returned fewer bytes than asked for`);
          return bytes.subarray(from, from + length);
        }
        // One request for the blocks still missing (from the first missing to the last), shared by concurrent reads.
        let missingFrom = -1;
        let missingTo = -1;
        for (let n = first; n <= last; n++) {
          if (!blocks.has(n)) {
            if (missingFrom < 0) missingFrom = n;
            missingTo = n;
          }
        }
        if (missingFrom >= 0) {
          const pending = fetchBlocks(missingFrom, missingTo);
          const waiting = [];
          for (let n = missingFrom; n <= missingTo; n++) {
            if (!blocks.has(n)) {
              blocks.set(n, pending);
              waiting.push(n);
            }
          }
          try {
            await pending;
          } catch (error) {
            for (const n of waiting) if (blocks.get(n) === pending) blocks.delete(n); // a later read tries again
            throw error;
          }
        }
        for (let n = first; n <= last; n++) if (blocks.get(n) instanceof Promise) await blocks.get(n);
        const out = new Uint8Array(length);
        for (let n = first; n <= last; n++) {
          const block = blocks.get(n);
          keep(n, block);
          const blockStart = n * blockSize;
          const from = Math.max(offset, blockStart);
          const to = Math.min(offset + length, blockStart + block.length);
          out.set(block.subarray(from - blockStart, to - blockStart), from - offset);
        }
        return out;
      },
    };
  }

  /**
   * Opens a JAZMIN file on a web server, reading only the parts a query needs (HTTP range requests). options: those
   * of open(), plus { headers } (sent with every request, e.g. Authorization) and { blockSize } (bytes per request,
   * at least; default 64 KiB).
   */
  async function openUrl(url, options = {}) {
    const { headers, blockSize, ...openOptions } = options;
    return open(await urlSource(url, { headers, blockSize }), openOptions);
  }

  /**
   * Opens a JAZMIN file made into a script (the library's portableScript(), or "jazmin script"), at `url`: relative to
   * the page, or a file:/// address. Pages opened from disk can't read a file beside them, but they can load a script,
   * from any folder. The script registers the file under its own address (globalThis.JazminScripts); one the page
   * already loaded with a <script> element is used as it is. The page holds the whole file in memory: for small files.
   * options: those of open().
   */
  async function openScript(url, options = {}) {
    return open(await scriptBytes(url), options);
  }

  /**
   * The bytes of a JAZMIN file made into a script, loaded as openScript() loads it: for example to hand the file to the
   * viewer in an iframe (postMessage({ type: 'jazmin:open', file: new Blob([bytes]), name })). Still encrypted.
   */
  async function scriptBytes(url) {
    if (typeof document === 'undefined') throw new JazminError('openScript() loads a script into a page; elsewhere, open the .jzm with open()');
    const scripts = (global.JazminScripts = global.JazminScripts || {});
    const src = new URL(url, document.baseURI).href;
    // Taken as the script's load event fires, right after it ran: another load of the same script can't mix in.
    const take = () => {
      const entry = scripts[src];
      delete scripts[src]; // the text can go: the reader keeps the bytes
      return entry;
    };
    const entry = scripts[src] ? take() : await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.onload = () => {
        script.remove();
        resolve(take());
      };
      script.onerror = () => {
        script.remove();
        reject(new JazminError(`Could not load ${url}`));
      };
      script.src = src;
      document.head.append(script);
    });
    if (!entry || typeof entry.data !== 'string') throw new JazminFormatError(`${url} is not a JAZMIN file made into a script (portableScript, or "jazmin script")`);
    return typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(entry.data) : base64ToBytes(entry.data);
  }

  // ---- the reader ---------------------------------------------------------------------------------

  /**
   * Opens a JAZMIN file. `input`: a File, Blob, ArrayBuffer or Uint8Array. options: { key } (jzk1-... master or owner
   * key, or jza1-... access key), { password }, { unlockToken } for online access keys, { table } (default: the first).
   */
  async function open(input, options = {}) {
    const file = await openFile(sourceOf(input), options);
    return file.table(options.table);
  }

  /** What is shared by the readers of a file's tables: source, header, keys, files. */
  async function openFile(source, options) {
    const { size } = source;
    const read = async (offset, length) => {
      if (!(offset >= 0 && length >= 0 && offset + length <= size)) throw new JazminFormatError('Unexpected end of file');
      return source.read(offset, length);
    };
    if (size < PREAMBLE + TRAILER) throw new JazminFormatError('File is too small to be JAZMIN');
    const preamble = await read(0, PREAMBLE);
    const magic = fromUtf8.decode(preamble.subarray(0, 4));
    if (magic === 'JZMN') throw new JazminFormatError('This file uses a pre-release JAZMIN draft format - write it again from its source data');
    if (magic !== 'JZM1') throw new JazminFormatError('Not a JAZMIN file');
    const pv = view(preamble);
    const flags = pv.getUint16(4, true);
    if (flags & ~KNOWN_FLAGS) throw new JazminFormatError(`Unsupported file features (flags 0x${flags.toString(16)})`);
    const fileId = preamble.slice(8, 24);
    const salt = preamble.slice(24, 56);
    const iterations = pv.getUint32(56, true);
    const trailer = await locateTrailer(read, size);

    /**
     * Reads, checks (digest, CRC-32), decrypts and decompresses a section. `bytes`: the section as stored, when
     * readSections() has read it already.
     */
    async function section(ref, sectionId, key, { requireDigest = false, bytes = null } = {}) {
      if (!(ref.length >= ENVELOPE)) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      const s = bytes ?? await read(ref.offset, ref.length);
      if (file.cost) file.cost.bytesRead += ref.length;
      if (ref.digest) {
        if (!equal(await sha256(s), ref.digest)) throw new JazminFormatError(`Section '${sectionId}' does not match the owner's signature`);
      } else if (requireDigest) {
        throw new JazminFormatError(`Section '${sectionId}' has no digest`);
      }
      return decode(s, sectionId, key);
    }

    /**
     * Many sections as stored, by the position of their ref (null for a ref read on its own later): neighbours less
     * than MERGE_GAP apart are read together, up to MERGE_SPAN bytes at a time. A browser answers each read of a File
     * or Blob on another process (about half a millisecond each in Chrome, however small), so a key spanning
     * thousands of partitions reads their directories in a few reads instead of thousands (issue #258).
     */
    async function readSections(refs) {
      const out = new Array(refs.length).fill(null);
      const order = refs.map((ref, k) => k).filter((k) => refs[k]?.length >= ENVELOPE).sort((a, b) => refs[a].offset - refs[b].offset);
      const spans = [];
      for (const k of order) {
        const { offset, length } = refs[k];
        const last = spans.at(-1);
        if (last && offset >= last.start && offset - last.end <= MERGE_GAP && offset + length - last.start <= MERGE_SPAN) {
          last.end = Math.max(last.end, offset + length);
          last.members.push(k);
        } else spans.push({ start: offset, end: offset + length, members: [k] });
      }
      await Promise.all(spans.filter((span) => span.members.length > 1).map(async (span) => {
        const bytes = await read(span.start, span.end - span.start);
        for (const k of span.members) out[k] = bytes.subarray(refs[k].offset - span.start, refs[k].offset - span.start + refs[k].length);
      }));
      return out;
    }

    async function decode(s, sectionId, key) {
      if (s.length < ENVELOPE) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      const v = view(s);
      const codec = s[0];
      const encrypted = (s[1] & 1) !== 0;
      const rawLength = v.getUint32(4, true);
      const payloadLength = v.getUint32(8, true);
      let body = s.subarray(ENVELOPE, ENVELOPE + payloadLength);
      if (body.length !== payloadLength || payloadLength + ENVELOPE !== s.length) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      if (crc32(body) !== v.getUint32(12, true)) throw new JazminFormatError(`Section '${sectionId}' failed its CRC-32 check`);
      if (key && !encrypted) throw new JazminFormatError(`Section '${sectionId}' is not encrypted but the file is`);
      if (encrypted) {
        if (!key) throw new JazminKeyError('This file is encrypted - enter its key or password');
        body = await decrypt(key, body, concat(fileId, s.subarray(0, 8), utf8.encode(sectionId)));
      }
      if (codec === CODEC_DEFLATE) return inflateRaw(body, rawLength);
      if (codec === CODEC_BROTLI) throw new JazminFormatError('Brotli sections cannot be read in browsers - write the file with deflate');
      if (codec !== CODEC_NONE) throw new JazminFormatError(`Unsupported codec ${codec}`);
      if (body.length !== rawLength) throw new JazminFormatError(`Section '${sectionId}' has the wrong decompressed length`);
      return body;
    }

    const plainSection = (bytes, sectionId) => {
      if (bytes.length < ENVELOPE || bytes[0] !== CODEC_NONE || bytes[1] !== 0) throw new JazminFormatError(`Section '${sectionId}' must be stored as is`);
      return decode(bytes, sectionId, null);
    };

    const headerSection = await read(trailer.header.offset, trailer.header.length);
    let headerRaw;
    let keys = null; // key or password files: { master }
    let access = null; // access-controlled files
    if (flags & FLAG_ACCESS) {
      if (options.password || !options.key) throw new JazminKeyError('This file is access-controlled - enter an owner key or access key');
      const key = await parseKey(options.key);
      if (key.kind === 'owner') throw Object.assign(new JazminKeyError(MASTER_KEY_REFUSED), { masterKeyRefused: true });
      if (!trailer.keySlots.length || !trailer.signature.length) throw new JazminFormatError('Key-slot or signature section is missing');
      const slotsSection = await read(trailer.keySlots.offset, trailer.keySlots.length);
      const signature = await plainSection(await read(trailer.signature.offset, trailer.signature.length), 'signature');
      if (signature.length !== 65 + 64) throw new JazminFormatError('Signature section has the wrong length');
      const owner = signature.subarray(0, 65);
      if (!equal((await sha256(owner)).subarray(0, 8), key.fingerprint)) throw new JazminKeyError('This file was not signed by the owner of this key');
      const message = concat(utf8.encode('JAZMIN/1/signature'), fileId, await sha256(slotsSection), await sha256(headerSection));
      if (!(await verifySignature(owner, message, signature.subarray(65)))) throw new JazminFormatError("The file's owner signature is invalid - the file was modified");
      const secret = key.secret;
      const id = await slotId(secret);
      const list = await plainSection(slotsSection, 'keyslots');
      const page = findPage(list, id);
      if (!page) throw new JazminKeyError('This key has not been granted access to this file');
      const pageSection = await read(page.offset, page.length);
      if (!equal(await sha256(pageSection), page.digest)) throw new JazminFormatError("Key-slot page does not match the owner's signature");
      const slot = findSlot(await plainSection(pageSection, `keyslots/${page.index}`), id);
      if (!slot) throw new JazminKeyError('This key has not been granted access to this file');
      let share = null;
      if (slot.online) {
        if (!options.unlockToken) throw new JazminUnlockRequiredError("This key needs an unlock token from the file owner's key service", toHex(fileId), toHex(id));
        share = await parseUnlockToken(options.unlockToken);
      }
      let bundle;
      try {
        const kek = await hkdf(share ? concat(secret, share) : secret, salt, 'JAZMIN/1/slot');
        bundle = parseJson(fromUtf8.decode(await decrypt(kek, slot.sealed, concat(fileId, id))), 'A key slot', true);
      } catch (error) {
        if (slot.online && error instanceof JazminKeyError) throw new JazminKeyError('The unlock token is not valid for this key and file');
        throw error;
      }
      const isOwner = bundle.owner !== undefined;
      const b = (s) => base64ToBytes(String(s));
      access = {
        isOwner,
        keyId: toHex(id), // the access key's id, as the owner's grants list it
        header: b(bundle.header),
        owner: isOwner ? b(bundle.owner) : null,
        partitions: new Map(Object.entries(bundle.partitions ?? {}).map(([pid, s]) => [pid, b(s)])),
        columns: new Map(Object.entries(bundle.columns ?? {}).map(([g, s]) => [g, b(s)])),
        files: new Map(Object.entries(bundle.files ?? {}).map(([g, s]) => [g, b(s)])),
        expires: bundle.expires,
        online: Boolean(bundle.online),
        // The key of what this key's holder sends back to the owner (spec 7.8); files written before it have none.
        submission: typeof bundle.submission === 'string' ? await keyText(b(bundle.submission)) : null,
        masks: readBundleMasks(bundle.masks),
        editLimit: bundle.edit, // what this key may send back (spec 7.9.1), as written
      };
      if (access.expires !== undefined) {
        const expires = Date.parse(access.expires);
        // The libraries also keep a last-seen record; a browser cannot keep one users could not clear.
        if (!(Date.now() <= expires)) throw new JazminKeyError(`Access for this key expired at ${access.expires}`);
      }
      headerRaw = await decode(headerSection, 'header', await hkdf(access.header, salt, 'JAZMIN/1/header'));
    } else {
      if (options.key && /^\s*jza1-/.test(options.key)) throw new JazminKeyError('This file is not access-controlled - use its master key');
      if (flags & FLAG_ENCRYPTED) {
        if (!options.key && !options.password) throw new JazminKeyError('This file is encrypted - enter its key or password');
        if (options.password && !(flags & FLAG_PASSWORD)) throw new JazminKeyError('This file was encrypted with a key, not a password');
        let master;
        if (options.password) {
          if (!(iterations >= MIN_KDF_ITERATIONS && iterations <= MAX_KDF_ITERATIONS)) throw new JazminFormatError(`The file asks for ${iterations} password iterations`);
          master = await pbkdf2(options.password, salt, iterations);
        } else {
          const key = await parseKey(options.key);
          if (key.kind !== 'owner') throw new JazminKeyError('This file needs its master key (jzk1-...)');
          master = key.bytes;
        }
        keys = { master };
        headerRaw = await decode(headerSection, 'header', await hkdf(master, salt, 'JAZMIN/1/header'));
      } else {
        if (options.key || options.password) throw new JazminKeyError('A key was entered but the file is not encrypted');
        headerRaw = await decode(headerSection, 'header', null);
      }
    }
    const header = readHeader(headerRaw);
    if (access?.expires !== undefined && Date.now() + 5 * 60000 < (header.modified || header.created)) {
      throw new JazminKeyError('The clock reads earlier than when this file was written - access refused'); // spec 7.7, check 2
    }
    const unsupported = header.readerFeatures.filter((feature) => feature !== 'index-deltas' && feature !== NESTED_COLUMNS);
    if (unsupported.length) throw new JazminFormatError(`This file needs features this reader does not support: ${unsupported.join(', ')}`);
    if (!header.tables.length) throw new JazminFormatError('Catalog: the file lists no tables');

    const file = {
      header, fileId, salt, size, keys, access, section, read, readSections,
      cost: null, // while explain({ analyze }) runs a query: what it reads
      gate: limiter(PARALLEL_SECTIONS), // file.gate(fn): fn() once fewer than PARALLEL_SECTIONS sections are being read
      metadata: header.metadata ? parseJson(header.metadata, 'Metadata', true) : {},
      /** Key of a catalog section: keyring group (key files) or HKDF(secret) (access-controlled files). */
      async key(sectionId, secret, group = 'data') {
        if (access) return hkdf(secret, salt, `JAZMIN/1/${sectionId}`);
        if (!keys) return null;
        const ring = header.keyring[group];
        if (!ring) throw new JazminFormatError(`Keyring has no secret for group '${group}'`);
        return hkdf(keys.master, ring, `JAZMIN/1/${sectionId}`);
      },
      async partitionSecret(id) {
        return access.isOwner ? hkdf(access.owner, salt, `JAZMIN/1/partition/${id}`) : access.partitions.get(id) ?? null;
      },
      async columnSecret(group) {
        return access.isOwner ? hkdf(access.owner, salt, `JAZMIN/1/column-group/${group}`) : access.columns.get(group) ?? null;
      },
      table: (name) => openTable(file, name, true),
      // The table readers handed out (weakly held): unlocking a masked column builds them again (spec 7.6.8).
      readers: new Set(),
    };
    return file;
  }

  async function locateTrailer(read, size) {
    const parse = (t) => {
      const v = view(t);
      return {
        header: { offset: Number(v.getBigUint64(0, true)), length: v.getUint32(8, true) },
        keySlots: { offset: Number(v.getBigUint64(12, true)), length: v.getUint32(20, true) },
        signature: { offset: Number(v.getBigUint64(24, true)), length: v.getUint32(32, true) },
      };
    };
    const valid = (t) => fromUtf8.decode(t.subarray(40, 44)) === 'JZM1' && crc32(t.subarray(0, 36)) === view(t).getUint32(36, true);
    const last = await read(size - TRAILER, TRAILER);
    if (valid(last)) return parse(last);
    // An interrupted append left bytes after the last complete version: find its trailer (spec 4.2, 11.2).
    const start = Math.max(PREAMBLE, size - 4 * 1024 * 1024);
    const tail = await read(start, size - start);
    for (let at = tail.length - TRAILER; at >= 0; at--) {
      if (tail[at + 40] === 0x4a && valid(tail.subarray(at, at + TRAILER))) return parse(tail.subarray(at, at + TRAILER));
    }
    throw new JazminFormatError('Missing trailer - the file is truncated');
  }

  function findPage(list, id) {
    if (list.length < 4) throw new JazminFormatError('Key-slot list is truncated');
    const v = view(list);
    const count = v.getUint32(0, true);
    if (list.length !== 4 + count * PAGE_ENTRY) throw new JazminFormatError('Key-slot list has the wrong length');
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = 4 + mid * PAGE_ENTRY;
      if (compareBytes(list.subarray(at, at + SLOT_ID), id) <= 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const at = 4 + (lo - 1) * PAGE_ENTRY;
    return {
      index: lo - 1,
      offset: Number(v.getBigUint64(at + SLOT_ID, true)),
      length: v.getUint32(at + SLOT_ID + 8, true),
      digest: list.subarray(at + SLOT_ID + 12, at + PAGE_ENTRY),
    };
  }

  function findSlot(raw, id) {
    if (raw.length < 4) throw new JazminFormatError('Key-slot page is truncated');
    const v = view(raw);
    const count = v.getUint32(0, true);
    const blobsAt = 4 + count * SLOT_ENTRY;
    if (blobsAt > raw.length) throw new JazminFormatError('Key-slot page is truncated');
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = 4 + mid * SLOT_ENTRY;
      const c = compareBytes(raw.subarray(at, at + SLOT_ID), id);
      if (c === 0) {
        const start = blobsAt + v.getUint32(at + SLOT_ID, true);
        const length = v.getUint32(at + SLOT_ID + 4, true);
        const end = start + ((length & ~ONLINE_SLOT) >>> 0);
        if (end > raw.length) throw new JazminFormatError('Key slot points outside its page');
        return { sealed: raw.subarray(start, end), online: (length & ONLINE_SLOT) !== 0 };
      }
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** A table reader; `register`: one handed out, built again in place when a masked column is unlocked (spec 7.6.8). */
  async function openTable(file, name, register = false) {
    const reader = await tableReader(file, name);
    if (register) file.readers.add(new WeakRef(reader));
    return reader;
  }

  /** One table of an open file: its columns (those this key may see), chunks and deleted rows. */
  async function tableReader(file, name) {
    const { header, access } = file;
    const index = name === undefined ? 0 : header.tables.findIndex((t) => t.name === name);
    if (index < 0) throw new JazminError(`This file has no table '${name}' (tables: ${header.tables.map((t) => `'${t.name}'`).join(', ')})`);
    const table = header.tables[index];
    const counted = table.groups.reduce((n, g) => n + (g.definitions ? g.columnCount : g.columns.length), 0);
    if (counted !== table.columnCount || counted > file.size) throw new JazminFormatError('Catalog: the column count does not match the column groups');
    if (table.chunkCount * ENVELOPE > file.size) throw new JazminFormatError('Catalog: the chunk count is larger than the file can hold');
    const requireDigest = Boolean(access);

    // Column groups: restricted ones are read with the group's secret, when this key has it.
    const columns = new Array(table.columnCount).fill(null);
    const groups = [];
    for (const g of table.groups) {
      let defs = g.columns;
      let visible = true;
      let secret = null;
      if (access) {
        secret = await file.columnSecret(g.name);
        visible = Boolean(secret);
      }
      if (g.definitions && visible) {
        const sectionId = `${index}/columns/${g.name}`;
        const raw = await file.section(g.definitions, sectionId, await file.key(sectionId, secret), { requireDigest });
        defs = [];
        readMessage(raw, (f, v) => {
          if (f === 1) defs.push(readColumn(v));
        });
      }
      for (const c of visible ? defs : []) {
        if (c.position >= table.columnCount || columns[c.position]) throw new JazminFormatError('Column positions are inconsistent');
        columns[c.position] = c;
      }
      groups.push({ name: g.name, secret, visible, cols: visible ? defs.map((c) => c.position).sort((a, b) => a - b) : [] });
    }

    // Partitions this key may read, with their directory segments (inline, partition table, deltas).
    let partitions = table.partitions;
    if (table.partitionTable) {
      const sectionId = `${index}/partitions`;
      partitions = readPartitionList(await file.section(table.partitionTable, sectionId, await file.key(sectionId, access?.header), { requireDigest }));
    }
    const segments = new Map(partitions.map((p) => [p.id.length ? bytesToBase64Url(p.id) : WHOLE_TABLE, [...p.segments]]));
    for (let d = 0; d < header.deltas.length; d++) {
      const sectionId = `delta/${d}`;
      for (const t of readDelta(await file.section(header.deltas[d], sectionId, await file.key(sectionId, access?.header), { requireDigest }))) {
        if (t.table !== index) continue;
        for (const p of t.partitions) {
          const id = p.id.length ? bytesToBase64Url(p.id) : WHOLE_TABLE;
          segments.set(id, [...(segments.get(id) ?? []), ...p.segments]);
        }
      }
    }
    const chunks = [];
    const dirSegments = []; // { partition, suffix, chunks, statistics, loaded: block number -> promise of its loading }
    const groupCount = table.groups.length;
    let hiddenRows = 0;
    // The chunk directories (one more per append) are read by the first query that needs them (route), as the library's
    // reader does, so that a file opens as fast after many appends as after none. An access key other than the owner's
    // reads its own now: rowCount needs them.
    let unread = [...segments]; // the partitions and their directory segments, until they are read
    let directoriesLoading = null; // their loading, once started
    const ensureDirectories = () => (directoriesLoading ??= (async () => {
      const pending = unread;
      unread = null;
      // The partitions' directories are read a few at a time, and used in the order they are listed. In a function of
      // its own, given the list, so that neither is kept with the reader.
      await (async (listed) => {
        const secrets = [];
        for (const batch of inBatches(listed, () => null)) secrets.push(...await Promise.all(batch.map(([id]) => (access ? file.gate(() => file.partitionSecret(id)) : null))));
        const toRead = [];
        listed.forEach(([id, list], p) => {
          const secret = secrets[p];
          if (access && !(secret && groups.some((g) => g.visible))) return; // another key's partition: not read
          list.forEach((ref, s) => toRead.push({ id, s, ref, secret, sectionId: `${index}/dir/${id}${s ? `/${s}` : ''}` }));
        });
        // Read a batch at a time, so that only one batch of their bytes is held at once.
        for (const batch of inBatches(toRead, (t) => t.ref)) {
          const stored = await file.readSections(batch.map((t) => t.ref));
          const directories = await Promise.all(batch.map(({ ref, secret, sectionId }, k) => file.gate(async () => (
            readDirectory(await file.section(ref, sectionId, await file.key(sectionId, secret), { requireDigest, bytes: stored[k] }), groupCount)))));
          batch.forEach(({ id, s, secret }, k) => {
            const segmentChunks = directories[k].chunks.map((c) => ({ ...c, partition: id, partitionSecret: secret, stats: [] }));
            chunks.push(...segmentChunks);
            dirSegments.push({ partition: id, suffix: s ? `/${s}` : '', chunks: segmentChunks, statistics: directories[k].statistics, loaded: new Map() });
          });
        }
      })(pending);
      chunks.sort((a, b) => a.ordinal - b.ordinal);
      for (let i = 1; i < chunks.length; i++) if (chunks[i].ordinal === chunks[i - 1].ordinal) throw new JazminFormatError('Chunk ordinals are inconsistent');
    })());
    const lazy = !access || access.isOwner;
    if (!lazy) await ensureDirectories();

    let deleted = [];
    if (table.deletes) {
      const sectionId = `${index}/deletes/${table.deletedCount}`;
      deleted = readPostingsSection(await file.section(table.deletes, sectionId, await file.key(sectionId, access?.header), { requireDigest }));
    }
    const deletedSet = new Set(deleted);
    /** Rows of a chunk not deleted by appends (`deleted` is sorted). */
    const liveRows = (chunk) => {
      const below = (id) => {
        let lo = 0;
        let hi = deleted.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (deleted[mid] < id) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      return chunk.rowCount - (below(chunk.rowStart + chunk.rowCount) - below(chunk.rowStart));
    };
    const visibleColumns = columns.filter(Boolean).map(({ position, ...c }) => c);
    // Lazy: every row is this reader's (as the library's rowCount); an access key counts the rows of its own chunks.
    const visibleRows = lazy ? table.rowCount - deleted.length
      : chunks.reduce((n, c) => n + c.rowCount, 0) - deleted.filter((id) => chunks.some((c) => id >= c.rowStart && id < c.rowStart + c.rowCount)).length;
    hiddenRows = table.rowCount - table.deletedCount - visibleRows;

    /**
     * A chunk's columns: `values` by column position (null where not decoded) and the positions decoded. `wanted` (by
     * column position) limits the columns decoded; a column group none of whose columns is wanted is not read.
     * `datesAsMs` gives datetimes as milliseconds instead of Date objects; `types` (by column position) other
     * definitions to decode with (nested columns with fields left out). A query that decodes a chunk in two passes
     * passes the same `read` ({ raws: Map, counted }) to both: each section is read and decompressed once.
     */
    async function chunkColumns(chunk, wanted = null, datesAsMs = false, types = null, read = null, rows = null, positions = null) {
      const values = new Array(table.columnCount).fill(null);
      const decodedCols = [];
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        if (!group.visible || !group.cols.length) continue;
        const groupWanted = wanted && group.cols.map((c) => wanted[c]);
        if (groupWanted && !groupWanted.includes(true)) continue;
        const sectionId = `${index}/chunk/${chunk.ordinal}/${group.name}`;
        const key = access
          ? await hkdf(concat(chunk.partitionSecret, group.secret), file.salt, `JAZMIN/1/${sectionId}`)
          : await file.key(sectionId, null);
        let raw = read?.raws.get(g);
        if (!raw) {
          raw = await file.section(chunk.parts[g], sectionId, key, { requireDigest, bytes: read?.stored?.get(g) });
          read?.raws.set(g, raw);
        }
        const groupTypes = group.cols.map((c) => types?.[c] ?? streamType(columns[c]));
        const cols = positions
          ? decodeColumnarAt(raw, groupTypes, chunk.rowCount, chunk.ordinal, groupWanted, positions, datesAsMs)
          : decodeColumnar(raw, groupTypes, chunk.rowCount, chunk.ordinal, groupWanted, datesAsMs, rows);
        group.cols.forEach((c, j) => {
          if (groupWanted && !groupWanted[j]) return;
          values[c] = cols[j];
          decodedCols.push(c);
        });
      }
      if (file.cost) {
        if (!read?.counted) file.cost.chunksRead++;
        if (read) read.counted = true;
        file.cost.columnsDecoded += decodedCols.length;
      }
      return { values, decodedCols };
    }

    /**
     * A chunk's rows as objects, by position in the chunk (rows deleted by appends are null). `wanted` (by column
     * position) limits the columns decoded; a column group none of whose columns is wanted is not read.
     */
    async function chunkRows(chunk, wanted = null) {
      const { values, decodedCols } = await chunkColumns(chunk, wanted);
      const rows = new Array(chunk.rowCount);
      for (let r = 0; r < chunk.rowCount; r++) {
        if (deletedSet.has(chunk.rowStart + r)) {
          rows[r] = null;
          continue;
        }
        const row = {};
        for (const i of decodedCols) setField(row, columns[i].name, values[i][r]);
        rows[r] = row;
      }
      return rows;
    }

    // ---- planning (as the library's reader): statistics, sort order, indexes ----
    const planColumnsList = columns.filter(Boolean);
    const byOrdinal = new Map(chunks.map((c) => [c.ordinal, c]));
    const chunkBytes = (chunk) => chunk.parts.reduce((n, part) => n + part.length, 0);
    const groupOfColumn = new Map();
    groups.forEach((g) => g.cols.forEach((c) => groupOfColumn.set(c, g)));

    /** Loads the statistics of these columns for every directory segment that has them. */
    // Blocks are read a few at a time; a block another query is loading is waited for, not read again.
    // With many partitions, their blocks are read together (readSections).
    async function ensureStats(cols) {
      const loading = [];
      const added = [];
      for (const segment of dirSegments) {
        for (let b = 0; b < segment.statistics.length; b++) {
          const block = segment.statistics[b];
          if (!block.columns.some((c) => cols.has(c))) continue;
          if (!segment.loaded.has(b)) {
            const job = { segment, b, block };
            added.push(job);
            segment.loaded.set(b, new Promise((resolve) => { job.start = resolve; })
              .then((bytes) => file.gate(() => loadStats(segment, b, block, bytes)))
              .then(() => segment.loaded.set(b, STATS_LOADED))); // loaded: one shared promise, none kept per block
          }
          loading.push(segment.loaded.get(b));
        }
      }
      // A batch at a time. A read that fails here is tried again by each block alone, which then fails with its own error.
      for (const batch of inBatches(added, (job) => job.block.section)) {
        const stored = dirSegments.length > 1 ? await file.readSections(batch.map((job) => job.block.section)).catch(() => []) : [];
        batch.forEach((job, k) => job.start(stored[k] ?? null));
        await Promise.allSettled(batch.map((job) => job.segment.loaded.get(job.b)));
      }
      await Promise.all(loading);
    }

    /** Reads one statistics block of a directory segment into its chunks' stats (`bytes`: as stored, read already). */
    async function loadStats(segment, b, block, bytes) {
      if (block.columns.some((c) => !(c >= 0 && c < table.columnCount))) throw new JazminFormatError('Statistics block lists unknown columns');
      const group = groupOfColumn.get(block.columns[0]);
      if (!group || !group.visible) return; // a column group this key cannot see
      const sectionId = `${index}/stats/${segment.partition}/${b}${segment.suffix}`;
      const key = access
        ? await hkdf(concat(segment.chunks[0]?.partitionSecret ?? await file.partitionSecret(segment.partition), group.secret), file.salt, `JAZMIN/1/${sectionId}`)
        : await file.key(sectionId, null);
      const entries = readStatistics(await file.section(block.section, sectionId, key, { requireDigest, bytes }));
      if (entries.length !== block.columns.length) throw new JazminFormatError('Statistics block does not match its columns');
      block.columns.forEach((col, k) => {
        const e = entries[k];
        const n = segment.chunks.length;
        if (e.nulls.length !== n || e.min.length !== n || e.max.length !== n) throw new JazminFormatError('Statistics do not match the chunk directory');
        const type = columns[col]?.type;
        if (!type) return;
        segment.chunks.forEach((chunk, i) => {
          chunk.stats[col] = { nulls: e.nulls[i], min: decodeBound(type, e.min[i]), max: decodeBound(type, e.max[i]) };
        });
        if (e.leaves.length) loadLeafStats(segment, col, e.leaves);
      });
    }

    /** A nested column's leaf statistics for one segment (spec 6.4): each leaf named once, with an entry per chunk. */
    function loadLeafStats(segment, col, leaves) {
      const column = columns[col];
      if (!isNested(column.type)) throw new JazminFormatError('Statistics list fields of a column that has none');
      const seen = new Set();
      const n = segment.chunks.length;
      for (const leaf of leaves) {
        const type = leafType(column, leaf.path);
        if (!type) throw new JazminFormatError('Statistics name a field that does not exist');
        const key = leaf.path.join(',');
        if (seen.has(key)) throw new JazminFormatError('Statistics name a field twice');
        seen.add(key);
        if (leaf.counts.length !== n || leaf.nulls.length !== n || leaf.min.length !== n || leaf.max.length !== n) {
          throw new JazminFormatError('Statistics do not match the chunk directory');
        }
        segment.chunks.forEach((chunk, i) => {
          if (!(leaf.nulls[i] <= leaf.counts[i])) throw new JazminFormatError('Statistics count more nulls than values');
          const byPath = ((chunk.leafStats ??= [])[col] ??= new Map());
          byPath.set(key, { count: Number(leaf.counts[i]), nulls: Number(leaf.nulls[i]), min: decodeBound(type, leaf.min[i]), max: decodeBound(type, leaf.max[i]) });
        });
      }
    }

    const statsOf = (chunk) => (col) => chunk.stats[col];
    const leavesOf = (chunk) => (col, path) => chunk.leafStats?.[col]?.get(path);
    const chunkMayMatch = (plan, chunk) => !plan || mayMatch(plan, statsOf(chunk), chunk.rowCount, leavesOf(chunk));

    /** The chunks a scan reads: on the leading sort column, a binary search on chunk statistics; then statistics. */
    function scanList(plan) {
      let list = chunks;
      const leading = table.sortedBy[0];
      const sortColumn = leading !== undefined ? planColumnsList.find((c) => c.name === leading) : undefined;
      const bounds = plan && sortColumn ? sortBounds(plan, sortColumn.position) : null;
      if (bounds && chunks.every((c) => { const st = c.stats[sortColumn.position]; return st && st.min !== undefined && st.max !== undefined && st.nulls === 0; })) {
        const cmp = (a, b) => keyCompare(sortColumn.type, a, b);
        const stat = (i) => chunks[i].stats[sortColumn.position];
        const firstWhere = (test) => {
          let lo = 0;
          let hi = chunks.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (test(stat(mid))) hi = mid;
            else lo = mid + 1;
          }
          return lo;
        };
        const from = bounds.low === undefined ? 0 : firstWhere((st) => (bounds.lowInclusive ? cmp(st.max, bounds.low) >= 0 : cmp(st.max, bounds.low) > 0));
        const to = bounds.high === undefined ? chunks.length : firstWhere((st) => (bounds.highInclusive ? cmp(st.min, bounds.high) > 0 : cmp(st.min, bounds.high) >= 0));
        list = chunks.slice(from, Math.max(from, to));
      }
      return list.filter((c) => chunkMayMatch(plan, c));
    }

    // Indexes: files that are not access-controlled (in those, indexes are the owner's alone).
    const loadedIndexes = new Map();
    async function indexOf(column, kind) {
      const cacheKey = `${column}/${kind}`;
      if (loadedIndexes.has(cacheKey)) return loadedIndexes.get(cacheKey);
      let result;
      const refs = access || table.sortedBy[0] === column ? [] : table.indexes.filter((ix) => ix.column === column && ix.kind === kind);
      const type = planColumnsList.find((c) => c.name === column)?.type;
      if (refs.length && type) {
        const readIndex = async (sectionId, ref) => {
          if (file.cost) file.cost.indexPagesRead++;
          return file.section(ref, sectionId, await file.key(sectionId, null, 'index'));
        };
        const sectionIdOf = (ix) => `${index}/index/${column}/${kind}${ix.segment ? `/${ix.segment}` : ''}`;
        const combine = (parts) => (parts.length === 1 ? parts[0] : new CompositeIndex(parts));
        if (kind === 'trigram') {
          result = new LazyTrigramIndex(refs.reduce((n, ix) => n + ix.section.length, 0), () => Promise.all(refs.map((ix) => readIndex(sectionIdOf(ix), ix.section))));
        } else {
          const parts = [];
          for (const ix of refs) {
            const sectionId = sectionIdOf(ix);
            parts.push(new PagedIndex(readIndexDirectory(await readIndex(sectionId, ix.section)), type, (part, ref) => readIndex(`${sectionId}/${part}`, ref),
              file.header.readerFeatures.includes('index-deltas')));
          }
          result = combine(parts);
        }
      }
      loadedIndexes.set(cacheKey, result);
      return result;
    }

    /** The chunk holding a row id, or undefined. */
    function chunkFor(rowId) {
      let lo = 0;
      let hi = chunks.length - 1;
      if (hi < 0) return undefined;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (chunks[mid].rowStart <= rowId) lo = mid;
        else hi = mid - 1;
      }
      const c = chunks[lo];
      return rowId >= c.rowStart && rowId < c.rowStart + c.rowCount ? c : undefined;
    }

    /**
     * How a filtered query reads (as the library's #candidates): the chunks a scan would read, or - when an index
     * lookup reads less than they do - the index's candidate rows in them. { runs: [{ chunk, from, to }], rowIds }
     * (from..to: the chunk's candidates in rowIds; rowIds null: every row of each chunk is checked).
     */
    async function route(plan) {
      await ensureDirectories();
      if (!plan) return { runs: chunks.map((chunk) => ({ chunk })), rowIds: null };
      const cols = planColumns(plan);
      const leading = planColumnsList.find((c) => c.name === table.sortedBy[0]);
      if (leading) cols.add(leading.position);
      await ensureStats(cols);
      const scan = scanList(plan);
      let budget = 0;
      let scanRows = 0;
      let smallest = Infinity;
      for (const chunk of scan) {
        budget += chunkBytes(chunk);
        scanRows += chunk.rowCount;
        smallest = Math.min(smallest, chunkBytes(chunk));
      }
      const lookup = await indexPlan(plan, indexOf, Math.max(scan.length ? budget - smallest : 0, SMALL_LOOKUP_BYTES), scanRows);
      const candidates = lookup ? await lookup.rows() : null;
      if (candidates === null) return { runs: scan.map((chunk) => ({ chunk })), rowIds: null };
      const inScan = new Set(scan);
      const rowIds = candidates.filter((id) => inScan.has(chunkFor(id)));
      const runs = [];
      for (let i = 0; i < rowIds.length;) {
        const chunk = chunkFor(rowIds[i]);
        let j = i + 1;
        while (j < rowIds.length && rowIds[j] < chunk.rowStart + chunk.rowCount) j++;
        runs.push({ chunk, from: i, to: j });
        i = j;
      }
      return { runs, rowIds };
    }

    /** By column position: the columns a query decodes - those its filter reads and those it returns. */
    function wantedColumns(plan, select) {
      const used = planColumns(plan);
      if (select) for (const name of select) used.add(planColumnsList.find((c) => c.name === name)?.position);
      else for (const c of planColumnsList) used.add(c.position);
      return Array.from({ length: table.columnCount }, (_, i) => used.has(i));
    }

    /** Rows of a query, chunk by chunk: { row } for each match, after skipping `offset` (whole chunks unread). */
    /**
     * Rows matching a filter. With `sink`, no rows are yielded: sink(values, from, to) is called instead for rows
     * from..to-1 of a chunk, with its decoded columns by position, which is all columnArrays() needs. Without a filter,
     * no row object is built at all, unbroken runs of rows go to the sink together, and dates are milliseconds.
     */
    // `only` (matchesReversed): the plan and candidates, worked out already, and the chunk runs to read.
    async function* matches(filter, { offset = 0, limit = Infinity, select, signal, onProgress, reverse = false } = {}, sink = null, only = null) {
      if (typeof reverse !== 'boolean') throw new JazminError('reverse must be true or false');
      if (reverse && !only) {
        yield* matchesReversed(filter, { offset, limit, select, signal, onProgress });
        return;
      }
      signal?.throwIfAborted();
      const match = filter ? compileFilter(filter, visibleColumns) : null;
      if (select) for (const name of select) if (!visibleColumns.some((c) => c.name === name)) throw new JazminError(`Unknown column '${name}' in select`);
      const plan = only ? only.plan : planOf(filter, planColumnsList);
      const { runs, rowIds } = only ?? await route(plan);
      if (match) {
        yield* filtered(match, plan, runs, rowIds, { offset, limit, select, signal, onProgress }, sink);
        return;
      }
      const wanted = wantedColumns(plan, select);
      let skipped = 0;
      let yielded = 0;
      for (let i = 0; i < runs.length; i++) {
        // Progress after each chunk (reported as the next one starts), and Stop between chunks.
        if (i) onProgress?.({ done: i, total: runs.length, matches: skipped + yielded });
        signal?.throwIfAborted();
        const { chunk, from, to } = runs[i];
        if (yielded >= limit) return;
        // Chunks wholly before the offset whose every row matches are counted, not read.
        if (rowIds === null && skipped < offset && offset - skipped >= liveRows(chunk) && (!plan || mustMatch(plan, statsOf(chunk), chunk.rowCount))) {
          skipped += liveRows(chunk);
          continue;
        }
        if (sink && !match) {
          const { values } = await chunkColumns(chunk, wanted, true);
          let runFrom = -1;
          let runTo = -1;
          const count = rowIds === null ? chunk.rowCount : to - from;
          for (let k = 0; k < count && yielded < limit; k++) {
            const r = rowIds === null ? k : rowIds[from + k] - chunk.rowStart;
            if (deletedSet.has(chunk.rowStart + r)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            yielded++;
            if (r !== runTo) {
              if (runFrom >= 0) sink(values, runFrom, runTo);
              runFrom = r;
            }
            runTo = r + 1;
          }
          if (runFrom >= 0) sink(values, runFrom, runTo);
          continue;
        }
        const rows = await chunkRows(chunk, wanted);
        const count = rowIds === null ? rows.length : to - from;
        for (let k = 0; k < count; k++) {
          const row = rows[rowIds === null ? k : rowIds[from + k] - chunk.rowStart];
          if (row === null) continue;
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yield select ? Object.fromEntries(select.map((name) => [name, row[name]])) : row;
          if (++yielded >= limit) return;
        }
      }
      if (runs.length) onProgress?.({ done: runs.length, total: runs.length, matches: skipped + yielded });
    }

    /**
     * Rows last first, as the library's reverse: the chunks the query reads, from the last; each one's matching rows read
     * as matches() reads them and given last first. Chunks an offset passes over whole are counted, not read.
     */
    async function* matchesReversed(filter, { offset, limit, select, signal, onProgress }) {
      signal?.throwIfAborted();
      if (select) for (const name of select) if (!visibleColumns.some((c) => c.name === name)) throw new JazminError(`Unknown column '${name}' in select`);
      const plan = planOf(filter, planColumnsList);
      const { runs, rowIds } = await route(plan);
      let skipped = 0;
      let yielded = 0;
      for (let i = runs.length - 1, done = 0; i >= 0 && yielded < limit; i--, done++) {
        if (done) onProgress?.({ done, total: runs.length, matches: skipped + yielded });
        signal?.throwIfAborted();
        const { chunk } = runs[i];
        if (rowIds === null && skipped < offset && offset - skipped >= liveRows(chunk) && (!plan || mustMatch(plan, statsOf(chunk), chunk.rowCount))) {
          skipped += liveRows(chunk);
          continue;
        }
        const rows = [];
        for await (const row of matches(filter, { select }, null, { plan, runs: [runs[i]], rowIds })) rows.push(row);
        for (let k = rows.length - 1; k >= 0 && yielded < limit; k--) {
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yielded++;
          yield rows[k];
        }
      }
      if (runs.length) onProgress?.({ done: runs.length, total: runs.length, matches: skipped + yielded });
    }

    /**
     * How a filtered query decodes, as the library's reader: the filter's columns first - a nested column the rows
     * don't return with only the fields the filter reads - and the columns the rows return only for chunks with
     * matching rows. `returned`: positions of the columns rows return (null: none, as for counting).
     */
    function filterDecoding(plan, returned) {
      const filterCols = [...planColumns(plan)];
      const filterWanted = Array.from({ length: table.columnCount }, (_, c) => filterCols.includes(c));
      const restWanted = Array.from({ length: table.columnCount }, (_, c) => !filterWanted[c] && Boolean(returned?.includes(c)));
      const types = new Array(table.columnCount).fill(null);
      for (const c of filterCols) if (isNested(columns[c].type) && !returned?.includes(c)) types[c] = filterReads(columns[c], plan);
      return { filterCols, filterWanted, restWanted, anyRest: restWanted.includes(true), types };
    }

    /**
     * The filter's matches in one chunk: positions of its rows (deleted ones left out) that `match` accepts, checked on
     * one object holding the filter's columns of a row, filled again for each row.
     */
    function chunkHits(chunk, values, filterCols, match, probe, rowIds, from, to) {
      const hits = [];
      const count = rowIds === null ? chunk.rowCount : to - from;
      for (let k = 0; k < count; k++) {
        const r = rowIds === null ? k : rowIds[from + k] - chunk.rowStart;
        if (deletedSet.has(chunk.rowStart + r)) continue;
        for (const c of filterCols) setField(probe, columns[c].name, values[c][r]);
        if (match(probe)) hits.push(r);
      }
      return hits;
    }

    /** Rows matching a filter (see matches), decoded as filterDecoding says. */
    async function* filtered(match, plan, runs, rowIds, { offset, limit, select, signal, onProgress }, sink) {
      const returned = select ? select.map((name) => planColumnsList.find((c) => c.name === name).position) : planColumnsList.map((c) => c.position);
      const { filterCols, filterWanted, restWanted, anyRest, types } = filterDecoding(plan, returned);
      const probe = {};
      let skipped = 0;
      let yielded = 0;
      for (let run = 0; run < runs.length; run++) {
        if (run) onProgress?.({ done: run, total: runs.length, matches: skipped + yielded });
        signal?.throwIfAborted();
        const { chunk, from, to } = runs[run];
        if (yielded >= limit) return;
        // Chunks wholly before the offset whose every row matches are counted, not read.
        if (rowIds === null && skipped < offset && offset - skipped >= liveRows(chunk) && mustMatch(plan, statsOf(chunk), chunk.rowCount)) {
          skipped += liveRows(chunk);
          continue;
        }
        const read = { raws: new Map(), counted: false }; // the chunk's sections, read once for both passes
        const few = chunk.rowCount * FEW_ROWS;
        let values;
        let hits;
        let aligned = false; // values hold one value per hit, not one per row
        if (rowIds !== null && to - from <= few) {
          // A few index candidates: only their values of the filter's columns are decoded.
          const positions = [];
          for (let k = from; k < to; k++) if (!deletedSet.has(rowIds[k])) positions.push(rowIds[k] - chunk.rowStart);
          ({ values } = await chunkColumns(chunk, filterWanted, false, types, read, null, positions));
          hits = [];
          const kept = [];
          for (let k = 0; k < positions.length; k++) {
            for (const c of filterCols) setField(probe, columns[c].name, values[c][k]);
            if (!match(probe)) continue;
            hits.push(positions[k]);
            kept.push(k);
          }
          for (const c of filterCols) values[c] = kept.map((k) => values[c][k]);
          aligned = true;
        } else {
          ({ values } = await chunkColumns(chunk, filterWanted, false, types, read));
          hits = chunkHits(chunk, values, filterCols, match, probe, rowIds, from, to);
          if (hits.length <= few) {
            for (const c of filterCols) values[c] = hits.map((r) => values[c][r]);
            aligned = true;
          }
        }
        if (!hits.length) continue;
        if (anyRest && aligned) {
          // Few rows match: the returned columns are decoded for them alone (the values between them are passed over).
          const more = await chunkColumns(chunk, restWanted, false, null, read, null, hits);
          for (let c = 0; c < table.columnCount; c++) if (restWanted[c]) values[c] = more.values[c];
        } else if (anyRest) {
          // The returned columns' text, decimal, json and binary values are made only for the matching rows.
          const matching = new Uint8Array(chunk.rowCount);
          for (const r of hits) matching[r] = 1;
          const more = await chunkColumns(chunk, restWanted, false, null, read, matching);
          for (let c = 0; c < table.columnCount; c++) if (restWanted[c]) values[c] = more.values[c];
        }
        for (let h = 0; h < hits.length; h++) {
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yielded++;
          const i = aligned ? h : hits[h];
          if (sink) sink(values, i, i + 1);
          else {
            const row = {};
            for (const c of returned) setField(row, columns[c].name, values[c][i]);
            yield row;
          }
          if (yielded >= limit) return;
        }
      }
      if (runs.length) onProgress?.({ done: runs.length, total: runs.length, matches: skipped + yielded });
    }

    // Embedded files this key can see (spec 6.8): directories merged by path.
    let fileIndex = null;
    let shapeList = null; // saved shapes this key can use, worked out once
    async function files() {
      if (fileIndex) return fileIndex;
      const entries = new Map();
      const contents = new Map();
      const shapes = new Map();
      const locks = new Map(); // id -> { id, kind, salt, iterations, keys: Map(content id -> sealed key) }
      const member = header.files;
      if (member) {
        const suffix = member.segment ? `/${member.segment}` : '';
        for (const dir of member.directories) {
          let sectionId;
          let key;
          if (!access) {
            sectionId = `files/dir${suffix}`;
            key = await file.key(sectionId, null, 'files');
          } else {
            const secret = access.isOwner ? await hkdf(access.owner, file.salt, `JAZMIN/1/file-group/${dir.group}`) : access.files.get(dir.group);
            if (!secret) continue; // a group this key does not see
            sectionId = `files/dir/${dir.group}${suffix}`;
            key = await hkdf(secret, file.salt, `JAZMIN/1/${sectionId}`);
          }
          const directory = checkFileDirectory(parseJson(fromUtf8.decode(await file.section(dir.section, sectionId, key, { requireDigest })), 'An embedded-file directory', true));
          for (const c of directory.contents) contents.set(c.id, c);
          for (const l of directory.locks ?? []) {
            if (!locks.has(l.id)) {
              locks.set(l.id, { id: l.id, kind: l.kind, salt: base64ToBytes(l.salt), iterations: l.iterations, keys: new Map(), keyService: keyServiceAddress(l.keyService) });
            }
            const lock = locks.get(l.id);
            for (const [id, sealed] of Object.entries(l.keys)) if (!lock.keys.has(id)) lock.keys.set(id, sealed);
          }
          for (const f of directory.files) {
            const known = entries.get(f.path);
            const page = access ? pageOf(f.page) : undefined; // a page only this group's keys know of (spec 6.8)
            // Seen through several groups: an action is allowed when any of them allows it.
            if (known) {
              known.actions = mergeActions(known.actions, fileActions(f.actions));
              if (page && !known.page) known.page = page;
            } else {
              entries.set(f.path, { path: f.path, type: f.type, content: f.content, actions: fileActions(f.actions), ...(page ? { page } : {}) });
            }
          }
          for (const s of directoryShapes(directory)) {
            if (shapes.has(s.name)) continue;
            shapes.set(s.name, {
              name: s.name, ...(s.description ? { description: s.description } : {}), ...(s.default ? { default: true } : {}),
              ...(s.table === undefined ? {} : { table: s.table }), ...(s.groups ? { groups: s.groups.includes('*') ? ['*'] : s.groups } : {}), shape: s.shape,
            });
          }
        }
        for (const e of entries.values()) if (!contents.has(e.content)) throw new JazminFormatError(`Embedded file '${e.path}' refers to missing content`);
      }
      // The key service of the file's online locks that don't name their own (spec 6.8.2).
      let keyService;
      try {
        keyService = member?.package ? keyServiceAddress(JSON.parse(member.package)?.keyService) : undefined;
      } catch {
        keyService = undefined;
      }
      return (fileIndex = { entries, contents, shapes, locks, contentKeys: new Map(), keyService });
    }

    // Locks opened, with every table of this file: id -> lock key. The browser never holds a shared file's owner key.
    file.unlocked ??= new Map();

    // A lock, from the file directories (stored files) or the key slot's masked columns (spec 7.6.8).
    const lockRecord = (locks, id) => locks.get(id) ?? access?.masks.locks.get(id);

    // Where an online lock's unlock token comes from (spec 6.8.2): the lock's own key service, else the file's.
    const lockInfo = ({ locks, keyService }, id) => {
      const lock = lockRecord(locks, id);
      const service = lock && lock.kind !== 'password' ? lock.keyService ?? keyService : undefined;
      return { id, ...(lock ? { kind: lock.kind } : {}), unlocked: file.unlocked.has(id), ...(service ? { keyService: service } : {}) };
    };

    /** A stored content's key: from its directory, or (locked) unsealed with its lock's key; throws while locked. */
    async function contentKey(content, path) {
      if (content.lock === undefined) {
        if (!content.key && (file.keys || access)) throw new JazminFormatError(`Embedded content ${content.id} has no key in an encrypted file`);
        return content.key ? base64ToBytes(content.key) : null;
      }
      const index = await files();
      if (index.contentKeys.has(content.id)) return index.contentKeys.get(content.id);
      const lock = index.locks.get(content.lock);
      if (!lock) {
        throw new JazminFormatError(`File '${path}' names lock '${content.lock}', which the file no longer has: its key is lost `
          + '(a JAZMIN library older than 1.7 may have appended to the file)');
      }
      const key = file.unlocked.get(content.lock);
      if (!key) throw new JazminFileLockedError(`File '${path}' is locked (lock '${content.lock}'): unlock it with ${lockNeeds(lock.kind)}`, path, content.lock, lock.kind);
      const sealed = lock.keys.get(String(content.id));
      if (sealed === undefined) throw new JazminFormatError(`Embedded content ${content.id} has no key for lock '${content.lock}'`);
      const opened = await decrypt(key, base64ToBytes(sealed), sealAad(content.lock, content.id));
      index.contentKeys.set(content.id, opened);
      return opened;
    }

    async function block(content, b, contentKeyBytes) {
      const ref = content.blocks[b];
      const sectionId = `file/${content.id}/${b}`;
      const key = contentKeyBytes ? await hkdf(contentKeyBytes, file.salt, `JAZMIN/1/${sectionId}`) : null;
      const bytes = await file.section({ offset: ref.offset, length: ref.length, digest: ref.digest ? base64ToBytes(ref.digest) : null }, sectionId, key, { requireDigest });
      if (bytes.length !== Math.min(content.blockSize, content.size - b * content.blockSize)) {
        throw new JazminFormatError(`Section '${sectionId}' has the wrong length for its embedded file`);
      }
      return bytes;
    }

    // A file whose grants limit what keys send back stores the document's edit settings as editByKey (spec 7.9.1).
    const storedPackage = header.files?.package ? parseJson(header.files.package, 'Package settings', true) : undefined;
    const settings = storedPackage?.editByKey === undefined ? storedPackage
      : (({ editByKey, ...rest }) => (rest.edit === undefined ? { ...rest, edit: editByKey } : rest))(storedPackage);
    const limitsFile = header.writerFeatures.includes('edit-limits') || storedPackage?.editByKey !== undefined;
    const ownLimit = access && !access.isOwner ? readEditLimit(access.editLimit, limitsFile) : null;
    const editTable = settings?.edit ? settings.edit.table ?? header.tables[0]?.name : null;
    const edit = !editSettings(settings?.edit) ? null : !access || access.isOwner ? settings.edit
      : effectiveEdit(settings.edit, ownLimit.edit, editTable === table.name ? new Set(visibleColumns.map((c) => c.name)) : null, ownLimit.lost);

    return {
      /** Names of the file's tables, in order. */
      tables: header.tables.map((t) => t.name),
      /** Name of this table. */
      table: table.name,
      columns: visibleColumns,
      metadata: file.metadata,
      sortedBy: table.sortedBy.length ? [...table.sortedBy] : undefined,
      /** The whole order when a key compares text another way (spec 6.7): [{ column, nocase?, natural? }]; else undefined. */
      sort: table.sort.length ? table.sort.map((k) => ({ ...k })) : undefined,
      /** Rows this key can read (deleted rows left out). */
      rowCount: visibleRows,
      /** Rows of this table this key may not see. */
      hiddenRowCount: Math.max(0, hiddenRows),
      encrypted: Boolean(file.keys || access),
      /** The file's id (hex), as the library's reader.fileId; a rewrite gives the file a new one. */
      fileId: toHex(file.fileId),
      /** Appends since the file was last written in full. */
      appendCount: header.appendCount,
      /** When the file was last written (its last append, or when it was created), by the writer's clock. */
      writtenAt: new Date(header.modified || header.created),
      /** The reader features the file needs (spec 3.2), as the library's reader.readerFeatures. */
      readerFeatures: [...header.readerFeatures],
      access: access ? {
        isOwner: access.isOwner, ...(access.isOwner ? {} : { keyId: access.keyId }), online: access.online, expires: access.expires, partitionBy: table.partitionBy || null,
        ...(ownLimit?.edit ? { edit: ownLimit.edit } : {}), ...(ownLimit?.lost ? { editLost: true } : {}), // what this key may send back (7.9.1)
      } : null,
      /**
       * The submission key (spec 7.8), as key text: lock the files you send back to the owner with it, for example
       * with JazminBrowser.write(rows, { columns, key: reader.submissionKey }). Null for files written before
       * submission keys existed, until the owner's next rewrite.
       */
      submissionKey: access?.submission ?? null,
      package: settings,
      /**
       * What this key may send back through the document now (spec 7.9.1): package.edit narrowed by the key's limit and,
       * when the document edits this table, by the columns the key sees; null when the document takes no changes.
       */
      edit,
      /** Another table of the same file (the file is not read again). */
      openTable: (tableName) => openTable(file, tableName, true),
      /**
       * Rows matching a filter (spec 9), chunk by chunk. options: { offset, limit, select, reverse } (reverse: last row
       * first, as fast as first first), and for long reads { signal, onProgress } (see count). Chunk statistics, the sort
       * order and indexes decide which chunks are read, as in the library.
       */
      find(filter, options) {
        return matches(filter, options);
      },
      /**
       * A page of rows as an array, in file order: { rows, total }. `total` counts every match (chunks whose every
       * row matches are counted without reading them); pass { total: false } to read only the page. { signal,
       * onProgress } as for count, for the search and then the count.
       */
      async query(filter, { offset = 0, limit = 100, select, total = true, signal, onProgress, reverse = false } = {}) {
        const rows = [];
        for await (const row of matches(filter, { offset, limit, select, signal, onProgress, reverse })) rows.push(row);
        return total ? { rows, total: await this.count(filter, { signal, onProgress }) } : { rows };
      },
      /**
       * Column values as arrays, for charts and totals, as the library's columnArrays(): { rowCount, values, nulls }.
       * Numbers and dates (milliseconds) in a Float64Array, bools in a Uint8Array (1 = true), other types in plain
       * arrays. Null rows of typed arrays hold NaN (0 for bools), with their bit (i & 7 of byte i >> 3) set in
       * nulls[column]. Far less memory than an object per row: 200,000 rows of a date and an amount take 3.2 MB.
       */
      async columnArrays(filter, { select, offset, limit } = {}) {
        const names = select ?? visibleColumns.map((c) => c.name);
        const collectors = names.map((name) => columnCollector(visibleColumns.find((c) => c.name === name) ?? { name }));
        const positions = names.map((name) => columns.findIndex((c) => c?.name === name));
        let rowCount = 0;
        // Values go from the decoded columns straight into the arrays: no object per row.
        const sink = (values, from, to) => {
          for (let i = 0; i < positions.length; i++) collectors[i].add(values[positions[i]], from, to);
          rowCount += to - from;
        };
        for await (const _ of matches(filter, { select: names, offset, limit }, sink)); // eslint-disable-line no-unused-vars
        const values = {};
        const nulls = {};
        names.forEach((name, i) => {
          const column = collectors[i].finish();
          setField(values, name, column.values);
          if (column.nulls) setField(nulls, name, column.nulls);
        });
        return { rowCount, values, nulls };
      },
      /**
       * Rows matching a filter. When sorted indexes answer it exactly, their row count is the answer; otherwise chunks
       * whose every row matches are counted by their row count, without reading them. For long counts:
       * { onProgress(p) } is called after each chunk with p = { done, total, matches }: chunks done and to do, and
       * matches so far; { signal } (an AbortSignal) stops it, rejecting with the signal's reason (an AbortError).
       */
      async count(filter, { signal, onProgress } = {}) {
        signal?.throwIfAborted();
        if (!filter) return visibleRows;
        const match = compileFilter(filter, visibleColumns);
        const plan = planOf(filter, planColumnsList);
        const { runs, rowIds } = await route(plan);
        if (rowIds !== null && answeredExactly(plan)) return rowIds.filter((id) => !deletedSet.has(id)).length;
        // Only the filter's columns are decoded: nested ones with only the fields it reads.
        const { filterCols, filterWanted, types } = filterDecoding(plan, null);
        const probe = {};
        let n = 0;
        // Every chunk a count reads is read: a batch of the next ones (up to MERGE_SPAN bytes or PARALLEL_SECTIONS
        // chunks) is read together (readSections) and decoded a few at a time, then checked in order.
        const whole = runs.map(({ chunk }) => rowIds === null && mustMatch(plan, statsOf(chunk), chunk.rowCount));
        const groupsRead = groups.map((group) => group.visible && group.cols.length > 0 && group.cols.some((c) => filterWanted[c]));
        const partsOf = (r) => groupsRead.map((wanted, g) => (wanted ? runs[r].chunk.parts[g] : null));
        const ahead = new Map();
        let started = 0;
        const readAhead = () => {
          const batch = [];
          let bytes = 0;
          for (; started < runs.length && batch.length < PARALLEL_SECTIONS; started++) {
            if (whole[started]) continue;
            const length = partsOf(started).reduce((n, ref) => n + (ref?.length ?? 0), 0);
            if (batch.length && bytes + length > MERGE_SPAN) break;
            batch.push(started);
            bytes += length;
          }
          const stored = file.readSections(batch.flatMap(partsOf)).catch(() => []); // a read that fails is tried again by each chunk alone
          batch.forEach((r, b) => {
            const reading = stored.then((all) => file.gate(() => chunkColumns(runs[r].chunk, filterWanted, false, types, {
              raws: new Map(), stored: new Map(groupsRead.map((wanted, g) => [g, all[b * groupsRead.length + g] ?? null])), counted: false,
            })));
            reading.catch(() => {}); // a read left unused when the count stops or fails
            ahead.set(r, reading);
          });
        };
        for (let i = 0; i < runs.length; i++) {
          if (i) onProgress?.({ done: i, total: runs.length, matches: n });
          signal?.throwIfAborted();
          const { chunk, from, to } = runs[i];
          if (whole[i]) {
            n += liveRows(chunk);
            continue;
          }
          if (!ahead.has(i)) readAhead();
          const { values } = await ahead.get(i);
          ahead.delete(i);
          n += chunkHits(chunk, values, filterCols, match, probe, rowIds, from, to).length;
        }
        if (runs.length) onProgress?.({ done: runs.length, total: runs.length, matches: n });
        return n;
      },
      /**
       * What a read would cost, before it runs, as the library's estimate(): the chunks, rows and stored bytes find()
       * reads at most ({ chunks, rows, bytes }), and those count() reads ({ countChunks, countRows, countBytes }: 0 when
       * indexes or statistics answer it). From chunk directories, statistics and indexes only: no row is read.
       * { offset } as find()'s: leading chunks it skips whole are counted, not read.
       */
      async estimate(filter, { offset = 0 } = {}) {
        if (filter) compileFilter(filter, visibleColumns);
        const plan = planOf(filter, planColumnsList);
        const { runs, rowIds } = await route(plan);
        const counted = !plan || (rowIds !== null && answeredExactly(plan)); // count() needs no chunk
        const whole = (chunk) => !plan || mustMatch(plan, statsOf(chunk), chunk.rowCount);
        const result = { chunks: 0, rows: 0, bytes: 0, countChunks: 0, countRows: 0, countBytes: 0 };
        let skipped = 0;
        for (const { chunk, from, to } of runs) {
          const live = liveRows(chunk);
          const rows = rowIds === null ? live : to - from;
          const first = chunk.parts[0];
          const last = chunk.parts[chunk.parts.length - 1];
          const length = last.offset + last.length - first.offset;
          if (!result.chunks && rowIds === null && offset - skipped >= live && whole(chunk)) skipped += live;
          else {
            result.chunks++;
            result.rows += rows;
            result.bytes += length;
          }
          if (!counted && !(rowIds === null && whole(chunk))) {
            result.countChunks++;
            result.countRows += rows;
            result.countBytes += length;
          }
        }
        return result;
      },
      /**
       * How a filter executes, as the library reports it: { strategy: 'index', candidateRows } or { strategy: 'scan',
       * chunks, chunksSkipped }. With { analyze: true } (and any find() options) it also runs the query and reports
       * rows, bytesRead, chunksRead, indexPagesRead, columnsDecoded and ms. Statistics and indexes already loaded are
       * not read again: analyze on a freshly opened reader to see a query's full cost.
       */
      async explain(filter, { analyze = false, ...options } = {}) {
        if (filter) compileFilter(filter, visibleColumns);
        const describe = async () => {
          const { runs, rowIds } = await route(planOf(filter, planColumnsList));
          return rowIds ? { strategy: 'index', candidateRows: rowIds.length } : { strategy: 'scan', chunks: chunks.length, chunksSkipped: chunks.length - runs.length };
        };
        if (!analyze) return describe();
        const cost = { rows: 0, bytesRead: 0, chunksRead: 0, indexPagesRead: 0, columnsDecoded: 0, ms: 0 };
        const start = performance.now();
        file.cost = cost;
        try {
          for await (const _ of matches(filter, options)) cost.rows++;
        } finally {
          file.cost = null;
        }
        cost.ms = performance.now() - start;
        return { ...(await describe()), ...cost };
      },
      /**
       * Saved export shapes this key can use, by name: [{ name, description?, default?, table?, shape }] (groups too in
       * files that aren't shared), as the library's reader.shapes. Shapes that use a column this key can't see are left
       * out. Use one by name: JazminBrowser.toJSON(reader, { shape: name }).
       */
      async shapes() {
        if (!shapeList) {
          const { shapes } = await files();
          if (shapes.size === 0) return []; // none saved: nothing to check (nor the shapes add-on to load)
          const first = header.tables[0].name;
          const columns = new Map([[table.name, visibleColumns]]);
          for (const s of shapes.values()) {
            for (const name of [s.table ?? first, ...addOn('shapes').shapeTables(s.shape)]) {
              if (!columns.has(name) && header.tables.some((t) => t.name === name)) columns.set(name, (await openTable(file, name)).columns);
            }
          }
          shapeList = [...shapes.values()].filter((s) => {
            const own = columns.get(s.table ?? first);
            if (!own) return false;
            try {
              addOn('shapes').compileShape(own, s.shape, (name) => columns.get(name));
              return true;
            } catch {
              return false;
            }
          }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
        return JSON.parse(JSON.stringify(shapeList));
      },
      /**
       * Embedded files this key can see: [{ path, type, size, sha256, actions?, lock?, page? }] (lock: { id, kind, unlocked };
       * page: a page of the document only some keys know of, spec 6.8).
       */
      async files() {
        const index = await files();
        const { entries, contents } = index;
        return [...entries.values()].map((e) => {
          const c = contents.get(e.content);
          return {
            path: e.path, type: e.type, size: c.size, sha256: c.sha256, ...(e.actions ? { actions: JSON.parse(JSON.stringify(e.actions)) } : {}),
            ...(c.lock !== undefined ? { lock: lockInfo(index, c.lock) } : {}), ...(e.page ? { page: JSON.parse(JSON.stringify(e.page)) } : {}),
          };
        }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      },
      /** Locks of the stored files and masked columns this key can see (spec 6.8.1, 7.6.8): [{ id, kind, unlocked, keyService? }]. */
      async locks() {
        const index = await files();
        return [...new Set([...index.locks.keys(), ...(access?.masks.locks.keys() ?? [])])].sort().map((id) => lockInfo(index, id));
      },
      /**
       * Masked columns of this table (spec 7.6.8): [{ column, type, group, lock: { id, kind, unlocked, keyService? },
       * shown?, unmasked?, at }], as the library's reader.masked. Until its lock is unlocked a masked column isn't in
       * `columns`. `shown` names the column with what its values show; `unmasked`, the column with its values in the rows
       * that aren't masked; `at`, where the column is (or will be, once unlocked) in `columns`, for viewers that show a
       * masked column in its place.
       */
      async masked() {
        if (!access) return [];
        const known = await files();
        return [...access.masks.groups].filter(([, e]) => e.column.table === index).sort(([, a], [, b]) => a.column.position - b.column.position)
          .map(([group, e]) => ({
            column: e.column.name, type: e.column.type, group, lock: lockInfo(known, e.lock),
            ...(e.column.shown ? { shown: e.column.shown } : {}), ...(e.column.unmasked ? { unmasked: e.column.unmasked } : {}),
            at: columns.slice(0, e.column.position).filter(Boolean).length,
          }));
      },
      /**
       * Opens a lock for as long as the file is open: { password }, { unlockToken } (jzf1-..., from the file owner's key
       * service), or both, as its kind needs. A wrong one throws JazminKeyError.
       */
      async unlock(id, { password, unlockToken } = {}) {
        const { locks } = await files();
        const lock = lockRecord(locks, id);
        if (!lock) throw new JazminError(`No lock '${id}' is visible with this key`);
        if ((lock.kind !== 'online' && !password) || (lock.kind !== 'password' && !unlockToken)) throw new JazminError(`Lock '${id}' needs ${lockNeeds(lock.kind)}`);
        if (file.unlocked.has(id)) return;
        if (lock.kind !== 'online' && !(Number.isInteger(lock.iterations) && lock.iterations >= MIN_KDF_ITERATIONS && lock.iterations <= MAX_KDF_ITERATIONS)) {
          throw new JazminFormatError(`Lock '${id}' has an iteration count outside ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
        }
        const secret = lock.kind === 'password' ? null : await parseFileUnlockToken(unlockToken);
        const key = await lockKey(lock, password, secret);
        // Checked by opening what it seals: a stored file's key, or a masked column group's secret (spec 7.6.8).
        const masked = [...(access?.masks.groups ?? [])].filter(([, e]) => e.lock === id);
        const [contentId, sealed] = lock.keys.entries().next().value ?? [];
        if (sealed === undefined && !masked.length) throw new JazminFormatError(`Lock '${id}' has no sealed keys`);
        const opened = new Map();
        try {
          if (sealed !== undefined) await decrypt(key, base64ToBytes(sealed), sealAad(id, contentId));
          for (const [group, e] of masked) opened.set(group, await decrypt(key, base64ToBytes(e.sealed), groupAad(id, group)));
        } catch {
          const what = lock.kind === 'password' ? 'password' : lock.kind === 'online' ? 'unlock token' : 'password or unlock token';
          throw new JazminKeyError(`Wrong ${what} for lock '${id}'`);
        }
        file.unlocked.set(id, key);
        if (!opened.size) return;
        // The masked columns become columns the key sees: every table reader of the file is built again, in place.
        for (const [group, groupSecret] of opened) access.columns.set(group, groupSecret);
        for (const ref of [...file.readers]) {
          const reader = ref.deref();
          if (!reader) file.readers.delete(ref);
          else Object.assign(reader, await tableReader(file, reader.table));
        }
      },
      /** A whole embedded file, checked against its SHA-256. */
      async readFile(path) {
        const { entries, contents } = await files();
        const entry = entries.get(path);
        if (!entry) throw new JazminError(`No file '${path}' is visible with this key`);
        const content = contents.get(entry.content);
        const key = await contentKey(content, path);
        const parts = [];
        for (let b = 0; b < content.blocks.length; b++) parts.push(await block(content, b, key));
        const bytes = concat(...parts);
        if (toHex(await sha256(bytes)) !== content.sha256) throw new JazminFormatError(`File '${path}' does not match its SHA-256`);
        return bytes;
      },
      /** The embedded file as a Blob with its media type. */
      async fileBlob(path) {
        const { entries } = await files();
        const entry = entries.get(path);
        return new Blob([await this.readFile(path)], { type: entry ? entry.type : 'application/octet-stream' });
      },
    };
  }

  // ---- exports: JSON, CSV and XML text, as the library writes them (js/src/formats) ------------------------------

  const EXPORT_TYPES = { json: 'application/json', csv: 'text/csv', xml: 'application/xml' };
  const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  const XML_UNWRITABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

  function bytesToBase64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return global.btoa(bin);
  }

  /** Text form of a non-null value, for CSV and XML (lists and objects, given their column definition, as JSON). */
  function exportText(type, value, column) {
    switch (type) {
      case 'datetime': return value.toISOString();
      case 'binary': return bytesToBase64(value);
      case 'json': return JSON.stringify(value);
      case 'list':
      case 'object': return exportNested(column, value);
      default: return String(value);
    }
  }

  /** JSON literal for a value (exact for int and decimal, which may exceed double precision). */
  function exportJson(type, value, column) {
    if (value === null || value === undefined) return 'null';
    switch (type) {
      case 'int':
      case 'decimal': return String(value);
      case 'float': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
      case 'datetime': return JSON.stringify(value.toISOString());
      case 'binary': return JSON.stringify(bytesToBase64(value));
      case 'list':
      case 'object': return exportNested(column, value);
      default: return JSON.stringify(value);
    }
  }

  /** A list or object value as JSON: every field in position order, nulls written. */
  function exportNested(column, value) {
    if (value === null || value === undefined) return 'null';
    if (column.type === 'list') {
      let out = '[';
      for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + exportJson(column.item.type, value[i], column.item);
      return `${out}]`;
    }
    if (column.type === 'object') {
      let out = '{';
      column.fields.forEach((f, i) => {
        out += `${i ? ',' : ''}${JSON.stringify(f.name)}:${exportJson(f.type, Object.hasOwn(value, f.name) ? value[f.name] : null, f)}`;
      });
      return `${out}}`;
    }
    return exportJson(column.type, value, column);
  }

  const csvQuote = (text, delimiter) => (text === '' || /["\r\n]/.test(text) || text.includes(delimiter) || text.trim() !== text ? `"${text.replace(/"/g, '""')}"` : text);
  function xmlEscape(text) {
    if (XML_UNWRITABLE.test(text)) throw new JazminValidationError('Value contains characters that XML 1.0 cannot represent');
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const xmlElement = (name) => (XML_NAME.test(name) && !/^xml/i.test(name)
    ? { open: `<${name}>`, close: `</${name}>` }
    : { open: `<field name="${xmlEscape(name)}">`, close: '</field>' });

  /**
   * An export's text, piece by piece. options: { filter, select, offset, limit } as for find, the format's own
   * (json: pretty, omitNulls; csv: delimiter, newline; xml: root, row), and { signal, onProgress } for long exports.
   */
  /**
   * Masked columns (spec 7.6.8) as one column each, as viewers show them, for exports (the library's maskedView): null
   * when there are none. A row's value is its unmasked value when it has one, else its value when unlocked and revealed
   * (`reveal`: true, false, or the columns to reveal), else what it shows (its shown column, or •••• with none).
   */
  function maskedView(readerColumns, masks, select, reveal = true) {
    if (!masks.length) return null;
    const revealed = (m) => m.lock.unlocked && (reveal === true || (Array.isArray(reveal) && reveal.includes(m.column)));
    const apart = new Set(masks.flatMap((m) => [m.column, m.shown, m.unmasked]).filter(Boolean));
    const merged = (m) => {
      const own = readerColumns.find((c) => c.name === m.column);
      return revealed(m) && own ? own : { name: m.column, type: revealed(m) ? m.type : 'string', nullable: true };
    };
    const all = [];
    readerColumns.forEach((column, i) => {
      for (const m of masks) if (m.at === i) all.push(merged(m));
      if (!apart.has(column.name)) all.push(column);
    });
    for (const m of masks) if (m.at >= readerColumns.length) all.push(merged(m));
    const columns = select ? all.filter((c) => select.includes(c.name)) : all;
    const shown = masks.filter((m) => columns.some((c) => c.name === m.column));
    const read = select ? [...new Set(columns.flatMap((c) => {
      const m = shown.find((x) => x.column === c.name);
      return m ? [m.lock.unlocked ? m.column : null, m.shown, m.unmasked].filter(Boolean) : [c.name];
    }))] : undefined;
    const text = (value) => (value instanceof Date ? value.toISOString() : String(value));
    const row = (r) => {
      const out = { ...r };
      for (const m of shown) {
        const open = m.unmasked ? r[m.unmasked] ?? null : null;
        const show = revealed(m);
        let value;
        if (open !== null) value = show ? open : text(open); // a row that isn't masked
        else if (show) value = r[m.column] ?? null;
        else if (m.lock.unlocked && (r[m.column] ?? null) === null) value = null;
        else if (m.shown) value = r[m.shown] ?? null;
        else value = '••••';
        out[m.column] = value;
      }
      return out;
    };
    return { columns, select: read, row };
  }

  async function* exportPieces(reader, format, options = {}) {
    if (!EXPORT_TYPES[format]) throw new JazminValidationError(`Unknown export format '${format}'`);
    const { filter, select, limit, offset, signal, onProgress, masked = 'merge', revealMasked = true, ...o } = options;
    if (masked !== 'merge' && masked !== 'raw') throw new JazminValidationError("masked is 'merge' (one column each, the default) or 'raw' (as stored)");
    // Masked columns: one column each, as viewers show them, unless asked for as stored.
    const view = masked === 'merge' && typeof reader.masked === 'function' ? maskedView(reader.columns, await reader.masked(), select, revealMasked) : null;
    const columns = view ? view.columns : select ? reader.columns.filter((c) => select.includes(c.name)) : reader.columns;
    const found = reader.find(filter, { select: view ? view.select : select, limit, offset, signal, onProgress });
    const rows = view ? (async function* () { for await (const r of found) yield view.row(r); }()) : found;
    if (format === 'csv') {
      const delimiter = o.delimiter ?? ',';
      const newline = o.newline ?? '\r\n';
      yield columns.map((c) => csvQuote(c.name, delimiter)).join(delimiter) + newline;
      for await (const row of rows) {
        yield columns.map((c) => {
          const value = row[c.name] ?? null;
          return value === null ? '' : csvQuote(exportText(c.type, value, c), delimiter);
        }).join(delimiter) + newline;
      }
    } else if (format === 'xml') {
      const rowName = o.row ?? 'row';
      const root = o.root ?? 'jazmin';
      const elements = columns.map((c) => xmlElement(c.name));
      yield `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`;
      for await (const row of rows) {
        let out = `  <${rowName}>`;
        columns.forEach((c, i) => {
          const value = row[c.name] ?? null;
          if (value !== null) out += elements[i].open + xmlEscape(exportText(c.type, value, c)) + elements[i].close;
        });
        yield `${out}</${rowName}>\n`;
      }
      yield `</${root}>\n`;
    } else {
      const names = columns.map((c) => JSON.stringify(c.name));
      const nl = o.pretty ? '\n' : '';
      const indent = o.pretty ? '  ' : '';
      const sep = o.pretty ? ': ' : ':';
      yield '[';
      let first = true;
      for await (const row of rows) {
        const fields = [];
        columns.forEach((c, i) => {
          const value = row[c.name] ?? null;
          if (value === null && o.omitNulls) return;
          fields.push(`${names[i]}${sep}${exportJson(c.type, value, c)}`);
        });
        yield `${first ? '' : ','}${nl}${indent}{${fields.join(o.pretty ? ', ' : ',')}}`;
        first = false;
      }
      yield `${first ? '' : nl}]`;
    }
  }

  /**
   * An export, its text given to `put` in pieces. With { shape } (docs/design/export-shapes.md), the shape decides the
   * structure: JSON or XML, filter and the format's options; select, offset and limit belong in the shape.
   */
  async function exportTo(reader, format, options, put) {
    const { shape, ...rest } = options ?? {};
    if (shape === undefined) {
      for await (const piece of exportPieces(reader, format, rest)) put(piece);
      return;
    }
    if (!EXPORT_TYPES[format]) throw new JazminValidationError(`Unknown export format '${format}'`);
    if (rest.select || rest.limit !== undefined || rest.offset !== undefined) throw new JazminValidationError('With a shape, use $rows/$limit in the shape instead of select, limit or offset');
    await addOn('shapes').writeShape(reader, shape, format, rest, put);
  }

  const ENOUGH = Symbol('jazmin.enough');

  /**
   * An export as one string: the library's toJSON / toCSV / toXML text. { maxLength }: stop once the text is that long
   * (a preview: the text is cut there, perhaps within a value).
   */
  async function exportString(reader, format, options) {
    const { maxLength, ...rest } = options ?? {};
    let out = '';
    if (maxLength === undefined) {
      await exportTo(reader, format, rest, (piece) => {
        out += piece;
      });
      return out;
    }
    const enough = new AbortController();
    const outer = rest.signal;
    if (outer?.aborted) enough.abort(outer.reason);
    else outer?.addEventListener('abort', () => enough.abort(outer.reason), { once: true });
    try {
      await exportTo(reader, format, { ...rest, signal: enough.signal }, (piece) => {
        out += piece;
        if (out.length >= maxLength) enough.abort(ENOUGH);
      });
    } catch (error) {
      if (error !== ENOUGH) throw error;
    }
    return out.slice(0, maxLength);
  }

  /** An export as a Blob of its media type, to save or download: built in pieces of about 1 MB, not one string. */
  async function exportBlob(reader, format, options) {
    const parts = [];
    let buffer = '';
    await exportTo(reader, format, options, (piece) => {
      buffer += piece;
      if (buffer.length >= 1 << 20) {
        parts.push(buffer);
        buffer = '';
      }
    });
    if (buffer) parts.push(buffer);
    return new Blob(parts, { type: EXPORT_TYPES[format] });
  }


  // ---- shared with the add-ons: errors and values the writer, shapes and queries all use ----------------------------

  class JazminValidationError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminValidationError';
    }
  }

  const normalizeBigInt = (v) => (v >= -MAX_SAFE_BIG && v <= MAX_SAFE_BIG ? Number(v) : v);

  const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

  function compareDecimalKeys(a, b) {
    const x = a.s < b.s ? a.m * 10n ** BigInt(b.s - a.s) : a.m;
    const y = b.s < a.s ? b.m * 10n ** BigInt(a.s - b.s) : b.m;
    return x < y ? -1 : x > y ? 1 : 0;
  }

  /** A decimal's key form: trailing zeros removed, compared numerically (12.5 and 12.50 are equal). */
  function decimalKeyOf(text) {
    let { m, s } = parseDecimalText(text, 'decimal');
    while (s > 0 && m % 10n === 0n) {
      m /= 10n;
      s--;
    }
    return { m, s };
  }

  function parseDecimalText(value, column) {
    const t = typeof value === 'number' ? String(value) : value;
    const match = typeof t === 'string' ? DECIMAL_TEXT.exec(t) : null;
    if (!match) throw validation(column, `expected a decimal string like '-12.50', got '${value}'`);
    const [, sign, whole, fraction = ''] = match;
    if (fraction.length > 255) throw validation(column, 'more than 255 digits after the point');
    const digits = (whole + fraction).replace(/^0+(?=\d)/, '');
    if (digits.length > 256) throw validation(column, 'more than 256 significant digits');
    const m = BigInt(digits);
    return { m: sign && m !== 0n ? -m : m, s: fraction.length };
  }

  const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

  const validation = (column, message) => new JazminValidationError(`Column '${column}': ${message}`);

  // ---- add-ons (jazmin-browser-shapes.js, -writer.js, -queries.js) ----------------------------------------------
  // The full jazmin-browser.js has them all; with jazmin-browser-core.js, those loaded after it. The core reaches an
  // add-on only through these hooks, which the add-on fills.
  const hooks = {};

  function addOn(name) {
    const found = hooks[name];
    if (!found) throw new JazminError(`This needs jazmin-browser-${name}.js, loaded after jazmin-browser-core.js (or load the full jazmin-browser.js)`);
    return found;
  }

  const API_CORE = {
    open,
    openUrl,
    openScript,
    scriptBytes,
    toJSON: (reader, options) => exportString(reader, 'json', options),
    toCSV: (reader, options) => exportString(reader, 'csv', options),
    toXML: (reader, options) => exportString(reader, 'xml', options),
    exportBlob,
    compileFilter,
    base64ToBytes,
    JazminError,
    JazminFormatError,
    JazminKeyError,
    JazminFileLockedError,
    JazminFileChangedError,
    JazminUnlockRequiredError,
    JazminValidationError,
  };
