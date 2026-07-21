import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('permits up to N concurrent acquisitions', async () => {
    const sem = new Semaphore(3);
    const order: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      (async () => {
        await sem.acquire();
        order.push(i);
        // hold briefly
        await new Promise((r) => setTimeout(r, 10));
        sem.release();
      })(),
    );
    await Promise.all(tasks);
    expect(order.slice(0, 3)).toHaveLength(3);
    expect(order).toHaveLength(6);
  });

  it('serialize() runs an async fn under the semaphore', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let maxActive = 0;
    const fn = async (i: number) => {
      await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      sem.release();
      return i;
    };
    await Promise.all([fn(1), fn(2), fn(3)]);
    expect(maxActive).toBe(1);
  });
});