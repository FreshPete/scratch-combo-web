import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

declare global {
  interface Window {
    __generationQa?: {
      randomEnabled: boolean
      randomValue: number
      loopStarts: number
      loopStops: number
      blockNextDecode: boolean
      decodeBlocked: boolean
      releaseDecode: (() => void) | null
    }
  }
}

function makeWav(frequency: number, durationSeconds = 0.1): Buffer {
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
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.35
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function makeIni(): string {
  const sample = (index: 1 | 2, name: string, fileName: string, ticks: number) => [
    '',
    `[Sample${String(index).padStart(2, '0')}]`,
    'SamplePlayFq=1',
    'SampleIsSilent=False',
    'SampleRepeatsPoss=True',
    'SampleRepeatMax=100',
    `SampleFileName=${fileName}`,
    `SampleDisplayName=${name}`,
    'SampleStartsForward=True',
    'SampleEndsForward=False',
    `Sample16ths=${ticks}`,
    'UseSample=True',
  ]
  return [
    '[Samples]',
    'CONFIGNAME=Dynamic boundary fixture',
    'VOL_B=35',
    'VOL_S=75',
    'RootSamplePathRelative=True',
    'RootSamplePath=assets',
    'Beat01=dynamic-bed.wav',
    'BPM01=600',
    ...sample(1, 'Alpha', 'alpha.wav', 8),
    ...sample(2, 'Beta', 'beta.wav', 16),
    '',
  ].join('\r\n')
}

async function installGenerationInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      randomEnabled: false,
      randomValue: 0.5,
      loopStarts: 0,
      loopStops: 0,
      blockNextDecode: false,
      decodeBlocked: false,
      releaseDecode: null as (() => void) | null,
    }
    window.__generationQa = state
    const originalRandom = Math.random.bind(Math)
    Math.random = () => state.randomEnabled ? state.randomValue : originalRandom()

    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (this.loop) state.loopStarts += 1
      return originalStart.call(this, when, offset, duration)
    }
    const originalStop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      if (this.loop) state.loopStops += 1
      return originalStop.call(this, when)
    }

    const originalDecode = AudioContext.prototype.decodeAudioData
    AudioContext.prototype.decodeAudioData = function (data: ArrayBuffer) {
      const decoded = originalDecode.call(this, data)
      if (!state.blockNextDecode) return decoded
      state.blockNextDecode = false
      state.decodeBlocked = true
      return new Promise<AudioBuffer>((resolve, reject) => {
        state.releaseDecode = () => { void decoded.then(resolve, reject) }
      })
    }
  })
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Choose WAV files').setInputFiles([
    { name: 'alpha.wav', buffer: makeWav(440), mimeType: 'audio/wav' },
    { name: 'beta.wav', buffer: makeWav(660), mimeType: 'audio/wav' },
    { name: 'dynamic-bed.wav', buffer: makeWav(110, 0.4), mimeType: 'audio/wav' },
  ])
  await page.getByLabel('Choose INI preset').setInputFiles({
    name: 'dynamic-boundary.ini',
    buffer: Buffer.from(makeIni()),
    mimeType: 'text/plain',
  })
  await expect(page.locator('.import-status__copy p')).toContainText('2 samples and 1 beat files resolved')
  await page.getByLabel('Combo length').selectOption('4')
  await page.evaluate(() => { window.__generationQa!.randomEnabled = true; window.__generationQa!.randomValue = 0 })
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 8 events' })).toBeVisible()
  await expect(page.locator('.timeline-lane-label')).toContainText('Alpha')
  await expect(page.getByRole('checkbox', { name: /Auto-generate/ })).not.toBeChecked()
  await expect(page.getByLabel('New combo every')).toHaveValue('2')
  await expect(page.getByLabel('New combo every')).toBeDisabled()
}

async function generateAlphaAgain(page: Page): Promise<void> {
  await page.evaluate(() => { window.__generationQa!.randomEnabled = true; window.__generationQa!.randomValue = 0 })
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 8 events' })).toBeVisible()
  await expect(page.locator('.timeline-lane-label')).toContainText('Alpha')
}

async function runRoundBoundary(
  page: Page,
  mode: 'Loop' | 'Q&A',
  rounds: 1 | 2 | 4 | 8,
  largePause = false,
): Promise<void> {
  const status = page.locator('.transport-status')
  const autoGenerate = page.getByRole('checkbox', { name: /Auto-generate/ })
  const roundsSelect = page.getByLabel('New combo every')
  const modeControl = page.getByRole('radio', { name: mode })
  if (!(await modeControl.isChecked())) await modeControl.check()
  const largePauseControl = page.getByRole('checkbox', { name: /Large pause/ })
  if (mode === 'Q&A' && (await largePauseControl.isChecked()) !== largePause) {
    if (largePause) await largePauseControl.check()
    else await largePauseControl.uncheck()
  }
  await autoGenerate.check()
  await roundsSelect.selectOption(String(rounds))
  await page.evaluate(() => { window.__generationQa!.randomEnabled = true; window.__generationQa!.randomValue = 0.75 })
  const loopStartsBefore = await page.evaluate(() => window.__generationQa!.loopStarts)
  const loopStopsBefore = await page.evaluate(() => window.__generationQa!.loopStops)
  await page.getByRole('button', { name: 'Play sequence' }).click()

  await expect.poll(() => status.innerText()).toContain('Auto-generate · combo 1 ·')
  await expect(status).toContainText(mode === 'Loop' ? 'Loop · combo cycle 1.' : 'Q&A · question playback · cycle 1.')
  await expect.poll(() => page.evaluate(() => window.__generationQa!.loopStarts)).toBe(loopStartsBefore + 1)
  await expect(page.locator('.sequence-event')).toHaveCount(8)

  await expect(page.locator('.sequence-event')).toHaveCount(8)
  await expect(page.locator('.timeline-figure')).toHaveCount(1)
  await expect(page.locator('.timeline-bar-row')).toHaveCount(1)
  await expect(page.locator('.timeline-ruler-row')).toHaveCount(1)

  const slotCount = mode === 'Loop' ? 1 : largePause ? 4 : 2
  const nextCycleNumber = rounds * slotCount + 1
  const timeout = rounds * slotCount * 500 + 5_000
  await expect.poll(() => status.innerText(), { timeout, intervals: [50, 100, 200] })
    .toContain('Auto-generate · combo 2 ·')
  await expect(status).toContainText(mode === 'Loop'
    ? `Auto-generate · combo 2 · Loop · combo cycle ${nextCycleNumber}.`
    : `Auto-generate · combo 2 · Q&A · question playback · cycle ${nextCycleNumber}.`)

  await expect(page.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })).toBeVisible()
  await expect(page.locator('.timeline-lane-label')).toContainText('Beta')
  await expect(page.locator('.timeline-lane-label')).not.toContainText('Alpha')
  await expect(page.locator('.sequence-event')).toHaveCount(4)
  await expect(page.locator('.timeline-figure')).toHaveCount(1)
  await expect(page.locator('.timeline-bar-row')).toHaveCount(1)
  await expect(page.locator('.timeline-ruler-row')).toHaveCount(1)
  expect(await page.evaluate(() => window.__generationQa!.loopStarts)).toBe(loopStartsBefore + 1)
  expect(await page.evaluate(() => window.__generationQa!.loopStops)).toBe(loopStopsBefore)
}

