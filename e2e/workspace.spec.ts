import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

declare global {
  interface Window {
    __audioQa?: {
      contexts: AudioContext[];
      sourceStarts: Array<{ when: number; offset: number; loop: boolean }>;
      sourceStops: Array<{ when: number; loop: boolean }>;
    };
  }
}

const privateWavDirectory = process.env.SCRATCH_COMBO_PRIVATE_WAV_DIR;
const privateIniPath = process.env.SCRATCH_COMBO_PRIVATE_INI_PATH;

async function instrumentWebAudio(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      contexts: [] as AudioContext[],
      sourceStarts: [] as Array<{ when: number; offset: number; loop: boolean }>,
      sourceStops: [] as Array<{ when: number; loop: boolean }>,
    };
    (window as Window).__audioQa = qa;

    const originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      if (!qa.contexts.includes(this)) qa.contexts.push(this);
      return originalResume.call(this);
    };

    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      const context = this.context as AudioContext;
      if (!qa.contexts.includes(context)) qa.contexts.push(context);
      qa.sourceStarts.push({ when: when ?? context.currentTime, offset: offset ?? 0, loop: this.loop });
      return originalStart.call(this, when, offset, duration);
    };

    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      const context = this.context as AudioContext;
      if (!qa.contexts.includes(context)) qa.contexts.push(context);
      qa.sourceStops.push({ when: when ?? context.currentTime, loop: this.loop });
      return originalStop.call(this, when);
    };
  });
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

function makeIni(sampleFileName = "Wanted.wav"): string {
  return [
    "[Samples]",
    "CONFIGNAME=Browser Fixture",
    "VOL_B=35",
    "VOL_S=75",
    "RootSamplePathRelative=True",
    "RootSamplePath=assets",
    "Beat01=beat.wav",
    "BPM01=120",
    "",
    "[Sample01]",
    "SamplePlayFq=1",
    "SampleIsSilent=False",
    "SampleRepeatsPoss=True",
    "SampleRepeatMax=100",
    `SampleFileName=${sampleFileName}`,
    "SampleDisplayName=QA Tone",
    "SampleStartsForward=True",
    "SampleEndsForward=False",
    "Sample16ths=8",
    "UseSample=True",
    "",
  ].join("\n");
}

function makeSilentIni(durationTicks = 64): string {
  return [
    "[Samples]",
    "CONFIGNAME=Silent QA Fixture",
    "VOL_B=35",
    "VOL_S=75",
    "RootSamplePathRelative=True",
    "RootSamplePath=assets",
    "Beat01=beat.wav",
    "BPM01=120",
    "",
    "[Sample01]",
    "SamplePlayFq=1",
    "SampleIsSilent=True",
    "SampleRepeatsPoss=False",
    "SampleRepeatMax=0",
    "SampleFileName=unused.wav",
    "SampleDisplayName=Forced Silent",
    "SampleStartsForward=True",
    "SampleEndsForward=True",
    `Sample16ths=${durationTicks}`,
    "UseSample=False",
    "",
  ].join("\n");
}

async function loadFastImportedCombo(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Choose INI preset").setInputFiles(payload("Fast-QA.ini", Buffer.from(makeIni()), "text/plain"));
  await page.getByLabel("Choose WAV files").setInputFiles([
    payload("Wanted.wav", makeWav(440), "audio/wav"),
    payload("beat.wav", makeWav(100), "audio/wav"),
  ]);
  await page.getByLabel("Combo length").selectOption("4");
  await page.getByRole("spinbutton", { name: "BPM" }).fill("240");
  await page.getByLabel("Beat bed").selectOption("0");
  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: "Sequence timeline: 64 legacy ticks, 8 events" })).toBeVisible();
}

