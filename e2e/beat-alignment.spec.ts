import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

declare global {
  interface Window {
    __beatAlignmentQa?: {
      resumeCount: number
      starts: Array<{
        node: AudioBufferSourceNode
        loop: boolean
        when: number | undefined
        offset: number | undefined
        durationArgument: number | undefined
        loopStart: number
        loopEnd: number
        buffer: AudioBuffer | null
        sampleRate: number
        frameLength: number
        channels: number
        samplesAtStart: number[]
      }>
      stops: AudioBufferSourceNode[]
      connections: Array<{ source: AudioNode; destination: AudioNode }>
      worklets: Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>
      decodedBuffers: Array<{ buffer: AudioBuffer; samplesAtDecode: number[] }>
    }
  }
}

test.describe.configure({ timeout: 180_000 })

const beatBpm = 120
const beatCueSeconds = 1
const beatLoopEndSeconds = 3
const beatDurationSeconds = 10
const customBeatName = 'BeatAlignment-IntroLoop.wav'

function makeIntroLoopWav(): Buffer {
  const sampleRate = 44_100
  const sampleCount = Math.round(sampleRate * beatDurationSeconds)
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

  const introEnd = beatCueSeconds
  const loopContentEnd = beatDurationSeconds - 1
  const beatSeconds = 60 / beatBpm
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate
    let sample: number
    if (time < introEnd) {
      // The lead-in has its own sustained tone and no beat pulses.
      sample = 0.24 * Math.sin(2 * Math.PI * 330 * time)
    } else if (time < loopContentEnd) {
      const beatOffset = (time - introEnd) % beatSeconds
      const pulse = beatOffset < 0.08 ? Math.exp(-beatOffset * 38) : 0
      sample = 0.07 * Math.sin(2 * Math.PI * 220 * (time - introEnd))
        + pulse * (
          0.24 * Math.sin(2 * Math.PI * 220 * beatOffset)
          + 0.05 * Math.sin(2 * Math.PI * 1_100 * beatOffset)
        )
    } else {
      // The untrimmed tail has a different tone from the looped body.
      sample = 0.24 * Math.sin(2 * Math.PI * 660 * (time - loopContentEnd))
    }
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2)
  }
  return wav
}

async function instrumentWebAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      resumeCount: 0,
      starts: [] as Array<{
        node: AudioBufferSourceNode
        loop: boolean
        when: number | undefined
        offset: number | undefined
        durationArgument: number | undefined
        loopStart: number
        loopEnd: number
        buffer: AudioBuffer | null
        sampleRate: number
        frameLength: number
        channels: number
        samplesAtStart: number[]
      }>,
      stops: [] as AudioBufferSourceNode[],
      connections: [] as Array<{ source: AudioNode; destination: AudioNode }>,
      worklets: [] as Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>,
      decodedBuffers: [] as Array<{ buffer: AudioBuffer; samplesAtDecode: number[] }>,
    }
    window.__beatAlignmentQa = qa

    const originalResume = AudioContext.prototype.resume
    AudioContext.prototype.resume = function () {
      qa.resumeCount += 1
      return originalResume.call(this)
    }

    const originalDecode = AudioContext.prototype.decodeAudioData
    AudioContext.prototype.decodeAudioData = function (data: ArrayBuffer, success?: DecodeSuccessCallback, error?: DecodeErrorCallback) {
      const decoded = originalDecode.call(this, data, success, error)
      void decoded.then((buffer) => {
        if (buffer.duration >= 9) {
          qa.decodedBuffers.push({ buffer, samplesAtDecode: Array.from(buffer.getChannelData(0)) })
        }
      })
      return decoded
    }

    const originalConnect = AudioNode.prototype.connect as unknown as (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ) => AudioNode
    AudioNode.prototype.connect = function (destination: AudioNode, output?: number, input?: number) {
      qa.connections.push({ source: this, destination })
      const result = originalConnect.call(this, destination, output, input)
      if (this instanceof AudioWorkletNode && destination === this.context.destination
        && !qa.worklets.some(({ node }) => node === this)) {
        const analyser = this.context.createAnalyser()
        analyser.fftSize = 8_192
        const mutedMonitor = this.context.createGain()
        mutedMonitor.gain.value = 0
        originalConnect.call(this, analyser)
        originalConnect.call(analyser, mutedMonitor)
        originalConnect.call(mutedMonitor, this.context.destination)
        qa.worklets.push({ node: this, analyser })
      }
      return result
    } as typeof AudioNode.prototype.connect

    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      const buffer = this.buffer
      qa.starts.push({
        node: this,
        loop: this.loop,
        when,
        offset,
        durationArgument: duration,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
        buffer,
        sampleRate: buffer?.sampleRate ?? 0,
        frameLength: buffer?.length ?? 0,
        channels: buffer?.numberOfChannels ?? 0,
        samplesAtStart: this.loop && buffer ? Array.from(buffer.getChannelData(0)) : [],
      })
      return originalStart.call(this, when, offset, duration)
    }

    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (this.loop) qa.stops.push(this)
      return originalStop.call(this, when)
    }
  })
}

