import { describe, expect, it, vi } from "vitest";
import { AudioTransport } from "./AudioTransport";
import type { Fixture } from "../domain";

interface FakeSourceRecord {
  readonly node: AudioBufferSourceNode;
  readonly startTimes: number[];
  readonly startOffsets: number[];
  readonly stopTimes: number[];
}

interface FakeKeepAliveRecord {
  readonly node: ConstantSourceNode;
  readonly startTimes: number[];
  readonly stopTimes: number[];
}

function makeBuffer(duration = 0.2, sampleRate = 48_000): AudioBuffer {
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
  let outputLatencySeconds = 0;
  let fixedOutputContextTime: number | undefined;
  let state: AudioContextState = "suspended";
  const sources: FakeSourceRecord[] = [];
  const keepAliveSources: FakeKeepAliveRecord[] = [];
  const gains: GainNode[] = [];
  const contextLike = {
    get currentTime() { return currentTime; },
    get state() { return state; },
    getOutputTimestamp: vi.fn(() => ({
      contextTime: fixedOutputContextTime ?? Math.max(0, currentTime - outputLatencySeconds),
      performanceTime: globalThis.performance.now(),
    })),
    sampleRate: 48_000,
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
    createConstantSource: vi.fn(() => {
      const startTimes: number[] = [];
      const stopTimes: number[] = [];
      let node: ConstantSourceNode;
      const sourceLike = {
        offset: makeFakeParam(0),
        onended: null as ConstantSourceNode["onended"],
        start: vi.fn((when = 0) => { startTimes.push(when); }),
        stop: vi.fn((when = 0) => { stopTimes.push(when); }),
        connect: vi.fn(() => node),
        disconnect: vi.fn(),
      };
      node = sourceLike as unknown as ConstantSourceNode;
      keepAliveSources.push({ node, startTimes, stopTimes });
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
    keepAliveSources,
    gains,
    setCurrentTime: (value: number) => { currentTime = value; },
    setOutputLatency: (value: number) => { outputLatencySeconds = value; },
    setOutputContextTime: (value: number | undefined) => { fixedOutputContextTime = value; },
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

function makeBeatFile(name: string): File {
  const bytes = new ArrayBuffer(46);
  const view = new DataView(bytes);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, 2, true);
  return {
    name,
    type: "audio/wav",
    size: bytes.byteLength,
    arrayBuffer: vi.fn(async () => bytes.slice(0)),
  } as unknown as File;
}

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

  it("separates scheduler progress from output-clock presentation through SoundTouch", async () => {
    const fake = makeFakeAudioContext();
    fake.setOutputLatency(0.04);
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const beatBuffer = makeBuffer(2);

    await transport.play({
      fixture,
      referenceBpm: 85,
      bpm: 85,
      beatBuffer,
      beatPlaybackRegion: { startOffsetSeconds: 0.25, loopEndSeconds: 1.75 },
    });
    const beatSource = fake.sources.find(({ node }) => node.loop);
    expect(beatSource?.startOffsets).toEqual([0.25]);
    expect(beatSource?.node.loopStart).toBeCloseTo(0.25);
    expect(beatSource?.node.loopEnd).toBeCloseTo(1.75);
    expect(transport.getSnapshot().presentation).toMatchObject({
      started: false,
      progress: 0,
      positionUnits: 0,
      estimatedProcessorDelaySeconds: 0.13,
      drainSeconds: 0.15,
    });

    fake.setCurrentTime(0.219);
    runScheduler();
    expect(transport.getSnapshot().progress).toBeGreaterThan(0.07);
    expect(transport.getSnapshot().presentation).toMatchObject({ started: false, progress: 0, positionUnits: 0 });

    fake.setCurrentTime(0.222);
    runScheduler();
    const presentation = transport.getSnapshot().presentation;
    expect(presentation?.started).toBe(true);
    expect(presentation?.progress).toBeLessThan(0.01);
    expect(presentation?.positionUnits).toBeGreaterThanOrEqual(0);
    expect(presentation?.positionUnits).toBeLessThan(0.1);
    expect(presentation?.progress).toBeLessThan(transport.getSnapshot().progress);
    transport.stop();
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    transport.dispose();
  });

  it("keeps the finite run active until outputTimestamp passes its final scheduled frame", async () => {
    const fake = makeFakeAudioContext();
    fake.setOutputLatency(0.04);
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const shortFixture: Fixture = {
      events: [{ id: "finite-end", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };

    await transport.play({ fixture: shortFixture, referenceBpm: 85, bpm: 85 });
    expect(fake.keepAliveSources).toHaveLength(1);
    expect(fake.keepAliveSources[0]?.startTimes).toEqual([0.05]);
    expect(fake.keepAliveSources[0]?.stopTimes[0]).toBeCloseTo(
      0.05 + 4 * 60 / 85 / 4 + 0.15,
      10,
    );
    fake.setCurrentTime(0.80); // Output has passed the WAV end, but the measured DSP drain remains.
    runScheduler();
    expect(transport.getSnapshot().status).toBe("playing");
    const scheduledDrainEnd = fake.keepAliveSources[0]?.stopTimes[0];
    transport.setTempo(100); // A slider change in the tail cannot move the finite end again.
    expect(fake.keepAliveSources[0]?.stopTimes[0]).toBe(scheduledDrainEnd);
    expect(processor.playbackRate.value).toBeCloseTo(100 / 85);

    fake.setCurrentTime(0.96);
    runScheduler();
    expect(transport.getSnapshot()).toMatchObject({
      status: "completed",
      progress: 1,
      presentation: { started: true, progress: 1, positionUnits: 4 },
    });
    expect(fake.keepAliveSources[0]?.stopTimes.at(-1)).toBe(0);
    transport.dispose();
  });

  it("uses the context clock when outputTimestamp is invalid", async () => {
    const fake = makeFakeAudioContext();
    fake.setOutputContextTime(Number.NaN);
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);

    await transport.play({ fixture, referenceBpm: 85, bpm: 85 });
    fake.setCurrentTime(0.20);
    runScheduler();
    expect(transport.getSnapshot().presentation?.started).toBe(true);
    transport.stop();
    transport.dispose();
  });

  it("keeps output-clock presentation monotonic when a timestamp repeats or regresses", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);

    await transport.play({ fixture, referenceBpm: 85, bpm: 85 });
    fake.setCurrentTime(0.40);
    fake.setOutputContextTime(0.25);
    runScheduler();
    const first = transport.getSnapshot().presentation!.positionUnits;

    fake.setCurrentTime(0.50);
    fake.setOutputContextTime(0.20);
    runScheduler();
    const repeated = transport.getSnapshot().presentation!.positionUnits;
    expect(repeated).toBeGreaterThanOrEqual(first);

    fake.setCurrentTime(0.60);
    fake.setOutputContextTime(0.35);
    runScheduler();
    expect(transport.getSnapshot().presentation!.positionUnits).toBeGreaterThan(repeated);
    transport.stop();
    transport.dispose();
  });

  it("keeps the estimated heard position monotonic across live tempo epochs", async () => {
    const fake = makeFakeAudioContext();
    fake.setOutputLatency(0.04);
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const longFixture: Fixture = {
      events: [{ id: "tempo-epoch", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 40,
    };

    await transport.play({ fixture: longFixture, referenceBpm: 85, bpm: 85 });
    fake.setCurrentTime(0.30);
    runScheduler();
    const beforeChange = transport.getSnapshot().presentation!.positionUnits;
    transport.setTempo(100);
    const atChange = transport.getSnapshot().presentation!.positionUnits;
    expect(atChange).toBeGreaterThanOrEqual(beforeChange);

    fake.setCurrentTime(0.43); // Output still maps through the old tempo epoch.
    runScheduler();
    const beforeAudibleTempoChange = transport.getSnapshot().presentation!.positionUnits;
    fake.setCurrentTime(0.49); // Output cursor has crossed the tempo epoch boundary.
    runScheduler();
    const afterAudibleTempoChange = transport.getSnapshot().presentation!.positionUnits;
    expect(beforeAudibleTempoChange).toBeGreaterThanOrEqual(atChange);
    expect(afterAudibleTempoChange).toBeGreaterThan(beforeAudibleTempoChange);
    transport.stop();
    transport.dispose();
  });

  it("bounds unpresented tempo history during rapid live adjustments", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport } = makeTransport(fake.context, async () => processor.node);
    const longFixture: Fixture = {
      events: [{ id: "rapid-tempo-history", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 128,
    };
    await transport.play({ fixture: longFixture, referenceBpm: 85, bpm: 85 });

    for (let index = 0; index < 70; index += 1) {
      fake.setCurrentTime(0.1 + index * 0.001);
      transport.setTempo(index % 2 === 0 ? 100 : 85);
    }

    const playback = Reflect.get(transport, "activePlayback") as { presentationEpochs: readonly unknown[] };
    expect(playback.presentationEpochs.length).toBeLessThanOrEqual(64);
    expect(transport.getSnapshot().presentation?.positionUnits).toBeGreaterThanOrEqual(0);
    transport.stop();
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
    const beatFile = makeBeatFile("beat.wav");

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
    const beatFile = makeBeatFile("beat.wav");
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
    const beatFile = makeBeatFile("looping-beat.wav");

    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: { events: [fixture.events[0]!], totalUnits: 4 } }],
      bpm: 120,
      beatFile,
    });

    const beatSource = fake.sources.find(({ node }) => node.loop);
    expect(beatSource?.startTimes).toEqual([0.05]);
    expect(beatSource?.startOffsets).toEqual([0]);
    expect(beatSource?.node.loopStart).toBe(0);
    expect(beatSource?.node.loopEnd).toBe(0);
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
    const beatFile = makeBeatFile("auto-generate-beat.wav");
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
      beatPlaybackRegion: { startOffsetSeconds: 0.025, loopEndSeconds: 0.175 },
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
    expect(beatSource?.startOffsets).toEqual([0.025]);
    expect(beatSource?.node.loopStart).toBeCloseTo(0.025);
    expect(beatSource?.node.loopEnd).toBeCloseTo(0.175);
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

  it("holds generated-plan presentation and callback until the estimated output boundary", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const fixtureFor = (id: string): Fixture => ({
      events: [{ id, sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    });
    let callbackRan = false;
    const seenPlanSnapshots: number[] = [];
    const onPlanBoundary = vi.fn(() => { callbackRan = true; });

    const play = transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: fixtureFor("presented-first") }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: fixtureFor("presented-next") }] }),
      onPlanBoundary,
      referenceBpm: 120,
      bpm: 120,
    });
    transport.subscribe((snapshot) => {
      if (snapshot.presentation?.cyclePlanIndex === 2) {
        expect(callbackRan).toBe(true);
        seenPlanSnapshots.push(snapshot.presentation.cyclePlanIndex);
      }
    });
    await play;

    const boundaryAt = 0.05 + 4 * 60 / 120 / 4;
    fake.setCurrentTime(boundaryAt);
    runScheduler();
    expect(transport.getSnapshot()).toMatchObject({
      cyclePlanIndex: 2,
      presentation: { cyclePlanIndex: 1, cycleSlotKind: "fixture" },
    });
    expect(onPlanBoundary).not.toHaveBeenCalled();

    fake.setCurrentTime(boundaryAt + 0.12);
    runScheduler();
    expect(onPlanBoundary).not.toHaveBeenCalled();
    expect(transport.getSnapshot().presentation?.cyclePlanIndex).toBe(1);

    fake.setCurrentTime(boundaryAt + 0.14);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledWith({
      planIndex: 2,
      completedRounds: 1,
      plan: expect.any(Object),
    });
    expect(transport.getSnapshot().presentation).toMatchObject({
      started: true,
      cyclePlanIndex: 2,
      cycleIteration: 2,
      cycleSlotIndex: 0,
      cycleSlotKind: "fixture",
    });
    expect(seenPlanSnapshots).toEqual([2]);
    transport.stop();
    transport.dispose();
  });

  it("does not fire queued presentation callbacks after the first callback stops playback", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const tinyFixture: Fixture = {
      events: [{ id: "rapid-boundary", sampleId: "synthPulse", startUnits: 0, durationUnits: 0.08, silent: false }],
      totalUnits: 0.08,
    };
    const onPlanBoundary = vi.fn(() => transport.stop());
    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: tinyFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: tinyFixture }] }),
      onPlanBoundary,
      referenceBpm: 85,
      bpm: 85,
    });

    fake.setCurrentTime(0.30);
    runScheduler();
    expect(onPlanBoundary).toHaveBeenCalledTimes(1);
    expect(transport.getSnapshot()).toEqual({ status: "idle", progress: 0 });
    expect(fake.keepAliveSources[0]?.stopTimes.at(-1)).toBe(0);
    transport.dispose();
  });

  it("keeps the audible Q&A fixture slot visible until the response slot reaches output", async () => {
    const fake = makeFakeAudioContext();
    const processor = makeProcessor();
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const answerFixture: Fixture = {
      events: [{ id: "qa-heard-answer", sampleId: "synthPulse", startUnits: 0, durationUnits: 4, silent: false }],
      totalUnits: 4,
    };
    await transport.playCyclePlan({
      slots: [{ kind: "fixture", fixture: answerFixture }],
      cyclesPerPlan: 1,
      nextPlan: () => ({ slots: [{ kind: "fixture", fixture: answerFixture }] }),
      referenceBpm: 120,
      bpm: 120,
    });
    expect(transport.getSnapshot().presentation?.cyclePlanIndex).toBe(1);
    transport.stop();

    await transport.playCyclePlan({
      slots: [
        { kind: "fixture", fixture: answerFixture },
        { kind: "silence", durationUnits: 4 },
      ],
      referenceBpm: 120,
      bpm: 120,
    });
    expect(transport.getSnapshot().presentation?.cyclePlanIndex).toBeUndefined();

    fake.setCurrentTime(0.65);
    runScheduler();
    expect(transport.getSnapshot()).toMatchObject({
      cycleSlotKind: "silence",
      presentation: { cycleSlotKind: "fixture", cycleSlotIndex: 0 },
    });

    fake.setCurrentTime(0.73);
    runScheduler();
    expect(transport.getSnapshot().presentation).toMatchObject({ cycleSlotKind: "silence", cycleSlotIndex: 1 });
    transport.stop();
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
    expect(onPlanBoundary).not.toHaveBeenCalled();
    fake.setCurrentTime(rebasedBoundaryAt + 0.14);
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
    const beatFile = makeBeatFile("provider-error-beat.wav");
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
    const beatFile = makeBeatFile("bounded-beat.wav");
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
    const { transport, runScheduler } = makeTransport(fake.context, async () => processor.node);
    const beatFile = makeBeatFile("auto-tempo-beat.wav");
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
    expect(onPlanBoundary).not.toHaveBeenCalled();
    fake.setCurrentTime(boundaryAt + 0.14);
    runScheduler();
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
    fake.setCurrentTime(nextPlanBoundary + 0.14);
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
    const beatFile = makeBeatFile("catch-up-beat.wav");

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
    const beatFile = makeBeatFile("levels-beat.wav");

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
    const beatFile = makeBeatFile("tempo-beat.wav");
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

  it("keeps scratch and custom beat pitch neutral with independent tempo references", async () => {
    const fake = makeFakeAudioContext();
    const sampleProcessor = makeProcessor();
    const beatProcessor = makeProcessor();
    const processors = [sampleProcessor, beatProcessor];
    const { transport } = makeTransport(fake.context, async () => processors.shift()!.node);
    const beatBuffer = makeBuffer(1, 48_000);

    await transport.play({
      fixture,
      referenceBpm: 85,
      beatReferenceBpm: 120,
      bpm: 100,
      pitchSemitones: 0,
      beatBuffer,
      beatPlaybackRegion: { startOffsetSeconds: 0.125, loopEndSeconds: 0.75 },
    });

    const beatSource = fake.sources.find(({ node }) => node.loop);
    const sampleSource = fake.sources.find(({ node }) => !node.loop);
    expect(beatSource?.node.buffer).toBe(beatBuffer);
    expect(sampleProcessor.playbackRate.value).toBeCloseTo(100 / 85);
    expect(sampleSource?.node.playbackRate.value).toBeCloseTo(100 / 85);
    expect(beatProcessor.playbackRate.value).toBeCloseTo(100 / 120);
    expect(beatSource?.node.playbackRate.value).toBeCloseTo(100 / 120);
    expect(beatSource?.startOffsets).toEqual([0.125]);
    expect(beatSource?.node.loopStart).toBeCloseTo(0.125);
    expect(beatSource?.node.loopEnd).toBeCloseTo(0.75);
    expect(sampleProcessor.pitchSemitones.value).toBe(0);
    expect(beatProcessor.pitchSemitones.value).toBe(0);
    expect(fake.gains[0]?.connect).toHaveBeenCalledWith(sampleProcessor.node);
    expect(fake.gains[1]?.connect).toHaveBeenCalledWith(beatProcessor.node);
    expect(fake.keepAliveSources).toHaveLength(2);

    transport.setTempo(105);
    transport.setPitchSemitones(3);

    expect(sampleProcessor.playbackRate.value).toBeCloseTo(105 / 85);
    expect(fake.sources.filter(({ node }) => !node.loop).at(-1)?.node.playbackRate.value).toBeCloseTo(105 / 85);
    expect(beatProcessor.playbackRate.value).toBeCloseTo(105 / 120);
    expect(beatSource?.node.playbackRate.value).toBeCloseTo(105 / 120);
    expect(beatSource?.startOffsets).toEqual([0.125]);
    expect(beatSource?.node.loopStart).toBeCloseTo(0.125);
    expect(beatSource?.node.loopEnd).toBeCloseTo(0.75);
    expect(sampleProcessor.pitchSemitones.value).toBe(3);
    expect(beatProcessor.pitchSemitones.value).toBe(3);
    expect(fake.keepAliveSources.map(({ stopTimes }) => stopTimes.at(-1))).toEqual([
      fake.keepAliveSources[0]?.stopTimes.at(-1),
      fake.keepAliveSources[0]?.stopTimes.at(-1),
    ]);

    transport.dispose();
  });

  it("rejects a beat region that rounds to an empty decoded-frame range before scheduling", async () => {
    const fake = makeFakeAudioContext();
    const { transport } = makeTransport(fake.context);
    const beatBuffer = makeBuffer(1, 48_000);

    await transport.play({
      fixture,
      bpm: 120,
      beatBuffer,
      beatPlaybackRegion: {
        startOffsetSeconds: 0.25,
        loopEndSeconds: 0.25 + 0.1 / 48_000,
      },
    });

    expect(transport.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("at least one decoded audio frame"),
    });
    expect(fake.sources).toHaveLength(0);
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
    expect(transport.getSnapshot().status).toBe("playing");
    fake.setCurrentTime(2.40);
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
