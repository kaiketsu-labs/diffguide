/** Something to release, such as a subscription. VS Code's `Disposable` has this shape. */
export interface Disposable {
  dispose(): void;
}

/** Subscribe to an event; same call shape as VS Code's `Event`, so either side accepts the other. */
export type Event<T> = (listener: (value: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

/** Host-neutral event source with VS Code `EventEmitter` semantics. */
export class Emitter<T> implements Disposable {
  readonly #listeners = new Set<(value: T) => unknown>();
  #disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const callback = (value: T): unknown => listener.call(thisArgs, value);
    if (!this.#disposed) this.#listeners.add(callback);
    const subscription = { dispose: (): void => { this.#listeners.delete(callback); } };
    disposables?.push(subscription);
    return subscription;
  };

  /** Deliver in registration order; a throwing listener does not stop the others, as in VS Code. */
  fire(value: T): void {
    for (const listener of [...this.#listeners]) {
      try { listener(value); } catch (error) { console.error(error); }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}
