import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { stageLocalImport } from './helpers/import-wizard'

declare global {
  interface Window {
    __timelinePresentationQa?: {
      beatStarts: number
      beatStops: number
      sampleStarts: number
    }
  }
}

function makeWav(frequency: number, durationSeconds = 0.4): Buffer {
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
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.4
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function makeIni(): string {
  const lines = [
    '[Samples]',
    'CONFIGNAME=Timeline presentation fixture',
    'VOL_B=35',
    'VOL_S=75',
    'RootSamplePathRelative=True',
    'RootSamplePath=assets',
    'Beat01=timeline-beat.wav',
    'BPM01=120',
  ]
  for (let index = 1; index <= 10; index += 1) {
    const sampleId = String(index).padStart(2, '0')
    lines.push(
      '',
      `[Sample${sampleId}]`,
      'SamplePlayFq=1',
      'SampleIsSilent=False',
      'SampleRepeatsPoss=True',
      'SampleRepeatMax=100',
      `SampleFileName=timeline-tone-${sampleId}.wav`,
      `SampleDisplayName=Timeline tone ${sampleId}`,
      'SampleStartsForward=True',
      'SampleEndsForward=False',
      'Sample16ths=8',
      'UseSample=True',
    )
  }
  lines.push('')
  return lines.join('\r\n')
}

async function instrumentAudioSources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = { beatStarts: 0, beatStops: 0, sampleStarts: 0 }
    const beatSources = new WeakSet<AudioBufferSourceNode>()
    window.__timelinePresentationQa = qa
    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (this.loop) {
        qa.beatStarts += 1
        beatSources.add(this)
      }
      else qa.sampleStarts += 1
      return originalStart.call(this, when, offset, duration)
    }
    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (beatSources.has(this)) qa.beatStops += 1
      return originalStop.call(this, when)
    }
  })
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  const wavFiles = Array.from({ length: 10 }, (_, index) => {
    const sampleId = String(index + 1).padStart(2, '0')
    return { name: `timeline-tone-${sampleId}.wav`, buffer: makeWav(300 + index * 40), mimeType: 'audio/wav' }
  })
  wavFiles.push({ name: 'timeline-beat.wav', buffer: makeWav(110, 0.3), mimeType: 'audio/wav' })
  await stageLocalImport(page, {
    name: 'timeline-presentation.ini',
    buffer: Buffer.from(makeIni()),
    mimeType: 'text/plain',
  }, wavFiles)
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Combo length').selectOption('16')
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: 'Sequence timeline: 256 legacy ticks, 32 events' })).toBeVisible()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  await expect(page.locator('.sequence-event--active, .timeline-lane--active')).toHaveCount(0)
  await expect(page.locator('.timeline-scroll')).toHaveAttribute('data-presentation-started', 'false')
}

type Segment = { id: string; left: string; width: string }

async function readSegments(page: Page, selector: string): Promise<Segment[]> {
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-event-id') ?? '',
    left: (element as HTMLElement).style.left,
    width: (element as HTMLElement).style.width,
  })).sort((left, right) => Number.parseFloat(left.left) - Number.parseFloat(right.left)))
}

async function readTrackAlignment(page: Page, layout: 'grid' | 'inline') {
  return page.locator('.timeline-scroll').evaluate((scroll, requestedLayout) => {
    const board = scroll.querySelector<HTMLElement>('.timeline-board')!
    const bar = scroll.querySelector<HTMLElement>('.timeline-bar-labels')!
    const ruler = scroll.querySelector<HTMLElement>('.timeline-ruler')!
    const track = scroll.querySelector<HTMLElement>(requestedLayout === 'grid' ? '.timeline-lane .timeline-track' : '.timeline-track--inline')!
    const relativeLeft = (element: HTMLElement) => element.getBoundingClientRect().left - board.getBoundingClientRect().left
    return { bar: relativeLeft(bar), ruler: relativeLeft(ruler), track: relativeLeft(track) }
  }, layout)
}

type PresentedState = {
  started: boolean
  position: number | null
  slotKind: string | null
  planIndex: string | null
  totalUnits: number
  active: Array<{ id: string; start: number; end: number }>
  playhead: number | null
}

