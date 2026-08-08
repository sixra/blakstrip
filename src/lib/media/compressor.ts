/**
 * The main-thread half of compression: owns the worker, matches replies to
 * requests, and throws the whole thing away when a file is done with.
 *
 * Kept separate from the Svelte island so the behaviour that is easy to get
 * wrong (superseding, teardown, a worker that dies mid-job) can be tested
 * directly rather than through a component.
 */
import type {
  CompressOptions,
  CompressRequest,
  CompressResponse,
  CompressSuccess,
} from './compress';
import type { MediaFormat } from './index';

/**
 * Raised on a request that a newer one replaced before it finished.
 *
 * Its own type so the caller can drop it silently. Dragging a quality slider
 * produces a stream of these by design, and showing "compression failed" every
 * time someone moves a control would be a bug wearing an error message.
 */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer request');
    this.name = 'SupersededError';
  }
}

interface Waiter {
  resolve: (value: CompressSuccess) => void;
  reject: (reason: Error) => void;
}

export class Compressor {
  #worker: Worker | undefined;
  #waiters = new Map<number, Waiter>();
  #nextId = 1;

  #spawn(): Worker {
    if (this.#worker) return this.#worker;

    // `new URL(..., import.meta.url)` is the form Vite compiles to a real,
    // same-origin worker file. An inline worker would be a blob:, and a blob:
    // worker inherits the page CSP, which has no 'wasm-unsafe-eval': the codecs
    // would fail to compile. See the note in astro.config.mjs.
    const worker = new Worker(new URL('./compress.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<CompressResponse>) => {
      const response = event.data;
      const waiter = this.#waiters.get(response.id);
      if (!waiter) return;
      this.#waiters.delete(response.id);
      if (response.ok) waiter.resolve(response);
      else waiter.reject(new Error(response.message));
    };

    // A worker that dies (an out-of-memory encode of a huge image is the
    // realistic cause) otherwise leaves every caller awaiting forever.
    worker.onerror = () => this.#failAll(new Error('the compressor stopped unexpectedly'));

    this.#worker = worker;
    return worker;
  }

  #failAll(error: Error): void {
    const waiters = [...this.#waiters.values()];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * Compress one image. Any request still in flight is abandoned: the worker
   * handles one job at a time and drops all but the newest waiting one, so
   * resolving the older promises would be a lie about what ran.
   */
  compress(
    bytes: Uint8Array,
    sourceFormat: MediaFormat,
    options: CompressOptions
  ): Promise<CompressSuccess> {
    this.#failAll(new SupersededError());

    const id = this.#nextId++;
    const request: CompressRequest = {
      id,
      bytes,
      sourceFormat,
      // Rebuilt field by field rather than passed through. `postMessage` uses
      // structured clone, which throws `DataCloneError` on a proxy, and a Svelte
      // `$state` object is exactly that: the UI held its options in one and every
      // compress failed with "could not be cloned". Copying the primitives out
      // also means a caller editing its own options object mid-encode cannot
      // change the job already sent.
      options: {
        format: options.format,
        quality: options.quality,
        effort: options.effort,
        maxDimension: options.maxDimension,
      },
    };

    return new Promise<CompressSuccess>((resolve, reject) => {
      this.#waiters.set(id, { resolve, reject });
      // The bytes are copied rather than transferred: the caller keeps the
      // original file to compress again at a different quality, and a
      // transferred buffer would come back detached and zero-length.
      this.#spawn().postMessage(request);
    });
  }

  /**
   * Terminate the worker and reject anything outstanding.
   *
   * Called when the user moves on to another file, not just on unmount. Wasm
   * linear memory never shrinks: after one 50-megapixel photo the worker holds
   * that peak for the life of the tab, and the only way to give it back is to
   * end the worker. A fresh one costs a few milliseconds to start.
   */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#failAll(new SupersededError());
  }
}
