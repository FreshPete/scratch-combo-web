/** Manually selected start cue and exclusive loop end, measured in decoded source seconds. */
export interface BeatPlaybackRegion {
  /** Source position used as the first downbeat cue and the start of every repeated loop. */
  readonly startOffsetSeconds: number;
  /** Exclusive source position where playback loops back to startOffsetSeconds; null means buffer end. */
  readonly loopEndSeconds: number | null;
}

export interface BeatPlaybackFrameRange {
  /** Inclusive first frame in the original decoded buffer. */
  readonly startFrame: number;
  /** Exclusive last frame in the original decoded buffer. */
  readonly endFrame: number;
}

/**
 * Resolve a manual beat cue/loop range to decoded source frames without copying or changing PCM.
 * Seconds are rounded to the nearest frame so AudioBufferSourceNode receives frame-aligned bounds.
 */
export function resolveBeatPlaybackFrameRange(
  buffer: Pick<AudioBuffer, "length" | "sampleRate">,
  region: BeatPlaybackRegion,
): BeatPlaybackFrameRange {
  const { length, sampleRate } = buffer;
  if (!Number.isSafeInteger(length) || length <= 0
    || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("The selected beat has invalid decoded audio dimensions.");
  }

  const { startOffsetSeconds, loopEndSeconds } = region;
  if (!Number.isFinite(startOffsetSeconds) || startOffsetSeconds < 0) {
    throw new Error("The beat start cue must be a finite time at or after the beginning of the decoded track.");
  }

  const durationSeconds = length / sampleRate;
  const resolvedLoopEndSeconds = loopEndSeconds === null ? durationSeconds : loopEndSeconds;
  if (!Number.isFinite(resolvedLoopEndSeconds)
    || resolvedLoopEndSeconds <= startOffsetSeconds
    || resolvedLoopEndSeconds > durationSeconds) {
    throw new Error("The beat loop end must be after its start cue and within the decoded track.");
  }

  const startFrame = Math.round(startOffsetSeconds * sampleRate);
  const endFrame = Math.round(resolvedLoopEndSeconds * sampleRate);
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
    || startFrame < 0 || startFrame >= endFrame || endFrame > length) {
    throw new Error("The selected beat loop must contain at least one decoded audio frame.");
  }

  return { startFrame, endFrame };
}
