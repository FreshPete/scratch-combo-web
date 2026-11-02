import type { Fixture } from "../domain";
import {
  createCyclePlanTimeline,
  createFixtureTimeline,
  rescaleCyclePlanTimeline,
  rescaleFixtureTimeline,
  type CyclePlanTimeline,
  type CycleSlot,
  type FixtureTimeline,
} from "./timeline";
import { createTempoPitchProcessor, type TempoPitchProcessorFactory, type TempoPitchProcessorNode } from "./TempoPitchProcessor";

export type TransportStatus = "idle" | "loading" | "playing" | "completed" | "error" | "disposed";

export interface TransportSnapshot {
  readonly status: TransportStatus;
  readonly progress: number;
  readonly error?: string;
  /** Zero-based slot index, present only during cycle-plan playback. */
  readonly cycleSlotIndex?: number;
  /** One-based repetition number, present only during cycle-plan playback. */
  readonly cycleIteration?: number;
  /** Current slot type, present only during cycle-plan playback. */
  readonly cycleSlotKind?: CycleSlot["kind"];
}

export interface PlayOptions {
  readonly fixture: Fixture;
  /** Imported preset's original BPM. Live tempo scales from this reference. */
  readonly referenceBpm?: number;
  readonly bpm: number;
  /** Independent pitch shift in semitones. Defaults to zero. */
  readonly pitchSemitones?: number;
  /** Fixture units per quarter-note beat. Defaults to 4 sixteenth-note units; legacy raw ticks use 16. */
  readonly unitsPerBeat?: number;
  /** Selected local WAV files keyed by fixture sample id. Files stay in session memory. */
  readonly assets?: ReadonlyMap<string, File>;
  /** Optional local beat WAV. It loops gaplessly through the run. */
  readonly beatFile?: File;
  /** Optional 0–100 percent volume from the normalized preset model. */
  readonly beatVolume?: number;
  /** Optional 0–100 percent volume from the normalized preset model. */
  readonly sampleVolume?: number;
}

export interface CyclePlanOptions extends Omit<PlayOptions, "fixture"> {
  /** Ordered slots repeat indefinitely until Stop, replacement Play, or disposal. */
  readonly slots: readonly CycleSlot[];
}

export interface AudioTransportOptions {
  /** Injection seam for deterministic scheduler tests. Production uses one browser AudioContext. */
  readonly audioContextFactory?: () => AudioContext;
  readonly scheduleInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly cancelInterval?: (handle: unknown) => void;
  readonly lookAheadSeconds?: number;
  readonly schedulerIntervalMs?: number;
  readonly startDelaySeconds?: number;
  /** Injection seam for deterministic tests. Production lazily loads SoundTouchJS. */
  readonly tempoPitchProcessorFactory?: TempoPitchProcessorFactory;
}

interface ActivePlayback {
  readonly generation: number;
  readonly context: AudioContext;
  timeline: FixtureTimeline;
  cyclePlan?: CyclePlanTimeline;
  startAt: number;
  fixtureEndAt: number;
  finishAt: number;
  readonly buffers: ReadonlyMap<string, AudioBuffer>;
  readonly sampleGain: GainNode;
  readonly beatGain?: GainNode;
  readonly beatSource?: AudioBufferSourceNode;
  readonly processor?: TempoPitchProcessorNode;
  readonly referenceBpm?: number;
  tempoRatio: number;
  pitchSemitones: number;
  cycleIterationBase: number;
  maxSampleDuration: number;
  nextEventIndex: number;
  nextCycleStartAt: number;
}

interface SampleSourceState {
  readonly startedAt: number;
}

const SYNTHETIC_SAMPLE_IDS = new Set(["synthPulse", "synthBrush", "synthSilence"]);
const DEFAULT_LOOK_AHEAD_SECONDS = 0.1;
const DEFAULT_SCHEDULER_INTERVAL_MS = 25;
const DEFAULT_START_DELAY_SECONDS = 0.05;

/**
 * Web Audio transport for finite fixtures and repeating cycle plans. One context is retained
 * for this session; event times are placed on its clock, not derived from React render time.
 */
