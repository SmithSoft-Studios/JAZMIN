// Worker thread for SectionPool: encodes one section per message and answers on its own port.
// Everything the worker allocates is handed to the main thread (and the chunk buffer handed back for reuse),
// so no garbage builds up here: a worker does little JS work, so it would rarely collect it.
import { isMarkedAsUntransferable, parentPort, workerData } from 'node:worker_threads';
import { encodeSectionParts } from './section.js';

const { port, signal, slot } = workerData;
const asBuffer = (bytes) => (bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);

/**
 * Whether a buffer can be handed over rather than copied: not a slice of Node's shared pool, and not marked
 * untransferable (Node 26 marks Buffer.allocUnsafe memory, which Buffer.concat and encryption use).
 */
const transferable = (bytes) => bytes.buffer.byteLength > Buffer.poolSize && !isMarkedAsUntransferable(bytes.buffer);

parentPort.on('message', ({ raw, options, stop }) => {
  if (stop) {
    // The pool is done: everything sent before this message is finished, so the thread ends without being killed
    // mid-compression (forcing that has crashed Node 26 on Windows: "close before init").
    port.close();
    parentPort.close();
    return;
  }
  let reply;
  const transfer = [];
  try {
    const input = asBuffer(raw);
    const { envelope, body } = encodeSectionParts(input, {
      ...options, key: asBuffer(options.key), fileId: asBuffer(options.fileId), outputSize: input.length + 64,
    });
    const stored = body.buffer === raw.buffer; // compression did not help: the body is the input itself
    reply = { envelope, body, raw: stored ? null : raw };
    if (transferable(body)) transfer.push(body.buffer);
    if (!stored && !isMarkedAsUntransferable(raw.buffer)) transfer.push(raw.buffer);
  } catch (error) {
    reply = { error: error?.message ?? String(error), raw };
  }
  try {
    port.postMessage(reply, transfer);
  } catch {
    port.postMessage(reply); // a buffer could not be handed over: copy everything instead (never leave the writer waiting)
  }
  Atomics.add(signal, slot, 1);
  Atomics.notify(signal, slot);
});
