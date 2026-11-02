import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stageLocalImport } from './helpers/import-wizard'

declare global {
  interface Window {
    __countInQa?: {
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
      taps: Array<{
        source: AudioNode
        analyser: AnalyserNode
        samples: Array<{ time: number; rms: number }>
      }>
      statusTexts: string[]
      stopMark?: number
      stopBufferCount?: number
      stopOscillatorCount?: number
    }
  }
}

test.describe.configure({ timeout: 180_000 })

const beatName = 'CountInTrimBeat.wav'
const cueSeconds = 1
const loopEndSeconds = 3
const practiceBpm = 170
const barDuration = 4 * 60 / practiceBpm

function makeWav(frequency = 440, durationSeconds = 0.12): Buffer {
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
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.3
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function makeTrimBeatWav(): Buffer {
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

  const sourceBeatSeconds = 60 / 85
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate
    let sample: number
    if (time < cueSeconds) {
      sample = 0.24 * Math.sin(2 * Math.PI * 330 * time)
    } else if (time < durationSeconds - 1) {
      const beatOffset = (time - cueSeconds) % sourceBeatSeconds
      const pulse = beatOffset < 0.08 ? Math.exp(-beatOffset * 38) : 0
      sample = 0.07 * Math.sin(2 * Math.PI * 220 * (time - cueSeconds))
        + pulse * (
          0.24 * Math.sin(2 * Math.PI * 220 * beatOffset)
          + 0.05 * Math.sin(2 * Math.PI * 1_100 * beatOffset)
        )
    } else {
      sample = 0.24 * Math.sin(2 * Math.PI * 660 * (time - (durationSeconds - 1)))
    }
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2)
  }
  return wav
}

function customIni(): string {
  return [
    '[Samples]',
    'CONFIGNAME=Count-in Metronome QA Fixture',
    'VOL_B=100',
    'VOL_S=75',
    'RootSamplePathRelative=True',
    'RootSamplePath=assets',
    'Beat01=Beats/unavailable.wav',
    'BPM01=85',
    '',
    '[Sample01]',
    'SamplePlayFq=1',
    'SampleIsSilent=False',
    'SampleRepeatsPoss=True',
    'SampleRepeatMax=100',
    'SampleFileName=Samples/Wanted.wav',
    'SampleDisplayName=QA sample',
    'SampleStartsForward=True',
    'SampleEndsForward=False',
    'Sample16ths=8',
    'UseSample=True',
    '',
  ].join('\r\n')
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
      taps: [] as Array<{
        source: AudioNode
        analyser: AnalyserNode
        samples: Array<{ time: number; rms: number }>
      }>,
      statusTexts: [] as string[],
    }
    window.__countInQa = qa

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
      const result = originalConnect.call(this, destination, output, input)
      if (destination instanceof AudioNode && this.context instanceof AudioContext) {
        qa.connections.push({ source: this, destination })
        if (destination === this.context.destination && !qa.taps.some((tap) => tap.source === this)) {
          const analyser = this.context.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0
          const mutedMonitor = this.context.createGain()
          mutedMonitor.gain.value = 0
          originalConnect.call(this, analyser)
          originalConnect.call(analyser, mutedMonitor)
          originalConnect.call(mutedMonitor, this.context.destination)
          qa.taps.push({ source: this, analyser, samples: [] })
        }
      }
      return result
    } as typeof AudioNode.prototype.connect

    window.setInterval(() => {
      for (const tap of qa.taps) {
        try {
          const values = new Float32Array(tap.analyser.fftSize)
          tap.analyser.getFloatTimeDomainData(values)
          const sum = values.reduce((total, sample) => total + sample * sample, 0)
          const rms = Math.sqrt(sum / values.length)
          if (rms > 0.00001) {
            tap.samples.push({ time: tap.source.context.currentTime, rms })
            if (tap.samples.length > 12_000) tap.samples.shift()
          }
        } catch {
          // Ignore taps whose context has already closed during Stop or page teardown.
        }
      }
    }, 8)

    let observedStatus: HTMLElement | null = null
    let statusObserver: MutationObserver | null = null
    window.setInterval(() => {
      if (observedStatus?.isConnected) return
      statusObserver?.disconnect()
      observedStatus = document.querySelector<HTMLElement>('.transport-status')
      if (!observedStatus) return
      const record = () => qa.statusTexts.push(observedStatus?.textContent?.trim() ?? '')
      statusObserver = new MutationObserver(record)
      statusObserver.observe(observedStatus, { childList: true, subtree: true, characterData: true })
      record()
    }, 10)
  })
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  const audioDirectory = path.resolve(process.cwd(), '.forge', 'count-in-qa-results', 'fixtures', 'count-in-metronome-audio')
  mkdirSync(path.join(audioDirectory, 'assets', 'Samples'), { recursive: true })
  writeFileSync(path.join(audioDirectory, 'assets', 'Samples', 'Wanted.wav'), makeWav(440))
  await stageLocalImport(page, {
    name: 'count-in-metronome.ini',
    buffer: Buffer.from(customIni()),
    mimeType: 'text/plain',
  }, audioDirectory, 'folder')
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()
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

