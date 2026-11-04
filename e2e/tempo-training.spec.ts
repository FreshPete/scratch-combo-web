import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createValidWizardFixture } from './fixtures/import-wizard-fixtures'
import { loadLocalImport } from './helpers/import-wizard'

declare global {
  interface Window {
    __tempoTrainingQa?: {
      buffers: Array<{
        node: AudioBufferSourceNode
        when: number
        callTime: number
        offset: number | undefined
        durationArgument: number | undefined
        loop: boolean
        loopStart: number
        loopEnd: number
        buffer: AudioBuffer | null
      }>
      bufferStops: Array<{ node: AudioBufferSourceNode; when: number; callTime: number }>
      oscillators: Array<{
        node: OscillatorNode
        when: number
        callTime: number
        frequency: number
      }>
      oscillatorStops: Array<{ node: OscillatorNode; when: number; callTime: number }>
      connections: Array<{ source: AudioNode; destination: AudioNode }>
      statusEvents: Array<{ text: string; audioTime: number | null; wallTime: number }>
    }
  }
}

test.describe.configure({ timeout: 180_000 })

const startBpm = 160
const beatReferenceBpm = 85
const cueSeconds = 1
const loopEndSeconds = 3
const trainingBeatName = 'TempoTraining-TrimmedLoop.wav'
const estimatedProcessorDelaySeconds = 0.13

function makeTrainingBeatWav(): Buffer {
  const sampleRate = 44_100
  const durationSeconds = 10
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

  const loopContentEnd = durationSeconds - 1
  const sourceBeatSeconds = 60 / beatReferenceBpm
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate
    let sample: number
    if (time < cueSeconds) {
      sample = 0.24 * Math.sin(2 * Math.PI * 330 * time)
    } else if (time < loopContentEnd) {
      const beatOffset = (time - cueSeconds) % sourceBeatSeconds
      const pulse = beatOffset < 0.08 ? Math.exp(-beatOffset * 38) : 0
      sample = 0.07 * Math.sin(2 * Math.PI * 220 * (time - cueSeconds))
        + pulse * (
          0.24 * Math.sin(2 * Math.PI * 220 * beatOffset)
          + 0.05 * Math.sin(2 * Math.PI * 1_100 * beatOffset)
        )
    } else {
      sample = 0.24 * Math.sin(2 * Math.PI * 660 * (time - loopContentEnd))
    }
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2)
  }
  return wav
}

async function installWebAudioInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      buffers: [] as Array<{
        node: AudioBufferSourceNode
        when: number
        callTime: number
        offset: number | undefined
        durationArgument: number | undefined
        loop: boolean
        loopStart: number
        loopEnd: number
        buffer: AudioBuffer | null
      }>,
      bufferStops: [] as Array<{ node: AudioBufferSourceNode; when: number; callTime: number }>,
      oscillators: [] as Array<{
        node: OscillatorNode
        when: number
        callTime: number
        frequency: number
      }>,
      oscillatorStops: [] as Array<{ node: OscillatorNode; when: number; callTime: number }>,
      connections: [] as Array<{ source: AudioNode; destination: AudioNode }>,
      statusEvents: [] as Array<{ text: string; audioTime: number | null; wallTime: number }>,
    }
    window.__tempoTrainingQa = qa

    const originalBufferStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      qa.buffers.push({
        node: this,
        when: when ?? this.context.currentTime,
        callTime: this.context.currentTime,
        offset,
        durationArgument: duration,
        loop: this.loop,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
        buffer: this.buffer,
      })
      return originalBufferStart.call(this, when, offset, duration)
    }

    const originalBufferStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      qa.bufferStops.push({ node: this, when: when ?? this.context.currentTime, callTime: this.context.currentTime })
      return originalBufferStop.call(this, when)
    }

    const originalOscillatorStart = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (when?: number) {
      qa.oscillators.push({
        node: this,
        when: when ?? this.context.currentTime,
        callTime: this.context.currentTime,
        frequency: this.frequency.value,
      })
      return originalOscillatorStart.call(this, when)
    }

    const originalOscillatorStop = OscillatorNode.prototype.stop
    OscillatorNode.prototype.stop = function (when?: number) {
      qa.oscillatorStops.push({ node: this, when: when ?? this.context.currentTime, callTime: this.context.currentTime })
      return originalOscillatorStop.call(this, when)
    }

    const originalConnect = AudioNode.prototype.connect as unknown as (
      this: AudioNode,
      destination: AudioNode | AudioParam,
      output?: number,
      input?: number,
    ) => AudioNode
    AudioNode.prototype.connect = function (destination: AudioNode | AudioParam, output?: number, input?: number) {
      if (destination instanceof AudioNode) qa.connections.push({ source: this, destination })
      return originalConnect.call(this, destination, output, input)
    } as typeof AudioNode.prototype.connect

    let observedStatus: HTMLElement | null = null
    let statusObserver: MutationObserver | null = null
    const recordStatus = () => {
      const status = document.querySelector<HTMLElement>('.transport-status')
      if (!status) return
      if (status !== observedStatus) {
        statusObserver?.disconnect()
        observedStatus = status
        statusObserver = new MutationObserver(recordStatus)
        statusObserver.observe(status, { childList: true, subtree: true, characterData: true })
      }
      const text = status.textContent?.trim() ?? ''
      if (qa.statusEvents.at(-1)?.text === text) return
      const context = qa.buffers.at(-1)?.node.context ?? qa.oscillators.at(-1)?.node.context
      qa.statusEvents.push({ text, audioTime: context?.currentTime ?? null, wallTime: performance.now() })
    }
    window.setInterval(recordStatus, 10)
  })
}

