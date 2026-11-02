import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __presetQaResumeCount?: number;
  }
}

function makeWav(frequency = 440, durationSeconds = 0.12): Buffer {
  const sampleRate = 8_000;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.3;
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2);
  }
  return wav;
}

function customIni(): string {
  return [
    "; retained browser-QA source comment",
    "[Samples]",
    "CONFIGNAME=Browser Override",
    "VOL_B=35",
    "VOL_S=75",
    "RootSamplePathRelative=True",
    "RootSamplePath=assets",
    "Beat01=beat.wav",
    "Beat02=beat-two.wav",
    "BPM01=85",
    "VendorNote=preserve this key",
    "",
    "[Sample01]",
    "SamplePlayFq=1",
    "SampleIsSilent=False",
    "SampleRepeatsPoss=True",
    "SampleRepeatMax=100",
    "SampleFileName=Wanted.wav",
    "SampleDisplayName=Override sample",
    "SampleStartsForward=True",
    "SampleEndsForward=False",
    "Sample16ths=8",
    "UseSample=True",
    "",
    "[VendorMetadata]",
    "Origin=browser-test",
    "",
  ].join("\r\n");
}

const presetChoices = [
  ["SSC-085BPM-01", "85 BPM - Beginner"],
  ["SSC-085BPM-02", "85 BPM - Average"],
  ["SSC-085BPM-03", "85 BPM - Good"],
  ["SSC-085BPM-04", "85 BPM - Very Good"],
  ["SSC-085BPM-05", "85 BPM - Expert"],
  ["SSC-096BPM2-01", "96 BPM Set 2"],
] as const;

function expectLocalReadOnlyRequests(pageUrl: string, requests: Array<{ url: string; method: string }>): void {
  const externalOrMutating = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== new URL(pageUrl).origin || !["GET", "HEAD"].includes(request.method);
  });
  expect(externalOrMutating).toEqual([]);
}

test("loads the 85 BPM Beginner preset without autoplay and resolves all six built-in choices", async ({ page }) => {
  test.setTimeout(120_000);
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await page.addInitScript(() => {
    window.__presetQaResumeCount = 0;
    const originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      window.__presetQaResumeCount = (window.__presetQaResumeCount ?? 0) + 1;
      return originalResume.call(this);
    };
  });
  await page.goto("/");
  const preset = page.getByLabel("Quick preset");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await expect(preset).toHaveValue("SSC-085BPM-01");
  await expect(page.locator(".import-status__copy p")).toContainText(
    "85 BPM - Beginner ready. All 64 sample references and 2 beat files are loaded",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await expect(page.getByLabel("Beat bed")).toHaveValue("0");
  await expect(page.getByRole("radio", { name: "Q&A" })).toBeChecked();
  await expect(page.getByLabel("Large pause")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
  expect(await page.evaluate(() => window.__presetQaResumeCount)).toBe(0);

  const beatBed = page.getByLabel("Beat bed");
  for (const beatName of ["Beat 01 · _BEAT01_85BPM.wav", "Beat 02 · _BEAT02_85BPM.wav"]) {
    await expect(page.getByRole("option", { name: beatName })).toBeEnabled();
  }
  await beatBed.selectOption("1");
  await expect(beatBed).toHaveValue("1");
  await beatBed.selectOption("0");

  for (const [id, label] of presetChoices) {
    await preset.selectOption(id);
    await expect(page.locator(".import-status__copy p")).toContainText(
      `${label} ready. All `,
      { timeout: 30_000 },
    );
    await expect(page.locator(".import-status__copy p")).toContainText("sample references and 2 beat files are loaded");
    await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
    await expect(page.getByRole("option", { name: /Beat 01 ·/ })).toBeEnabled();
    await expect(page.getByRole("option", { name: /Beat 02 ·/ })).toBeEnabled();
  }
  await expect(preset).toHaveValue("SSC-096BPM2-01");
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("96");
  await expect(page.getByLabel("Beat bed")).toHaveValue("0");
  expectLocalReadOnlyRequests(page.url(), requests);
});

test("a custom INI and WAV selection wins over a delayed startup preset response", async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  let releaseResponse: () => void = () => {};
  let defaultRequestStarted = false;
  let defaultRouteFinished = false;
  const delayedResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/private-presets/SSC-085BPM-01.ini", async (route) => {
    defaultRequestStarted = true;
    await delayedResponse;
    try {
      await route.continue();
    } catch {
      // The custom preset selection aborts this stale built-in request.
    }
    defaultRouteFinished = true;
  });

  await page.goto("/");
  await expect.poll(() => defaultRequestStarted).toBe(true);
  await page.getByLabel("Choose WAV files").setInputFiles([
    { name: "Wanted.wav", buffer: makeWav(440), mimeType: "audio/wav" },
    { name: "beat.wav", buffer: makeWav(100), mimeType: "audio/wav" },
    { name: "beat-two.wav", buffer: makeWav(120), mimeType: "audio/wav" },
  ]);
  await page.getByLabel("Choose INI preset").setInputFiles({
    name: "override.ini",
    buffer: Buffer.from(customIni()),
    mimeType: "text/plain",
  });

  await expect(page.locator(".import-status__copy strong")).toHaveText("override.ini");
  await expect(page.locator(".import-status__copy p")).toContainText("1 samples and 2 beat files resolved");
  await expect(page.getByRole("button", { name: "Generate combo" })).toBeEnabled();
  await expect(page.getByLabel("Quick preset")).toHaveValue("custom");
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");

  releaseResponse();
  await expect.poll(() => defaultRouteFinished).toBe(true);
  await expect(page.locator(".import-status__copy strong")).toHaveText("override.ini");
  await expect(page.locator(".sequence-heading")).toContainText("Browser Override");
  await expect(page.getByRole("button", { name: "Generate combo" })).toBeEnabled();
  expectLocalReadOnlyRequests(page.url(), requests);
});

test("a failed built-in asset load stays disabled until Retry succeeds", async ({ page }) => {
  let presetFetches = 0;
  await page.route("**/private-presets/SSC-085BPM-01.ini", async (route) => {
    presetFetches += 1;
    if (presetFetches === 1) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary local failure" });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry built-in preset" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Build preview" })).toBeDisabled();

  await page.getByRole("button", { name: "Retry built-in preset" }).click();
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
  await expect(page.getByLabel("Quick preset")).toHaveValue("SSC-085BPM-01");
  expect(presetFetches).toBe(2);
});
