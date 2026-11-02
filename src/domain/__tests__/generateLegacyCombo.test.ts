import { describe, expect, it } from 'vitest';
import type { Preset, SampleDefinition } from '../types';
import { generateLegacyCombo, web24bitRnd } from '../generateLegacyCombo';
import { createRandomTape } from './random-tape';

function sample(
  id: string,
  name: string,
  options: Partial<SampleDefinition> = {},
): SampleDefinition {
  return {
    id,
    name,
    fileName: `${id}.wav`,
    durationUnits: 1,
    weight: 1,
    startForward: true,
    endForward: true,
    canRepeat: false,
    maxRepeat: 0,
    enabled: true,
    silent: false,
    ...options,
  };
}

function preset(samples: SampleDefinition[]): Preset {
  return {
    name: 'synthetic parity case',
    bpm: 100,
    beatFiles: [],
    beatVolume: 60,
    sampleVolume: 80,
    samples,
  };
}

describe('generateLegacyCombo', () => {
  it('uses Single-rounded weighted slots in sorted display order while retaining row numbers', () => {
    const source = preset([
      sample('Sample01', 'Zulu'),
      sample('Sample02', 'Alpha'),
      sample('Sample03', 'Mike'),
    ]);
    const belowBoundary = createRandomTape([Math.fround(1 / 3) - 2 ** -25]);
    const atBoundary = createRandomTape([1 / 3]);

    const below = generateLegacyCombo(source, 1, belowBoundary.next);
    const at = generateLegacyCombo(source, 1, atBoundary.next);

    expect(below.events[0]?.sampleNumber).toBe(2);
    expect(at.events[0]?.sampleNumber).toBe(3);
    expect([below.events[0]?.sampleId, at.events[0]?.sampleId]).toEqual(['Sample02', 'Sample03']);
    expect(belowBoundary.drawCount).toBe(1);
    expect(atBoundary.drawCount).toBe(1);
  });

  it('alternates non-silent direction and applies the exact terminal orientation gate', () => {
    const tape = createRandomTape([0.1, 0.9]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A', { durationUnits: 2, startForward: true, endForward: true }),
        sample('Sample02', 'B', { durationUnits: 2, startForward: false, endForward: false }),
      ]),
      4,
      tape.next,
    );

    expect(result.events.map(({ sampleId, startTick, durationTicks }) => [sampleId, startTick, durationTicks])).toEqual([
      ['Sample01', 0, 2],
      ['Sample02', 2, 2],
    ]);
    expect(result).toMatchObject({ completedRawTicks: 4, remainingRawTicks: 0, terminalReason: 'length-budget-complete' });
  });

  it('force-enables silent rows and lets silence bypass direction alternation', () => {
    const tape = createRandomTape([0.1, 0.9]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'Regular', { startForward: false, endForward: true }),
        sample('Sample02', '!Pause!', {
          enabled: false,
          silent: true,
          startForward: false,
          endForward: false,
        }),
      ]),
      2,
      tape.next,
    );

    expect(result.events.map(({ sampleNumber, silent }) => [sampleNumber, silent])).toEqual([[2, true], [1, false]]);
    expect(result.terminalReason).toBe('length-budget-complete');
  });

  it('takes the prior-sample repeat shortcut before the weighted table, including its max boundary', () => {
    const tape = createRandomTape([0.5, 0.1, 0.1]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'Repeater', {
          durationUnits: 1,
          canRepeat: true,
          maxRepeat: 2,
          startForward: true,
          endForward: true,
        }),
      ]),
      3,
      tape.next,
    );

    expect(result.events.map(({ sampleNumber }) => sampleNumber)).toEqual([1, 1, 1]);
    expect(result.terminalReason).toBe('length-budget-complete');
    expect(tape.drawCount).toBe(3);
  });

  it('uses the stricter incremented repeat maximum on weighted same-ID draws', () => {
    const tape = createRandomTape([0.1, 0.5, 0.1, 0.5, 0.1, 0.9]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A', {
          durationUnits: 1,
          canRepeat: true,
          maxRepeat: 2,
          startForward: true,
          endForward: false,
        }),
        sample('Sample02', 'B', { durationUnits: 2, startForward: true, endForward: false }),
      ]),
      4,
      tape.next,
    );

    expect(result.events.map(({ sampleId }) => sampleId)).toEqual(['Sample01', 'Sample01', 'Sample02']);
    expect(result.terminalReason).toBe('length-budget-complete');
    expect(tape.drawCount).toBe(6);
  });

  it('restarts the entire combo after 1000 failed candidate draws and discards partial events', () => {
    const tape = createRandomTape([0.1, ...Array.from({ length: 1000 }, () => 0.1), 0.9]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A', { durationUnits: 1 }),
        sample('Sample02', 'B', { durationUnits: 3 }),
      ]),
      3,
      tape.next,
      { maxOuterRestarts: 1 },
    );

    expect(result.events.map(({ sampleNumber, startTick }) => [sampleNumber, startTick])).toEqual([[2, 0]]);
    expect(result).toMatchObject({
      requestedRawTicks: 3,
      completedRawTicks: 3,
      remainingRawTicks: 0,
      terminalReason: 'length-budget-complete',
      restarts: 1,
    });
    expect(tape.drawCount).toBe(1002);
  });

  it('returns typed selection exhaustion with no partial events after the restart budget', () => {
    const tape = createRandomTape([0.1, ...Array.from({ length: 1000 }, () => 0.1)]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A', { durationUnits: 1 }),
        sample('Sample02', 'B', { durationUnits: 3 }),
      ]),
      3,
      tape.next,
      { maxOuterRestarts: 0 },
    );

    expect(result).toMatchObject({
      events: [],
      requestedRawTicks: 3,
      completedRawTicks: 0,
      remainingRawTicks: 3,
      terminalReason: 'selection-exhausted',
      restarts: 0,
    });
    expect(tape.drawCount).toBe(1001);
  });

  it('stops with trailing rest when the remainder is below every enabled row length', () => {
    const tape = createRandomTape([0.1]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A', { durationUnits: 3 }),
        sample('Sample02', 'B', { durationUnits: 2 }),
      ]),
      4,
      tape.next,
    );

    expect(result).toMatchObject({
      events: [expect.objectContaining({ sampleId: 'Sample01', startTick: 0, durationTicks: 3 })],
      requestedRawTicks: 4,
      completedRawTicks: 3,
      remainingRawTicks: 1,
      terminalReason: 'minimum-fit-exhausted',
    });
  });

  it('continues after zero duration when a later weighted candidate makes progress', () => {
    const tape = createRandomTape([0.1, 0.9]);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A zero', { durationUnits: 0, silent: true }),
        sample('Sample02', 'B positive', { durationUnits: 1, endForward: false, silent: true }),
      ]),
      1,
      tape.next,
    );

    expect(result).toMatchObject({
      completedRawTicks: 1,
      remainingRawTicks: 0,
      terminalReason: 'length-budget-complete',
      events: [
        expect.objectContaining({ sampleId: 'Sample01', durationTicks: 0 }),
        expect.objectContaining({ sampleId: 'Sample02', durationTicks: 1 }),
      ],
    });
  });

  it('bounds endless zero-duration row changes and discards partial output', () => {
    const draws = Array.from({ length: 1000 }, (_, index) => (index % 2 === 0 ? 0.1 : 0.9));
    const tape = createRandomTape(draws);
    const result = generateLegacyCombo(
      preset([
        sample('Sample01', 'A zero', { durationUnits: 0, silent: true }),
        sample('Sample02', 'B zero', { durationUnits: 0, silent: true }),
      ]),
      1,
      tape.next,
    );

    expect(result).toMatchObject({
      events: [],
      completedRawTicks: 0,
      remainingRawTicks: 1,
      terminalReason: 'zero-duration-stall',
    });
    expect(tape.drawCount).toBe(1000);
  });

  it('validates requested ticks, restart bounds, and finite random draws', () => {
    const source = preset([sample('Sample01', 'A')]);

    expect(() => generateLegacyCombo(source, -1, () => 0)).toThrow('between 0 and 512');
    expect(() => generateLegacyCombo(source, 513, () => 0)).toThrow('between 0 and 512');
    expect(() => generateLegacyCombo(source, 1, () => 0, { maxOuterRestarts: 17 })).toThrow('between 0 and 16');
    expect(() => generateLegacyCombo(source, 1, () => 1)).toThrow('[0, 1)');
    expect(() => generateLegacyCombo(source, 1, () => Number.NaN)).toThrow('finite value');
  });

  it('provides a quantized browser random adapter that never returns one', () => {
    expect(web24bitRnd(() => 0.5)).toBe(0.5);
    expect(web24bitRnd(() => 0.999999999)).toBe(1 - 2 ** -24);
  });
});
