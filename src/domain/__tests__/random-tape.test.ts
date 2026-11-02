import { describe, expect, it } from 'vitest';
import { createRandomTape } from './random-tape';

describe('createRandomTape', () => {
  it('replays a supplied draw sequence and tracks consumption', () => {
    const tape = createRandomTape([0, 0.5, 0.999]);

    expect([tape.next(), tape.next(), tape.next()]).toEqual([0, 0.5, 0.999]);
    expect(tape.drawCount).toBe(3);
    expect(() => tape.assertExhausted()).not.toThrow();
  });

  it('fails on overdraw and when an expected draw remains unused', () => {
    const tape = createRandomTape([0.25, 0.75]);

    expect(tape.next()).toBe(0.25);
    expect(() => tape.assertExhausted()).toThrow('1 unused draw');
    expect(tape.next()).toBe(0.75);
    expect(() => tape.next()).toThrow('Random tape exhausted after 2 draws');
  });

  it('rejects non-finite tape values', () => {
    expect(() => createRandomTape([0, Number.NaN])).toThrow('finite numbers');
  });
});
