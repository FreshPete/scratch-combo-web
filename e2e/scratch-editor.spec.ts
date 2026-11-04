import { expect, test } from '@playwright/test'

test('draws a scratch on a phone-sized viewport and plays the edited PCM', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 })
  await page.route('**/private-presets/**', (route) => route.abort())
  await page.addInitScript(() => {
    const originalStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      const pcm = this.buffer?.getChannelData(0)
      if (pcm) {
        let peak = 0
        let audibleFrames = 0
        for (const value of pcm) {
          peak = Math.max(peak, Math.abs(value))
          if (Math.abs(value) > 0.001) audibleFrames += 1
        }
        document.body.dataset.scratchPcm = `${peak},${audibleFrames}`
      }
      return originalStart.call(this, when, offset, duration)
    }
  })
  await page.goto('/#scratch-editor')
  const editor = page.getByRole('tabpanel', { name: 'Editor' })
  const record = editor.getByRole('slider', { name: 'Record position across the sound' })
  const fader = editor.getByRole('slider', { name: 'Crossfader cuts, open or closed' })
  const play = editor.getByRole('button', { name: 'Play scratch' })
  const stop = editor.getByRole('button', { name: 'Stop preview' })
  await expect(editor.getByLabel('Scratch sound')).toHaveValue('starter')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)

  await play.click()
  await expect(stop).toBeEnabled()
  await expect(page.locator('body')).toHaveAttribute('data-scratch-pcm', /,\d+$/)
  const originalPcm = await page.locator('body').getAttribute('data-scratch-pcm')
  expect(Number(originalPcm?.split(',')[0])).toBeGreaterThan(0.05)
  await stop.click()

  await fader.scrollIntoViewIfNeeded()
  const faderBounds = (await fader.boundingBox())!
  const touch = await page.context().newCDPSession(page)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const y = faderBounds.y + faderBounds.height / 2
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: faderBounds.x + faderBounds.width * 0.015, y }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: faderBounds.x + faderBounds.width * 0.1, y }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await expect(fader).toHaveAttribute('aria-valuenow', '0')
  await expect(fader.locator('rect').nth(2)).toHaveClass(/--closed/)

  await record.scrollIntoViewIfNeeded()
  const bounds = (await record.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.8, { steps: 5 })
  await page.mouse.up()
  await expect(record).toHaveAttribute('aria-valuenow', '20')
  await fader.focus()
  const beforeCut = await fader.getAttribute('aria-valuenow')
  await page.keyboard.press('Space')
  await expect(fader).not.toHaveAttribute('aria-valuenow', beforeCut!)

  await play.click()
  await expect(stop).toBeEnabled()
  await expect(page.locator('body')).not.toHaveAttribute('data-scratch-pcm', originalPcm!)
  const editedPcm = await page.locator('body').getAttribute('data-scratch-pcm')
  expect(editedPcm).not.toBe(originalPcm)
  expect(Number(editedPcm?.split(',')[0])).toBeGreaterThan(0.05)
  await page.getByRole('tab', { name: 'Practice' }).click()
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(play).toBeEnabled()
  await expect(record).toHaveAttribute('aria-valuenow', '20')
  await editor.getByRole('button', { name: 'Reset pattern' }).click()
  await expect(record).toHaveAttribute('aria-valuenow', '0')

  await editor.getByLabel('Scratch sound').selectOption({ label: 'Ahh vocal' })
  await play.click()
  await expect(editor.getByRole('status')).toHaveText('Playing Ahh vocal.')
  const ahhPcm = await page.locator('body').getAttribute('data-scratch-pcm')
  expect(ahhPcm).not.toBe(originalPcm)
  expect(Number(ahhPcm?.split(',')[0])).toBeGreaterThan(0.05)
})

test('previews a loaded WAV and stops the practice transport first', async ({ page }) => {
  await page.goto('/')
  const playSequence = page.getByRole('button', { name: 'Play sequence' })
  await expect(playSequence).toBeEnabled({ timeout: 30_000 })
  await playSequence.click()
  const practiceStop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(practiceStop).toBeEnabled()
  await page.getByRole('tab', { name: 'Editor' }).click()
  const editor = page.getByRole('tabpanel', { name: 'Editor' })
  await editor.getByLabel('Scratch sound').selectOption({ label: 'Baby' })
  await editor.getByRole('button', { name: 'Play scratch' }).click()
  await expect(editor.getByRole('status')).toHaveText(/Playing Baby/i)
  await expect(practiceStop).toBeHidden()
  await expect(editor.getByRole('status')).toHaveText('Preview finished.')
  await page.getByRole('tab', { name: 'Practice' }).click()
  await expect(playSequence).toBeEnabled()
  await expect(practiceStop).toBeDisabled()
})
