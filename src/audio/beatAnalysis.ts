/**
 * Local-only BPM estimation and bounded browser audio import for a beat track.
 * The detector works on decoded PCM; this module never sends audio off-device.
 */

const MIN_ANALYSIS_SECONDS = 8;
const MAX_ANALYSIS_SECONDS = 120;
const ANALYSIS_FRAME_SECONDS = 0.01;
const MIN_DETECTABLE_BPM = 50;
const MAX_DETECTABLE_BPM = 200;
const MIN_CORRELATION = 0.14;
const OCTAVE_CORRELATION_RATIO = 0.55;

export const MAX_LOCAL_AUDIO_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LOCAL_AUDIO_DURATION_SECONDS = 10 * 60;
export const MAX_DECODED_AUDIO_CHANNEL_SAMPLES = 60_000_000;
export const MAX_BPM_ANALYSIS_SECONDS = MAX_ANALYSIS_SECONDS;

export type BpmDetectionResult =
  | {
      readonly status: "detected";
      /** Best estimate, rounded to one decimal BPM. */
      readonly bpm: number;
      /** A normalized autocorrelation score, not a probability or calibrated accuracy. */
      readonly confidence: number;
      /** Other plausible estimates, excluding `bpm`, strongest first. */
      readonly alternatives: readonly number[];
    }
  | {
      readonly status: "ambiguous";
      /** Competing estimates, strongest first; may include half/double-time choices. */
      readonly candidates: readonly number[];
      /** A normalized autocorrelation score, not a probability or calibrated accuracy. */
      readonly confidence: number;
    }
  | {
      readonly status: "insufficient";
      readonly reason: "invalid-audio" | "too-short" | "silence" | "no-periodic-tempo";
    };

export interface LocalAudioAnalysis {
  readonly buffer: AudioBuffer;
  readonly detection: BpmDetectionResult;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channelCount: number;
}

interface TempoCandidate {
  readonly bpm: number;
  readonly score: number;
}

/**
 * Estimate a beat period from a short, decoded PCM window. This intentionally
 * reports half/double-time ambiguity instead of silently picking one when the
 * signal supports both interpretations.
 */
