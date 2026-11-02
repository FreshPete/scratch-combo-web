import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { stageLocalImport } from './helpers/import-wizard'

declare global {
  interface Window {
    __waveformQa?: {
      calls: number
      failNext: boolean
      blockNext: boolean
      blocked: boolean
      release: (() => void) | null
    }
    __ttmAudioQa?: {
      beatStarts: number
      beatStops: number
    }
    __ttmSaveQa?: {
      contents: string[]
    }
  }
}

function makeWav(kind: 'sine' | 'silence' = 'sine', durationSeconds = 0.18): Buffer {
  const sampleRate = 8_000
  const sampleCount = Math.round(sampleRate * durationSeconds)
  const dataBytes = sampleCount * 2
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = kind === 'silence' ? 0 : Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.4
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function makeIni(options: {
  readonly name?: string
  readonly fileName?: string
  readonly silent?: boolean
  readonly bpm?: number
} = {}): string {
  const name = options.name ?? 'Waveform sample'
  const fileName = options.fileName ?? 'waveform-sample.wav'
  const silent = options.silent ?? false
  return [
    '[Samples]',
    'CONFIGNAME=Focused waveform fixture',
    'VOL_B=35',
    'VOL_S=75',
    'RootSamplePathRelative=True',
    'RootSamplePath=assets',
    'Beat01=waveform-beat.wav',
    `BPM01=${options.bpm ?? 120}`,
    '',
    '[Sample01]',
    'SamplePlayFq=1',
    `SampleIsSilent=${silent ? 'True' : 'False'}`,
    'SampleRepeatsPoss=True',
    'SampleRepeatMax=100',
    `SampleFileName=${fileName}`,
    `SampleDisplayName=${name}`,
    'SampleStartsForward=True',
    'SampleEndsForward=False',
    'Sample16ths=8',
    `UseSample=${silent ? 'False' : 'True'}`,
    '',
  ].join('\r\n')
}

async function installWaveformDecoderControls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { calls: 0, failNext: false, blockNext: false, blocked: false, release: null as (() => void) | null }
    window.__waveformQa = state
    const OfflineContext = window.OfflineAudioContext
    if (!OfflineContext) return
    const original = OfflineContext.prototype.decodeAudioData
    OfflineContext.prototype.decodeAudioData = function (data: ArrayBuffer) {
      state.calls += 1
      if (state.failNext) {
        state.failNext = false
        return Promise.reject(new Error('QA forced waveform decode failure'))
      }
      const decoded = original.call(this, data)
      if (state.blockNext) {
        state.blockNext = false
        state.blocked = true
        return new Promise<AudioBuffer>((resolve, reject) => {
          state.release = () => { void decoded.then(resolve, reject) }
        })
      }
      return decoded
    }
  })
}

async function importCustomFixture(
  page: Page,
  options: {
    name?: string
    fileName?: string
    silent?: boolean
    wav?: Buffer
    includeBeat?: boolean
    failWaveformDecodeOnLoad?: boolean
    blockWaveformDecodeOnLoad?: boolean
  } = {},
  navigate = true,
): Promise<void> {
  if (navigate) {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  }
  const files = []
  if (options.wav) files.push({ name: options.fileName ?? 'waveform-sample.wav', buffer: options.wav, mimeType: 'audio/wav' })
  if (options.includeBeat !== false) files.push({ name: 'waveform-beat.wav', buffer: makeWav('sine', 0.3), mimeType: 'audio/wav' })
  await stageLocalImport(page, {
    name: 'focused-waveform.ini',
    buffer: Buffer.from(makeIni(options)),
    mimeType: 'text/plain',
  }, files)
  if (options.failWaveformDecodeOnLoad || options.blockWaveformDecodeOnLoad) {
    await page.evaluate((behavior) => {
      if (behavior.fail) window.__waveformQa!.failNext = true
      if (behavior.block) window.__waveformQa!.blockNext = true
    }, { fail: Boolean(options.failWaveformDecodeOnLoad), block: Boolean(options.blockWaveformDecodeOnLoad) })
  }
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Combo length').selectOption('4')
}