async function openAndApplyTrim(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Custom', exact: true }).check()
  await page.getByLabel('Upload custom beat').setInputFiles({
    name: beatName,
    mimeType: 'audio/wav',
    buffer: makeTrimBeatWav(),
  })
  await expect(page.locator('.session-controls__analysis')).toContainText(/estimated|ambiguous|periodic tempo|pulse/i, { timeout: 20_000 })
  await page.getByRole('spinbutton', { name: 'Custom beat BPM', exact: true }).fill('85')
  await page.getByRole('button', { name: 'Use custom beat', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue('85')

  const disclosure = page.getByText('Manual beat trim', { exact: true })
  await expect(disclosure).toBeVisible()
  if (!(await disclosure.evaluate((element) => Boolean(element.closest('details')?.open)))) {
    await disclosure.click()
  }
  const start = page.getByRole('spinbutton', { name: 'First downbeat / loop start (seconds)', exact: true })
  const end = page.getByRole('spinbutton', { name: 'Loop end (seconds)', exact: true })
  await expect(start).toBeEnabled({ timeout: 20_000 })
  await expect(end).toBeEnabled()
  await start.fill(String(cueSeconds))
  await end.fill(String(loopEndSeconds))
  await page.getByRole('button', { name: 'Apply beat trim', exact: true }).click()
  await expect(page.locator('.session-controls__trim-status'))
    .toContainText('Applied: cue 1.000s · loop end 3.000s.')
}

function browserLabel(): string {
  const channel = (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase()
  return channel === 'msedge' ? 'edge' : channel.replace(/[^a-z0-9-]+/g, '-')
}

test('count-in stop, trimmed cue, audible clicks, and Auto-generate stay on one audio phase', async ({ page }) => {
  await installWebAudioInstrumentation(page)
  await loadFixture(page)

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await openAndApplyTrim(page)
  await page.getByRole('spinbutton', { name: 'BPM', exact: true }).fill(String(practiceBpm))
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Combo length').selectOption('4')
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline:/ })).toBeVisible()

  const countIn = page.locator('#count-in-bars')
  const metronome = page.locator('#metronome-enabled')
  const clickLevel = page.locator('#metronome-volume')
  const status = page.locator('.transport-status')
  const progress = page.getByRole('progressbar', { name: 'Preview progress' })
  const play = page.getByRole('button', { name: 'Play sequence' })
  const stop = page.getByRole('button', { name: 'Stop' })

  await expect(countIn).toHaveValue('0')
  await expect(metronome).not.toBeChecked()
  await expect(clickLevel).toHaveValue('60')
  await expect(clickLevel).toBeDisabled()
  await expect(countIn).toBeEnabled({ timeout: 15_000 })

  // Off keeps the existing immediate-start path; there is no countdown status.
  await play.click()
  await expect(status).toContainText('Q&A · question playback · cycle 1.', { timeout: 10_000 })
  await expect(status).not.toContainText('Count-in')
  const immediateStart = await page.evaluate(() => {
    const entry = window.__countInQa?.buffers.find((source) => source.loop && source.buffer?.duration >= 9)
    return entry ? { scheduledDelay: entry.when - entry.callTime, offset: entry.offset } : null
  })
  expect(immediateStart).not.toBeNull()
  expect(immediateStart!.scheduledDelay).toBeLessThan(0.3)
  expect(immediateStart!.offset).toBe(cueSeconds)
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')

  // Stop during an eight-beat pre-roll must cancel already queued future nodes and prevent later starts.
  await countIn.selectOption('2')
  const beforeStopStartCounts = await page.evaluate(() => ({
    buffers: window.__countInQa?.buffers.length ?? 0,
    oscillators: window.__countInQa?.oscillators.length ?? 0,
  }))
  await play.click()
  await expect(status).toHaveText('Count-in · beat 1 of 8.')
  await expect(stop).toBeEnabled()
  await expect(progress).toHaveAttribute('value', '0')
  await expect(page.locator('.timeline-playhead')).toHaveCount(0)
  await expect(countIn).toBeDisabled()
  await expect(metronome).toBeDisabled()
  await expect(clickLevel).toBeEnabled()
  await expect.poll(() => page.evaluate((startIndex) => {
    const entries = window.__countInQa?.oscillators.slice(startIndex) ?? []
    const context = entries[0]?.node.context
    return entries.length >= 2 && Boolean(context && entries.at(-1)!.when > context.currentTime)
  }, beforeStopStartCounts.oscillators), { timeout: 2_000, intervals: [10, 20, 30] }).toBe(true)
  const stopMark = await page.evaluate(() => {
    const qa = window.__countInQa
    const context = qa?.oscillators.at(-1)?.node.context
    if (!qa || !context) throw new Error('Count-in did not create a native oscillator in AudioContext.')
    qa.stopMark = context.currentTime
    qa.stopBufferCount = qa.buffers.length
    qa.stopOscillatorCount = qa.oscillators.length
    return qa.stopMark
  })
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
  const afterStop = await page.evaluate(() => {
    const qa = window.__countInQa!
    const context = qa.oscillators.at(-1)?.node.context
    if (!context) throw new Error('AudioContext disappeared after Stop.')
    return { time: context.currentTime, buffers: qa.buffers.length, oscillators: qa.oscillators.length }
  })
  await expect.poll(() => page.evaluate(() => {
    const qa = window.__countInQa
    const context = qa?.oscillators.at(-1)?.node.context
    return context && qa?.stopMark !== undefined ? context.currentTime - qa.stopMark : 0
  }), { timeout: 6_000 }).toBeGreaterThan(3.1)

  const cancellation = await page.evaluate(() => {
    const qa = window.__countInQa!
    const mark = qa.stopMark!
    const futureOscillators = qa.oscillators.filter((entry) => entry.when > mark)
    const futureBuffers = qa.buffers.filter((entry) => entry.when > mark)
    const cancelled = (node: AudioBufferSourceNode | OscillatorNode, stops: Array<{ node: AudioBufferSourceNode | OscillatorNode; when: number; callTime: number }>) =>
      stops.some((entry) => entry.node === node && entry.when === 0 && entry.callTime >= mark)
    return {
      bufferCount: qa.buffers.length,
      oscillatorCount: qa.oscillators.length,
      stopBufferCount: qa.stopBufferCount,
      stopOscillatorCount: qa.stopOscillatorCount,
      futureOscillatorsCancelled: futureOscillators.every((entry) => cancelled(entry.node, qa.oscillatorStops)),
      futureBuffersCancelled: futureBuffers.every((entry) => cancelled(entry.node, qa.bufferStops)),
      futureOscillatorsStoppedBeforeStart: futureOscillators.every((entry) => qa.oscillatorStops.some((stop) =>
        stop.node === entry.node && stop.when === 0 && stop.callTime >= mark && stop.callTime < entry.when)),
      futureOscillatorCount: futureOscillators.length,
      futureBufferCount: futureBuffers.length,
    }
  })
  expect(cancellation.bufferCount).toBe(afterStop.buffers)
  expect(cancellation.oscillatorCount).toBe(afterStop.oscillators)
  expect(cancellation.bufferCount).toBeGreaterThan(beforeStopStartCounts.buffers)
  expect(cancellation.stopBufferCount).toBeGreaterThan(beforeStopStartCounts.buffers)
  expect(cancellation.stopOscillatorCount).toBeGreaterThan(beforeStopStartCounts.oscillators)
  expect(cancellation.futureOscillatorCount).toBeGreaterThan(0)
  expect(cancellation.futureOscillatorsCancelled).toBe(true)
  expect(cancellation.futureOscillatorsStoppedBeforeStart).toBe(true)
  expect(cancellation.futureBufferCount).toBeGreaterThan(0)
  expect(cancellation.futureBuffersCancelled).toBe(true)

  // One-bar count-in drives the imported fixture, trimmed beat, ongoing metronome, and next generated plan.
  await countIn.selectOption('1')
  await metronome.check()
  await setRangeValue(page, '#metronome-volume', 60)
  const autoGenerate = page.getByRole('checkbox', { name: /Auto-generate/ })
  await expect(autoGenerate).toBeEnabled()
  await autoGenerate.check()
  await page.getByLabel('New combo every').selectOption('1')

  const run = await page.evaluate(() => ({
    buffers: window.__countInQa?.buffers.length ?? 0,
    oscillators: window.__countInQa?.oscillators.length ?? 0,
  }))
  await play.click()
  await expect(status).toHaveText('Count-in · beat 1 of 4.')
  await expect(progress).toHaveAttribute('value', '0')
  await expect(page.locator('.timeline-playhead')).toHaveCount(0)
  await expect(countIn).toBeDisabled()
  await expect(metronome).toBeDisabled()
  await expect(clickLevel).toBeEnabled()

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const bpmRange = page.getByRole('slider', { name: 'BPM range' })
  await expect(bpmRange).toBeDisabled()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await setRangeValue(page, '#metronome-volume', 40)
  await expect(page.locator('#metronome-volume-value')).toHaveText('40%')

  await expect(status).toContainText('Auto-generate · combo 1 · Q&A · question playback · cycle 1.', { timeout: 10_000 })
  await expect(page.getByRole('img', { name: /Sequence timeline:/ })).toBeVisible()
  await expect(page.locator('.timeline-playhead')).toBeVisible()
  const postCountInStatusIndex = await page.evaluate(() => {
    const qa = window.__countInQa!
    const currentStatus = document.querySelector('.transport-status')?.textContent?.trim() ?? ''
    if (qa.statusTexts.at(-1) !== currentStatus) qa.statusTexts.push(currentStatus)
    return qa.statusTexts.length
  })

  const clickEvidence = await page.evaluate(async ({ runBufferIndex, runOscillatorIndex, bpm }) => {
    const qa = window.__countInQa
    if (!qa) throw new Error('Web Audio instrumentation was missing.')
    const reaches = (from: AudioNode, target: AudioNode): boolean => {
      const pending = [from]
      const visited = new Set<AudioNode>()
      while (pending.length) {
        const current = pending.shift()!
        if (current === target) return true
        if (visited.has(current)) continue
        visited.add(current)
        for (const edge of qa.connections) {
          if (edge.source === current && !visited.has(edge.destination)) pending.push(edge.destination)
        }
      }
      return false
    }
    const oscillators = qa.oscillators.slice(runOscillatorIndex)
    const beatStart = qa.buffers.slice(runBufferIndex).find((entry) => entry.loop && entry.buffer?.duration >= 9)
    if (!beatStart) throw new Error('The trimmed preset beat did not reach a native AudioBufferSourceNode.')
    const firstClick = oscillators[0]
    if (!firstClick) throw new Error('The count-in did not schedule a click oscillator.')
    const sequenceClick = oscillators.find((entry) => entry.frequency === 1_760
      && entry.when >= firstClick.when + (4 * 60 / bpm) - 0.05)
    if (!sequenceClick) throw new Error('The ongoing metronome did not schedule the sequence downbeat.')
    const clickTap = qa.taps.find((tap) => reaches(firstClick.node, tap.source))
    const beatTap = qa.taps.find((tap) => tap.source instanceof AudioWorkletNode && reaches(beatStart.node, tap.source))
    if (!clickTap || !beatTap) throw new Error('Native PCM taps were not found on the click and processed beat output paths.')

    const onset = (tap: typeof clickTap, notBefore: number) =>
      tap.samples.find((sample) => sample.time >= notBefore && sample.rms > 0.0001)?.time ?? null
    const firstClickPcm = onset(clickTap, firstClick.when)
    const sequenceClickPcm = onset(clickTap, sequenceClick.when)
    const firstBeatPcm = onset(beatTap, beatStart.when)
    return {
      firstClickFrequency: firstClick.frequency,
      countInFrequencies: oscillators.slice(0, 4).map((entry) => entry.frequency),
      sequenceClickFrequency: sequenceClick.frequency,
      firstClickWhen: firstClick.when,
      sequenceClickWhen: sequenceClick.when,
      beatWhen: beatStart.when,
      beatOffset: beatStart.offset,
      beatLoopStart: beatStart.loopStart,
      beatLoopEnd: beatStart.loopEnd,
      beatDuration: beatStart.buffer?.duration ?? 0,
      sequenceClickInterval: sequenceClick.when - firstClick.when,
      firstClickPcm,
      sequenceClickPcm,
      firstBeatPcm,
      pcmOnsetDelta: firstBeatPcm !== null && sequenceClickPcm !== null ? firstBeatPcm - sequenceClickPcm : null,
      metronomeGain: clickTap.source instanceof GainNode ? clickTap.source.gain.value : null,
      recentOscillatorCount: oscillators.length,
    }
  }, { runBufferIndex: run.buffers, runOscillatorIndex: run.oscillators, bpm: practiceBpm })

  expect(clickEvidence.firstClickFrequency).toBe(1_760)
  expect(clickEvidence.countInFrequencies).toEqual([1_760, 1_320, 1_320, 1_320])
  expect(clickEvidence.sequenceClickFrequency).toBe(1_760)
  expect(clickEvidence.sequenceClickInterval).toBeCloseTo(barDuration, 1)
  expect(clickEvidence.beatOffset).toBe(cueSeconds)
  expect(clickEvidence.beatLoopStart).toBe(cueSeconds)
  expect(clickEvidence.beatLoopEnd).toBe(loopEndSeconds)
  expect(clickEvidence.beatDuration).toBeCloseTo(10, 2)
  expect(clickEvidence.firstClickPcm).not.toBeNull()
  expect(clickEvidence.sequenceClickPcm).not.toBeNull()
  expect(clickEvidence.firstBeatPcm).not.toBeNull()
  expect(Math.abs(clickEvidence.pcmOnsetDelta ?? Number.POSITIVE_INFINITY)).toBeLessThan(0.1)
  expect(clickEvidence.metronomeGain).toBeCloseTo(0.4, 1)

  const tempoMark = await page.evaluate(() => window.__countInQa!.oscillators.at(-1)!.node.context.currentTime)
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const bpmInput = page.getByRole('spinbutton', { name: 'BPM', exact: true })
  await expect(bpmRange).toBeEnabled()
  await bpmInput.fill('160')
  await expect(bpmInput).toHaveValue('160')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()

  await expect(status).toContainText('Auto-generate · combo 1 · Q&A · answer pause · cycle 2.', { timeout: 12_000 })
  const boundaryHandle = await page.waitForFunction(() => {
    const text = document.querySelector('.transport-status')?.textContent?.trim() ?? ''
    const match = /^Auto-generate · combo (\d+) · Q&A · question playback · cycle (\d+)\.$/.exec(text)
    if (!match || Number(match[1]) <= 1) return false
    return { planIndex: Number(match[1]), cycleNumber: Number(match[2]), status: text }
  }, undefined, { timeout: 12_000 })
  const boundary = await boundaryHandle.jsonValue() as { planIndex: number; cycleNumber: number; status: string }
  expect(boundary.planIndex).toBeGreaterThan(1)
  expect(boundary.cycleNumber).toBeGreaterThan(2)
  expect(boundary.status).not.toContain('Count-in')
  const repeatedCountInStatuses = await page.evaluate((startIndex) =>
    window.__countInQa!.statusTexts.slice(startIndex).filter((text) => text.startsWith('Count-in')),
  postCountInStatusIndex)
  expect(repeatedCountInStatuses).toEqual([])
  const continuity = await page.evaluate((data) => {
    const entries = window.__countInQa!.oscillators.slice(data.startIndex)
    const ordered = [...entries].sort((left, right) => left.when - right.when)
    return {
      count: ordered.length,
      intervals: ordered.slice(1).map((entry, index) => entry.when - ordered[index]!.when),
      intervalsAfterTempo: ordered.slice(1).filter((entry) => entry.when > data.tempoMark)
        .map((entry) => entry.when - ordered[ordered.indexOf(entry) - 1]!.when),
      frequencies: ordered.map((entry) => entry.frequency),
    }
  }, { startIndex: run.oscillators, tempoMark })
  expect(continuity.count).toBeGreaterThan(12)
  expect(Math.max(...continuity.intervals)).toBeLessThan(0.5)
  expect(continuity.intervalsAfterTempo.length).toBeGreaterThan(4)
  for (const interval of continuity.intervalsAfterTempo.slice(-5)) {
    expect(interval).toBeCloseTo(60 / 160, 1)
  }
  await expect(status).not.toContainText('Count-in')

  const audioEvidenceDirectory = path.resolve(process.cwd(), '.forge', 'count-in-qa-results', browserLabel())
  mkdirSync(audioEvidenceDirectory, { recursive: true })
  writeFileSync(path.join(audioEvidenceDirectory, 'audio-timing.json'), JSON.stringify({
    browser: browserLabel(),
    countInBars: 1,
    beatsPerBar: 4,
    practiceBpm,
    liveBpmAfterChange: 160,
    metronomeVolumePercent: 40,
    estimatedProcessorDelaySeconds: 0.13,
    pcmOnsetToleranceSeconds: 0.1,
    onset: clickEvidence,
    autoGenerateBoundary: boundary,
    repeatedCountInStatuses,
    clickContinuity: continuity,
  }, null, 2))

  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
})

