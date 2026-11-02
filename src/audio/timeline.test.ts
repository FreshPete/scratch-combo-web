import { describe, expect, it } from "vitest";
import { createCyclePlanTimeline, createFixtureTimeline, rescaleCyclePlanTimeline, secondsForUnits } from "./timeline";
import type { Fixture } from "../domain";

const fixture: Fixture = {
  events: [
    { id: "late", sampleId: "synthBrush", startUnits: 4, durationUnits: 2, silent: false },
    { id: "early", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false },
  ],
  totalUnits: 6,
};

describe("fixture timeline", () => {
  it("converts sixteenth-bar units to seconds and keeps event order stable", () => {
    expect(secondsForUnits(4, 120)).toBe(0.5);

    const timeline = createFixtureTimeline(fixture, 120);

    expect(timeline.totalSeconds).toBe(0.75);
    expect(timeline.events.map(({ id, offsetSeconds }) => [id, offsetSeconds])).toEqual([
      ["early", 0],
      ["late", 0.5],
    ]);
  });

  it("converts the recovered legacy 16th-note ticks at 16 ticks per quarter-note beat", () => {
    const rawTickFixture: Fixture = {
      events: [{ id: "legacy-step", sampleId: "synthPulse", startUnits: 64, durationUnits: 16, silent: false }],
      totalUnits: 128,
    };
    const timeline = createFixtureTimeline(rawTickFixture, 85, 16);

    expect(secondsForUnits(128, 85, 16)).toBeCloseTo(5.6470588235, 10);
    expect(timeline.totalSeconds).toBeCloseTo(5.6470588235, 10);
    expect(timeline.events[0]?.offsetSeconds).toBeCloseTo(2.8235294118, 10);
  });

  it("keeps the four-unit demo scale as the default", () => {
    expect(createFixtureTimeline({ events: [fixture.events[0]!], totalUnits: 32 }, 100).totalSeconds).toBe(4.8);
  });

  it("lays out explicit fixture and silence slots on one repeated-plan timeline", () => {
    const activeFixture: Fixture = {
      events: [{ id: "hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const plan = createCyclePlanTimeline([
      { kind: "fixture", fixture: activeFixture },
      { kind: "silence", durationUnits: 4 },
      { kind: "fixture", fixture: activeFixture },
    ], 120);

    expect(plan.totalSeconds).toBe(1.5);
    expect(plan.slots).toEqual([
      { kind: "fixture", startUnits: 0, durationUnits: 4, startSeconds: 0, durationSeconds: 0.5 },
      { kind: "silence", startUnits: 4, durationUnits: 4, startSeconds: 0.5, durationSeconds: 0.5 },
      { kind: "fixture", startUnits: 8, durationUnits: 4, startSeconds: 1, durationSeconds: 0.5 },
    ]);
    expect(plan.events.map(({ id, offsetSeconds }) => [id, offsetSeconds])).toEqual([
      ["hit", 0],
      ["hit", 1],
    ]);
  });

  it("rescales fixture and cycle times from raw musical positions", () => {
    const activeFixture: Fixture = {
      events: [{ id: "hit", sampleId: "synthPulse", startUnits: 8, durationUnits: 4, silent: false }],
      totalUnits: 16,
    };
    const original = createCyclePlanTimeline([
      { kind: "fixture", fixture: activeFixture },
      { kind: "silence", durationUnits: 8 },
    ], 85, 16);
    const retimed = rescaleCyclePlanTimeline(original, 100);

    expect(retimed.totalUnits).toBe(original.totalUnits);
    expect(retimed.totalSeconds).toBeCloseTo(24 * 60 / 100 / 16);
    expect(retimed.events[0]?.startUnits).toBe(8);
    expect(retimed.events[0]?.offsetSeconds).toBeCloseTo(8 * 60 / 100 / 16);
    expect(retimed.slots.map(({ startUnits, durationUnits }) => [startUnits, durationUnits])).toEqual([[0, 16], [16, 8]]);
  });

  it("allows a silent-only cycle but rejects missing or zero-length slots", () => {
    expect(createCyclePlanTimeline([{ kind: "silence", durationUnits: 4 }], 120).events).toEqual([]);
    expect(() => createCyclePlanTimeline([], 120)).toThrow("at least one fixture or silent slot");
    expect(() => createCyclePlanTimeline([{ kind: "silence", durationUnits: 0 }], 120)).toThrow("duration greater than zero");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid BPM %s", (bpm) => {
    expect(() => createFixtureTimeline(fixture, bpm)).toThrow("BPM must be a finite number greater than zero.");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid units per beat %s", (unitsPerBeat) => {
    expect(() => createFixtureTimeline(fixture, 120, unitsPerBeat)).toThrow("Units per beat must be a finite number greater than zero.");
  });

  it("rejects BPM values whose derived timeline duration overflows", () => {
    expect(() => createFixtureTimeline(fixture, 1e-308)).toThrow("invalid timeline scale");
    expect(() => createFixtureTimeline(fixture, Number.MIN_VALUE)).toThrow("invalid timeline scale");
  });

  it("keeps the documented conversion finite at the largest representable BPM", () => {
    const timeline = createFixtureTimeline(fixture, Number.MAX_VALUE);
    expect(Number.isFinite(timeline.totalSeconds)).toBe(true);
    expect(timeline.totalSeconds).toBeGreaterThan(0);
  });

  it("rejects an empty fixture and events outside the configured duration", () => {
    expect(() => createFixtureTimeline({ events: [], totalUnits: 0 }, 120)).toThrow("There are no events to play");
    expect(() => createFixtureTimeline({
      events: [{ id: "too-long", sampleId: "synthPulse", startUnits: 2, durationUnits: 5, silent: false }],
      totalUnits: 6,
    }, 120)).toThrow("extends beyond the fixture duration");
  });
});