export class AudioTransport {
  private context: AudioContext | undefined;
  private activePlayback: ActivePlayback | undefined;
  private intervalHandle: unknown;
  private generation = 0;
  private disposed = false;
  private fileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
  private syntheticBufferCache = new Map<string, AudioBuffer>();
  private selectedSampleVolume = 1;
  private selectedBeatVolume = 1;
  private selectedBpm: number | undefined;
  private selectedReferenceBpm: number | undefined;
  private selectedPitchSemitones = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly sampleSources = new Map<AudioBufferSourceNode, SampleSourceState>();
  private readonly outputNodes = new Set<AudioNode>();
  private readonly listeners = new Set<(snapshot: TransportSnapshot) => void>();
  private snapshot: TransportSnapshot = Object.freeze({ status: "idle", progress: 0 });

  private readonly contextFactory: () => AudioContext;
  private readonly scheduleInterval: (callback: () => void, intervalMs: number) => unknown;
  private readonly cancelInterval: (handle: unknown) => void;
  private readonly lookAheadSeconds: number;
  private readonly schedulerIntervalMs: number;
  private readonly startDelaySeconds: number;
  private readonly tempoPitchProcessorFactory: TempoPitchProcessorFactory;

  constructor(options: AudioTransportOptions = {}) {
    this.contextFactory = options.audioContextFactory ?? createBrowserAudioContext;
    this.scheduleInterval = options.scheduleInterval ?? ((callback, intervalMs) =>
      globalThis.setInterval(callback, intervalMs));
    this.cancelInterval = options.cancelInterval ?? ((handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
    this.lookAheadSeconds = positiveOption(options.lookAheadSeconds, DEFAULT_LOOK_AHEAD_SECONDS);
    this.schedulerIntervalMs = positiveOption(options.schedulerIntervalMs, DEFAULT_SCHEDULER_INTERVAL_MS);
    this.startDelaySeconds = positiveOption(options.startDelaySeconds, DEFAULT_START_DELAY_SECONDS);
    this.tempoPitchProcessorFactory = options.tempoPitchProcessorFactory ?? createTempoPitchProcessor;
  }

  subscribe = (listener: (snapshot: TransportSnapshot) => void): (() => void) => {
    if (this.disposed) {
      listener(this.snapshot);
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TransportSnapshot => this.snapshot;

  /** Read progress from the audio clock; UI code can poll this for display only. */
  getProgress = (): number => {
    const playback = this.activePlayback;
    if (!playback || this.snapshot.status !== "playing") {
      return this.snapshot.progress;
    }
    if (playback.cyclePlan) {
      return repeatingProgressAt(
        playback.context.currentTime,
        playback.startAt,
        playback.cyclePlan.totalSeconds,
      );
    }
    return progressAt(playback.context.currentTime, playback.startAt, playback.timeline.totalSeconds);
  };

  play = (options: PlayOptions): Promise<void> => this.startPlayback(
    options,
    () => ({ timeline: createFixtureTimeline(options.fixture, options.bpm, options.unitsPerBeat) }),
  );

  /** Play an explicit ordered cycle plan repeatedly until Stop or replacement playback. */
  playCyclePlan = (options: CyclePlanOptions): Promise<void> => this.startPlayback(
    options,
    () => {
      const cyclePlan = createCyclePlanTimeline(options.slots, options.bpm, options.unitsPerBeat);
      return { timeline: cyclePlan, cyclePlan };
    },
  );

  /** Update the active sample layer without changing its scheduled sources or phase. */
  setSampleVolume = (value: number): void => {
    const normalized = volumeValue(value, "Sample volume");
    this.selectedSampleVolume = normalized;
    const playback = this.activePlayback;
    if (playback && this.snapshot.status === "playing") {
      setGainValue(playback.sampleGain, normalized, playback.context.currentTime);
    }
  };

  /** Update the active beat layer without restarting its continuous source. */
  setBeatVolume = (value: number): void => {
    const normalized = volumeValue(value, "Beat volume");
    this.selectedBeatVolume = normalized;
    const playback = this.activePlayback;
    if (playback?.beatGain && this.snapshot.status === "playing") {
      setGainValue(playback.beatGain, normalized, playback.context.currentTime);
    }
  };

  /** Change tempo immediately while preserving the current musical position. */
  setTempo = (value: number): void => {
    const bpm = positiveBpm(value, "BPM");
    const playback = this.activePlayback;
    if (!playback) {
      if (this.snapshot.status === "loading" && this.selectedReferenceBpm !== undefined) {
        this.validateTempoRatio(bpm, this.selectedReferenceBpm);
        this.selectedBpm = bpm;
        return;
      }
      throw new Error("Live tempo changes are available during playback of an imported preset.");
    }
    if (!playback.processor || playback.referenceBpm === undefined) {
      throw new Error("Live tempo changes require playback started with an imported preset BPM.");
    }

    const tempoRatio = this.validateTempoRatio(bpm, playback.referenceBpm);
    this.selectedBpm = bpm;
    this.retimePlayback(playback, bpm, tempoRatio);
  };

  /** Change pitch independently from tempo on the live AudioWorklet processor. */
  setPitchSemitones = (value: number): void => {
    const pitchSemitones = pitchValue(value);
    const playback = this.activePlayback;
    if (playback?.processor) {
      this.selectedPitchSemitones = pitchSemitones;
      playback.pitchSemitones = pitchSemitones;
      setAudioParamValue(playback.processor.pitchSemitones, pitchSemitones, playback.context.currentTime);
      return;
    }
    if (this.snapshot.status === "loading") {
      if (pitchSemitones !== 0 && this.selectedReferenceBpm === undefined) {
        throw new Error("Live pitch changes require playback started with an imported preset BPM.");
      }
      this.selectedPitchSemitones = pitchSemitones;
      return;
    }
    if (this.snapshot.status === "playing" && pitchSemitones !== 0) {
      throw new Error("Live pitch changes require playback started with an imported preset BPM.");
    }
    this.selectedPitchSemitones = pitchSemitones;
  };

  private startPlayback = async (
    options: Omit<PlayOptions, "fixture">,
    createSchedule: () => { readonly timeline: FixtureTimeline; readonly cyclePlan?: CyclePlanTimeline },
  ): Promise<void> => {
    if (this.disposed) return;

    this.cancelRun();
    const generation = this.generation;
    this.publish({ status: "loading", progress: 0 });
    let pendingProcessor: TempoPitchProcessorNode | undefined;

    try {
      let { timeline, cyclePlan } = createSchedule();
      const bpm = positiveBpm(options.bpm, "BPM");
      const referenceBpm = options.referenceBpm === undefined
        ? undefined
        : positiveBpm(options.referenceBpm, "Reference BPM");
      const playbackReferenceBpm = referenceBpm ?? bpm;
      this.validateTempoRatio(bpm, playbackReferenceBpm);
      const initialPitch = pitchValue(options.pitchSemitones ?? this.selectedPitchSemitones);
      this.selectedBpm = bpm;
      this.selectedReferenceBpm = referenceBpm;
      this.selectedPitchSemitones = initialPitch;
      this.selectedSampleVolume = volumeValue(options.sampleVolume, "Sample volume");
      this.selectedBeatVolume = volumeValue(options.beatVolume, "Beat volume");
      const assets = options.assets ?? new Map<string, File>();
      const sampleIds = new Set(timeline.events.filter((event) => !event.silent).map((event) => event.sampleId));

      for (const sampleId of sampleIds) {
        if (!assets.has(sampleId) && !SYNTHETIC_SAMPLE_IDS.has(sampleId)) {
          throw new Error(`No audio file is selected for “${sampleId}”. Import its WAV file or use a demo sample.`);
        }
      }

      const context = this.getContext();
      if (context.state === "closed") {
        throw new Error("The audio session has closed. Reload the page to start a new audio session.");
      }

      // Call resume synchronously from Play, before awaiting any file reads or decodes.
      const resumePromise = context.state === "running" ? Promise.resolve() : context.resume();
      const processorPromise = referenceBpm !== undefined || initialPitch !== 0
        ? this.tempoPitchProcessorFactory(context).then((processor) => {
          pendingProcessor = processor;
          if (!this.isCurrent(generation)) disconnectNode(processor);
          return processor;
        })
        : Promise.resolve(undefined);
      const decodedSamples = new Map<string, Promise<AudioBuffer>>();
      for (const sampleId of sampleIds) {
        const file = assets.get(sampleId);
        decodedSamples.set(sampleId, file
          ? this.decodeFile(context, file)
          : Promise.resolve(this.getSyntheticBuffer(context, sampleId)));
      }
      const beatPromise = options.beatFile ? this.decodeFile(context, options.beatFile) : undefined;

      const [sampleEntries, beatBuffer, processor] = await Promise.all([
        Promise.all([...decodedSamples].map(async ([sampleId, bufferPromise]) => [sampleId, await bufferPromise] as const)),
        beatPromise ?? Promise.resolve(undefined),
        resumePromise,
        processorPromise,
      ]).then(([entries, beat, , worklet]) => [entries, beat, worklet] as const);

      if (!this.isCurrent(generation)) {
        if (processor) disconnectNode(processor);
        return;
      }

      const currentBpm = this.selectedBpm ?? bpm;
      const tempoRatio = this.validateTempoRatio(currentBpm, playbackReferenceBpm);
      const currentPitch = this.selectedPitchSemitones;
      if (currentBpm !== timeline.bpm) {
        timeline = cyclePlan
          ? rescaleCyclePlanTimeline(cyclePlan, currentBpm)
          : rescaleFixtureTimeline(timeline, currentBpm);
        if (cyclePlan) cyclePlan = timeline as CyclePlanTimeline;
      }

      const buffers = new Map<string, AudioBuffer>(sampleEntries);
      if (processor) {
        setAudioParamValue(processor.playbackRate, tempoRatio, context.currentTime);
        setAudioParamValue(processor.pitchSemitones, currentPitch, context.currentTime);
        processor.connect(context.destination);
        this.outputNodes.add(processor);
      }
      const output = processor ?? context.destination;
      const sampleGain = context.createGain();
      sampleGain.gain.value = this.selectedSampleVolume;
      sampleGain.connect(output);
      this.outputNodes.add(sampleGain);

      const startAt = context.currentTime + this.startDelaySeconds;
      const fixtureEndAt = startAt + timeline.totalSeconds;
      const beat = beatBuffer
        ? this.scheduleBeat(context, beatBuffer, startAt, cyclePlan ? undefined : fixtureEndAt, this.selectedBeatVolume, output, tempoRatio)
        : undefined;
      let finishAt = fixtureEndAt;
      let maxSampleDuration = 0;
      for (const event of timeline.events) {
        if (event.silent) continue;
        const buffer = buffers.get(event.sampleId);
        if (!buffer) continue;
        finishAt = Math.max(finishAt, startAt + event.offsetSeconds + buffer.duration / tempoRatio);
        maxSampleDuration = Math.max(maxSampleDuration, buffer.duration / tempoRatio);
      }

      const playback: ActivePlayback = {
        generation,
        context,
        timeline,
        ...(cyclePlan ? { cyclePlan } : {}),
        startAt,
        fixtureEndAt,
        finishAt,
        buffers,
        sampleGain,
        ...(beat ? { beatGain: beat.gain, beatSource: beat.source } : {}),
        ...(processor ? { processor } : {}),
        ...(referenceBpm === undefined ? {} : { referenceBpm }),
        tempoRatio,
        pitchSemitones: currentPitch,
        cycleIterationBase: 0,
        maxSampleDuration,
        nextEventIndex: 0,
        nextCycleStartAt: startAt,
      };
      this.activePlayback = playback;

      this.publish(cyclePlan
        ? { status: "playing", progress: 0, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: cyclePlan.slots[0]!.kind }
        : { status: "playing", progress: 0 });
      this.intervalHandle = this.scheduleInterval(() => this.tick(generation), this.schedulerIntervalMs);
      this.tick(generation);
    } catch (error) {
      if (pendingProcessor) disconnectNode(pendingProcessor);
      if (!this.isCurrent(generation)) return;
      this.cancelRun();
      this.publish({ status: "error", progress: 0, error: describeError(error) });
    }
  };

  stop = (): void => {
    if (this.disposed) return;
    this.cancelRun();
    this.publish({ status: "idle", progress: 0 });
  };

  /** Stop active or pending playback and release decoded references after a new import. */
  resetAssets = (): void => {
    if (this.disposed) return;
    this.cancelRun();
    this.fileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
    this.syntheticBufferCache.clear();
    this.publish({ status: "idle", progress: 0 });
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.cancelRun();
    this.disposed = true;
    this.fileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
    this.syntheticBufferCache.clear();
    this.publish({ status: "disposed", progress: 0 });
    this.listeners.clear();

    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  };

  private tick(generation: number): void {
    const playback = this.activePlayback;
    if (!playback || !this.isCurrent(generation)) return;

    const now = playback.context.currentTime;
    const schedulingHorizon = now + this.lookAheadSeconds;

    try {
      if (playback.cyclePlan) {
        this.scheduleCycleEvents(playback, now, schedulingHorizon);
      } else {
        this.scheduleFixtureEvents(playback, now, schedulingHorizon);
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.cancelRun();
      this.publish({ status: "error", progress: 0, error: describeError(error) });
      return;
    }

    if (!playback.cyclePlan && now >= playback.finishAt) {
      this.cancelRun();
      this.publish({ status: "completed", progress: 1 });
      return;
    }

    if (playback.cyclePlan) {
      const phase = cyclePhaseAt(now, playback.startAt, playback.cyclePlan, playback.cycleIterationBase);
      this.publish({
        status: "playing",
        progress: repeatingProgressAt(now, playback.startAt, playback.cyclePlan.totalSeconds),
        cycleSlotIndex: phase.slotIndex,
        cycleIteration: phase.iteration,
        cycleSlotKind: phase.kind,
      });
      return;
    }

    this.publish({ status: "playing", progress: progressAt(now, playback.startAt, playback.timeline.totalSeconds) });
  }

  private scheduleFixtureEvents(playback: ActivePlayback, now: number, schedulingHorizon: number): void {
    while (playback.nextEventIndex < playback.timeline.events.length) {
      const event = playback.timeline.events[playback.nextEventIndex];
      if (!event) break;
      const when = playback.startAt + event.offsetSeconds;
      if (when > schedulingHorizon) break;

      playback.nextEventIndex += 1;
      this.scheduleEvent(playback, event, when, now);
    }
  }

  private scheduleCycleEvents(playback: ActivePlayback, now: number, schedulingHorizon: number): void {
    const cyclePlan = playback.cyclePlan;
    if (!cyclePlan || !cyclePlan.events.some((event) => !event.silent)) return;

    if (playback.nextEventIndex >= cyclePlan.events.length) {
      playback.nextEventIndex = 0;
      playback.nextCycleStartAt += cyclePlan.totalSeconds;
    }
    this.skipExpiredCycles(playback, now);

    while (true) {
      const event = cyclePlan.events[playback.nextEventIndex];
      if (!event) break;
      const when = playback.nextCycleStartAt + event.offsetSeconds;
      if (when > schedulingHorizon) break;

      playback.nextEventIndex += 1;
      this.scheduleEvent(playback, event, when, now);

      if (playback.nextEventIndex >= cyclePlan.events.length) {
        playback.nextEventIndex = 0;
        playback.nextCycleStartAt += cyclePlan.totalSeconds;
        this.skipExpiredCycles(playback, now);
      }
    }
  }

  private skipExpiredCycles(playback: ActivePlayback, now: number): void {
    const cyclePlan = playback.cyclePlan;
    if (!cyclePlan || playback.nextCycleStartAt + cyclePlan.totalSeconds > now - playback.maxSampleDuration) return;

    const fullyExpiredCycles = Math.floor(
      (now - playback.maxSampleDuration - playback.nextCycleStartAt) / cyclePlan.totalSeconds,
    );
    if (fullyExpiredCycles <= 0) return;

    playback.nextCycleStartAt += fullyExpiredCycles * cyclePlan.totalSeconds;
    playback.nextEventIndex = 0;
  }

  private scheduleEvent(playback: ActivePlayback, event: FixtureTimeline["events"][number], when: number, now: number): void {
    if (event.silent) return;

    const buffer = playback.buffers.get(event.sampleId);
    if (!buffer) {
      throw new Error(`Audio for “${event.sampleId}” could not be loaded. Re-import its WAV file and try again.`);
    }
    const elapsedSeconds = Math.max(0, now - when);
    if (elapsedSeconds >= buffer.duration / playback.tempoRatio) return;
    this.scheduleSample(playback, buffer, Math.max(now, when), elapsedSeconds * playback.tempoRatio);
  }

  private scheduleSample(
    playback: ActivePlayback,
    buffer: AudioBuffer,
    when: number,
    offsetSeconds: number,
  ): void {
    const source = playback.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playback.tempoRatio;
    source.connect(playback.sampleGain);
    this.sources.add(source);
    this.sampleSources.set(source, { startedAt: when });
    source.onended = () => this.releaseSource(source);

    try {
      source.start(when, offsetSeconds);
    } catch (error) {
      this.releaseSource(source);
      throw error;
    }
  }

  private scheduleBeat(
    context: AudioContext,
    buffer: AudioBuffer,
    startAt: number,
    stopAt: number | undefined,
    volume: number,
    output: AudioNode,
    tempoRatio: number,
  ): { readonly gain: GainNode; readonly source: AudioBufferSourceNode } {
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error("The selected beat WAV has no playable audio.");
    }

    const gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(output);
    this.outputNodes.add(gain);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = tempoRatio;
    source.connect(gain);
    this.sources.add(source);
    source.onended = () => this.releaseSource(source);

    try {
      source.start(startAt);
      if (stopAt !== undefined) source.stop(stopAt);
    } catch (error) {
      this.releaseSource(source);
      throw error;
    }
    return { gain, source };
  }

  private releaseSource(source: AudioBufferSourceNode): void {
    source.onended = null;
    this.sources.delete(source);
    this.sampleSources.delete(source);
    try {
      source.disconnect();
    } catch {
      // A browser may already have disconnected a node during context shutdown.
    }
  }

  private decodeFile(context: AudioContext, file: File): Promise<AudioBuffer> {
    const cached = this.fileBufferCache.get(file);
    if (cached) return cached;

    const decoding = file.arrayBuffer()
      .then((bytes) => context.decodeAudioData(bytes.slice(0)))
      .then((buffer) => {
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
          throw new Error(`“${file.name || "The selected WAV"}” has no playable audio.`);
        }
        return buffer;
      });
    this.fileBufferCache.set(file, decoding);
    void decoding.catch(() => this.fileBufferCache.delete(file));
    return decoding;
  }

  private getSyntheticBuffer(context: AudioContext, sampleId: string): AudioBuffer {
    const cached = this.syntheticBufferCache.get(sampleId);
    if (cached) return cached;
    if (!SYNTHETIC_SAMPLE_IDS.has(sampleId)) {
      throw new Error(`“${sampleId}” is not a built-in demo sound.`);
    }

    const sampleRate = context.sampleRate || 44_100;
    const durationSeconds = sampleId === "synthSilence" ? 0.05 : 0.2;
    const buffer = context.createBuffer(1, Math.max(1, Math.round(sampleRate * durationSeconds)), sampleRate);
    const channel = buffer.getChannelData(0);

    if (sampleId === "synthPulse") {
      for (let index = 0; index < channel.length; index += 1) {
        const time = index / sampleRate;
        const envelope = Math.exp(-18 * time);
        channel[index] = Math.sin(2 * Math.PI * 180 * time) * envelope * 0.55;
      }
    } else if (sampleId === "synthBrush") {
      // A fixed harmonic cluster gives a short percussive click without random noise or assets.
      for (let index = 0; index < channel.length; index += 1) {
        const time = index / sampleRate;
        const envelope = Math.exp(-42 * time);
        const click = Math.sin(2 * Math.PI * 1_100 * time)
          + 0.45 * Math.sin(2 * Math.PI * 1_730 * time)
          + 0.2 * Math.sin(2 * Math.PI * 2_900 * time);
        channel[index] = click * envelope * 0.22;
      }
    }

    this.syntheticBufferCache.set(sampleId, buffer);
    return buffer;
  }

  private getContext(): AudioContext {
    if (!this.context) this.context = this.contextFactory();
    return this.context;
  }

  private cancelRun(): void {
    this.generation += 1;
    if (this.intervalHandle !== undefined) {
      this.cancelInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.activePlayback = undefined;

    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // Stop is best-effort for nodes whose context ended during cancellation.
      }
      try {
        source.disconnect();
      } catch {
        // The node may have been disconnected by its end callback already.
      }
    }
    this.sources.clear();
    this.sampleSources.clear();

    for (const node of this.outputNodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore duplicate disconnects during cleanup.
      }
    }
    this.outputNodes.clear();
  }

  private validateTempoRatio(bpm: number, referenceBpm: number): number {
    const ratio = bpm / referenceBpm;
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2) {
      throw new Error(`BPM must stay between ${formatBpm(referenceBpm * 0.5)} and ${formatBpm(referenceBpm * 2)} for this preset.`);
    }
    return ratio;
  }

