import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { expectStepTwoFocus } from './helpers/import-wizard'
import {
  createDiagnosticWizardFixture,
  createDefaultLengthIncompatibleWizardFixture,
  createValidWizardFixture,
  makeWizardWav,
} from './fixtures/import-wizard-fixtures'

declare global {
  interface Window {
    __importWizardQa?: {
      audioSources: File[]
      sourceReadAttempts: number
      outputTaps: AnalyserNode[]
      workletNodes: number
      sourceStarts: Array<{ loop: boolean; when: number }>
    }
    __pendingSnapshotQa?: {
      blocked: boolean
      release: (() => void) | null
      files: File[]
    }
  }
}

async function instrumentLocalAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      audioSources: [] as File[],
      sourceReadAttempts: 0,
      outputTaps: [] as AnalyserNode[],
      workletNodes: 0,
      sourceStarts: [] as Array<{ loop: boolean; when: number }>,
    }
    window.__importWizardQa = qa

    document.addEventListener('change', (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return
      for (const file of Array.from(input.files ?? [])) {
        if (file.name.toLowerCase().endsWith('.wav') && !qa.audioSources.includes(file)) qa.audioSources.push(file)
      }
    }, true)

    const nativeConnect = AudioNode.prototype.connect as unknown as (
      this: AudioNode,
      ...args: unknown[]
    ) => AudioNode
    const instrumentedConnect = function (this: AudioNode, ...args: unknown[]): AudioNode {
      const destination = args[0]
      if (destination === this.context.destination) {
        const tap = this.context.createAnalyser()
        tap.fftSize = 2048
        qa.outputTaps.push(tap)
        nativeConnect.apply(this, [tap, ...args.slice(1)])
        nativeConnect.call(tap, destination)
        return destination as AudioNode
      }
      return nativeConnect.apply(this, args)
    }
    AudioNode.prototype.connect = instrumentedConnect as typeof AudioNode.prototype.connect

    const nativeStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      qa.sourceStarts.push({ loop: this.loop, when: when ?? this.context.currentTime })
      if (duration !== undefined) return nativeStart.call(this, when, offset, duration)
      if (offset !== undefined) return nativeStart.call(this, when, offset)
      return nativeStart.call(this, when)
    }

    if (typeof AudioWorkletNode !== 'undefined') {
      const NativeWorkletNode = window.AudioWorkletNode
      window.AudioWorkletNode = new Proxy(NativeWorkletNode, {
        construct(target, args, newTarget) {
          qa.workletNodes += 1
          return Reflect.construct(target, args, newTarget)
        },
      })
    }
  })
}

async function openYourFiles(page: Page): Promise<void> {
  await page.goto('/')
  const quickPreset = page.getByLabel('Quick preset')
  await expect(quickPreset).toBeVisible()
  await quickPreset.selectOption('custom')
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toBeFocused()
  await expect(page.getByLabel('Choose audio folder')).toHaveCount(0)
  await expect(page.getByLabel('Choose WAV files')).toHaveCount(0)
}

async function checkNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const measured = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(Math.max(measured.documentWidth, measured.bodyWidth), `wizard must fit at ${width}px`).toBeLessThanOrEqual(width + 1)
}

async function sealSelectedSourceFiles(page: Page): Promise<number> {
  return page.evaluate(() => {
    const qa = window.__importWizardQa
    if (!qa) throw new Error('The local audio QA probe was not installed.')
    for (const file of qa.audioSources) {
      Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: async () => {
          qa.sourceReadAttempts += 1
          throw new Error('The original picker File was read after Load preset.')
        },
      })
    }
    return qa.audioSources.length
  })
}

async function outputPeak(page: Page): Promise<number> {
  return page.evaluate(() => {
    const taps = window.__importWizardQa?.outputTaps ?? []
    return Math.max(0, ...taps.map((tap) => {
      const samples = new Float32Array(tap.fftSize)
      tap.getFloatTimeDomainData(samples)
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
    }))
  })
}

function expectLocalReadOnlyRequests(pageUrl: string, requests: Array<{ url: string; method: string }>): void {
  const externalOrMutating = requests.filter((request) => {
    const url = new URL(request.url)
    return url.origin !== new URL(pageUrl).origin || !['GET', 'HEAD'].includes(request.method)
  })
  expect(externalOrMutating).toEqual([])
}