async function loadPracticeFixture(page: Page, scenario: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  const fixture = await createValidWizardFixture(path.resolve(
    process.cwd(), '.forge', 'tempo-training-qa-results', 'fixtures', scenario,
  ))
  await loadLocalImport(page, fixture.iniPath, fixture.audioDirectory, 'Wizard Memory Fixture', 'folder')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
  await page.getByLabel('Combo length').selectOption('4')
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 8 events' })).toBeVisible()
}

async function openDetails(details: Locator): Promise<void> {
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator('summary').click()
  }
}

async function configureTrimmedBeatAndTraining(
  page: Page,
  options: { targetBpm: number; stepBpm: number; roundsPerStep: number },
): Promise<void> {
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await page.getByLabel('Upload custom beat').setInputFiles({
    name: trainingBeatName,
    mimeType: 'audio/wav',
    buffer: makeTrainingBeatWav(),
  })
  await expect(page.locator('.session-controls__analysis'))
    .toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 })
  await page.getByRole('spinbutton', { name: 'Custom beat BPM', exact: true }).fill(String(beatReferenceBpm))
  await page.getByRole('button', { name: 'Use custom beat', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat', exact: true }))
    .toHaveValue(String(beatReferenceBpm))

  const trimDisclosure = page.getByText('Manual beat trim', { exact: true })
  await expect(trimDisclosure).toBeVisible()
  if (!(await trimDisclosure.evaluate((element) => Boolean(element.closest('details')?.open)))) {
    await trimDisclosure.click()
  }
  const cue = page.getByRole('spinbutton', { name: 'First downbeat / loop start (seconds)', exact: true })
  const loopEnd = page.getByRole('spinbutton', { name: 'Loop end (seconds)', exact: true })
  await cue.fill(String(cueSeconds))
  await loopEnd.fill(String(loopEndSeconds))
  await page.getByRole('button', { name: 'Apply beat trim', exact: true }).click()
  await expect(page.locator('.session-controls__trim-status'))
    .toContainText('Applied: cue 1.000s · loop end 3.000s.')

  await page.getByRole('spinbutton', { name: 'BPM', exact: true }).fill(String(startBpm))
  const trainer = page.locator('#tempo-training')
  await expect(trainer).toBeVisible()
  await openDetails(trainer)
  const enabled = page.locator('#tempo-training-enabled')
  await expect(enabled).not.toBeChecked()
  await expect(page.locator('#tempo-training-target-bpm')).toHaveValue('100')
  await expect(page.locator('#tempo-training-step-bpm')).toHaveValue('1')
  await expect(page.locator('#tempo-training-rounds-per-step')).toHaveValue('2')
  await enabled.check()
  await page.locator('#tempo-training-target-bpm').fill(String(options.targetBpm))
  await page.locator('#tempo-training-step-bpm').fill(String(options.stepBpm))
  await page.locator('#tempo-training-rounds-per-step').fill(String(options.roundsPerStep))
  await expect(page.getByRole('status').filter({ hasText: 'Increase by' }))
    .toContainText(`Increase by ${options.stepBpm} BPM every ${options.roundsPerStep} full`)
}

async function setRangeValue(page: Page, selector: string, target: number): Promise<void> {
  const range = page.locator(selector)
  await range.focus()
  const current = Number(await range.inputValue())
  const key = target > current ? 'ArrowRight' : 'ArrowLeft'
  for (let step = 0; step < Math.abs(target - current); step += 1) {
    await page.keyboard.press(key)
  }
  await expect(range).toHaveValue(String(target))
}

async function waitForAnswerCycle(page: Page, lowerProgress: number, upperProgress: number): Promise<number> {
  const timeline = page.locator('.timeline-scroll')
  const progress = page.getByRole('progressbar', { name: 'Preview progress' })
  let observedProgress = 0
  await expect.poll(async () => {
    const slotKind = await timeline.getAttribute('data-cycle-slot-kind')
    observedProgress = Number(await progress.getAttribute('value'))
    return slotKind === 'silence' && observedProgress >= lowerProgress && observedProgress < upperProgress
  }, { timeout: 10_000, intervals: [20, 30, 50] }).toBe(true)
  return observedProgress
}

async function readAudioClock(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__tempoTrainingQa
    const context = qa?.buffers.at(-1)?.node.context ?? qa?.oscillators.at(-1)?.node.context
    if (!context) throw new Error('No active AudioContext was found.')
    return context.currentTime
  })
}

