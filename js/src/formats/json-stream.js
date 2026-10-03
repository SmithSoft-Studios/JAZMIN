import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { JazminValidationError } from '../errors.js';

const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const BOM = 0xfeff;

function isWhitespace(ch) {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

/**
 * Streams the objects of a JSON array file (`[{...},{...}]`) or a JSON Lines file
 * (one object per line) without loading the file: memory is one read block plus
 * the object currently being parsed.
 */
export function* readJsonObjects(path, { blockSize = 1 << 20 } = {}) {
  const fd = fs.openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const block = Buffer.allocUnsafe(blockSize);
  let pending = ''; // text of an object that continues into the next block
  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayOpened = false;
  let arrayClosed = false;
  let count = 0;

  const unexpected = (ch) =>
    new JazminValidationError(`Unexpected '${String.fromCharCode(ch)}' after JSON object ${count}`);

  try {
    for (;;) {
      const read = fs.readSync(fd, block, 0, blockSize, null);
      const text = read === 0 ? decoder.end() : decoder.write(block.subarray(0, read));
      let start = depth > 0 ? 0 : -1;
      for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (depth > 0) {
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === BACKSLASH) escaped = true;
            else if (ch === QUOTE) inString = false;
          } else if (ch === QUOTE) {
            inString = true;
          } else if (ch === OPEN_BRACE || ch === OPEN_BRACKET) {
            depth++;
          } else if ((ch === CLOSE_BRACE || ch === CLOSE_BRACKET) && --depth === 0) {
            const json = pending + text.slice(start, i + 1);
            pending = '';
            start = -1;
            let value;
            try {
              value = JSON.parse(json);
            } catch (error) {
              throw new JazminValidationError(`JSON object ${count} is invalid: ${error.message}`);
            }
            count++;
            yield value;
          }
          continue;
        }
        // Between objects
        if (isWhitespace(ch) || ch === COMMA || ch === BOM) continue;
        if (arrayClosed) throw unexpected(ch);
        if (ch === OPEN_BRACE) {
          depth = 1;
          start = i;
        } else if (ch === OPEN_BRACKET && !arrayOpened && count === 0) {
          arrayOpened = true;
        } else if (ch === CLOSE_BRACKET && arrayOpened) {
          arrayClosed = true;
        } else {
          throw unexpected(ch);
        }
      }
      if (depth > 0) pending += text.slice(start);
      if (read === 0) break;
    }
    if (depth > 0) throw new JazminValidationError(`JSON ends inside object ${count}`);
    if (arrayOpened && !arrayClosed) throw new JazminValidationError('JSON array is not closed');
  } finally {
    fs.closeSync(fd);
  }
}