export function detectBpmFromPcm(
  channels: readonly Float32Array[],
  sampleRate: number,
): BpmDetectionResult {
  if (!validPcm(channels, sampleRate)) return insufficient("invalid-audio");

  const frameSamples = Math.max(1, Math.round(sampleRate * ANALYSIS_FRAME_SECONDS));
  const frameCount = Math.floor(channels[0]!.length / frameSamples);
  const durationSeconds = frameCount * frameSamples / sampleRate;
  if (durationSeconds < MIN_ANALYSIS_SECONDS) return insufficient("too-short");

  const frameRms = new Float64Array(frameCount);
  const channelCount = channels.length;
  let totalSquare = 0;
  let maximumAbsoluteValue = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSamples;
    const end = start + frameSamples;
    let frameSquare = 0;
    for (const channel of channels) {
      for (let index = start; index < end; index += 1) {
        const sample = channel[index]!;
        if (!Number.isFinite(sample)) return insufficient("invalid-audio");
        const absolute = Math.abs(sample);
        if (absolute > maximumAbsoluteValue) maximumAbsoluteValue = absolute;
        frameSquare += sample * sample;
      }
    }
    frameRms[frame] = Math.sqrt(frameSquare / (frameSamples * channelCount));
    totalSquare += frameSquare;
  }

  const overallRms = Math.sqrt(totalSquare / (frameCount * frameSamples * channelCount));
  if (maximumAbsoluteValue < 1e-5 || overallRms < 1e-6) return insufficient("silence");

  // Positive log-energy change emphasizes attacks while damping sustained tones.
  const onset = new Float64Array(frameCount);
  let previousLogEnergy = Math.log1p(frameRms[0]! * 12);
  for (let frame = 1; frame < frameCount; frame += 1) {
    const logEnergy = Math.log1p(frameRms[frame]! * 12);
    onset[frame] = Math.max(0, logEnergy - previousLogEnergy);
    previousLogEnergy = logEnergy;
  }

  const onsetMean = onset.reduce((sum, value) => sum + value, 0) / onset.length;
  if (!Number.isFinite(onsetMean) || onsetMean < 1e-7) return insufficient("no-periodic-tempo");
  for (let index = 0; index < onset.length; index += 1) onset[index] = onset[index]! - onsetMean;

  const minimumLag = Math.floor(60 / MAX_DETECTABLE_BPM / ANALYSIS_FRAME_SECONDS);
  const maximumLag = Math.ceil(60 / MIN_DETECTABLE_BPM / ANALYSIS_FRAME_SECONDS);
  const scores = new Float64Array(maximumLag + 1);
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (lag * 2 >= frameCount) continue;
    let dot = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const usableFrames = frameCount - lag;
    for (let index = lag; index < frameCount; index += 1) {
      const left = onset[index]!;
      const right = onset[index - lag]!;
      dot += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    if (leftEnergy > 0 && rightEnergy > 0 && usableFrames > 0) {
      scores[lag] = Math.max(0, dot / Math.sqrt(leftEnergy * rightEnergy));
    }
  }

  const candidates = findTempoCandidates(scores, minimumLag, maximumLag);
  const strongest = candidates[0];
  if (!strongest || strongest.score < MIN_CORRELATION) return insufficient("no-periodic-tempo");

  const octaveCompetitor = candidates.find((candidate) => {
    const ratio = strongest.bpm / candidate.bpm;
    const octaveRelated = Math.abs(ratio - 2) <= 0.06 || Math.abs(ratio - 0.5) <= 0.015;
    return octaveRelated && candidate.score >= strongest.score * OCTAVE_CORRELATION_RATIO;
  });
  if (octaveCompetitor) {
    const plausible = candidates
      .filter((candidate) => candidate.score >= strongest.score * OCTAVE_CORRELATION_RATIO)
      .slice(0, 3)
      .map(({ bpm }) => bpm);
    return {
      status: "ambiguous",
      candidates: Object.freeze(plausible),
      confidence: roundedConfidence(strongest.score),
    };
  }

  const alternatives = candidates
    .filter((candidate) => candidate.bpm !== strongest.bpm && candidate.score >= Math.max(MIN_CORRELATION, strongest.score * 0.72))
    .slice(0, 3)
    .map(({ bpm }) => bpm);
  return {
    status: "detected",
    bpm: strongest.bpm,
    confidence: roundedConfidence(strongest.score),
    alternatives: Object.freeze(alternatives),
  };
}

/** Validate, decode, and analyze one local WAV or MP3 without uploading it. */
export async function analyzeLocalAudioFile(
  context: BaseAudioContext,
  file: File,
): Promise<LocalAudioAnalysis> {
  const buffer = await decodeLocalAudioFile(context, file);
  const analysisFrames = Math.min(buffer.length, Math.floor(MAX_ANALYSIS_SECONDS * buffer.sampleRate));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index).subarray(0, analysisFrames));
  return Object.freeze({
    buffer,
    detection: detectBpmFromPcm(channels, buffer.sampleRate),
    durationSeconds: buffer.duration,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
  });
}

/** Decode a local WAV/MP3 after size, format, duration, and PCM-budget preflight. */
export async function decodeLocalAudioFile(context: BaseAudioContext, file: File): Promise<AudioBuffer> {
  validateLocalFile(file);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOCAL_AUDIO_FILE_BYTES) {
    throw new Error(`Audio files must be no larger than ${formatMiB(MAX_LOCAL_AUDIO_FILE_BYTES)}.`);
  }

  const fileKind = localFileKind(file);
  const metadata = fileKind === "wav" ? inspectWav(bytes) : inspectMp3(bytes);
  validateContextSampleRate(context.sampleRate);
  validatePreflightMetadata(metadata, context.sampleRate);

  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(bytes);
  } catch {
    throw new Error(`“${file.name || "This audio file"}” could not be decoded. Choose a playable WAV or MP3 file.`);
  }

  validateDecodedBuffer(buffer, context.sampleRate, file.name);
  return buffer;
}

