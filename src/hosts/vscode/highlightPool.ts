import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { CodeSource } from '../../core/codePreview.js';
import type { TextMateContributions, TextMateTheme } from './textMateHighlighter.js';

/** What a highlight worker builds its own highlighter from; each worker loads the WASM file and grammars itself. */
export interface HighlightWorkerData { readonly contributions: TextMateContributions; readonly theme: TextMateTheme; readonly wasmPath: string }
/** One request to a worker and its answer, matched by `id`. */
export interface HighlightJob { readonly id: number; readonly sources: readonly CodeSource[] }
export interface HighlightResult { readonly id: number; readonly html: readonly (string | undefined)[] }

type Colored = readonly (string | undefined)[];
interface Task { readonly sources: readonly CodeSource[]; readonly resolve: (html: Colored) => void; readonly reject: (error: Error) => void }

/** More workers color no faster: 235 files took 3484, 2190, 1896, 1767 and 1767 ms with 1, 2, 3, 4 and 6 on a 10-core machine, since each compiles its grammars' patterns itself. */
const maximumWorkers = 4;
/** Idle workers end after this long, since each holds its grammars in memory. */
const idleMs = 30_000;

const ended = new Error('The highlight worker ended.');

/** Tokenizes code on worker threads, so a large diff's colors neither take one core nor block the extension host. */
export class HighlightPool {
  readonly #size = Math.max(1, Math.min(maximumWorkers, availableParallelism() - 1));
  readonly #idle: Worker[] = [];
  readonly #busy = new Map<Worker, Task>();
  readonly #waiting: Task[] = [];
  #jobs = 0;
  #ending: NodeJS.Timeout | undefined;
  #disposed = false;
  /** Set when a worker fails before it colored anything, such as when its file cannot load; no more are started then. */
  #broken: Error | undefined;

  constructor(private readonly workerPath: string, private readonly data: HighlightWorkerData) {}

  /** Color `sources` on the next free worker, in the order asked. */
  run(sources: readonly CodeSource[]): Promise<Colored> {
    return new Promise((resolve, reject) => {
      if (this.#disposed) { reject(new Error('The highlighter was replaced.')); return; }
      if (this.#broken !== undefined) { reject(this.#broken); return; }
      this.#waiting.push({ sources, resolve, reject });
      this.#next();
    });
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#ending);
    for (const worker of [...this.#idle, ...this.#busy.keys()]) void worker.terminate();
    for (const task of [...this.#busy.values(), ...this.#waiting.splice(0)]) task.reject(new Error('The highlighter was replaced.'));
    this.#idle.length = 0;
    this.#busy.clear();
  }

  #next(): void {
    clearTimeout(this.#ending);
    while (this.#waiting.length > 0) {
      const worker = this.#idle.pop() ?? (this.#busy.size < this.#size ? this.#start() : undefined);
      const task = worker === undefined ? undefined : this.#waiting.shift();
      if (worker === undefined || task === undefined) break;
      this.#busy.set(worker, task);
      worker.postMessage({ id: ++this.#jobs, sources: task.sources } satisfies HighlightJob);
    }
    if (this.#busy.size === 0) {
      this.#ending = setTimeout(() => { for (const worker of this.#idle.splice(0)) void worker.terminate(); }, idleMs);
      this.#ending.unref();
    }
  }

  #start(): Worker {
    const worker = new Worker(this.workerPath, { workerData: this.data });
    worker.unref();
    let answered = false;
    worker.on('message', ({ html }: HighlightResult) => {
      answered = true;
      const task = this.#busy.get(worker);
      this.#busy.delete(worker);
      this.#idle.push(worker);
      task?.resolve(html);
      this.#next();
    });
    // A worker that fails leaves its task to the caller, which then colors on its own thread.
    const failed = (error: Error): void => {
      const task = this.#busy.get(worker);
      this.#busy.delete(worker);
      const idle = this.#idle.indexOf(worker);
      if (idle >= 0) this.#idle.splice(idle, 1);
      void worker.terminate();
      task?.reject(error);
      if (this.#disposed) return;
      if (!answered && this.#broken === undefined && error !== ended) {
        this.#broken = error;
        console.warn('DiffGuide colors code on the extension host thread, since its highlight worker failed.', error);
        for (const waiting of this.#waiting.splice(0)) waiting.reject(error);
      }
      this.#next();
    };
    worker.on('error', failed);
    worker.on('exit', () => { failed(ended); });
    return worker;
  }
}
