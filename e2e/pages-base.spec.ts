import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

test('production preview loads built-in media and its AudioWorklet beneath the GitHub Pages project path', async ({ page }) => {
  test.setTimeout(120_000)
  const presetRequests: string[] = []
  const assetRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/private-presets/')) presetRequests.push(request.url())
    if (pathname.includes('/assets/')) assetRequests.push(pathname)
  })

  await page.goto('/scratch-combo-web/')
  await expect(page.getByRole('heading', { name: 'Generated combo' })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.import-status__copy p')).toContainText(
    '85 BPM - Beginner ready. All 64 sample references and 2 beat files are loaded',
    { timeout: 60_000 },
  )

  const waveformView = page.getByRole('radio', { name: 'Waveform' })
  const ttmView = page.getByRole('radio', { name: /TTM practice guides/ })
  await expect(waveformView).toBeVisible()
  await expect(waveformView).toBeChecked()
  await expect(ttmView).toBeVisible()
  await expect(ttmView).toBeDisabled()
  await expect(page.getByText(/Local debug only/i)).toBeVisible()
  await expect(page.locator('.sequence-ttm-motion, [class*="sequence-event--ttm-"]')).toHaveCount(0)

  await page.getByRole('link', { name: 'Samples' }).click()
  await page.getByRole('button', { name: /^Edit / }).first().click()
  await expect(page.locator('.sample-editor')).toBeVisible()
  await expect(page.locator('.sample-editor [aria-label^="TTM guide for "]')).toHaveCount(0)
  await page.locator('#sequence-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await expect(waveformView).toBeInViewport()
  await expect(ttmView).toBeInViewport()
  await expect(page.locator('.sequence-waveform path').first()).toBeVisible()
  const peakFillColors = await page.locator('.sequence-waveform path').evaluateAll((paths) => Array.from(new Set(
    paths.map((path) => getComputedStyle(path).fill).filter((fill) => fill && fill !== 'none'),
  )))
  expect(peakFillColors.length).toBeGreaterThanOrEqual(2)
  mkdirSync(path.resolve(process.cwd(), 'test-results'), { recursive: true })
  await page.screenshot({ path: path.resolve(process.cwd(), 'test-results', 'pages-production-ttm-gated.png'), fullPage: false })

  expect(presetRequests.length).toBeGreaterThan(60)
  expect(presetRequests.every((url) => new URL(url).pathname.startsWith('/scratch-combo-web/private-presets/'))).toBe(true)
  const workletAsset = await page.evaluate(async () => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"]')
    if (!entry?.src) return ''
    const source = await (await fetch(entry.src)).text()
    return source.match(/\/scratch-combo-web\/assets\/soundtouch-processor-[^`]+\.js/)?.[0] ?? ''
  })
  expect(workletAsset).toMatch(/^\/scratch-combo-web\/assets\/soundtouch-processor-/)

  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.locator('.transport-status')).toContainText('Q&A · question playback', { timeout: 30_000 })
  expect(assetRequests.some((path) => /^\/scratch-combo-web\/assets\/chunk-[^/]+\.js$/.test(path))).toBe(true)
  expect(assetRequests.every((path) => {
    const filename = path.slice(path.lastIndexOf('/') + 1)
    return path.startsWith('/scratch-combo-web/assets/') && !filename.startsWith('.')
  })).toBe(true)
  await page.getByRole('button', { name: 'Stop' }).click()

  await page.locator('#session-section').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await expect(page.getByRole('button', { name: 'Reset controls' })).toBeInViewport()
  await expect(page.getByRole('slider', { name: 'Pitch shift in semitones' })).toBeInViewport()
  await expect(page.getByRole('slider', { name: 'Sample level' })).toBeInViewport()
  await expect(page.getByRole('slider', { name: 'Beat level' })).toBeInViewport()
  await page.screenshot({ path: path.resolve(process.cwd(), 'test-results', 'pages-production-session-controls.png'), fullPage: false })
})
