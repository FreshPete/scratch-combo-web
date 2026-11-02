import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

declare global {
  interface Window {
    __pagesTtmAudioQa?: {
      beatStarts: number
      beatStops: number
    }
  }
}

async function instrumentBeatSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = { beatStarts: 0, beatStops: 0 }
    const beatSources = new WeakSet<AudioBufferSourceNode>()
    window.__pagesTtmAudioQa = qa
    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (this.loop) {
        qa.beatStarts += 1
        beatSources.add(this)
      }
      return originalStart.call(this, when, offset, duration)
    }
    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (beatSources.has(this)) qa.beatStops += 1
      return originalStop.call(this, when)
    }
  })
}

async function assertPracticeTopRowsDoNotOverlap(page: Page, expanded: boolean): Promise<void> {
  const details = page.locator('.preview-help')
  const isOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open)
  if (isOpen !== expanded) await details.locator('summary').click()

  const bounds = await page.evaluate(() => {
    const read = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }
    return {
      quickPreset: read('.quick-preset-row'),
      aboutPreview: read('.preview-help'),
      practiceCard: read('.practice-cycle-controls'),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })
  expect(bounds.quickPreset.bottom).toBeLessThanOrEqual(bounds.aboutPreview.top + 1)
  expect(bounds.aboutPreview.bottom).toBeLessThanOrEqual(bounds.practiceCard.top + 1)
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth + 1)
}

async function assertTimelineCaptionItemsDoNotOverlap(page: Page): Promise<void> {
  const boxes = await page.locator('.timeline-caption > *').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }))
  expect(boxes.length).toBe(4)
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first]!
      const b = boxes[second]!
      const overlaps = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
      expect(overlaps, `Timeline caption items ${first} and ${second} overlap`).toBe(false)
    }
  }
}