/** Check a predecoded beat buffer before accepting it for playback. */
export function validateLocalAudioBuffer(buffer: AudioBuffer): void {
  if (!buffer || typeof buffer !== "object") {
    throw new Error("The selected beat has no playable audio.");
  }
  validateDecodedBuffer(buffer, buffer.sampleRate, "The selected beat");
}

interface PreflightAudioMetadata {
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channelCount: number;
}

function validPcm(channels: readonly Float32Array[], sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) return false;
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) return false;
  if (channels.some((channel) => !channel || typeof channel.length !== "number" || typeof channel.subarray !== "function")) return false;
  const length = channels[0]?.length ?? 0;
  if (length === 0 || channels.some((channel) => channel.length !== length)) return false;
  const duration = length / sampleRate;
  return duration <= MAX_ANALYSIS_SECONDS;
}

function findTempoCandidates(scores: Float64Array, minimumLag: number, maximumLag: number): TempoCandidate[] {
  const found: TempoCandidate[] = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const score = scores[lag]!;
    if (score <= 0) continue;
    if (score < (scores[lag - 1] ?? 0) || score < (scores[lag + 1] ?? 0)) continue;
    const bpm = roundOneDecimal(60 / (lag * ANALYSIS_FRAME_SECONDS));
    if (bpm < MIN_DETECTABLE_BPM || bpm > MAX_DETECTABLE_BPM) continue;
    if (found.some((candidate) => Math.abs(candidate.bpm - bpm) / bpm < 0.035)) continue;
    found.push({ bpm, score });
  }
  return found.sort((left, right) => right.score - left.score).slice(0, 8);
}

function insufficient(reason: Extract<BpmDetectionResult, { status: "insufficient" }>['reason']): BpmDetectionResult {
  return { status: "insufficient", reason };
}

function roundedConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function validateLocalFile(file: File): void {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isFinite(file.size) || file.size <= 0) {
    throw new Error("Choose a non-empty local WAV or MP3 file.");
  }
  if (file.size > MAX_LOCAL_AUDIO_FILE_BYTES) {
    throw new Error(`Audio files must be no larger than ${formatMiB(MAX_LOCAL_AUDIO_FILE_BYTES)}.`);
  }
  localFileKind(file);
}

function localFileKind(file: File): "wav" | "mp3" {
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const type = typeof file.type === "string" ? file.type.toLowerCase().split(";")[0]?.trim() : "";
  if (name.endsWith(".wav") || type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (name.endsWith(".mp3") || type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  throw new Error("Choose a WAV or MP3 audio file.");
}

function validateContextSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("This browser audio context has an unsupported sample rate.");
  }
}

function validatePreflightMetadata(metadata: PreflightAudioMetadata, outputSampleRate: number): void {
  validateAudioMetadata(metadata, outputSampleRate);
}

function validateDecodedBuffer(buffer: AudioBuffer, outputSampleRate: number, name: string): void {
  if (!buffer || typeof buffer.getChannelData !== "function" || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    throw new Error(`“${name || "This audio file"}” has no playable audio.`);
  }
  validateAudioMetadata({
    durationSeconds: buffer.duration,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
  }, outputSampleRate);
  if (!Number.isInteger(buffer.length) || buffer.length <= 0) {
    throw new Error(`“${name || "This audio file"}” has no playable audio.`);
  }
  if (buffer.length * buffer.numberOfChannels > MAX_DECODED_AUDIO_CHANNEL_SAMPLES) {
    throw new Error("This audio track is too large to keep in browser memory. Choose a shorter or lower-rate file.");
  }
}