test('folder import holds source bytes in memory, audits playback and stays editable at phone widths', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await instrumentLocalAudio(page)
  const requests: Array<{ url: string; method: string }> = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))

  const fixture = await createValidWizardFixture(testInfo.outputPath('folder-fixture'))
  await openYourFiles(page)
  await checkNoHorizontalOverflow(page, 390)

  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  const audioHeading = page.getByRole('heading', { name: 'Choose the audio files' })
  await expect(audioHeading).toBeVisible()
  await expectStepTwoFocus(page)
  await expect(page.getByLabel('Choose audio folder')).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toHaveCount(0)
  await expect(page.getByLabel('Choose WAV files')).toHaveCount(0)
  await checkNoHorizontalOverflow(page, 844)

  await page.getByLabel('Choose audio folder').setInputFiles(fixture.audioDirectory)
  await page.getByRole('button', { name: 'Review selection' }).click()
  const reviewHeading = page.getByRole('heading', { name: 'Review and load' })
  await expect(reviewHeading).toBeVisible({ timeout: 30_000 })
  await expect(reviewHeading).toBeFocused()
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await expect(page.getByText(/Samples\/WizardTone\.wav/)).toBeVisible()
  await expect(page.getByText(/Beats\/Bed\.wav/)).toBeVisible()
  await expect(page.getByLabel('Current session files')).not.toContainText('Wizard Memory Fixture')
  await checkNoHorizontalOverflow(page, 1280)
  await page.screenshot({ path: testInfo.outputPath('folder-review-1280.png'), fullPage: true })

  await page.getByRole('button', { name: 'Load preset' }).click()
  await expect(page.locator('.sequence-heading')).toContainText('Wizard Memory Fixture', { timeout: 30_000 })
  expect(await page.evaluate(() => window.__importWizardQa?.sourceStarts.length ?? 0)).toBe(0)
  await expect(page.getByLabel('Current session files')).toContainText('Wizard Memory Fixture')
  const selectedAudioFiles = await sealSelectedSourceFiles(page)
  expect(selectedAudioFiles).toBe(2)

  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  const previewSample = page.getByRole('button', { name: 'Preview Wizard Tone' })
  await expect(previewSample).toBeEnabled()
  await previewSample.click()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.workletNodes ?? 0)).toBeGreaterThan(0)
  await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.001)
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.sourceStarts.length ?? 0)).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.sourceReadAttempts ?? 0)).toBe(0)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const beatBed = page.getByLabel('Beat bed')
  await expect(beatBed).toBeEnabled()
  await beatBed.selectOption('0')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Generate combo' }).click()
  const timeline = page.getByRole('img', { name: /Sequence timeline: .*legacy ticks, \d+ events/ })
  await expect(timeline).toBeVisible()

  const loopStartsBeforePlay = await page.evaluate(() =>
    window.__importWizardQa?.sourceStarts.filter((start) => start.loop).length ?? 0,
  )
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toContainText('question playback')
  await expect.poll(() => page.evaluate(() =>
    window.__importWizardQa?.sourceStarts.filter((start) => start.loop).length ?? 0,
  )).toBeGreaterThan(loopStartsBeforePlay)
  await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.001)
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.sourceReadAttempts ?? 0)).toBe(0)

  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start another import' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect(page.locator('.transport-status')).not.toHaveText('Playback stopped.')
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Preview Wizard Tone' })).toBeDisabled()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(beatBed).toBeDisabled()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByLabel('Quick preset')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Generate combo' })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.sourceReadAttempts ?? 0)).toBe(0)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  await expect(page.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(timeline).toBeVisible()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toContainText('question playback')
  await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.001)
  await expect.poll(() => page.evaluate(() => window.__importWizardQa?.sourceReadAttempts ?? 0)).toBe(0)
  await page.getByRole('button', { name: 'Stop' }).click()

  const sourceNames = ['WizardTone.wav', 'Bed.wav']
  expect(requests.filter((request) => sourceNames.some((name) => request.url.includes(name)))).toEqual([])
  expectLocalReadOnlyRequests(page.url(), requests)
})

