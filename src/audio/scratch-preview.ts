export type ScratchPreviewInput = {
  channels: readonly Float32Array[];
  sourceSampleRate: number;
  outputSampleRate: number;
  durationSeconds: number;
  /** Record positions sampled evenly across the preview, from 0 to 1. */
  positions: readonly number[];
  /** Fader state sampled evenly across the preview. True means open. */
  fader: readonly boolean[];
};

export const SCRATCH_SOURCE_WINDOW_SECONDS = 0.4;
const MINIMUM_SCRATCH_SPEED = 0.02;
const FADE_SECONDS = 0.004;

/** Renders a drawn record path and fader pattern to local PCM for immediate audition. */
export function renderScratchPreview(input: ScratchPreviewInput): Float32Array<ArrayBuffer>[] {
  const {
    channels,
    sourceSampleRate,
    outputSampleRate,
    durationSeconds,
    positions,
    fader,
  } = input;

  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new RangeError("Source sample rate must be a positive number.");
  }
  if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
    throw new RangeError("Output sample rate must be a positive number.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new RangeError("Preview duration must be a non-negative number.");
  }

  const frameCount = Math.floor(durationSeconds * outputSampleRate);
  const result: Float32Array<ArrayBuffer>[] = channels.map(() => new Float32Array(frameCount));
  const longestSource = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0);

  if (frameCount === 0 || longestSource === 0 || positions.length === 0) {
    return result;
  }

  const sourceFrameCount = Math.min(longestSource, Math.floor(sourceSampleRate * SCRATCH_SOURCE_WINDOW_SECONDS));
  const sourceSpan = Math.max(0, sourceFrameCount - 1);
  const fadeFrames = Math.max(1, Math.floor(outputSampleRate * FADE_SECONDS));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / outputSampleRate;
    const progress = durationSeconds === 0 ? 0 : Math.min(1, time / durationSeconds);
    const position = interpolatePosition(positions, progress);
    const segmentIndex = getPositionSegment(positions.length, progress);
    const motionGain = getMotionGain(
      positions,
      segmentIndex,
      sourceSpan,
      sourceSampleRate,
      durationSeconds,
      time,
      fadeFrames,
      outputSampleRate,
    );
    if (motionGain === 0) {
      continue;
    }

    const faderGain = getFaderGain(fader, time, durationSeconds, fadeFrames, outputSampleRate);
    if (faderGain === 0) {
      continue;
    }

    const sourcePosition = position * sourceSpan;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const source = channels[channelIndex];
      const destination = result[channelIndex];
      if (!source || !destination || source.length === 0) {
        continue;
      }
      const boundedPosition = Math.min(source.length - 1, sourcePosition);
      const lowerFrame = Math.floor(boundedPosition);
      const upperFrame = Math.min(source.length - 1, lowerFrame + 1);
      const fraction = boundedPosition - lowerFrame;
      const lowerSample = source[lowerFrame] ?? 0;
      const upperSample = source[upperFrame] ?? 0;
      const lowerValue = Number.isFinite(lowerSample) ? lowerSample : 0;
      const upperValue = Number.isFinite(upperSample) ? upperSample : 0;
      destination[frame] = (lowerValue + (upperValue - lowerValue) * fraction) * faderGain * motionGain;
    }
  }

  return result;
}

/** A short, deterministic harmonic source for trying the editor before loading samples. */
export function makeScratchPreviewSource(sampleRate: number): Float32Array<ArrayBuffer> {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("Sample rate must be a positive number.");
  }

  const frameCount = Math.max(2, Math.floor(sampleRate * SCRATCH_SOURCE_WINDOW_SECONDS));
  const source = new Float32Array(frameCount);
  const fundamental = 145;
  const formants = [1, 0.56, 0.34, 0.23, 0.15, 0.1];

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame === 0 || frame === frameCount - 1) {
      source[frame] = 0;
      continue;
    }
    const phase = (frame / sampleRate) * fundamental * Math.PI * 2;
    let sample = 0;
    for (let harmonic = 0; harmonic < formants.length; harmonic += 1) {
      sample += Math.sin(phase * (harmonic + 1)) * formants[harmonic]!;
    }
    const envelope = Math.sin((Math.PI * frame) / (frameCount - 1)) ** 0.35;
    source[frame] = (sample / 2.38) * envelope * 0.72;
  }

  return source;
}

