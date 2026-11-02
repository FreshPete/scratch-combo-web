import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare global {
  interface Window {
    __customBeatQa?: {
      contexts: AudioContext[]
      sourceStarts: Array<{
        node: AudioBufferSourceNode
        loop: boolean
        duration: number | undefined
        playbackRate: number
      }>
      sourceStops: AudioBufferSourceNode[]
      connections: Array<{ source: AudioNode; destination: AudioNode }>
      worklets: Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>
    }
  }
}

const scratchBpm = 85
const customBeatBpm = 128
const customBeatToneHz = 220
const fixtureBeatCount = 24
const fixtureSampleRate = 44_100
const mp3FixturePath = path.resolve(process.cwd(), 'e2e/fixtures/custom-beat-128-bpm.mp3')

function makeClickTrackWav(bpm: number, beatCount: number, toneHz: number): Buffer {
  const sampleRate = fixtureSampleRate
  const sampleCount = Math.round(sampleRate * beatCount * 60 / bpm)
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
    const time = index / sampleRate
    const beatPhase = time * bpm / 60
    const beatOffset = (beatPhase - Math.floor(beatPhase)) * 60 / bpm
    const envelope = beatOffset < 0.075 ? Math.exp(-beatOffset * 42) : 0
    const sample = envelope * (
      0.04 * Math.sin(2 * Math.PI * 80 * beatOffset)
      + 0.30 * Math.sin(2 * Math.PI * toneHz * beatOffset)
      + 0.05 * Math.sin(2 * Math.PI * 1_000 * beatOffset)
      + 0.04 * Math.sin(2 * Math.PI * 1_900 * beatOffset)
    )
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2)
  }
  return wav
}

function payload(name: string, buffer: Buffer, mimeType: string) {
  return { name, mimeType, buffer }
}

async function instrumentWebAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      contexts: [] as AudioContext[],
      sourceStarts: [] as Array<{
        node: AudioBufferSourceNode
        loop: boolean
        duration: number | undefined
        playbackRate: number
      }>,
      sourceStops: [] as AudioBufferSourceNode[],
      connections: [] as Array<{ source: AudioNode; destination: AudioNode }>,
      worklets: [] as Array<{ node: AudioWorkletNode; analyser: AnalyserNode }>,
    }
    ;(window as Window).__customBeatQa = qa

    const originalResume = AudioContext.prototype.resume
    AudioContext.prototype.resume = function () {
      if (!qa.contexts.includes(this)) qa.contexts.push(this)
      return originalResume.call(this)
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
      const context = this.context as AudioContext
      if (!qa.contexts.includes(context)) qa.contexts.push(context)
      qa.sourceStarts.push({
        node: this,
        loop: this.loop,
        duration: this.buffer?.duration,
        playbackRate: this.playbackRate.value,
      })
      return originalStart.call(this, when, offset, duration)
    }

    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (this.loop) qa.sourceStops.push(this)
      return originalStop.call(this, when)
    }
  })
}

async function activeBeatLoopCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__customBeatQa
    if (!qa) return 0
    return qa.sourceStarts.filter(({ node, loop }) => loop && !qa.sourceStops.includes(node)).length
  })
}

type ScratchLibraryBaseline = {
  presetId: string
  heading: string
  sampleName: string
  sampleCount: number
  sampleCountText: string
  beatOptionText: string
  sampleVolume: string
  beatVolume: string
}

async function loadScratchLibrary(page: Page): Promise<ScratchLibraryBaseline> {
  await page.goto('/')
  await expect(page.getByLabel('Quick preset')).toHaveValue('SSC-085BPM-01')
  const presetId = await page.getByLabel('Quick preset').inputValue()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'BPM', exact: true })).toHaveValue('85')
  await expect(page.getByLabel('Beat bed')).toHaveValue('0')
  const beatOptionText = (await page.getByLabel('Beat bed').locator('option').nth(1).textContent())?.trim() ?? ''
  const sampleVolume = await page.getByLabel('Sample level').inputValue()
  const beatVolume = await page.getByLabel('Beat level').inputValue()
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await expect(page.locator('.sample-table tbody tr').first()).toBeVisible()
  const sampleName = (await page.locator('.sample-name').first().textContent())?.trim() ?? ''
  const sampleCount = await page.locator('.sample-table tbody tr').count()
  const sampleCountText = (await page.locator('.sample-count').textContent())?.trim() ?? ''
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  const baseline: ScratchLibraryBaseline = {
    presetId,
    heading: (await page.locator('.sequence-heading').textContent()) ?? '',
    sampleName,
    sampleCount,
    sampleCountText,
    beatOptionText,
    sampleVolume,
    beatVolume,
  }
  expect(baseline.sampleName).not.toBe('')
  expect(baseline.sampleCount).toBeGreaterThan(0)
  expect(baseline.beatOptionText).toMatch(/^Beat 01 · /)

  await expect(page.locator('[aria-label^="Sequence timeline: "]')).toBeVisible()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Beat bed')).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.length ?? 0)).toBe(0)
  return baseline
}