async function openSaveManager(page: Page): Promise<void> {
  const manager = page.locator('details').filter({ hasText: 'Save and manage sessions' }).first()
  if (!(await manager.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await page.getByText('Save and manage sessions', { exact: true }).click()
  }
}

async function readOrRemoveSettings(page: Page, remove: boolean): Promise<Record<string, unknown>> {
  return page.evaluate(async (shouldRemove) => {
    const request = indexedDB.open('scratch-combo-sessions-v1', 1)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = database.transaction('payloads', shouldRemove ? 'readwrite' : 'readonly')
        const store = transaction.objectStore('payloads')
        const getAll = store.getAll()
        getAll.onsuccess = () => {
          const records = getAll.result as Array<{ kind: string; snapshot?: Record<string, unknown> }>
          const sessions = records.filter((entry) => entry.kind === 'session' && entry.snapshot)
          if (sessions.length !== 1 || !sessions[0]?.snapshot) {
            reject(new Error(`Expected one saved session payload, found ${sessions.length}.`))
            transaction.abort()
            return
          }
          const snapshot = sessions[0].snapshot
          const result = {
            countInBars: snapshot.countInBars,
            metronomeEnabled: snapshot.metronomeEnabled,
            metronomeVolume: snapshot.metronomeVolume,
          }
          if (shouldRemove) {
            delete snapshot.countInBars
            delete snapshot.metronomeEnabled
            delete snapshot.metronomeVolume
            store.put(sessions[0])
          }
          transaction.oncomplete = () => resolve(result)
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error ?? new Error('Saved-session fixture update was aborted.'))
        }
        getAll.onerror = () => reject(getAll.error)
      })
    } finally {
      database.close()
    }
  }, remove)
}