async function preparePractice(
  page: Page,
  options: { mode: 'Loop' | 'Q&A'; countInBars: '0' | '1'; metronomeLevel: number; largePause?: boolean },
): Promise<void> {
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('radio', { name: options.mode, exact: true }).check()
  if (options.mode === 'Q&A') {
    const largePause = page.getByRole('checkbox', { name: /Large pause/ })
    if (options.largePause) await largePause.check()
    else await largePause.uncheck()
  }
  await page.locator('#count-in-bars').selectOption(options.countInBars)
  await page.locator('#metronome-enabled').check()
  await setRangeValue(page, '#metronome-volume', options.metronomeLevel)
}

async function clickGain(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const qa = window.__tempoTrainingQa
    const oscillator = qa?.oscillators.at(-1)?.node
    if (!qa || !oscillator) return null
    const pending: AudioNode[] = [oscillator]
    const visited = new Set<AudioNode>()
    const gains: GainNode[] = []
    while (pending.length > 0) {
      const source = pending.shift()!
      if (visited.has(source)) continue
      visited.add(source)
      for (const edge of qa.connections) {
        if (edge.source !== source || visited.has(edge.destination)) continue
        if (edge.destination instanceof GainNode) gains.push(edge.destination)
        pending.push(edge.destination)
      }
    }
    return gains.at(-1)?.gain.value ?? null
  })
}

async function expectLocalReadOnlyTraffic(page: Page, requests: Array<{ url: string; method: string }>): Promise<void> {
  const appOrigin = new URL(page.url()).origin
  for (const request of requests) {
    expect(new URL(request.url).origin, 'the journey should stay on the local app origin').toBe(appOrigin)
    expect(['GET', 'HEAD'], 'the journey should not send mutating requests').toContain(request.method)
  }
}