async function uploadAndApplyCustomBeat(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, baseline: ScratchLibraryBaseline): Promise<void> {
  await expect(page.getByLabel('Upload custom beat')).toBeDisabled()
  await expect(page.locator('.session-controls__custom-beat-upload')).toHaveClass(/session-controls__custom-beat-upload--inactive/)
  const inactiveCustomPanel = page.locator('.session-controls__custom-source-panel')
  const activePresetPanel = page.locator('.session-controls__source-panel').first()
  await expect(inactiveCustomPanel).toHaveClass(/session-controls__source-panel--inactive/)
  const [inactiveColor, activeColor] = await Promise.all([
    inactiveCustomPanel.evaluate((element) => getComputedStyle(element).color),
    activePresetPanel.evaluate((element) => getComputedStyle(element).color),
  ])
  expect(inactiveColor).not.toBe(activeColor)
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  await expect(page.getByLabel('Upload custom beat')).toBeEnabled()
  await page.getByLabel('Upload custom beat').setInputFiles(file)
  const analysis = page.locator('.session-controls__analysis')
  await expect(analysis).toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 })

  const analysisText = (await analysis.textContent()) ?? ''
  const estimate = analysisText.match(/estimated\s+([\d.]+)\s+BPM/i)
  const possibleTempos = analysisText.match(/Possible tempos:\s*([\d., ]+)\s+BPM/i)
  if (estimate) {
    expect(Number(estimate[1])).toBeGreaterThanOrEqual(customBeatBpm - 5)
    expect(Number(estimate[1])).toBeLessThanOrEqual(customBeatBpm + 5)
  } else if (possibleTempos) {
    const candidates = possibleTempos[1]!.split(',').map((value) => Number(value.trim()))
    expect(candidates.some((candidate) => Math.abs(candidate - customBeatBpm) <= 5)).toBe(true)
  } else {
    throw new Error(`No BPM estimate or candidates were announced: ${analysisText}`)
  }

  const correction = page.getByRole('spinbutton', { name: 'Custom beat BPM' })
  await expect(correction).toBeVisible()
  await correction.fill(String(customBeatBpm))
  await page.getByRole('button', { name: 'Use custom beat' }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  await expect(page.locator('.session-controls__custom-beat-upload')).not.toHaveClass(/session-controls__custom-beat-upload--inactive/)
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect(page.getByRole('spinbutton', { name: 'BPM', exact: true })).toHaveValue(String(customBeatBpm))
  await expect(page.locator('.session-controls__hint').filter({ hasText: `scratch source ${scratchBpm}` })).toContainText(`beat source ${customBeatBpm}`)
  await expect(page.getByLabel('Quick preset')).toHaveValue(baseline.presetId)
  await expect(page.locator('.sequence-heading')).toContainText(baseline.heading.trim())
  await expect(page.locator('.sample-name').first()).toHaveText(baseline.sampleName)
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(baseline.sampleCount)
  await expect(page.locator('.sample-count')).toHaveText(baseline.sampleCountText)
  await expect(page.getByLabel('Beat bed').locator('option', { hasText: baseline.beatOptionText })).toHaveCount(1)
  await expect(page.getByLabel('Beat bed').locator('option', { hasText: `Your beat · ${file.name}` })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.filter((source) => source.loop).length ?? 0))
    .toBe(0)
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.length ?? 0)).toBe(0)
}

