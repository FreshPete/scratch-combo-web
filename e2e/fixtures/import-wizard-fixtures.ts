import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ImportWizardFixture = {
  iniPath: string
  audioDirectory: string
}

export type DiagnosticWizardFixture = ImportWizardFixture & {
  folderFiles: {
    hit: string
    bed: string
    duplicateA: string
    duplicateB: string
    corrupt: string
  }
}

export function makeWizardWav(frequency = 440, durationSeconds = 1): Buffer {
  const sampleRate = 16_000
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
    const envelope = Math.min(1, index / 160) * Math.min(1, (sampleCount - index) / 160)
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.35 * envelope
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function sampleSection(
  id: number,
  displayName: string,
  fileName: string,
  options: { durationTicks?: number; canRepeat?: boolean; endsForward?: boolean } = {},
): string[] {
  return [
    `[Sample${String(id).padStart(2, '0')}]`,
    'SamplePlayFq=1',
    'SampleIsSilent=False',
    `SampleRepeatsPoss=${options.canRepeat === false ? 'False' : 'True'}`,
    'SampleRepeatMax=100',
    `SampleFileName=${fileName}`,
    `SampleDisplayName=${displayName}`,
    'SampleStartsForward=True',
    `SampleEndsForward=${options.endsForward ? 'True' : 'False'}`,
    `Sample16ths=${options.durationTicks ?? 8}`,
    'UseSample=True',
    '',
  ]
}

function iniText(configName: string, sampleRows: Array<{
  name: string
  file: string
  durationTicks?: number
  canRepeat?: boolean
  endsForward?: boolean
}>): string {
  return [
    '[Samples]',
    `CONFIGNAME=${configName}`,
    'VOL_B=70',
    'VOL_S=80',
    'RootSamplePathRelative=True',
    'RootSamplePath=assets',
    'Beat01=Beats/Bed.wav',
    'BPM01=120',
    '',
    ...sampleRows.flatMap((row, index) => sampleSection(index + 1, row.name, row.file, row)),
  ].join('\r\n')
}

async function writeWav(filePath: string, frequency?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, makeWizardWav(frequency))
}

export async function createValidWizardFixture(root: string): Promise<ImportWizardFixture> {
  const audioDirectory = path.join(root, 'wizard-audio')
  const iniPath = path.join(root, 'wizard.ini')
  await mkdir(audioDirectory, { recursive: true })
  await writeFile(iniPath, iniText('Wizard Memory Fixture', [
    { name: 'Wizard Tone', file: 'Samples/WizardTone.wav' },
  ]))
  await writeWav(path.join(audioDirectory, 'assets', 'Samples', 'WizardTone.wav'), 440)
  await writeWav(path.join(audioDirectory, 'assets', 'Beats', 'Bed.wav'), 110)
  return { iniPath, audioDirectory }
}

/** A valid sample that fills four beats but cannot repeat to fill the default eight. */
export async function createDefaultLengthIncompatibleWizardFixture(root: string): Promise<ImportWizardFixture> {
  const audioDirectory = path.join(root, 'short-audio')
  const iniPath = path.join(root, 'short.ini')
  await mkdir(audioDirectory, { recursive: true })
  await writeFile(iniPath, iniText('Short Non-Repeating Fixture', [
    { name: 'Single Long Tone', file: 'Samples/LongTone.wav', durationTicks: 64, canRepeat: false, endsForward: true },
  ]))
  await writeWav(path.join(audioDirectory, 'assets', 'Samples', 'LongTone.wav'), 440)
  await writeWav(path.join(audioDirectory, 'assets', 'Beats', 'Bed.wav'), 110)
  return { iniPath, audioDirectory }
}

export async function createDiagnosticWizardFixture(root: string): Promise<DiagnosticWizardFixture> {
  const audioDirectory = path.join(root, 'diagnostic-audio')
  const iniPath = path.join(root, 'diagnostics.ini')
  const folderFiles = {
    hit: path.join(audioDirectory, 'assets', 'Samples', 'WizardTone.wav'),
    bed: path.join(audioDirectory, 'assets', 'Beats', 'Bed.wav'),
    duplicateA: path.join(audioDirectory, 'assets', 'SessionA', 'Click.wav'),
    duplicateB: path.join(audioDirectory, 'assets', 'SessionB', 'Click.wav'),
    corrupt: path.join(audioDirectory, 'assets', 'Broken', 'Corrupt.wav'),
  }
  await mkdir(audioDirectory, { recursive: true })
  await writeFile(iniPath, iniText('Wizard Diagnostics Fixture', [
    { name: 'Wizard Tone', file: 'Samples/WizardTone.wav' },
    { name: 'Missing Sample', file: 'Samples/Required.wav' },
    { name: 'Ambiguous Sample', file: 'Click.wav' },
    { name: 'Corrupt Sample', file: 'Broken/Corrupt.wav' },
  ]))
  await writeWav(folderFiles.hit, 440)
  await writeWav(folderFiles.bed, 110)
  await writeWav(folderFiles.duplicateA, 330)
  await writeWav(folderFiles.duplicateB, 550)
  await mkdir(path.dirname(folderFiles.corrupt), { recursive: true })
  await writeFile(folderFiles.corrupt, Buffer.from('not a decodable PCM WAV'))
  return { iniPath, audioDirectory, folderFiles }
}
