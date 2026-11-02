import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window {
    __workspaceQa?: {
      beatStarts: number
      beatStops: number
      randomCalls: number
    }
  }
}

async function instrumentWorkspace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa = { beatStarts: 0, beatStops: 0, randomCalls: 0 }
    const beatSources = new WeakSet<AudioBufferSourceNode>()
    window.__workspaceQa = qa

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
    const originalRandom = Math.random
    Math.random = function () {
      qa.randomCalls += 1
      return originalRandom.call(Math)
    }
  })
}

async function openWorkspace(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await expect(page.getByLabel('Quick preset')).toHaveValue('SSC-085BPM-01')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByLabel('Current session files')).toContainText('85 BPM - Beginner', { timeout: 60_000 })
  await expect(page.locator('.import-current__count')).toContainText('66 WAV files in session')
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Generated combo|Sequence preview/ })).toBeVisible()
  await expect(page.locator('.timeline-scroll')).toBeVisible()
}

async function eventIds(page: Page): Promise<string[]> {
  return page.locator('.sequence-event[data-event-id]').evaluateAll((events) =>
    events.map((event) => event.getAttribute('data-event-id') ?? ''),
  )
}

async function activeBeatCounts(page: Page): Promise<{ starts: number; stops: number }> {
  return page.evaluate(() => ({
    starts: window.__workspaceQa?.beatStarts ?? 0,
    stops: window.__workspaceQa?.beatStops ?? 0,
  }))
}

async function blurToPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