async function readAudioGraph(page: Page): Promise<{
  beatSourceDuration: number
  beatSourceRate: number
  beatSourceLoop: boolean
  sampleProcessorRate: number
  beatProcessorRate: number
  samplePitch: number
  beatPitch: number
}> {
  return page.evaluate(() => {
    const qa = window.__customBeatQa
    if (!qa) throw new Error('Web Audio QA instrumentation was not installed.')
    const beatSource = [...qa.sourceStarts].reverse().find((entry) => entry.loop)
    if (!beatSource) throw new Error('The selected custom beat did not start as a looping audio source.')
    const beatGain = qa.connections.find((connection) => connection.source === beatSource.node)?.destination
    const beatProcessor = qa.connections.find((connection) => connection.source === beatGain
      && connection.destination instanceof AudioWorkletNode)?.destination as AudioWorkletNode | undefined
    if (!beatProcessor) throw new Error('The custom beat was not sent through a dedicated worklet processor.')
    const sampleProcessor = qa.worklets.map(({ node }) => node).find((node) => node !== beatProcessor)
    if (!sampleProcessor) throw new Error('Scratch samples did not use their own worklet processor.')
    const parameterValue = (node: AudioWorkletNode, name: string) => node.parameters.get(name)?.value ?? Number.NaN
    return {
      beatSourceDuration: beatSource.duration ?? Number.NaN,
      beatSourceRate: beatSource.playbackRate,
      beatSourceLoop: beatSource.loop,
      sampleProcessorRate: parameterValue(sampleProcessor, 'playbackRate'),
      beatProcessorRate: parameterValue(beatProcessor, 'playbackRate'),
      samplePitch: parameterValue(sampleProcessor, 'pitchSemitones'),
      beatPitch: parameterValue(beatProcessor, 'pitchSemitones'),
    }
  })
}

async function waitForBeatOutputTone(page: Page, expectedHz: number): Promise<number[]> {
  const readings: number[] = []
  await expect.poll(async () => {
    const reading = await page.evaluate((expected) => {
      const qa = window.__customBeatQa
      if (!qa) return { hz: 0, db: Number.NEGATIVE_INFINITY }
      const beatSource = [...qa.sourceStarts].reverse().find((entry) => entry.loop)
      const beatGain = qa.connections.find((connection) => connection.source === beatSource?.node)?.destination
      const processor = qa.connections.find((connection) => connection.source === beatGain
        && connection.destination instanceof AudioWorkletNode)?.destination as AudioWorkletNode | undefined
      const analyser = qa.worklets.find((entry) => entry.node === processor)?.analyser
      if (!analyser) return { hz: 0, db: Number.NEGATIVE_INFINITY }
      const spectrum = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatFrequencyData(spectrum)
      const sampleRate = analyser.context.sampleRate
      const firstBin = Math.max(1, Math.floor((expected - 55) * analyser.fftSize / sampleRate))
      const lastBin = Math.min(spectrum.length - 1, Math.ceil((expected + 55) * analyser.fftSize / sampleRate))
      let bestBin = firstBin
      for (let bin = firstBin + 1; bin <= lastBin; bin += 1) {
        if (spectrum[bin]! > spectrum[bestBin]!) bestBin = bin
      }
      return { hz: bestBin * sampleRate / analyser.fftSize, db: spectrum[bestBin]! }
    }, expectedHz)
    if (reading.db > -55 && Math.abs(reading.hz - expectedHz) <= 18) readings.push(reading.hz)
    return readings.length
  }, { timeout: 10_000, intervals: [100, 150, 200, 250] }).toBeGreaterThanOrEqual(3)

  const closestReading = readings.reduce((best, frequency) => Math.abs(frequency - expectedHz) < Math.abs(best - expectedHz)
    ? frequency
    : best, Number.POSITIVE_INFINITY)
  expect(Math.abs(closestReading - expectedHz), `expected ${expectedHz.toFixed(1)} Hz; sampled ${readings.join(', ')}`)
    .toBeLessThanOrEqual(18)
  const measuredMin = Math.min(...readings)
  const measuredMax = Math.max(...readings)
  console.log(`[custom-beat-qa] target ${expectedHz.toFixed(1)} Hz; sampled ${measuredMin.toFixed(1)}–${measuredMax.toFixed(1)} Hz across ${readings.length} worklet frames`)
  return readings
}

