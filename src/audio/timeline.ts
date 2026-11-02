import type { Fixture, FixtureEvent } from "../domain";

export interface ScheduledFixtureEvent {
  readonly id: string;
  readonly sampleId: string;
  readonly startUnits: number;
  readonly offsetSeconds: number;
  readonly durationUnits: number;
  readonly silent: boolean;
}

export interface FixtureTimeline {
  readonly bpm: number;
  readonly unitsPerBeat: number;
  readonly secondsPerUnit: number;
  readonly totalUnits: number;
  readonly totalSeconds: number;
  readonly events: readonly ScheduledFixtureEvent[];
}

export type CycleSlot =
  | { readonly kind: "fixture"; readonly fixture: Fixture }
  /** Suppresses new combo events; sample sources already started can finish naturally. */
  | { readonly kind: "silence"; readonly durationUnits: number };

export interface CyclePlanSlotTimeline {
  readonly kind: CycleSlot["kind"];
  readonly startUnits: number;
  readonly durationUnits: number;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export interface CyclePlanTimeline extends FixtureTimeline {
  readonly slots: readonly CyclePlanSlotTimeline[];
}

/** Convert fixture units to seconds. The first-slice fixture uses four sixteenths per beat. */
export function secondsForUnits(units: number, bpm: number, unitsPerBeat = 4): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error("BPM must be a finite number greater than zero.");
  }
  if (!Number.isFinite(unitsPerBeat) || unitsPerBeat <= 0) {
    throw new Error("Units per beat must be a finite number greater than zero.");
  }
  if (!Number.isFinite(units) || units < 0) {
    throw new Error("Timeline units must be a finite non-negative number.");
  }

  if (units === 0) return 0;
  const seconds = units * (60 / bpm / unitsPerBeat);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("The BPM and timeline units produce an invalid audio duration.");
  }
  return seconds;
}

/** Validate a fixture and build its immutable, chronologically ordered schedule. */
export function createFixtureTimeline(fixture: Fixture, bpm: number, unitsPerBeat = 4): FixtureTimeline {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error("BPM must be a finite number greater than zero.");
  }
  if (!Number.isFinite(unitsPerBeat) || unitsPerBeat <= 0) {
    throw new Error("Units per beat must be a finite number greater than zero.");
  }
  if (!fixture || !Array.isArray(fixture.events)) {
    throw new Error("The combo fixture is missing its event list.");
  }
  if (fixture.events.length === 0) {
    throw new Error("There are no events to play. Generate a combo fixture first.");
  }
  if (!Number.isFinite(fixture.totalUnits) || fixture.totalUnits <= 0) {
    throw new Error("The combo fixture has no playable duration.");
  }

  const secondsPerUnit = 60 / bpm / unitsPerBeat;
  if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) {
    throw new Error("The BPM produces an invalid timeline scale.");
  }
  const totalSeconds = fixture.totalUnits * secondsPerUnit;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error("The BPM and fixture length produce an invalid audio duration.");
  }
  const events = fixture.events.map((event: FixtureEvent, index) => {
    validateEvent(event, fixture.totalUnits, index);
    const offsetSeconds = event.startUnits * secondsPerUnit;
    if (!Number.isFinite(offsetSeconds)) {
      throw new Error(`Fixture event “${event.id}” has an invalid timeline position.`);
    }
    return {
      id: event.id,
      sampleId: event.sampleId,
      startUnits: event.startUnits,
      offsetSeconds,
      durationUnits: event.durationUnits,
      silent: event.silent,
      index,
    };
  });

  events.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.index - right.index);

  return {
    bpm,
    unitsPerBeat,
    secondsPerUnit,
    totalSeconds,
    totalUnits: fixture.totalUnits,
    events: events.map(({ index: _index, ...event }) => event),
  };
}