test('a valid preset loads when its sample cannot fill eight beats and can generate at four', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const fixture = await createDefaultLengthIncompatibleWizardFixture(testInfo.outputPath('short-fixture'))
  await openYourFiles(page)
  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  await page.getByLabel('Choose audio folder').setInputFiles(fixture.audioDirectory)
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()

  await expect(page.getByLabel('Current session files')).toContainText('Short Non-Repeating Fixture')
  await expect(page.getByRole('button', { name: 'Start another import' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('preset loaded, but its default 8-beat combo could not be prepared')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  const comboLength = page.getByLabel('Combo length')
  await expect(comboLength).toBeEnabled()
  await expect(comboLength).toHaveValue('8')
  await expect(page.getByRole('button', { name: 'Generate combo' })).toBeEnabled()

  await comboLength.selectOption('4')
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline: 64 legacy ticks/ })).toBeVisible()
  await expect(page.locator('.sequence-event')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('review explains nested matches, missing, ambiguous, and corrupt references; the multi-file fallback can repair them', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const fixture = await createDiagnosticWizardFixture(testInfo.outputPath('diagnostic-fixture'))
  await openYourFiles(page)
  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  await page.getByLabel('Choose audio folder').setInputFiles(fixture.audioDirectory)
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('heading', { name: 'Review and load' })).toBeFocused()
  await expect(page.getByLabel('Choose INI preset')).toHaveCount(0)
  await expect(page.getByLabel('Choose audio folder')).toHaveCount(0)
  await expect(page.getByLabel('Choose WAV files')).toHaveCount(0)

  const load = page.getByRole('button', { name: 'Load preset' })
  await expect(load).toBeDisabled()
  const reviewRow = (sampleName: string) => page.getByRole('row').filter({ hasText: sampleName })
  await expect(reviewRow('Wizard Tone')).toContainText('assets/Samples/WizardTone.wav')
  await expect(reviewRow('Missing Sample')).toContainText('Required WAV missing')
  await expect(reviewRow('Ambiguous Sample')).toContainText('Ambiguous')
  await expect(reviewRow('Ambiguous Sample')).toContainText('SessionA/Click.wav')
  await expect(reviewRow('Ambiguous Sample')).toContainText('SessionB/Click.wav')
  await expect(reviewRow('Corrupt Sample')).toContainText('WAV could not decode')

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByLabel('Choose audio folder')).toBeFocused()
  await expect(page.getByText('5 WAV files selected for this draft.')).toBeVisible()
  await page.getByRole('button', { name: 'Choose files instead' }).click()
  const wavPicker = page.getByLabel('Choose WAV files')
  await expect(wavPicker).toBeVisible()
  await expect(wavPicker).toBeFocused()
  await expect(page.getByLabel('Choose audio folder')).toHaveCount(0)
  await wavPicker.setInputFiles([
    { name: 'WizardTone.wav', buffer: await readFile(fixture.folderFiles.hit), mimeType: 'audio/wav' },
    { name: 'Required.wav', buffer: makeWizardWav(280), mimeType: 'audio/wav' },
    { name: 'Click.wav', buffer: makeWizardWav(660), mimeType: 'audio/wav' },
    { name: 'Corrupt.wav', buffer: makeWizardWav(770), mimeType: 'audio/wav' },
    { name: 'Bed.wav', buffer: await readFile(fixture.folderFiles.bed), mimeType: 'audio/wav' },
  ])
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('heading', { name: 'Review and load' })).toBeFocused()
  await expect(load).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(reviewRow('Missing Sample')).toContainText('Copied · audio decoded')
  await expect(reviewRow('Ambiguous Sample')).toContainText('Copied · audio decoded')
  await expect(reviewRow('Corrupt Sample')).toContainText('Copied · audio decoded')
  await page.getByRole('button', { name: 'Load preset' }).click()
  await expect(page.locator('.sequence-heading')).toContainText('Wizard Diagnostics Fixture', { timeout: 30_000 })
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByRole('button', { name: 'Generate combo' }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline: .*legacy ticks, \d+ events/ })).toBeVisible()
})