async function generateCombo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline: 64 legacy ticks/ })).toBeVisible()
  await expect(page.locator('.sequence-event').first()).toBeVisible()
}

async function loadCustomFixture(
  page: Page,
  options: { name?: string; fileName?: string; silent?: boolean; wav?: Buffer; includeBeat?: boolean } = {},
): Promise<void> {
  await importCustomFixture(page, options)
  await generateCombo(page)
}

async function readGridGeometry(page: Page) {
  return page.locator('.timeline-scroll').evaluate((scroll) => {
    const board = scroll.querySelector<HTMLElement>('.timeline-board')!
    const barLabels = scroll.querySelector<HTMLElement>('.timeline-bar-labels')!
    const ruler = scroll.querySelector<HTMLElement>('.timeline-ruler')!
    const track = scroll.querySelector<HTMLElement>('.timeline-track')!
    const rect = (element: HTMLElement) => element.getBoundingClientRect()
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      maxScrollLeft: Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      scrollLeft: scroll.scrollLeft,
      barStart: rect(barLabels).left - rect(board).left,
      rulerStart: rect(ruler).left - rect(board).left,
      trackStart: rect(track).left - rect(board).left,
      barWidth: rect(barLabels).width,
      rulerWidth: rect(ruler).width,
      trackWidth: rect(track).width,
      eventCount: scroll.querySelectorAll('.sequence-event').length,
      laneCount: scroll.querySelectorAll('.timeline-lane').length,
    }
  })
}