function browserLabel(): string {
  return (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

function resultPath(...parts: string[]): string {
  return path.resolve(process.cwd(), '.forge', 'tempo-training-qa-results', ...parts)
}

test('Loop tempo training steps on full rounds, clamps at target, and keeps the trimmed beat and metronome continuous', async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  await installWebAudioInstrumentation(page)
  await loadPracticeFixture(page, 'loop')
  await configureTrimmedBeatAndTraining(page, { targetBpm: 170, stepBpm: 5, roundsPerStep: 1 })
  await preparePractice(page, { mode: 'Loop', countInBars: '0', metronomeLevel: 42 })

  const status = page.locator('#tempo-training-status')
  const play = page.getByRole('button', { name: 'Play sequence', exact: true })
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const initialStatusIndex = await page.evaluate(() => window.__tempoTrainingQa?.statusEvents.length ?? 0)
  await play.click()
  await expect(status).toContainText('160 of 170 BPM', { timeout: 10_000 })
  await expect(status).toContainText('165 of 170 BPM', { timeout: 10_000 })
  await expect(status).toContainText('holding at 170 BPM', { timeout: 10_000 })

  const firstBoundary = await page.evaluate(({ startIndex, estimatedDelaySeconds }) => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const beat = qa.buffers.find(({ loop, buffer }) => loop && buffer?.duration >= 9)
    const step = qa.statusEvents.slice(startIndex).find(({ text }) => /Tempo training · 165 of 170 BPM/.test(text))
    if (!beat || !step || step.audioTime === null) throw new Error('The first audible tempo step boundary was not recorded.')
    const expectedScheduleBoundary = beat.when + (4 * 60 / 160)
    const expectedPresentationBoundary = expectedScheduleBoundary + estimatedDelaySeconds
    return {
      beatStart: beat.when,
      beatOffset: beat.offset,
      beatLoopStart: beat.loopStart,
      beatLoopEnd: beat.loopEnd,
      expectedScheduleBoundary,
      expectedPresentationBoundary,
      statusObservedAtAudioContextTime: step.audioTime,
      statusArrivalAfterScheduleBoundarySeconds: step.audioTime - expectedScheduleBoundary,
      statusArrivalAfterPresentationEstimateSeconds: step.audioTime - expectedPresentationBoundary,
      status: step.text,
    }
  }, { startIndex: initialStatusIndex, estimatedDelaySeconds: estimatedProcessorDelaySeconds })
  expect(firstBoundary.beatOffset).toBe(cueSeconds)
  expect(firstBoundary.beatLoopStart).toBe(cueSeconds)
  expect(firstBoundary.beatLoopEnd).toBe(loopEndSeconds)
  expect(firstBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeGreaterThanOrEqual(-0.02)
  expect(firstBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeLessThan(0.6)

  const volume = page.locator('#metronome-volume')
  await expect(volume).toBeEnabled()
  await setRangeValue(page, '#metronome-volume', 37)
  await expect(page.locator('#metronome-volume-value')).toHaveText('37%')
  await expect.poll(() => clickGain(page)).toBeCloseTo(0.37, 2)

  const holdObservedAt = await page.evaluate((startIndex) => {
    const event = window.__tempoTrainingQa?.statusEvents.slice(startIndex)
      .find(({ text }) => text.includes('holding at 170 BPM'))
    if (event?.audioTime === null || event?.audioTime === undefined) {
      throw new Error('The target hold was not recorded against the AudioContext clock.')
    }
    return event.audioTime
  }, initialStatusIndex)
  await page.waitForFunction((goalTime) => {
    const qa = window.__tempoTrainingQa
    const context = qa?.buffers.at(-1)?.node.context ?? qa?.oscillators.at(-1)?.node.context
    return Boolean(context && context.currentTime >= goalTime + (2 * 4 * 60 / 170))
  }, holdObservedAt, { timeout: 15_000 })
  await expect(status).toContainText('holding at 170 BPM')
  const heldEvidence = await page.evaluate(() => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const beatStarts = qa.buffers.filter(({ loop, buffer }) => loop && buffer?.duration >= 9)
    const beat = beatStarts[0]
    if (!beat?.buffer) throw new Error('The trimmed custom beat did not start.')
    const intervals = qa.oscillators.slice(1).map((entry, index) => entry.when - qa.oscillators[index]!.when)
    const bpmValues = qa.statusEvents.flatMap(({ text }) => {
      const match = /Tempo training · ([\d.]+) of ([\d.]+) BPM/.exec(text)
        ?? /Tempo training · holding at ([\d.]+) BPM/.exec(text)
      return match ? [Number(match[1])] : []
    })
    return {
      beatStarts: beatStarts.length,
      beatWasStopped: qa.bufferStops.some(({ node }) => node === beat.node),
      offset: beat.offset,
      loopStart: beat.loopStart,
      loopEnd: beat.loopEnd,
      bpmValues,
      maximumDisplayedBpm: Math.max(...bpmValues),
      metronomeIntervals: intervals,
      statusEvents: qa.statusEvents.map(({ text }) => text),
    }
  })
  expect(heldEvidence.beatStarts).toBe(1)
  expect(heldEvidence.beatWasStopped).toBe(false)
  expect(heldEvidence.offset).toBe(cueSeconds)
  expect(heldEvidence.loopStart).toBe(cueSeconds)
  expect(heldEvidence.loopEnd).toBe(loopEndSeconds)
  expect(heldEvidence.maximumDisplayedBpm).toBe(170)
  expect(Math.max(...heldEvidence.metronomeIntervals)).toBeLessThan(0.5)
  for (const interval of heldEvidence.metronomeIntervals.slice(-5)) {
    expect(interval).toBeCloseTo(60 / 170, 1)
  }
  await expect.poll(() => clickGain(page)).toBeCloseTo(0.37, 2)

  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
  const beforeReplayStatusIndex = await page.evaluate(() => window.__tempoTrainingQa?.statusEvents.length ?? 0)
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'BPM', exact: true }).fill(String(startBpm))
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await play.click()
  await expect(status).toContainText('160 of 170 BPM')
  await expect(status).toContainText('165 of 170 BPM', { timeout: 10_000 })
  const replayEvidence = await page.evaluate((startIndex) => {
    const events = window.__tempoTrainingQa?.statusEvents.slice(startIndex) ?? []
    const countIns = events.filter(({ text }) => text.includes('Count-in'))
    const firstStep = events.find(({ text }) => /Tempo training · 165 of 170 BPM/.test(text))
    return { countIns: countIns.map(({ text }) => text), firstStep: firstStep?.text ?? '' }
  }, beforeReplayStatusIndex)
  expect(replayEvidence.countIns).toEqual([])
  expect(replayEvidence.firstStep).toContain('165 of 170 BPM')
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')

  await expectLocalReadOnlyTraffic(page, requests)
  const browser = browserLabel()
  const browserResults = resultPath(browser)
  mkdirSync(browserResults, { recursive: true })
  writeFileSync(path.join(browserResults, 'loop-audio-timing.json'), JSON.stringify({
    browser,
    startBpm,
    targetBpm: 170,
    stepBpm: 5,
    roundsPerStep: 1,
    audioTransportSnapshotPollIntervalMs: 25,
    estimatedProcessorDelaySeconds,
    fixtureCycleSecondsAtStart: 4 * 60 / startBpm,
    firstBoundary,
    heldEvidence,
    replayEvidence,
  }, null, 2))
})