/** Build one ordered cycle plan. Its slots can be repeated by the transport without gaps. */
export function createCyclePlanTimeline(
  slots: readonly CycleSlot[],
  bpm: number,
  unitsPerBeat = 4,
): CyclePlanTimeline {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error("BPM must be a finite number greater than zero.");
  }
  if (!Number.isFinite(unitsPerBeat) || unitsPerBeat <= 0) {
    throw new Error("Units per beat must be a finite number greater than zero.");
  }
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error("A cycle plan must contain at least one fixture or silent slot.");
  }

  const secondsPerUnit = 60 / bpm / unitsPerBeat;
  if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) {
    throw new Error("The BPM produces an invalid timeline scale.");
  }

  let startUnits = 0;
  let eventOrder = 0;
  const timelineSlots: CyclePlanSlotTimeline[] = [];
  const events: Array<ScheduledFixtureEvent & { readonly order: number }> = [];

  for (const [slotIndex, slot] of slots.entries()) {
    if (!slot || typeof slot !== "object") {
      throw new Error(`Cycle slot ${slotIndex + 1} is invalid.`);
    }

    let kind: CycleSlot["kind"];
    let durationUnits: number;
    let fixtureTimeline: FixtureTimeline | undefined;

    if (slot.kind === "fixture") {
      kind = "fixture";
      fixtureTimeline = createFixtureTimeline(slot.fixture, bpm, unitsPerBeat);
      durationUnits = slot.fixture.totalUnits;
    } else if (slot.kind === "silence") {
      kind = "silence";
      durationUnits = slot.durationUnits;
      if (!Number.isFinite(durationUnits) || durationUnits <= 0) {
        throw new Error(`Silent cycle slot ${slotIndex + 1} must have a finite duration greater than zero.`);
      }
    } else {
      throw new Error(`Cycle slot ${slotIndex + 1} has an unsupported kind.`);
    }

    const startSeconds = startUnits * secondsPerUnit;
    const durationSeconds = durationUnits * secondsPerUnit;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`Cycle slot ${slotIndex + 1} has an invalid duration.`);
    }
    timelineSlots.push({ kind, startUnits, durationUnits, startSeconds, durationSeconds });

    if (fixtureTimeline) {
      for (const event of fixtureTimeline.events) {
        events.push({
          ...event,
          startUnits: startUnits + event.startUnits,
          offsetSeconds: startSeconds + event.offsetSeconds,
          order: eventOrder,
        });
        eventOrder += 1;
      }
    }
    startUnits += durationUnits;
    if (!Number.isFinite(startUnits)) {
      throw new Error("The cycle plan produces an invalid audio duration.");
    }
  }

  events.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.order - right.order);
  const totalSeconds = startUnits * secondsPerUnit;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error("The cycle plan produces an invalid audio duration.");
  }

  return {
    bpm,
    unitsPerBeat,
    secondsPerUnit,
    totalSeconds,
    totalUnits: startUnits,
    slots: timelineSlots,
    events: events.map(({ order: _order, ...event }) => event),
  };
}

/** Rebuild time coordinates for a new BPM while retaining fixture-unit positions. */
export function rescaleFixtureTimeline(timeline: FixtureTimeline, bpm: number): FixtureTimeline {
  validateBpm(bpm);
  const secondsPerUnit = 60 / bpm / timeline.unitsPerBeat;
  const totalSeconds = timeline.totalUnits * secondsPerUnit;
  if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0 || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error("The BPM produces an invalid timeline scale.");
  }
  return {
    ...timeline,
    bpm,
    secondsPerUnit,
    totalSeconds,
    events: timeline.events.map((event) => ({
      ...event,
      offsetSeconds: event.startUnits * secondsPerUnit,
    })),
  };
}

/** Rebuild all cycle-slot and event time coordinates from their musical-unit positions. */
export function rescaleCyclePlanTimeline(timeline: CyclePlanTimeline, bpm: number): CyclePlanTimeline {
  const scaled = rescaleFixtureTimeline(timeline, bpm);
  return {
    ...scaled,
    slots: timeline.slots.map((slot) => ({
      ...slot,
      startSeconds: slot.startUnits * scaled.secondsPerUnit,
      durationSeconds: slot.durationUnits * scaled.secondsPerUnit,
    })),
  };
}

function validateBpm(bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error("BPM must be a finite number greater than zero.");
  }
}

function validateEvent(event: FixtureEvent, totalUnits: number, index: number): void {
  if (!event || typeof event !== "object") {
    throw new Error(`Fixture event ${index + 1} is invalid.`);
  }
  if (typeof event.id !== "string" || event.id.trim() === "") {
    throw new Error(`Fixture event ${index + 1} has no id.`);
  }
  if (typeof event.sampleId !== "string" || event.sampleId.trim() === "") {
    throw new Error(`Fixture event ${index + 1} has no sample id.`);
  }
  if (!Number.isFinite(event.startUnits) || event.startUnits < 0) {
    throw new Error(`Fixture event “${event.id}” has an invalid start position.`);
  }
  if (!Number.isFinite(event.durationUnits) || event.durationUnits <= 0) {
    throw new Error(`Fixture event “${event.id}” has an invalid duration.`);
  }
  if (event.startUnits + event.durationUnits > totalUnits) {
    throw new Error(`Fixture event “${event.id}” extends beyond the fixture duration.`);
  }
  if (typeof event.silent !== "boolean") {
    throw new Error(`Fixture event “${event.id}” has an invalid silence flag.`);
  }
}