async function expectTwoSamplePasses(
  page: import("@playwright/test").Page,
  firstPassIndex: number,
  expectedPassSeconds: number,
  hasSilentResponse: boolean,
): Promise<void> {
  const readSampleStarts = () => page.evaluate(() => window.__audioQa?.sourceStarts.filter((start) => !start.loop).map((start) => start.when) ?? []);
  await expect.poll(async () => (await readSampleStarts()).length, { timeout: 12_000 })
    .toBeGreaterThanOrEqual(firstPassIndex + 16);
  const starts = (await readSampleStarts()).slice(firstPassIndex, firstPassIndex + 16);
  expect(starts).toHaveLength(16);
  const firstPassStart = starts[0]!;
  const secondPassStart = starts[8]!;
  expect(secondPassStart - firstPassStart).toBeCloseTo(expectedPassSeconds, 1);

  if (hasSilentResponse) {
    const silenceStarts = starts.filter((when) => when > firstPassStart + 1.05 && when < secondPassStart - 0.05);
    expect(silenceStarts).toEqual([]);
  }
}

async function readTimelineGeometry(page: import("@playwright/test").Page) {
  return page.locator(".timeline-scroll").evaluate((scroll) => {
    const board = scroll.querySelector<HTMLElement>(".timeline-board")!;
    const barLabels = scroll.querySelector<HTMLElement>(".timeline-bar-labels")!;
    const ruler = scroll.querySelector<HTMLElement>(".timeline-ruler")!;
    const axisLabel = scroll.querySelector<HTMLElement>(".timeline-axis-label")!;
    const laneLabel = scroll.querySelector<HTMLElement>(".timeline-lane-label")!;
    const track = scroll.querySelector<HTMLElement>(".timeline-track")!;
    const boardLeft = board.getBoundingClientRect().left;
    const rect = (element: HTMLElement) => element.getBoundingClientRect();
    const barRect = rect(barLabels);
    const rulerRect = rect(ruler);
    const trackRect = rect(track);
    const scrollRect = scroll.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      scrollClientWidth: scroll.clientWidth,
      scrollWidth: scroll.scrollWidth,
      scrollLeft: scroll.scrollLeft,
      maxScrollLeft: Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      barStart: barRect.left - boardLeft,
      rulerStart: rulerRect.left - boardLeft,
      trackStart: trackRect.left - boardLeft,
      barWidth: barRect.width,
      rulerWidth: rulerRect.width,
      trackWidth: trackRect.width,
      axisLeft: rect(axisLabel).left,
      laneLabelLeft: rect(laneLabel).left,
      scrollLeftEdge: scrollRect.left,
      laneLabelRight: rect(laneLabel).right,
      trackLeft: trackRect.left,
      containers: [".timeline-scroll", ".timeline-figure", ".sequence-section", ".sample-table-scroll", ".sample-table", ".sample-section", ".workspace"]
        .map((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const bounds = rect(element);
          const style = getComputedStyle(element);
          return { selector, left: bounds.left, right: bounds.right, width: bounds.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: style.overflowX, minWidth: style.minWidth, display: style.display };
        }),
      overflowIsolation: (() => {
        const timeline = document.querySelector<HTMLElement>(".timeline-figure")!;
        const samples = document.querySelector<HTMLElement>(".sample-section")!;
        const timelineDisplay = timeline.style.display;
        const samplesDisplay = samples.style.display;
        timeline.style.display = "none";
        const withoutTimeline = document.documentElement.scrollWidth;
        timeline.style.display = timelineDisplay;
        samples.style.display = "none";
        const withoutSamples = document.documentElement.scrollWidth;
        samples.style.display = samplesDisplay;
        return { withoutTimeline, withoutSamples };
      })(),
      overflowingElements: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .map((element) => ({
          tag: element.tagName,
          className: typeof element.className === "string" ? element.className : "",
          id: element.id,
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
          width: element.getBoundingClientRect().width,
        }))
        .filter((element) => element.right > window.innerWidth + 1 && element.width > 0)
        .sort((left, right) => right.right - left.right)
        .slice(0, 12),
    };
  });
}

