/** Calls of the returned function in one event-loop turn share one `load`; requests sent at the same moment read the same state. */
export function sharedPerTurn<T>(load: () => T): () => T {
  let shared: { readonly value: T } | undefined;
  return () => {
    if (shared === undefined) {
      shared = { value: load() };
      setImmediate(() => { shared = undefined; });
    }
    return shared.value;
  };
}

/** Values the user just wrote to GitHub, laid over reads until GitHub reports them, since its reads can lag behind its writes. */
export class PendingWrites {
  readonly #pending = new Map<string, { readonly value: unknown; readonly until: number }>();

  constructor(private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}

  /** Show `key` as `value` until GitHub reads the same or `ttlMs` passes. */
  expect(key: string, value: boolean | string): void {
    this.#pending.set(key, { value, until: this.now() + this.ttlMs });
  }

  /** The written value while GitHub still reads an older one; otherwise what GitHub read. */
  apply<V extends boolean | string>(key: string, read: V): V {
    const pending = this.#pending.get(key);
    if (pending === undefined) return read;
    if (pending.value === read || this.now() > pending.until) {
      this.#pending.delete(key);
      return read;
    }
    return pending.value as V;
  }

  /** Some write is not on GitHub yet. */
  get waiting(): boolean {
    for (const [key, { until }] of this.#pending) if (this.now() > until) this.#pending.delete(key);
    return this.#pending.size > 0;
  }
}