function interpolatePosition(positions: readonly number[], progress: number): number {
  if (positions.length === 1) {
    return clampPosition(positions[0] ?? 0);
  }

  const scaled = progress * (positions.length - 1);
  const lowerIndex = Math.min(positions.length - 2, Math.floor(scaled));
  const fraction = Math.max(0, Math.min(1, scaled - lowerIndex));
  const lower = clampPosition(positions[lowerIndex] ?? 0);
  const upper = clampPosition(positions[lowerIndex + 1] ?? lower);
  return lower + (upper - lower) * fraction;
}

function getPositionSegment(positionCount: number, progress: number): number {
  if (positionCount < 2) {
    return -1;
  }
  return Math.min(positionCount - 2, Math.floor(progress * (positionCount - 1)));
}

function getMotionGain(
  positions: readonly number[],
  segmentIndex: number,
  sourceSpan: number,
  sourceSampleRate: number,
  durationSeconds: number,
  time: number,
  fadeFrames: number,
  outputSampleRate: number,
): number {
  if (segmentIndex < 0 || durationSeconds === 0) {
    return 0;
  }
  const segmentDuration = durationSeconds / (positions.length - 1);
  const segmentStart = segmentIndex * segmentDuration;
  const segmentEnd = segmentStart + segmentDuration;
  const active = isMovingSegment(positions, segmentIndex, sourceSpan, sourceSampleRate, segmentDuration);
  if (!active) {
    return 0;
  }

  const startsMovingSection = segmentIndex === 0 || !isMovingSegment(
    positions,
    segmentIndex - 1,
    sourceSpan,
    sourceSampleRate,
    segmentDuration,
  );
  const endsMovingSection = segmentIndex === positions.length - 2 || !isMovingSegment(
    positions,
    segmentIndex + 1,
    sourceSpan,
    sourceSampleRate,
    segmentDuration,
  );
  const fadeDuration = Math.min(fadeFrames / outputSampleRate, segmentDuration / 2);
  let gain = 1;

  if (startsMovingSection) {
    gain = Math.min(gain, Math.max(0, Math.min(1, (time - segmentStart) / fadeDuration)));
  }
  if (endsMovingSection) {
    gain = Math.min(gain, Math.max(0, Math.min(1, (segmentEnd - time) / fadeDuration)));
  }
  return gain;
}

function isMovingSegment(
  positions: readonly number[],
  segmentIndex: number,
  sourceSpan: number,
  sourceSampleRate: number,
  segmentDuration: number,
): boolean {
  const lower = clampPosition(positions[segmentIndex] ?? 0);
  const upper = clampPosition(positions[segmentIndex + 1] ?? lower);
  const speed = (Math.abs(upper - lower) * sourceSpan) / sourceSampleRate / segmentDuration;
  return speed >= MINIMUM_SCRATCH_SPEED;
}

function getFaderGain(
  fader: readonly boolean[],
  time: number,
  durationSeconds: number,
  fadeFrames: number,
  outputSampleRate: number,
): number {
  if (fader.length === 0) {
    return 1;
  }

  const stepDuration = durationSeconds / fader.length;
  if (stepDuration <= 0) {
    return 0;
  }

  const step = Math.min(fader.length - 1, Math.floor(time / stepDuration));
  if (!fader[step]) {
    return 0;
  }

  const start = step * stepDuration;
  const end = start + stepDuration;
  const startsOpenSection = step === 0 || !fader[step - 1];
  const endsOpenSection = step === fader.length - 1 || !fader[step + 1];
  const fadeDuration = Math.min(fadeFrames / outputSampleRate, stepDuration / 2);
  let gain = 1;

  if (startsOpenSection) {
    gain = Math.min(gain, Math.max(0, Math.min(1, (time - start) / fadeDuration)));
  }
  if (endsOpenSection) {
    gain = Math.min(gain, Math.max(0, Math.min(1, (end - time) / fadeDuration)));
  }
  return gain;
}

function clampPosition(position: number): number {
  if (!Number.isFinite(position)) {
    return 0;
  }
  return Math.max(0, Math.min(1, position));
}
