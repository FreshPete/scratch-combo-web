import { expect, test } from '@playwright/test'

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
})
