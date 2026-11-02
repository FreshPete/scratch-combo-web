import { expect, test } from "@playwright/test";

test("browser worklet preserves tempo pitch independence, separate gains, and finite sample tails", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const probe = await import("/src/audio/tempoPitchBrowserProbe.ts");
    return probe.runTempoPitchBrowserProbe();
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
});
