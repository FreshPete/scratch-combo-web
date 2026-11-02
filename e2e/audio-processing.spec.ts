import { expect, test } from "@playwright/test";

test("browser worklet preserves independent controls and aligns common-rate presentation to rendered PCM", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const [probe, transport] = await Promise.all([
      import("/src/audio/tempoPitchBrowserProbe.ts"),
      import("/src/audio/AudioTransport.ts"),
    ]);
    return {
      ...(await probe.runTempoPitchBrowserProbe()),
      presentationLagEstimateSeconds: transport.SOUNDTOUCH_ESTIMATED_PRESENTATION_DELAY_SECONDS,
    };
  });

  expect(result.before.sampleHz).toBeCloseTo(440, -1);
  expect(result.before.beatHz).toBeCloseTo(220, -1);
  expect(result.tempoOnly.sampleHz).toBeCloseTo(440, -1);
  expect(result.tempoOnly.beatHz).toBeCloseTo(220, -1);
  expect(result.pitchShifted.sampleHz).toBeCloseTo(440 * Math.pow(2, 3 / 12), -1);
  expect(result.pitchShifted.beatHz).toBeCloseTo(220 * Math.pow(2, 3 / 12), -1);

  expect(result.before.sampleGain).toBeCloseTo(0.125, 1);
  expect(result.before.beatGain).toBeCloseTo(0.25, 1);
  expect(result.tempoOnly.sampleGain).toBeCloseTo(0.1, 1);
  expect(result.tempoOnly.beatGain).toBeCloseTo(0.35, 1);
  expect(result.pitchShifted.sampleGain).toBeCloseTo(0.1, 1);
  expect(result.pitchShifted.beatGain).toBeCloseTo(0.35, 1);

  expect(result.durationSeconds).toBeCloseTo(1.7 / (100 / 85), 1);
  expect(result.finiteInputTailEndSeconds).toBeCloseTo(0.2 / (100 / 85), 2);
  expect(result.sourceContinuityRms.every((value) => value > 0.05)).toBe(true);

  const commonRateOffsets = result.transientAlignment
    .filter(({ tempoRatio }) => [0.75, 1, 100 / 85].some((commonRate) => Math.abs(tempoRatio - commonRate) < 0.0001))
    .flatMap(({ repeatedMeasuredDelaysSeconds }) => repeatedMeasuredDelaysSeconds);
  expect(commonRateOffsets).toHaveLength(24);
  expect(commonRateOffsets.every((delay) => delay !== null
    && Math.abs(delay - result.presentationLagEstimateSeconds) <= 0.03)).toBe(true);
  // A tone alone can hide a missing tail. The finite probe also changes to a distinct end marker.
  expect(result.finitePresentationWindows.every((window) => window.renderedEndMarkerSeconds !== null)).toBe(true);
  expect(result.finitePresentationWindows.every((window) => window.endMarkerTimingErrorSeconds !== null
    && window.endMarkerTimingErrorSeconds >= 0.08
    && window.endMarkerTimingErrorSeconds <= 0.15)).toBe(true);
  const noPadding = result.finitePaddingComparison.find((window) => window.paddingMode === "none");
  const zeroPadding = result.finitePaddingComparison.find((window) => window.paddingMode === "zero");
  const beatPadding = result.finitePaddingComparison.find((window) => window.paddingMode === "beat");
  expect(noPadding?.renderedTailAfterSourceEndSeconds).toBeLessThan(0.01);
  expect(zeroPadding?.renderedTailAfterSourceEndSeconds).toBeGreaterThan(0.11);
  expect(beatPadding?.renderedTailAfterSourceEndSeconds).toBeGreaterThan(0.35);
  expect(result.finiteZeroPaddingWindows.every((window) => window.renderedTailAfterSourceEndSeconds >= 0.11
    && window.renderedTailAfterSourceEndSeconds <= 0.14)).toBe(true);
  expect(result.finitePitchDrainWindows.every((window) => window.renderedTailAfterSourceEndSeconds >= 0.11
    && window.renderedTailAfterSourceEndSeconds <= 0.14)).toBe(true);
});
