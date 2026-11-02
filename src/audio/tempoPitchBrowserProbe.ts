import { SoundTouchNode, processOffline } from "@soundtouchjs/audio-worklet";
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";

export interface BrowserDspProbeResult {
  readonly before: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly tempoOnly: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly pitchShifted: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly durationSeconds: number;
  readonly finiteInputTailEndSeconds: number;
  readonly sourceContinuityRms: readonly number[];
  readonly transientAlignment: readonly {
    readonly tempoRatio: number;
    readonly pitchSemitones: number;
    readonly measuredDelaySeconds: number;
    readonly repeatedMeasuredDelaysSeconds: readonly (number | null)[];
  }[];
  readonly finitePresentationWindows: readonly {
    readonly paddingMode: "none" | "zero" | "beat";
    readonly tempoRatio: number;
    readonly pitchSemitones: number;
    readonly sourceStartSeconds: number;
    readonly expectedSourceEndSeconds: number;
    readonly firstRenderedSoundSeconds: number;
    readonly lastRenderedSoundSeconds: number;
    readonly renderedTailAfterSourceEndSeconds: number;
    readonly expectedEndMarkerSeconds: number;
    readonly renderedEndMarkerSeconds: number | null;
    readonly endMarkerTimingErrorSeconds: number | null;
  }[];
  readonly finitePaddingComparison: readonly {
    readonly paddingMode: "none" | "zero" | "beat";
    readonly expectedEndMarkerSeconds: number;
    readonly renderedEndMarkerSeconds: number | null;
    readonly endMarkerTimingErrorSeconds: number | null;
    readonly renderedTailAfterSourceEndSeconds: number;
  }[];
  readonly finiteZeroPaddingWindows: readonly {
    readonly tempoRatio: number;
    readonly pitchSemitones: number;
    readonly expectedEndMarkerSeconds: number;
    readonly renderedEndMarkerSeconds: number | null;
    readonly endMarkerTimingErrorSeconds: number | null;
    readonly renderedTailAfterSourceEndSeconds: number;
  }[];
  readonly finitePitchDrainWindows: readonly {
    readonly tempoRatio: number;
    readonly pitchSemitones: number;
    readonly expectedEndMarkerSeconds: number;
    readonly renderedEndMarkerSeconds: number | null;
    readonly endMarkerTimingErrorSeconds: number | null;
    readonly renderedTailAfterSourceEndSeconds: number;
  }[];
}

