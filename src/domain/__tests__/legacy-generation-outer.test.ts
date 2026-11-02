import { describe, expect, it } from 'vitest';
import type { SampleDefinition } from '../types';
import {
  buildLegacyCollectionOrder,
  isLegacyGenerationEnabled,
  iterateEnabledWeightedSampleNumbers,
  minimumEnabledSampleLength,
  sumEnabledSelectionWeight,
} from '../legacy-generation-outer';

function sample(
  id: string,
  options: Partial<Pick<SampleDefinition, 'enabled' | 'weight' | 'durationUnits'>> = {},
): SampleDefinition {
  return {
    id,
    name: id,
    fileName: `${id}.wav`,
    durationUnits: options.durationUnits ?? 4,
    weight: options.weight ?? 1,
    startForward: true,
    endForward: true,
    canRepeat: false,
    maxRepeat: 0,
    enabled: options.enabled ?? true,
    silent: false,
  };
}

describe('confirmed generator outer helpers', () => {
  it('sums enabled play weights and expands weighted IDs in sample order', () => {
    const samples = [
      sample('first', { weight: 2 }),
      sample('disabled', { weight: 17, enabled: false }),
      sample('last', { weight: 1 }),
      sample('zero-weight', { weight: 0 }),
    ];

    expect(sumEnabledSelectionWeight(samples)).toBe(3);
    expect([...iterateEnabledWeightedSampleNumbers(samples)]).toEqual([1, 1, 3]);
  });

  it('uses the loader-sorted display collection, preserves numeric IDs, and enables silent rows', () => {
    const samples = [
      sample('source-first', { weight: 1 }),
      { ...sample('source-alpha', { weight: 2 }), name: 'Alpha' },
      { ...sample('duplicate-alpha', { weight: 1 }), name: 'Alpha' },
      { ...sample('pause', { weight: 1, enabled: false }), name: '!Pause!', silent: true },
    ];

    const ordered = buildLegacyCollectionOrder(samples);
    expect(ordered.map(({ sampleNumber, sortKey }) => [sampleNumber, sortKey])).toEqual([
      [4, '!Pause!'],
      [3, 'Alphaz'],
      [2, 'Alphaz'],
      [1, 'source-first'],
    ]);
    expect(isLegacyGenerationEnabled(samples[3]!)).toBe(true);
    expect([...iterateEnabledWeightedSampleNumbers(samples)]).toEqual([4, 3, 2, 2, 1]);
  });

  it('derives against original names and matches unstable native sort ties', () => {
    const samples = [
      { ...sample('sample02'), name: 'Alpha' },
      { ...sample('sample01'), name: 'Alpha' },
      { ...sample('sample03'), name: 'Alphaz' },
    ];

    expect(buildLegacyCollectionOrder(samples).map(({ sampleNumber, sortKey }) => [sampleNumber, sortKey])).toEqual([
      [3, 'Alphaz'],
      [2, 'Alphazz'],
      [1, 'Alphazz'],
    ]);
  });

  it('checks duplicate names case-insensitively but sorts keys case-sensitively', () => {
    const samples = [
      { ...sample('Sample01'), name: 'Alpha' },
      { ...sample('Sample02'), name: 'alpha' },
    ];

    expect(buildLegacyCollectionOrder(samples).map(({ sampleNumber, sortKey }) => [sampleNumber, sortKey])).toEqual([
      [1, 'Alphaz'],
      [2, 'alphaz'],
    ]);
  });

  it('uses numeric legacy IDs and ignores rows above the loader Sample500 limit', () => {
    const samples = [
      { ...sample('sample02'), name: 'Zulu' },
      { ...sample('Sample501'), name: 'Ignored' },
      { ...sample('Sample01'), name: 'Alpha' },
    ];

    expect(buildLegacyCollectionOrder(samples).map(({ sampleNumber }) => sampleNumber)).toEqual([1, 2]);
  });

  it('limits the stop threshold to the selected length and minimum enabled legacy duration', () => {
    const samples = [
      sample('long', { durationUnits: 8 }),
      sample('disabled-short', { durationUnits: 1, enabled: false }),
      sample('short', { durationUnits: 4 }),
    ];

    expect(minimumEnabledSampleLength(samples, 16)).toBe(4);
    expect(minimumEnabledSampleLength(samples, 2)).toBe(2);
    expect(minimumEnabledSampleLength([sample('disabled', { enabled: false })], 16)).toBe(16);
  });

  it('fails closed for invalid enabled integer fields', () => {
    expect(() => sumEnabledSelectionWeight([sample('bad', { weight: 1.5 })])).toThrow('integer play weight');
    expect(() => minimumEnabledSampleLength([sample('bad', { durationUnits: -1 })], 8)).toThrow('integer legacy length');
  });
});
