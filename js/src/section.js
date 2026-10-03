import zlib from 'node:zlib';
import { crc32 } from './binary.js';
import { CODEC, ENVELOPE_SIZE, SECTION_ENCRYPTED } from './constants.js';
import { JazminFormatError, JazminKeyError, JazminValidationError } from './errors.js';
import { decrypt, encrypt } from './keys.js';

const MAX_SECTION = 0xffffffff;
const MAX_PREALLOCATE = 64 * 1024 * 1024; // a damaged length cannot reserve more than this up front

function compress(codecId, raw, level, outputSize) {
  // outputSize: one output buffer of that size instead of 16 KB pieces joined into a copy (same bytes).
  const size = outputSize ? { chunkSize: Math.max(outputSize, 64) } : {};
  switch (codecId) {
    case CODEC.none:
      return raw;
    case CODEC.deflate:
      return zlib.deflateRawSync(raw, { level: level ?? 6, ...size });
    case CODEC.brotli:
      return zlib.brotliCompressSync(raw, {
        ...size,
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: level ?? 6,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      });
    default:
      throw new JazminValidationError(`Unknown codec id ${codecId}`);
  }
}

function decompress(codecId, body, rawLength) {
  // One output buffer of the known size: no 16 KB pieces joined into a second copy (less garbage, faster). Output
  // beyond the declared length stops decompression, so a damaged length or payload cannot exhaust memory.
  const options = { chunkSize: Math.max(Math.min(rawLength + 1, MAX_PREALLOCATE), 64), maxOutputLength: Math.max(rawLength, 1) };
  switch (codecId) {
    case CODEC.none: return body;
    case CODEC.deflate: return zlib.inflateRawSync(body, options);
    case CODEC.brotli: return zlib.brotliDecompressSync(body, options);
    default: throw new JazminFormatError(`Unsupported codec id ${codecId}`);
  }
}

function aad(fileId, envelope, sectionId) {
  return Buffer.concat([fileId, envelope.subarray(0, 8), Buffer.from(sectionId, 'utf8')]);
}

/**
 * Builds one section: 16-byte envelope + payload.
 * Pipeline: raw -> compress -> (encrypt) -> CRC-32.
 */
export function encodeSection(raw, options) {
  const { envelope, body } = encodeSectionParts(raw, options);
  return Buffer.concat([envelope, body]);
}

/**
 * encodeSection without joining the parts: the section is `envelope` followed by `body`. `body` is `raw`
 * itself when compression did not help. `outputSize` sizes the compressor's single output buffer.
 */
export function encodeSectionParts(raw, { codec = 'deflate', level, key, fileId, sectionId, outputSize }) {
  let codecId = CODEC[codec];
  if (codecId === undefined) throw new JazminValidationError(`Unknown codec '${codec}'`);
  if (raw.length > MAX_SECTION) throw new JazminValidationError('Section exceeds 4 GiB');

  let body = compress(codecId, raw, level, outputSize);
  if (body.length >= raw.length) {
    codecId = CODEC.none; // compression did not help - store as-is
    body = raw;
  }

  const envelope = Buffer.alloc(ENVELOPE_SIZE);
  envelope[0] = codecId;
  envelope[1] = key ? SECTION_ENCRYPTED : 0;
  envelope.writeUInt32LE(raw.length, 4);
  if (key) body = encrypt(key, body, aad(fileId, envelope, sectionId));
  envelope.writeUInt32LE(body.length, 8);
  envelope.writeUInt32LE(crc32(body), 12);
  return { envelope, body };
}

/** Reads the payload length declared by an envelope. */
export function sectionPayloadLength(envelope) {
  return envelope.readUInt32LE(8);
}

/** Verifies, decrypts and decompresses a section (envelope + payload). */
export function decodeSection(section, { key, fileId, sectionId }) {
  if (section.length < ENVELOPE_SIZE) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
  const envelope = section.subarray(0, ENVELOPE_SIZE);
  const codecId = envelope[0];
  const encrypted = (envelope[1] & SECTION_ENCRYPTED) !== 0;
  const rawLength = envelope.readUInt32LE(4);
  const payloadLength = envelope.readUInt32LE(8);
  let body = section.subarray(ENVELOPE_SIZE, ENVELOPE_SIZE + payloadLength);
  if (body.length !== payloadLength) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
  if (crc32(body) !== envelope.readUInt32LE(12)) throw new JazminFormatError(`Section '${sectionId}' failed its CRC-32 check`);

  if (key && !encrypted) {
    // Prevents a downgrade attack where an encrypted section is swapped for a plaintext one.
    throw new JazminFormatError(`Section '${sectionId}' is not encrypted but the file is`);
  }
  if (encrypted) {
    if (!key) throw new JazminKeyError('This file is encrypted - supply a key or password');
    body = decrypt(key, body, aad(fileId, envelope, sectionId));
  }
  let raw;
  try {
    raw = decompress(codecId, body, rawLength);
  } catch (error) {
    if (error instanceof JazminFormatError) throw error;
    throw new JazminFormatError(`Section '${sectionId}' could not be decompressed`);
  }
  if (raw.length !== rawLength) throw new JazminFormatError(`Section '${sectionId}' has the wrong decompressed length`);
  return raw;
}
