/**
 * Fixed-capacity circular buffer used for:
 * 1. Client-side input prediction & reconciliation history
 * 2. Server-side 1-second (60-frame) lag compensation hitbox history
 * 3. Client-side 100ms remote entity snapshot interpolation
 */
export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) {
      throw new Error("RingBuffer capacity must be > 0");
    }
    this.buffer = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  getLatest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  /**
   * Returns entries ordered from oldest (index 0) to newest (index length - 1).
   */
  getAt(orderedIndex: number): T | undefined {
    if (orderedIndex < 0 || orderedIndex >= this.count) return undefined;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    const idx = (start + orderedIndex) % this.capacity;
    return this.buffer[idx];
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.getAt(i);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