async function readPresentedState(page: Page): Promise<PresentedState> {
  return page.locator('.timeline-scroll').evaluate((scroll) => {
    const totalUnits = Number(scroll.getAttribute('aria-label')?.match(/Sequence timeline: (\d+) legacy ticks/)?.[1] ?? 0)
    const active = Array.from(scroll.querySelectorAll<HTMLElement>('.sequence-event--active[data-event-id]')).map((event) => {
      const left = Number.parseFloat(event.style.left)
      const width = Number.parseFloat(event.style.width)
      return {
        id: event.dataset.eventId ?? '',
        start: left * totalUnits / 100,
        end: (left + width) * totalUnits / 100,
      }
    })
    const playhead = scroll.querySelector<HTMLElement>('.timeline-playhead')
    return {
      started: scroll.dataset.presentationStarted === 'true',
      position: scroll.dataset.presentationPositionUnits === undefined ? null : Number(scroll.dataset.presentationPositionUnits),
      slotKind: scroll.dataset.cycleSlotKind ?? null,
      planIndex: scroll.dataset.cyclePlanIndex ?? null,
      totalUnits,
      active,
      playhead: playhead ? Number.parseFloat(playhead.style.left) : null,
    }
  })
}

async function activeEventMatchesPresentedPosition(page: Page): Promise<boolean> {
  const state = await readPresentedState(page)
  if (!state.started || state.position === null || state.active.length !== 1) return false
  const [active] = state.active
  if (!active || state.position <= active.start + 0.8 || state.position >= active.end - 0.8) return false
  const playheadUnits = state.playhead === null ? Number.NaN : state.playhead * state.totalUnits / 100
  return Math.abs(playheadUnits - state.position) <= 0.25
}

async function assertNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(Math.max(dimensions.document, dimensions.body)).toBeLessThanOrEqual(dimensions.viewport)
}

async function assertStickyAtHorizontalStops(page: Page, selector: string): Promise<void> {
  const scroll = page.locator('.timeline-scroll')
  await scroll.evaluate((element) => { element.scrollLeft = 0 })
  const initialOffset = await page.locator(selector).first().evaluate((label) => label.getBoundingClientRect().left - label.closest('.timeline-scroll')!.getBoundingClientRect().left)
  const maximumScroll = await scroll.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(maximumScroll).toBeGreaterThan(0)
  for (const ratio of [0, 0.5, 1]) {
    await scroll.evaluate((element, position) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) * position }, ratio)
    const metrics = await page.locator(selector).first().evaluate((label) => ({
      offset: label.getBoundingClientRect().left - label.closest('.timeline-scroll')!.getBoundingClientRect().left,
      scrollLeft: label.closest('.timeline-scroll')!.scrollLeft,
    }))
    expect(Math.abs(metrics.scrollLeft - maximumScroll * ratio)).toBeLessThanOrEqual(1)
    expect(metrics.offset).toBeGreaterThanOrEqual(-1)
    expect(metrics.offset).toBeLessThanOrEqual(initialOffset + 1)
  }
}

