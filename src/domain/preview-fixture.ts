import type { Fixture, FixtureEvent, Preset } from './types';

export const MAX_PREVIEW_UNITS = 4096;
export const REST_SAMPLE_ID = '__rest__';

/** Build a stable ordered preview fixture; this does not model legacy random selection. */
export function buildPreviewFixture(preset: Preset, targetUnits = 32): Fixture {
  if (!Number.isSafeInteger(targetUnits) || targetUnits < 0 || targetUnits > MAX_PREVIEW_UNITS) {
    throw new RangeError(`Preview length must be a whole number between 0 and ${MAX_PREVIEW_UNITS}.`);
  }

  const events: FixtureEvent[] = [];
  let cursor = 0;

  for (const sample of preset.samples) {
    if (cursor >= targetUnits) break;
    if (!sample.enabled || !Number.isSafeInteger(sample.durationUnits) || sample.durationUnits <= 0) continue;

    const durationUnits = Math.min(sample.durationUnits, targetUnits - cursor);
    events.push({
      id: `fixture-event-${String(events.length + 1).padStart(3, '0')}`,
      sampleId: sample.id,
      startUnits: cursor,
      durationUnits,
      silent: sample.silent,
    });
    cursor += durationUnits;
  }

  if (cursor < targetUnits) {
    events.push({
      id: `fixture-event-${String(events.length + 1).padStart(3, '0')}`,
      sampleId: REST_SAMPLE_ID,
      startUnits: cursor,
      durationUnits: targetUnits - cursor,
      silent: true,
    });
  }

  return { events, totalUnits: targetUnits };
}
