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
import { decodeLocalAudioFile, validateLocalAudioBuffer } from "./beatAnalysis";
import { resolveBeatPlaybackFrameRange, type BeatPlaybackFrameRange, type BeatPlaybackRegion } from "./beatPlaybackRegion";

export type TransportStatus = "idle" | "loading" | "counting-in" | "playing" | "completed" | "error" | "disposed";

export interface CountInProgress {
  /** One-based beat currently shown during count-in. */
  readonly beat: number;
  /** Total count-in beats: four for one bar, eight for two bars. */
  readonly beats: number;
}

export interface TransportSnapshot {
  readonly status: TransportStatus;
  /** Scheduler/input-clock progress. AudioWorklet output can trail this clock. */
  readonly progress: number;
  /** Present only while the audible count-in is in progress. */
  readonly countIn?: CountInProgress;
  /** Estimated heard position, mapped from the output-device clock and SoundTouch delay. */
  readonly presentation?: TransportPresentation;
  readonly error?: string;
  /** Zero-based slot index, present only during cycle-plan playback. */
  readonly cycleSlotIndex?: number;
  /** One-based repetition number, present only during cycle-plan playback. */
  readonly cycleIteration?: number;
  /** Current slot type, present only during cycle-plan playback. */
  readonly cycleSlotKind?: CycleSlot["kind"];
  /** One-based generated cycle-plan index, present only when Auto-generate is enabled. */
  readonly cyclePlanIndex?: number;
  /** Live tempo-trainer progress, reported at the estimated heard phase. */
  readonly tempoTraining?: TempoTrainingProgress;
}

export interface TempoTrainingOptions {
  /** Goal BPM; the transport clamps the last step to this value. */
  readonly targetBpm: number;
  /** BPM added after each configured group of complete rounds. */
  readonly stepBpm: number;
  /** Complete passes through the full ordered slot list per tempo step. */
  readonly roundsPerStep: number;
}

export interface TempoTrainingProgress {
  readonly currentBpm: number;
  readonly targetBpm: number;
  readonly stepBpm: number;
  readonly roundsPerStep: number;
  /** Full slot-list passes that have reached the output presentation clock. */
  readonly completedRounds: number;
  /** Zero-based completed rounds since the last tempo step. Resets to zero at the goal. */
  readonly roundsIntoStep: number;
  readonly goalReached: boolean;
}

export interface TransportPresentation {
  /** True after the initial fixture position is expected to have reached output. */
  readonly started: boolean;
  /** Estimated SoundTouch content lag; zero if playback bypasses the processor. */
  readonly estimatedProcessorDelaySeconds: number;
  /** Finite SoundTouch output drain after the last input source; zero for looping playback. */
  readonly drainSeconds: number;
  /** Normalized progress through the finite fixture or current full cycle plan. */
  readonly progress: number;
  /** Position in timeline units within the active slot, or the finite fixture. */
  readonly positionUnits: number;
  readonly cycleSlotIndex?: number;
  readonly cycleIteration?: number;
  readonly cycleSlotKind?: CycleSlot["kind"];
  readonly cyclePlanIndex?: number;
}

export interface PlayOptions {
  readonly fixture: Fixture;
  /** Imported preset's original BPM. Live tempo scales from this reference. */
  readonly referenceBpm?: number;
  /** Selected beat track's original BPM. Defaults to the scratch reference BPM. */
  readonly beatReferenceBpm?: number;
  readonly bpm: number;
  /** Optional automatic tempo ramp for repeating cycle-plan practice. */
  readonly tempoTraining?: TempoTrainingOptions;
  /** Audible 4/4 bars before sequence start. Defaults to no count-in. */
  readonly countInBars?: 0 | 1 | 2;
  /** Continue quarter-note clicks after count-in, including silent cycle slots. Defaults to false. */
  readonly metronomeEnabled?: boolean;
  /** Independent metronome level, as a percentage from 0 to 100. Defaults to 60. */
  readonly metronomeVolume?: number;
  /** Independent pitch shift in semitones. Defaults to zero. */
  readonly pitchSemitones?: number;
  /** Fixture units per quarter-note beat. Defaults to 4 sixteenth-note units; legacy raw ticks use 16. */
  readonly unitsPerBeat?: number;
  /** Selected local WAV files keyed by fixture sample id. Files stay in session memory. */
  readonly assets?: ReadonlyMap<string, File>;
  /** Optional local beat WAV. It loops gaplessly through the run. */
  readonly beatFile?: File;
  /** Optional beat buffer already decoded and validated by `analyzeLocalAudioFile`. */
  readonly beatBuffer?: AudioBuffer;
  /** Optional manual downbeat cue and loop end in seconds of the decoded beat source. */
  readonly beatPlaybackRegion?: BeatPlaybackRegion;
  /** Optional 0–100 percent volume from the normalized preset model. */
  readonly beatVolume?: number;
  /** Optional 0–100 percent volume from the normalized preset model. */
  readonly sampleVolume?: number;
}

export interface CyclePlanDefinition {
  readonly slots: readonly CycleSlot[];
}

export interface CyclePlanRequest {
  /** Full plan rounds that precede the next plan; requested as its final configured round approaches. */
  readonly completedRounds: number;
  /** One-based index of the plan the provider should return. */
  readonly nextPlanIndex: number;
}

export interface CyclePlanBoundary {
  /** One-based index of the plan that has just become active. */
  readonly planIndex: number;
  /** Cumulative full practice rounds completed before this plan starts. */
  readonly completedRounds: number;
  readonly plan: CyclePlanDefinition;
}

export type CyclePlanProvider = (request: CyclePlanRequest) => CyclePlanDefinition;
export type CyclePlanBoundaryHandler = (boundary: CyclePlanBoundary) => void;

export interface CyclePlanOptions extends Omit<PlayOptions, "fixture"> {
  /** Initial ordered slot plan; repeats until Stop or, with Auto-generate, until its next plan boundary. */
  readonly slots: readonly CycleSlot[];
  /** Full cycles of this slot sequence per generated fixture. Required with nextPlan. */
  readonly cyclesPerPlan?: number;
  /** Synchronous, warmed provider for the next generated fixture plan. */
  readonly nextPlan?: CyclePlanProvider;
  /** Called when a generated plan becomes active at a full cycle boundary. */
  readonly onPlanBoundary?: CyclePlanBoundaryHandler;
  /** Additional sample ids eligible in future generated plans; decoded before playback. */
  readonly preloadSampleIds?: readonly string[];
}

type InternalPlaybackOptions = Omit<PlayOptions, "fixture"> & Pick<
  CyclePlanOptions,
  "cyclesPerPlan" | "nextPlan" | "onPlanBoundary" | "preloadSampleIds"
>;

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
  readonly metronomeGain?: GainNode;
  readonly countInBeats: number;
  readonly metronomeEnabled: boolean;
  metronomeTempoEpochs: MetronomeTempoEpoch[];
  /** Initial sequence-start anchor. Count-in never reopens at later plan boundaries. */
  readonly countInEndAt: number;
  nextMetronomeBeatIndex: number;
  readonly keepAliveSources: readonly ConstantSourceNode[];
  drainEndAt?: number;
  /** Processor for combo samples; also processes the beat when both tempo ratios match. */
  readonly processor?: TempoPitchProcessorNode;
  /** Dedicated beat processor used only when beat and scratch reference tempi differ. */
  readonly beatProcessor?: TempoPitchProcessorNode;
  readonly presentationDelaySeconds: number;
  presentationEpochs: PresentationEpoch[];
  pendingPresentationBoundaries: PendingPresentationBoundary[];
  lastOutputContextTime: number;
  hasPresentedStart: boolean;
  readonly referenceBpm?: number;
  readonly sampleReferenceBpm: number;
  readonly beatReferenceBpm: number;
  /** Tempo currently used by the scheduler for future sources. */
  bpm: number;
  tempoRatio: number;
  beatTempoRatio: number;
  pitchSemitones: number;
  cycleIterationBase: number;
  dynamicCycle?: DynamicCyclePlayback;
  tempoTraining?: ActiveTempoTraining;
  /** At least one non-silent hit in the current trainer round was missed or truncated. */
  tempoTrainingRoundIncomplete: boolean;
  maxSampleDuration: number;
  nextEventIndex: number;
  nextCycleStartAt: number;
}

interface PresentationEpoch {
  /** AudioContext time at which this plan/tempo mapping became schedulable. */
  readonly effectiveAt: number;
  /** Start anchor for the fixture/cycle in the scheduler clock. */
  readonly startAt: number;
  readonly timeline: FixtureTimeline;
  readonly cycleIterationBase: number;
  readonly bpm: number;
  readonly cyclePlanIndex?: number;
}

interface MetronomeTempoEpoch {
  readonly effectiveAt: number;
  /** Fractional global beat position at `effectiveAt`, continuous through tempo changes. */
  readonly beatIndexAt: number;
  readonly secondsPerBeat: number;
}

interface ActiveTempoTraining extends TempoTrainingOptions {
  readonly startingBpm: number;
  /** Scheduled full rounds; presentation progress is derived independently from output time. */
  scheduledRounds: number;
  roundsSinceStep: number;
  /** Full scheduled rounds whose boundaries have reached the estimated output clock. */
  presentedRounds: number;
  pendingRoundBoundaries: number[];
}