async function openManualTrim(page: Page): Promise<void> {
  const disclosure = page.getByText('Manual beat trim', { exact: true })
  await expect(disclosure).toBeVisible()
  const open = await disclosure.evaluate((element) => Boolean(element.closest('details')?.open))
  if (!open) await disclosure.click()
  await expect(page.getByRole('spinbutton', { name: 'First downbeat / loop start (seconds)', exact: true })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Loop end (seconds)', exact: true })).toBeVisible()
}

async function setTrim(page: Page, start: string, end: string): Promise<void> {
  const startInput = page.getByRole('spinbutton', { name: 'First downbeat / loop start (seconds)', exact: true })
  const endInput = page.getByRole('spinbutton', { name: 'Loop end (seconds)', exact: true })
  await startInput.fill(start)
  await endInput.fill(end)
  await expect(page.getByRole('button', { name: 'Apply beat trim', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Apply beat trim', exact: true }).click()
  await expect(startInput).toHaveValue(start)
  await expect(endInput).toHaveValue(end)
}

async function warmSelectedPresetBeat(page: Page): Promise<void> {
  const sourceCountBefore = await page.evaluate(() => window.__beatAlignmentQa?.starts.filter(({ loop }) => loop).length ?? 0)
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.starts.filter(({ loop }) => loop).length ?? 0))
    .toBe(sourceCountBefore + 1)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
}

async function activeCustomBeatSource(page: Page): Promise<{
  when: number | undefined
  offset: number | undefined
  loop: boolean
  loopStart: number
  loopEnd: number
  sampleRate: number
  frameLength: number
  channels: number
  storedSampleCount: number
  changedSampleCount: number
}> {
  return page.evaluate(() => {
    const qa = window.__beatAlignmentQa
    if (!qa) throw new Error('Web Audio QA instrumentation was not installed.')
    const entry = [...qa.starts].reverse().find(({ loop, buffer }) => loop && buffer && buffer.duration >= 9)
    if (!entry?.buffer) throw new Error('The uploaded beat did not reach a looping native AudioBufferSourceNode.')
    const decoded = qa.decodedBuffers.find(({ buffer }) => buffer === entry.buffer)
    if (!decoded) throw new Error('The uploaded beat PCM snapshot was not recorded when it decoded.')
    const currentSamples = entry.buffer.getChannelData(0)
    let changedSampleCount = 0
    let changedSinceDecodeCount = 0
    for (let index = 0; index < currentSamples.length; index += 1) {
      if (!Object.is(currentSamples[index], entry.samplesAtStart[index])) changedSampleCount += 1
      if (!Object.is(currentSamples[index], decoded.samplesAtDecode[index])) changedSinceDecodeCount += 1
    }
    return {
      when: entry.when,
      offset: entry.offset,
      loop: entry.loop,
      loopStart: entry.loopStart,
      loopEnd: entry.loopEnd,
      sampleRate: entry.sampleRate,
      frameLength: entry.frameLength,
      channels: entry.channels,
      storedSampleCount: entry.samplesAtStart.length,
      changedSampleCount,
      changedSinceDecodeCount,
    }
  })
}

async function activeBeatLoopCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__beatAlignmentQa
    if (!qa) return 0
    return qa.starts.filter(({ node, loop }) => loop && !qa.stops.includes(node)).length
  })
}