function validateAudioMetadata(metadata: PreflightAudioMetadata, outputSampleRate: number): void {
  if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 || metadata.durationSeconds > MAX_LOCAL_AUDIO_DURATION_SECONDS) {
    throw new Error(`Audio tracks must be no longer than ${MAX_LOCAL_AUDIO_DURATION_SECONDS / 60} minutes.`);
  }
  if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate < 8_000 || metadata.sampleRate > 192_000) {
    throw new Error("Audio tracks must use a sample rate between 8 kHz and 192 kHz.");
  }
  if (!Number.isInteger(metadata.channelCount) || metadata.channelCount < 1 || metadata.channelCount > 2) {
    throw new Error("Audio tracks must be mono or stereo.");
  }
  const projectedFrames = Math.ceil(metadata.durationSeconds * outputSampleRate);
  if (!Number.isSafeInteger(projectedFrames) || projectedFrames * metadata.channelCount > MAX_DECODED_AUDIO_CHANNEL_SAMPLES) {
    throw new Error("This audio track is too large to decode safely in the browser. Choose a shorter or lower-rate file.");
  }
}

function inspectWav(buffer: ArrayBuffer): PreflightAudioMetadata {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("The selected WAV file has an invalid RIFF/WAVE header.");
  }
  const riffEnd = 8 + view.getUint32(4, true);
  if (!Number.isSafeInteger(riffEnd) || riffEnd < 12 || riffEnd > view.byteLength) {
    throw new Error("The selected WAV file has an invalid RIFF length.");
  }

  let format: { readonly tag: number; readonly channels: number; readonly sampleRate: number; readonly byteRate: number; readonly blockAlign: number; readonly bits: number } | undefined;
  let audioDataBytes = 0;
  let hasAudioData = false;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const chunkEnd = payloadOffset + chunkSize;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd + (chunkSize % 2) > riffEnd) {
      throw new Error("The selected WAV file contains a truncated audio chunk.");
    }

    if (chunkId === "fmt ") {
      if (format) throw new Error("The selected WAV file contains duplicate format chunks.");
      if (chunkSize < 16) throw new Error("The selected WAV file has an invalid format chunk.");
      format = {
        tag: view.getUint16(payloadOffset, true),
        channels: view.getUint16(payloadOffset + 2, true),
        sampleRate: view.getUint32(payloadOffset + 4, true),
        byteRate: view.getUint32(payloadOffset + 8, true),
        blockAlign: view.getUint16(payloadOffset + 12, true),
        bits: view.getUint16(payloadOffset + 14, true),
      };
    } else if (chunkId === "data") {
      if (!format) throw new Error("The selected WAV file must declare its format before audio data.");
      if (hasAudioData) throw new Error("The selected WAV file contains duplicate audio data chunks.");
      hasAudioData = true;
      audioDataBytes += chunkSize;
      if (!Number.isSafeInteger(audioDataBytes)) throw new Error("The selected WAV file is too large.");
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!format || audioDataBytes === 0) throw new Error("The selected WAV file contains no playable audio data.");
  const pcmEncoding = format.tag === 1 && [8, 16, 24, 32].includes(format.bits);
  const floatEncoding = format.tag === 3 && format.bits === 32;
  if (!pcmEncoding && !floatEncoding) {
    throw new Error("Use an uncompressed PCM or 32-bit float WAV file.");
  }
  if (format.byteRate <= 0 || format.blockAlign <= 0 || format.sampleRate <= 0) {
    throw new Error("The selected WAV file has invalid audio format values.");
  }
  const expectedBlockAlign = format.channels * (format.bits / 8);
  if (!Number.isInteger(expectedBlockAlign)
    || format.blockAlign !== expectedBlockAlign
    || format.byteRate !== format.sampleRate * format.blockAlign
    || audioDataBytes % format.blockAlign !== 0) {
    throw new Error("The selected WAV file has inconsistent audio format metadata.");
  }
  const durationSeconds = audioDataBytes / format.byteRate;
  return {
    durationSeconds,
    sampleRate: format.sampleRate,
    channelCount: format.channels,
  };
}

