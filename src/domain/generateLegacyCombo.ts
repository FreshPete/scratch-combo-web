import type { Preset, SampleDefinition } from './types';
import {
  buildLegacyCollectionOrder,
  isLegacyGenerationEnabled,
  minimumEnabledSampleLength,
  sumEnabledSelectionWeight,
} from './legacy-generation-outer';

export const DEFAULT_MAX_OUTER_RESTARTS = 16;
export const MAX_LEGACY_COMBO_TICKS = 512;
export const MAX_LEGACY_COMBO_EVENTS = 8192;
const MAX_CANDIDATE_ATTEMPTS = 1000;
const MAX_CONSECUTIVE_ZERO_DURATION_EVENTS = 1000;

export type LegacyRandomSource = () => number;

/** Browser adapter matching a finite 24-bit fraction before the generator's VB6 Single step. */
export function web24bitRnd(random: () => number = Math.random): number {
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new RangeError('Browser random source must return a finite value in [0, 1).');
  }
  return Math.floor(draw * 2 ** 24) / 2 ** 24;
}

export type LegacyComboTerminalReason =
  | 'length-budget-complete'
  | 'minimum-fit-exhausted'
  | 'selection-exhausted'
  | 'event-budget-exhausted'
  | 'zero-duration-stall';

export interface LegacyComboEvent {
  eventNumber: number;
  sampleNumber: number;
  sampleId: string;
  startTick: number;
  durationTicks: number;
  startForward: boolean;
  endForward: boolean;
  silent: boolean;
}

export interface LegacyComboResult {
  events: LegacyComboEvent[];
  requestedRawTicks: number;
  completedRawTicks: number;
  remainingRawTicks: number;
  terminalReason: LegacyComboTerminalReason;
  restarts: number;
}

export interface LegacyComboOptions {
  /** Test seam for the native outer restart. Production defaults to sixteen restarts. */
  maxOuterRestarts?: number;
}

interface SelectorState {
  previousSampleNumber: number;
  repeatCount: number;
  directionState: boolean;
}

function nextNativeSingle(randomSource: LegacyRandomSource): number {
  const draw = randomSource();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new RangeError('Random source must return a finite value in [0, 1).');
  }

  const nativeSingle = Math.fround(draw);
  if (!Number.isFinite(nativeSingle) || nativeSingle < 0 || nativeSingle >= 1) {
    throw new RangeError('Random draw must remain in [0, 1) after VB6 Single rounding.');
  }
  return nativeSingle;
}

function resolveSample(
  byNumber: ReadonlyMap<number, SampleDefinition>,
  sampleNumber: number,
): SampleDefinition | undefined {
  return byNumber.get(sampleNumber);
}

function sampleNumberAtWeightedSlot(
  samplesInCollectionOrder: ReturnType<typeof buildLegacyCollectionOrder>,
  slot: number,
): number | undefined {
  let offset = 0;
  for (const entry of samplesInCollectionOrder) {
    if (!isLegacyGenerationEnabled(entry.sample)) continue;
    const end = offset + entry.sample.weight;
    if (slot < end) return entry.sampleNumber;
    offset = end;
  }
  return undefined;
}

function selectNextSampleNumber(
  samplesByNumber: ReadonlyMap<number, SampleDefinition>,
  samplesInCollectionOrder: ReturnType<typeof buildLegacyCollectionOrder>,
  totalWeight: number,
  remainingRawTicks: number,
  state: SelectorState,
  randomSource: LegacyRandomSource,
): number {
  const prior = resolveSample(samplesByNumber, state.previousSampleNumber);

  // method_1B's prior-row shortcut runs before the weighted candidate loop.
  if (
    prior &&
    prior.canRepeat &&
    state.repeatCount < prior.maxRepeat &&
    prior.durationUnits <= remainingRawTicks
  ) {
    const repeatDraw = nextNativeSingle(randomSource);
    if (Math.floor(repeatDraw * 3 + 1) === 1) {
      state.repeatCount += 1;
      return state.previousSampleNumber;
    }
  }

  for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt += 1) {
    const draw = nextNativeSingle(randomSource);
    const slot = Math.floor(totalWeight * draw + 1) - 1;
    const candidateNumber = sampleNumberAtWeightedSlot(samplesInCollectionOrder, slot);
    if (candidateNumber === undefined) continue;

    const candidate = resolveSample(samplesByNumber, candidateNumber);
    if (!candidate) continue;

    if (candidateNumber === state.previousSampleNumber) {
      state.repeatCount += 1;
      if (!candidate.canRepeat || state.repeatCount >= candidate.maxRepeat) continue;
    }

    const previousEndsForward = prior?.endForward ?? false;
    if (!candidate.silent && !prior?.silent && candidate.startForward !== !previousEndsForward) {
      continue;
    }
    if (candidate.durationUnits > remainingRawTicks) continue;

    if (candidate.durationUnits === remainingRawTicks) {
      if (candidate.endForward !== !state.directionState) continue;
      state.directionState = false;
    } else if (state.previousSampleNumber <= 0) {
      state.directionState = candidate.startForward;
    }

    if (candidateNumber !== state.previousSampleNumber) state.repeatCount = 0;
    state.previousSampleNumber = candidateNumber;
    return candidateNumber;
  }

  return -1;
}