async function verifyTimelineGeometryAtWidths(
  page: import("@playwright/test").Page,
  widths: readonly number[],
): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const initial = await readTimelineGeometry(page);
    expect(initial.documentWidth, `page must not overflow at ${width}px; isolated=${JSON.stringify(initial.overflowIsolation)}; containers=${JSON.stringify(initial.containers)}; offenders=${JSON.stringify(initial.overflowingElements)}`).toBeLessThanOrEqual(width + 1);
    expect(initial.scrollWidth).toBeGreaterThanOrEqual(initial.scrollClientWidth);

    const scrollStops = initial.maxScrollLeft > 0
      ? [0, Math.round(initial.maxScrollLeft / 2), initial.maxScrollLeft]
      : [0];
    for (const target of scrollStops) {
      await page.locator(".timeline-scroll").evaluate((scroll, next) => { scroll.scrollLeft = next; }, target);
      const geometry = await readTimelineGeometry(page);
      expect(geometry.scrollLeft, `timeline should reach requested scroll offset at ${width}px`).toBeCloseTo(target, 0);
      expect(geometry.barStart, `bar labels and ruler start together at ${width}px`).toBeCloseTo(geometry.rulerStart, 0);
      expect(geometry.rulerStart, `ruler and sample tracks start together at ${width}px`).toBeCloseTo(geometry.trackStart, 0);
      expect(geometry.barWidth, `bar labels span the grid width at ${width}px`).toBeCloseTo(geometry.rulerWidth, 0);
      expect(geometry.rulerWidth, `ruler spans the sample track width at ${width}px`).toBeCloseTo(geometry.trackWidth, 0);
      expect(Math.abs(geometry.axisLeft - geometry.laneLabelLeft), `sticky labels share a left edge at ${width}px`).toBeLessThanOrEqual(1);
      if (target === 0) {
        expect(Math.abs(geometry.laneLabelRight - geometry.trackLeft), `sample label stops at the grid start at ${width}px`).toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(geometry.axisLeft - geometry.scrollLeftEdge), `axis label stays pinned after horizontal scroll at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
  }
}

async function verifySamplePanel(page: import("@playwright/test").Page, expectedRows: number): Promise<void> {
  const panel = page.locator(".sample-table-scroll");
  await expect(panel).toHaveAttribute("role", "region");
  await expect(panel).toHaveAccessibleName("Sample settings");
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(expectedRows);

  const initial = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector<HTMLElement>("thead th")!.getBoundingClientRect();
    const rowRects = Array.from(element.querySelectorAll<HTMLElement>("tbody tr"), (row) => row.getBoundingClientRect());
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      headerTop: header.top,
      visibleRows: rowRects.filter((row) => row.top >= bounds.top && row.bottom <= bounds.bottom).length,
    };
  });
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(initial.visibleRows).toBeGreaterThanOrEqual(8);
  expect(initial.visibleRows).toBeLessThanOrEqual(15);

  await panel.focus();
  await expect(panel).toBeFocused();
  for (let pageDown = 0; pageDown < 20; pageDown += 1) await page.keyboard.press("PageDown");
  await expect.poll(() => panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(initial.scrollTop);

  const bottom = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector<HTMLElement>("thead th")!.getBoundingClientRect();
    const lastRow = element.querySelector<HTMLElement>("tbody tr:last-child")!.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      maxScrollTop: element.scrollHeight - element.clientHeight,
      headerTop: header.top,
      panelTop: bounds.top,
      panelBottom: bounds.bottom,
      lastRowTop: lastRow.top,
      lastRowBottom: lastRow.bottom,
    };
  });
  expect(bottom.scrollTop).toBeCloseTo(bottom.maxScrollTop, 0);
  expect(Math.abs(bottom.headerTop - (bottom.panelTop + 1))).toBeLessThanOrEqual(2);
  expect(bottom.lastRowTop).toBeGreaterThanOrEqual(bottom.panelTop);
  expect(bottom.lastRowBottom).toBeLessThanOrEqual(bottom.panelBottom + 1);
}

function payload(name: string, buffer: Buffer, mimeType: string) {
  return { name, buffer, mimeType };
}

function collectWavFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectWavFiles(fullPath);
    return entry.isFile() && path.extname(entry.name).toLowerCase() === ".wav" ? [fullPath] : [];
  });
}

test("demo Play/Stop uses one running AudioContext, advances progress, and completes locally", async ({ page }, testInfo) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await instrumentWebAudio(page);
  await page.goto("/");
  await expect(page.getByRole("option", { name: "Synthetic demo" })).toBeAttached();
  await page.getByLabel("Quick preset").selectOption("demo");

  await expect(page.getByRole("heading", { name: "Scratch Combo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sequence preview" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Sequence timeline: 32 sixteenth units, 4 events" })).toBeVisible();
  await expect(page.getByText("3 samples")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  const screenshotDirectory = path.resolve(process.cwd(), "test-results");
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, "demo-desktop-final.png"), fullPage: false });
  await page.screenshot({ path: testInfo.outputPath("demo-desktop.png"), fullPage: true });

  const status = page.locator(".transport-status");
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(status).toHaveText("Playing sequence.");
  await expect.poll(() => page.evaluate(() => window.__audioQa?.contexts.map((context) => context.state) ?? []))
    .toContain("running");
  await expect.poll(() => page.evaluate(() => window.__audioQa?.sourceStarts.length ?? 0))
    .toBeGreaterThan(0);

  const progress = page.getByRole("progressbar", { name: "Preview progress" });
  await expect.poll(async () => Number(await progress.getAttribute("value")))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveText("Playback stopped.");
  await expect(progress).toHaveAttribute("value", "0");

  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(status).toHaveText("Preview complete.", { timeout: 12_000 });
  await expect(progress).toHaveAttribute("value", "1");
  const audioState = await page.evaluate(() => ({
    contexts: window.__audioQa?.contexts.length ?? 0,
    startedSources: window.__audioQa?.sourceStarts.length ?? 0,
    states: window.__audioQa?.contexts.map((context) => context.state) ?? [],
  }));
  expect(audioState.contexts).toBe(1);
  expect(audioState.startedSources).toBeGreaterThan(1);
  expect(audioState.states).toContain("running");

  const externalOrMutatingRequests = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== new URL(page.url()).origin || !["GET", "HEAD"].includes(request.method);
  });
  expect(externalOrMutatingRequests).toEqual([]);
});

test("import diagnostics recover from missing and case-ambiguous WAV selections", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Choose INI preset").setInputFiles(payload("QA.ini", Buffer.from(makeIni()), "text/plain"));
  await expect(page.getByText(/Wanted\.wav.*not selected/i)).toBeVisible();

  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: /Sequence timeline: 128 legacy ticks/ })).toBeVisible();
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /This combo uses WAV files that are not ready: QA Tone/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate combo" })).toBeEnabled();

  const beat = payload("beat.wav", makeWav(100), "audio/wav");
  const sample = payload("Wanted.wav", makeWav(440), "audio/wav");
  await page.getByLabel("Choose WAV files").setInputFiles([sample, beat]);
  await expect(page.getByText(/not selected/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: /Sequence timeline: 128 legacy ticks/ })).toBeVisible();
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(page.locator(".transport-status")).toHaveText(/^Q&A · question playback · cycle \d+\.$/);
  await page.getByRole("button", { name: "Stop" }).click();

  const collision = payload("wanted.wav", makeWav(660), "audio/wav");
  await page.getByLabel("Choose WAV files").setInputFiles([sample, collision, beat]);
  await expect(page.getByText(/Selected files collide when paths are compared without case/i)).toBeVisible();

  await page.getByLabel("Choose WAV files").setInputFiles([sample, beat]);
  await expect(page.getByText(/collide when paths are compared without case|matches more than one selected file/i)).toHaveCount(0);
});

test("imported Q&A uses full silent response slots, Large Pause uses three, and Loop repeats until Stop", async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await instrumentWebAudio(page);
  await loadFastImportedCombo(page);

  const status = page.locator(".transport-status");
  const playhead = page.locator(".timeline-playhead");
  const sampleStartCount = () => page.evaluate(() => window.__audioQa?.sourceStarts.filter((start) => !start.loop).length ?? 0);
  await expect(page.getByRole("radio", { name: "Q&A" })).toBeChecked();
  await expect(page.getByLabel("Large pause")).not.toBeChecked();

  const regularQABaseline = await sampleStartCount();
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(status).toHaveText(/^Q&A · question playback · cycle \d+\.$/);
  await expect.poll(async () => Number.parseFloat((await playhead.getAttribute("style"))?.match(/left:\s*([\d.]+)%/)?.[1] ?? "0"))
    .toBeGreaterThan(20);
  await expect(status).toHaveText(/^Q&A · answer pause · cycle \d+\.$/, { timeout: 4_000 });
  const answerPosition = Number.parseFloat((await playhead.getAttribute("style"))?.match(/left:\s*([\d.]+)%/)?.[1] ?? "0");
  const firstQuestionSamples = await sampleStartCount();
  expect(firstQuestionSamples).toBeGreaterThan(2);
  const loopedBedCount = await page.evaluate(() => window.__audioQa?.sourceStarts.filter((start) => start.loop).length ?? 0);
  expect(loopedBedCount).toBe(1);
  expect(answerPosition).toBeGreaterThanOrEqual(0);
  expect(answerPosition).toBeLessThanOrEqual(100);
  await expect.poll(async () => {
    const current = Number.parseFloat((await playhead.getAttribute("style"))?.match(/left:\s*([\d.]+)%/)?.[1] ?? "0");
    return Math.abs(current - answerPosition);
  }).toBeGreaterThan(5);
  await expectTwoSamplePasses(page, regularQABaseline, 2, true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveText("Playback stopped.");
  await expect(page.getByRole("progressbar", { name: "Preview progress" })).toHaveAttribute("value", "0");
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();

  await page.getByLabel("Large pause").check();
  await expect(page.getByText("1 audio cycle, then 3 silent cycles.")).toBeVisible();
  const largePauseBaseline = await sampleStartCount();
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(status).toHaveText(/^Q&A · question playback · cycle \d+\.$/);
  await expect(status).toHaveText(/^Q&A · answer pause · cycle \d+\.$/, { timeout: 4_000 });
  await expectTwoSamplePasses(page, largePauseBaseline, 4, true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveText("Playback stopped.");

  await page.getByRole("radio", { name: "Loop" }).check();
  await expect(page.getByLabel("Large pause")).toHaveCount(0);
  const loopBaseline = await sampleStartCount();
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(status).toHaveText(/^Loop · combo cycle \d+\.$/);
  await expectTwoSamplePasses(page, loopBaseline, 1, false);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveText("Playback stopped.");
  await expect(page.getByRole("progressbar", { name: "Preview progress" })).toHaveAttribute("value", "0");

  const externalOrMutatingRequests = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== new URL(page.url()).origin || !["GET", "HEAD"].includes(request.method);
  });
  expect(externalOrMutatingRequests).toEqual([]);
});

test("timeline ruler and sample grid stay aligned across widths and horizontal scroll positions", async ({ page }) => {
  await loadFastImportedCombo(page);
  await verifyTimelineGeometryAtWidths(page, [390, 640, 800, 844, 1024, 1280, 1920]);

  await page.setViewportSize({ width: 390, height: 900 });
  const sampleTableScroll = page.locator(".sample-table-scroll");
  await sampleTableScroll.evaluate((element) => { element.scrollLeft = 0; });
  const initialTableOffset = await sampleTableScroll.evaluate((element) => element.scrollLeft);
  await sampleTableScroll.focus();
  expect(await sampleTableScroll.evaluate((element) => document.activeElement === element)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => sampleTableScroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(initialTableOffset);

  await page.locator(".timeline-scroll").evaluate((scroll) => { scroll.scrollLeft = scroll.scrollWidth; });
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Play sequence" }).click();
  const playhead = page.locator(".timeline-playhead");
  await expect(playhead).toBeVisible();
  const pinnedLabelHit = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(".timeline-scroll")!;
    const label = scroll.querySelector<HTMLElement>(".timeline-lane-label")!;
    const track = scroll.querySelector<HTMLElement>(".timeline-track")!;
    const playheadElement = scroll.querySelector<HTMLElement>(".timeline-playhead")!;
    scroll.scrollLeft = scroll.scrollWidth;
    const scrollRect = scroll.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const overlapLeft = Math.max(scrollRect.left, labelRect.left, trackRect.left);
    const overlapRight = Math.min(scrollRect.right, labelRect.right, trackRect.right);
    const overlapTop = Math.max(scrollRect.top, labelRect.top, trackRect.top);
    const overlapBottom = Math.min(scrollRect.bottom, labelRect.bottom, trackRect.bottom);
    if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) return { overlaps: false, hitLabel: false };

    const x = (overlapLeft + overlapRight) / 2;
    const y = (overlapTop + overlapBottom) / 2;
    playheadElement.style.left = ((x - trackRect.left) / trackRect.width) * 100 + "%";
    playheadElement.style.pointerEvents = "auto";
    const topmost = document.elementFromPoint(x, y);
    return {
      overlaps: true,
      hitLabel: topmost?.closest(".timeline-lane-label") === label,
      hitPlayhead: topmost === playheadElement,
    };
  });
  expect(pinnedLabelHit.overlaps).toBe(true);
  expect(pinnedLabelHit.hitLabel).toBe(true);
  expect(pinnedLabelHit.hitPlayhead).toBe(false);
  await page.getByRole("button", { name: "Stop" }).click();
});

test("workspace navigation follows section order, anchors, and active location", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeEnabled();
  const navigation = page.getByRole("navigation", { name: "Workspace sections" });
  const links = await navigation.getByRole("link").evaluateAll((elements) => elements.map((element) => ({
    label: element.textContent?.trim(),
    href: element.getAttribute("href"),
  })));
  expect(links).toEqual([
    { label: "Sequence", href: "#sequence-section" },
    { label: "Files", href: "#files-section" },
    { label: "Session", href: "#session-section" },
    { label: "Samples", href: "#sample-section" },
  ]);

  for (const [label, target] of [
    ["Sequence", "#sequence-section"],
    ["Files", "#files-section"],
    ["Session", "#session-section"],
    ["Samples", "#sample-section"],
  ] as const) {
    const link = navigation.getByRole("link", { name: label });
    await link.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(target);
    await expect(page.locator(target)).toBeInViewport();
    await expect(link).toHaveAttribute("aria-current", "location");
    await expect(navigation.locator('[aria-current="location"]')).toHaveCount(1);
  }

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(navigation.getByRole("link", { name: "Samples" })).toHaveAttribute("aria-current", "location");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(navigation.getByRole("link", { name: "Sequence" })).toHaveAttribute("aria-current", "location");
});

test("captures a narrow-viewport review; mobile layout support remains out of scope", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Generated combo" })).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Scratch Combo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("demo-mobile.png"), fullPage: true });
});

test("imported combo lengths map to 64, 128, 256, and 512 raw legacy ticks", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Choose INI preset").setInputFiles(payload("QA.ini", Buffer.from(makeIni()), "text/plain"));

  const comboLength = page.getByLabel("Combo length");
  const generate = page.getByRole("button", { name: "Generate combo" });
  for (const [beats, rawTicks] of [[4, 64], [8, 128], [16, 256], [32, 512]] as const) {
    await comboLength.selectOption(String(beats));
    await generate.click();
    const timeline = page.getByRole("img", { name: new RegExp(`Sequence timeline: ${rawTicks} legacy ticks, \\d+ events`) });
    await expect(timeline).toBeVisible();
    const accessibleName = await timeline.getAttribute("aria-label");
    const eventCount = Number(accessibleName?.match(/, (\d+) events$/)?.[1] ?? 0);
    expect(eventCount).toBe(rawTicks / 8);
  }
});

test("silent rows remain enabled when UseSample is false, and infeasible generation returns promptly", async ({ page }) => {
  await page.goto("/");
  const iniPicker = page.getByLabel("Choose INI preset");
  await iniPicker.setInputFiles(payload("Silent.ini", Buffer.from(makeSilentIni()), "text/plain"));

  const silentToggle = page.getByRole("checkbox", { name: "Enable Forced Silent for next combo" });
  await expect(silentToggle).toBeChecked();
  await expect(silentToggle).toBeDisabled();
  await page.getByLabel("Combo length").selectOption("4");
  await page.getByRole("button", { name: "Generate combo" }).click();
  await expect(page.getByRole("img", { name: "Sequence timeline: 64 legacy ticks, 1 events" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Sequence events" })).toContainText("Forced Silent, starts at legacy tick 1, lasts 64 legacy ticks, silent");
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(page.locator(".transport-status")).toHaveText("Q&A · question playback · cycle 1.");
  await page.getByRole("button", { name: "Stop" }).click();

  await iniPicker.setInputFiles(payload("Infeasible.ini", Buffer.from(makeSilentIni(8)), "text/plain"));
  const generate = page.getByRole("button", { name: "Generate combo" });
  await generate.click();
  await expect(page.getByRole("alert")).toContainText("within its bounded retries", { timeout: 10_000 });
  await expect(generate).toBeEnabled();
});

test("private 85 BPM preset reaches its Q&A answer slot and stops without uploading files", async ({ page }) => {
  test.skip(!privateWavDirectory, "Set SCRATCH_COMBO_PRIVATE_WAV_DIR to run the local preserved-asset smoke check.");
  const wavDirectory = privateWavDirectory!;
  const ini = privateIniPath ?? path.resolve(wavDirectory, "..", "SSC-085BPM-01.ini");
  test.skip(!existsSync(ini) || !existsSync(wavDirectory), "The configured private preset or WAV folder is unavailable.");

  const wavFiles = collectWavFiles(wavDirectory);
  test.skip(wavFiles.length === 0, "The configured private WAV folder contains no WAV files.");
  const iniText = readFileSync(ini, "utf8");
  const presetName = /^CONFIGNAME\s*=\s*(.+)$/im.exec(iniText)?.[1]?.trim();
  expect(presetName).toBeTruthy();

  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await instrumentWebAudio(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByLabel("Choose INI preset").setInputFiles({ name: path.basename(ini), mimeType: "text/plain", buffer: readFileSync(ini) });
  await page.getByLabel("Choose WAV files").setInputFiles(wavFiles.map((filePath) => ({
    name: path.basename(filePath),
    mimeType: "audio/wav",
    buffer: readFileSync(filePath),
  })));

  await expect(page.getByText("64 samples")).toBeVisible();
  await expect(page.getByText(/not selected|matches more than one selected file|collide when paths are compared without case/i)).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("85");
  await expect(page.locator(".sequence-heading")).toContainText(presetName!);

  const generate = page.getByRole("button", { name: "Generate combo" });
  await generate.click();
  const timeline = page.getByRole("img", { name: /Sequence timeline: 128 legacy ticks, \d+ events/ });
  await expect(timeline).toBeVisible();
  const timelineLabel = await timeline.getAttribute("aria-label");
  expect(Number(timelineLabel?.match(/, (\d+) events$/)?.[1] ?? 0)).toBeGreaterThan(0);
  const eventList = page.getByRole("list", { name: "Sequence events" });
  await expect(eventList.locator("li").first()).toContainText(/starts at legacy tick 1, lasts \d+ legacy ticks/);

  mkdirSync(path.resolve(process.cwd(), "test-results"), { recursive: true });
  await page.setViewportSize({ width: 844, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.resolve(process.cwd(), "test-results", "qa-loop-private-844.png"), fullPage: false });
  await verifySamplePanel(page, 64);
  await page.screenshot({ path: path.resolve(process.cwd(), "test-results", "qa-loop-samples-bottom-844.png"), fullPage: false });
  await page.locator(".sample-table-scroll").evaluate((element) => { element.scrollTop = 0; });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.resolve(process.cwd(), "test-results", "legacy-generator-final.png"), fullPage: false });
  await expect(generate).toBeInViewport();
  await expect(page.getByRole("button", { name: "Play sequence" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Stop" })).toBeInViewport();

  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(page.locator(".transport-status")).toHaveText("Q&A · question playback · cycle 1.");
  await expect.poll(() => page.evaluate(() => window.__audioQa?.contexts.map((context) => context.state) ?? []))
    .toContain("running");
  await expect.poll(() => page.evaluate(() => window.__audioQa?.sourceStarts.length ?? 0))
    .toBeGreaterThan(0);
  await expect(page.locator(".transport-status")).toHaveText(/^Q&A · answer pause · cycle \d+\.$/, { timeout: 12_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".transport-status")).toHaveText("Playback stopped.");

  const externalOrMutatingRequests = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== new URL(page.url()).origin || !["GET", "HEAD"].includes(request.method);
  });
  expect(externalOrMutatingRequests).toEqual([]);
});