function inspectMp3(buffer: ArrayBuffer): PreflightAudioMetadata {
  const bytes = new Uint8Array(buffer);
  let startOffset = skipLeadingId3Tag(bytes);
  const firstFrame = findMp3Frame(bytes, startOffset, Math.min(bytes.length, startOffset + 65_536));
  if (firstFrame < 0) throw new Error("The selected MP3 file has no readable MPEG audio frames.");
  startOffset = firstFrame;

  let offset = startOffset;
  let durationSeconds = 0;
  let sampleRate = 0;
  let channelCount = 1;
  let decodedFrames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] === 0x54 && bytes[offset + 1] === 0x41 && bytes[offset + 2] === 0x47) break; // ID3v1 trailer
    const frame = parseMp3FrameHeader(bytes, offset);
    if (!frame) {
      const nextFrame = findMp3Frame(bytes, offset + 1, Math.min(bytes.length, offset + 4096));
      if (nextFrame < 0) break;
      offset = nextFrame;
      continue;
    }
    if (offset + frame.frameLength > bytes.length) break; // Ignore a partial trailing frame.
    sampleRate = sampleRate || frame.sampleRate;
    channelCount = Math.max(channelCount, frame.channelCount);
    durationSeconds += frame.samplesPerFrame / frame.sampleRate;
    decodedFrames += frame.samplesPerFrame;
    if (durationSeconds > MAX_LOCAL_AUDIO_DURATION_SECONDS) {
      throw new Error(`Audio tracks must be no longer than ${MAX_LOCAL_AUDIO_DURATION_SECONDS / 60} minutes.`);
    }
    offset += frame.frameLength;
  }

  if (decodedFrames === 0 || sampleRate === 0) throw new Error("The selected MP3 file has no complete audio frames.");
  return { durationSeconds, sampleRate, channelCount };
}

interface Mp3FrameHeader {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly samplesPerFrame: number;
  readonly frameLength: number;
}

function parseMp3FrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (bytes[offset + 1]! >> 3) & 0x03;
  const layer = (bytes[offset + 1]! >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2]! >> 2) & 0x03;
  const hasPadding = (bytes[offset + 2]! & 0x02) !== 0;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;

  const mpeg1 = version === 3;
  const bitrateTable = mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const baseSampleRates = [44_100, 48_000, 32_000];
  const sampleRate = baseSampleRates[sampleRateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = bitrateTable[bitrateIndex]! * 1_000;
  const samplesPerFrame = mpeg1 ? 1_152 : 576;
  const frameLength = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + Number(hasPadding);
  if (frameLength < 24) return undefined;
  return {
    sampleRate,
    channelCount: ((bytes[offset + 3]! >> 6) & 0x03) === 3 ? 1 : 2,
    samplesPerFrame,
    frameLength,
  };
}

function findMp3Frame(bytes: Uint8Array, from: number, to: number): number {
  const end = Math.min(bytes.length - 4, to);
  for (let offset = Math.max(0, from); offset <= end; offset += 1) {
    const frame = parseMp3FrameHeader(bytes, offset);
    if (!frame || offset + frame.frameLength > bytes.length) continue;
    const nextOffset = offset + frame.frameLength;
    if (nextOffset + 4 > bytes.length || parseMp3FrameHeader(bytes, nextOffset)) return offset;
  }
  return -1;
}

function skipLeadingId3Tag(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const sizeBytes = bytes.subarray(6, 10);
  if (sizeBytes.some((value) => (value & 0x80) !== 0)) throw new Error("The selected MP3 file has an invalid ID3 tag.");
  const size = ((sizeBytes[0]! & 0x7f) << 21)
    | ((sizeBytes[1]! & 0x7f) << 14)
    | ((sizeBytes[2]! & 0x7f) << 7)
    | (sizeBytes[3]! & 0x7f);
  const footerBytes = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  const end = 10 + size + footerBytes;
  if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error("The selected MP3 file contains a truncated ID3 tag.");
  return end;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