async function capturePrepScreenshots(page: Page): Promise<void> {
  const browser = browserLabel()
  const imageDirectory = path.resolve(process.cwd(), 'docs', 'images', 'count-in-metronome')
  mkdirSync(imageDirectory, { recursive: true })
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const panel = page.locator('.playback-prep')
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.style.scrollBehavior = 'auto'
    })
    await panel.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#count-in-bars')?.focus({ preventScroll: true })
    })
    await expect(page.locator('#count-in-bars')).toBeFocused()
    await expect(page.locator('#count-in-bars')).toBeInViewport()
    await expect(page.locator('#metronome-enabled')).toBeInViewport()
    await expect(page.locator('#metronome-volume')).toBeInViewport()
    const geometry = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        centerY: rect.top + rect.height / 2,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(-1)
    expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(geometry.width).toBeGreaterThan(0)
    expect(Math.abs(geometry.centerY - geometry.viewportHeight / 2)).toBeLessThan(40)
    expect(geometry.pageWidth).toBeLessThanOrEqual(viewport.width + 1)
    await page.screenshot({
      path: path.join(imageDirectory, `count-in-metronome-${browser}-${viewport.name}.png`),
      fullPage: false,
    })
  }
}

test('saved count-in settings round-trip, legacy fields default off, and controls fit focused desktop/mobile views', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()

  const countIn = page.locator('#count-in-bars')
  const metronome = page.locator('#metronome-enabled')
  const clickLevel = page.locator('#metronome-volume')
  await expect(countIn).toHaveValue('0')
  await expect(metronome).not.toBeChecked()
  await expect(clickLevel).toHaveValue('60')
  await expect(clickLevel).toBeDisabled()

  await countIn.selectOption('2')
  await metronome.check()
  await setRangeValue(page, '#metronome-volume', 37)
  await openSaveManager(page)
  await page.getByRole('textbox', { name: 'Session name' }).fill('QA Count-in Settings')
  await page.getByRole('button', { name: 'Save as new session' }).click()
  await expect(page.getByRole('combobox', { name: 'Session' })).toContainText('QA Count-in Settings')
  const persisted = await readOrRemoveSettings(page, false)
  expect(persisted).toEqual({ countInBars: 2, metronomeEnabled: true, metronomeVolume: 37 })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Reload last saved' }).click()
  await expect(countIn).toHaveValue('2')
  await expect(metronome).toBeChecked()
  await expect(clickLevel).toHaveValue('37')
  await expect(clickLevel).toBeEnabled()
  await capturePrepScreenshots(page)

  const removed = await readOrRemoveSettings(page, true)
  expect(removed).toEqual({ countInBars: 2, metronomeEnabled: true, metronomeVolume: 37 })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Reload last saved' }).click()
  await expect(countIn).toHaveValue('0')
  await expect(metronome).not.toBeChecked()
  await expect(clickLevel).toHaveValue('60')
  await expect(clickLevel).toBeDisabled()
  await expect(countIn).toBeEnabled({ timeout: 15_000 })
})
