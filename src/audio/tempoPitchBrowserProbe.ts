import { SoundTouchNode, processOffline } from "@soundtouchjs/audio-worklet";
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";

export interface BrowserDspProbeResult {
  readonly before: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly tempoOnly: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly pitchShifted: { readonly sampleHz: number; readonly beatHz: number; readonly sampleGain: number; readonly beatGain: number };
  readonly durationSeconds: number;
  readonly finiteInputTailEndSeconds: number;
  readonly sourceContinuityRms: readonly number[];
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

  return {
    before,
    tempoOnly,
    pitchShifted,
    durationSeconds: processed.length / processed.sampleRate,
    finiteInputTailEndSeconds,
    sourceContinuityRms,
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