/** Browser-only integration probe that renders the actual bundled worklet. */
export async function runTempoPitchBrowserProbe(): Promise<BrowserDspProbeResult> {
  const sampleRate = 48_000;
  const renderSeconds = 4;
  const renderContext = new OfflineAudioContext(1, sampleRate * renderSeconds, sampleRate);
  const worklet = await createWorklet(renderContext);
  const sample = createTone(renderContext, 440, 1);
  const beat = createTone(renderContext, 220, 1);
  const sampleGain = renderContext.createGain();
  const beatGain = renderContext.createGain();
  sampleGain.gain.value = 0.25;
  beatGain.gain.value = 0.5;
  sampleGain.connect(worklet);
  beatGain.connect(worklet);
  worklet.connect(renderContext.destination);
  sample.connect(sampleGain);
  beat.connect(beatGain);

  const tempoRatio = 100 / 85;
  sample.playbackRate.setValueAtTime(1, 0);
  beat.playbackRate.setValueAtTime(1, 0);
  worklet.playbackRate.setValueAtTime(1, 0);
  sample.playbackRate.setValueAtTime(tempoRatio, 1.2);
  beat.playbackRate.setValueAtTime(tempoRatio, 1.2);
  worklet.playbackRate.setValueAtTime(tempoRatio, 1.2);
  worklet.pitchSemitones.setValueAtTime(3, 2.4);
  sampleGain.gain.setValueAtTime(0.2, 0.9);
  beatGain.gain.setValueAtTime(0.7, 0.9);
  sample.start(0);
  beat.start(0);

  const rendered = await renderContext.startRendering();
  const data = rendered.getChannelData(0);
  const before = inspectMix(data, sampleRate, 0.5, 0.9, 440, 220);
  const tempoOnly = inspectMix(data, sampleRate, 1.75, 2.1, 440, 220);
  const pitchShifted = inspectMix(data, sampleRate, 3.0, 3.4, 440 * Math.pow(2, 3 / 12), 220 * Math.pow(2, 3 / 12));
  const sourceContinuityRms = [
    rms(data, sampleRate, 1.16, 1.19),
    rms(data, sampleRate, 1.21, 1.24),
    rms(data, sampleRate, 2.36, 2.39),
    rms(data, sampleRate, 2.41, 2.44),
  ];

  const durationInput = createToneBuffer(renderContext, 440, 1.7);
  const processed = await processOffline({
    input: durationInput,
    processorUrl,
    playbackRate: tempoRatio,
    pitchSemitones: 0,
  });
  const finiteInputTailEndSeconds = await renderFiniteSourceTail(sampleRate, tempoRatio);
  const transientAlignment = [];
  for (const rate of [0.5, 0.75, 1, tempoRatio, 2]) {
    for (const pitchSemitones of [0, 3]) {
      transientAlignment.push(await measureTransientAlignment(sampleRate, rate, pitchSemitones));
    }
  }
  const finitePresentationWindows = [];
  for (const rate of [0.5, 1, tempoRatio, 2]) {
    finitePresentationWindows.push(await measureFinitePresentationWindow(sampleRate, rate, 0));
  }
  const finitePaddingComparison = [
    finitePresentationWindows.find((window) => window.tempoRatio === 1)!,
    await measureFinitePresentationWindow(sampleRate, 1, 0, "zero"),
    await measureFinitePresentationWindow(sampleRate, 1, 0, "beat"),
  ];
  const finiteZeroPaddingWindows = [];
  for (const rate of [0.5, 0.75, 1, tempoRatio, 2]) {
    const window = await measureFinitePresentationWindow(sampleRate, rate, 0, "zero");
    finiteZeroPaddingWindows.push({
      tempoRatio: window.tempoRatio,
      pitchSemitones: window.pitchSemitones,
      expectedEndMarkerSeconds: window.expectedEndMarkerSeconds,
      renderedEndMarkerSeconds: window.renderedEndMarkerSeconds,
      endMarkerTimingErrorSeconds: window.endMarkerTimingErrorSeconds,
      renderedTailAfterSourceEndSeconds: window.renderedTailAfterSourceEndSeconds,
    });
  }
  const finitePitchDrainWindows = [];
  for (const pitchSemitones of [-12, 12]) {
    const window = await measureFinitePresentationWindow(sampleRate, 1, pitchSemitones, "zero");
    finitePitchDrainWindows.push({
      tempoRatio: window.tempoRatio,
      pitchSemitones: window.pitchSemitones,
      expectedEndMarkerSeconds: window.expectedEndMarkerSeconds,
      renderedEndMarkerSeconds: window.renderedEndMarkerSeconds,
      endMarkerTimingErrorSeconds: window.endMarkerTimingErrorSeconds,
      renderedTailAfterSourceEndSeconds: window.renderedTailAfterSourceEndSeconds,
    });
  }

  return {
    before,
    tempoOnly,
    pitchShifted,
    durationSeconds: processed.length / processed.sampleRate,
    finiteInputTailEndSeconds,
    sourceContinuityRms,
    transientAlignment,
    finitePresentationWindows,
    finitePaddingComparison,
    finiteZeroPaddingWindows,
    finitePitchDrainWindows,
  };
}