async function openSaveManager(page: Page): Promise<void> {
  const manager = page.locator('details').filter({ hasText: 'Save and manage sessions' }).first()
  if (!(await manager.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await manager.locator('summary').click()
  }
}

async function readOrRemoveTempoTrainingFromSavedSession(page: Page, remove: boolean): Promise<unknown> {
  return page.evaluate(async (shouldRemove) => {
    const request = indexedDB.open('scratch-combo-sessions-v1', 1)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction('payloads', shouldRemove ? 'readwrite' : 'readonly')
        const store = transaction.objectStore('payloads')
        const all = store.getAll()
        all.onsuccess = () => {
          const records = all.result as Array<{ kind: string; snapshot?: Record<string, unknown> }>
          const sessions = records.filter((record) => record.kind === 'session' && record.snapshot)
          if (sessions.length !== 1 || !sessions[0]?.snapshot) {
            reject(new Error(`Expected one saved session payload, found ${sessions.length}.`))
            transaction.abort()
            return
          }
          const snapshot = sessions[0].snapshot
          const settings = snapshot.tempoTraining
          if (shouldRemove) {
            delete snapshot.tempoTraining
            store.put(sessions[0])
          }
          transaction.oncomplete = () => resolve(settings)
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error ?? new Error('Saved-session update was aborted.'))
        }
        all.onerror = () => reject(all.error)
      })
    } finally {
      database.close()
    }
  }, remove)
}