  private retimePlayback(playback: ActivePlayback, bpm: number, tempoRatio: number): void {
    if (playback.context.currentTime >= playback.finishAt && !playback.cyclePlan) {
      this.tick(playback.generation);
      if (this.activePlayback !== playback) return;
    }

    const now = playback.context.currentTime;
    // Flush events due under the old tempo before invalidating only its future lookahead.
    this.scheduleDueEvents(playback, now, now + this.lookAheadSeconds);
    for (const [source, state] of this.sampleSources) {
      if (state.startedAt > now) {
        this.releaseSource(source);
        try {
          source.stop(0);
        } catch {
          // Best effort for a source already removed by context shutdown.
        }
      }
    }

    const oldSecondsPerUnit = playback.timeline.secondsPerUnit;
    const hadStarted = now >= playback.startAt;
    const oldElapsedSeconds = Math.max(0, now - playback.startAt);
    const oldCycleLength = playback.cyclePlan?.totalSeconds;
    const previousIteration = oldCycleLength
      ? playback.cycleIterationBase + Math.floor(oldElapsedSeconds / oldCycleLength)
      : 0;
    const positionSeconds = oldCycleLength
      ? oldElapsedSeconds % oldCycleLength
      : oldElapsedSeconds;
    const positionUnits = positionSeconds / oldSecondsPerUnit;

    playback.timeline = playback.cyclePlan
      ? rescaleCyclePlanTimeline(playback.cyclePlan, bpm)
      : rescaleFixtureTimeline(playback.timeline, bpm);
    if (playback.cyclePlan) playback.cyclePlan = playback.timeline as CyclePlanTimeline;
    playback.tempoRatio = tempoRatio;
    playback.startAt = hadStarted
      ? now - positionUnits * playback.timeline.secondsPerUnit
      : playback.startAt;
    playback.fixtureEndAt = playback.startAt + playback.timeline.totalSeconds;
    if (playback.cyclePlan) {
      playback.nextCycleStartAt = playback.startAt;
      playback.cycleIterationBase = previousIteration;
    }

    playback.nextEventIndex = !hadStarted
      ? 0
      : playback.timeline.events.findIndex((event) => event.startUnits > positionUnits);
    if (playback.nextEventIndex < 0) playback.nextEventIndex = playback.timeline.events.length;

    playback.maxSampleDuration = 0;
    let finishAt = playback.fixtureEndAt;
    for (const event of playback.timeline.events) {
      if (event.silent) continue;
      const buffer = playback.buffers.get(event.sampleId);
      if (!buffer) continue;
      const scaledDuration = buffer.duration / tempoRatio;
      finishAt = Math.max(finishAt, playback.startAt + event.offsetSeconds + scaledDuration);
      playback.maxSampleDuration = Math.max(playback.maxSampleDuration, scaledDuration);
    }
    playback.finishAt = finishAt;

    setAudioParamValue(playback.processor!.playbackRate, tempoRatio, now);
    for (const source of this.sources) {
      if (source === playback.beatSource) {
        setAudioParamValue(source.playbackRate, tempoRatio, now);
      } else if (this.sampleSources.has(source)) {
        setAudioParamValue(source.playbackRate, tempoRatio, now);
      }
    }
    if (playback.beatSource && !playback.cyclePlan) {
      try {
        playback.beatSource.stop(playback.fixtureEndAt);
      } catch {
        // A source that has already ended does not need another stop time.
      }
    }
    this.selectedBpm = bpm;
    this.tick(playback.generation);
  }

