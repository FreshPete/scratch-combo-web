import type { SampleDefinition } from './types';

export interface LegacyCollectionEntry {
  sample: SampleDefinition;
  sampleNumber: number;
  sortKey: string;
}

function originalSampleNumber(sample: SampleDefinition, index: number): number {
  const match = /^sample(\d+)$/i.exec(sample.id);
  if (!match) return index + 1;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : index + 1;
}

/** The original loader promotes every silent row to UseSample=True after reading the INI flag. */
export function isLegacyGenerationEnabled(sample: SampleDefinition): boolean {
  return sample.enabled || sample.silent;
}

/**
 * Derive each key against other original display names, preserve the source row number as
 * ItemData, then apply the recovered midpoint-pivot `LtStr` quicksort.
 */
export function buildLegacyCollectionOrder(samples: readonly SampleDefinition[]): LegacyCollectionEntry[] {
  const sourceRows = samples
    .map((sample, index) => ({ sample, sampleNumber: originalSampleNumber(sample, index) }))
    .filter(({ sampleNumber }) => sampleNumber <= 500)
    .sort((left, right) => left.sampleNumber - right.sampleNumber);
  for (let index = 1; index < sourceRows.length; index += 1) {
    if (sourceRows[index - 1]?.sampleNumber === sourceRows[index]?.sampleNumber) {
      throw new RangeError(`Duplicate legacy sample number ${sourceRows[index]?.sampleNumber}.`);
    }
  }

  const entries = sourceRows.map(({ sample, sampleNumber }) => {
    let sortKey = sample.name;
    while (
      sourceRows.some(
        (other) =>
          other.sampleNumber !== sampleNumber &&
          other.sample.name.toLowerCase() === sortKey.toLowerCase(),
      )
    ) {
      sortKey += 'z';
    }
    return { sample, sampleNumber, sortKey };
  });

  return sortLegacyEntries(entries, 0, entries.length - 1);
}

/** CSortedItems.method_07 uses midpoint-pivot Hoare quicksort and swaps equal keys. */
function sortLegacyEntries(entries: LegacyCollectionEntry[], first: number, last: number): LegacyCollectionEntry[] {
  let left = first;
  let right = last;
  const pivot = entries[Math.floor((first + last) / 2)]?.sortKey;
  if (pivot === undefined) return entries;

  while (left <= right) {
    while (left <= last && entries[left]!.sortKey < pivot) left += 1;
    while (right >= first && pivot < entries[right]!.sortKey) right -= 1;
    if (left <= right) {
      [entries[left], entries[right]] = [entries[right]!, entries[left]!];
      left += 1;
      right -= 1;
    }
  }

  if (first < right) sortLegacyEntries(entries, first, right);
  if (left < last) sortLegacyEntries(entries, left, last);
  return entries;
}

/** Sum the selection weights of enabled rows in collection order. */
export function sumEnabledSelectionWeight(samples: readonly SampleDefinition[]): number {
  let total = 0;
  for (const { sample } of buildLegacyCollectionOrder(samples)) {
    if (!isLegacyGenerationEnabled(sample)) continue;
    if (!Number.isSafeInteger(sample.weight) || sample.weight < 0) {
      throw new RangeError(`Enabled sample ${sample.id} has an invalid integer play weight.`);
    }
    total += sample.weight;
    if (!Number.isSafeInteger(total)) throw new RangeError('Enabled sample weights exceed the safe integer range.');
  }
  return total;
}

/** Expand enabled sample numbers by their weights in collection order. */
export function* iterateEnabledWeightedSampleNumbers(
  samples: readonly SampleDefinition[],
): Generator<number, void, undefined> {
  for (const { sample, sampleNumber } of buildLegacyCollectionOrder(samples)) {
    if (!isLegacyGenerationEnabled(sample)) continue;
    if (!Number.isSafeInteger(sample.weight) || sample.weight < 0) {
      throw new RangeError(`Enabled sample ${sample.id} has an invalid integer play weight.`);
    }
    for (let occurrence = 0; occurrence < sample.weight; occurrence += 1) {
      yield sampleNumber;
    }
  }
}

/** Return the smaller of the selected length and enabled sample lengths. */
export function minimumEnabledSampleLength(
  samples: readonly SampleDefinition[],
  selectedLength: number,
): number {
  if (!Number.isSafeInteger(selectedLength) || selectedLength < 0) {
    throw new RangeError('Selected legacy length must be a non-negative safe integer.');
  }

  let minimum = selectedLength;
  for (const { sample } of buildLegacyCollectionOrder(samples)) {
    if (!isLegacyGenerationEnabled(sample)) continue;
    if (!Number.isSafeInteger(sample.durationUnits) || sample.durationUnits < 0) {
      throw new RangeError(`Enabled sample ${sample.id} has an invalid integer legacy length.`);
    }
    if (sample.durationUnits < minimum) minimum = sample.durationUnits;
  }
  return minimum;
}