async function measureFinitePresentationWindow(
  sampleRate: number,
  tempoRatio: number,
  pitchSemitones: number,
  paddingMode: "none" | "zero" | "beat" = "none",
): Promise<{
  readonly paddingMode: "none" | "zero" | "beat";
  readonly tempoRatio: number;
  readonly pitchSemitones: number;
  readonly sourceStartSeconds: number;
  readonly expectedSourceEndSeconds: number;
  readonly firstRenderedSoundSeconds: number;
  readonly lastRenderedSoundSeconds: number;
  readonly renderedTailAfterSourceEndSeconds: number;
  readonly expectedEndMarkerSeconds: number;
  readonly renderedEndMarkerSeconds: number | null;
  readonly endMarkerTimingErrorSeconds: number | null;
}> {
  const sourceStartSeconds = 0.05;
  const inputDurationSeconds = 1.5;
  const expectedSourceEndSeconds = sourceStartSeconds + inputDurationSeconds / tempoRatio;
  const context = new OfflineAudioContext(1, Math.ceil(sampleRate * (expectedSourceEndSeconds + 0.5)), sampleRate);
  const worklet = await createWorklet(context);
  const buffer = context.createBuffer(1, Math.ceil(sampleRate * inputDurationSeconds), sampleRate);
  const channel = buffer.getChannelData(0);
  const endMarkerInputStartSeconds = inputDurationSeconds - 0.3;
  const endMarkerInputEndSeconds = inputDurationSeconds - 0.005;
  for (let index = 0; index < channel.length; index += 1) {
    const time = index / sampleRate;
    if (time >= endMarkerInputStartSeconds && time < endMarkerInputEndSeconds) {
      const markerTime = time - endMarkerInputStartSeconds;
      const fade = Math.min(1, markerTime / 0.002, (endMarkerInputEndSeconds - time) / 0.002);
      channel[index] = 0.4 * Math.sin(2 * Math.PI * 1_900 * markerTime) * fade;
    } else if (time < endMarkerInputStartSeconds - 0.005) {
      const fadeIn = Math.min(1, time / 0.005);
      channel[index] = 0.4 * Math.sin(2 * Math.PI * 440 * time) * fadeIn;
    }
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = tempoRatio;
  worklet.playbackRate.value = tempoRatio;
  worklet.pitchSemitones.value = pitchSemitones;
  source.connect(worklet);
  worklet.connect(context.destination);
  source.start(sourceStartSeconds);

  if (paddingMode === "zero") {
    const keepAlive = context.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(worklet);
    keepAlive.start(0);
    keepAlive.stop(expectedSourceEndSeconds + 0.4);
  } else if (paddingMode === "beat") {
    const beatSource = context.createBufferSource();
    beatSource.buffer = createToneBuffer(context, 220, 0.25);
    beatSource.loop = true;
    beatSource.playbackRate.value = tempoRatio;
    beatSource.connect(worklet);
    beatSource.start(sourceStartSeconds);
    beatSource.stop(expectedSourceEndSeconds + 0.4);
  }

  const rendered = await context.startRendering();
  const data = rendered.getChannelData(0);
  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample));
  if (!Number.isFinite(peak) || peak < 0.001) {
    throw new Error(`The worklet produced no finite-source signal at tempo ${tempoRatio}.`);
  }
  const threshold = peak * 0.05;
  let first = -1;
  let last = -1;
  for (let index = 0; index < data.length; index += 1) {
    if (Math.abs(data[index]!) < threshold) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0 || last < 0) throw new Error(`No finite-source output was detected at tempo ${tempoRatio}.`);
  const firstRenderedSoundSeconds = first / sampleRate;
  const lastRenderedSoundSeconds = last / sampleRate;
  const expectedEndMarkerSeconds = sourceStartSeconds + endMarkerInputStartSeconds / tempoRatio;
  const markerSearchStart = Math.max(0, Math.floor((expectedEndMarkerSeconds - 0.15) * sampleRate));
  const markerSearchEnd = Math.min(data.length, Math.ceil((expectedEndMarkerSeconds + 0.15) * sampleRate));
  const markerWindowSamples = Math.floor(sampleRate * 0.006);
  const markerStepSamples = Math.max(1, Math.floor(sampleRate * 0.001));
  const markerThreshold = 0.04;
  const endMarkerOutputFrequency = 1_900 * Math.pow(2, pitchSemitones / 12);
  let renderedEndMarkerSeconds: number | null = null;
  for (let start = markerSearchStart; start + markerWindowSamples <= markerSearchEnd; start += markerStepSamples) {
    if (goertzelAmplitude(data, start, start + markerWindowSamples, sampleRate, endMarkerOutputFrequency) >= markerThreshold) {
      renderedEndMarkerSeconds = start / sampleRate;
      break;
    }
  }
  return {
    paddingMode,
    tempoRatio,
    pitchSemitones,
    sourceStartSeconds,
    expectedSourceEndSeconds,
    firstRenderedSoundSeconds,
    lastRenderedSoundSeconds,
    renderedTailAfterSourceEndSeconds: lastRenderedSoundSeconds - expectedSourceEndSeconds,
    expectedEndMarkerSeconds,
    renderedEndMarkerSeconds,
    endMarkerTimingErrorSeconds: renderedEndMarkerSeconds === null
      ? null
      : renderedEndMarkerSeconds - expectedEndMarkerSeconds,
  };
}

