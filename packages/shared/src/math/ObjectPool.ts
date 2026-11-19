/**
 * Fixed-capacity zero-GC object pool.
 * Pre-allocates objects upfront and recycles them with zero heap churn during combat.
 */
export class ObjectPool<T> {
  private readonly items: T[] = [];
  private readonly activeFlags: Uint8Array;
  private _activeCount = 0;

  constructor(
    private readonly capacity: number,
    factory: (index: number) => T,
    private readonly onReset?: (item: T) => void
  ) {
    this.activeFlags = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items.push(factory(i));
    }
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  acquire(): T | null {
    for (let i = 0; i < this.capacity; i++) {
      if (this.activeFlags[i] === 0) {
        this.activeFlags[i] = 1;
        this._activeCount++;
        const item = this.items[i];
        if (this.onReset) {
          this.onReset(item);
        }
        return item;
      }
    }
    return null;
  }

  release(item: T): boolean {
    const idx = this.items.indexOf(item);
    if (idx >= 0 && this.activeFlags[idx] === 1) {
      this.activeFlags[idx] = 0;
      this._activeCount--;
      return true;
    }
    return false;
  }

  releaseAll(): void {
    this.activeFlags.fill(0);
    this._activeCount = 0;
  }

  forEachActive(cb: (item: T, index: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.activeFlags[i] === 1) {
        cb(this.items[i], i);
      }
    }
  }

  getAll(): readonly T[] {
    return this.items;
  }
}
