import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { stageLocalImport } from "./helpers/import-wizard";

declare global {
  interface Window {
    __liveAudioQa?: {
      sources: AudioBufferSourceNode[];
      stops: Array<{ loop: boolean; when: number }>;
    };
    __qaSavePickerState?: {
      mode: "cancel" | "save";
      suggestedNames: string[];
      contents: string[];
    };
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
    "CONFIGNAME=Browser Editor Fixture",
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
    "SampleDisplayName=Editor sample",
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

async function loadCustomFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await stageLocalImport(page, {
    name: "editor.ini",
    buffer: Buffer.from(customIni()),
    mimeType: "text/plain",
  }, [
    { name: "Wanted.wav", buffer: makeWav(440), mimeType: "audio/wav" },
    { name: "beat.wav", buffer: makeWav(100), mimeType: "audio/wav" },
    { name: "beat-two.wav", buffer: makeWav(120), mimeType: "audio/wav" },
  ]);
  await expect(page.getByRole("button", { name: "Load preset" })).toBeEnabled();
  await page.getByRole("button", { name: "Load preset" }).click();
}

test("session controls stay inside the workspace at narrow, tablet, and desktop widths", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByLabel("Current session files")).toContainText("85 BPM - Beginner", { timeout: 30_000 });
  await expect(page.locator(".import-current__count")).toContainText("66 WAV files in session");
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");

  for (const width of [390, 844, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator("#session-section").evaluate((section) => {
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const sectionRect = bounds(section);
      const grid = section.querySelector<HTMLElement>(".session-controls__grid")!;
      const gridRect = bounds(grid);
      const fields = Array.from(grid.querySelectorAll<HTMLElement>(".session-controls__field"));
      return {
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        sectionRect,
        gridRect,
        gridClientWidth: grid.clientWidth,
        gridScrollWidth: grid.scrollWidth,
        fields: fields.map((field) => ({
          rect: bounds(field),
          controls: Array.from(field.querySelectorAll<HTMLElement>("input, select"), bounds),
        })),
        resetRect: bounds(section.querySelector(".session-controls__reset")!),
      };
    });
    expect(geometry.pageWidth, `document must not overflow at ${width}px`).toBeLessThanOrEqual(width + 1);
    expect(geometry.fields).toHaveLength(4);
    expect(geometry.gridScrollWidth).toBeLessThanOrEqual(geometry.gridClientWidth + 1);
    expect(geometry.gridRect.left).toBeGreaterThanOrEqual(geometry.sectionRect.left - 1);
    expect(geometry.gridRect.right).toBeLessThanOrEqual(geometry.sectionRect.right + 1);
    expect(geometry.resetRect.left).toBeGreaterThanOrEqual(geometry.sectionRect.left - 1);
    expect(geometry.resetRect.right).toBeLessThanOrEqual(geometry.sectionRect.right + 1);
    for (const field of geometry.fields) {
      expect(field.rect.width, `control field should have width at ${width}px`).toBeGreaterThan(100);
      expect(field.rect.left).toBeGreaterThanOrEqual(geometry.gridRect.left - 1);
      expect(field.rect.right).toBeLessThanOrEqual(geometry.gridRect.right + 1);
      for (const control of field.controls) {
        expect(control.width).toBeGreaterThan(0);
        expect(control.left).toBeGreaterThanOrEqual(field.rect.left - 1);
        expect(control.right).toBeLessThanOrEqual(field.rect.right + 1);
      }
    }
  }

  const proofDirectory = path.resolve(process.cwd(), "test-results");
  mkdirSync(proofDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator("#session-section").evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await expect(page.getByRole("slider", { name: "Pitch shift in semitones" })).toHaveValue("0");
  await expect(page.getByRole("slider", { name: "Sample level" })).toHaveValue("80");
  await expect(page.getByRole("slider", { name: "Beat level" })).toHaveValue("100");
  await expect(page.getByLabel("Beat bed")).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Reset controls" })).toBeVisible();
  await page.screenshot({
    path: path.join(proofDirectory, "integrated-session-controls-desktop.png"),
    fullPage: false,
  });
});

test("live BPM, pitch, and levels stay independent; reset preserves the playing phase and beat bed", async ({ page }) => {
  await page.addInitScript(() => {
    const qa = { sources: [] as AudioBufferSourceNode[], stops: [] as Array<{ loop: boolean; when: number }> };
    window.__liveAudioQa = qa;
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      qa.sources.push(this);
      return originalStart.call(this, when, offset, duration);
    };
    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      qa.stops.push({ loop: this.loop, when: when ?? this.context.currentTime });
      return originalStop.call(this, when);
    };
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  const practiceTab = page.getByRole("tab", { name: "Practice", exact: true });
  const sessionTab = page.getByRole("tab", { name: "Session", exact: true });
  await sessionTab.click();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await practiceTab.click();
  await expect(page.getByRole("radio", { name: "Q&A" })).toBeChecked();
  await page.getByLabel("Combo length").selectOption("16");
  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: /Sequence timeline: 256 legacy ticks/ })).toBeVisible();
  await page.getByLabel("Large pause").check();
  await sessionTab.click();
  await page.getByLabel("Beat bed").selectOption("1");
  await page.getByRole("button", { name: "Play sequence" }).click();
  const status = page.locator(".transport-status");
  await expect(status).toHaveText("Q&A · question playback · cycle 1.");
  const readQaCycle = () => page.evaluate(() => {
    const match = /^Q&A · (?:question playback|answer pause) · cycle (\d+)\.$/.exec(
      document.querySelector(".transport-status")?.textContent?.trim() ?? "",
    );
    return match ? Number(match[1]) : null;
  });
  const initialCycle = (await readQaCycle())!;
  await expect.poll(() => page.evaluate(() => window.__liveAudioQa?.sources.filter((source) => source.loop).length ?? 0))
    .toBe(1);

  const progress = page.getByRole("progressbar", { name: "Preview progress" });
  const initialProgress = Number(await progress.getAttribute("value"));
  const sourceStopCount = await page.evaluate(() => window.__liveAudioQa?.stops.filter((stop) => stop.loop).length ?? 0);
  const tempoRange = page.getByRole("slider", { name: "BPM range" });
  await tempoRange.focus();
  for (let step = 0; step < 30; step += 1) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("100");
  await expect(tempoRange).toHaveValue("100");
  await expect.poll(() => page.evaluate(() => {
    const beat = window.__liveAudioQa?.sources.find((source) => source.loop);
    return beat?.playbackRate.value ?? 0;
  })).toBeCloseTo(100 / 85, 2);

  const pitch = page.getByRole("slider", { name: "Pitch shift in semitones" });
  await pitch.focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowRight");
  const sampleLevel = page.getByRole("slider", { name: "Sample level" });
  await sampleLevel.focus();
  await page.keyboard.press("End");
  const beatLevel = page.getByRole("slider", { name: "Beat level" });
  await beatLevel.focus();
  await page.keyboard.press("Home");

  await expect(pitch).toHaveValue("3");
  await expect(sampleLevel).toHaveValue("100");
  await expect(beatLevel).toHaveValue("0");
  await expect.poll(readQaCycle).not.toBeNull();
  const cycleAfterLiveChanges = (await readQaCycle())!;
  expect(cycleAfterLiveChanges).toBeGreaterThanOrEqual(initialCycle);
  await expect.poll(async () => Number(await progress.getAttribute("value")))
    .toBeGreaterThan(initialProgress);
  expect(await page.evaluate(() => window.__liveAudioQa?.sources.filter((source) => source.loop).length ?? 0)).toBe(1);
  expect(await page.evaluate(() => window.__liveAudioQa?.stops.filter((stop) => stop.loop).length ?? 0)).toBe(sourceStopCount);

  await page.getByRole("button", { name: "Reset controls" }).click();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await expect(tempoRange).toHaveValue("85");
  await expect(pitch).toHaveValue("0");
  await expect(sampleLevel).toHaveValue("80");
  await expect(beatLevel).toHaveValue("100");
  await expect.poll(readQaCycle).not.toBeNull();
  const cycleAfterReset = (await readQaCycle())!;
  expect(cycleAfterReset).toBeGreaterThanOrEqual(cycleAfterLiveChanges);
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled();
  await expect(page.getByLabel("Beat bed")).toHaveValue("1");
  await practiceTab.click();
  await expect(page.getByRole("radio", { name: "Q&A" })).toBeChecked();
  await expect(page.getByLabel("Large pause")).toBeChecked();
  await expect(page.getByLabel("Combo length")).toHaveValue("16");
  await expect.poll(() => page.evaluate(() => {
    const beat = window.__liveAudioQa?.sources.find((source) => source.loop);
    return beat?.playbackRate.value ?? 0;
  })).toBeCloseTo(1, 2);
  expect(await page.evaluate(() => window.__liveAudioQa?.sources.filter((source) => source.loop).length ?? 0)).toBe(1);
  expect(await page.evaluate(() => window.__liveAudioQa?.stops.filter((stop) => stop.loop).length ?? 0)).toBe(sourceStopCount);
  await page.getByRole("button", { name: "Stop" }).click();
});

