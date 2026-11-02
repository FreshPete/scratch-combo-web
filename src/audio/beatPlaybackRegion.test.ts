import { describe, expect, it } from "vitest";
import { resolveBeatPlaybackFrameRange, type BeatPlaybackRegion } from "./beatPlaybackRegion";

function bufferFrames(length = 48_000, sampleRate = 48_000): Pick<AudioBuffer, "length" | "sampleRate"> {
  return { length, sampleRate };
}

describe("resolveBeatPlaybackFrameRange", () => {
  it("maps cue and exclusive loop end to exact decoded frames", () => {
    const startFrame = 1_001;
    const endFrame = 33_017;
    const region: BeatPlaybackRegion = {
      startOffsetSeconds: startFrame / 44_100,
      loopEndSeconds: endFrame / 44_100,
    };

    expect(resolveBeatPlaybackFrameRange(bufferFrames(44_100, 44_100), region)).toEqual({
      startFrame,
      endFrame,
    });
  });

  it("uses the full decoded buffer end when the loop end is null", () => {
    expect(resolveBeatPlaybackFrameRange(bufferFrames(96_000), {
      startOffsetSeconds: 0.25,
      loopEndSeconds: null,
    })).toEqual({ startFrame: 12_000, endFrame: 96_000 });
  });

  it.each([
    ["NaN start", { startOffsetSeconds: Number.NaN, loopEndSeconds: 1 }],
    ["infinite start", { startOffsetSeconds: Number.POSITIVE_INFINITY, loopEndSeconds: 1 }],
    ["negative start", { startOffsetSeconds: -0.001, loopEndSeconds: 1 }],
    ["NaN end", { startOffsetSeconds: 0, loopEndSeconds: Number.NaN }],
    ["infinite end", { startOffsetSeconds: 0, loopEndSeconds: Number.POSITIVE_INFINITY }],
    ["negative end", { startOffsetSeconds: 0, loopEndSeconds: -0.001 }],
    ["end beyond decoded duration", { startOffsetSeconds: 0, loopEndSeconds: 1.001 }],
    ["end before cue", { startOffsetSeconds: 0.5, loopEndSeconds: 0.25 }],
  ] as const)("rejects %s", (_label, region) => {
    expect(() => resolveBeatPlaybackFrameRange(bufferFrames(), region)).toThrow();
  });

  it("rejects a non-empty time span that rounds to an empty frame range", () => {
    expect(() => resolveBeatPlaybackFrameRange(bufferFrames(), {
      startOffsetSeconds: 0.25,
      loopEndSeconds: 0.25 + 0.1 / 48_000,
    })).toThrow(/at least one decoded audio frame/);
  });

  it("rejects a cue that rounds to the decoded buffer end", () => {
    expect(() => resolveBeatPlaybackFrameRange(bufferFrames(48_000), {
      startOffsetSeconds: 0.999999,
      loopEndSeconds: null,
    })).toThrow(/at least one decoded audio frame/);
  });
});
