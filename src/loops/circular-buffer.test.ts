import assert from 'node:assert';
import { describe, it } from 'node:test';
import { CircularBuffer } from './circular-buffer.js';

describe('CircularBuffer', () => {
  describe('constructor', () => {
    it('throws for non-positive capacity', () => {
      assert.throws(() => new CircularBuffer(0), /capacity must be positive/);
      assert.throws(() => new CircularBuffer(-1), /capacity must be positive/);
    });

    it('creates buffer with specified capacity', () => {
      const buffer = new CircularBuffer<string>(5);
      assert.strictEqual(buffer.length, 0);
    });
  });

  describe('push and toArray', () => {
    it('returns empty array when empty', () => {
      const buffer = new CircularBuffer<string>(5);
      assert.deepStrictEqual(buffer.toArray(), []);
    });

    it('stores items in order', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      assert.deepStrictEqual(buffer.toArray(), ['a', 'b', 'c']);
      assert.strictEqual(buffer.length, 3);
    });

    it('overwrites oldest items when full', () => {
      const buffer = new CircularBuffer<string>(3);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      buffer.push('d'); // Overwrites 'a'
      assert.deepStrictEqual(buffer.toArray(), ['b', 'c', 'd']);
      assert.strictEqual(buffer.length, 3);
    });

    it('handles multiple overwrites correctly', () => {
      const buffer = new CircularBuffer<string>(3);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      buffer.push('d');
      buffer.push('e');
      buffer.push('f');
      assert.deepStrictEqual(buffer.toArray(), ['d', 'e', 'f']);
    });

    it('handles wrap-around correctly', () => {
      const buffer = new CircularBuffer<number>(5);
      // Fill buffer
      for (let i = 1; i <= 5; i++) buffer.push(i);
      assert.deepStrictEqual(buffer.toArray(), [1, 2, 3, 4, 5]);

      // Add more items, causing wrap-around
      buffer.push(6);
      buffer.push(7);
      assert.deepStrictEqual(buffer.toArray(), [3, 4, 5, 6, 7]);
    });
  });

  describe('last', () => {
    it('returns empty array for n <= 0', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      assert.deepStrictEqual(buffer.last(0), []);
      assert.deepStrictEqual(buffer.last(-1), []);
    });

    it('returns empty array when buffer is empty', () => {
      const buffer = new CircularBuffer<string>(5);
      assert.deepStrictEqual(buffer.last(3), []);
    });

    it('returns last N items', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      buffer.push('d');
      assert.deepStrictEqual(buffer.last(2), ['c', 'd']);
      assert.deepStrictEqual(buffer.last(3), ['b', 'c', 'd']);
    });

    it('returns all items if N > count', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      assert.deepStrictEqual(buffer.last(10), ['a', 'b']);
    });

    it('works correctly after wrap-around', () => {
      const buffer = new CircularBuffer<string>(3);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      buffer.push('d'); // Now: b, c, d
      assert.deepStrictEqual(buffer.last(2), ['c', 'd']);
      assert.deepStrictEqual(buffer.last(3), ['b', 'c', 'd']);
    });
  });

  describe('clear', () => {
    it('removes all items', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');
      buffer.clear();
      assert.strictEqual(buffer.length, 0);
      assert.deepStrictEqual(buffer.toArray(), []);
    });

    it('allows adding items after clear', () => {
      const buffer = new CircularBuffer<string>(3);
      buffer.push('a');
      buffer.push('b');
      buffer.clear();
      buffer.push('x');
      buffer.push('y');
      assert.deepStrictEqual(buffer.toArray(), ['x', 'y']);
    });
  });

  describe('integration with TUI output scenario', () => {
    it('handles typical output buffer usage pattern', () => {
      const buffer = new CircularBuffer<string>(100);

      // Simulate streaming output
      for (let i = 1; i <= 150; i++) {
        buffer.push(`line ${i}`);
      }

      // Should have last 100 lines
      assert.strictEqual(buffer.length, 100);

      const output = buffer.toArray();
      assert.strictEqual(output.length, 100);
      assert.strictEqual(output[0], 'line 51');
      assert.strictEqual(output[99], 'line 150');

      // Get last 10 lines for display
      const display = buffer.last(10);
      assert.strictEqual(display.length, 10);
      assert.strictEqual(display[0], 'line 141');
      assert.strictEqual(display[9], 'line 150');
    });
  });
});