interface PendingPresentationBoundary {
  readonly at: number;
  readonly boundary: CyclePlanBoundary;
  readonly handler?: CyclePlanBoundaryHandler;
}

interface DynamicCyclePlayback {
  readonly cyclesPerPlan: number;
  readonly nextPlan: CyclePlanProvider;
  readonly onPlanBoundary?: CyclePlanBoundaryHandler;
  planIndex: number;
  completedRounds: number;
  cyclesScheduledInPlan: number;
  planStartCycleGlobal: number;
  providerRequested: boolean;
  awaitingBoundaryAt?: number;
  preparedPlan?: CyclePlanDefinition;
  preparedTimeline?: CyclePlanTimeline;
  preparedEventIndex?: number;
  providerError?: string;
}

interface SampleSourceState {
  readonly startedAt: number;
}

interface MetronomeSourceState {
  readonly scheduledAt: number;
  readonly envelope: GainNode;
}

type AudioDecodeJob =
  | { readonly kind: "sample"; readonly sampleId: string }
  | { readonly kind: "beat"; readonly file: File };

type AudioDecodeResult =
  | { readonly kind: "sample"; readonly sampleId: string; readonly buffer: AudioBuffer }
  | { readonly kind: "beat"; readonly buffer: AudioBuffer };

const SYNTHETIC_SAMPLE_IDS = new Set(["synthPulse", "synthBrush", "synthSilence"]);
const DEFAULT_LOOK_AHEAD_SECONDS = 0.1;
const DEFAULT_SCHEDULER_INTERVAL_MS = 25;
const DEFAULT_START_DELAY_SECONDS = 0.05;
const MAX_PARALLEL_AUDIO_DECODES = 4;
const MAX_DYNAMIC_CYCLE_ADVANCES_PER_TICK = 64;
const MAX_PRESENTATION_EPOCHS = 64;
const BEATS_PER_BAR = 4;
const DEFAULT_METRONOME_VOLUME_PERCENT = 60;
const METRONOME_CLICK_DURATION_SECONDS = 0.045;
export const MIN_TEMPO_TRAINING_STEP_BPM = 0.1;
export const MAX_TEMPO_TRAINING_STEP_BPM = 20;
export const MAX_TEMPO_TRAINING_ROUNDS_PER_STEP = 64;
/**
 * Edge actual-worklet PCM probes at 48 kHz measured first/repeated transient offsets of
 * 102–137 ms for common 0.75–1.176 tempo ratios and 0/+3 semitones. Use 130 ms as an
 * estimated SoundTouch content lag; WSOLA can move individual attacks by about 28 ms.
 */