function proofPath(name: string): string {
  const browser = (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return path.resolve(process.cwd(), 'docs/images', `pages-production-${name}-${browser}.png`)
}

test('production Pages preview renders 85 BPM TTM guides, assignments, fader states, Grid/Inline playback, and the worklet', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentBeatSource(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const presetRequests: string[] = []
  const assetRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/private-presets/')) presetRequests.push(request.url())
    if (pathname.includes('/assets/')) assetRequests.push(pathname)
  })

  await page.goto('/scratch-combo-web/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Quick preset')).toHaveValue('SSC-085BPM-01')
  for (const width of [390, 844, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    await assertPracticeTopRowsDoNotOverlap(page, false)
    await assertPracticeTopRowsDoNotOverlap(page, true)
    await assertTimelineCaptionItemsDoNotOverlap(page)
  }
  const previewHelp = page.locator('.preview-help')
  if (await previewHelp.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await previewHelp.locator('summary').click()
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const filesTab = page.getByRole('tab', { name: 'Files', exact: true })
  await filesTab.click()
  await expect(page.locator('.import-status__copy p')).toContainText(
    '85 BPM - Beginner ready. All 64 sample references and 2 beat files are loaded',
    { timeout: 60_000 },
  )

  const practiceTab = page.getByRole('tab', { name: 'Practice', exact: true })
  await practiceTab.click()
  const waveformView = page.getByRole('radio', { name: 'Waveform' })
  const ttmView = page.getByRole('radio', { name: 'TTM practice guides' })
  await expect(waveformView).toBeChecked()
  await expect(ttmView).toBeVisible()
  await expect(ttmView).toBeEnabled()
  await expect(page.getByText(/Local debug only/i)).toHaveCount(0)
  await expect(page.getByRole('img', { name: /Sequence timeline: 128 legacy ticks/ })).toBeVisible()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  const peakFillColors = await page.locator('.sequence-waveform path').evaluateAll((paths) => Array.from(new Set(
    paths.map((path) => getComputedStyle(path).fill).filter((fill) => fill && fill !== 'none'),
  )))
  expect(peakFillColors.length).toBeGreaterThanOrEqual(2)

  await ttmView.check()
  const legend = page.locator('.ttm-guide-legend')
  await expect(legend).toBeVisible()
  await expect(legend).toContainText(/Time.*record forward.*backward/)
  await expect(legend).toContainText(/OPEN.*audible.*CUT.*closed.*muted/)
  await expect(legend).toContainText(/Illustrative guides only.*not WAV transcriptions/)

  const activeLaneNames = await page.locator('.timeline-lane').evaluateAll((lanes) => lanes
    .filter((lane) => lane.querySelector('.sequence-event:not(.sequence-event--silent)'))
    .map((lane) => lane.querySelector('.timeline-lane-name-text')?.textContent?.trim() ?? '')
    .filter((name) => name && name !== 'Rest'),
  )
  const distinctActiveNames = [...new Set(activeLaneNames)]
  const namesWithoutBuiltInSuggestions = distinctActiveNames.filter((name) =>
    !new Set(['Baby', 'Baby (F)', 'Baby (R)', 'Baby Fade', 'Chirp']).has(name),
  )
  const targetName = namesWithoutBuiltInSuggestions[0]!
  expect(targetName).toBeTruthy()
  const untranscribedName = namesWithoutBuiltInSuggestions[1]
    ?? ['Baby (F)', 'Baby (R)', 'Chirp'].find((name) => distinctActiveNames.includes(name))
    ?? distinctActiveNames.find((name) => name !== targetName && name !== 'Baby')
  if (!untranscribedName) throw new Error('The practice combo needs an active second sample for the Untranscribed check.')
  const targetEventId = await page.locator('.timeline-lane').filter({
    has: page.locator('.timeline-lane-name-text', { hasText: new RegExp('^' + targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
  }).locator('.sequence-event[data-event-id]').first().getAttribute('data-event-id')
  const untranscribedEventId = await page.locator('.timeline-lane').filter({
    has: page.locator('.timeline-lane-name-text', { hasText: new RegExp('^' + untranscribedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
  }).locator('.sequence-event[data-event-id]').first().getAttribute('data-event-id')
  expect(targetEventId).not.toBeNull()
  expect(untranscribedEventId).not.toBeNull()

  const samplesTab = page.getByRole('tab', { name: 'Samples', exact: true })
  await samplesTab.click()
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(64)
  await page.getByRole('button', { name: 'Edit Baby (F)', exact: true }).click()
  const suggestedGuide = page.getByLabel('TTM guide for Baby (F)')
  await expect(suggestedGuide).toHaveValue('forward-movement')
  await expect(suggestedGuide.locator('option:checked')).toHaveText('Suggested: Forward movement')
  await expect(page.getByText(/Suggested from the exact sample label only.*no audio is analyzed/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByRole('button', { name: 'Edit Baby Fade', exact: true }).click()
  const unassignedGuide = page.getByLabel('TTM guide for Baby Fade')
  await expect(unassignedGuide).toHaveValue('untranscribed')
  await expect(unassignedGuide.locator('option:checked')).toHaveText('Unassigned · Untranscribed')
  await expect(page.getByText(/No guide is assigned/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByRole('button', { name: 'Edit ' + targetName, exact: true }).click()
  const targetGuide = page.getByLabel('TTM guide for ' + targetName)
  await targetGuide.selectOption('forward-cut')
  await expect(page.getByText(/Session-only illustrative guide/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Edit ' + untranscribedName, exact: true }).click()
  const explicitUntranscribed = page.getByLabel('TTM guide for ' + untranscribedName)
  await explicitUntranscribed.selectOption('untranscribed')
  await expect(page.getByText('Explicitly Untranscribed for this session. Choose a guide to add an illustrative pattern.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await practiceTab.click()
  await expect(ttmView).toBeChecked()
  const targetEvent = page.locator(`.sequence-event[data-event-id="${targetEventId}"]`)
  const untranscribedEvent = page.locator(`.sequence-event[data-event-id="${untranscribedEventId}"]`)
  await expect(targetEvent).toHaveClass(/sequence-event--ttm-guide/)
  const targetMotion = targetEvent.locator('.sequence-ttm-motion path')
  await expect(targetMotion).toHaveAttribute('d', 'M6 92 L50 8 L94 92')
  const motionEvidence = await targetMotion.evaluate((pathElement) => {
    const box = pathElement.getBoundingClientRect()
    const style = getComputedStyle(pathElement)
    return {
      d: pathElement.getAttribute('d') ?? '',
      stroke: style.stroke,
      strokeWidth: Number.parseFloat(style.strokeWidth),
      box: { width: box.width, height: box.height },
    }
  })
  expect(new Set((motionEvidence.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)).size).toBeGreaterThan(2)
  expect(motionEvidence.stroke).not.toBe('none')
  expect(motionEvidence.strokeWidth).toBeGreaterThan(0)
  expect(motionEvidence.box.width).toBeGreaterThan(0)
  expect(motionEvidence.box.height).toBeGreaterThan(0)
  await expect(targetEvent.locator('.sequence-ttm-fader__interval')).toHaveCount(2)
  await expect(targetEvent.locator('.sequence-ttm-fader__interval--open')).toHaveCount(1)
  await expect(targetEvent.locator('.sequence-ttm-fader__interval--closed')).toHaveCount(1)
  const faderIntervals = await targetEvent.locator('.sequence-ttm-fader__interval').evaluateAll((intervals) => intervals.map((interval) => ({
    state: interval.classList.contains('sequence-ttm-fader__interval--open') ? 'open'
      : interval.classList.contains('sequence-ttm-fader__interval--closed') ? 'closed' : 'unknown',
    left: interval.style.left,
    width: interval.style.width,
  })))
  expect(faderIntervals).toEqual([
    { state: 'open', left: '6%', width: '44%' },
    { state: 'closed', left: '50%', width: '44%' },
  ])
  await expect(untranscribedEvent).toHaveClass(/sequence-event--ttm-untranscribed/)
  await expect(untranscribedEvent.locator('.sequence-ttm-motion')).toHaveCount(0)
  await expect(untranscribedEvent.locator('.sequence-ttm-placeholder-mark')).toHaveText('—')

  const proofDirectory = path.resolve(process.cwd(), 'docs/images')
  mkdirSync(proofDirectory, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole('radio', { name: 'Grid' })).toBeChecked()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toContainText('Q&A · question playback', { timeout: 30_000 })
  await expect(page.locator('.sequence-event--active')).toHaveCount(1)
  await expect(page.locator('.timeline-lane--active .timeline-playhead')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__pagesTtmAudioQa?.beatStarts ?? 0)).toBe(1)
  const beatStopsBeforeViewSwitch = await page.evaluate(() => window.__pagesTtmAudioQa?.beatStops ?? 0)
  await expect(targetEvent.locator('.sequence-ttm-motion path')).toBeVisible()
  await expect(targetEvent.locator('.sequence-ttm-fader')).toBeVisible()
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.screenshot({ path: proofPath('ttm-grid'), fullPage: false })

  await waveformView.check()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  await ttmView.check()
  await expect(targetEvent.locator('.sequence-ttm-motion path')).toBeVisible()
  expect(await page.evaluate(() => window.__pagesTtmAudioQa?.beatStarts ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__pagesTtmAudioQa?.beatStops ?? 0)).toBe(beatStopsBeforeViewSwitch)

  await page.getByRole('radio', { name: 'Inline' }).check()
  const inlineTargetEvent = page.locator(`.timeline-inline-row .sequence-event[data-event-id="${targetEventId}"]`)
  const inlineUntranscribedEvent = page.locator(`.timeline-inline-row .sequence-event[data-event-id="${untranscribedEventId}"]`)
  await expect(inlineTargetEvent.locator('.sequence-ttm-motion path')).toHaveAttribute('d', 'M6 92 L50 8 L94 92')
  await expect(inlineTargetEvent.locator('.sequence-ttm-fader__interval--closed')).toBeVisible()
  await expect(inlineUntranscribedEvent.locator('.sequence-ttm-placeholder-mark')).toHaveText('—')
  await expect(page.locator('.sequence-event--active')).toHaveCount(1)
  expect(await page.evaluate(() => window.__pagesTtmAudioQa?.beatStarts ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__pagesTtmAudioQa?.beatStops ?? 0)).toBe(beatStopsBeforeViewSwitch)
  await expect.poll(async () => Number(await page.locator('.timeline-scroll').getAttribute('data-presentation-position-units')))
    .toBeGreaterThan(0)
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.screenshot({ path: proofPath('ttm-inline'), fullPage: false })

  expect(presetRequests.length).toBeGreaterThan(60)
  expect(
    presetRequests.every((url) => new URL(url).pathname.startsWith('/scratch-combo-web/private-presets/')),
    'Unexpected preset request paths: ' + JSON.stringify(presetRequests.filter((url) => !new URL(url).pathname.startsWith('/scratch-combo-web/private-presets/'))),
  ).toBe(true)
  const workletAsset = await page.evaluate(async () => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"]')
    if (!entry?.src) return ''
    const source = await (await fetch(entry.src)).text()
    return source.match(/\/scratch-combo-web\/assets\/soundtouch-processor-[^`]+\.js/)?.[0] ?? ''
  })
  expect(workletAsset).toMatch(/^\/scratch-combo-web\/assets\/soundtouch-processor-/)
  expect(assetRequests.some((requestPath) => /^\/scratch-combo-web\/assets\/chunk-[^/]+\.js$/.test(requestPath))).toBe(true)
  expect(assetRequests.every((requestPath) => {
    const filename = requestPath.slice(requestPath.lastIndexOf('/') + 1)
    return requestPath.startsWith('/scratch-combo-web/assets/') && !filename.startsWith('.')
  })).toBe(true)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  expect(await page.evaluate(() => window.__pagesTtmAudioQa?.beatStops ?? 0)).toBe(1)

  const sessionTab = page.getByRole('tab', { name: 'Session', exact: true })
  await sessionTab.click()
  await expect(page.getByRole('button', { name: 'Reset controls' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Pitch shift in semitones' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Sample level' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Beat level' })).toBeVisible()
  await page.screenshot({ path: proofPath('session-controls'), fullPage: false })
})