test('invalid INI keeps the active setup; Back preserves the valid draft and Cancel restores Quick preset focus', async ({ page }, testInfo) => {
  const fixture = await createValidWizardFixture(testInfo.outputPath('cancel-fixture'))
  await page.goto('/')
  await page.getByLabel('Quick preset').selectOption('demo')
  await expect(page.getByRole('heading', { name: 'Sequence preview' })).toBeVisible()
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const initialBpm = await page.getByRole('spinbutton', { name: 'BPM' }).inputValue()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Quick preset').selectOption('custom')

  await page.getByLabel('Choose INI preset').setInputFiles({
    name: 'invalid.ini',
    buffer: Buffer.from('[Samples]\r\nBPM01=not-a-number\r\n'),
    mimeType: 'text/plain',
  })
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('tab', { name: 'Samples', exact: true }).click()
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(3)
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(initialBpm)
  await page.getByRole('tab', { name: 'Files', exact: true }).click()

  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toBeFocused()
  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  await page.getByRole('button', { name: 'Choose files instead' }).click()
  await page.getByLabel('Choose WAV files').setInputFiles([
    { name: 'WizardTone.wav', buffer: makeWizardWav(440), mimeType: 'audio/wav' },
    { name: 'Bed.wav', buffer: makeWizardWav(110), mimeType: 'audio/wav' },
  ])
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('heading', { name: 'Review and load' })).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toBeFocused()
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByLabel('Quick preset')).toHaveValue('demo')
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(initialBpm)
})

test('Cancel aborts a pending WAV snapshot and leaves the active setup intact', async ({ page }, testInfo) => {
  const fixture = await createValidWizardFixture(testInfo.outputPath('pending-cancel-fixture'))
  await page.addInitScript(() => {
    const state = { blocked: false, release: null as (() => void) | null, files: [] as File[] }
    window.__pendingSnapshotQa = state
    document.addEventListener('change', (event) => {
      const input = event.target
      if (input instanceof HTMLInputElement && input.type === 'file') state.files.push(...Array.from(input.files ?? []))
    }, true)
  })
  await page.goto('/')
  await page.getByLabel('Quick preset').selectOption('custom')
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  const folderPicker = page.getByLabel('Choose audio folder')
  await folderPicker.setInputFiles(fixture.audioDirectory)
  await page.evaluate(() => {
    const file = window.__pendingSnapshotQa!.files.find((candidate) => candidate.name === 'WizardTone.wav')
    if (!file) throw new Error('The synthetic sample WAV was not present in the selected folder.')
    const read = file.arrayBuffer.bind(file)
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => new Promise<ArrayBuffer>((resolve) => {
        window.__pendingSnapshotQa!.blocked = true
        window.__pendingSnapshotQa!.release = () => { void read().then(resolve) }
      }),
    })
  })

  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect.poll(() => page.evaluate(() => window.__pendingSnapshotQa?.blocked)).toBe(true)
  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeEnabled()
  await cancel.click()
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toBeFocused()
  await expect(page.getByLabel('Current session files')).toContainText('85 BPM - Beginner')

  await page.evaluate(() => window.__pendingSnapshotQa?.release?.())
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Current session files')).toContainText('85 BPM - Beginner')
  await expect(page.getByLabel('Quick preset')).toHaveValue('SSC-085BPM-01')
})

test('a delayed startup preset cannot overwrite a reviewed and loaded local wizard draft', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const fixture = await createValidWizardFixture(testInfo.outputPath('stale-fixture'))
  let releaseStartup: () => void = () => {}
  let startupRequestStarted = false
  let startupRequestFinished = false
  const waitForStartup = new Promise<void>((resolve) => { releaseStartup = resolve })
  await page.route('**/private-presets/SSC-085BPM-01.ini', async (route) => {
    startupRequestStarted = true
    await waitForStartup
    try {
      await route.continue()
    } catch {
      // A custom load may correctly abort the stale startup response.
    }
    startupRequestFinished = true
  })

  await page.goto('/')
  await expect.poll(() => startupRequestStarted).toBe(true)
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.getByLabel('Choose INI preset').setInputFiles(fixture.iniPath)
  await expectStepTwoFocus(page)
  await page.getByLabel('Choose audio folder').setInputFiles(fixture.audioDirectory)
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('heading', { name: 'Review and load' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()
  await expect(page.locator('.sequence-heading')).toContainText('Wizard Memory Fixture', { timeout: 30_000 })

  releaseStartup()
  await expect.poll(() => startupRequestFinished).toBe(true)
  await expect(page.locator('.sequence-heading')).toContainText('Wizard Memory Fixture')
  await expect(page.getByLabel('Quick preset')).toHaveValue('custom')

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Quick preset').selectOption('demo')
  await expect(page.getByRole('heading', { name: 'Sequence preview' })).toBeVisible()
  await expect(page.getByLabel('Quick preset')).toHaveValue('demo')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
  await expect(page.getByLabel('Choose INI preset')).toBeEnabled()
})