test('Auto-generate offers 1/2/4/8 rounds and swaps only at representative full Loop, Q&A, and large-pause boundaries', async ({ page }) => {
  test.setTimeout(60_000)
  await installGenerationInstrumentation(page)
  await loadFixture(page)
  const autoGenerate = page.getByRole('checkbox', { name: /Auto-generate/ })
  const roundsSelect = page.getByLabel('New combo every')
  await autoGenerate.check()
  for (const rounds of [1, 2, 4, 8] as const) {
    await roundsSelect.selectOption(String(rounds))
    await expect(roundsSelect).toHaveValue(String(rounds))
  }
  await autoGenerate.uncheck()

  await page.getByRole('radio', { name: 'Loop' }).check()
  await runRoundBoundary(page, 'Loop', 2)
  const proofDirectory = path.resolve(process.cwd(), 'test-results')
  mkdirSync(proofDirectory, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#sequence-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: path.join(proofDirectory, 'integrated-auto-generate-boundary.png'), fullPage: false })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  await autoGenerate.uncheck()
  await generateAlphaAgain(page)
  await page.getByRole('radio', { name: 'Q&A' }).check()
  await runRoundBoundary(page, 'Q&A', 1)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')

  await autoGenerate.uncheck()
  await generateAlphaAgain(page)
  await runRoundBoundary(page, 'Q&A', 1, true)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
})

test('structural controls lock during audio loading and playback, then unlock on Stop while live controls stay available', async ({ page }) => {
  await installGenerationInstrumentation(page)
  await loadFixture(page)
  const status = page.locator('.transport-status')
  const autoGenerate = page.getByRole('checkbox', { name: /Auto-generate/ })
  const roundsSelect = page.getByLabel('New combo every')
  const comboLength = page.getByLabel('Combo length')
  const generate = page.getByRole('button', { name: 'Generate combo' })
  const mode = page.getByRole('radio', { name: 'Q&A' })
  const largePause = page.getByRole('checkbox', { name: /Large pause/ })
  const editSample = page.getByRole('button', { name: 'Edit Alpha' })
  const stop = page.getByRole('button', { name: 'Stop' })
  const liveControls = [
    page.getByRole('spinbutton', { name: 'BPM' }),
    page.getByRole('slider', { name: 'BPM range' }),
    page.getByRole('slider', { name: 'Pitch shift in semitones' }),
    page.getByRole('slider', { name: 'Sample level' }),
    page.getByRole('slider', { name: 'Beat level' }),
    page.getByRole('button', { name: 'Reset controls' }),
  ]
  await expect(editSample).toBeEnabled()
  await expect(page.getByLabel('Quick preset')).toBeEnabled()
  await autoGenerate.check()
  await roundsSelect.selectOption('2')
  await page.evaluate(() => { window.__generationQa!.blockNextDecode = true })
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect.poll(() => page.evaluate(() => window.__generationQa!.decodeBlocked)).toBe(true)
  await expect(status).toHaveText('Preparing preview audio.')

  for (const control of [autoGenerate, roundsSelect, comboLength, generate, mode, largePause, editSample, page.getByLabel('Quick preset')]) {
    await expect(control).toBeDisabled()
  }
  await expect(stop).toBeEnabled()
  for (const control of liveControls) await expect(control).toBeEnabled()
  await expect(page.getByText('Stop playback to change combo options or sample settings.')).toBeVisible()

  await page.evaluate(() => window.__generationQa!.releaseDecode?.())
  await expect(status).toContainText('Q&A · question playback · cycle 1.', { timeout: 10_000 })
  await expect(stop).toBeEnabled()
  for (const control of [autoGenerate, roundsSelect, comboLength, generate, mode, largePause, editSample, page.getByLabel('Quick preset')]) {
    await expect(control).toBeDisabled()
  }
  for (const control of liveControls) await expect(control).toBeEnabled()
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
  for (const control of [autoGenerate, comboLength, generate, mode, editSample, page.getByLabel('Quick preset')]) {
    await expect(control).toBeEnabled()
  }
  await expect(roundsSelect).toBeEnabled()
  await expect(largePause).toBeEnabled()
})