test('Grid and Inline preserve event fractions, shared ticks, and narrow-screen clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await loadFixture(page)

  const gridLayout = page.getByRole('radio', { name: 'Grid' })
  const inlineLayout = page.getByRole('radio', { name: 'Inline' })
  await expect(gridLayout).toBeChecked()
  expect(await page.locator('.timeline-lane').count()).toBeGreaterThanOrEqual(6)
  await expect(page.locator('.timeline-lane').first()).toHaveCSS('min-height', '52px')
  const scrollCap = await page.locator('.timeline-scroll').evaluate((scroll) => Number.parseFloat(getComputedStyle(scroll).maxHeight))
  expect(scrollCap).toBeLessThanOrEqual(520)
  expect(scrollCap).toBeLessThanOrEqual(Math.min(520, 720 * 0.64) + 1)
  const scrollMetrics = await page.locator('.timeline-scroll').evaluate((scroll) => ({ height: scroll.clientHeight, contentHeight: scroll.scrollHeight }))
  expect(scrollMetrics.contentHeight).toBeGreaterThan(scrollMetrics.height)

  const transportBeforeGrid = await page.locator('.transport-row').evaluate((transport) => Boolean(
    document.querySelector('.timeline-figure')
    && (transport.compareDocumentPosition(document.querySelector('.timeline-figure')!) & Node.DOCUMENT_POSITION_FOLLOWING),
  ))
  expect(transportBeforeGrid).toBe(true)
  await expect(page.getByRole('button', { name: 'Play sequence' })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeInViewport()

  const gridSegments = await readSegments(page, '.timeline-lane .sequence-event')
  expect(gridSegments).toHaveLength(32)
  const gridAlignment = await readTrackAlignment(page, 'grid')
  expect(gridAlignment.bar).toBeCloseTo(gridAlignment.ruler, 0)
  expect(gridAlignment.ruler).toBeCloseTo(gridAlignment.track, 0)

  await inlineLayout.check()
  await expect(page.locator('.timeline-inline-row')).toHaveCount(1)
  await expect(page.locator('.timeline-inline-row')).toHaveCSS('min-height', '148px')
  const inlineSegments = await readSegments(page, '.timeline-inline-row .sequence-event--inline')
  expect(inlineSegments).toEqual(gridSegments)
  const inlineAlignment = await readTrackAlignment(page, 'inline')
  expect(inlineAlignment.bar).toBeCloseTo(inlineAlignment.ruler, 0)
  expect(inlineAlignment.ruler).toBeCloseTo(inlineAlignment.track, 0)
  for (let index = 0; index < inlineSegments.length - 1; index += 1) {
    const end = Number.parseFloat(inlineSegments[index]!.left) + Number.parseFloat(inlineSegments[index]!.width)
    expect(end).toBeCloseTo(Number.parseFloat(inlineSegments[index + 1]!.left), 2)
  }

  const proofDirectory = path.resolve(process.cwd(), 'test-results')
  mkdirSync(proofDirectory, { recursive: true })
  await page.screenshot({ path: path.join(proofDirectory, 'timeline-inline-1280.png'), fullPage: false })

  await page.setViewportSize({ width: 390, height: 820 })
  await assertNoPageOverflow(page)
  await assertStickyAtHorizontalStops(page, '.timeline-inline-row .timeline-axis-label')
  for (const width of [844, 1920]) {
    await page.setViewportSize({ width, height: 820 })
    await assertNoPageOverflow(page)
  }

  await gridLayout.check()
  await page.setViewportSize({ width: 390, height: 820 })
  await assertNoPageOverflow(page)
  await assertStickyAtHorizontalStops(page, '.timeline-lane .timeline-lane-label')
})

test('active waveform follows the estimated heard cursor across layouts, Auto-generate, answer silence, and Stop', async ({ page }) => {
  await instrumentAudioSources(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await loadFixture(page)

  await page.getByLabel('Auto-generate').check()
  await page.getByLabel('New combo every').selectOption('1')
  await page.getByRole('radio', { name: 'Loop' }).check()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  const timeline = page.locator('.timeline-scroll')
  await expect(page.locator('.transport-status')).toContainText('Loop · combo cycle 1.')
  await expect.poll(() => activeEventMatchesPresentedPosition(page), { timeout: 8_000 }).toBe(true)
  const firstPlanIndex = await timeline.getAttribute('data-cycle-plan-index')
  expect(firstPlanIndex).toBe('1')
  const firstPosition = (await readPresentedState(page)).position!
  await expect(page.locator('.timeline-lane--active .timeline-now-playing')).toHaveText('Now playing')
  await expect.poll(() => page.evaluate(() => window.__timelinePresentationQa?.beatStarts ?? 0)).toBe(1)
  const beatStopsBeforeToggle = await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)
  const sampleStartsBeforeBoundary = await page.evaluate(() => window.__timelinePresentationQa?.sampleStarts ?? 0)
  expect(sampleStartsBeforeBoundary).toBeGreaterThan(0)

  const proofDirectory = path.resolve(process.cwd(), 'test-results')
  mkdirSync(proofDirectory, { recursive: true })
  await page.locator('.timeline-lane--active').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(proofDirectory, 'timeline-grid-active-1280.png'), fullPage: false })

  await page.getByRole('radio', { name: 'Inline' }).check()
  await expect(page.locator('.timeline-inline-row .sequence-event--active[data-event-id]')).toHaveCount(1)
  await expect(page.locator('.sequence-event--active .sequence-inline-event-label')).toContainText(/Now playing · Timeline tone \d{2}/)
  await expect.poll(() => activeEventMatchesPresentedPosition(page), { timeout: 2_000 }).toBe(true)
  const inlinePosition = (await readPresentedState(page)).position!
  expect(inlinePosition).toBeGreaterThan(firstPosition)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStarts ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)).toBe(beatStopsBeforeToggle)

  await page.locator('.timeline-inline-row .sequence-event--active').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(proofDirectory, 'timeline-inline-active-1280.png'), fullPage: false })

  await expect.poll(() => timeline.getAttribute('data-cycle-plan-index'), { timeout: 12_000 }).toBe('2')
  await expect.poll(() => activeEventMatchesPresentedPosition(page), { timeout: 2_000 }).toBe(true)
  const currentEventIds = await page.locator('.timeline-inline-row .sequence-event--inline').evaluateAll((events) => events.map((event) => event.getAttribute('data-event-id')))
  const currentActiveId = await page.locator('.timeline-inline-row .sequence-event--active').getAttribute('data-event-id')
  expect(currentEventIds).toContain(currentActiveId)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStarts ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)).toBe(beatStopsBeforeToggle)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.timeline-scroll')).toHaveAttribute('data-presentation-started', 'false')
  await expect(page.locator('.timeline-scroll')).not.toHaveAttribute('data-presentation-position-units')
  await expect(page.locator('.timeline-scroll')).not.toHaveAttribute('data-cycle-plan-index')
  await expect(page.locator('.sequence-event--active')).toHaveCount(0)
  await expect(page.locator('.timeline-playhead')).toHaveCount(0)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)).toBe(1)

  await page.getByLabel('Auto-generate').uncheck()
  await page.getByRole('radio', { name: 'Q&A' }).check()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toHaveText(/^Q&A · answer pause · cycle 2\.$/, { timeout: 12_000 })
  await expect(timeline).toHaveAttribute('data-presentation-started', 'true')
  await expect(timeline).toHaveAttribute('data-cycle-slot-kind', 'silence')
  await expect(page.locator('.sequence-event--active')).toHaveCount(0)
  await expect(page.locator('.timeline-lane--active')).toHaveCount(0)
  await expect(page.locator('.timeline-playhead')).toHaveCount(1)
  const pauseState = await readPresentedState(page)
  expect(pauseState.playhead).not.toBeNull()
  expect(pauseState.position).not.toBeNull()
  expect(Math.abs(pauseState.playhead! * pauseState.totalUnits / 100 - pauseState.position!)).toBeLessThanOrEqual(0.25)
  const sampleStartsAtPause = await page.evaluate(() => window.__timelinePresentationQa?.sampleStarts ?? 0)
  await page.waitForTimeout(200)
  const laterPausePosition = Number(await timeline.getAttribute('data-presentation-position-units'))
  expect(laterPausePosition).toBeGreaterThan(pauseState.position!)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.sampleStarts ?? 0)).toBe(sampleStartsAtPause)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.sequence-event--active, .timeline-lane--active, .timeline-playhead')).toHaveCount(0)
})