async function expectNoPageOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(Math.max(geometry.document, geometry.body), `custom beat layout overflows at ${width}px`).toBeLessThanOrEqual(width)
}

function proofImagePath(): string {
  const browser = (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return path.resolve(process.cwd(), 'docs/images', `custom-beat-live-playback-${browser}.png`)
}

function customFirstProofImagePath(): string {
  const browser = (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return path.resolve(process.cwd(), 'docs/images', `beat-source-custom-first-${browser}.png`)
}

test('WAV custom beat keeps the scratch library, follows tempo at neutral pitch, and leaves live controls available', async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  await instrumentWebAudio(page)
  const baseline = await loadScratchLibrary(page)
  await uploadAndApplyCustomBeat(page, {
    name: 'CustomBeat-128.wav',
    mimeType: 'audio/wav',
    buffer: makeClickTrackWav(customBeatBpm, fixtureBeatCount, customBeatToneHz),
  }, baseline)

  await expectNoPageOverflow(page, 390)
  await expectNoPageOverflow(page, 844)
  await page.setViewportSize({ width: 1280, height: 720 })

  const scratchDefaults = { sample: baseline.sampleVolume, beat: baseline.beatVolume }
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).not.toHaveText('Playback stopped.', { timeout: 12_000 })
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.contexts.map((context) => context.state) ?? []))
    .toContain('running')
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)

  const structuralControls = [
    page.getByLabel('Quick preset'),
    page.getByLabel('Combo length'),
    page.getByLabel('Choose INI preset'),
    page.getByLabel('Choose WAV files'),
    page.getByLabel('Choose audio folder'),
    page.getByLabel('Beat bed'),
    page.getByRole('radio', { name: 'Preset', exact: true }),
    page.getByRole('radio', { name: 'Custom', exact: true }),
    page.getByLabel('Upload custom beat'),
    page.locator('.sequence-actions .button--primary'),
  ]
  for (const control of structuralControls) await expect(control).toBeDisabled()

  const liveControls = [
    page.getByRole('spinbutton', { name: 'BPM', exact: true }),
    page.getByRole('slider', { name: 'Pitch shift in semitones' }),
    page.getByLabel('Sample level'),
    page.getByLabel('Beat level'),
    page.getByRole('button', { name: 'Reset controls' }),
  ]
  for (const control of liveControls) await expect(control).toBeEnabled()

  await expect.poll(async () => (await readAudioGraph(page)).beatSourceDuration, { timeout: 8_000 }).toBeGreaterThan(10)
  const initialAudio = await readAudioGraph(page)
  expect(initialAudio.beatSourceLoop).toBe(true)
  expect(initialAudio.beatSourceRate).toBeCloseTo(1, 4)
  expect(initialAudio.sampleProcessorRate).toBeCloseTo(customBeatBpm / scratchBpm, 4)
  expect(initialAudio.beatProcessorRate).toBeCloseTo(1, 4)
  expect(initialAudio.samplePitch).toBe(0)
  expect(initialAudio.beatPitch).toBe(0)
  expect(initialAudio.sampleProcessorRate).not.toBe(initialAudio.beatProcessorRate)
  await waitForBeatOutputTone(page, customBeatToneHz)

  await page.getByRole('spinbutton', { name: 'BPM', exact: true }).fill('126')
  await expect.poll(async () => (await readAudioGraph(page)).sampleProcessorRate).toBeCloseTo(126 / scratchBpm, 4)
  await expect.poll(async () => (await readAudioGraph(page)).beatProcessorRate).toBeCloseTo(126 / customBeatBpm, 4)
  await expect.poll(async () => {
    const graph = await readAudioGraph(page)
    return { samplePitch: graph.samplePitch, beatPitch: graph.beatPitch }
  }).toEqual({ samplePitch: 0, beatPitch: 0 })
  await page.getByRole('slider', { name: 'Pitch shift in semitones' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => {
    const graph = await readAudioGraph(page)
    return { samplePitch: graph.samplePitch, beatPitch: graph.beatPitch }
  }).toEqual({ samplePitch: 2, beatPitch: 2 })
  await page.waitForTimeout(700)
  await waitForBeatOutputTone(page, customBeatToneHz * Math.pow(2, 2 / 12))
  await page.getByLabel('Sample level').focus()
  await page.keyboard.press('Home')
  await page.getByLabel('Beat level').focus()
  await page.keyboard.press('Home')
  await expect(page.locator('.session-controls__readout').filter({ hasText: '0%' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Reset controls' }).click()
  await expect(page.getByRole('spinbutton', { name: 'BPM', exact: true })).toHaveValue(String(customBeatBpm))
  await expect(page.getByRole('slider', { name: 'Pitch shift in semitones' })).toHaveValue('0')
  await expect(page.getByLabel('Sample level')).toHaveValue(scratchDefaults.sample)
  await expect(page.getByLabel('Beat level')).toHaveValue(scratchDefaults.beat)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect(page.locator('.transport-status')).not.toHaveText('Playback stopped.')
  expect(await page.evaluate(() => window.__customBeatQa?.sourceStarts.filter((source) => source.loop).length ?? 0)).toBe(1)
  expect(await page.evaluate(() => window.__customBeatQa?.sourceStops.length ?? 0)).toBe(0)
  await expect.poll(async () => (await readAudioGraph(page)).sampleProcessorRate).toBeCloseTo(customBeatBpm / scratchBpm, 4)
  await expect.poll(async () => (await readAudioGraph(page)).beatProcessorRate).toBeCloseTo(1, 4)
  await expect.poll(async () => {
    const graph = await readAudioGraph(page)
    return { samplePitch: graph.samplePitch, beatPitch: graph.beatPitch }
  }).toEqual({ samplePitch: 0, beatPitch: 0 })

  await page.locator('#session-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: proofImagePath(), fullPage: false })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  await expect(page.getByLabel('Quick preset')).toBeEnabled()
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(baseline.sampleCount)

  const invalidStatus = page.locator('.session-controls__analysis')
  await page.getByLabel('Upload custom beat').setInputFiles(payload('broken.wav', Buffer.from('not a RIFF/WAVE file'), 'audio/wav'))
  await expect(invalidStatus).toContainText(/could not analyze.*current beat remains selected/i)
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect(page.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
  await page.getByRole('radio', { name: 'Preset', exact: true }).check()
  await expect(page.getByLabel('Beat bed')).toBeEnabled()
  await expect(page.getByLabel('Upload custom beat')).toBeDisabled()
  await expect(page.locator('.session-controls__custom-beat-upload')).toHaveClass(/session-controls__custom-beat-upload--inactive/)
  const invalidCandidateApply = page.getByRole('button', { name: 'Use custom beat' })
  if (await invalidCandidateApply.count()) await expect(invalidCandidateApply).toBeDisabled()
  await expect(page.getByLabel('Beat bed')).toHaveValue('0')
  await expect.poll(() => activeBeatLoopCount(page)).toBe(0)
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  await expect(page.getByLabel('Upload custom beat')).toBeEnabled()
  await expect(page.locator('.session-controls__custom-beat-upload')).not.toHaveClass(/session-controls__custom-beat-upload--inactive/)
  await expect(page.getByRole('spinbutton', { name: 'BPM', exact: true })).toHaveValue(String(customBeatBpm))
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect.poll(() => activeBeatLoopCount(page)).toBe(0)
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  const externalOrMutatingRequests = requests.filter((request) => {
    const url = new URL(request.url)
    return url.origin !== new URL(page.url()).origin || !['GET', 'HEAD'].includes(request.method)
  })
  expect(externalOrMutatingRequests).toEqual([])
})

test('MP3 custom beat decodes in the browser, can be corrected, and reaches the live transport', async ({ page }) => {
  await instrumentWebAudio(page)
  const baseline = await loadScratchLibrary(page)
  await uploadAndApplyCustomBeat(page, {
    name: path.basename(mp3FixturePath),
    mimeType: 'audio/mpeg',
    buffer: readFileSync(mp3FixturePath),
  }, baseline)

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.locator('.timeline-scroll')).toBeVisible()
  await page.getByRole('radio', { name: 'TTM practice guides' }).check()
  await expect(page.locator('.sequence-ttm-motion path').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(baseline.sampleCount)
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByLabel('Choose INI preset')).toBeEnabled()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.length ?? 0)).toBe(0)

  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.contexts.map((context) => context.state) ?? []))
    .toContain('running')
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  const graph = await readAudioGraph(page)
  expect(graph.beatSourceLoop).toBe(true)
  expect(graph.beatSourceDuration).toBeGreaterThan(10)
  expect(graph.sampleProcessorRate).toBeCloseTo(customBeatBpm / scratchBpm, 4)
  expect(graph.beatProcessorRate).toBeCloseTo(1, 4)
  expect(graph.samplePitch).toBe(0)
  expect(graph.beatPitch).toBe(0)
  await waitForBeatOutputTone(page, customBeatToneHz)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
})