  private scheduleDueEvents(playback: ActivePlayback, now: number, horizon: number): void {
    if (playback.cyclePlan) {
      this.scheduleCycleEvents(playback, now, horizon);
    } else {
      this.scheduleFixtureEvents(playback, now, horizon);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private publish(snapshot: TransportSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // A UI subscriber must not interrupt audio scheduling.
      }
    }
  }
}

function createBrowserAudioContext(): AudioContext {
  const legacyWindow = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = globalThis.AudioContext ?? legacyWindow.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("Web Audio is unavailable in this browser. Use a current version of Chrome or Edge.");
  }
  return new AudioContextConstructor();
}

function positiveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function volumeValue(value: number | undefined, label: string): number {
  const normalized = value ?? 100;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${label} must be a finite percentage between 0 and 100.`);
  }
  return normalized / 100;
}

function positiveBpm(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a finite number of at least 1 BPM.`);
  }
  return value;
}

function pitchValue(value: number): number {
  if (!Number.isInteger(value) || value < -12 || value > 12) {
    throw new Error("Pitch must be a whole semitone value between −12 and +12.");
  }
  return value;
}

function formatBpm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function setAudioParamValue(parameter: AudioParam, value: number, currentTime: number): void {
  try {
    parameter.cancelScheduledValues(currentTime);
    parameter.setValueAtTime(value, currentTime);
  } catch {
    parameter.value = value;
  }
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // The context may already have removed this graph node.
  }
}

