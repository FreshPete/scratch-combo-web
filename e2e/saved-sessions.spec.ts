import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { stageLocalImport } from "./helpers/import-wizard";

declare global {
  interface Window {
    __savedSessionsQa?: {
      resumeCount: number;
      sourceStarts: Array<{ duration: number; loop: boolean }>;
      decodedWavByteLengths: number[];
    };
    __uploadedBeatQa?: {
      resumeCount: number;
      sourceStarts: Array<{ node: AudioBufferSourceNode; loop: boolean; duration: number | undefined }>;
      sourceStops: AudioBufferSourceNode[];
      decodedWavByteLengths: number[];
      connections: Array<{ source: AudioNode; destination: AudioNode }>;
      worklets: Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>;
    };
  }
}

test.describe.configure({ timeout: 120_000 });

function makeWav(frequency: number, durationSeconds: number): Buffer {
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

const sampleWav = makeWav(440, 0.37);
const beatWav = makeWav(100, 0.23);
const secondBeatWav = makeWav(120, 0.29);
const uploadedBeatBpm = 128;

function makeClickTrackWav(bpm: number, beatCount: number, toneHz: number): Buffer {
  const sampleRate = 44_100;
  const sampleCount = Math.round(sampleRate * beatCount * 60 / bpm);
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
    const time = index / sampleRate;
    const beatPhase = time * bpm / 60;
    const beatOffset = (beatPhase - Math.floor(beatPhase)) * 60 / bpm;
    const envelope = beatOffset < 0.075 ? Math.exp(-beatOffset * 42) : 0;
    const sample = envelope * (
      0.04 * Math.sin(2 * Math.PI * 80 * beatOffset)
      + 0.30 * Math.sin(2 * Math.PI * toneHz * beatOffset)
      + 0.05 * Math.sin(2 * Math.PI * 1_000 * beatOffset)
      + 0.04 * Math.sin(2 * Math.PI * 1_900 * beatOffset)
    );
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2);
  }
  return wav;
}

const uploadedBeatWav = makeClickTrackWav(uploadedBeatBpm, 24, 220);

function customIni(): string {
  return [
    "; saved-session browser QA fixture",
    "[Samples]",
    "CONFIGNAME=Browser Saved Session Fixture",
    "VOL_B=45",
    "VOL_S=75",
    "RootSamplePathRelative=True",
    "RootSamplePath=assets",
    "Beat01=beat.wav",
    "Beat02=beat-two.wav",
    "BPM01=84",
    "VendorNote=retained by the source session",
    "",
    "[Sample01]",
    "SamplePlayFq=1",
    "SampleIsSilent=False",
    "SampleRepeatsPoss=True",
    "SampleRepeatMax=100",
    "SampleFileName=Wanted.wav",
    "SampleDisplayName=QA sample",
    "SampleStartsForward=True",
    "SampleEndsForward=False",
    "Sample16ths=8",
    "UseSample=True",
    "",
    "[VendorMetadata]",
    "Origin=saved-session-browser-test",
    "",
  ].join("\r\n");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function installAudioInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      resumeCount: 0,
      sourceStarts: [] as Array<{ duration: number; loop: boolean }>,
      decodedWavByteLengths: [] as number[],
    };
    window.__savedSessionsQa = qa;

    const originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      qa.resumeCount += 1;
      return originalResume.call(this);
    };

    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      qa.sourceStarts.push({ duration: this.buffer?.duration ?? 0, loop: this.loop });
      return originalStart.call(this, when, offset, duration);
    };

    const originalDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (
      audioData: ArrayBuffer,
      successCallback?: (decodedData: AudioBuffer) => void,
      errorCallback?: (error: DOMException) => void,
    ) {
      const bytes = new Uint8Array(audioData);
      if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF") {
        qa.decodedWavByteLengths.push(bytes.byteLength);
      }
      if (successCallback || errorCallback) {
        return originalDecode.call(this, audioData, successCallback, errorCallback);
      }
      return originalDecode.call(this, audioData);
    };
  });
}