test('workspace tabs and direct hashes preserve the live 85 BPM sequence, TTM view, and global transport', async ({ page }) => {
  await instrumentWorkspace(page)

  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Practice', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('tab', { name: 'Practice', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#panel-practice')).toBeFocused()
  await page.goForward()
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true')

  for (const route of [
    { hash: '#sequence-section', tab: 'Practice', panel: '#panel-practice' },
    { hash: '#session-section', tab: 'Session', panel: '#panel-session' },
    { hash: '#sample-section', tab: 'Samples', panel: '#panel-samples' },
    { hash: '#import-heading', tab: 'Files', panel: '#panel-files' },
  ]) {
    await page.goto('/' + route.hash)
    await expect(page.getByRole('tab', { name: route.tab, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(route.panel)).toBeVisible()
  }

  await openWorkspace(page)
  const practiceTab = page.getByRole('tab', { name: 'Practice', exact: true })
  const sessionTab = page.getByRole('tab', { name: 'Session', exact: true })
  const filesTab = page.getByRole('tab', { name: 'Files', exact: true })
  await practiceTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(sessionTab).toHaveAttribute('aria-selected', 'true')
  await expect(sessionTab).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(practiceTab).toHaveAttribute('aria-selected', 'true')
  await practiceTab.focus()
  await page.keyboard.press('ArrowDown')
  await expect(sessionTab).toHaveAttribute('aria-selected', 'true')
  await expect(sessionTab).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(practiceTab).toHaveAttribute('aria-selected', 'true')
  await practiceTab.focus()
  await page.keyboard.press('End')
  await expect(filesTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(practiceTab).toHaveAttribute('aria-selected', 'true')

  const ttmView = page.getByRole('radio', { name: 'TTM practice guides' })
  await expect(ttmView).toBeEnabled()
  await ttmView.check()
  await expect(page.locator('.sequence-ttm-motion path').first()).toBeVisible()
  const originalEventIds = await eventIds(page)
  expect(originalEventIds.length).toBeGreaterThan(0)

  await blurToPage(page)
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect(page.locator('.transport-status')).not.toHaveText('Playback stopped.')
  await expect.poll(async () => (await activeBeatCounts(page)).starts).toBe(1)
  await expect(page.locator('.timeline-lane--active .timeline-now-playing')).toBeVisible()

  const inlineLayout = page.getByRole('radio', { name: 'Inline' })
  await inlineLayout.check()
  const inlineActiveEvent = page.locator('.timeline-inline-row .sequence-event--active[data-event-id]')
  await expect(inlineActiveEvent).toHaveCount(1)
  await expect(inlineActiveEvent).toHaveAttribute('title', /Now playing ·/)
  await page.getByRole('radio', { name: 'Waveform' }).check()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  await ttmView.check()
  await expect(page.locator('.sequence-ttm-motion path').first()).toBeVisible()

  let lastPosition = Number(await page.locator('.timeline-scroll').getAttribute('data-presentation-position-units'))
  for (const tabName of ['Session', 'Samples', 'Files']) {
    await page.getByRole('tab', { name: tabName, exact: true }).click()
    await expect(page.getByRole('tab', { name: tabName, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
    await expect(page.locator('.transport-status')).toBeVisible()
    await expect.poll(async () => Number(await page.locator('.timeline-scroll').getAttribute('data-presentation-position-units')))
      .toBeGreaterThan(lastPosition)
    lastPosition = Number(await page.locator('.timeline-scroll').getAttribute('data-presentation-position-units'))
    expect(await activeBeatCounts(page)).toEqual({ starts: 1, stops: 0 })
  }

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Inline' })).toBeChecked()
  await expect(ttmView).toBeChecked()
  await expect(page.locator('.sequence-ttm-motion path').first()).toBeVisible()
  await expect(page.locator('.timeline-playhead')).toBeVisible()
  const returnedActiveEvent = page.locator('.timeline-inline-row .sequence-event--active[data-event-id]')
  await expect(returnedActiveEvent).toBeVisible()
  await expect(returnedActiveEvent).toHaveAttribute('title', /Now playing ·/)
  expect((await eventIds(page)).sort()).toEqual(originalEventIds.slice().sort())
  expect(await activeBeatCounts(page)).toEqual({ starts: 1, stops: 0 })

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  expect(await activeBeatCounts(page)).toEqual({ starts: 1, stops: 1 })
})

test('single-character shortcuts work, ignore interactive and modified keys, and restore shortcut-help focus', async ({ page }) => {
  await instrumentWorkspace(page)
  await openWorkspace(page)

  const helpButton = page.getByRole('button', { name: 'Keyboard shortcuts' })
  await helpButton.click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close shortcuts' })).toBeFocused()
  const shortcutToggle = page.getByLabel('Enable single-character shortcuts')
  await expect(shortcutToggle).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(helpButton).toBeFocused()

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  const bpm = page.getByRole('spinbutton', { name: 'BPM', exact: true })
  await bpm.fill('96')
  await blurToPage(page)
  await page.keyboard.press('r')
  await expect(bpm).toHaveValue('85')

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  const quickPreset = page.getByLabel('Quick preset')
  await quickPreset.focus()
  const randomCallsBeforeGuard = await page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)
  await page.keyboard.press('g')
  expect(await page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)).toBe(randomCallsBeforeGuard)
  await page.getByRole('tab', { name: 'Practice', exact: true }).click()

  await blurToPage(page)
  const randomCallsBeforeGenerate = await page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)
  await page.keyboard.press('g')
  await expect.poll(() => page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)).toBeGreaterThan(randomCallsBeforeGenerate)
  await expect(page.locator('.timeline-scroll')).toBeVisible()

  await page.getByRole('tab', { name: 'Session', exact: true }).click()
  await bpm.fill('96')
  await page.getByRole('button', { name: 'Play sequence' }).focus()
  const randomCallsBeforeButtonGuard = await page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)
  await page.keyboard.press('g')
  expect(await page.evaluate(() => window.__workspaceQa?.randomCalls ?? 0)).toBe(randomCallsBeforeButtonGuard)
  await blurToPage(page)
  await page.keyboard.press('r')
  await expect(bpm).toHaveValue('85')

  await blurToPage(page)
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(async () => (await activeBeatCounts(page)).starts).toBe(1)

  await bpm.focus()
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  await expect.poll(async () => activeBeatCounts(page)).toEqual({ starts: 1, stops: 0 })

  await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  const inlineRadio = page.getByRole('radio', { name: 'Inline' })
  await inlineRadio.focus()
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()

  await helpButton.focus()
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', repeat: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  expect(await activeBeatCounts(page)).toEqual({ starts: 1, stops: 0 })

  await helpButton.click()
  await expect(dialog).toBeVisible()
  await shortcutToggle.uncheck()
  await expect(page.getByText('Single-character shortcuts are off. This help button remains available.')).toBeVisible()
  await page.getByRole('button', { name: 'Close shortcuts' }).click()
  await expect(helpButton).toBeFocused()
  await blurToPage(page)
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled()
  expect(await activeBeatCounts(page)).toEqual({ starts: 1, stops: 0 })

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.transport-status')).toHaveText('Playback stopped.')
  await helpButton.click()
  await expect(shortcutToggle).not.toBeChecked()
  await shortcutToggle.check()
  await page.getByRole('button', { name: 'Close shortcuts' }).click()
  await expect(helpButton).toBeFocused()
})