function buildResult(
  events: LegacyComboEvent[],
  requestedRawTicks: number,
  remainingRawTicks: number,
  terminalReason: LegacyComboTerminalReason,
  restarts: number,
): LegacyComboResult {
  const completedRawTicks = events.reduce((sum, event) => sum + event.durationTicks, 0);
  return {
    events,
    requestedRawTicks,
    completedRawTicks,
    remainingRawTicks,
    terminalReason,
    restarts,
  };
}

/**
 * Generate one legacy combo in raw `lng16ths` ticks, separate from Web Audio Fixture units.
 * `randomSource` supplies the value for each native Rnd() call; this reproduces picker draw
 * consumption, not the VB6 Randomize/Rnd pseudo-random stream. Browser callers can pass
 * `web24bitRnd` as the source for a bounded 24-bit fraction.
 */
export function generateLegacyCombo(
  preset: Preset,
  requestedRawTicks: number,
  randomSource: LegacyRandomSource,
  options: LegacyComboOptions = {},
): LegacyComboResult {
  if (
    !Number.isSafeInteger(requestedRawTicks) ||
    requestedRawTicks < 0 ||
    requestedRawTicks > MAX_LEGACY_COMBO_TICKS
  ) {
    throw new RangeError(`Requested legacy length must be an integer tick count between 0 and ${MAX_LEGACY_COMBO_TICKS}.`);
  }
  if (typeof randomSource !== 'function') throw new TypeError('An explicit random source is required.');

  const maxOuterRestarts = options.maxOuterRestarts ?? DEFAULT_MAX_OUTER_RESTARTS;
  if (
    !Number.isSafeInteger(maxOuterRestarts) ||
    maxOuterRestarts < 0 ||
    maxOuterRestarts > DEFAULT_MAX_OUTER_RESTARTS
  ) {
    throw new RangeError(`Outer restarts must be an integer between 0 and ${DEFAULT_MAX_OUTER_RESTARTS}.`);
  }
  if (requestedRawTicks === 0) {
    return buildResult([], requestedRawTicks, 0, 'length-budget-complete', 0);
  }

  const samplesInCollectionOrder = buildLegacyCollectionOrder(preset.samples);
  const samplesByNumber = new Map(samplesInCollectionOrder.map(({ sample, sampleNumber }) => [sampleNumber, sample]));
  const totalWeight = sumEnabledSelectionWeight(preset.samples);
  const minimumLength = minimumEnabledSampleLength(preset.samples, requestedRawTicks);

  let restarts = 0;
  while (true) {
    const events: LegacyComboEvent[] = [];
    const state: SelectorState = {
      previousSampleNumber: 0,
      repeatCount: 0,
      directionState: false,
    };
    let remainingRawTicks = requestedRawTicks;
    let consecutiveZeroDurationEvents = 0;

    while (remainingRawTicks > 0 && remainingRawTicks >= minimumLength) {
      if (events.length >= MAX_LEGACY_COMBO_EVENTS) {
        return buildResult([], requestedRawTicks, requestedRawTicks, 'event-budget-exhausted', restarts);
      }

      const sampleNumber = selectNextSampleNumber(
        samplesByNumber,
        samplesInCollectionOrder,
        totalWeight,
        remainingRawTicks,
        state,
        randomSource,
      );

      if (sampleNumber < 0) {
        if (restarts < maxOuterRestarts) {
          restarts += 1;
          break;
        }
        return buildResult([], requestedRawTicks, requestedRawTicks, 'selection-exhausted', restarts);
      }

      const sample = resolveSample(samplesByNumber, sampleNumber);
      if (!sample) return buildResult([], requestedRawTicks, requestedRawTicks, 'selection-exhausted', restarts);

      const event: LegacyComboEvent = {
        eventNumber: events.length + 1,
        sampleNumber,
        sampleId: sample.id,
        startTick: requestedRawTicks - remainingRawTicks,
        durationTicks: sample.durationUnits,
        startForward: sample.startForward,
        endForward: sample.endForward,
        silent: sample.silent,
      };
      events.push(event);
      remainingRawTicks -= event.durationTicks;

      if (event.durationTicks === 0) {
        consecutiveZeroDurationEvents += 1;
        if (consecutiveZeroDurationEvents >= MAX_CONSECUTIVE_ZERO_DURATION_EVENTS) {
          return buildResult([], requestedRawTicks, requestedRawTicks, 'zero-duration-stall', restarts);
        }
      } else {
        consecutiveZeroDurationEvents = 0;
      }
    }

    if (remainingRawTicks === 0) {
      return buildResult(events, requestedRawTicks, 0, 'length-budget-complete', restarts);
    }
    if (remainingRawTicks < minimumLength) {
      return buildResult(events, requestedRawTicks, remainingRawTicks, 'minimum-fit-exhausted', restarts);
    }
    // A method_1B -1 clears the current list and restarts from the full requested budget.
  }
}