async function installUploadedBeatInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      resumeCount: 0,
      sourceStarts: [] as Array<{ node: AudioBufferSourceNode; loop: boolean; duration: number | undefined }>,
      sourceStops: [] as AudioBufferSourceNode[],
      decodedWavByteLengths: [] as number[],
      connections: [] as Array<{ source: AudioNode; destination: AudioNode }>,
      worklets: [] as Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>,
    };
    window.__uploadedBeatQa = qa;

    const originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      qa.resumeCount += 1;
      return originalResume.call(this);
    };

    const originalDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (
      audioData: ArrayBuffer,
      successCallback?: (decodedData: AudioBuffer) => void,
      errorCallback?: (error: DOMException) => void,
    ) {
      const bytes = new Uint8Array(audioData);
      if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF") {
        qa.decodedWavByteLengths.push(bytes.byteLength);
      }
      if (successCallback || errorCallback) return originalDecode.call(this, audioData, successCallback, errorCallback);
      return originalDecode.call(this, audioData);
    };

    const originalConnect = AudioNode.prototype.connect as unknown as (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ) => AudioNode;
    AudioNode.prototype.connect = function (destination: AudioNode, output?: number, input?: number) {
      qa.connections.push({ source: this, destination });
      const result = originalConnect.call(this, destination, output, input);
      if (this instanceof AudioWorkletNode && destination === this.context.destination
        && !qa.worklets.some(({ node }) => node === this)) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 8_192;
        const mutedMonitor = this.context.createGain();
        mutedMonitor.gain.value = 0;
        originalConnect.call(this, analyser);
        originalConnect.call(analyser, mutedMonitor);
        originalConnect.call(mutedMonitor, this.context.destination);
        qa.worklets.push({ node: this, analyser });
      }
      return result;
    } as typeof AudioNode.prototype.connect;

    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      qa.sourceStarts.push({ node: this, loop: this.loop, duration: this.buffer?.duration });
      return originalStart.call(this, when, offset, duration);
    };

    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (this.loop) qa.sourceStops.push(this);
      return originalStop.call(this, when);
    };
  });
}

async function loadCustomFixture(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await stageLocalImport(page, {
    name: "saved-session.ini",
    buffer: Buffer.from(customIni()),
    mimeType: "text/plain",
  }, [
    { name: "Wanted.wav", buffer: sampleWav, mimeType: "audio/wav" },
    { name: "beat.wav", buffer: beatWav, mimeType: "audio/wav" },
    { name: "beat-two.wav", buffer: secondBeatWav, mimeType: "audio/wav" },
  ]);
  await expect(page.getByRole("button", { name: "Load preset" })).toBeEnabled();
  await page.getByRole("button", { name: "Load preset" }).click();
  await expect(page.locator(".sequence-heading")).toContainText("Browser Saved Session Fixture");
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate combo" })).toBeEnabled();
}

async function setSliderWithKeyboard(page: Page, label: string, valueFromMin: number): Promise<void> {
  const slider = page.getByRole("slider", { name: label });
  await slider.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < valueFromMin; step += 1) await page.keyboard.press("ArrowRight");
}

async function setSavedControls(page: Page): Promise<void> {
  await page.getByLabel("Combo length").selectOption("16");
  const largePause = page.getByLabel("Large pause");
  if (await largePause.isChecked()) await largePause.uncheck();
  const loopMode = page.getByRole("radio", { name: "Loop" });
  if (!(await loopMode.isChecked())) await loopMode.check();

  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("spinbutton", { name: "BPM" }).fill("99");
  const pitch = page.getByRole("slider", { name: "Pitch shift in semitones" });
  await pitch.focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowRight");
  await setSliderWithKeyboard(page, "Sample level", 93);
  await setSliderWithKeyboard(page, "Beat level", 90);
  await page.getByLabel("Beat bed").selectOption("1");
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: /Sequence timeline/ })).toBeVisible();
  await expect.poll(() => page.locator(".timeline-scroll .sequence-event").count()).toBeGreaterThan(0);
}

async function captureCombo(page: Page): Promise<string[]> {
  const events = page.getByRole("list", { name: "Sequence events" });
  await expect(events).toBeVisible();
  await expect.poll(() => events.getByRole("listitem").count()).toBeGreaterThan(0);
  return events.getByRole("listitem").allTextContents();
}