test('the actual 85 BPM preset keeps its audible active wave aligned in Grid and Inline', async ({ page }) => {
  await instrumentAudioSources(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByLabel('Current session files')).toContainText('85 BPM - Beginner', { timeout: 60_000 })
  await expect(page.locator('.import-current__count')).toContainText('66 WAV files in session')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline: 128 legacy ticks/ })).toBeVisible()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Grid' })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Play sequence' })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeInViewport()

  await page.getByRole('button', { name: 'Play sequence' }).click()
  const timeline = page.locator('.timeline-scroll')
  const status = page.locator('.transport-status')
  await expect(status).toHaveText('Q&A · question playback · cycle 1.')
  await expect(timeline).not.toHaveAttribute('data-cycle-plan-index')
  await expect.poll(() => activeEventMatchesPresentedPosition(page), { timeout: 12_000 }).toBe(true)
  await expect(page.locator('.timeline-lane--active .timeline-now-playing')).toHaveText('Now playing')
  await expect.poll(() => page.evaluate(() => window.__timelinePresentationQa?.beatStarts ?? 0)).toBe(1)
  const beatStops = await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)

  const proofDirectory = path.resolve(process.cwd(), 'test-results')
  mkdirSync(proofDirectory, { recursive: true })
  await page.locator('.timeline-lane--active').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(proofDirectory, 'timeline-85-grid-active-1280.png'), fullPage: false })

  await page.getByRole('radio', { name: 'Inline' }).check()
  await expect(page.locator('.timeline-inline-row .sequence-event--active[data-event-id]')).toHaveCount(1)
  await expect.poll(() => activeEventMatchesPresentedPosition(page), { timeout: 2_000 }).toBe(true)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStarts ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)).toBe(beatStops)
  await page.locator('.timeline-inline-row .sequence-event--active').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(proofDirectory, 'timeline-85-inline-active-1280.png'), fullPage: false })

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.sequence-event--active, .timeline-lane--active, .timeline-playhead')).toHaveCount(0)
  expect(await page.evaluate(() => window.__timelinePresentationQa?.beatStops ?? 0)).toBe(1)
})