test('real WAV peaks sit inside their event slot and the timeline grid stays aligned at seven widths', async ({ page }) => {
  await installWaveformDecoderControls(page)
  await loadCustomFixture(page, { wav: makeWav() })
  const waveform = page.locator('.sequence-waveform').first()
  await expect(waveform).toBeVisible({ timeout: 10_000 })
  const signal = await waveform.evaluate((svg) => {
    const pathData = svg.querySelector('path')?.getAttribute('d') ?? ''
    const event = svg.closest<HTMLElement>('.sequence-event')!
    const svgRect = svg.getBoundingClientRect()
    const eventRect = event.getBoundingClientRect()
    return {
      pathData,
      svgWidth: svgRect.width,
      eventWidth: eventRect.width,
      widthPercent: Number.parseFloat((svg as SVGSVGElement).style.width),
    }
  })
  const coordinates = (signal.pathData.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  expect(signal.pathData).toContain('Z')
  expect(new Set(coordinates.filter((_, index) => index % 2 === 1)).size).toBeGreaterThan(1)
  expect(signal.widthPercent).toBeGreaterThan(1)
  expect(signal.widthPercent).toBeLessThan(100)
  expect(signal.svgWidth).toBeGreaterThan(0)
  expect(signal.svgWidth).toBeLessThan(signal.eventWidth)

  for (const width of [390, 640, 800, 1024, 1280, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    const initial = await readGridGeometry(page)
    expect(initial.pageWidth, `document must remain clipped at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(initial.barStart).toBeCloseTo(initial.rulerStart, 0)
    expect(initial.rulerStart).toBeCloseTo(initial.trackStart, 0)
    expect(initial.barWidth).toBeCloseTo(initial.rulerWidth, 0)
    expect(initial.rulerWidth).toBeCloseTo(initial.trackWidth, 0)
    expect(initial.eventCount).toBeGreaterThan(0)
    for (const target of [0, Math.round(initial.maxScrollLeft / 2), initial.maxScrollLeft]) {
      await page.locator('.timeline-scroll').evaluate((scroll, next) => { scroll.scrollLeft = next }, target)
      const scrolled = await readGridGeometry(page)
      expect(scrolled.scrollLeft).toBeCloseTo(target, 0)
      expect(scrolled.barStart).toBeCloseTo(scrolled.rulerStart, 0)
      expect(scrolled.rulerStart).toBeCloseTo(scrolled.trackStart, 0)
      expect(scrolled.eventCount).toBe(initial.eventCount)
      expect(scrolled.laneCount).toBe(initial.laneCount)
    }
  }
})

test('silent and decoder-failed audio keep events visible without invented peaks', async ({ page }) => {
  await installWaveformDecoderControls(page)
  await loadCustomFixture(page, { name: 'Silent row', fileName: 'silent-row.wav', silent: true, includeBeat: false })
  await expect(page.locator('.sequence-event--silent')).toHaveCount(8)
  await expect(page.locator('.sequence-waveform')).toHaveCount(0)

  await importCustomFixture(page, {
    name: 'Corrupt row',
    fileName: 'corrupt-row.wav',
    wav: makeWav(),
    includeBeat: false,
    failWaveformDecodeOnLoad: true,
  }, false)
  await generateCombo(page)
  await expect.poll(() => page.evaluate(() => window.__waveformQa!.calls)).toBeGreaterThan(0)
  await expect(page.locator('.sequence-event')).toHaveCount(8)
  await expect(page.locator('.sequence-waveform')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a preset and file change makes an older pending waveform decode stale', async ({ page }) => {
  await installWaveformDecoderControls(page)
  await importCustomFixture(page, {
    name: 'Decode race',
    fileName: 'race.wav',
    wav: makeWav(),
    blockWaveformDecodeOnLoad: true,
  })
  await expect.poll(() => page.evaluate(() => window.__waveformQa!.blocked)).toBe(true)
  await generateCombo(page)
  await expect.poll(() => page.evaluate(() => window.__waveformQa!.blocked)).toBe(true)

  await importCustomFixture(page, { name: 'Decode race', fileName: 'race.wav', wav: makeWav('silence') }, false)
  await expect(page.getByRole('img', { name: /Sequence timeline/ })).toHaveCount(0)
  await generateCombo(page)
  await expect(page.locator('.sequence-waveform')).toHaveCount(8, { timeout: 10_000 })
  const currentPath = await page.locator('.sequence-waveform path').first().getAttribute('d')
  const flatCoordinates = (currentPath?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  expect(new Set(flatCoordinates.filter((_, index) => index % 2 === 1))).toEqual(new Set([16]))

  await page.evaluate(() => window.__waveformQa!.release?.())
  await page.waitForTimeout(100)
  await expect(page.locator('.sequence-waveform path').first()).toHaveAttribute('d', currentPath!)
})

test('TTM guide selection is advisory session state and switching views keeps playback and grid position', async ({ page }) => {
  await page.addInitScript(() => {
    const qa = { beatStarts: 0, beatStops: 0 }
    window.__ttmAudioQa = qa
    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (this.loop) qa.beatStarts += 1
      return originalStart.call(this, when, offset, duration)
    }
    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (this.loop) qa.beatStops += 1
      return originalStop.call(this, when)
    }
    const saveState = { contents: [] as string[] }
    window.__ttmSaveQa = saveState
    ;(window as unknown as { showSaveFilePicker: () => Promise<{
      name: string
      createWritable: () => Promise<{ write: (value: string | Blob) => Promise<void>; close: () => Promise<void> }>
    }> }).showSaveFilePicker = async () => {
      let content = ''
      return {
        name: 'ttm-session.ini',
        createWritable: async () => ({
          write: async (value) => { content = typeof value === 'string' ? value : await value.text() },
          close: async () => { saveState.contents.push(content) },
        }),
      }
    }
  })
  await loadCustomFixture(page, { name: 'Baby(F)', fileName: 'baby-forward.wav', wav: makeWav() })
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Baby(F)' }).click()
  const guideSelect = page.getByLabel('TTM guide for Baby(F)')
  await expect(guideSelect).toHaveValue('forward-movement')
  await expect(guideSelect.locator('option:checked')).toHaveText('Suggested: Forward movement')
  await expect(guideSelect.locator('option')).toHaveText([
    'Untranscribed', 'Baby scratch / rub', 'Suggested: Forward movement', 'Backward movement', 'Forward scratch / cut', 'Chirp',
  ])
  await expect(page.getByText(/suggested from the exact sample label only.*no audio is analyzed/i)).toBeVisible()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('radio', { name: 'TTM practice guides' }).check()
  await expect(page.getByRole('radio', { name: 'TTM practice guides' })).toBeChecked()
  const timeline = page.locator('.timeline-scroll')
  const geometryBefore = await readGridGeometry(page)
  const ttmVisual = page.locator('.sequence-ttm-motion path').first()
  await expect(ttmVisual).toBeVisible()
  await expect(page.locator('.sequence-event').first()).toHaveAttribute('title', /Suggested illustrative TTM guide: Forward movement.*not an audio transcription/i)
  const babyForwardLane = page.locator('.timeline-lane').filter({ has: page.locator('.timeline-lane-name-text', { hasText: 'Baby(F)' }) }).first()
  await expect(babyForwardLane.locator('.sequence-event--ttm-guide')).toHaveCount(8)

  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toContainText('Q&A · question playback · cycle 1.')
  await expect.poll(() => page.evaluate(() => window.__ttmAudioQa!.beatStarts)).toBe(1)
  const progress = page.getByRole('progressbar', { name: 'Preview progress' })
  await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(0.05)
  const progressBefore = Number(await progress.getAttribute('value'))
  const playheadBefore = await page.locator('.timeline-playhead').getAttribute('style')
  expect(playheadBefore).toMatch(/left:\s*(?!0(?:\.0+)?%)/)
  const stopsBefore = await page.evaluate(() => window.__ttmAudioQa!.beatStops)
  await page.getByRole('radio', { name: 'Waveform' }).check()
  await expect(page.locator('.sequence-waveform').first()).toBeVisible()
  await page.getByRole('radio', { name: 'TTM practice guides' }).check()
  await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(progressBefore)
  expect(await page.evaluate(() => window.__ttmAudioQa!.beatStarts)).toBe(1)
  expect(await page.evaluate(() => window.__ttmAudioQa!.beatStops)).toBe(stopsBefore)
  const geometryAfter = await readGridGeometry(page)
  expect(geometryAfter.barStart).toBeCloseTo(geometryBefore.barStart, 0)
  expect(geometryAfter.rulerStart).toBeCloseTo(geometryBefore.rulerStart, 0)
  expect(geometryAfter.trackStart).toBeCloseTo(geometryBefore.trackStart, 0)
  expect(await timeline.count()).toBe(1)
  expect(await page.locator('.timeline-playhead').count()).toBeGreaterThan(0)
  const playheadAfter = await page.locator('.timeline-playhead').getAttribute('style')
  expect(playheadAfter).toMatch(/left:\s*(?!0(?:\.0+)?%)/)

  const proofDirectory = path.resolve(process.cwd(), 'test-results/ttm-beats-qa')
  mkdirSync(proofDirectory, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#sequence-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.screenshot({ path: path.join(proofDirectory, 'integrated-ttm-guides.png'), fullPage: true })
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await guideSelect.selectOption('untranscribed')
  await expect(guideSelect.locator('option:checked')).toHaveText('Untranscribed')
  await expect(page.getByText('Explicitly Untranscribed for this session. Choose a guide to add an illustrative pattern.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.locator('.sequence-event--ttm-untranscribed')).toHaveCount(8)
  await expect(page.locator('.sequence-ttm-motion')).toHaveCount(0)
  await expect(page.locator('.sequence-event').first()).toHaveAttribute('title', /explicitly set to Untranscribed/i)
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save Sample Data' }).click()
  await expect.poll(() => page.evaluate(() => window.__ttmSaveQa!.contents.length)).toBe(1)
  const savedIni = await page.evaluate(() => window.__ttmSaveQa!.contents[0])
  expect(savedIni).toContain('[Sample01]')
  expect(savedIni).not.toMatch(/ttm|guide|motion/i)

  await loadCustomFixture(page, { name: 'Unknown tone', fileName: 'unknown-tone.wav', wav: makeWav() })
  await page.getByRole('radio', { name: 'TTM practice guides' }).check()
  await expect(page.locator('.timeline-lane-label--ttm').filter({ hasText: 'Unassigned' })).toBeVisible()
  await expect(page.locator('.sequence-event--ttm-unassigned')).toHaveCount(8)
  await expect(page.locator('.sequence-ttm-motion')).toHaveCount(0)
  await expect(page.locator('.sequence-event').first()).toHaveAttribute('title', /TTM guide is unassigned \(Untranscribed\)/i)
})
