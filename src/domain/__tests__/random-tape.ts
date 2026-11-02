/** Test-only deterministic source for exercising future generator draw sequences. */
export interface RandomTape {
  next(): number;
  readonly drawCount: number;
  assertExhausted(): void;
}

export function createRandomTape(draws: readonly number[]): RandomTape {
  if (draws.some((draw) => !Number.isFinite(draw))) {
    throw new TypeError('Random tape values must be finite numbers.');
  }

  let index = 0;
  return {
    next() {
      if (index >= draws.length) {
        throw new Error(`Random tape exhausted after ${index} draw${index === 1 ? '' : 's'}.`);
      }
      const draw = draws[index];
      if (draw === undefined) throw new Error(`Random tape has no value at draw ${index + 1}.`);
      index += 1;
      return draw;
    },
    get drawCount() {
      return index;
    },
    assertExhausted() {
      const unused = draws.length - index;
      if (unused > 0) throw new Error(`Random tape has ${unused} unused draw${unused === 1 ? '' : 's'}.`);
    },
  };
}
