import { expect, type Page } from '@playwright/test'

export type LocalFilePayload = { name: string; mimeType: string; buffer: Buffer }
export type LocalFileSelection = string | readonly string[] | LocalFilePayload | readonly LocalFilePayload[]

export async function expectStepTwoFocus(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Choose the audio files' })).toBeFocused()
}

/** Open a fresh custom import draft through the public Quick preset control. */
export async function openLocalImport(page: Page): Promise<void> {
  const quickPreset = page.getByLabel('Quick preset')
  if (await quickPreset.isDisabled()) {
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
  } else if (await quickPreset.inputValue() !== 'custom') {
    await page.getByRole('tab', { name: 'Practice', exact: true }).click()
    await quickPreset.selectOption('custom')
  } else {
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const startAnotherImport = page.getByRole('button', { name: 'Start another import' })
    if (await startAnotherImport.count() > 0 && await startAnotherImport.isVisible()) {
      await startAnotherImport.click()
    }
  }
  await expect(page.getByRole('heading', { name: 'Choose your INI preset' })).toBeVisible()
}

/** Stage an INI and WAV selection and leave the wizard at its review page. */
export async function stageLocalImport(
  page: Page,
  iniFile: LocalFileSelection,
  audioFiles: LocalFileSelection,
  mode: 'folder' | 'files' = 'files',
): Promise<void> {
  await openLocalImport(page)
  await page.getByLabel('Choose INI preset').setInputFiles(iniFile)
  await expectStepTwoFocus(page)

  if (mode === 'folder') {
    await page.getByLabel('Choose audio folder').setInputFiles(audioFiles as string)
  } else {
    await page.getByRole('button', { name: 'Choose files instead' }).click()
    await page.getByLabel('Choose WAV files').setInputFiles(audioFiles as LocalFilePayload | readonly LocalFilePayload[])
  }
  await page.getByRole('button', { name: 'Review selection' }).click()
  await expect(page.getByRole('heading', { name: 'Review and load' })).toBeFocused()
}

/** Stage and atomically load a local preset while keeping each test on the user workflow. */
export async function loadLocalImport(
  page: Page,
  iniFile: LocalFileSelection,
  audioFiles: LocalFileSelection,
  expectedPresetName?: string,
  mode: 'folder' | 'files' = 'files',
): Promise<void> {
  await stageLocalImport(page, iniFile, audioFiles, mode)
  await expect(page.getByRole('button', { name: 'Load preset' })).toBeEnabled()
  await page.getByRole('button', { name: 'Load preset' }).click()
  if (expectedPresetName) {
    await expect(page.locator('.sequence-heading')).toContainText(expectedPresetName, { timeout: 30_000 })
  }
}