async function selectOptionContaining(select: Locator, label: string): Promise<void> {
  const matchingOption = select.locator("option").filter({ hasText: label }).first();
  await expect(matchingOption).toHaveCount(1);
  const value = await matchingOption.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(value!);
}

async function openSaveManager(page: Page): Promise<void> {
  const disclosure = page.locator("details").filter({ hasText: "Save and manage sessions" }).first();
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await page.getByText("Save and manage sessions", { exact: true }).click();
  }
  await expect(page.getByRole("textbox", { name: "Session name" })).toBeVisible();
}

async function closeSaveManager(page: Page): Promise<void> {
  const disclosure = page.locator("details").filter({ hasText: "Save and manage sessions" }).first();
  if (await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await page.getByText("Save and manage sessions", { exact: true }).click();
  }
  await expect(page.getByRole("textbox", { name: "Session name" })).toBeHidden();
}

async function clickAndAcceptDialog(page: Page, buttonName: string, expectedMessage: string): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    await dialog.accept();
    return message;
  });
  await page.getByRole("button", { name: buttonName }).click();
  expect(await dialogMessage).toContain(expectedMessage);
}

async function persistedBlobDigests(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scratch-combo-sessions-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open saved session database"));
    });
    const payloads = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction("payloads", "readonly");
      const request = transaction.objectStore("payloads").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read saved session payloads"));
    });
    database.close();

    const hashes: string[] = [];
    const visited = new WeakSet<object>();
    const visit = async (value: unknown): Promise<void> => {
      if (value instanceof Blob) {
        const digest = await crypto.subtle.digest("SHA-256", await value.arrayBuffer());
        hashes.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
        return;
      }
      if (value === null || typeof value !== "object" || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) await visit(item);
      } else {
        for (const item of Object.values(value)) await visit(item);
      }
    };
    for (const payload of payloads) await visit(payload);
    return hashes;
  });
}

async function activeUploadedBeatLoops(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__uploadedBeatQa;
    if (!qa) return 0;
    return qa.sourceStarts.filter(({ node, loop }) => loop && !qa.sourceStops.includes(node)).length;
  });
}

async function uploadedBeatOutputRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__uploadedBeatQa;
    if (!qa) return 0;
    const beatSource = [...qa.sourceStarts].reverse().find(({ node, loop }) => (
      loop && !qa.sourceStops.includes(node)
    ));
    if (!beatSource) return 0;
    const beatGain = qa.connections.find(({ source }) => source === beatSource.node)?.destination;
    const processor = qa.connections.find(({ source, destination }) => (
      source === beatGain && destination instanceof AudioWorkletNode
    ))?.destination as AudioWorkletNode | undefined;
    const analyser = qa.worklets.find(({ node }) => node === processor)?.analyser;
    if (!analyser) return 0;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let squareSum = 0;
    for (const sample of samples) squareSum += sample * sample;
    return Math.sqrt(squareSum / samples.length);
  });
}

async function expectSavedControls(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Loop" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Q&A" })).not.toBeChecked();
  await expect(page.getByLabel("Combo length")).toHaveValue("16");

  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("99");
  await expect(page.getByRole("slider", { name: "Pitch shift in semitones" })).toHaveValue("3");
  await expect(page.getByRole("slider", { name: "Sample level" })).toHaveValue("93");
  await expect(page.getByRole("slider", { name: "Beat level" })).toHaveValue("90");
  await expect(page.getByLabel("Beat bed")).toHaveValue("1");
}

async function expectCustomSourceRestored(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByLabel("Current session files")).toContainText("Browser Saved Session Fixture");
  await expect(page.locator(".import-current__count")).toContainText("3 WAV files in session");
  await expect(page.getByLabel("Quick preset")).toHaveValue("custom");
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
}

async function expectStopped(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(await page.evaluate(() => window.__savedSessionsQa?.resumeCount ?? 0)).toBe(0);
  expect(await page.evaluate(() => window.__savedSessionsQa?.sourceStarts.length ?? 0)).toBe(0);
}