async function beatOutputRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__beatAlignmentQa
    if (!qa) return 0
    const source = [...qa.starts].reverse().find(({ loop, buffer }) => loop && buffer && buffer.duration >= 9)?.node
    const gain = qa.connections.find((connection) => connection.source === source)?.destination
    const processor = qa.connections.find((connection) => connection.source === gain
      && connection.destination instanceof AudioWorkletNode)?.destination as AudioWorkletNode | undefined
    const analyser = qa.worklets.find((entry) => entry.node === processor)?.analyser
    if (!analyser) return 0
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    const sum = samples.reduce((total, sample) => total + sample * sample, 0)
    return Math.sqrt(sum / samples.length)
  })
}

async function removeNewTrimFieldsFromSavedSession(page: Page): Promise<void> {
  const result = await page.evaluate(async (beatName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('scratch-combo-sessions-v1', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<{ removed: string[] }>((resolve, reject) => {
        const transaction = database.transaction('payloads', 'readwrite')
        const store = transaction.objectStore('payloads')
        let removed: string[] = []
        const request = store.getAll()
        request.onsuccess = () => {
          const payload = (request.result as Array<{ id: string; kind: string; snapshot?: Record<string, unknown> }>)
            .find((entry) => entry.kind === 'session'
              && (entry.snapshot?.customBeatFile as { name?: string } | undefined)?.name === beatName)
          if (!payload?.snapshot) {
            reject(new Error('The named session payload for the uploaded beat was not found.'))
            transaction.abort()
            return
          }
          removed = ['presetBeatTrimId', 'customBeatTrimId', 'beatTrims']
            .filter((field) => field in payload.snapshot!)
          delete payload.snapshot.presetBeatTrimId
          delete payload.snapshot.beatTrims
          delete payload.snapshot.customBeatTrimId
          store.put(payload)
        }
        request.onerror = () => reject(request.error)
        transaction.oncomplete = () => resolve({ removed })
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error ?? new Error('Legacy-session fixture update was aborted.'))
      })
    } finally {
      database.close()
    }
  }, customBeatName)
  expect(result.removed).toEqual(['presetBeatTrimId', 'customBeatTrimId', 'beatTrims'])
}

async function expectNoOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const geometry = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(Math.max(geometry.document, geometry.body), `manual trim layout overflows at ${width}px`)
    .toBeLessThanOrEqual(width)
}

function proofImagePath(browser: string, viewport: 'desktop' | 'mobile'): string {
  return path.resolve(process.cwd(), 'docs/images/beat-alignment', `manual-cue-loop-trim-${browser}-${viewport}.png`)
}