test('Custom source can be selected first and reviewed audio stays inactive until applied', async ({ page }) => {
  await instrumentWebAudio(page)
  const baseline = await loadScratchLibrary(page)

  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Preset', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  const inactivePresetPanel = page.locator('.session-controls__source-panel').first()
  const activeCustomPanel = page.locator('.session-controls__custom-source-panel')
  await expect(inactivePresetPanel).toHaveClass(/session-controls__source-panel--inactive/)
  await expect(activeCustomPanel).not.toHaveClass(/session-controls__source-panel--inactive/)
  const [inactiveSourceColor, activeSourceColor] = await Promise.all([
    inactivePresetPanel.evaluate((element) => getComputedStyle(element).color),
    activeCustomPanel.evaluate((element) => getComputedStyle(element).color),
  ])
  expect(inactiveSourceColor).not.toBe(activeSourceColor)
  await expect(page.locator('.session-controls__beat-sync')).toContainText(/No custom beat is applied/i)
  await expect(page.getByLabel('Upload custom beat')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
  await page.locator('#session-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: customFirstProofImagePath(), fullPage: false })

  await page.getByLabel('Upload custom beat').setInputFiles({
    name: 'CustomBeat-128.wav',
    mimeType: 'audio/wav',
    buffer: makeClickTrackWav(customBeatBpm, fixtureBeatCount, customBeatToneHz),
  })
  const analysis = page.locator('.session-controls__analysis')
  await expect(analysis).toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 })
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: 'Custom beat BPM' })).toBeVisible()
  await expect(page.locator('.session-controls__beat-sync')).toContainText(/No custom beat is applied/i)
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.filter((source) => source.loop).length ?? 0))
    .toBe(0)

  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => activeBeatLoopCount(page)).toBe(0)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  await page.getByRole('spinbutton', { name: 'Custom beat BPM' }).fill(String(customBeatBpm))
  await page.getByRole('button', { name: 'Use custom beat' }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.__customBeatQa?.sourceStarts.filter((source) => source.loop).length ?? 0))
    .toBe(0)

  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  const appliedCustomLoop = await page.evaluate(() => {
    const qa = window.__customBeatQa
    return qa?.sourceStarts.filter(({ node, loop }) => loop && !qa.sourceStops.includes(node)).at(-1)?.duration ?? 0
  })
  expect(appliedCustomLoop).toBeGreaterThan(10)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  await page.getByRole('radio', { name: 'Preset', exact: true }).check()
  await expect(page.getByLabel('Beat bed')).toBeEnabled()
  await expect(page.getByLabel('Beat bed')).toHaveValue('0')
  await expect(page.getByLabel('Upload custom beat')).toBeDisabled()
  await expect(page.locator('.session-controls__custom-beat-upload')).toHaveClass(/session-controls__custom-beat-upload--inactive/)
  const cachedCandidateBpm = page.getByRole('spinbutton', { name: 'Custom beat BPM' })
  if (await cachedCandidateBpm.count()) await expect(cachedCandidateBpm).toBeDisabled()
  const cachedCandidateApply = page.getByRole('button', { name: 'Use custom beat' })
  if (await cachedCandidateApply.count()) await expect(cachedCandidateApply).toBeDisabled()
  await expect(activeCustomPanel).toHaveClass(/session-controls__source-panel--inactive/)
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toBeDisabled()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => activeBeatLoopCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByLabel('Beat bed')).toBeDisabled()
  await expect(activeCustomPanel).not.toHaveClass(/session-controls__source-panel--inactive/)
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toBeEnabled()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(String(customBeatBpm))
  await expect(page.getByLabel('Upload custom beat')).toHaveAttribute('accept', /audio\/mpeg/)
  await expect(page.getByLabel('Quick preset')).toHaveValue(baseline.presetId)
})
