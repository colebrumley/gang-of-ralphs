/**
 * A fixed-size circular buffer that overwrites oldest entries when full.
 * More efficient than array.slice() which creates garbage on every overflow.
 */
export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0; // Next write position
  private count = 0; // Current number of items
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('CircularBuffer capacity must be positive');
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer. If full, overwrites the oldest item.
   */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Get all items in order from oldest to newest.
   */
  toArray(): T[] {
    if (this.count === 0) {
      return [];
    }

    const result: T[] = new Array(this.count);
    // Start position: if buffer is full, start from head (oldest); otherwise start from 0
    const start = this.count === this.capacity ? this.head : 0;

    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      result[i] = this.buffer[index] as T;
    }

    return result;
  }

  /**
   * Get the number of items currently in the buffer.
   */
  get length(): number {
    return this.count;
  }

  /**
   * Clear all items from the buffer.
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Get the last N items (most recent), or all items if N > count.
   */
  last(n: number): T[] {
    if (n <= 0 || this.count === 0) {
      return [];
    }

    const takeCount = Math.min(n, this.count);
    const result: T[] = new Array(takeCount);

    // Calculate start position for the last N items
    // head points to next write position, so head - 1 is the most recent
    for (let i = 0; i < takeCount; i++) {
      // Go backwards from head - 1
      const index = (this.head - takeCount + i + this.capacity) % this.capacity;
      result[i] = this.buffer[index] as T;
    }

    return result;
  }
}
