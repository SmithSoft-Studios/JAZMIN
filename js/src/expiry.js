// Time-limited access (spec section 7.7): expiry parsing, the clock floor and the per-user
// "last seen" record that detects a clock being set back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JazminAccessExpiredError, JazminValidationError } from './errors.js';
import { hkdf } from './keys.js';

/** Allowed clock disagreement before a time check fails. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Milliseconds since the epoch for a Date, ISO string or number (ms); `now()` when omitted. */
export function toMs(value, what = 'time') {
  if (value === undefined || value === null) return Date.now();
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) throw new JazminValidationError(`Invalid ${what} '${value}'`);
  return ms;
}

/**
 * Absolute expiry (ms) of a grant: `expires` (Date / ISO / ms) or `expiresIn` relative to `now`
 * ('90s', '30m', '2h', '14d', '2w', '5y' or a number of ms). Years are calendar years.
 * Returns undefined for grants that never expire.
 */
export function grantExpiry(grant, now) {
  if (grant.expires !== undefined && grant.expires !== null) return toMs(grant.expires, 'expires');
  const span = grant.expiresIn;
  if (span === undefined || span === null) return undefined;
  if (typeof span === 'number' && span > 0) return now + span;
  const match = /^(\d+)\s*(s|m|h|d|w|y)$/.exec(String(span).trim());
  if (!match) throw new JazminValidationError(`Invalid expiresIn '${span}' (use e.g. '2h', '14d' or '5y')`);
  const amount = Number(match[1]);
  if (match[2] === 'y') {
    const date = new Date(now);
    date.setUTCFullYear(date.getUTCFullYear() + amount);
    return date.getTime();
  }
  return now + amount * UNIT_MS[match[2]];
}

export function defaultStateDir() {
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Jazmin', 'access-state')
    : path.join(os.homedir(), '.jazmin', 'access-state');
}

function directoryStore(dir) {
  return {
    read(name) {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write(name, text) {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, target);
    },
  };
}

/**
 * Enforces an expiring grant when a file is opened:
 *  1. not after `expires`;
 *  2. the clock is not earlier than when the (signed) file was written;
 *  3. the clock is not earlier than the last time this key opened this file on this machine.
 * The last-seen time is kept per user (not in the file, which the user could swap for an older
 * copy). It carries an HMAC keyed by the access key, so casual edits are detected.
 *
 * `state`: undefined (default directory), { dir }, a custom store { read(name), write(name, text) },
 * or false to skip check 3.
 */
export function enforceExpiry({ expires, writtenAt, now, fileId, keyId, secret, state }) {
  if (now > expires) throw new JazminAccessExpiredError(`Access for this key expired at ${new Date(expires).toISOString()}`);
  if (now < writtenAt - CLOCK_TOLERANCE_MS) {
    throw new JazminAccessExpiredError(`The system clock (${new Date(now).toISOString()}) is earlier than when this file was written `
      + `(${new Date(writtenAt).toISOString()}) - check the clock`);
  }
  if (state === false) return;
  const store = typeof state?.read === 'function' ? state : directoryStore(state?.dir ?? defaultStateDir());
  const name = `${fileId.toString('hex')}.${keyId}.json`;
  const macKey = hkdf(secret, fileId, 'JAZMIN/1/last-seen');
  const mac = (t) => crypto.createHmac('sha256', macKey).update(String(t)).digest('hex');

  let lastSeen = 0;
  const text = store.read(name);
  if (text !== undefined) {
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    if (!record || !Number.isFinite(record.lastSeen) || record.mac !== mac(record.lastSeen)) {
      throw new JazminAccessExpiredError('The access record for this file was modified - access refused');
    }
    lastSeen = record.lastSeen;
  }
  if (now < lastSeen - CLOCK_TOLERANCE_MS) {
    throw new JazminAccessExpiredError(`Clock rollback detected: the system clock (${new Date(now).toISOString()}) is earlier than `
      + `this key's last access (${new Date(lastSeen).toISOString()})`);
  }
  if (now > lastSeen) store.write(name, JSON.stringify({ lastSeen: now, mac: mac(now) }));
}
