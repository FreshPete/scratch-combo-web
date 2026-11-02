import { describe, expect, it, vi } from "vitest";
import { AudioTransport } from "./AudioTransport";
import type { Fixture } from "../domain";

interface FakeSourceRecord {
  readonly node: AudioBufferSourceNode;
  readonly startTimes: number[];
  readonly startOffsets: number[];
  readonly stopTimes: number[];
}

function makeBuffer(duration = 0.2, sampleRate = 1_000): AudioBuffer {
  const length = Math.max(1, Math.round(duration * sampleRate));
  const channel = new Float32Array(length);
  return {
    duration,
    length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
}

function makeFakeParam(initialValue = 1) {
  const parameter = {
    value: initialValue,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((value: number) => { parameter.value = value; }),
    setTargetAtTime: vi.fn((value: number) => { parameter.value = value; }),
  };
  return parameter;
}

function makeProcessor() {
  const playbackRate = { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime(value: number) { this.value = value; } };
  const pitchSemitones = { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime(value: number) { this.value = value; } };
  return {
    node: {
      playbackRate,
      pitchSemitones,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioNode,
    playbackRate,
    pitchSemitones,
  };
}

function makeFakeAudioContext(decodeAudioData?: (data: ArrayBuffer) => Promise<AudioBuffer>) {
  let currentTime = 0;
  let state: AudioContextState = "suspended";
  const sources: FakeSourceRecord[] = [];
  const gains: GainNode[] = [];
  const contextLike = {
    get currentTime() { return currentTime; },
    get state() { return state; },
    sampleRate: 1_000,
    destination: {} as AudioNode,
    resume: vi.fn(async () => { state = "running"; }),
    close: vi.fn(async () => { state = "closed"; }),
    decodeAudioData: vi.fn(decodeAudioData ?? (async () => makeBuffer())),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => makeBuffer(length / sampleRate, sampleRate)),
    createGain: vi.fn(() => {
      const gainParam = {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setTargetAtTime: vi.fn((value: number) => { gainParam.value = value; }),
      };
      const node = {
        gain: gainParam,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node as unknown as GainNode);
      return node;
    }),
    createBufferSource: vi.fn(() => {
      const startTimes: number[] = [];
      const startOffsets: number[] = [];
      const stopTimes: number[] = [];
      let node: AudioBufferSourceNode;
      const sourceLike = {
        buffer: null as AudioBuffer | null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: makeFakeParam(),
        onended: null as AudioBufferSourceNode["onended"],
        start: vi.fn((when = 0, offset = 0) => {
          startTimes.push(when);
          startOffsets.push(offset);
        }),
        stop: vi.fn((when = 0) => { stopTimes.push(when); }),
        connect: vi.fn(() => node),
        disconnect: vi.fn(),
      };
      node = sourceLike as unknown as AudioBufferSourceNode;
      sources.push({ node, startTimes, startOffsets, stopTimes });
      return node;
    }),
  };

  return {
    context: contextLike as unknown as AudioContext,
    sources,
    gains,
    setCurrentTime: (value: number) => { currentTime = value; },
  };
}

function makeTransport(context: AudioContext, tempoPitchProcessorFactory?: () => Promise<AudioNode>) {
  let tick: (() => void) | undefined;
  const transport = new AudioTransport({
    audioContextFactory: () => context,
    scheduleInterval: (callback) => {
      tick = callback;
      return callback;
    },
    cancelInterval: () => { tick = undefined; },
    ...(tempoPitchProcessorFactory
      ? { tempoPitchProcessorFactory: tempoPitchProcessorFactory as never }
      : {}),
  });
  return { transport, runScheduler: () => tick?.() };
}

const fixture: Fixture = {
  events: [
    { id: "one", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false },
    { id: "two", sampleId: "synthBrush", startUnits: 4, durationUnits: 4, silent: false },
    { id: "three", sampleId: "synthPulse", startUnits: 8, durationUnits: 4, silent: false },
  ],
  totalUnits: 12,
};

describe("AudioTransport", () => {
  it("schedules requested source times from the context clock", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);

    await transport.play({ fixture, bpm: 120 });
    expect(fake.context.resume).toHaveBeenCalledTimes(1);
    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toEqual([0.05]);

    fake.setCurrentTime(0.45);
    runScheduler();
    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toEqual([0.05, 0.55]);

    fake.setCurrentTime(0.95);
    runScheduler();
    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toEqual([0.05, 0.55, 1.05]);
    expect(transport.getProgress()).toBeCloseTo(0.6);
    transport.dispose();
  });

  it("stops sources already scheduled for the future", async () => {
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context);

    await transport.play({ fixture, bpm: 120 });
    expect(fake.sources[0]?.startTimes[0]).toBeGreaterThan(fake.context.currentTime);

    transport.stop();

    expect(fake.sources[0]?.stopTimes).toEqual([0]);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
  });

  it("skips expired buffers and seeks into a still-live buffer after a delayed timer tick", async () => {
    const fake = makeFakeAudioContext(async () => makeBuffer(0.5));
    const { transport, runScheduler } = makeTransport(fake.context);
    const sampleFile = {
      name: "long.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const delayedFixture: Fixture = {
      events: [0, 4, 8].map((startUnits, index) => ({
        id: `event-${index + 1}`,
        sampleId: "long-sample",
        startUnits,
        durationUnits: 4,
        silent: false,
      })),
      totalUnits: 12,
    };

    await transport.play({ fixture: delayedFixture, bpm: 120, assets: new Map([["long-sample", sampleFile]]) });
    fake.setCurrentTime(1.1);
    runScheduler();

    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[0]?.startTimes).toEqual([0.05]);
    expect(fake.sources[1]?.startTimes[0]).toBeCloseTo(1.1);
    expect(fake.sources[1]?.startOffsets[0]).toBeCloseTo(0.05);
    transport.dispose();
  });

  it("does not schedule a stale decode after stop or import reset", async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    const decodePromise = new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    const fake = makeFakeAudioContext(() => decodePromise);
    const { transport } = makeTransport(fake.context);
    const sampleFile = {
      name: "local.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const localFixture: Fixture = {
      events: [{ id: "local", sampleId: "local-sample", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    const pendingPlay = transport.play({ fixture: localFixture, bpm: 120, assets: new Map([["local-sample", sampleFile]]) });
    await Promise.resolve();
    await Promise.resolve();
    transport.stop();
    resolveDecode(makeBuffer());
    await pendingPlay;

    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });

    transport.resetAssets();
    let resolveNextDecode!: (buffer: AudioBuffer) => void;
    const nextDecode = new Promise<AudioBuffer>((resolve) => { resolveNextDecode = resolve; });
    vi.mocked(fake.context.decodeAudioData).mockReturnValue(nextDecode);
    const pendingImportPlay = transport.play({ fixture: localFixture, bpm: 120, assets: new Map([["local-sample", sampleFile]]) });
    await Promise.resolve();
    await Promise.resolve();
    transport.resetAssets();
    resolveNextDecode(makeBuffer());
    await pendingImportPlay;

    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("keeps a newer Play when an older decode resolves later", async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    const decodePromise = new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    const fake = makeFakeAudioContext(() => decodePromise);
    const { transport } = makeTransport(fake.context);
    const sampleFile = {
      name: "slow.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const localFixture: Fixture = {
      events: [{ id: "local", sampleId: "local-sample", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    const stalePlay = transport.play({ fixture: localFixture, bpm: 120, assets: new Map([["local-sample", sampleFile]]) });
    await Promise.resolve();
    await Promise.resolve();
    await transport.play({
      fixture: { events: [{ id: "demo", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }], totalUnits: 4 },
      bpm: 120,
    });

    resolveDecode(makeBuffer());
    await stalePlay;

    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]?.startTimes).toEqual([0.05]);
    expect(transport.getSnapshot().status).toBe("playing");
    transport.dispose();
  });

  it("loops an optional beat buffer only through the finite fixture duration", async () => {
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context);
    const beatFile = {
      name: "beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;

    await transport.play({
      fixture: { events: [fixture.events[0]!], totalUnits: 4 },
      bpm: 120,
      beatFile,
      beatVolume: 30,
      sampleVolume: 80,
    });

    const beatSource = fake.sources.find(({ node }) => node.loop);
    expect(beatSource).toBeDefined();
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.stopTimes).toEqual([0.55]);
    expect(fake.gains.map(({ gain }) => gain.value)).toEqual([0.8, 0.3]);
    transport.dispose();
  });

  it("plays a legacy raw-tick fixture with an optional looping beat through the recovered finite length", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const beatFile = {
      name: "beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const legacyFixture: Fixture = {
      events: [
        { id: "first", sampleId: "synthPulse", startUnits: 0, durationUnits: 64, silent: false },
        { id: "second", sampleId: "synthBrush", startUnits: 64, durationUnits: 64, silent: false },
      ],
      totalUnits: 128,
    };

    await transport.play({ fixture: legacyFixture, bpm: 85, unitsPerBeat: 16, beatFile });
    fake.setCurrentTime(2.8);
    runScheduler();

    const beatSource = fake.sources.find(({ node }) => node.loop);
    const secondSampleSource = fake.sources.find(({ startTimes }) => (startTimes[0] ?? 0) > 1);
    expect(beatSource?.stopTimes[0]).toBeCloseTo(5.6970588235, 10);
    expect(secondSampleSource?.startTimes[0]).toBeCloseTo(2.8735294118, 10);
    expect(transport.getProgress()).toBeCloseTo((2.8 - 0.05) / (128 * 60 / 85 / 16), 10);
    transport.dispose();
  });

  it("repeats explicit fixture and silence slots with clock-derived slot and iteration state", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const oneCycleFixture: Fixture = {
      events: [{ id: "cycle-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({
      slots: [
        { kind: "fixture", fixture: oneCycleFixture },
        { kind: "silence", durationUnits: 4 },
        { kind: "fixture", fixture: oneCycleFixture },
      ],
      bpm: 120,
    });

    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toEqual([0.05]);
    expect(transport.getSnapshot()).toMatchObject({
      status: "playing",
      cycleSlotIndex: 0,
      cycleIteration: 1,
      cycleSlotKind: "fixture",
    });

    fake.setCurrentTime(0.7);
    runScheduler();
    expect(transport.getSnapshot()).toMatchObject({
      status: "playing",
      cycleSlotIndex: 1,
      cycleIteration: 1,
      cycleSlotKind: "silence",
    });
    expect(transport.getProgress()).toBeCloseTo(0.65 / 1.5);

    fake.setCurrentTime(1);
    runScheduler();
    fake.setCurrentTime(1.55);
    runScheduler();
    fake.setCurrentTime(2.55);
    runScheduler();

    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toEqual([0.05, 1.05, 1.55, 2.55]);
    expect(transport.getSnapshot()).toMatchObject({
      status: "playing",
      cycleSlotIndex: 2,
      cycleIteration: 2,
      cycleSlotKind: "fixture",
    });
    transport.dispose();
  });

  it("keeps one beat source looping across cycle boundaries until Stop", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const beatFile = {
      name: "looping-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: { events: [fixture.events[0]!], totalUnits: 4 } }],
      bpm: 120,
      beatFile,
    });

    const beatSource = fake.sources.find(({ node }) => node.loop);
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.stopTimes).toEqual([]);

    fake.setCurrentTime(1.1);
    runScheduler();
    fake.setCurrentTime(2.1);
    runScheduler();

    expect(fake.sources.filter(({ node }) => node.loop)).toHaveLength(1);
    expect(beatSource?.stopTimes).toEqual([]);
    expect(transport.getSnapshot().status).toBe("playing");

    transport.stop();
    expect(beatSource?.stopTimes).toEqual([0]);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("generates distinct plans after full audible and silent rounds without restarting the beat bed", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const beatFile = {
      name: "auto-generate-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const fixtureFor = (id: string, sampleId: string): Fixture => ({
      events: [{ id, sampleId, startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    });
    const initialFixture = fixtureFor("initial", "synthPulse");
    const secondFixture = fixtureFor("second", "synthBrush");
    const thirdFixture = fixtureFor("third", "synthPulse");
    const nextPlan = vi.fn(({ nextPlanIndex }: { completedRounds: number; nextPlanIndex: number }) => ({
      slots: [
        { kind: "fixture" as const, fixture: nextPlanIndex === 2 ? secondFixture : thirdFixture },
        { kind: "silence" as const, durationUnits: 4 },
      ],
    }));
    const onPlanBoundary = vi.fn();

    await transport.playCyclePlan({
      slots: [
        { kind: "fixture", fixture: initialFixture },
        { kind: "silence", durationUnits: 4 },
      ],
      cyclesPerPlan: 2,
      nextPlan,
      onPlanBoundary,
      bpm: 120,
      beatFile,
      preloadSampleIds: ["synthBrush"],
    });

    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 1 });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05]);
    const beatSource = fake.sources.find(({ node }) => node.loop);

    fake.setCurrentTime(0.95);
    runScheduler();
    expect(nextPlan).toHaveBeenCalledWith({ completedRounds: 1, nextPlanIndex: 2 });
    expect(onPlanBoundary).not.toHaveBeenCalled();
    expect(transport.getSnapshot()).toMatchObject({ cyclePlanIndex: 1, cycleSlotIndex: 1, cycleSlotKind: "silence" });

    fake.setCurrentTime(2.05);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledTimes(1);
    expect(onPlanBoundary).toHaveBeenLastCalledWith({
      planIndex: 2,
      completedRounds: 2,
      plan: expect.objectContaining({ slots: expect.any(Array) }),
    });
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleIteration: 3 });

    fake.setCurrentTime(2.95);
    runScheduler();
    expect(nextPlan).toHaveBeenLastCalledWith({ completedRounds: 3, nextPlanIndex: 3 });
    fake.setCurrentTime(4.05);
    runScheduler();

    expect(onPlanBoundary).toHaveBeenCalledTimes(2);
    expect(onPlanBoundary).toHaveBeenLastCalledWith({
      planIndex: 3,
      completedRounds: 4,
      plan: expect.objectContaining({ slots: expect.any(Array) }),
    });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, 1.05, 2.05, 3.05, 4.05]);
    expect(fake.sources.filter(({ node }) => node.loop)).toHaveLength(1);
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.stopTimes).toEqual([]);
    transport.stop();
    transport.dispose();
  });

  it("schedules a prepared generated hit at the exact plan boundary and publishes only at that boundary", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const initialFixture: Fixture = {
      events: [{ id: "boundary-first", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const nextFixture: Fixture = {
      events: [{ id: "boundary-next", sampleId: "synthBrush", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const onPlanBoundary = vi.fn();
    const boundaryAt = 0.05 + 4 * 60 / 120 / 4;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: nextFixture }] }),
      onPlanBoundary,
      bpm: 120,
      preloadSampleIds: ["synthBrush"],
    });
    expect(onPlanBoundary).not.toHaveBeenCalled();

    fake.setCurrentTime(boundaryAt - 0.1);
    runScheduler();
    const sampleRecords = fake.sources.filter(({ node }) => !node.loop);
    const sampleStarts = sampleRecords.map(({ startTimes }) => startTimes[0]);
    expect(sampleStarts).toEqual([0.05, boundaryAt]);
    expect(sampleRecords[1]?.startOffsets).toEqual([0]);
    expect(onPlanBoundary).not.toHaveBeenCalled();
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 1 });

    fake.setCurrentTime(boundaryAt);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledWith({
      planIndex: 2,
      completedRounds: 1,
      plan: expect.objectContaining({ slots: expect.any(Array) }),
    });
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleIteration: 2 });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, boundaryAt]);
    transport.dispose();
  });

  it("allows an initially silent Auto-generate plan to advance into an audible plan", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const nextFixture: Fixture = {
      events: [{ id: "first-audible", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const onPlanBoundary = vi.fn();
    const boundaryAt = 0.05 + 4 * 60 / 120 / 4;

    await transport.playCyclePlan({
      slots: [{ kind: "silence", durationUnits: 4 }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: nextFixture }] }),
      onPlanBoundary,
      preloadSampleIds: ["synthPulse"],
      bpm: 120,
    });
    expect(fake.sources.filter(({ node }) => !node.loop)).toHaveLength(0);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 1, cycleSlotKind: "silence" });

    fake.setCurrentTime(boundaryAt - 0.1);
    runScheduler();
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([boundaryAt]);
    expect(onPlanBoundary).not.toHaveBeenCalled();

    fake.setCurrentTime(boundaryAt);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledTimes(1);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleSlotKind: "fixture" });
    transport.dispose();
  });

  it("rebuilds a prepared boundary hit at the rebased tempo without early publication", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const initialFixture: Fixture = {
      events: [{ id: "retime-initial", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const nextFixture: Fixture = {
      events: [{ id: "retime-next", sampleId: "synthBrush", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const onPlanBoundary = vi.fn();
    const rebasedBoundaryAt = 0.45 - ((0.45 - 0.05) / (60 / 120 / 4)) * (60 / 100 / 4)
      + 4 * 60 / 100 / 4;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: nextFixture }] }),
      onPlanBoundary,
      referenceBpm: 120,
      bpm: 120,
      preloadSampleIds: ["synthBrush"],
    });
    fake.setCurrentTime(0.45);
    transport.setTempo(100);
    expect(onPlanBoundary).not.toHaveBeenCalled();
    const cancelledOldBoundarySource = fake.sources.find(({ startTimes }) => startTimes[0] === 0.55);
    expect(cancelledOldBoundarySource?.stopTimes).toEqual([0]);

    fake.setCurrentTime(rebasedBoundaryAt - 0.1);
    runScheduler();
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, 0.55, rebasedBoundaryAt]);
    expect(fake.sources.filter(({ node }) => !node.loop).at(-1)?.startOffsets).toEqual([0]);
    expect(onPlanBoundary).not.toHaveBeenCalled();

    fake.setCurrentTime(rebasedBoundaryAt);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledTimes(1);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2 });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, 0.55, rebasedBoundaryAt]);
    transport.dispose();
  });

  it("continues from an all-silent generated plan into the following audible plan", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const fixtureFor = (id: string): Fixture => ({
      events: [{ id, sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    });
    const onPlanBoundary = vi.fn();
    const firstBoundaryAt = 0.05 + 4 * 60 / 120 / 4;
    const secondBoundaryAt = firstBoundaryAt + 4 * 60 / 120 / 4;
    const nextPlan = vi.fn(({ nextPlanIndex }: { completedRounds: number; nextPlanIndex: number }) => ({
      slots: nextPlanIndex === 2
        ? [{ kind: "silence" as const, durationUnits: 4 }]
        : [{ kind: "fixture" as const, fixture: fixtureFor("after-silent-plan") }],
    }));

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: fixtureFor("initial-audible") }],
      cyclesPerPlan: 1,
      nextPlan,
      onPlanBoundary,
      bpm: 120,
      preloadSampleIds: ["synthPulse"],
    });

    fake.setCurrentTime(firstBoundaryAt - 0.1);
    runScheduler();
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05]);
    expect(onPlanBoundary).not.toHaveBeenCalled();
    expect(nextPlan).toHaveBeenCalledWith({ completedRounds: 0, nextPlanIndex: 2 });

    fake.setCurrentTime(firstBoundaryAt);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledWith({
      planIndex: 2,
      completedRounds: 1,
      plan: expect.objectContaining({ slots: [{ kind: "silence", durationUnits: 4 }] }),
    });
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleSlotKind: "silence" });

    fake.setCurrentTime(secondBoundaryAt - 0.1);
    runScheduler();
    expect(nextPlan).toHaveBeenLastCalledWith({ completedRounds: 1, nextPlanIndex: 3 });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, secondBoundaryAt]);
    expect(onPlanBoundary).toHaveBeenCalledTimes(1);

    fake.setCurrentTime(secondBoundaryAt);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledTimes(2);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 3, cycleSlotKind: "fixture" });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, secondBoundaryAt]);
    transport.dispose();
  });

  it("stops launching queued candidate decodes after Stop and allows a newer playback", async () => {
    const pendingReads: Array<(bytes: ArrayBuffer) => void> = [];
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context);
    const candidateIds = Array.from({ length: 8 }, (_, index) => `queued-candidate-${index}`);
    const assets = new Map(candidateIds.map((id) => [id, {
      name: `${id}.wav`,
      arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>((resolve) => pendingReads.push(resolve))),
    } as unknown as File] as const));
    const initialFixture: Fixture = {
      events: [{ id: "queued-initial", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    const pendingPlay = transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: initialFixture }] }),
      preloadSampleIds: candidateIds,
      assets,
      bpm: 120,
    });
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(pendingReads).toHaveLength(4);

    transport.stop();
    for (const resolveRead of pendingReads) resolveRead(new ArrayBuffer(1));
    await pendingPlay;

    expect([...assets.values()].reduce((total, file) => total + vi.mocked(file.arrayBuffer).mock.calls.length, 0)).toBe(4);
    expect(fake.context.decodeAudioData).toHaveBeenCalledTimes(4);
    await transport.play({ fixture: initialFixture, bpm: 120 });
    expect(transport.getSnapshot().status).toBe("playing");
    transport.dispose();
  });

  it("finishes the current full round before reporting a synchronous provider failure", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const beatFile = {
      name: "provider-error-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const oneRound: Fixture = {
      events: [{ id: "round-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const nextPlan = vi.fn(() => { throw new Error("fixture generation failed"); });

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: oneRound }],
      cyclesPerPlan: 1,
      nextPlan,
      bpm: 120,
      beatFile,
    });
    expect(nextPlan).toHaveBeenCalledTimes(1);
    expect(fake.sources.find(({ node }) => !node.loop)?.startTimes).toEqual([0.05]);
    expect(transport.getSnapshot().status).toBe("playing");

    fake.setCurrentTime(0.54);
    runScheduler();
    expect(transport.getSnapshot().status).toBe("playing");
    fake.setCurrentTime(0.55);
    runScheduler();

    expect(transport.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("fixture generation failed"),
    });
    expect(fake.sources.find(({ node }) => node.loop)?.stopTimes).toEqual([0]);
    transport.dispose();
  });

  it("cancels auto-generation preloads on Stop without calling the provider", async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    const decodePromise = new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    const fake = makeFakeAudioContext(() => decodePromise);
    const { transport } = makeTransport(fake.context);
    const futureFile = {
      name: "future-sample.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const initialFixture: Fixture = {
      events: [{ id: "current-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    const nextPlan = vi.fn(() => ({ slots: [{ kind: "fixture" as const, fixture: initialFixture }] }));

    const pendingPlay = transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan,
      preloadSampleIds: ["future-sample"],
      assets: new Map([["future-sample", futureFile]]),
      bpm: 120,
    });
    await Promise.resolve();
    await Promise.resolve();
    transport.stop();
    resolveDecode(makeBuffer());
    await pendingPlay;

    expect(nextPlan).not.toHaveBeenCalled();
    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("preloads candidate and beat files with bounded decode concurrency", async () => {
    let activeDecodes = 0;
    let maxActiveDecodes = 0;
    const fake = makeFakeAudioContext(async () => {
      activeDecodes += 1;
      maxActiveDecodes = Math.max(maxActiveDecodes, activeDecodes);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      activeDecodes -= 1;
      return makeBuffer();
    });
    const { transport } = makeTransport(fake.context);
    const candidateIds = Array.from({ length: 6 }, (_, index) => `candidate-${index}`);
    const assets = new Map(candidateIds.map((id) => [id, {
      name: `${id}.wav`,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File] as const));
    const beatFile = {
      name: "bounded-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const initialFixture: Fixture = {
      events: [{ id: "current", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({
        slots: [{ kind: "fixture", fixture: {
          events: [{ id: "future", sampleId: candidateIds[0]!, startUnits: 0, durationUnits: 4, silent: false }],
          totalUnits: 4,
        } }],
      }),
      preloadSampleIds: candidateIds,
      assets,
      beatFile,
      bpm: 120,
    });

    expect(maxActiveDecodes).toBe(4);
    expect(fake.context.decodeAudioData).toHaveBeenCalledTimes(7);
    expect(transport.getSnapshot().status).toBe("playing");
    transport.dispose();
  });

  it("applies a live tempo change at a generated plan boundary without resetting beat phase", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport } = makeTransport(fake.context, async () => processor.node);
    const beatFile = {
      name: "auto-tempo-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const fixtureFor = (id: string, sampleId: string): Fixture => ({
      events: [{ id, sampleId, startUnits: 0, durationUnits: 16, silent: false }],
      totalUnits: 16,
    });
    const nextFixture = fixtureFor("next-plan-hit", "synthBrush");
    const nextPlan = vi.fn(() => ({ slots: [{ kind: "fixture" as const, fixture: nextFixture }] }));
    const onPlanBoundary = vi.fn();

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: fixtureFor("first-plan-hit", "synthPulse") }],
      cyclesPerPlan: 1,
      nextPlan,
      onPlanBoundary,
      referenceBpm: 85,
      bpm: 85,
      unitsPerBeat: 16,
      beatFile,
      preloadSampleIds: ["synthBrush"],
    });
    const beatSource = fake.sources.find(({ node }) => node.loop);
    const boundaryAt = 0.05 + 16 * 60 / 85 / 16;
    fake.setCurrentTime(boundaryAt);

    transport.setTempo(100);

    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleIteration: 2 });
    expect(onPlanBoundary).toHaveBeenCalledWith({ planIndex: 2, completedRounds: 1, plan: expect.any(Object) });
    expect(fake.sources.filter(({ node }) => !node.loop).map(({ startTimes }) => startTimes[0])).toEqual([0.05, boundaryAt]);
    expect(fake.sources.filter(({ node }) => node.loop)).toHaveLength(1);
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.stopTimes).toEqual([]);
    expect(beatSource?.node.playbackRate.value).toBeCloseTo(100 / 85);
    expect(fake.sources.at(-1)?.node.playbackRate.value).toBeCloseTo(100 / 85);
    transport.stop();
    transport.dispose();
  });

  it("reschedules only not-yet-started generated hits after tempo changes at the boundary", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const initialFixture: Fixture = {
      events: [{ id: "boundary-tempo-first", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 16,
    };
    const generatedFixture: Fixture = {
      events: [
        { id: "boundary-tempo-tick-zero", sampleId: "synthBrush", startUnits: 0, durationUnits: 1, silent: false },
        { id: "boundary-tempo-next-tick", sampleId: "synthBrush", startUnits: 1, durationUnits: 1, silent: false },
      ],
      totalUnits: 16,
    };
    const nextPlan = vi.fn(() => ({ slots: [{ kind: "fixture" as const, fixture: generatedFixture }] }));
    const boundaryAt = 0.05 + 16 * 60 / 85 / 16;
    const oldNextHitAt = boundaryAt + 60 / 85 / 16;
    const newNextHitAt = boundaryAt + 60 / 100 / 16;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: initialFixture }],
      cyclesPerPlan: 1,
      nextPlan,
      referenceBpm: 85,
      bpm: 85,
      unitsPerBeat: 16,
      preloadSampleIds: ["synthBrush"],
    });
    fake.setCurrentTime(boundaryAt - 0.05);
    runScheduler();
    const tickZeroSource = fake.sources.find(({ startTimes }) => startTimes[0] === boundaryAt);
    const oldFutureSource = fake.sources.find(({ startTimes }) => startTimes[0] === oldNextHitAt);
    expect(tickZeroSource).toBeDefined();
    expect(oldFutureSource).toBeDefined();

    fake.setCurrentTime(boundaryAt);
    transport.setTempo(100);

    expect(tickZeroSource?.stopTimes).toEqual([]);
    expect(oldFutureSource?.stopTimes).toEqual([0]);
    expect(fake.sources.filter(({ startTimes }) => startTimes[0] === boundaryAt)).toHaveLength(1);
    const rescheduledHit = fake.sources.find(({ startTimes }) => startTimes[0] === newNextHitAt);
    expect(rescheduledHit).toBeDefined();
    expect(rescheduledHit?.startOffsets).toEqual([0]);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleIteration: 2 });
    transport.dispose();
  });

  it("keeps generated cycle iteration monotonic after retiming mid-round", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const fixtureFor = (id: string): Fixture => ({
      events: [{ id, sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 16,
    });
    const nextPlan = vi.fn(() => ({ slots: [{ kind: "fixture" as const, fixture: fixtureFor("next-plan") }] }));
    const onPlanBoundary = vi.fn();
    const cycleSeconds = 16 * 60 / 85 / 16;
    const secondCycleStart = 0.05 + cycleSeconds;
    const retimeAt = secondCycleStart + 0.1;
    const positionUnits = 0.1 / (60 / 85 / 16);
    const rebasedCycleStart = retimeAt - positionUnits * (60 / 100 / 16);
    const nextPlanBoundary = rebasedCycleStart + 16 * 60 / 100 / 16;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: fixtureFor("two-round-plan") }],
      cyclesPerPlan: 2,
      nextPlan,
      onPlanBoundary,
      referenceBpm: 85,
      bpm: 85,
      unitsPerBeat: 16,
    });
    fake.setCurrentTime(retimeAt);
    runScheduler();
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 1, cycleIteration: 2 });
    expect(nextPlan).toHaveBeenCalledWith({ completedRounds: 1, nextPlanIndex: 2 });

    transport.setTempo(100);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 1, cycleIteration: 2 });
    fake.setCurrentTime(nextPlanBoundary);
    runScheduler();

    expect(onPlanBoundary).toHaveBeenCalledWith({ planIndex: 2, completedRounds: 2, plan: expect.any(Object) });
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cyclePlanIndex: 2, cycleIteration: 3 });
    transport.dispose();
  });

  it("bounds Auto-generate catch-up after a long scheduler gap", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const fixtureFor = (id: string): Fixture => ({
      events: [{ id, sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    });
    const nextPlan = vi.fn(() => ({ slots: [{ kind: "fixture" as const, fixture: fixtureFor("catch-up") }] }));
    const onPlanBoundary = vi.fn();
    const beatFile = {
      name: "catch-up-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: fixtureFor("initial-catch-up") }],
      cyclesPerPlan: 1,
      nextPlan,
      onPlanBoundary,
      beatFile,
      bpm: 120,
    });
    const beatSource = fake.sources.find(({ node }) => node.loop);
    fake.setCurrentTime(5 * 60 * 60);
    runScheduler();

    expect(transport.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("fell too far behind the audio clock"),
    });
    expect(nextPlan.mock.calls.length).toBeLessThanOrEqual(65);
    expect(onPlanBoundary.mock.calls.length).toBeLessThanOrEqual(64);
    expect(beatSource?.stopTimes).toEqual([0]);
    transport.dispose();
  });

  it("changes sample and beat gain independently without restarting either source", async () => {
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context);
    const beatFile = {
      name: "levels-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: { events: [fixture.events[0]!], totalUnits: 4 } }],
      bpm: 120,
      beatFile,
      sampleVolume: 80,
      beatVolume: 30,
    });

    const originalStarts = fake.sources.map(({ startTimes }) => [...startTimes]);
    expect(fake.gains.map(({ gain }) => gain.value)).toEqual([0.8, 0.3]);

    transport.setSampleVolume(40);
    expect(fake.gains.map(({ gain }) => gain.value)).toEqual([0.4, 0.3]);

    transport.setBeatVolume(75);
    expect(fake.gains.map(({ gain }) => gain.value)).toEqual([0.4, 0.75]);
    expect(fake.sources.map(({ startTimes }) => startTimes)).toEqual(originalStarts);
    expect(fake.sources.find(({ node }) => node.loop)?.stopTimes).toEqual([]);
    transport.dispose();
  });

  it("retimes active cycles at the same musical position without restarting the beat bed", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const beatFile = {
      name: "tempo-beat.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const tempoFixture: Fixture = {
      events: [
        { id: "start", sampleId: "synthPulse", startUnits: 0, durationUnits: 2, silent: false },
        { id: "middle", sampleId: "synthBrush", startUnits: 6, durationUnits: 2, silent: false },
        { id: "end", sampleId: "synthPulse", startUnits: 12, durationUnits: 2, silent: false },
      ],
      totalUnits: 16,
    };

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: tempoFixture }],
      referenceBpm: 85,
      bpm: 85,
      unitsPerBeat: 16,
      beatFile,
    });
    fake.setCurrentTime(0.25);
    runScheduler();

    const beatSource = fake.sources.find(({ node }) => node.loop);
    const oldFutureSource = fake.sources.find(({ startTimes }) => startTimes[0] === 0.05 + 6 * 60 / 85 / 16);
    expect(oldFutureSource).toBeDefined();
    expect(oldFutureSource?.stopTimes).toEqual([]);

    transport.setTempo(100);
    transport.setPitchSemitones(3);

    expect(processor.playbackRate.value).toBeCloseTo(100 / 85);
    expect(processor.pitchSemitones.value).toBe(3);
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.stopTimes).toEqual([]);
    expect(beatSource?.node.playbackRate.value).toBeCloseTo(100 / 85);
    expect(oldFutureSource?.stopTimes).toEqual([0]);

    runScheduler();
    const replacement = fake.sources.find(({ startTimes, node }) =>
      !node.loop && startTimes[0] !== 0.05 && startTimes[0] !== oldFutureSource?.startTimes[0]);
    expect(replacement?.startTimes[0]).toBeCloseTo(0.25 + (6 - ((0.25 - 0.05) / (60 / 85 / 16))) * 60 / 100 / 16, 10);
    expect(replacement?.node.playbackRate.value).toBeCloseTo(100 / 85);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cycleIteration: 1 });

    fake.setCurrentTime(0.85);
    transport.setTempo(90);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cycleIteration: 2 });
    fake.setCurrentTime(1.5);
    transport.setTempo(100);
    expect(transport.getSnapshot()).toMatchObject({ status: "playing", cycleIteration: 3 });
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.node.playbackRate.value).toBeCloseTo(100 / 85);
    transport.stop();
    transport.dispose();
  });

  it("keeps a finite audition's tick-zero hit when tempo changes during the initial lead-in", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport } = makeTransport(fake.context, async () => processor.node);
    const oneHit: Fixture = {
      events: [{ id: "first-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.play({ fixture: oneHit, referenceBpm: 85, bpm: 85 });
    expect(fake.sources[0]?.startTimes).toEqual([0.05]);

    transport.setTempo(100);

    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[0]?.stopTimes).toEqual([0]);
    expect(fake.sources[1]?.startTimes).toEqual([0.05]);
    expect(transport.getSnapshot().status).toBe("playing");
    transport.stop();
    transport.dispose();
  });

  it("keeps a cycle plan's first tick-zero hit when tempo changes during the initial lead-in", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport } = makeTransport(fake.context, async () => processor.node);
    const oneHit: Fixture = {
      events: [{ id: "first-cycle-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: oneHit }],
      referenceBpm: 85,
      bpm: 85,
    });
    expect(fake.sources[0]?.startTimes).toEqual([0.05]);

    transport.setTempo(100);

    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[0]?.stopTimes).toEqual([0]);
    expect(fake.sources[1]?.startTimes).toEqual([0.05]);
    expect(transport.getSnapshot()).toMatchObject({
      status: "playing",
      cycleSlotIndex: 0,
      cycleIteration: 1,
      cycleSlotKind: "fixture",
    });
    transport.stop();
    transport.dispose();
  });

  it("keeps finite sample-tail completion anchored through repeated tempo changes", async () => {
    const fake = makeFakeAudioContext(async () => makeBuffer(2));
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const sampleFile = {
      name: "two-second.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const shortFixture: Fixture = {
      events: [{ id: "long-hit", sampleId: "long-hit", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.play({
      fixture: shortFixture,
      referenceBpm: 120,
      bpm: 120,
      assets: new Map([["long-hit", sampleFile]]),
    });
    expect(transport.getSnapshot().status).toBe("playing");

    fake.setCurrentTime(1.5);
    transport.setTempo(100);
    fake.setCurrentTime(1.8);
    transport.setTempo(90);

    fake.setCurrentTime(2.19);
    runScheduler();
    expect(transport.getSnapshot().status).toBe("playing");
    fake.setCurrentTime(2.21);
    runScheduler();
    expect(transport.getSnapshot().status).toBe("completed");
    transport.dispose();
  });

  it("reports worklet failure instead of silently playing at the wrong pitch", async () => {
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context, async () => { throw new Error("worklet blocked"); });

    await transport.play({ fixture, referenceBpm: 85, bpm: 85 });

    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toMatchObject({ status: "error", error: expect.stringContaining("worklet blocked") });
    transport.dispose();
  });

  it("disconnects a worklet that resolves after Stop without starting sources", async () => {
    let resolveProcessor!: (processor: AudioNode) => void;
    const processorPromise = new Promise<AudioNode>((resolve) => { resolveProcessor = resolve; });
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context, () => processorPromise);
    const processor = makeProcessor();

    const pendingPlay = transport.play({ fixture, referenceBpm: 85, bpm: 85 });
    await Promise.resolve();
    await Promise.resolve();
    transport.stop();
    resolveProcessor(processor.node);
    await pendingPlay;

    expect(processor.node.disconnect).toHaveBeenCalled();
    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("does not stop a sample tail when a silent cycle slot begins", async () => {
    const fake = makeFakeAudioContext(async () => makeBuffer(1.25));
    const { transport, runScheduler } = makeTransport(fake.context);
    const sampleFile = {
      name: "long-tail.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const tailFixture: Fixture = {
      events: [{ id: "tail", sampleId: "tail-sample", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({
      slots: [
        { kind: "fixture", fixture: tailFixture },
        { kind: "silence", durationUnits: 4 },
      ],
      bpm: 120,
      assets: new Map([["tail-sample", sampleFile]]),
    });

    const activeTail = fake.sources[0];
    expect(activeTail?.startTimes).toEqual([0.05]);
    fake.setCurrentTime(0.6);
    runScheduler();

    expect(transport.getSnapshot()).toMatchObject({ cycleSlotIndex: 1, cycleSlotKind: "silence" });
    expect(fake.sources).toHaveLength(1);
    expect(activeTail?.stopTimes).toEqual([]);
    transport.stop();
    transport.dispose();
  });

  it("skips fully expired cycle passes after a delayed scheduler wake", async () => {
    const fake = makeFakeAudioContext();
    const { transport, runScheduler } = makeTransport(fake.context);
    const oneCycleFixture: Fixture = {
      events: [{ id: "wake-hit", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({ slots: [{ kind: "fixture", fixture: oneCycleFixture }], bpm: 120 });
    fake.setCurrentTime(100_000);
    runScheduler();

    expect(fake.sources.map(({ startTimes }) => startTimes[0])).toHaveLength(2);
    expect(fake.sources[1]?.startTimes[0]).toBeCloseTo(100_000.05, 6);
    expect(transport.getSnapshot().status).toBe("playing");
    transport.dispose();
  });

  it("stops a pending cycle-plan decode from starting audio after Stop", async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    const decodePromise = new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    const fake = makeFakeAudioContext(() => decodePromise);
    const { transport } = makeTransport(fake.context);
    const sampleFile = {
      name: "cycle.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const cycleFixture: Fixture = {
      events: [{ id: "cycle-sample", sampleId: "cycle-sample", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    const pendingPlay = transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: cycleFixture }],
      bpm: 120,
      assets: new Map([["cycle-sample", sampleFile]]),
    });
    await Promise.resolve();
    await Promise.resolve();
    transport.stop();
    resolveDecode(makeBuffer());
    await pendingPlay;

    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("reports a cycle-plan sample decode failure without starting audio", async () => {
    const fake = makeFakeAudioContext(async () => { throw new Error("WAV decode failed"); });
    const { transport } = makeTransport(fake.context);
    const sampleFile = {
      name: "broken.wav",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    const cycleFixture: Fixture = {
      events: [{ id: "broken-sample", sampleId: "broken-sample", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: cycleFixture }],
      bpm: 120,
      assets: new Map([["broken-sample", sampleFile]]),
    });

    expect(fake.sources).toHaveLength(0);
    expect(transport.getSnapshot()).toMatchObject({
      status: "error",
      error: "WAV decode failed",
    });
    transport.dispose();
  });

  it("reports invalid BPM as an actionable error without creating audio", async () => {
    const fake = makeFakeAudioContext();
    const contextFactory = vi.fn(() => fake.context);
    const transport = new AudioTransport({ audioContextFactory: contextFactory });

    await transport.play({ fixture, bpm: 0 });

    expect(contextFactory).not.toHaveBeenCalled();
    expect(transport.getSnapshot()).toMatchObject({
      status: "error",
      error: "BPM must be a finite number greater than zero.",
    });
    transport.dispose();
  });
});