test("sample edits save a preserved working INI and leave BPM01 as recorded tempo", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { mode: "cancel" as "cancel" | "save", suggestedNames: [] as string[], contents: [] as string[] };
    window.__qaSavePickerState = state;
    const pickerWindow = window as unknown as {
      showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{
        name: string;
        createWritable: () => Promise<{ write: (value: string | Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    };
    pickerWindow.showSaveFilePicker = async (options) => {
      state.suggestedNames.push(options.suggestedName);
      if (state.mode === "cancel") throw new DOMException("User cancelled the save dialog.", "AbortError");
      let content = "";
      return {
        name: options.suggestedName,
        createWritable: async () => ({
          write: async (value) => { content = typeof value === "string" ? value : await value.text(); },
          close: async () => { state.contents.push(content); },
        }),
      };
    };
  });
  await loadCustomFixture(page);

  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("spinbutton", { name: "BPM" }).fill("100");
  await page.getByRole("slider", { name: "Sample level" }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("slider", { name: "Beat level" }).focus();
  await page.keyboard.press("ArrowLeft");

  await page.getByRole("tab", { name: "Samples", exact: true }).click();
  await page.getByRole("button", { name: "Edit Editor sample" }).click();
  const editor = page.getByRole("form", { name: "Edit Editor sample" });
  await expect(editor).toBeVisible();
  await page.getByLabel("Duration ticks").fill("12");
  const proofDirectory = path.resolve(process.cwd(), "test-results");
  mkdirSync(proofDirectory, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(proofDirectory, "sample-editor-desktop-final.png"), fullPage: true });
  await page.setViewportSize({ width: 844, height: 900 });
  await page.screenshot({ path: path.join(proofDirectory, "sample-editor-844-final.png"), fullPage: true });
  await page.getByRole("button", { name: "Save sample changes" }).click();
  const sampleRow = page.locator(".sample-table tbody tr").filter({ hasText: "Editor sample" });
  await expect(sampleRow).toContainText("12 legacy ticks");

  const save = page.getByRole("button", { name: "Save Sample Data" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => page.evaluate(() => window.__qaSavePickerState!.suggestedNames.length)).toBe(1);
  await expect(save).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(sampleRow).toContainText("12 legacy ticks");

  await page.evaluate(() => { window.__qaSavePickerState!.mode = "save"; });
  await save.click();
  await expect(page.locator('.visually-hidden[aria-live="polite"]')).toContainText("Working preset copy saved as editor-edited.ini");
  const savedIni = (await page.evaluate(() => window.__qaSavePickerState!.contents[0]))!;
  expect(await page.evaluate(() => window.__qaSavePickerState!.suggestedNames)).toEqual(["editor-edited.ini", "editor-edited.ini"]);
  expect(savedIni).toContain("; retained browser-QA source comment");
  expect(savedIni).toContain("BPM01=85");
  expect(savedIni).toContain("Beat01=beat.wav");
  expect(savedIni).toContain("Beat02=beat-two.wav");
  expect(savedIni).toContain("VendorNote=preserve this key");
  expect(savedIni).toContain("[VendorMetadata]\r\nOrigin=browser-test");
  expect(savedIni).toContain("[Sample01]");
  expect(savedIni).toContain("Sample16ths=12");
  expect(savedIni).toMatch(/VOL_B=34\r\nVOL_S=74/);

  await stageLocalImport(page, {
    name: "editor-edited.ini",
    buffer: Buffer.from(savedIni),
    mimeType: "text/plain",
  }, [
    { name: "Wanted.wav", buffer: makeWav(440), mimeType: "audio/wav" },
    { name: "beat.wav", buffer: makeWav(100), mimeType: "audio/wav" },
    { name: "beat-two.wav", buffer: makeWav(120), mimeType: "audio/wav" },
  ]);
  await expect(page.getByRole("button", { name: "Load preset" })).toBeEnabled();
  await page.getByRole("button", { name: "Load preset" }).click();
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await expect(page.getByLabel("Beat bed")).toHaveValue("0");
  await page.getByRole("tab", { name: "Samples", exact: true }).click();
  await expect(page.locator(".sample-table tbody tr").filter({ hasText: "Editor sample" })).toContainText("12 legacy ticks");
});