function setGainValue(gain: GainNode, value: number, currentTime: number): void {
  try {
    gain.gain.cancelScheduledValues(currentTime);
    gain.gain.setTargetAtTime(value, currentTime, 0.015);
  } catch {
    gain.gain.value = value;
  }
}

function progressAt(now: number, startAt: number, durationSeconds: number): number {
  return Math.min(1, Math.max(0, (now - startAt) / durationSeconds));
}

function repeatingProgressAt(now: number, startAt: number, durationSeconds: number): number {
  if (now <= startAt) return 0;
  const elapsedSeconds = now - startAt;
  return (elapsedSeconds % durationSeconds) / durationSeconds;
}

function cyclePhaseAt(
  now: number,
  startAt: number,
  cyclePlan: CyclePlanTimeline,
  iterationBase = 0,
): { readonly slotIndex: number; readonly iteration: number; readonly kind: CycleSlot["kind"] } {
  const elapsedSeconds = Math.max(0, now - startAt);
  const iteration = Math.min(Number.MAX_SAFE_INTEGER, iterationBase + Math.floor(elapsedSeconds / cyclePlan.totalSeconds) + 1);
  const positionSeconds = elapsedSeconds % cyclePlan.totalSeconds;
  const slotIndex = cyclePlan.slots.findIndex((slot) =>
    positionSeconds < slot.startSeconds + slot.durationSeconds);
  const resolvedSlotIndex = slotIndex < 0 ? cyclePlan.slots.length - 1 : slotIndex;
  const slot = cyclePlan.slots[resolvedSlotIndex]!;
  return { slotIndex: resolvedSlotIndex, iteration, kind: slot.kind };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Audio could not be started. Check the selected WAV files and try again.";
}
