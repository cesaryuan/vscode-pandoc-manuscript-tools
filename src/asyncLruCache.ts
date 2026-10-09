/** Bounds shared asynchronous work by entry count and retained string size. */
export class AsyncLruCache<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; weight: number }>();
  private weight = 0;

  /** Includes keys in the budget because translation keys retain the source paragraph. */
  constructor(private readonly maxEntries: number, private readonly maxCharacters: number,
    private readonly measure: (value: T) => number) {}

  /** Reuses pending work, refreshes recency, and forgets failed or unavailable results. */
  getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }
    const entry = { promise: undefined as Promise<T>, weight: key.length };
    entry.promise = Promise.resolve().then(create).then((value) => {
      // An evicted in-flight request must not reinsert itself or evict newer work.
      if (this.entries.get(key) === entry) {
        if (value === undefined) this.delete(key);
        else {
          const measured = key.length + this.measure(value);
          this.weight += measured - entry.weight;
          entry.weight = measured;
          this.trim();
        }
      }
      return value;
    }, (error) => {
      if (this.entries.get(key) === entry) this.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    this.weight += entry.weight;
    this.trim();
    return entry.promise;
  }

  /** Removes obsolete image versions without retaining a separate path index. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) this.delete(key);
    }
  }

  /** Releases retained results; pending callers still receive their original promises. */
  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }

  /** Removes one entry and its contribution to the storage budget. */
  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.weight -= entry.weight;
      this.entries.delete(key);
    }
  }

  /** Evicts the least recently requested entries until both budgets are satisfied. */
  private trim(): void {
    while (this.entries.size > this.maxEntries || this.weight > this.maxCharacters) {
      this.delete(this.entries.keys().next().value!);
    }
  }
}