function browserLabel(): string {
  return (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

test('manual beat cue and loop trim survive selection and saved-session restore, then reach continuous native playback', async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  await instrumentWebAudio(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Quick preset')).toHaveValue('SSC-085BPM-01')

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeChecked()
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await page.getByLabel('Upload custom beat').setInputFiles({
    name: customBeatName,
    mimeType: 'audio/wav',
    buffer: makeIntroLoopWav(),
  })
  const analysis = page.locator('.session-controls__analysis')
  await expect(analysis).toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 })
  await page.getByRole('spinbutton', { name: 'Custom beat BPM', exact: true }).fill(String(beatBpm))
  await page.getByRole('button', { name: 'Use custom beat', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(beatBpm))

  const trimDisclosure = page.getByText('Manual beat trim', { exact: true })
  await expect(trimDisclosure).toBeVisible()
  await expect.poll(() => trimDisclosure.evaluate((element) => Boolean(element.closest('details')?.open))).toBe(false)
  await openManualTrim(page)

  const startInput = page.getByRole('spinbutton', { name: 'First downbeat / loop start (seconds)', exact: true })
  const endInput = page.getByRole('spinbutton', { name: 'Loop end (seconds)', exact: true })
  const applyTrim = page.getByRole('button', { name: 'Apply beat trim', exact: true })
  await startInput.fill('-0.25')
  await expect(startInput).toHaveAttribute('aria-invalid', 'true')
  const trimPanel = page.locator('.session-controls__beat-trim')
  await expect(trimPanel.getByRole('alert')).toBeVisible()
  await expect(applyTrim).toBeDisabled()
  await startInput.fill(String(beatCueSeconds))
  await endInput.fill('0.5')
  await expect(endInput).toHaveAttribute('aria-invalid', 'true')
  await expect(trimPanel.getByRole('alert')).toBeVisible()
  await expect(applyTrim).toBeDisabled()

  await setTrim(page, String(beatCueSeconds), String(beatLoopEndSeconds))
  await expect(trimPanel.getByRole('alert')).toHaveCount(0)
  await expect(trimPanel.locator('.session-controls__trim-status'))
    .toContainText('Applied: cue 1.000s · loop end 3.000s.')

  // Each built-in bed keeps a distinct cue; switching back to the uploaded beat retains its cue too.
  await page.getByRole('radio', { name: 'Preset', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeChecked()
  const beatBed = page.getByLabel('Beat bed')
  await expect(beatBed).toBeEnabled()
  const firstPresetBeat = page.getByRole('option', { name: /^Beat 01 ·/ })
  const secondPresetBeat = page.getByRole('option', { name: /^Beat 02 ·/ })
  await expect(firstPresetBeat).toBeEnabled()
  await expect(secondPresetBeat).toBeEnabled()
  const firstPresetBeatValue = await firstPresetBeat.getAttribute('value')
  const secondPresetBeatValue = await secondPresetBeat.getAttribute('value')
  expect(firstPresetBeatValue).not.toBeNull()
  expect(secondPresetBeatValue).not.toBeNull()
  await beatBed.selectOption(firstPresetBeatValue!, { timeout: 15_000 })
  await expect(beatBed).toHaveValue(firstPresetBeatValue!)
  await warmSelectedPresetBeat(page)
  await openManualTrim(page)
  await setTrim(page, '0.25', '0.75')
  await beatBed.selectOption(secondPresetBeatValue!, { timeout: 15_000 })
  await expect(beatBed).toHaveValue(secondPresetBeatValue!)
  await warmSelectedPresetBeat(page)
  await openManualTrim(page)
  await setTrim(page, '0.5', '1.25')
  await beatBed.selectOption(firstPresetBeatValue!, { timeout: 15_000 })
  await expect(startInput).toHaveValue('0.25')
  await expect(endInput).toHaveValue('0.75')
  await beatBed.selectOption(secondPresetBeatValue!, { timeout: 15_000 })
  await expect(startInput).toHaveValue('0.5')
  await expect(endInput).toHaveValue('1.25')
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await expect(startInput).toHaveValue(String(beatCueSeconds))
  await expect(endInput).toHaveValue(String(beatLoopEndSeconds))
  await expect(trimPanel.locator('.session-controls__trim-status'))
    .toContainText('Applied: cue 1.000s · loop end 3.000s.')

  // Reset returns the selection to a full clip; then reapply the saved region for the restore journey.
  await page.getByRole('button', { name: 'Reset beat trim', exact: true }).click()
  await expect(startInput).toHaveValue('0')
  await expect(endInput).toHaveValue('')
  await expect(trimPanel.locator('.session-controls__trim-status')).toHaveText('Full clip — no manual trim applied.')
  await setTrim(page, String(beatCueSeconds), String(beatLoopEndSeconds))

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  const saveManager = page.locator('details').filter({ hasText: 'Save and manage sessions' }).first()
  if (!(await saveManager.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await page.getByText('Save and manage sessions', { exact: true }).click()
  }
  await page.getByRole('textbox', { name: 'Session name' }).fill('Beat trim QA')
  await page.getByRole('button', { name: 'Save as new session' }).click()
  await expect(page.getByRole('combobox', { name: 'Session' })).toContainText('Beat trim QA')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reload last saved' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reload last saved' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.resumeCount ?? -1)).toBe(0)
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.starts.length ?? -1)).toBe(0)

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await openManualTrim(page)
  await expect(startInput).toHaveValue(String(beatCueSeconds))
  await expect(endInput).toHaveValue(String(beatLoopEndSeconds))

  const browser = browserLabel()
  const proofDirectory = path.resolve(process.cwd(), 'docs/images/beat-alignment')
  mkdirSync(proofDirectory, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await startInput.scrollIntoViewIfNeeded()
  await expect(startInput).toBeInViewport()
  await page.screenshot({ path: proofImagePath(browser, 'desktop'), fullPage: false })
  await expectNoOverflow(page, 390)
  await startInput.scrollIntoViewIfNeeded()
  await expect(startInput).toBeInViewport()
  await page.screenshot({ path: proofImagePath(browser, 'mobile'), fullPage: false })
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Combo length').selectOption('4')
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.locator('[aria-label^="Sequence timeline: "]')).toBeVisible()
  await page.getByRole('radio', { name: 'Q&A' }).check()
  const autoGenerate = page.getByRole('checkbox', { name: /Auto-generate/ })
  await autoGenerate.check()
  await page.getByLabel('New combo every').selectOption('1')

  await page.getByRole('button', { name: 'Play sequence' }).click()
  const status = page.locator('.transport-status')
  await expect(status).toContainText('Auto-generate · combo 1 · Q&A · question playback · cycle 1.')
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  await expect.poll(() => beatOutputRms(page), { timeout: 10_000, intervals: [100, 150, 200, 250] }).toBeGreaterThan(0.001)
  const trimmedSource = await activeCustomBeatSource(page)
  const expectedStartFrame = Math.round(beatCueSeconds * trimmedSource.sampleRate)
  const expectedEndFrame = Math.round(beatLoopEndSeconds * trimmedSource.sampleRate)
  expect(trimmedSource.loop).toBe(true)
  expect(Number.isFinite(trimmedSource.when)).toBe(true)
  expect(trimmedSource.channels).toBe(1)
  expect(trimmedSource.frameLength).toBe(trimmedSource.storedSampleCount)
  expect(trimmedSource.offset).toBeCloseTo(expectedStartFrame / trimmedSource.sampleRate, 8)
  expect(trimmedSource.loopStart).toBeCloseTo(expectedStartFrame / trimmedSource.sampleRate, 8)
  expect(trimmedSource.loopEnd).toBeCloseTo(expectedEndFrame / trimmedSource.sampleRate, 8)
  expect(trimmedSource.changedSampleCount).toBe(0)
  expect(trimmedSource.changedSinceDecodeCount).toBe(0)

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(startInput).toBeDisabled()
  await expect(endInput).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Apply beat trim' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Reset beat trim' })).toBeDisabled()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeDisabled()
  await expect.poll(() => status.innerText(), { timeout: 20_000, intervals: [50, 100, 200] })
    .toContain('Auto-generate · combo 2 · Q&A · question playback · cycle 3.')
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.starts.filter(({ loop }) => loop).length ?? 0))
    .toBe(1)
  await expect.poll(() => beatOutputRms(page), { timeout: 10_000, intervals: [100, 150, 200, 250] }).toBeGreaterThan(0.001)
  const autoGeneratedSource = await activeCustomBeatSource(page)
  expect(autoGeneratedSource.changedSampleCount).toBe(0)
  expect(autoGeneratedSource.changedSinceDecodeCount).toBe(0)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(status).toHaveText('Playback stopped.')

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await openManualTrim(page)
  await page.getByRole('button', { name: 'Reset beat trim', exact: true }).click()
  await expect(startInput).toHaveValue('0')
  await expect(endInput).toHaveValue('')
  await expect(trimPanel.locator('.session-controls__trim-status')).toHaveText('Full clip — no manual trim applied.')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  await expect.poll(() => beatOutputRms(page), { timeout: 10_000, intervals: [100, 150, 200, 250] }).toBeGreaterThan(0.001)
  const fullClipSource = await activeCustomBeatSource(page)
  expect(fullClipSource.loop).toBe(true)
  expect(fullClipSource.offset === undefined || fullClipSource.offset === 0).toBe(true)
  expect(fullClipSource.loopStart).toBe(0)
  // Web Audio treats the default loopEnd=0 as the decoded buffer end.
  const effectiveFullClipEndFrame = fullClipSource.loopEnd > 0
    ? Math.round(fullClipSource.loopEnd * fullClipSource.sampleRate)
    : fullClipSource.frameLength
  expect(effectiveFullClipEndFrame).toBe(fullClipSource.frameLength)
  expect(fullClipSource.changedSampleCount).toBe(0)
  expect(fullClipSource.changedSinceDecodeCount).toBe(0)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(status).toHaveText('Playback stopped.')

  // Removing these new v1 fields emulates a session saved before manual trim existed.
  await removeNewTrimFieldsFromSavedSession(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Reload last saved' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.resumeCount ?? -1)).toBe(0)
  await expect.poll(() => page.evaluate(() => window.__beatAlignmentQa?.starts.length ?? -1)).toBe(0)
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await openManualTrim(page)
  await expect(startInput).toHaveValue('0')
  await expect(endInput).toHaveValue('')

  const currentOrigin = new URL(page.url()).origin
  const externalOrMutating = requests.filter((request) => {
    const url = new URL(request.url)
    return url.origin !== currentOrigin || !['GET', 'HEAD'].includes(request.method)
  })
  expect(externalOrMutating).toEqual([])
})
