// Encodes sections (compress, encrypt, checksum) on worker threads while the writer's API stays synchronous:
// results are collected in submission order with receiveMessageOnPort, blocking with Atomics.wait when needed.
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { JazminError } from './errors.js';

const STALL_MS = 120_000; // a worker that has not answered for this long is treated as failed

export class SectionPool {
  #workers = [];
  #signal;
  #next = 0; // worker for the next submission (round robin)
  #queued = []; // worker index of each submission not yet taken, oldest first
  #free = []; // chunk buffers handed back by workers, reused for the next submissions
  #taken; // per worker: results taken so far (the signal counts results posted)

  /** Starts `size` workers; throws if worker threads are unavailable (the caller then encodes inline). */
  constructor(size) {
    this.#signal = new Int32Array(new SharedArrayBuffer(4 * size));
    this.#taken = new Array(size).fill(0);
    for (let i = 0; i < size; i++) {
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(new URL('./section-worker.js', import.meta.url), {
        workerData: { port: port2, signal: this.#signal, slot: i },
        transferList: [port2],
      });
      worker.unref(); // an unfinished writer must not keep the process alive
      this.#workers.push({ worker, port: port1 });
    }
  }

  /** Chunks in flight at most: two per worker keeps every worker busy while bounding memory. */
  get capacity() {
    return this.#workers.length * 2;
  }

  get pending() {
    return this.#queued.length;
  }

  /** Queues `raw` (copied, so the caller may reuse its buffer) for encodeSection(raw, options). */
  submit(raw, options) {
    let buffer = this.#free.pop();
    if (!buffer || buffer.byteLength < raw.length) buffer = new ArrayBuffer(Math.ceil(raw.length * 1.25));
    const copy = new Uint8Array(buffer, 0, raw.length);
    copy.set(raw);
    const w = this.#next;
    this.#next = (w + 1) % this.#workers.length;
    this.#workers[w].worker.postMessage({ raw: copy, options }, [buffer]); // moved to the worker, not copied
    this.#queued.push(w);
  }

  /** Resolves once the oldest submission's result can be taken without blocking (for async writers). */
  async whenReady() {
    const w = this.#queued[0];
    if (w === undefined) return;
    // Workers are unref'd and some Node versions (20) do not count a pending waitAsync as work: without a timer
    // of our own, Node could decide nothing is left to do and exit while we wait.
    const keepAlive = setTimeout(() => {}, 0x7fffffff);
    try {
      for (;;) {
        const posted = Atomics.load(this.#signal, w);
        if (posted > this.#taken[w]) return;
        const { async, value } = Atomics.waitAsync(this.#signal, w, posted, 1000);
        if (async) await value;
      }
    } finally {
      clearTimeout(keepAlive);
    }
  }

  /** The oldest submission's encoded section as { envelope, body } (written one after the other), waiting if needed. */
  take() {
    const w = this.#queued.shift();
    this.#taken[w]++;
    const { port } = this.#workers[w];
    let waited = 0;
    for (;;) {
      const seen = Atomics.load(this.#signal, w);
      const received = receiveMessageOnPort(port);
      if (received) {
        const { envelope, body, raw, error } = received.message;
        if (raw && this.#free.length < this.capacity) this.#free.push(raw.buffer);
        if (error) throw new JazminError(`Encoding a section failed: ${error}`);
        return { envelope: Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength), body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
      }
      if (Atomics.wait(this.#signal, w, seen, 1000) === 'timed-out' && (waited += 1000) >= STALL_MS) {
        throw new JazminError('A compression worker stopped responding');
      }
    }
  }

  close() {
    for (const { worker, port } of this.#workers) {
      port.close();
      worker.terminate();
    }
    this.#workers = [];
    this.#queued = [];
    this.#free = [];
  }
}