async function captureTrainerScreenshots(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true')
  const trainer = page.locator('#tempo-training')
  await openDetails(trainer)
  const target = page.locator('#tempo-training-target-bpm')
  const browser = browserLabel()
  const screenshotDirectory = path.resolve(process.cwd(), 'test-results', 'screenshots', 'tempo-training')
  mkdirSync(screenshotDirectory, { recursive: true })
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.style.scrollBehavior = 'auto'
    })
    await trainer.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await target.evaluate((element) => (element as HTMLInputElement).focus({ preventScroll: true }))
    await expect(target).toBeFocused()
    const geometry = await trainer.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(-1)
    expect(geometry.top).toBeGreaterThanOrEqual(-1)
    expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height + 1)
    expect(geometry.width).toBeGreaterThan(0)
    expect(geometry.height).toBeGreaterThan(0)
    expect(geometry.pageWidth).toBeLessThanOrEqual(viewport.width + 1)
    await expect(page.locator('#tempo-training-enabled')).toBeChecked()
    await expect(page.locator('#tempo-training-step-bpm')).toBeInViewport()
    await expect(page.locator('#tempo-training-rounds-per-step')).toBeInViewport()
    await page.screenshot({
      path: path.join(screenshotDirectory, `tempo-trainer-${browser}-${viewport.name}.png`),
      fullPage: false,
    })
  }
}

