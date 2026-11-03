import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createValidWizardFixture } from './fixtures/import-wizard-fixtures'
import { loadLocalImport } from './helpers/import-wizard'

declare global {
  interface Window {
    __pauseResumeQa?: {
      contexts: AudioContext[]
      bufferStarts: Array<{ node: AudioBufferSourceNode; when: number; callTime: number }>
      oscillatorStarts: Array<{ node: OscillatorNode; when: number; callTime: number }>
      statusTexts: string[]
    }
  }
}

test.describe.configure({ timeout: 90_000 })

async function installWebAudioInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = {
      contexts: [] as AudioContext[],
      bufferStarts: [] as Array<{ node: AudioBufferSourceNode; when: number; callTime: number }>,
      oscillatorStarts: [] as Array<{ node: OscillatorNode; when: number; callTime: number }>,
      statusTexts: [] as string[],
    }
    window.__pauseResumeQa = qa

    const originalBufferStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (!qa.contexts.includes(this.context)) qa.contexts.push(this.context)
      qa.bufferStarts.push({
        node: this,
        when: when ?? this.context.currentTime,
        callTime: this.context.currentTime,
      })
      return originalBufferStart.call(this, when, offset, duration)
    }

    const originalOscillatorStart = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (when?: number) {
      if (!qa.contexts.includes(this.context)) qa.contexts.push(this.context)
      qa.oscillatorStarts.push({
        node: this,
        when: when ?? this.context.currentTime,
        callTime: this.context.currentTime,
      })
      return originalOscillatorStart.call(this, when)
    }

    let observedStatus: HTMLElement | null = null
    let statusObserver: MutationObserver | null = null
    let previousText = ''
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
      if (text && text !== previousText) {
        previousText = text
        qa.statusTexts.push(text)
      }
    }
    window.setInterval(recordStatus, 15)
  })
}