async function expectWithinViewport(page: Page, width: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const ids = [
      "saved-sessions-select",
      "load-session",
      "reload-last-session",
    ];
    const controls = ids.map((id) => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!element) return { id, missing: true, left: 0, right: viewportWidth };
      const rect = element.getBoundingClientRect();
      return { id, missing: false, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    const tabs = Array.from(document.querySelectorAll<HTMLElement>("[role=tab]"))
      .filter((tab) => tab.getClientRects().length > 0)
      .map((tab) => {
        const rect = tab.getBoundingClientRect();
        return { name: tab.textContent?.trim(), left: rect.left, right: rect.right };
      });
    const summary = Array.from(document.querySelectorAll<HTMLElement>("summary"))
      .find((element) => element.textContent?.trim() === "Save and manage sessions");
    const summaryRect = summary?.getBoundingClientRect();
    const timelineRect = document.querySelector(".timeline-figure")?.getBoundingClientRect();
    return {
      viewportWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      controls,
      tabs,
      summary: summaryRect ? { left: summaryRect.left, right: summaryRect.right } : null,
      timeline: timelineRect ? { left: timelineRect.left, right: timelineRect.right, top: timelineRect.top, bottom: timelineRect.bottom } : null,
    };
  });
  expect(layout.documentWidth, `page should not scroll horizontally at ${width}px`).toBeLessThanOrEqual(width + 1);
  expect(layout.tabs.length).toBeGreaterThan(0);
  for (const control of layout.controls) {
    expect(control.missing, `${control.id} should exist`).toBe(false);
    expect(control.width ?? 0, `${control.id} should remain usable at ${width}px`).toBeGreaterThan(0);
    expect(control.left, `${control.id} should not clip at ${width}px`).toBeGreaterThanOrEqual(-1);
    expect(control.right, `${control.id} should not clip at ${width}px`).toBeLessThanOrEqual(width + 1);
  }
  for (const tab of layout.tabs) {
    expect(tab.left, `tab ${tab.name} should not clip at ${width}px`).toBeGreaterThanOrEqual(-1);
    expect(tab.right, `tab ${tab.name} should not clip at ${width}px`).toBeLessThanOrEqual(width + 1);
  }
  expect(layout.summary).not.toBeNull();
  expect(layout.summary!.left).toBeGreaterThanOrEqual(-1);
  expect(layout.summary!.right).toBeLessThanOrEqual(width + 1);
  expect(layout.timeline).not.toBeNull();
  expect(layout.timeline!.left).toBeGreaterThanOrEqual(-1);
  expect(layout.timeline!.right).toBeLessThanOrEqual(width + 1);
  expect(layout.timeline!.bottom).toBeGreaterThan(0);
  if (width >= 844) expect(layout.timeline!.top).toBeLessThan(layout.viewportHeight);
}

async function corruptSavedSessionSnapshot(page: Page, name: string): Promise<void> {
  await page.evaluate((targetName) => new Promise<void>((resolve, reject) => {
    const openRequest = indexedDB.open("scratch-combo-sessions-v1");
    openRequest.onerror = () => reject(openRequest.error ?? new Error("Could not open saved session database"));
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains("records") || !database.objectStoreNames.contains("payloads")) {
        database.close();
        reject(new Error("Saved session stores are missing"));
        return;
      }
      const transaction = database.transaction(["records", "payloads"], "readwrite");
      const recordStore = transaction.objectStore("records");
      const payloadStore = transaction.objectStore("payloads");
      const recordsRequest = recordStore.getAll();
      recordsRequest.onerror = () => transaction.abort();
      recordsRequest.onsuccess = () => {
        const record = recordsRequest.result.find((item: { name?: string }) => item.name === targetName);
        if (!record) {
          transaction.abort();
          return;
        }
        const payloadRequest = payloadStore.get(record.id);
        payloadRequest.onerror = () => transaction.abort();
        payloadRequest.onsuccess = () => {
          const payload = payloadRequest.result as { snapshot?: { comboBeats?: number } } | undefined;
          if (!payload?.snapshot) {
            transaction.abort();
            return;
          }
          payload.snapshot.comboBeats = 3;
          payloadStore.put(payload);
        };
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("Could not corrupt saved session settings"));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error(`Saved session ${targetName} was not found for corruption`));
      };
    };
  }), name);
}