export const SOUNDTOUCH_ESTIMATED_PRESENTATION_DELAY_SECONDS = 0.13;
/** Zero-input end-marker probes at 48 kHz drained 116–128 ms after input end at ratios 0.5–2. */
export const SOUNDTOUCH_FINITE_DRAIN_SECONDS = 0.15;

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
  private beatFileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
  private syntheticBufferCache = new Map<string, AudioBuffer>();
  private selectedSampleVolume = 1;
  private selectedBeatVolume = 1;
  private selectedMetronomeVolume = DEFAULT_METRONOME_VOLUME_PERCENT / 100;
  private selectedBpm: number | undefined;
  private selectedReferenceBpm: number | undefined;
  private selectedBeatReferenceBpm: number | undefined;
  private selectedPitchSemitones = 0;
  private loadingTempoTrainingCancelled = false;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly keepAliveSources = new Set<ConstantSourceNode>();
  private readonly sampleSources = new Map<AudioBufferSourceNode, SampleSourceState>();
  private readonly metronomeSources = new Map<OscillatorNode, MetronomeSourceState>();
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
      const epoch = this.presentationEpochAt(playback, playback.context.currentTime);
      const cyclePlan = "slots" in epoch.timeline ? epoch.timeline as CyclePlanTimeline : playback.cyclePlan;
      return repeatingProgressAt(
        playback.context.currentTime,
        epoch.startAt,
        cyclePlan.totalSeconds,
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

  /** Update the click layer without restarting the count-in or metronome phase. */
  setMetronomeVolume = (value: number): void => {
    const normalized = volumeValue(value, "Metronome volume");
    this.selectedMetronomeVolume = normalized;
    const playback = this.activePlayback;
    if (playback?.metronomeGain) {
      setGainValue(playback.metronomeGain, normalized, playback.context.currentTime);
    }
  };

  /** Change tempo immediately while preserving the current musical position. */
  setTempo = (value: number): void => {
    const bpm = positiveBpm(value, "BPM");
    const playback = this.activePlayback;
    if (!playback) {
      if (this.snapshot.status === "loading"
        && (this.selectedReferenceBpm !== undefined || this.selectedBeatReferenceBpm !== undefined)) {
        if (this.selectedReferenceBpm !== undefined) this.validateTempoRatio(bpm, this.selectedReferenceBpm);
        if (this.selectedBeatReferenceBpm !== undefined) this.validateTempoRatio(bpm, this.selectedBeatReferenceBpm);
        this.selectedBpm = bpm;
        this.loadingTempoTrainingCancelled = true;
        return;
      }
      throw new Error("Live tempo changes require playback with a BPM reference.");
    }
    if (!playback.processor && !playback.beatProcessor) {
      throw new Error("Live tempo changes require playback started with a BPM reference.");
    }
    if (playback.countInBeats > 0 && this.presentationTimeAt(playback) < playback.countInEndAt) {
      throw new Error("Tempo is locked during count-in. It becomes live when the sequence starts.");
    }

    const tempoRatio = this.validateTempoRatio(bpm, playback.sampleReferenceBpm);
    const beatTempoRatio = this.validateTempoRatio(bpm, playback.beatReferenceBpm);
    this.selectedBpm = bpm;
    if (playback.tempoTraining) {
      this.restoreCurrentScheduleEpoch(playback, playback.context.currentTime);
      delete playback.tempoTraining;
    }
    if (!playback.cyclePlan && playback.context.currentTime >= playback.finishAt) {
      playback.tempoRatio = tempoRatio;
      playback.beatTempoRatio = beatTempoRatio;
      if (playback.processor) setAudioParamValue(playback.processor.playbackRate, tempoRatio, playback.context.currentTime);
      if (playback.beatProcessor) setAudioParamValue(playback.beatProcessor.playbackRate, beatTempoRatio, playback.context.currentTime);
      for (const source of this.sources) {
        if (source === playback.beatSource) setAudioParamValue(source.playbackRate, beatTempoRatio, playback.context.currentTime);
        else if (this.sampleSources.has(source)) setAudioParamValue(source.playbackRate, tempoRatio, playback.context.currentTime);
      }
      return;
    }
    try {
      this.retimePlayback(playback, bpm, tempoRatio);
    } catch (error) {
      if (this.activePlayback === playback && this.isCurrent(playback.generation)) {
        this.cancelRun();
        this.publish({ status: "error", progress: 0, error: describeError(error) });
      }
    }
  };

  /** Change pitch independently from tempo on the live AudioWorklet processor. */
  setPitchSemitones = (value: number): void => {
    const pitchSemitones = pitchValue(value);
    const playback = this.activePlayback;
    if (playback?.processor || playback?.beatProcessor) {
      this.selectedPitchSemitones = pitchSemitones;
      playback.pitchSemitones = pitchSemitones;
      if (playback.processor) setAudioParamValue(playback.processor.pitchSemitones, pitchSemitones, playback.context.currentTime);
      if (playback.beatProcessor) setAudioParamValue(playback.beatProcessor.pitchSemitones, pitchSemitones, playback.context.currentTime);
      return;
    }
    if (this.snapshot.status === "loading") {
      if (pitchSemitones !== 0 && this.selectedReferenceBpm === undefined && this.selectedBeatReferenceBpm === undefined) {
        throw new Error("Live pitch changes require playback started with a BPM reference.");
      }
      this.selectedPitchSemitones = pitchSemitones;
      return;
    }
    if (this.snapshot.status === "playing" && pitchSemitones !== 0) {
      throw new Error("Live pitch changes require playback started with a BPM reference.");
    }
    this.selectedPitchSemitones = pitchSemitones;
  };

  private startPlayback = async (
    options: InternalPlaybackOptions,
    createSchedule: () => { readonly timeline: FixtureTimeline; readonly cyclePlan?: CyclePlanTimeline },
  ): Promise<void> => {
    if (this.disposed) return;

    this.capturePresentedTempo();
    this.cancelRun();
    this.loadingTempoTrainingCancelled = false;
    const generation = this.generation;
    this.publish({ status: "loading", progress: 0 });
    const pendingProcessors: TempoPitchProcessorNode[] = [];

    try {
      let { timeline, cyclePlan } = createSchedule();
      const bpm = positiveBpm(options.bpm, "BPM");
      const referenceBpm = options.referenceBpm === undefined
        ? undefined
        : positiveBpm(options.referenceBpm, "Reference BPM");
      const sampleReferenceBpm = referenceBpm ?? bpm;
      const beatReferenceBpm = options.beatReferenceBpm === undefined
        ? sampleReferenceBpm
        : positiveBpm(options.beatReferenceBpm, "Beat reference BPM");
      const initialTempoRatio = this.validateTempoRatio(bpm, sampleReferenceBpm);
      const initialBeatTempoRatio = this.validateTempoRatio(bpm, beatReferenceBpm);
      const initialPitch = pitchValue(options.pitchSemitones ?? this.selectedPitchSemitones);
      const countInBars = countInBarsValue(options.countInBars);
      if (options.metronomeEnabled !== undefined && typeof options.metronomeEnabled !== "boolean") {
        throw new Error("Metronome enabled must be a boolean.");
      }
      const metronomeEnabled = options.metronomeEnabled ?? false;
      const countInBeats = countInBars * BEATS_PER_BAR;
      const hasBeat = Boolean(options.beatFile || options.beatBuffer);
      if (options.beatFile && options.beatBuffer) {
        throw new Error("Pass either a beat file or its decoded beat buffer, not both.");
      }
      if (options.beatPlaybackRegion && !hasBeat) {
        throw new Error("A beat playback region requires a selected beat track.");
      }
      if (options.beatBuffer) validateLocalAudioBuffer(options.beatBuffer);
      const dynamicCycleConfig = createDynamicCycleConfig(options);
      if (dynamicCycleConfig && !cyclePlan) {
        throw new Error("Auto-generate requires a cycle plan.");
      }
      const requestedTempoTraining = options.tempoTraining === undefined
        ? undefined
        : this.validateTempoTrainingOptions(options.tempoTraining, bpm, sampleReferenceBpm, beatReferenceBpm);
      if (requestedTempoTraining && !cyclePlan) {
        throw new Error("Tempo training requires a repeating cycle plan.");
      }
      this.selectedBpm = bpm;
      this.selectedReferenceBpm = referenceBpm;
      this.selectedBeatReferenceBpm = options.beatReferenceBpm;
      this.selectedPitchSemitones = initialPitch;
      this.selectedSampleVolume = volumeValue(options.sampleVolume, "Sample volume");
      this.selectedBeatVolume = volumeValue(options.beatVolume, "Beat volume");
      this.selectedMetronomeVolume = volumeValue(
        options.metronomeVolume ?? DEFAULT_METRONOME_VOLUME_PERCENT,
        "Metronome volume",
      );
      const assets = options.assets ?? new Map<string, File>();
      const sampleIds = new Set(timeline.events.filter((event) => !event.silent).map((event) => event.sampleId));
      for (const sampleId of options.preloadSampleIds ?? []) {
        if (typeof sampleId !== "string" || sampleId.trim() === "") {
          throw new Error("Auto-generate has an invalid sample preload id.");
        }
        sampleIds.add(sampleId);
      }

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
      const needsSampleProcessor = referenceBpm !== undefined
        || initialPitch !== 0
        || options.beatReferenceBpm !== undefined;
      const needsSeparateBeatProcessor = hasBeat
        && options.beatReferenceBpm !== undefined
        && Math.abs(initialTempoRatio - initialBeatTempoRatio) > 1e-9;
      const loadProcessor = (): Promise<TempoPitchProcessorNode> => this.tempoPitchProcessorFactory(context).then((processor) => {
        pendingProcessors.push(processor);
        if (!this.isCurrent(generation)) disconnectNode(processor);
        return processor;
      });
      const processorPromise = Promise.all([
        needsSampleProcessor ? loadProcessor() : Promise.resolve(undefined),
        needsSeparateBeatProcessor ? loadProcessor() : Promise.resolve(undefined),
      ]);
      const decodeJobs: AudioDecodeJob[] = [
        ...[...sampleIds].map((sampleId) => ({ kind: "sample" as const, sampleId })),
        ...(options.beatFile && !options.beatBuffer ? [{ kind: "beat" as const, file: options.beatFile }] : []),
      ];
      const audioDecodePromise = mapWithConcurrency(decodeJobs, MAX_PARALLEL_AUDIO_DECODES, async (job): Promise<AudioDecodeResult> => {
        if (!this.isCurrent(generation)) throw new StalePlaybackError();
        if (job.kind === "beat") {
          return { kind: "beat", buffer: await this.decodeBeatFile(context, job.file) };
        }
        const file = assets.get(job.sampleId);
        const buffer = file
          ? await this.decodeFile(context, file)
          : this.getSyntheticBuffer(context, job.sampleId);
        return { kind: "sample", sampleId: job.sampleId, buffer };
      }, () => this.isCurrent(generation));

      const [decodedItems, processors] = await Promise.all([
        audioDecodePromise,
        resumePromise,
        processorPromise,
      ]).then(([items, , worklets]) => [items, worklets] as const);
      const [processor, dedicatedBeatProcessor] = processors;

      if (!this.isCurrent(generation)) {
        for (const node of [processor, dedicatedBeatProcessor]) if (node) disconnectNode(node);
        return;
      }

      const sampleEntries = decodedItems.flatMap((item) => item.kind === "sample"
        ? [[item.sampleId, item.buffer] as const]
        : []);
      const beatBuffer = options.beatBuffer ?? decodedItems.find((item) => item.kind === "beat")?.buffer;

      const currentBpm = this.selectedBpm ?? bpm;
      const tempoRatio = this.validateTempoRatio(currentBpm, sampleReferenceBpm);
      const beatTempoRatio = this.validateTempoRatio(currentBpm, beatReferenceBpm);
      const activeTempoTraining = requestedTempoTraining && !this.loadingTempoTrainingCancelled
        ? this.createActiveTempoTraining(
          requestedTempoTraining,
          currentBpm,
          sampleReferenceBpm,
          beatReferenceBpm,
        )
        : undefined;
      this.selectedBpm = currentBpm;
      const currentPitch = this.selectedPitchSemitones;
      if (currentBpm !== timeline.bpm) {
        timeline = cyclePlan
          ? rescaleCyclePlanTimeline(cyclePlan, currentBpm)
          : rescaleFixtureTimeline(timeline, currentBpm);
        if (cyclePlan) cyclePlan = timeline as CyclePlanTimeline;
      }

      const buffers = new Map<string, AudioBuffer>(sampleEntries);
      const beatPlaybackFrames = beatBuffer && options.beatPlaybackRegion
        ? resolveBeatPlaybackFrameRange(beatBuffer, options.beatPlaybackRegion)
        : undefined;
      const processorsToConnect = new Set([processor, dedicatedBeatProcessor].filter(
        (node): node is TempoPitchProcessorNode => node !== undefined,
      ));
      if (processor) {
        setAudioParamValue(processor.playbackRate, tempoRatio, context.currentTime);
        setAudioParamValue(processor.pitchSemitones, currentPitch, context.currentTime);
      }
      if (dedicatedBeatProcessor) {
        setAudioParamValue(dedicatedBeatProcessor.playbackRate, beatTempoRatio, context.currentTime);
        setAudioParamValue(dedicatedBeatProcessor.pitchSemitones, currentPitch, context.currentTime);
      }
      for (const node of processorsToConnect) {
        node.connect(context.destination);
        this.outputNodes.add(node);
      }

      const sampleOutput = processor ?? context.destination;
      const sampleGain = context.createGain();
      sampleGain.gain.value = this.selectedSampleVolume;
      sampleGain.connect(sampleOutput);
      this.outputNodes.add(sampleGain);

      const secondsPerBeat = timeline.secondsPerUnit * timeline.unitsPerBeat;
      const startAt = context.currentTime + this.startDelaySeconds + countInBeats * secondsPerBeat;
      const fixtureEndAt = startAt + timeline.totalSeconds;
      const metronomeGain = countInBeats > 0 || metronomeEnabled
        ? context.createGain()
        : undefined;
      if (metronomeGain) {
        metronomeGain.gain.value = this.selectedMetronomeVolume;
        metronomeGain.connect(context.destination);
        this.outputNodes.add(metronomeGain);
      }
      const beatOutput = dedicatedBeatProcessor ?? processor ?? context.destination;
      const beat = beatBuffer
        ? this.scheduleBeat(
          context,
          beatBuffer,
          startAt,
          cyclePlan ? undefined : fixtureEndAt,
          this.selectedBeatVolume,
          beatOutput,
          beatTempoRatio,
          beatPlaybackFrames,
        )
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
      const drainEndAt = processorsToConnect.size > 0 && !cyclePlan
        ? finishAt + SOUNDTOUCH_FINITE_DRAIN_SECONDS
        : undefined;
      const keepAliveSources = [...processorsToConnect].map((node) =>
        this.scheduleProcessorKeepAlive(context, node, startAt, drainEndAt));

      const playback: ActivePlayback = {
        generation,
        context,
        timeline,
        ...(cyclePlan ? { cyclePlan } : {}),
        startAt,
        fixtureEndAt,
        finishAt,
        ...(drainEndAt === undefined ? {} : { drainEndAt }),
        buffers,
        sampleGain,
        ...(beat ? { beatGain: beat.gain, beatSource: beat.source } : {}),
        ...(metronomeGain ? { metronomeGain } : {}),
        countInBeats,
        metronomeEnabled,
        metronomeTempoEpochs: [{
          effectiveAt: startAt,
          beatIndexAt: 0,
          secondsPerBeat,
        }],
        countInEndAt: startAt,
        nextMetronomeBeatIndex: countInBeats > 0 ? -countInBeats : 0,
        keepAliveSources,
        ...(processor ? { processor } : {}),
        ...(dedicatedBeatProcessor ? { beatProcessor: dedicatedBeatProcessor } : {}),
        presentationDelaySeconds: processorsToConnect.size > 0 ? SOUNDTOUCH_ESTIMATED_PRESENTATION_DELAY_SECONDS : 0,
        presentationEpochs: [{
          effectiveAt: startAt,
          startAt,
          timeline,
          cycleIterationBase: 0,
          bpm: currentBpm,
          ...(dynamicCycleConfig ? { cyclePlanIndex: 1 } : {}),
        }],
        pendingPresentationBoundaries: [],
        lastOutputContextTime: 0,
        hasPresentedStart: false,
        ...(referenceBpm === undefined ? {} : { referenceBpm }),
        sampleReferenceBpm,
        beatReferenceBpm,
        bpm: currentBpm,
        tempoRatio,
        beatTempoRatio,
        pitchSemitones: currentPitch,
        cycleIterationBase: 0,
        ...(dynamicCycleConfig ? {
          dynamicCycle: {
            ...dynamicCycleConfig,
            planIndex: 1,
            completedRounds: 0,
            cyclesScheduledInPlan: 0,
            planStartCycleGlobal: 0,
            providerRequested: false,
          },
        } : {}),
        ...(activeTempoTraining ? { tempoTraining: activeTempoTraining } : {}),
        tempoTrainingRoundIncomplete: false,
        maxSampleDuration,
        nextEventIndex: 0,
        nextCycleStartAt: startAt,
      };
      this.activePlayback = playback;

      this.intervalHandle = this.scheduleInterval(() => this.tick(generation), this.schedulerIntervalMs);
      this.tick(generation);
    } catch (error) {
      for (const processor of pendingProcessors) disconnectNode(processor);
      if (!this.isCurrent(generation)) return;
      this.cancelRun();
      this.publish({ status: "error", progress: 0, error: describeError(error) });
    }
  };

  stop = (): void => {
    if (this.disposed) return;
    this.capturePresentedTempo();
    this.cancelRun();
    this.publish({ status: "idle", progress: 0 });
  };

  /** Stop active or pending playback and release decoded references after a new import. */
  resetAssets = (): void => {
    if (this.disposed) return;
    this.capturePresentedTempo();
    this.cancelRun();
    this.fileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
    this.beatFileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
    this.syntheticBufferCache.clear();
    this.publish({ status: "idle", progress: 0 });
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.capturePresentedTempo();
    this.cancelRun();
    this.disposed = true;
    this.fileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
    this.beatFileBufferCache = new WeakMap<File, Promise<AudioBuffer>>();
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
      if (!this.isCurrent(generation) || this.activePlayback !== playback) return;
      this.scheduleMetronomeClicks(playback, now, schedulingHorizon);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.cancelRun();
      this.publish({ status: "error", progress: 0, error: describeError(error) });
      return;
    }

    if (!this.isCurrent(generation) || this.activePlayback !== playback) return;

    const presentationTime = this.presentationTimeAt(playback);
    const presentation = this.presentationAt(playback, presentationTime);
    if (playback.tempoTraining) {
      this.selectedBpm = this.presentationEpochAt(playback, presentationTime).bpm;
    }
    this.flushPresentedBoundaries(playback, presentationTime);
    if (!this.isCurrent(generation) || this.activePlayback !== playback) return;

    const completionAt = playback.drainEndAt ?? playback.finishAt;
    if (!playback.cyclePlan && playback.lastOutputContextTime >= completionAt) {
      const completedPresentation = this.presentationAt(playback, Math.max(presentationTime, playback.finishAt));
      this.cancelRun();
      this.publish({ status: "completed", progress: 1, presentation: {
        ...completedPresentation,
        started: true,
        progress: 1,
        positionUnits: playback.timeline.totalUnits,
      } });
      return;
    }

    const countIn = this.countInAt(playback, presentationTime);
    if (playback.cyclePlan) {
      const schedulerEpoch = this.presentationEpochAt(playback, now);
      const schedulerPlan = "slots" in schedulerEpoch.timeline
        ? schedulerEpoch.timeline as CyclePlanTimeline
        : playback.cyclePlan;
      const phase = cyclePhaseAt(
        now,
        schedulerEpoch.startAt,
        schedulerPlan,
        schedulerEpoch.cycleIterationBase,
      );
      const progress = this.tempoTrainingProgress(playback, presentationTime);
      this.publish({
        status: countIn ? "counting-in" : "playing",
        progress: countIn ? 0 : repeatingProgressAt(now, schedulerEpoch.startAt, schedulerPlan.totalSeconds),
        ...(countIn ? { countIn } : {}),
        presentation,
        cycleSlotIndex: phase.slotIndex,
        cycleIteration: phase.iteration,
        cycleSlotKind: phase.kind,
        ...(playback.dynamicCycle ? { cyclePlanIndex: playback.dynamicCycle.planIndex } : {}),
        ...(progress ? { tempoTraining: progress } : {}),
      });
      return;
    }

    this.publish({
      status: countIn ? "counting-in" : "playing",
      progress: countIn ? 0 : progressAt(now, playback.startAt, playback.timeline.totalSeconds),
      ...(countIn ? { countIn } : {}),
      presentation,
    });
  }

  private presentationTimeAt(playback: ActivePlayback): number {
    return this.outputTimeAt(playback) - playback.presentationDelaySeconds;
  }

  private outputTimeAt(playback: ActivePlayback): number {
    const context = playback.context;
    let outputTime = context.currentTime;
    const getOutputTimestamp = context.getOutputTimestamp;
    if (typeof getOutputTimestamp === "function") {
      try {
        const timestamp = getOutputTimestamp.call(context);
        const performanceNow = globalThis.performance?.now?.();
        const contextTime = timestamp?.contextTime;
        const performanceTime = timestamp?.performanceTime;
        if (typeof contextTime === "number"
          && Number.isFinite(contextTime)
          && typeof performanceTime === "number"
          && Number.isFinite(performanceTime)
          && contextTime > 0
          && performanceTime > 0
          && Number.isFinite(performanceNow)
          && performanceNow! >= performanceTime) {
          const projectedOutputTime = contextTime + (performanceNow! - performanceTime) / 1_000;
          if (Number.isFinite(projectedOutputTime) && projectedOutputTime >= 0) {
            outputTime = Math.min(context.currentTime, projectedOutputTime);
          }
        }
      } catch {
        // Fall back to the scheduler clock on browsers without a usable output timestamp.
      }
    }
    playback.lastOutputContextTime = Math.max(playback.lastOutputContextTime, outputTime);
    return playback.lastOutputContextTime;
  }

  private presentationEpochAt(playback: ActivePlayback, time: number): PresentationEpoch {
    const epochs = playback.presentationEpochs;
    let epochIndex = 0;
    for (let index = 1; index < epochs.length; index += 1) {
      if (epochs[index]!.effectiveAt > time) break;
      epochIndex = index;
    }
    return epochs[epochIndex] ?? epochs[0]!;
  }

  private capturePresentedTempo(): void {
    const playback = this.activePlayback;
    if (!playback?.tempoTraining) return;
    this.selectedBpm = this.presentationEpochAt(playback, this.presentationTimeAt(playback)).bpm;
  }

  private tempoTrainingProgress(
    playback: ActivePlayback,
    presentationTime: number,
  ): TempoTrainingProgress | undefined {
    const training = playback.tempoTraining;
    if (!training) return undefined;
    const currentBpm = this.presentationEpochAt(playback, presentationTime).bpm;
    this.confirmPresentedTempoTrainingRounds(training, presentationTime);
    // This counter advances only when a scheduled full-round boundary reaches the
    // estimated output clock. Use it directly because catch-up can rebase the phase
    // before the next round while a prior boundary is still in processor latency.
    const completedRounds = training.presentedRounds;
    const goalReached = currentBpm >= training.targetBpm;
    return {
      currentBpm,
      targetBpm: training.targetBpm,
      stepBpm: training.stepBpm,
      roundsPerStep: training.roundsPerStep,
      completedRounds,
      roundsIntoStep: goalReached ? 0 : completedRounds % training.roundsPerStep,
      goalReached,
    };
  }

  private countInAt(playback: ActivePlayback, presentationTime: number): CountInProgress | undefined {
    if (playback.countInBeats === 0 || presentationTime >= playback.countInEndAt) return undefined;
    const secondsPerBeat = playback.timeline.secondsPerUnit * playback.timeline.unitsPerBeat;
    const countInStartAt = playback.countInEndAt - playback.countInBeats * secondsPerBeat;
    const elapsedBeats = (presentationTime - countInStartAt) / secondsPerBeat;
    return {
      beat: Math.max(1, Math.min(playback.countInBeats, Math.floor(elapsedBeats) + 1)),
      beats: playback.countInBeats,
    };
  }

  private presentationAt(playback: ActivePlayback, presentationTime: number): TransportPresentation {
    const epochs = playback.presentationEpochs;
    const epoch = this.presentationEpochAt(playback, presentationTime);
    const timingMetadata = {
      estimatedProcessorDelaySeconds: playback.presentationDelaySeconds,
      drainSeconds: playback.drainEndAt === undefined ? 0 : SOUNDTOUCH_FINITE_DRAIN_SECONDS,
    };
    if (presentationTime >= (epochs[0]?.startAt ?? playback.startAt)) {
      playback.hasPresentedStart = true;
    }

    let presentation: TransportPresentation;
    if ("slots" in epoch.timeline) {
      const cyclePlan = epoch.timeline as CyclePlanTimeline;
      const elapsedSeconds = Math.max(0, presentationTime - epoch.startAt);
      const cycleProgressSeconds = elapsedSeconds % cyclePlan.totalSeconds;
      const cycleUnits = cycleProgressSeconds / cyclePlan.secondsPerUnit;
      const slotIndex = cyclePlan.slots.findIndex((slot) => cycleUnits < slot.startUnits + slot.durationUnits);
      const resolvedSlotIndex = slotIndex < 0 ? cyclePlan.slots.length - 1 : slotIndex;
      const slot = cyclePlan.slots[resolvedSlotIndex]!;
      const positionUnits = Math.min(
        slot.durationUnits,
        Math.max(0, cycleUnits - slot.startUnits),
      );
      presentation = {
        started: playback.hasPresentedStart,
        ...timingMetadata,
        progress: cycleProgressSeconds / cyclePlan.totalSeconds,
        positionUnits,
        cycleSlotIndex: resolvedSlotIndex,
        cycleIteration: Math.min(
          Number.MAX_SAFE_INTEGER,
          epoch.cycleIterationBase + Math.floor(elapsedSeconds / cyclePlan.totalSeconds) + 1,
        ),
        cycleSlotKind: slot.kind,
        ...(epoch.cyclePlanIndex === undefined ? {} : { cyclePlanIndex: epoch.cyclePlanIndex }),
      };
    } else {
      const elapsedSeconds = Math.max(0, presentationTime - epoch.startAt);
      const durationSeconds = epoch.timeline.totalSeconds;
      presentation = {
        started: playback.hasPresentedStart,
        ...timingMetadata,
        progress: progressAt(presentationTime, epoch.startAt, durationSeconds),
        positionUnits: Math.min(epoch.timeline.totalUnits, elapsedSeconds / epoch.timeline.secondsPerUnit),
      };
    }

    while (playback.presentationEpochs.length > 1
      && playback.presentationEpochs[1]!.effectiveAt <= presentationTime) {
      playback.presentationEpochs.shift();
    }
    return presentation;
  }

  private appendPresentationEpoch(
    playback: ActivePlayback,
    effectiveAt: number,
    cyclePlanIndex?: number,
  ): void {
    const last = playback.presentationEpochs.at(-1);
    if (last?.effectiveAt === effectiveAt) playback.presentationEpochs.pop();
    playback.presentationEpochs.push({
      effectiveAt,
      startAt: playback.startAt,
      timeline: playback.timeline,
      cycleIterationBase: playback.cycleIterationBase,
      bpm: playback.bpm,
      ...(cyclePlanIndex === undefined ? {} : { cyclePlanIndex }),
    });
    while (playback.presentationEpochs.length > MAX_PRESENTATION_EPOCHS) {
      playback.presentationEpochs.shift();
    }
  }

  private flushPresentedBoundaries(playback: ActivePlayback, presentationTime: number): void {
    while (playback.pendingPresentationBoundaries[0]
      && playback.pendingPresentationBoundaries[0].at <= presentationTime) {
      if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
      const pending = playback.pendingPresentationBoundaries.shift()!;
      try {
        pending.handler?.(pending.boundary);
      } catch {
        // A UI notification must not interrupt output scheduling.
      }
      if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
    }
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

  private scheduleMetronomeClicks(playback: ActivePlayback, now: number, schedulingHorizon: number): void {
    this.compactMetronomeTempoEpochs(playback, now);
    if (!playback.metronomeGain) return;
    if (!playback.metronomeEnabled && playback.nextMetronomeBeatIndex >= 0) return;

    const clickDelay = playback.presentationDelaySeconds;
    const firstCurrentBeat = Math.ceil(this.metronomeBeatIndexAt(playback, now - clickDelay) - 1e-9);
    playback.nextMetronomeBeatIndex = Math.max(playback.nextMetronomeBeatIndex, firstCurrentBeat);

    while (true) {
      const beatIndex = playback.nextMetronomeBeatIndex;
      const beatAt = this.metronomeBeatTimeAt(playback, beatIndex);
      if (beatIndex >= 0 && !playback.cyclePlan && beatAt >= playback.fixtureEndAt) return;
      const when = beatAt + clickDelay;
      if (when > schedulingHorizon) return;
      playback.nextMetronomeBeatIndex += 1;
      if (beatIndex < 0 && playback.countInBeats === 0) continue;
      if (beatIndex >= 0 && !playback.metronomeEnabled) continue;
      this.scheduleMetronomeClick(playback, beatIndex, when);
    }
  }

  private metronomeBeatIndexAt(playback: ActivePlayback, time: number): number {
    const epochs = playback.metronomeTempoEpochs;
    let epoch = epochs[0]!;
    for (let index = 1; index < epochs.length; index += 1) {
      const candidate = epochs[index]!;
      if (candidate.effectiveAt > time) break;
      epoch = candidate;
    }
    return epoch.beatIndexAt + (time - epoch.effectiveAt) / epoch.secondsPerBeat;
  }

  private metronomeBeatTimeAt(playback: ActivePlayback, beatIndex: number): number {
    const epochs = playback.metronomeTempoEpochs;
    let epoch = epochs[0]!;
    for (let index = 1; index < epochs.length; index += 1) {
      const candidate = epochs[index]!;
      if (beatIndex + 1e-9 < candidate.beatIndexAt) break;
      epoch = candidate;
    }
    return epoch.effectiveAt + (beatIndex - epoch.beatIndexAt) * epoch.secondsPerBeat;
  }

  private replaceMetronomeTempoEpochs(
    playback: ActivePlayback,
    effectiveAt: number,
    beatIndexAt: number,
    secondsPerBeat: number,
  ): void {
    playback.metronomeTempoEpochs = [{ effectiveAt, beatIndexAt, secondsPerBeat }];
  }

  private appendMetronomeTempoEpoch(
    playback: ActivePlayback,
    effectiveAt: number,
    beatIndexAt: number,
    secondsPerBeat: number,
  ): void {
    const epochs = playback.metronomeTempoEpochs;
    while (epochs.length > 0 && epochs.at(-1)!.effectiveAt >= effectiveAt) epochs.pop();
    epochs.push({ effectiveAt, beatIndexAt, secondsPerBeat });
  }

  private compactMetronomeTempoEpochs(playback: ActivePlayback, now: number): void {
    const epochs = playback.metronomeTempoEpochs;
    const nextBeatAt = playback.nextMetronomeBeatIndex;
    while (epochs.length > 1
      && epochs[1]!.effectiveAt < now - playback.presentationDelaySeconds
      && epochs[1]!.beatIndexAt <= nextBeatAt) {
      epochs.shift();
    }
  }

  private scheduleMetronomeClick(playback: ActivePlayback, beatIndex: number, when: number): void {
    const output = playback.metronomeGain;
    if (!output) return;
    const context = playback.context;
    const accent = beatIndex % BEATS_PER_BAR === 0;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = accent ? 1_760 : 1_320;
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(accent ? 0.8 : 0.48, when + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + METRONOME_CLICK_DURATION_SECONDS);
    oscillator.connect(envelope);
    envelope.connect(output);
    this.outputNodes.add(envelope);
    this.metronomeSources.set(oscillator, { scheduledAt: when, envelope });
    oscillator.onended = () => this.releaseMetronomeSource(oscillator);

    try {
      oscillator.start(when);
      oscillator.stop(when + METRONOME_CLICK_DURATION_SECONDS);
    } catch (error) {
      this.releaseMetronomeSource(oscillator);
      try {
        oscillator.stop(0);
      } catch {
        // The oscillator may not have started.
      }
      throw error;
    }
  }

  private releaseMetronomeSource(source: OscillatorNode): void {
    source.onended = null;
    const state = this.metronomeSources.get(source);
    this.metronomeSources.delete(source);
    try {
      source.disconnect();
    } catch {
      // The oscillator may already have disconnected at its end.
    }
    if (state) {
      this.outputNodes.delete(state.envelope);
      disconnectNode(state.envelope);
    }
  }

  private cancelFutureMetronomeClicks(now: number, presentationDelaySeconds: number): void {
    for (const [source, state] of this.metronomeSources) {
      // A click whose musical onset passed is already part of the current phrase,
      // even if output latency means its oscillator start is still in the future.
      if (state.scheduledAt <= now + presentationDelaySeconds) continue;
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // The click may already have ended during a tempo change.
      }
      this.releaseMetronomeSource(source);
    }
  }

  private scheduleCycleEvents(playback: ActivePlayback, now: number, schedulingHorizon: number): void {
    let cyclePlan = playback.cyclePlan;
    const dynamic = playback.dynamicCycle;
    if (!cyclePlan || (!dynamic && cyclePlan.events.length === 0)) return;

    if (dynamic?.awaitingBoundaryAt !== undefined) {
      if (now >= dynamic.awaitingBoundaryAt) {
        this.activateNextCyclePlan(playback);
        if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
        cyclePlan = playback.cyclePlan;
        if (!cyclePlan) return;
      } else {
        this.schedulePreparedCyclePlan(playback, dynamic, now, schedulingHorizon);
        return;
      }
    }

    if (!dynamic && playback.nextEventIndex >= cyclePlan.events.length) {
      this.completeScheduledCycle(playback);
    }
    if (!dynamic) this.skipExpiredCycles(playback, now);

    let advancedCycles = 0;
    while (true) {
      const activePlan = playback.cyclePlan;
      const activeDynamic = playback.dynamicCycle;
      if (!activePlan) return;

      if (activeDynamic
        && !activeDynamic.providerRequested
        && activeDynamic.cyclesScheduledInPlan === activeDynamic.cyclesPerPlan - 1
        && playback.nextCycleStartAt <= schedulingHorizon) {
        this.prepareNextCyclePlan(playback, activeDynamic);
        if (!this.isCurrent(playback.generation)) return;
      }

      if (playback.nextEventIndex >= activePlan.events.length) {
        if (activePlan.events.length === 0) {
          if (playback.nextCycleStartAt + activePlan.totalSeconds > schedulingHorizon) break;
          this.completeScheduledCycle(playback);
          advancedCycles += 1;
          if (activeDynamic?.awaitingBoundaryAt !== undefined) {
            if (now >= activeDynamic.awaitingBoundaryAt) {
              this.assertDynamicCatchUpCapacity(advancedCycles);
              this.activateNextCyclePlan(playback);
              if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
              continue;
            }
            this.schedulePreparedCyclePlan(playback, activeDynamic, now, schedulingHorizon);
            break;
          }
          if (activeDynamic && advancedCycles >= MAX_DYNAMIC_CYCLE_ADVANCES_PER_TICK) {
            this.assertDynamicCatchUpCapacity(advancedCycles);
          }
          continue;
        }
        this.completeScheduledCycle(playback);
        advancedCycles += 1;
        if (activeDynamic?.awaitingBoundaryAt !== undefined) {
          if (now >= activeDynamic.awaitingBoundaryAt) {
            this.assertDynamicCatchUpCapacity(advancedCycles);
            this.activateNextCyclePlan(playback);
            if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
            continue;
          }
          this.schedulePreparedCyclePlan(playback, activeDynamic, now, schedulingHorizon);
          break;
        }
        if (!activeDynamic) this.skipExpiredCycles(playback, now);
        if (activeDynamic && advancedCycles >= MAX_DYNAMIC_CYCLE_ADVANCES_PER_TICK) {
          this.assertDynamicCatchUpCapacity(advancedCycles);
        }
        continue;
      }

      const event = activePlan.events[playback.nextEventIndex];
      if (!event) break;
      const when = playback.nextCycleStartAt + event.offsetSeconds;
      if (when > schedulingHorizon) break;

      playback.nextEventIndex += 1;
      this.scheduleEvent(playback, event, when, now);

      if (playback.nextEventIndex >= activePlan.events.length) {
        this.completeScheduledCycle(playback);
        advancedCycles += 1;
        if (playback.dynamicCycle?.awaitingBoundaryAt !== undefined) {
          if (now >= playback.dynamicCycle.awaitingBoundaryAt) {
            this.assertDynamicCatchUpCapacity(advancedCycles);
            this.activateNextCyclePlan(playback);
            if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
            continue;
          }
          this.schedulePreparedCyclePlan(playback, playback.dynamicCycle, now, schedulingHorizon);
          break;
        }
        if (!playback.dynamicCycle) this.skipExpiredCycles(playback, now);
        if (playback.dynamicCycle && advancedCycles >= MAX_DYNAMIC_CYCLE_ADVANCES_PER_TICK) {
          this.assertDynamicCatchUpCapacity(advancedCycles);
        }
      }
    }
  }

  private assertDynamicCatchUpCapacity(advancedCycles: number): void {
    if (advancedCycles >= MAX_DYNAMIC_CYCLE_ADVANCES_PER_TICK) {
      throw new Error("Auto-generate fell too far behind the audio clock. Playback stopped; press Play to restart from the current combo.");
    }
  }

  private completeScheduledCycle(playback: ActivePlayback): void {
    const cyclePlan = playback.cyclePlan;
    if (!cyclePlan) return;
    playback.nextEventIndex = 0;
    playback.nextCycleStartAt += cyclePlan.totalSeconds;
    const dynamic = playback.dynamicCycle;
    if (dynamic) {
      dynamic.cyclesScheduledInPlan += 1;
      if (dynamic.cyclesScheduledInPlan >= dynamic.cyclesPerPlan) {
        dynamic.awaitingBoundaryAt = playback.nextCycleStartAt;
      }
    }
    if (!playback.tempoTrainingRoundIncomplete) {
      this.advanceTempoTrainingRound(playback, playback.nextCycleStartAt);
    }
    playback.tempoTrainingRoundIncomplete = false;
  }

  private advanceTempoTrainingRound(playback: ActivePlayback, boundaryAt: number): void {
    const training = playback.tempoTraining;
    if (!training) return;
    training.scheduledRounds = boundedCount(training.scheduledRounds + 1);
    training.pendingRoundBoundaries.push(boundaryAt);
    if (playback.bpm >= training.targetBpm) return;
    training.roundsSinceStep += 1;
    if (training.roundsSinceStep < training.roundsPerStep) return;
    training.roundsSinceStep = 0;
    const nextBpm = Math.min(training.targetBpm, playback.bpm + training.stepBpm);
    if (nextBpm <= playback.bpm) return;
    this.applyTempoTrainingStepAtBoundary(playback, nextBpm, boundaryAt);
  }

  private confirmPresentedTempoTrainingRounds(
    training: ActiveTempoTraining,
    presentationTime: number,
  ): void {
    while (training.pendingRoundBoundaries[0] !== undefined
      && training.pendingRoundBoundaries[0] <= presentationTime) {
      training.pendingRoundBoundaries.shift();
      training.presentedRounds = boundedCount(training.presentedRounds + 1);
    }
  }

  private applyTempoTrainingStepAtBoundary(
    playback: ActivePlayback,
    nextBpm: number,
    boundaryAt: number,
  ): void {
    const currentPlan = playback.cyclePlan;
    const training = playback.tempoTraining;
    if (!currentPlan || !training || this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;

    const tempoRatio = this.validateTempoRatio(nextBpm, playback.sampleReferenceBpm);
    const beatTempoRatio = this.validateTempoRatio(nextBpm, playback.beatReferenceBpm);
    const nextPlan = rescaleCyclePlanTimeline(currentPlan, nextBpm);
    const now = playback.context.currentTime;

    // Keep clicks whose musical onset has already passed, then rebuild only future clicks
    // on a piecewise beat grid that changes at the same round boundary as the samples.
    this.scheduleMetronomeClicks(playback, now, now + playback.presentationDelaySeconds);
    this.cancelFutureMetronomeClicks(now, playback.presentationDelaySeconds);
    const boundaryBeat = this.metronomeBeatIndexAt(playback, boundaryAt);
    this.appendMetronomeTempoEpoch(
      playback,
      boundaryAt,
      boundaryBeat,
      nextPlan.secondsPerUnit * nextPlan.unitsPerBeat,
    );
    const currentBeat = this.metronomeBeatIndexAt(playback, now);
    playback.nextMetronomeBeatIndex = Math.max(0, Math.floor(currentBeat + 1e-9) + 1);

    playback.timeline = nextPlan;
    playback.cyclePlan = nextPlan;
    playback.startAt = boundaryAt;
    playback.fixtureEndAt = boundaryAt + nextPlan.totalSeconds;
    playback.nextCycleStartAt = boundaryAt;
    playback.cycleIterationBase = training.scheduledRounds;
    playback.bpm = nextBpm;
    playback.tempoRatio = tempoRatio;
    playback.beatTempoRatio = beatTempoRatio;
    if (playback.dynamicCycle?.preparedTimeline) {
      playback.dynamicCycle.preparedTimeline = rescaleCyclePlanTimeline(
        playback.dynamicCycle.preparedTimeline,
        nextBpm,
      );
    }

    const parameterAt = Math.max(now, boundaryAt);
    if (playback.processor) setAudioParamValueAt(playback.processor.playbackRate, tempoRatio, parameterAt);
    if (playback.beatProcessor) setAudioParamValueAt(playback.beatProcessor.playbackRate, beatTempoRatio, parameterAt);
    if (playback.beatSource) setAudioParamValueAt(playback.beatSource.playbackRate, beatTempoRatio, parameterAt);
    // Keep native source-rate compensation aligned with SoundTouch at the exact
    // boundary, including long hits already running or queued into lookahead.
    for (const source of this.sampleSources.keys()) {
      setAudioParamValueAt(source.playbackRate, tempoRatio, parameterAt);
    }
    this.appendPresentationEpoch(playback, boundaryAt, playback.dynamicCycle?.planIndex);
  }

  private schedulePreparedCyclePlan(
    playback: ActivePlayback,
    dynamic: DynamicCyclePlayback,
    now: number,
    schedulingHorizon: number,
  ): void {
    const boundaryAt = dynamic.awaitingBoundaryAt;
    const timeline = dynamic.preparedTimeline;
    if (boundaryAt === undefined || !timeline || dynamic.providerError) return;

    let eventIndex = dynamic.preparedEventIndex ?? 0;
    while (eventIndex < timeline.events.length) {
      const event = timeline.events[eventIndex];
      if (!event) break;
      const when = boundaryAt + event.offsetSeconds;
      if (when > schedulingHorizon) break;
      eventIndex += 1;
      this.scheduleEvent(playback, event, when, now);
    }
    dynamic.preparedEventIndex = eventIndex;
  }

  private prepareNextCyclePlan(playback: ActivePlayback, dynamic: DynamicCyclePlayback): void {
    dynamic.providerRequested = true;
    const request: CyclePlanRequest = {
      completedRounds: boundedCount(dynamic.completedRounds + dynamic.cyclesScheduledInPlan),
      nextPlanIndex: boundedCount(dynamic.planIndex + 1),
    };

    try {
      const definition = dynamic.nextPlan(request);
      if (!this.isCurrent(playback.generation) || this.activePlayback !== playback) return;
      if (isPromiseLike(definition)) {
        void Promise.resolve(definition).catch(() => undefined);
        throw new Error("The nextPlan provider must return synchronously; candidate sample files are preloaded before playback.");
      }
      if (!definition || !Array.isArray(definition.slots)) {
        throw new Error("The nextPlan provider must synchronously return a plan with a slots array.");
      }
      const timeline = createCyclePlanTimeline(
        definition.slots,
        playback.timeline.bpm,
        playback.timeline.unitsPerBeat,
      );
      if (timeline.totalUnits !== playback.cyclePlan?.totalUnits) {
        throw new Error("The next combo plan must keep the current total length in raw ticks.");
      }
      for (const event of timeline.events) {
        if (!event.silent && !playback.buffers.has(event.sampleId)) {
          throw new Error(`Auto-generated sample “${event.sampleId}” was not preloaded. Add it to preloadSampleIds and try again.`);
        }
      }
      dynamic.preparedPlan = definition;
      dynamic.preparedTimeline = timeline;
    } catch (error) {
      dynamic.providerError = `Auto-generate could not prepare the next combo. ${describeError(error)}`;
    }
  }

  private activateNextCyclePlan(playback: ActivePlayback): void {
    const dynamic = playback.dynamicCycle;
    const currentPlan = playback.cyclePlan;
    if (!dynamic || !currentPlan || dynamic.awaitingBoundaryAt === undefined) return;
    if (!dynamic.providerRequested) this.prepareNextCyclePlan(playback, dynamic);
    if (dynamic.providerError) throw new Error(dynamic.providerError);
    const definition = dynamic.preparedPlan;
    const nextPlan = dynamic.preparedTimeline;
    if (!definition || !nextPlan) {
      throw new Error("Auto-generate did not prepare a next combo at the plan boundary.");
    }

    const boundaryAt = dynamic.awaitingBoundaryAt;
    playback.cycleIterationBase = boundedCount(dynamic.planStartCycleGlobal + dynamic.cyclesPerPlan);
    playback.startAt = boundaryAt;
    playback.fixtureEndAt = boundaryAt + nextPlan.totalSeconds;
    playback.timeline = nextPlan;
    playback.cyclePlan = nextPlan;
    playback.nextCycleStartAt = boundaryAt;
    playback.nextEventIndex = dynamic.preparedEventIndex ?? 0;
    dynamic.completedRounds = boundedCount(dynamic.completedRounds + dynamic.cyclesPerPlan);
    dynamic.planIndex = boundedCount(dynamic.planIndex + 1);
    dynamic.planStartCycleGlobal = playback.cycleIterationBase;
    dynamic.cyclesScheduledInPlan = 0;
    dynamic.providerRequested = false;
    delete dynamic.awaitingBoundaryAt;
    delete dynamic.preparedPlan;
    delete dynamic.preparedTimeline;
    delete dynamic.preparedEventIndex;
    delete dynamic.providerError;

    this.appendPresentationEpoch(playback, boundaryAt, dynamic.planIndex);

    playback.pendingPresentationBoundaries.push({
      at: boundaryAt,
      boundary: {
        planIndex: dynamic.planIndex,
        completedRounds: dynamic.completedRounds,
        plan: definition,
      },
      ...(dynamic.onPlanBoundary ? { handler: dynamic.onPlanBoundary } : {}),
    });
  }

  private skipExpiredCycles(playback: ActivePlayback, now: number): void {
    const cyclePlan = playback.cyclePlan;
    if (!cyclePlan) return;

    const fullyExpiredCycles = playback.nextCycleStartAt + cyclePlan.totalSeconds <= now - playback.maxSampleDuration
      ? Math.floor((now - playback.maxSampleDuration - playback.nextCycleStartAt) / cyclePlan.totalSeconds)
      : 0;
    // With training enabled, a round whose start already passed cannot be a full
    // practice pass after a scheduler stall, even if a long sample tail is seekable.
    const missedTrainerCycles = playback.tempoTraining && playback.nextEventIndex === 0
      ? Math.max(0, Math.ceil((now - playback.nextCycleStartAt) / cyclePlan.totalSeconds))
      : 0;
    const cyclesToSkip = Math.max(fullyExpiredCycles, missedTrainerCycles);
    if (cyclesToSkip <= 0) return;

    playback.nextCycleStartAt += cyclesToSkip * cyclePlan.totalSeconds;
    playback.nextEventIndex = 0;

    const training = playback.tempoTraining;
    if (training) {
      // Missed rounds leave both BPM and cadence untouched. Rebase the heard phase at
      // the next on-time pass so skipped wall-clock cycles never appear as progress.
      playback.startAt = playback.nextCycleStartAt;
      playback.fixtureEndAt = playback.startAt + cyclePlan.totalSeconds;
      const presentationTime = this.presentationTimeAt(playback);
      this.confirmPresentedTempoTrainingRounds(training, presentationTime);
      playback.cycleIterationBase = training.presentedRounds;
      playback.presentationEpochs = playback.presentationEpochs.filter(
        (epoch) => epoch.effectiveAt <= now,
      );
      this.appendPresentationEpoch(playback, now, playback.dynamicCycle?.planIndex);
    }
  }

  private scheduleEvent(playback: ActivePlayback, event: FixtureTimeline["events"][number], when: number, now: number): void {
    if (event.silent) return;

    const buffer = playback.buffers.get(event.sampleId);
    if (!buffer) {
      throw new Error(`Audio for “${event.sampleId}” could not be loaded. Re-import its WAV file and try again.`);
    }
    const elapsedSeconds = Math.max(0, now - when);
    if (playback.tempoTraining && elapsedSeconds > 0) {
      playback.tempoTrainingRoundIncomplete = true;
    }
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

  private scheduleProcessorKeepAlive(
    context: AudioContext,
    processor: TempoPitchProcessorNode,
    startAt: number,
    stopAt?: number,
  ): ConstantSourceNode {
    const source = context.createConstantSource();
    source.offset.value = 0;
    source.connect(processor);
    this.keepAliveSources.add(source);
    this.outputNodes.add(source);
    source.onended = () => this.releaseKeepAlive(source);
    try {
      source.start(startAt);
      if (stopAt !== undefined) source.stop(stopAt);
    } catch (error) {
      this.releaseKeepAlive(source);
      try {
        source.stop(0);
      } catch {
        // The node may not have started.
      }
      throw error;
    }
    return source;
  }

  private releaseKeepAlive(source: ConstantSourceNode): void {
    source.onended = null;
    this.keepAliveSources.delete(source);
    this.outputNodes.delete(source);
    try {
      source.disconnect();
    } catch {
      // The context may already have disconnected this node.
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
    playbackFrames?: BeatPlaybackFrameRange,
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
    if (playbackFrames) {
      source.loopStart = playbackFrames.startFrame / buffer.sampleRate;
      source.loopEnd = playbackFrames.endFrame / buffer.sampleRate;
    }
    source.connect(gain);
    this.sources.add(source);
    source.onended = () => this.releaseSource(source);

    try {
      if (playbackFrames) source.start(startAt, playbackFrames.startFrame / buffer.sampleRate);
      else source.start(startAt);
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

  private decodeBeatFile(context: AudioContext, file: File): Promise<AudioBuffer> {
    const cached = this.beatFileBufferCache.get(file);
    if (cached) return cached;

    const decoding = decodeLocalAudioFile(context, file);
    this.beatFileBufferCache.set(file, decoding);
    void decoding.catch(() => this.beatFileBufferCache.delete(file));
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

    for (const [source, state] of this.metronomeSources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // Stop is best-effort for click nodes that already ended.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore duplicate disconnects during cancellation.
      }
      try {
        state.envelope.disconnect();
      } catch {
        // The click envelope may already have been disconnected by its end callback.
      }
    }
    this.metronomeSources.clear();

    for (const source of this.keepAliveSources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // Stop is best-effort during playback replacement or context shutdown.
      }
      try {
        source.disconnect();
      } catch {
        // The node may already have ended.
      }
    }
    this.keepAliveSources.clear();

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
      throw new Error(`BPM must stay between ${formatBpm(referenceBpm * 0.5)} and ${formatBpm(referenceBpm * 2)} for this audio layer.`);
    }
    return ratio;
  }

  private validateTempoTrainingOptions(
    value: TempoTrainingOptions,
    startingBpm: number,
    sampleReferenceBpm: number,
    beatReferenceBpm: number,
  ): TempoTrainingOptions {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Tempo training settings must include a target BPM, step BPM, and rounds per step.");
    }
    const targetBpm = positiveBpm(value.targetBpm, "Tempo training target BPM");
    if (targetBpm < startingBpm) {
      throw new Error("Tempo training target BPM must be at least the starting BPM.");
    }
    this.validateTempoRatio(targetBpm, sampleReferenceBpm);
    this.validateTempoRatio(targetBpm, beatReferenceBpm);

    if (!Number.isFinite(value.stepBpm)
      || value.stepBpm < MIN_TEMPO_TRAINING_STEP_BPM
      || value.stepBpm > MAX_TEMPO_TRAINING_STEP_BPM) {
      throw new Error(`Tempo training step BPM must be between ${MIN_TEMPO_TRAINING_STEP_BPM} and ${MAX_TEMPO_TRAINING_STEP_BPM}.`);
    }
    if (!Number.isSafeInteger(value.roundsPerStep)
      || value.roundsPerStep < 1
      || value.roundsPerStep > MAX_TEMPO_TRAINING_ROUNDS_PER_STEP) {
      throw new Error(`Tempo training rounds per step must be a whole number between 1 and ${MAX_TEMPO_TRAINING_ROUNDS_PER_STEP}.`);
    }
    return { targetBpm, stepBpm: value.stepBpm, roundsPerStep: value.roundsPerStep };
  }

  private createActiveTempoTraining(
    options: TempoTrainingOptions,
    startingBpm: number,
    sampleReferenceBpm: number,
    beatReferenceBpm: number,
  ): ActiveTempoTraining {
    return {
      ...this.validateTempoTrainingOptions(options, startingBpm, sampleReferenceBpm, beatReferenceBpm),
      startingBpm,
      scheduledRounds: 0,
      roundsSinceStep: 0,
      presentedRounds: 0,
      pendingRoundBoundaries: [],
    };
  }

  private restoreCurrentScheduleEpoch(playback: ActivePlayback, now: number): void {
    const epoch = this.presentationEpochAt(playback, now);
    if ("slots" in epoch.timeline) {
      const cyclePlan = epoch.timeline as CyclePlanTimeline;
      playback.timeline = cyclePlan;
      playback.cyclePlan = cyclePlan;
    }
    playback.startAt = epoch.startAt;
    playback.cycleIterationBase = epoch.cycleIterationBase;
    playback.bpm = epoch.bpm;
    playback.tempoRatio = this.validateTempoRatio(epoch.bpm, playback.sampleReferenceBpm);
    playback.beatTempoRatio = this.validateTempoRatio(epoch.bpm, playback.beatReferenceBpm);
    playback.presentationEpochs = playback.presentationEpochs.filter((candidate) => candidate.effectiveAt <= now);
  }

  private retimePlayback(playback: ActivePlayback, bpm: number, tempoRatio: number): void {
    if (playback.context.currentTime >= playback.finishAt && !playback.cyclePlan) {
      this.tick(playback.generation);
      if (this.activePlayback !== playback) return;
    }

    const now = playback.context.currentTime;
    // Commit any click whose musical onset has passed under the old phase before
    // moving the beat cursor. With a 130 ms processor delay and a 100 ms lookahead,
    // that click can still be just outside the regular scheduler's output horizon.
    this.scheduleMetronomeClicks(
      playback,
      now,
      now + playback.presentationDelaySeconds,
    );
    this.cancelFutureMetronomeClicks(now, playback.presentationDelaySeconds);
    let activatedPlanAtBoundary = false;
    const dynamic = playback.dynamicCycle;
    if (dynamic?.awaitingBoundaryAt !== undefined && now >= dynamic.awaitingBoundaryAt) {
      this.activateNextCyclePlan(playback);
      if (this.activePlayback !== playback || !this.isCurrent(playback.generation)) return;
      activatedPlanAtBoundary = true;
    }
    const scheduledAtBoundaryIndex = activatedPlanAtBoundary ? playback.nextEventIndex : undefined;
    // Flush events due under the old tempo before invalidating only its future lookahead.
    if (!activatedPlanAtBoundary) this.scheduleDueEvents(playback, now, now + this.lookAheadSeconds);
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
    const oldBeatPosition = this.metronomeBeatIndexAt(playback, now);
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
    const newSecondsPerBeat = playback.timeline.secondsPerUnit * playback.timeline.unitsPerBeat;
    this.replaceMetronomeTempoEpochs(playback, now, oldBeatPosition, newSecondsPerBeat);
    playback.nextMetronomeBeatIndex = Math.max(0, Math.floor(oldBeatPosition) + 1);
    playback.tempoRatio = tempoRatio;
    playback.beatTempoRatio = this.validateTempoRatio(bpm, playback.beatReferenceBpm);
    playback.bpm = bpm;
    playback.startAt = hadStarted
      ? now - positionUnits * playback.timeline.secondsPerUnit
      : playback.startAt;
    playback.fixtureEndAt = playback.startAt + playback.timeline.totalSeconds;
    if (playback.cyclePlan) {
      playback.nextCycleStartAt = playback.startAt;
      playback.cycleIterationBase = previousIteration;
      if (dynamic) {
        dynamic.cyclesScheduledInPlan = Math.max(0, Math.min(
          dynamic.cyclesPerPlan - 1,
          previousIteration - dynamic.planStartCycleGlobal,
        ));
        delete dynamic.awaitingBoundaryAt;
        delete dynamic.preparedEventIndex;
        if (dynamic.preparedTimeline) {
          dynamic.preparedTimeline = rescaleCyclePlanTimeline(dynamic.preparedTimeline, bpm);
        }
      }
    }

    playback.nextEventIndex = activatedPlanAtBoundary
      ? scheduledPrefixCursorAtPosition(playback.timeline.events, scheduledAtBoundaryIndex ?? 0, positionUnits)
      : !hadStarted
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
    if (playback.keepAliveSources.length > 0) {
      if (playback.cyclePlan) {
        delete playback.drainEndAt;
      } else {
        playback.drainEndAt = finishAt + SOUNDTOUCH_FINITE_DRAIN_SECONDS;
        for (const source of playback.keepAliveSources) {
          try {
            source.stop(playback.drainEndAt);
          } catch {
            // The zero-input keep-alive may have ended during context shutdown.
          }
        }
      }
    }

    this.appendPresentationEpoch(
      playback,
      now,
      playback.dynamicCycle?.planIndex,
    );

    if (playback.processor) setAudioParamValue(playback.processor.playbackRate, tempoRatio, now);
    if (playback.beatProcessor) setAudioParamValue(playback.beatProcessor.playbackRate, playback.beatTempoRatio, now);
    for (const source of this.sources) {
      if (source === playback.beatSource) {
        setAudioParamValue(source.playbackRate, playback.beatTempoRatio, now);
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

function createDynamicCycleConfig(options: InternalPlaybackOptions): Omit<
  DynamicCyclePlayback,
  | "planIndex"
  | "completedRounds"
  | "cyclesScheduledInPlan"
  | "planStartCycleGlobal"
  | "providerRequested"
  | "awaitingBoundaryAt"
  | "preparedPlan"
  | "preparedTimeline"
  | "preparedEventIndex"
  | "providerError"
> | undefined {
  if (!options.nextPlan) {
    if (options.cyclesPerPlan !== undefined || options.onPlanBoundary !== undefined || options.preloadSampleIds !== undefined) {
      throw new Error("cyclesPerPlan, onPlanBoundary, and preloadSampleIds require a nextPlan provider.");
    }
    return undefined;
  }
  if (typeof options.nextPlan !== "function") {
    throw new Error("nextPlan must be a synchronous function when Auto-generate is enabled.");
  }
  if (![1, 2, 4, 8].includes(options.cyclesPerPlan ?? 0)) {
    throw new Error("cyclesPerPlan must be 1, 2, 4, or 8 when Auto-generate is enabled.");
  }
  return {
    cyclesPerPlan: options.cyclesPerPlan!,
    nextPlan: options.nextPlan,
    ...(options.onPlanBoundary ? { onPlanBoundary: options.onPlanBoundary } : {}),
  };
}

class StalePlaybackError extends Error {}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (shouldContinue()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      if (!shouldContinue()) return;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function boundedCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function volumeValue(value: number | undefined, label: string): number {
  const normalized = value ?? 100;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${label} must be a finite percentage between 0 and 100.`);
  }
  return normalized / 100;
}

function countInBarsValue(value: 0 | 1 | 2 | undefined): 0 | 1 | 2 {
  const bars = value ?? 0;
  if (bars !== 0 && bars !== 1 && bars !== 2) {
    throw new Error("Count-in must be disabled or set to one or two 4/4 bars.");
  }
  return bars;
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

function setAudioParamValueAt(parameter: AudioParam, value: number, effectiveAt: number): void {
  try {
    parameter.cancelScheduledValues(effectiveAt);
    parameter.setValueAtTime(value, effectiveAt);
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

function scheduledPrefixCursorAtPosition(
  events: FixtureTimeline["events"],
  scheduledPrefixLength: number,
  positionUnits: number,
): number {
  const scheduledLimit = Math.min(events.length, Math.max(0, scheduledPrefixLength));
  let cursor = 0;
  while (cursor < scheduledLimit && events[cursor]!.startUnits <= positionUnits) cursor += 1;
  return cursor;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Audio could not be started. Check the selected WAV files and try again.";
}