function goertzelAmplitude(data: Float32Array, start: number, end: number, sampleRate: number, frequency: number): number {
  const length = end - start;
  if (length <= 0) return 0;
  let real = 0;
  let imaginary = 0;
  for (let offset = 0; offset < length; offset += 1) {
    const angle = 2 * Math.PI * frequency * offset / sampleRate;
    const sample = data[start + offset] ?? 0;
    real += sample * Math.cos(angle);
    imaginary -= sample * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / length;
}

async function measureTransientAlignment(
  sampleRate: number,
  tempoRatio: number,
  pitchSemitones: number,
): Promise<{
  readonly tempoRatio: number;
  readonly pitchSemitones: number;
  readonly measuredDelaySeconds: number;
  readonly repeatedMeasuredDelaysSeconds: readonly (number | null)[];
}> {
  const inputOnsetSeconds = [0.05, 0.85, 1.65, 2.45];
  const context = new OfflineAudioContext(1, sampleRate * 4, sampleRate);
  const worklet = await createWorklet(context);
  const buffer = context.createBuffer(1, Math.floor(sampleRate * 0.2), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    const time = index / sampleRate;
    channel[index] = 0.5 * Math.sin(2 * Math.PI * 440 * time) * Math.min(1, time / 0.002) * Math.exp(-5 * time);
  }
  worklet.playbackRate.value = tempoRatio;
  worklet.pitchSemitones.value = pitchSemitones;
  worklet.connect(context.destination);
  for (const startAt of inputOnsetSeconds) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = tempoRatio;
    source.connect(worklet);
    source.start(startAt);
  }

  const rendered = await context.startRendering();
  const data = rendered.getChannelData(0);
  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample));
  if (!Number.isFinite(peak) || peak < 0.001) {
    throw new Error(`The worklet produced no usable signal at tempo ${tempoRatio} and pitch ${pitchSemitones}.`);
  }
  const threshold = Math.max(0.0005, peak * 0.04);
  const repeatedMeasuredDelaysSeconds = inputOnsetSeconds.map((expectedOnsetSeconds) => {
    const startIndex = Math.floor(expectedOnsetSeconds * sampleRate);
    const endIndex = Math.min(data.length, Math.ceil((expectedOnsetSeconds + 0.25) * sampleRate));
    let onsetIndex = -1;
    for (let index = startIndex; index < endIndex; index += 1) {
      if (Math.abs(data[index]!) >= threshold) {
        onsetIndex = index;
        break;
      }
    }
    return onsetIndex < 0 ? null : onsetIndex / sampleRate - expectedOnsetSeconds;
  });

  return {
    tempoRatio,
    pitchSemitones,
    measuredDelaySeconds: repeatedMeasuredDelaysSeconds.find((delay) => delay !== null) ?? Number.NaN,
    repeatedMeasuredDelaysSeconds,
  };
}

async function renderFiniteSourceTail(sampleRate: number, tempoRatio: number): Promise<number> {
  const context = new OfflineAudioContext(1, Math.ceil(sampleRate * 0.6), sampleRate);
  const worklet = await createWorklet(context);
  const buffer = createToneBuffer(context, 440, 0.2);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = tempoRatio;
  worklet.playbackRate.value = tempoRatio;
  source.connect(worklet);
  worklet.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  const channel = rendered.getChannelData(0);
  let lastActiveIndex = 0;
  for (let index = 0; index < channel.length; index += 1) {
    if (Math.abs(channel[index]!) > 0.001) lastActiveIndex = index;
  }
  return lastActiveIndex / sampleRate;
}

async function createWorklet(context: OfflineAudioContext): Promise<SoundTouchNode> {
  await SoundTouchNode.register(context, processorUrl);
  return new SoundTouchNode({ context });
}

function createTone(context: OfflineAudioContext, frequency: number, durationSeconds: number): AudioBufferSourceNode {
  const buffer = createToneBuffer(context, frequency, durationSeconds);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function createToneBuffer(context: OfflineAudioContext, frequency: number, durationSeconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * durationSeconds), context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = 0.5 * Math.sin(2 * Math.PI * frequency * index / context.sampleRate);
  }
  return buffer;
}

function inspectMix(
  data: Float32Array,
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
  expectedSampleHz: number,
  expectedBeatHz: number,
): { sampleHz: number; beatHz: number; sampleGain: number; beatGain: number } {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.floor(endSeconds * sampleRate);
  return {
    sampleHz: peakFrequency(data, sampleRate, start, end, expectedSampleHz),
    beatHz: peakFrequency(data, sampleRate, start, end, expectedBeatHz),
    sampleGain: toneAmplitude(data, sampleRate, start, end, expectedSampleHz),
    beatGain: toneAmplitude(data, sampleRate, start, end, expectedBeatHz),
  };
}

function peakFrequency(data: Float32Array, sampleRate: number, start: number, end: number, center: number): number {
  let bestFrequency = center;
  let bestMagnitude = -1;
  for (let frequency = center - 35; frequency <= center + 35; frequency += 1) {
    const magnitude = toneAmplitude(data, sampleRate, start, end, frequency);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestFrequency = frequency;
    }
  }
  return bestFrequency;
}

function toneAmplitude(data: Float32Array, sampleRate: number, start: number, end: number, frequency: number): number {
  let inPhase = 0;
  let quadrature = 0;
  const length = end - start;
  for (let index = start; index < end; index += 1) {
    const phase = 2 * Math.PI * frequency * (index - start) / sampleRate;
    inPhase += data[index]! * Math.cos(phase);
    quadrature += data[index]! * Math.sin(phase);
  }
  return 2 * Math.hypot(inPhase, quadrature) / length;
}

function rms(data: Float32Array, sampleRate: number, startSeconds: number, endSeconds: number): number {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.floor(endSeconds * sampleRate);
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += data[index]! * data[index]!;
  return Math.sqrt(sum / (end - start));
}