test("named sessions and favourites retain the exact combo, controls, and imported preset WAV assets", async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await installAudioInstrumentation(page);
  await loadCustomFixture(page);
  await setSavedControls(page);
  const savedCombo = await captureCombo(page);

  await openSaveManager(page);
  const sessionName = page.getByRole("textbox", { name: "Session name" });
  await expect(sessionName).toBeVisible();
  await sessionName.fill("QA Named Session");
  const saveSessionButton = page.getByRole("button", { name: "Save session" });
  const saveAsNewSessionButton = page.getByRole("button", { name: "Save as new session" });
  const sessions = page.getByRole("combobox", { name: "Session" });
  await sessionName.focus();
  await page.keyboard.press("Tab");
  await expect(saveSessionButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(saveAsNewSessionButton).toBeFocused();
  await saveAsNewSessionButton.click();
  await expect(sessions).toContainText("QA Named Session");
  await expect(sessions).toBeEnabled();
  await sessions.focus();
  await expect(sessions).toBeFocused();
  await sessionName.fill("QA Saved Copy");
  await saveAsNewSessionButton.click();
  await expect(sessions).toContainText("QA Saved Copy");
  await expect(sessions).toContainText("QA Named Session");
  await selectOptionContaining(sessions, "QA Named Session");
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("spinbutton", { name: "BPM" }).fill("110");
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await page.getByRole("radio", { name: "Q&A" }).check();
  await page.getByLabel("Large pause").check();
  await page.getByLabel("Combo length").selectOption("8");
  await page.getByRole("button", { name: "Generate combo" }).click();
  const changedBeforeLoad = await captureCombo(page);
  expect(changedBeforeLoad).not.toEqual(savedCombo);
  await page.getByRole("button", { name: "Load session" }).click();
  await expect.poll(() => captureCombo(page)).toEqual(savedCombo);
  await expectSavedControls(page);
  await expectCustomSourceRestored(page);
  await openSaveManager(page);
  await expect(page.getByRole("textbox", { name: "Session name" })).toHaveValue("QA Named Session");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions).toContainText("QA Named Session");
  await expect(sessions).toContainText("QA Saved Copy");
  await expectStopped(page);

  await openSaveManager(page);
  const favoriteName = page.getByRole("textbox", { name: "Favourite combo name" });
  await favoriteName.fill("QA Exact Combo");
  await page.getByRole("button", { name: "Save combo as favourite" }).click();
  const favorites = page.getByRole("combobox", { name: "Favourite combo" });
  await expect(favorites).toContainText("QA Exact Combo");
  await selectOptionContaining(favorites, "QA Exact Combo");

  await page.getByLabel("Combo length").selectOption("8");
  await page.getByRole("button", { name: "Generate combo" }).click();
  const changedCombo = await captureCombo(page);
  expect(changedCombo).not.toEqual(savedCombo);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload last saved" })).toBeEnabled();
  await page.getByRole("button", { name: "Reload last saved" }).click();
  await expect.poll(() => captureCombo(page)).toEqual(savedCombo);
  await expectSavedControls(page);
  await expectCustomSourceRestored(page);
  await expectStopped(page);

  const wavSizes = await page.evaluate(() => window.__savedSessionsQa?.decodedWavByteLengths ?? []);
  expect(wavSizes).toContain(sampleWav.length);
  expect(wavSizes).toContain(secondBeatWav.length);
  const savedBlobHashes = await persistedBlobDigests(page);
  expect(savedBlobHashes).toContain(sha256(sampleWav));
  expect(savedBlobHashes).toContain(sha256(beatWav));
  expect(savedBlobHashes).toContain(sha256(secondBeatWav));

  await openSaveManager(page);
  await expect(favorites).toContainText("QA Exact Combo");
  await selectOptionContaining(favorites, "QA Exact Combo");
  await page.getByRole("button", { name: "Load favourite combo" }).click();
  await expect.poll(() => captureCombo(page)).toEqual(savedCombo);
  await expectStopped(page);

  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedSessionsQa?.sourceStarts.length ?? 0)).toBeGreaterThan(0);
  const audioSources = await page.evaluate(() => window.__savedSessionsQa?.sourceStarts ?? []);
  expect(audioSources.some((source) => source.duration > 0)).toBe(true);
  expect(audioSources.some((source) => source.loop && Math.abs(source.duration - 0.29) < 0.001)).toBe(true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeVisible();

  await closeSaveManager(page);
  await expect(page.getByRole("button", { name: "Save session" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Save as new session" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete selected session" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete selected favourite" })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload last saved" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Favourite combo" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Load favourite combo" })).toBeHidden();

  const evidenceDirectory = path.resolve(process.cwd(), "test-results");
  mkdirSync(evidenceDirectory, { recursive: true });
  for (const viewport of [
    { width: 1280, height: 900, name: "desktop" },
    { width: 844, height: 900, name: "tablet" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectWithinViewport(page, viewport.width);
    if (viewport.name !== "tablet") {
      await page.screenshot({
        path: path.join(evidenceDirectory, `saved-sessions-${viewport.name}.png`),
        fullPage: false,
      });
    }
    if (viewport.name === "mobile") {
      await page.locator(".timeline-figure").scrollIntoViewIfNeeded();
      await expect(page.getByRole("img", { name: /Sequence timeline/ })).toBeInViewport();
      await page.screenshot({
        path: path.join(evidenceDirectory, "saved-sessions-mobile-timeline.png"),
        fullPage: false,
      });
    }
  }

  await openSaveManager(page);
  await clickAndAcceptDialog(page, "Delete selected favourite", "QA Exact Combo");
  await expect(favorites.locator("option").filter({ hasText: "QA Exact Combo" })).toHaveCount(0);

  await clickAndAcceptDialog(page, "Delete selected session", "QA Named Session");
  await expect(sessions.locator("option").filter({ hasText: "QA Named Session" })).toHaveCount(0);
  await selectOptionContaining(sessions, "QA Saved Copy");
  await clickAndAcceptDialog(page, "Delete selected session", "QA Saved Copy");
  await expect(sessions.locator("option").filter({ hasText: "QA Saved Copy" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await expect(sessions.locator("option").filter({ hasText: "QA Named Session" })).toHaveCount(0);
  await expect(sessions.locator("option").filter({ hasText: "QA Saved Copy" })).toHaveCount(0);
  await openSaveManager(page);
  await expect(favorites.locator("option").filter({ hasText: "QA Exact Combo" })).toHaveCount(0);

  const allowedOrigin = new URL(page.url()).origin;
  const nonLocalOrMutating = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== allowedOrigin || !["GET", "HEAD"].includes(request.method);
  });
  expect(nonLocalOrMutating).toEqual([]);
});

test("an invalid saved session record fails without replacing the active combo", async ({ page }) => {
  await installAudioInstrumentation(page);
  await loadCustomFixture(page);
  await setSavedControls(page);
  const savedCombo = await captureCombo(page);

  await openSaveManager(page);
  await page.getByRole("textbox", { name: "Session name" }).fill("QA Corrupt Record");
  await page.getByRole("button", { name: "Save session" }).click();
  const sessions = page.getByRole("combobox", { name: "Session" });
  await expect(sessions).toContainText("QA Corrupt Record");
  await expect(sessions).toBeEnabled();
  await selectOptionContaining(sessions, "QA Corrupt Record");
  await corruptSavedSessionSnapshot(page, "QA Corrupt Record");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await page.getByLabel("Combo length").selectOption("8");
  await page.getByRole("button", { name: "Generate combo" }).click();
  const activeCombo = await captureCombo(page);
  expect(activeCombo).not.toEqual(savedCombo);
  await expect(sessions).toContainText("QA Corrupt Record");
  await selectOptionContaining(sessions, "QA Corrupt Record");
  await page.getByRole("button", { name: "Load session" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("The saved session contains invalid settings or audio metadata. Delete it and save the session again.");
  await expect.poll(() => captureCombo(page)).toEqual(activeCombo);
  await expect(page.getByLabel("Combo length")).toHaveValue("8");
  await expectStopped(page);
});

test("an uploaded custom beat WAV survives named-session reload and produces nonzero output RMS", async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await installUploadedBeatInstrumentation(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Quick preset")).toHaveValue("SSC-085BPM-01", { timeout: 30_000 });
  const presetId = await page.getByLabel("Quick preset").inputValue();
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Preset", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "Custom", exact: true }).check();
  await expect(page.getByLabel("Upload custom beat")).toBeEnabled();
  await page.getByLabel("Upload custom beat").setInputFiles({
    name: "Uploaded-QA-Beat-128.wav",
    mimeType: "audio/wav",
    buffer: uploadedBeatWav,
  });
  const analysis = page.locator(".session-controls__analysis");
  await expect(analysis).toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 });
  await page.getByRole("spinbutton", { name: "Custom beat BPM" }).fill(String(uploadedBeatBpm));
  await page.getByRole("button", { name: "Use custom beat" }).click();

  await expect(page.getByRole("radio", { name: "Custom", exact: true })).toBeChecked();
  await expect(page.getByRole("spinbutton", { name: "Recorded BPM for custom beat" })).toHaveValue(String(uploadedBeatBpm));
  await expect(page.getByRole("spinbutton", { name: "BPM", exact: true })).toHaveValue(String(uploadedBeatBpm));
  await expect(page.getByLabel("Beat bed")).toBeDisabled();
  await expect(page.getByLabel("Quick preset")).toHaveValue(presetId);
  await page.getByRole("tab", { name: "Practice", exact: true }).click();

  await openSaveManager(page);
  await page.getByRole("textbox", { name: "Session name" }).fill("QA Uploaded Beat");
  await page.getByRole("button", { name: "Save as new session" }).click();
  const sessions = page.getByRole("combobox", { name: "Session" });
  await expect(sessions).toContainText("QA Uploaded Beat");
  await selectOptionContaining(sessions, "QA Uploaded Beat");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Quick preset")).toHaveValue(presetId, { timeout: 30_000 });
  await page.getByRole("tab", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload last saved" })).toBeEnabled();
  await page.getByRole("button", { name: "Reload last saved" }).click();

  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Custom", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Preset", exact: true })).not.toBeChecked();
  await expect(page.getByRole("spinbutton", { name: "Recorded BPM for custom beat" })).toHaveValue(String(uploadedBeatBpm));
  await expect(page.getByRole("spinbutton", { name: "BPM", exact: true })).toHaveValue(String(uploadedBeatBpm));
  await expect(page.getByLabel("Beat bed")).toBeDisabled();
  await expect(page.getByLabel("Quick preset")).toHaveValue(presetId);
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(await page.evaluate(() => window.__uploadedBeatQa?.resumeCount ?? 0)).toBe(0);
  expect(await page.evaluate(() => window.__uploadedBeatQa?.sourceStarts.length ?? 0)).toBe(0);

  const decodedWavByteLengths = await page.evaluate(() => window.__uploadedBeatQa?.decodedWavByteLengths ?? []);
  expect(decodedWavByteLengths).toContain(uploadedBeatWav.length);
  const savedBlobHashes = await persistedBlobDigests(page);
  expect(savedBlobHashes).toContain(sha256(uploadedBeatWav));

  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect.poll(() => activeUploadedBeatLoops(page)).toBe(1);
  await expect.poll(() => uploadedBeatOutputRms(page), { timeout: 10_000, intervals: [100, 150, 200, 250] })
    .toBeGreaterThan(0.001);
  const outputRms = await uploadedBeatOutputRms(page);
  expect(outputRms).toBeGreaterThan(0.001);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(await activeUploadedBeatLoops(page)).toBe(0);

  const allowedOrigin = new URL(page.url()).origin;
  const nonLocalOrMutating = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== allowedOrigin || !["GET", "HEAD"].includes(request.method);
  });
  expect(nonLocalOrMutating).toEqual([]);
});