test('Q&A training waits through all three large-pause cycles, cancels on manual BPM, and round-trips safely', async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  await installWebAudioInstrumentation(page)
  await loadPracticeFixture(page, 'qa')
  await configureTrimmedBeatAndTraining(page, { targetBpm: 164, stepBpm: 2, roundsPerStep: 1 })

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await openSaveManager(page)
  await page.getByRole('textbox', { name: 'Session name' }).fill('QA Tempo Training Settings')
  await page.getByRole('button', { name: 'Save as new session', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Session' })).toContainText('QA Tempo Training Settings')
  const persisted = await readOrRemoveTempoTrainingFromSavedSession(page, false)
  expect(persisted).toEqual({ enabled: true, targetBpm: 164, stepBpm: 2, roundsPerStep: 1 })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reload last saved', exact: true }).click()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const trainer = page.locator('#tempo-training')
  await openDetails(trainer)
  await expect(page.locator('#tempo-training-enabled')).toBeChecked()
  await expect(page.locator('#tempo-training-target-bpm')).toHaveValue('164')
  await expect(page.locator('#tempo-training-step-bpm')).toHaveValue('2')
  await expect(page.locator('#tempo-training-rounds-per-step')).toHaveValue('1')
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat', exact: true }))
    .toHaveValue(String(beatReferenceBpm))

  const bpm = page.getByRole('spinbutton', { name: 'BPM', exact: true })
  const recordedBpm = page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat', exact: true })
  await recordedBpm.fill('60')
  await bpm.fill('120')
  await page.locator('#tempo-training-target-bpm').fill('170')
  await expect(page.locator('#tempo-training-target-bpm')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#tempo-training-message'))
    .toContainText('Target BPM must stay within the selected sources’ shared 60–120 BPM range.')
  await expect(bpm).toHaveValue('120')

  await recordedBpm.fill(String(beatReferenceBpm))
  await bpm.fill(String(startBpm))
  await page.locator('#tempo-training-target-bpm').fill('164')
  await expect(page.locator('#tempo-training-message')).toContainText('Increase by 2 BPM every 1 full round')
  await captureTrainerScreenshots(page)

  await preparePractice(page, { mode: 'Q&A', countInBars: '1', metronomeLevel: 46, largePause: true })
  const status = page.locator('#tempo-training-status')
  const play = page.getByRole('button', { name: 'Play sequence', exact: true })
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const firstRunStatusIndex = await page.evaluate(() => window.__tempoTrainingQa?.statusEvents.length ?? 0)
  await play.click()
  await expect(status).toContainText('Count-in · beat 1 of 4.', { timeout: 10_000 })
  await expect(status).toContainText('160 of 164 BPM', { timeout: 10_000 })
  await expect(status).toContainText('starting tempo')
  await expect(page.locator('.timeline-scroll')).toHaveAttribute('data-cycle-slot-kind', 'fixture')
  const answerProgress: number[] = []
  for (const range of [[0.28, 0.48], [0.53, 0.73], [0.78, 0.98]] as const) {
    answerProgress.push(await waitForAnswerCycle(page, range[0], range[1]))
    await expect(status).toContainText('160 of 164 BPM')
    await expect(status).toContainText('starting tempo')
  }
  await expect(status).toContainText('162 of 164 BPM', { timeout: 10_000 })
  const firstRoundBoundary = await page.evaluate(({ startIndex, answerProgress, estimatedDelaySeconds }) => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const beat = qa.buffers.find(({ loop, buffer }) => loop && buffer?.duration >= 9)
    const step = qa.statusEvents.slice(startIndex).find(({ text }) => /Tempo training · 162 of 164 BPM/.test(text))
    if (!beat || !step || step.audioTime === null) throw new Error('The first Q&A round step was not recorded.')
    const expectedScheduleBoundary = beat.when + 4 * (4 * 60 / 160)
    const expectedPresentationBoundary = expectedScheduleBoundary + estimatedDelaySeconds
    return {
      beatStart: beat.when,
      expectedScheduleBoundary,
      expectedPresentationBoundary,
      statusObservedAtAudioContextTime: step.audioTime,
      statusArrivalAfterScheduleBoundarySeconds: step.audioTime - expectedScheduleBoundary,
      statusArrivalAfterPresentationEstimateSeconds: step.audioTime - expectedPresentationBoundary,
      answerProgress,
      status: step.text,
    }
  }, { startIndex: firstRunStatusIndex, answerProgress, estimatedDelaySeconds: estimatedProcessorDelaySeconds })
  expect(firstRoundBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeGreaterThanOrEqual(-0.02)
  expect(firstRoundBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeLessThan(0.6)

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await bpm.fill('163')
  await expect(status).toContainText('Tempo training stopped at 163 BPM. Press Play to restart from this tempo.')
  const manualOverrideClock = await readAudioClock(page)
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.waitForFunction((startTime) => {
    const qa = window.__tempoTrainingQa
    const context = qa?.buffers.at(-1)?.node.context ?? qa?.oscillators.at(-1)?.node.context
    const text = document.querySelector('#tempo-training-status')?.textContent ?? ''
    return Boolean(context && context.currentTime >= startTime + (16 * 60 / 163)
      && text.includes('Tempo training stopped at 163 BPM. Press Play to restart from this tempo.'))
  }, manualOverrideClock, { timeout: 12_000 })

  const afterManualOverride = await page.evaluate((startIndex) => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const runEvents = qa.statusEvents.slice(startIndex)
    const beatStarts = qa.buffers.filter(({ loop, buffer }) => loop && buffer?.duration >= 9)
    const countIns = runEvents.filter(({ text }) => text.includes('Count-in')).map(({ text }) => text)
    return {
      beatStarts: beatStarts.length,
      countIns,
      statusEvents: runEvents.map(({ text }) => text),
    }
  }, firstRunStatusIndex)
  expect(afterManualOverride.beatStarts).toBe(1)
  expect(afterManualOverride.countIns).toHaveLength(4)
  expect(afterManualOverride.countIns.at(-1)).toContain('beat 4 of 4')

  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
  const replayStatusIndex = await page.evaluate(() => window.__tempoTrainingQa?.statusEvents.length ?? 0)
  await play.click()
  await expect(status).toContainText('Count-in · beat 1 of 4.', { timeout: 10_000 })
  await expect(status).toContainText('163 of 164 BPM')
  await expect(status).toContainText('starting tempo')
  await expect(status).toContainText('holding at 164 BPM', { timeout: 12_000 })
  const replayBoundary = await page.evaluate(({ startIndex, estimatedDelaySeconds }) => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const beat = [...qa.buffers].reverse().find(({ loop, buffer }) => loop && buffer?.duration >= 9)
    const step = qa.statusEvents.slice(startIndex).find(({ text }) => text.includes('holding at 164 BPM'))
    if (!beat || !step || step.audioTime === null) throw new Error('The rearmed Q&A step was not recorded.')
    const expectedScheduleBoundary = beat.when + (16 * 60 / 163)
    const expectedPresentationBoundary = expectedScheduleBoundary + estimatedDelaySeconds
    return {
      beatStart: beat.when,
      startBpm: 163,
      targetBpm: 164,
      expectedScheduleBoundary,
      expectedPresentationBoundary,
      statusObservedAtAudioContextTime: step.audioTime,
      statusArrivalAfterScheduleBoundarySeconds: step.audioTime - expectedScheduleBoundary,
      statusArrivalAfterPresentationEstimateSeconds: step.audioTime - expectedPresentationBoundary,
      status: step.text,
    }
  }, { startIndex: replayStatusIndex, estimatedDelaySeconds: estimatedProcessorDelaySeconds })
  expect(replayBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeGreaterThanOrEqual(-0.02)
  expect(replayBoundary.statusArrivalAfterScheduleBoundarySeconds).toBeLessThan(0.6)
  const goalHeldAt = await readAudioClock(page)
  await page.waitForFunction((goalTime) => {
    const qa = window.__tempoTrainingQa
    const context = qa?.buffers.at(-1)?.node.context ?? qa?.oscillators.at(-1)?.node.context
    const text = document.querySelector('#tempo-training-status')?.textContent ?? ''
    return Boolean(context && context.currentTime >= goalTime + (16 * 60 / 164) && text.includes('holding at 164 BPM'))
  }, goalHeldAt, { timeout: 12_000 })
  const replayEvidence = await page.evaluate((startIndex) => {
    const qa = window.__tempoTrainingQa
    if (!qa) throw new Error('Web Audio QA instrumentation was missing.')
    const events = qa.statusEvents.slice(startIndex)
    const countIns = events.filter(({ text }) => text.includes('Count-in')).map(({ text }) => text)
    const bpmValues = events.flatMap(({ text }) => {
      const match = /Tempo training · ([\d.]+) of ([\d.]+) BPM/.exec(text)
        ?? /Tempo training · holding at ([\d.]+) BPM/.exec(text)
      return match ? [Number(match[1])] : []
    })
    return { countIns, maximumDisplayedBpm: Math.max(...bpmValues), statusEvents: events.map(({ text }) => text) }
  }, replayStatusIndex)
  expect(replayEvidence.countIns).toHaveLength(4)
  expect(replayEvidence.countIns.at(-1)).toContain('beat 4 of 4')
  expect(replayEvidence.maximumDisplayedBpm).toBe(164)
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')

  const removed = await readOrRemoveTempoTrainingFromSavedSession(page, true)
  expect(removed).toEqual({ enabled: true, targetBpm: 164, stepBpm: 2, roundsPerStep: 1 })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reload last saved', exact: true }).click()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await openDetails(page.locator('#tempo-training'))
  await expect(page.locator('#tempo-training-enabled')).not.toBeChecked()
  await expect(page.locator('#tempo-training-target-bpm')).toHaveValue('100')
  await expect(page.locator('#tempo-training-step-bpm')).toHaveValue('1')
  await expect(page.locator('#tempo-training-rounds-per-step')).toHaveValue('2')

  await expectLocalReadOnlyTraffic(page, requests)
  const browser = browserLabel()
  const browserResults = resultPath(browser)
  mkdirSync(browserResults, { recursive: true })
  writeFileSync(path.join(browserResults, 'qa-round-evidence.json'), JSON.stringify({
    browser,
    startBpm,
    targetBpm: 164,
    stepBpm: 2,
    roundsPerStep: 1,
    largePauseSilentCycles: 3,
    estimatedProcessorDelaySeconds,
    audioTransportSnapshotPollIntervalMs: 25,
    firstRoundBoundary,
    replayBoundary,
    manualTempoBpm: 163,
    rearmedFromManualTempo: 163,
    rearmedTargetHeldAt: 164,
    firstRun: afterManualOverride,
    replayEvidence,
    persisted,
    removed,
    traffic: requests,
  }, null, 2))
})