async function loadPracticeFixture(page: Page, scenario: string, fixtureRoot: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })

  const fixture = await createValidWizardFixture(path.resolve(fixtureRoot, scenario))
  await loadLocalImport(page, fixture.iniPath, fixture.audioDirectory, 'Wizard Memory Fixture', 'folder')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await page.getByLabel('Combo length').selectOption('4')
  await page.getByRole('button', { name: 'Generate combo', exact: true }).click()
  await expect(page.getByRole('img', { name: /Sequence timeline:/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play sequence', exact: true })).toBeEnabled()
}

async function readAudioState(page: Page): Promise<{
  state: AudioContextState | null
  currentTime: number | null
  bufferStarts: number
  oscillatorStarts: number
  progress: number
}> {
  return page.evaluate(() => {
    const qa = window.__pauseResumeQa
    const context = qa?.contexts.at(-1)
    const progress = document.querySelector<HTMLProgressElement>('progress[aria-label="Preview progress"]')
    return {
      state: context?.state ?? null,
      currentTime: context?.currentTime ?? null,
      bufferStarts: qa?.bufferStarts.length ?? 0,
      oscillatorStarts: qa?.oscillatorStarts.length ?? 0,
      progress: progress?.value ?? 0,
    }
  })
}

async function waitForAudioContextState(page: Page, state: AudioContextState): Promise<void> {
  await expect.poll(async () => (await readAudioState(page)).state, { timeout: 10_000, intervals: [20, 40, 80] }).toBe(state)
}

async function capturePausedState(page: Page, name: string): Promise<void> {
  const browser = (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const viewport = process.env.PLAYWRIGHT_MOBILE === '1' ? 'mobile' : 'desktop'
  const directory = path.resolve(process.cwd(), 'docs', 'images', 'pause-resume')
  mkdirSync(directory, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: path.join(directory, `${name}-${browser}-${viewport}.png`), fullPage: true })
}

test('pause freezes the real audio clock and progress, resume continues the same run, and Stop works while paused', async ({ page }, testInfo) => {
  await installWebAudioInstrumentation(page)
  await loadPracticeFixture(page, 'playback-pause', testInfo.outputPath('fixture'))

  const status = page.locator('.transport-status')
  const progress = page.getByRole('progressbar', { name: 'Preview progress' })
  const play = page.getByRole('button', { name: 'Play sequence', exact: true })
  const pause = page.getByRole('button', { name: 'Pause playback', exact: true })
  const resume = page.getByRole('button', { name: 'Resume playback', exact: true })
  const stop = page.getByRole('button', { name: 'Stop', exact: true })

  await play.click()
  await expect(pause).toBeEnabled({ timeout: 10_000 })
  await waitForAudioContextState(page, 'running')
  await expect.poll(async () => (await readAudioState(page)).progress, { timeout: 10_000, intervals: [20, 40, 80] }).toBeGreaterThan(0.02)

  await pause.click()
  await expect(resume).toBeEnabled()
  await expect(status).toHaveText('Playback paused. Press Resume playback to continue.')
  await waitForAudioContextState(page, 'suspended')
  const paused = await readAudioState(page)
  expect(paused.currentTime).not.toBeNull()
  expect(paused.progress).toBeGreaterThan(0)

  await page.waitForTimeout(450)
  const stillPaused = await readAudioState(page)
  expect(stillPaused.state).toBe('suspended')
  expect(Math.abs(stillPaused.currentTime! - paused.currentTime!)).toBeLessThan(0.01)
  expect(Math.abs(stillPaused.progress - paused.progress)).toBeLessThan(0.005)
  expect(stillPaused.bufferStarts).toBe(paused.bufferStarts)
  expect(stillPaused.oscillatorStarts).toBe(paused.oscillatorStarts)
  await capturePausedState(page, 'playback-paused')

  await resume.click()
  await expect(pause).toBeEnabled()
  await waitForAudioContextState(page, 'running')
  await expect.poll(async () => (await readAudioState(page)).currentTime, { timeout: 5_000, intervals: [20, 40, 80] })
    .toBeGreaterThan(paused.currentTime! + 0.15)
  await expect.poll(async () => (await readAudioState(page)).progress, { timeout: 5_000, intervals: [20, 40, 80] })
    .toBeGreaterThan(paused.progress + 0.01)

  await pause.click()
  await expect(resume).toBeEnabled()
  await expect(status).toContainText('Playback paused.')
  await waitForAudioContextState(page, 'suspended')
  await expect(stop).toBeEnabled()

  const beforeStop = await readAudioState(page)
  await stop.click()
  await expect(status).toHaveText('Playback stopped.')
  await expect(progress).toHaveAttribute('value', '0')
  await expect(play).toBeEnabled()
  await page.waitForTimeout(350)
  const afterStop = await readAudioState(page)
  expect(afterStop.bufferStarts).toBe(beforeStop.bufferStarts)
  expect(afterStop.oscillatorStarts).toBe(beforeStop.oscillatorStarts)
})

test('pause and resume preserve the current count-in beat without restarting the pre-roll', async ({ page }, testInfo) => {
  await installWebAudioInstrumentation(page)
  await loadPracticeFixture(page, 'count-in-pause', testInfo.outputPath('fixture'))

  const status = page.locator('.transport-status')
  const progress = page.getByRole('progressbar', { name: 'Preview progress' })
  const countIn = page.locator('#count-in-bars')
  const play = page.getByRole('button', { name: 'Play sequence', exact: true })
  const pause = page.getByRole('button', { name: 'Pause playback', exact: true })
  const resume = page.getByRole('button', { name: 'Resume playback', exact: true })

  await countIn.selectOption('2')
  await play.click()
  await expect(status).toHaveText('Count-in · beat 1 of 8.')
  await expect(pause).toBeEnabled()
  await expect(progress).toHaveAttribute('value', '0')

  await expect.poll(async () => {
    const match = (await status.innerText()).match(/^Count-in · beat (\d+) of 8\.$/)
    return match ? Number(match[1]) : 0
  }, { timeout: 3_000, intervals: [20, 40, 80] }).toBeGreaterThan(1)
  await pause.click()
  await expect(resume).toBeEnabled()
  const pausedStatus = await status.innerText()
  const pausedBeatMatch = pausedStatus.match(/^Playback paused · count-in beat (\d+) of 8\.$/)
  expect(pausedBeatMatch, `Expected a paused count-in status, got: ${pausedStatus}`).not.toBeNull()
  const pausedBeat = Number(pausedBeatMatch![1])
  expect(pausedBeat).toBeGreaterThan(1)

  await waitForAudioContextState(page, 'suspended')
  const paused = await readAudioState(page)
  const pausedStarts = { buffers: paused.bufferStarts, oscillators: paused.oscillatorStarts }
  await page.waitForTimeout(400)
  const stillPaused = await readAudioState(page)
  expect(await status.innerText()).toBe(pausedStatus)
  expect(Math.abs(stillPaused.currentTime! - paused.currentTime!)).toBeLessThan(0.01)
  expect(stillPaused.bufferStarts).toBe(pausedStarts.buffers)
  expect(stillPaused.oscillatorStarts).toBe(pausedStarts.oscillators)
  await capturePausedState(page, 'count-in-paused')

  const statusStartIndex = await page.evaluate(() => window.__pauseResumeQa?.statusTexts.length ?? 0)
  await resume.click()
  await expect(pause).toBeEnabled()
  await waitForAudioContextState(page, 'running')
  await expect(page.locator('.timeline-playhead').first()).toBeVisible({ timeout: 10_000 })

  const resumedCountInStatuses = await page.evaluate((startIndex) =>
    (window.__pauseResumeQa?.statusTexts.slice(startIndex) ?? [])
      .filter((text) => /^Count-in · beat \d+ of 8\.$/.test(text)), statusStartIndex)
  expect(resumedCountInStatuses.length).toBeGreaterThan(0)
  expect(resumedCountInStatuses).not.toContain('Count-in · beat 1 of 8.')
})
