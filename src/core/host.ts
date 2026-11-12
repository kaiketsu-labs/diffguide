/** Durable key-value state the host keeps across restarts. VS Code's `Memento` has this shape. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
