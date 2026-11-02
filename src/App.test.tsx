import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CyclePlanOptions } from './audio'
import * as domain from './domain'
import App from './App'

const audioHarness = vi.hoisted(() => {
  type Snapshot = {
    status: 'idle' | 'loading' | 'playing' | 'completed' | 'error' | 'disposed'
    progress: number
    error?: string
    cycleSlotIndex?: number
    cycleIteration?: number
    cycleSlotKind?: 'fixture' | 'silence'
    cyclePlanIndex?: number
    presentation?: {
      started: boolean
      progress: number
      positionUnits: number
      cycleSlotIndex?: number
      cycleIteration?: number
      cycleSlotKind?: 'fixture' | 'silence'
      cyclePlanIndex?: number
    }
  }
  let snapshot: Snapshot = { status: 'idle', progress: 0 }
  let tempoAvailable = false
  const listeners = new Set<() => void>()
  const emit = (next: Snapshot) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const getSnapshot = () => snapshot
  const getProgress = () => snapshot.progress
  const hasTempoReference = (options: unknown) => typeof options === 'object' && options !== null
    && typeof (options as { referenceBpm?: unknown }).referenceBpm === 'number'
  const play = vi.fn(async (options: unknown) => {
    tempoAvailable = hasTempoReference(options)
    emit({ status: 'playing', progress: 0 })
  })
  const playCyclePlan = vi.fn(async (options: unknown) => {
    tempoAvailable = hasTempoReference(options)
    emit({
      status: 'playing', progress: 0, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture',
      presentation: { started: false, progress: 0, positionUnits: 0, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture' },
    })
  })
  const setTempo = vi.fn((_bpm: number) => {
    if (!tempoAvailable || (snapshot.status !== 'playing' && snapshot.status !== 'loading')) {
      throw new Error('Live tempo changes require active playback with an imported preset reference.')
    }
  })
  const setPitchSemitones = vi.fn()
  const setSampleVolume = vi.fn()
  const setBeatVolume = vi.fn()
  const stop = vi.fn(() => { tempoAvailable = false; emit({ status: 'idle', progress: 0 }) })
  const resetAssets = vi.fn(() => { tempoAvailable = false; emit({ status: 'idle', progress: 0 }) })
  const dispose = vi.fn(() => { tempoAvailable = false; emit({ status: 'disposed', progress: 0 }) })
  const snapshotReferencedWavFiles = vi.fn(async (
    files: readonly File[],
    options?: { decodeFiles?: readonly File[] },
  ) => {
    const uniqueFiles = [...new Set(files)]
    const decodeFiles = new Set(options?.decodeFiles ?? [])
    const filesBySource = new Map(uniqueFiles.map((file) => [file, new File([file], file.name, { type: file.type, lastModified: file.lastModified })]))
    const validationBySource = new Map(uniqueFiles.map((file) => [file, decodeFiles.has(file)
      ? { status: 'valid' as const, durationSeconds: 0.1, sampleRate: 44100, channelCount: 1, decodedChannelSamples: Math.max(1, file.size) }
      : { status: 'not-requested' as const }]))
    return {
      filesBySource,
      validationBySource,
      copiedFileCount: uniqueFiles.length,
      copiedBytes: uniqueFiles.reduce((total, file) => total + file.size, 0),
      decodeAttemptCount: decodeFiles.size,
      decodedFileCount: decodeFiles.size,
      decodedChannelSamples: decodeFiles.size,
      decodedDurationSeconds: decodeFiles.size * 0.1,
    }
  })
  const reset = () => {
    snapshot = { status: 'idle', progress: 0 }
    tempoAvailable = false
    listeners.clear()
    play.mockClear()
    playCyclePlan.mockClear()
    setTempo.mockClear()
    setPitchSemitones.mockClear()
    setSampleVolume.mockClear()
    setBeatVolume.mockClear()
    stop.mockClear()
    resetAssets.mockClear()
    dispose.mockClear()
    snapshotReferencedWavFiles.mockReset()
    snapshotReferencedWavFiles.mockImplementation(async (files, options) => {
      const uniqueFiles = [...new Set(files)]
      const decodeFiles = new Set(options?.decodeFiles ?? [])
      const filesBySource = new Map(uniqueFiles.map((file) => [file, new File([file], file.name, { type: file.type, lastModified: file.lastModified })]))
      const validationBySource = new Map(uniqueFiles.map((file) => [file, decodeFiles.has(file)
        ? { status: 'valid' as const, durationSeconds: 0.1, sampleRate: 44100, channelCount: 1, decodedChannelSamples: Math.max(1, file.size) }
        : { status: 'not-requested' as const }]))
      return {
        filesBySource,
        validationBySource,
        copiedFileCount: uniqueFiles.length,
        copiedBytes: uniqueFiles.reduce((total, file) => total + file.size, 0),
        decodeAttemptCount: decodeFiles.size,
        decodedFileCount: decodeFiles.size,
        decodedChannelSamples: decodeFiles.size,
        decodedDurationSeconds: decodeFiles.size * 0.1,
      }
    })
  }
  return {
    listeners, subscribe, getSnapshot, getProgress, play, playCyclePlan,
    setTempo, setPitchSemitones, setSampleVolume, setBeatVolume,
    stop, resetAssets, dispose, snapshotReferencedWavFiles, emit, reset,
  }
})

const presetHarness = vi.hoisted(() => ({
  fetchBuiltInPresetCatalog: vi.fn(),
  loadBuiltInPreset: vi.fn(),
  loaded: undefined as unknown,
}))

const bpmHarness = vi.hoisted(() => ({
  analyzeLocalAudioFile: vi.fn(),
}))

const waveformHarness = vi.hoisted(() => ({
  loadWaveform: vi.fn(async (_file: File): Promise<unknown> => null),
}))

vi.mock('./audio', () => ({
  analyzeLocalAudioFile: bpmHarness.analyzeLocalAudioFile,
  snapshotReferencedWavFiles: audioHarness.snapshotReferencedWavFiles,
  AudioTransport: class {
    subscribe = audioHarness.subscribe
    getSnapshot = audioHarness.getSnapshot
    getProgress = audioHarness.getProgress
    play = audioHarness.play
    playCyclePlan = audioHarness.playCyclePlan
    setTempo = audioHarness.setTempo
    setPitchSemitones = audioHarness.setPitchSemitones
    setSampleVolume = audioHarness.setSampleVolume
    setBeatVolume = audioHarness.setBeatVolume
    stop = audioHarness.stop
    resetAssets = audioHarness.resetAssets
    dispose = audioHarness.dispose
  },
}))

vi.mock('./presets/catalog', () => ({
  fetchBuiltInPresetCatalog: presetHarness.fetchBuiltInPresetCatalog,
  loadBuiltInPreset: presetHarness.loadBuiltInPreset,
}))

vi.mock('./waveforms/waveform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./waveforms/waveform')>()
  return { ...actual, loadWaveform: waveformHarness.loadWaveform }
})

vi.mock('./domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./domain')>()
  return { ...actual, generateLegacyCombo: vi.fn(actual.generateLegacyCombo) }
})

const defaultLegacyGenerator = vi.mocked(domain.generateLegacyCombo).getMockImplementation()

function delayedIniFile(name: string) {
  let resolveText: (text: string) => void = () => undefined
  const text = new Promise<string>((resolve) => { resolveText = resolve })
  const file = new File([], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', { configurable: true, value: () => text })
  return { file, resolve: resolveText }
}

function samplePreset(configName: string, sampleName: string, fileName: string): string {
  return [
    '[Samples]',
    'ConfigName=' + configName,
    'BPM01=100',
    'Beat01=beat.wav',
    'VOL_B=60',
    'VOL_S=80',
    'RootSamplePathRelative=True',
    'RootSamplePath=sounds',
    '',
    '[Sample01]',
    'SamplePlayFq=1',
    'SampleIsSilent=False',
    'SampleRepeatsPoss=True',
    'SampleRepeatMax=512',
    'SampleFileName=' + fileName,
    'SampleDisplayName=' + sampleName,
    'SampleStartsForward=True',
    'SampleEndsForward=False',
    'Sample16ths=8',
    'UseSample=True',
  ].join('\n')
}

function chooseFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  fireEvent.change(input)
}

async function stageLocalImport(
  iniFile: File,
  audioFiles: File[] = [],
  options: { load?: boolean; fileMode?: 'folder' | 'files' } = {},
) {
  selectWorkspaceTab('Files')
  chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [iniFile])
  await screen.findByRole('heading', { name: 'Choose the audio files' })

  if (options.fileMode === 'files') fireEvent.click(screen.getByRole('button', { name: 'Choose files instead' }))
  if (audioFiles.length > 0) {
    chooseFiles(screen.getByLabelText(options.fileMode === 'files' ? 'Choose WAV files' : 'Choose audio folder') as HTMLInputElement, audioFiles)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  await screen.findByRole('heading', { name: 'Review and load' })
  await waitFor(() => expect(document.querySelector('.import-wizard')).toHaveAttribute('aria-busy', 'false'))

  if (options.load !== false) {
    const load = screen.getByRole('button', { name: 'Load preset' })
    await waitFor(() => expect(load).toBeEnabled())
    fireEvent.click(load)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preset loaded' })).toBeDisabled())
  }
}

function fileWithPath(fileName: string, relativePath: string) {
  const file = new File(['audio'], fileName, { type: 'audio/wav' })
  Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: relativePath })
  return file
}

function selectWorkspaceTab(name: 'Practice' | 'Session' | 'Samples' | 'Files') {
  fireEvent.click(screen.getByRole('tab', { name }))
}

function selectDemoPreset() {
  selectWorkspaceTab('Practice')
  fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'demo' } })
}

beforeEach(() => {
  audioHarness.reset()
  bpmHarness.analyzeLocalAudioFile.mockReset()
  vi.mocked(domain.generateLegacyCombo).mockReset()
  if (defaultLegacyGenerator) vi.mocked(domain.generateLegacyCombo).mockImplementation(defaultLegacyGenerator)
  presetHarness.fetchBuiltInPresetCatalog.mockReset()
  presetHarness.loadBuiltInPreset.mockReset()
  waveformHarness.loadWaveform.mockReset()
  waveformHarness.loadWaveform.mockResolvedValue(null)
  const builtinIni = samplePreset('85 BPM - Beginner', 'Bundled kick', 'kick.wav')
    .replace('BPM01=100', 'BPM01=85')
    .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
    .replace('Beat01=beat.wav', 'Beat01=beat.wav\nBeat02=beat-two.wav')
  const builtinPreset = domain.parseLegacyIni(builtinIni)
  const entries = [
    { id: 'SSC-085BPM-01', label: '85 BPM - Beginner', bpm: 85, iniFile: 'SSC-085BPM-01.ini', audioDirectory: 'sounds' },
    { id: 'SSC-085BPM-02', label: '85 BPM - Average', bpm: 85, iniFile: 'SSC-085BPM-02.ini', audioDirectory: 'sounds' },
    { id: 'SSC-085BPM-03', label: '85 BPM - Good', bpm: 85, iniFile: 'SSC-085BPM-03.ini', audioDirectory: 'sounds' },
    { id: 'SSC-085BPM-04', label: '85 BPM - Very Good', bpm: 85, iniFile: 'SSC-085BPM-04.ini', audioDirectory: 'sounds' },
    { id: 'SSC-085BPM-05', label: '85 BPM - Expert', bpm: 85, iniFile: 'SSC-085BPM-05.ini', audioDirectory: 'sounds' },
    { id: 'SSC-096BPM2-01', label: '96 BPM Set 2', bpm: 96, iniFile: 'SSC-096BPM2-01.ini', audioDirectory: 'sounds' },
  ]
  presetHarness.loaded = {
    preset: builtinPreset,
    iniFile: new File([builtinIni], 'SSC-085BPM-01.ini', { type: 'text/plain' }),
    iniText: builtinIni,
    audioFiles: [
      fileWithPath('kick.wav', 'sounds/kick.wav'),
      fileWithPath('beat.wav', 'sounds/beat.wav'),
      fileWithPath('beat-two.wav', 'sounds/beat-two.wav'),
    ],
  }
  presetHarness.fetchBuiltInPresetCatalog.mockResolvedValue({ version: 1, defaultPresetId: 'SSC-085BPM-01', presets: entries })
  presetHarness.loadBuiltInPreset.mockImplementation(async (entry: { iniFile: string }) => ({
    ...(presetHarness.loaded as object),
    iniFile: new File([builtinIni], entry.iniFile, { type: 'text/plain' }),
  }))
  class TestAudioContext {
    state: AudioContextState = 'running'
    close = vi.fn(async () => { this.state = 'closed' as AudioContextState })
  }
  vi.stubGlobal('AudioContext', TestAudioContext)
})
afterEach(async () => {
  cleanup()
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.resolve()
})

describe('workspace import and transport lifecycle', () => {
  it('keeps Play and Stop before the expanded timeline', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    const timeline = await screen.findByRole('img', { name: /Sequence timeline/ }) as HTMLElement
    const transportRow = document.querySelector<HTMLElement>('.transport-dock')

    expect(transportRow).toBeInTheDocument()
    expect(transportRow!.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(transportRow!).getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(within(transportRow!).getByRole('button', { name: 'Stop' })).toBeDisabled()
  })

  it('uses four keyboard-operable tabs and activates direct hash targets', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })

    const practiceTab = screen.getByRole('tab', { name: 'Practice' })
    const sessionTab = screen.getByRole('tab', { name: 'Session' })
    const tabs = screen.getByRole('tablist', { name: 'Workspace sections' })
    expect(tabs).toHaveAttribute('aria-orientation', 'vertical')
    expect(practiceTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Practice' })).not.toHaveAttribute('hidden')
    expect(document.getElementById('panel-session')).toHaveAttribute('hidden')
    expect(document.getElementById('panel-samples')).toHaveAttribute('hidden')
    expect(document.getElementById('panel-files')).toHaveAttribute('hidden')

    fireEvent.keyDown(practiceTab, { key: 'ArrowDown' })
    await waitFor(() => expect(sessionTab).toHaveAttribute('aria-selected', 'true'))
    expect(sessionTab).toHaveFocus()

    window.location.hash = '#import-heading'
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true'))
    const filesPanel = screen.getByRole('tabpanel', { name: 'Files' })
    expect(filesPanel).not.toHaveAttribute('hidden')
    await waitFor(() => expect(filesPanel).toHaveFocus())

    window.location.hash = '#workspace'
    await waitFor(() => expect(practiceTab).toHaveAttribute('aria-selected', 'true'))
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    fireEvent.click(sessionTab)
    await waitFor(() => expect(sessionTab).toHaveAttribute('aria-selected', 'true'))
    window.history.back()
    await waitFor(() => expect(practiceTab).toHaveAttribute('aria-selected', 'true'))
  })

  it('keeps global transport available on every tab and provides safe, toggleable shortcuts', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectDemoPreset()
    selectWorkspaceTab('Practice')

    const play = screen.getByRole('button', { name: 'Play sequence' })
    const stop = screen.getByRole('button', { name: 'Stop' })
    fireEvent.keyDown(document.body, { key: 'g' })
    await screen.findByText('Fixed demo preview built. Ready to play.')
    fireEvent.keyDown(document.body, { key: 'p' })
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(document.body, { key: 'p' })
    expect(stop).toBeDisabled()
    expect(audioHarness.stop).toHaveBeenCalled()

    selectWorkspaceTab('Session')
    const bpmField = screen.getByRole('spinbutton', { name: 'BPM' })
    fireEvent.change(bpmField, { target: { value: '94' } })
    fireEvent.keyDown(bpmField, { key: 'p' })
    expect(audioHarness.play).toHaveBeenCalledTimes(1)
    expect(play).toBeEnabled()
    fireEvent.keyDown(document.body, { key: 'r' })
    expect(bpmField).toHaveValue(100)

    selectWorkspaceTab('Practice')
    fireEvent.keyDown(document.body, { key: 'p', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'p', repeat: true })
    expect(audioHarness.play).toHaveBeenCalledTimes(1)

    const helpButton = screen.getByRole('button', { name: 'Keyboard shortcuts' })
    fireEvent.click(helpButton)
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(screen.getByRole('button', { name: 'Close shortcuts' })).toHaveFocus()
    expect(screen.getByRole('checkbox', { name: 'Enable single-character shortcuts' })).toBeChecked()
    expect(within(dialog).getByText('P', { exact: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable single-character shortcuts' }))
    expect(screen.getByRole('checkbox', { name: 'Enable single-character shortcuts' })).not.toBeChecked()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument())
    expect(helpButton).toHaveFocus()

    const statusBeforeDisabledShortcut = document.querySelector('.transport-status')?.textContent
    fireEvent.keyDown(document.body, { key: 'g' })
    expect(document.querySelector('.transport-status')?.textContent).toBe(statusBeforeDisabledShortcut)
    fireEvent.click(helpButton)
    expect(screen.getByRole('checkbox', { name: 'Enable single-character shortcuts' })).not.toBeChecked()
  })

  it('switches Grid and Inline without changing event timing or restarting playback', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await screen.findByRole('img', { name: /Sequence timeline/ })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled())

    const gridGeometry = Array.from(document.querySelectorAll<HTMLElement>('.timeline-lane .sequence-event'))
      .map((event) => [event.dataset.eventId, event.style.left, event.style.width])
      .sort(([first = ''], [second = '']) => first.localeCompare(second))
    const barLabels = document.querySelector('.timeline-bar-labels')?.textContent
    const beatLabels = document.querySelector('.timeline-ruler')?.textContent

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    act(() => audioHarness.emit({
      status: 'playing', progress: 0.25, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture',
      presentation: { started: true, progress: 0.25, positionUnits: 0, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture' },
    }))
    const playheadBefore = document.querySelector('.timeline-playhead')?.getAttribute('style')

    fireEvent.click(screen.getByRole('radio', { name: 'Inline' }))
    expect(screen.getByRole('radio', { name: 'Inline' })).toBeChecked()
    expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1)
    expect(audioHarness.getSnapshot().status).toBe('playing')
    expect(document.querySelector('.timeline-playhead')?.getAttribute('style')).toBe(playheadBefore)
    expect(document.querySelector('.timeline-bar-labels')?.textContent).toBe(barLabels)
    expect(document.querySelector('.timeline-ruler')?.textContent).toBe(beatLabels)

    const inlineGeometry = Array.from(document.querySelectorAll<HTMLElement>('.timeline-inline-row .sequence-event'))
      .map((event) => [event.dataset.eventId, event.style.left, event.style.width])
      .sort(([first = ''], [second = '']) => first.localeCompare(second))
    expect(document.querySelectorAll('.timeline-inline-row .sequence-event')).toHaveLength(gridGeometry.length)
    expect(inlineGeometry).toEqual(gridGeometry)

    fireEvent.click(screen.getByRole('radio', { name: 'TTM practice guides' }))
    expect(screen.getByRole('radio', { name: 'TTM practice guides' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Inline' })).toBeChecked()
    expect(document.querySelector('.timeline-inline-row')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Waveform' }))
    expect(screen.getByRole('radio', { name: 'Waveform' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Inline' })).toBeChecked()
  })

  it('follows the presented event in both layouts and clears it in rests and answer pauses', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [
        { eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 8, startForward: true, endForward: false, silent: false },
        { eventNumber: 2, sampleNumber: 1, sampleId: 'Sample01', startTick: 8, durationTicks: 8, startForward: true, endForward: false, silent: false },
      ],
      requestedRawTicks: 64,
      completedRawTicks: 16,
      remainingRawTicks: 48,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.sequence-event--active')).not.toBeInTheDocument()

    act(() => audioHarness.emit({
      status: 'playing', progress: 0.1, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture',
      presentation: { started: true, progress: 0.1, positionUnits: 9, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture' },
    }))
    expect(document.querySelector('.timeline-scroll')).toHaveAttribute('data-presentation-position-units', '9')
    expect(document.querySelector('.sequence-event--active')).toHaveAttribute('data-event-id', 'legacy-2-Sample01')
    expect(document.querySelector('.timeline-lane--active')).toContainElement(document.querySelector('.timeline-now-playing'))

    fireEvent.click(screen.getByRole('radio', { name: 'Inline' }))
    expect(document.querySelector('.sequence-event--active .sequence-inline-event-label')).toHaveTextContent('Now playing · Bundled kick')
    expect(document.querySelector('.sequence-event--active')).toHaveAttribute('data-event-id', 'legacy-2-Sample01')

    act(() => audioHarness.emit({
      status: 'playing', progress: 0.2, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture',
      presentation: { started: true, progress: 0.2, positionUnits: 17, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture' },
    }))
    expect(document.querySelector('.sequence-event--active')).not.toBeInTheDocument()

    act(() => audioHarness.emit({
      status: 'playing', progress: 0.75, cycleSlotIndex: 1, cycleIteration: 1, cycleSlotKind: 'silence',
      presentation: { started: true, progress: 0.75, positionUnits: 9, cycleSlotIndex: 1, cycleIteration: 1, cycleSlotKind: 'silence' },
    }))
    expect(document.querySelector('.timeline-scroll')).toHaveAttribute('data-cycle-slot-kind', 'silence')
    expect(document.querySelector('.sequence-event--active')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(document.querySelector('.sequence-event--active')).not.toBeInTheDocument()
    expect(document.querySelector('.timeline-scroll')).toHaveAttribute('data-presentation-started', 'false')
    expect(document.querySelector('.timeline-scroll')).not.toHaveAttribute('data-presentation-position-units')
  })

  it('shows a decoded WAV envelope inside the event slot at its reference-time width', async () => {
    waveformHarness.loadWaveform.mockResolvedValue({
      durationSeconds: 0.1,
      peaks: Float32Array.from([1, 0.5]),
      path: 'M0 1 L1 2 Z',
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })

    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await waitFor(() => expect(document.querySelector('.sequence-event--waveform svg.sequence-waveform')).toBeInTheDocument())
    expect(waveformHarness.loadWaveform).toHaveBeenCalledWith((presetHarness.loaded as { audioFiles: File[] }).audioFiles[0])
    const waveform = document.querySelector('.sequence-event--waveform svg.sequence-waveform') as SVGSVGElement
    expect(Number.parseFloat(waveform.style.width)).toBeCloseTo((0.1 / (8 * 60 / (85 * 16))) * 100)
    expect(waveform.querySelector('path')).toHaveAttribute('d', 'M0 1 L1 2 Z')
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()
  })

  it('keeps the normal event block when decoding fails and leaves silent slots dashed', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [{
        eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 8,
        startForward: true, endForward: false, silent: false,
      }],
      requestedRawTicks: 128,
      completedRawTicks: 8,
      remainingRawTicks: 120,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    const file = new File(['audio'], 'kick.wav', { type: 'audio/wav' })
    waveformHarness.loadWaveform.mockResolvedValue(null)

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await stageLocalImport(
      new File([samplePreset('Local preset', 'Local kick', 'kick.wav')], 'local.ini', { type: 'text/plain' }),
      [file],
    )
    selectWorkspaceTab('Practice')
    await screen.findAllByText('Local kick')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await waitFor(() => expect(document.querySelectorAll('.sequence-event').length).toBeGreaterThan(0))
    const retainedWav = waveformHarness.loadWaveform.mock.calls.at(-1)?.[0]
    expect(retainedWav).toBeInstanceOf(File)
    expect(retainedWav).not.toBe(file)
    expect(retainedWav?.name).toBe(file.name)
    expect(document.querySelector('.sequence-event--waveform')).not.toBeInTheDocument()
    expect(document.querySelector('.sequence-event--silent')).toBeInTheDocument()
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()
  })

  it('renders assigned TTM guides in the shared timeline and keeps assignments out of saved audio settings', async () => {
    const write = vi.fn(async (_value: string | Blob) => undefined)
    const close = vi.fn(async () => undefined)
    const createWritable = vi.fn(async () => ({ write, close }))
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn(async (options: { suggestedName: string }) => ({ name: options.suggestedName, createWritable })),
    })
    try {
      render(<App />)
      await screen.findByRole('heading', { name: 'Generated combo' })
      selectWorkspaceTab('Samples')
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bundled kick' }))

      const guideSelect = screen.getByRole('combobox', { name: 'TTM guide for Bundled kick' })
      expect(guideSelect).toHaveValue('untranscribed')
      fireEvent.change(guideSelect, { target: { value: 'forward-cut' } })
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'TTM guide for Bundled kick' })).toHaveValue('forward-cut'))
      selectWorkspaceTab('Practice')
      fireEvent.click(screen.getByRole('radio', { name: 'TTM practice guides' }))

      const guidePath = document.querySelector('.sequence-ttm-motion path')
      expect(guidePath).toHaveAttribute('d', 'M6 92 L50 8 L94 92')
      const guideEvent = document.querySelector('.sequence-event--ttm-guide')
      expect(guideEvent?.querySelectorAll('.sequence-ttm-fader__interval--open')).toHaveLength(1)
      expect(guideEvent?.querySelectorAll('.sequence-ttm-fader__interval--closed')).toHaveLength(1)
      expect(screen.getAllByText(/not WAV transcriptions/i).length).toBeGreaterThan(0)
      expect(screen.getByRole('img', { name: /Sequence timeline/ })).toBeInTheDocument()
      expect(audioHarness.play).not.toHaveBeenCalled()
      expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()

      selectWorkspaceTab('Samples')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save Sample Data' }))
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      expect(write.mock.calls[0]?.[0]).not.toContain('forward-cut')
      expect(write.mock.calls[0]?.[0]).not.toContain('TTM')
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    }
  })

  it('shows exact sample-name suggestions in TTM view and lets explicit Untranscribed override them', async () => {
    const loaded = presetHarness.loaded as { preset: domain.Preset }
    presetHarness.loaded = {
      ...(presetHarness.loaded as object),
      preset: {
        ...loaded.preset,
        samples: loaded.preset.samples.map((sample) => sample.id === 'Sample01' ? { ...sample, name: 'Baby(F)' } : sample),
      },
    }

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Baby(F)' }))
    const guideSelect = screen.getByRole('combobox', { name: 'TTM guide for Baby(F)' })
    expect(guideSelect).toHaveValue('forward-movement')
    expect(guideSelect.querySelector('option:checked')).toHaveTextContent('Suggested: Forward movement')
    expect(screen.getByText(/suggested from the exact sample label only/i)).toBeInTheDocument()

    selectWorkspaceTab('Practice')
    fireEvent.click(screen.getByRole('radio', { name: 'TTM practice guides' }))
    expect(document.querySelector('.sequence-ttm-motion path')).toHaveAttribute('d', 'M6 92 L94 8')
    expect(document.querySelector('.timeline-lane-label--ttm small')).toHaveTextContent('Suggested: Forward movement')

    selectWorkspaceTab('Samples')
    fireEvent.change(guideSelect, { target: { value: 'untranscribed' } })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'TTM guide for Baby(F)' })).toHaveValue('untranscribed'))
    selectWorkspaceTab('Practice')
    expect(document.querySelector('.sequence-ttm-motion path')).not.toBeInTheDocument()
    expect(document.querySelector('.sequence-event--ttm-untranscribed')).toBeInTheDocument()
    expect(document.querySelector('.timeline-lane-label--ttm small')).toHaveTextContent('Untranscribed')
    expect(document.querySelector('.visually-hidden[aria-label="Sequence events"]')).toHaveTextContent('TTM guide: Untranscribed')
  })

  it('marks a name without an exact TTM alias as unassigned', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [{
        eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 8,
        startForward: true, endForward: false, silent: false,
      }],
      requestedRawTicks: 128,
      completedRawTicks: 8,
      remainingRawTicks: 120,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    const ini = samplePreset('Unknown TTM label', 'Mystery scratch', 'mystery.wav')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await stageLocalImport(
      new File([ini], 'unknown-ttm.ini', { type: 'text/plain' }),
      [new File(['mystery audio'], 'mystery.wav', { type: 'audio/wav' })],
    )
    selectWorkspaceTab('Practice')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await screen.findByRole('img', { name: 'Sequence timeline: 128 legacy ticks, 2 events' })
    fireEvent.click(screen.getByRole('radio', { name: 'TTM practice guides' }))

    expect(document.querySelector('.sequence-event--ttm-unassigned')).toBeInTheDocument()
    expect(document.querySelector('.sequence-ttm-motion path')).not.toBeInTheDocument()
    expect(document.querySelector('.timeline-lane-label--ttm small')).toHaveTextContent('Unassigned')
    expect(screen.getByRole('link', { name: 'Edit a sample' })).toHaveAttribute('href', '#sample-section')
    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mystery scratch' }))
    const guideSelect = screen.getByRole('combobox', { name: 'TTM guide for Mystery scratch' })
    expect(guideSelect).toHaveValue('untranscribed')
    expect(guideSelect.querySelector('option:checked')).toHaveTextContent('Unassigned · Untranscribed')
    expect(screen.getByText(/No guide is assigned/i)).toBeInTheDocument()
  })

  it('disables local TTM guides and hides guide assignment controls in production', async () => {
    vi.stubEnv('DEV', false)
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })

    const ttmView = screen.getByRole('radio', { name: /TTM practice guides.*Local debug only/i })
    const waveformView = screen.getByRole('radio', { name: 'Waveform' })
    expect(ttmView).toBeDisabled()
    expect(screen.getByText('Local debug only')).toBeVisible()
    expect(waveformView).toBeChecked()

    fireEvent.click(ttmView)
    expect(waveformView).toBeChecked()
    expect(document.querySelector('.ttm-guide-legend')).not.toBeInTheDocument()
    expect(document.querySelector('[class*="sequence-ttm-"]')).not.toBeInTheDocument()
    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bundled kick' }))
    expect(screen.queryByRole('combobox', { name: /TTM guide for/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('combobox', { name: /TTM guide for/ })).not.toBeInTheDocument()
  })

  it('starts auto-generation off and replaces the visible fixture only at a completed-round boundary', async () => {
    const result = (startTick: number): ReturnType<typeof domain.generateLegacyCombo> => ({
      events: [{
        eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick, durationTicks: 8,
        startForward: true, endForward: false, silent: false,
      }],
      requestedRawTicks: 128,
      completedRawTicks: startTick + 8,
      remainingRawTicks: 120 - startTick,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    vi.mocked(domain.generateLegacyCombo).mockReturnValueOnce(result(0)).mockReturnValueOnce(result(16))

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    const autoGenerate = screen.getByRole('checkbox', { name: /Auto-generate/ })
    const roundCount = screen.getByRole('combobox', { name: 'New combo every' })
    expect(autoGenerate).not.toBeChecked()
    expect(roundCount).toHaveValue('2')
    expect(roundCount).toBeDisabled()

    fireEvent.click(autoGenerate)
    expect(roundCount).toBeEnabled()
    fireEvent.change(roundCount, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))

    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as CyclePlanOptions
    expect(options.cyclesPerPlan).toBe(4)
    expect(options.preloadSampleIds).toEqual(['Sample01'])
    expect(options.nextPlan).toBeTypeOf('function')
    expect(options.onPlanBoundary).toBeTypeOf('function')
    const eventsBeforeBoundary = document.querySelector('.visually-hidden[aria-label="Sequence events"]')?.textContent ?? ''
    const eventCountBeforeBoundary = document.querySelectorAll('.sequence-event').length
    expect(eventsBeforeBoundary).toContain('starts at legacy tick 1')

    let nextPlan: ReturnType<NonNullable<CyclePlanOptions['nextPlan']>> | undefined
    await act(async () => { nextPlan = options.nextPlan?.({ completedRounds: 4, nextPlanIndex: 2 }) })
    expect(nextPlan?.slots).toHaveLength(2)
    expect(document.querySelector('.visually-hidden[aria-label="Sequence events"]')?.textContent).toBe(eventsBeforeBoundary)

    await act(async () => {
      options.onPlanBoundary?.({ planIndex: 2, completedRounds: 4, plan: nextPlan! })
    })
    const eventsAfterBoundary = document.querySelector('.visually-hidden[aria-label="Sequence events"]')?.textContent ?? ''
    expect(eventsAfterBoundary).toContain('starts at legacy tick 17')
      expect(eventsAfterBoundary).not.toContain('starts at legacy tick 1, lasts')
    expect(document.querySelectorAll('.sequence-event')).toHaveLength(eventCountBeforeBoundary)

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Loop' }))
    fireEvent.change(roundCount, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(2))
    const loopOptions = audioHarness.playCyclePlan.mock.calls[1]?.[0] as CyclePlanOptions
    expect(loopOptions.cyclesPerPlan).toBe(1)
    expect(loopOptions.slots).toHaveLength(1)
  })

  it('locks fixture-changing controls during sequence playback and sample audition', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    const sequenceEvents = () => document.querySelector('.visually-hidden[aria-label="Sequence events"]')?.textContent ?? ''
    const originalEvents = sequenceEvents()

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeDisabled()
    expect(screen.getByLabelText('Combo length')).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Loop' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Large pause/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Auto-generate/ })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'New combo every' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'New combo every' })).toHaveValue('2')
    expect(screen.getByRole('checkbox', { name: /Large pause/ })).toBeDisabled()
    expect(screen.getByLabelText('Quick preset')).toBeDisabled()
    selectWorkspaceTab('Files')
    expect(screen.getByLabelText('Choose INI preset')).toBeDisabled()
    expect(screen.queryByLabelText('Choose audio folder')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Choose WAV files')).not.toBeInTheDocument()
    selectWorkspaceTab('Samples')
    expect(screen.getByLabelText('Enable Bundled kick for next combo')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Preview Bundled kick' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit Bundled kick' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeDisabled()
    selectWorkspaceTab('Session')
    expect(screen.getByLabelText('Beat bed')).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Preset' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeDisabled()

    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toBeEnabled()
    expect(screen.getByRole('slider', { name: 'Pitch shift in semitones' })).toBeEnabled()
    expect(screen.getByRole('slider', { name: 'Sample level' })).toBeEnabled()
    expect(screen.getByRole('slider', { name: 'Beat level' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset controls' })).toBeEnabled()

    selectWorkspaceTab('Practice')
    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-generate/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Loop' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Large pause/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'New combo every' }), { target: { value: '8' } })
    fireEvent.click(screen.getByLabelText('Enable Bundled kick for next combo'))
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [
      new File([samplePreset('Locked choice', 'Locked kick', 'locked.wav')], 'locked.ini', { type: 'text/plain' }),
    ])
    expect(sequenceEvents()).toBe(originalEvents)
    expect(screen.getByRole('checkbox', { name: /Auto-generate/ })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    selectWorkspaceTab('Practice')
    expect(screen.getByLabelText('Quick preset')).toBeEnabled()
    selectWorkspaceTab('Practice')
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled()

    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bundled kick' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview Bundled kick' }))
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    selectWorkspaceTab('Practice')
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Auto-generate/ })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'New combo every' })).toBeDisabled()
    selectWorkspaceTab('Samples')
    expect(screen.getByRole('combobox', { name: 'TTM guide for Bundled kick' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save sample changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByLabelText('BPM')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  })

  it('keeps manual playback available with unresolved unselected samples until Auto-generate is enabled', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [{
        eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 8,
        startForward: true, endForward: false, silent: false,
      }],
      requestedRawTicks: 128,
      completedRawTicks: 8,
      remainingRawTicks: 120,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    const availableFile = new File(['available'], 'kick.wav', { type: 'audio/wav' })
    const secondSample = [
      '', '[Sample02]', 'SamplePlayFq=1', 'SampleIsSilent=False', 'SampleRepeatsPoss=True', 'SampleRepeatMax=512',
      'SampleFileName=missing.wav', 'SampleDisplayName=Missing row', 'SampleStartsForward=True', 'SampleEndsForward=False',
      'Sample16ths=8', 'UseSample=False',
    ].join('\n')
    const ini = samplePreset('Local preset', 'Available kick', 'kick.wav').replace('SampleRepeatMax=2', 'SampleRepeatMax=512') + '\n' + secondSample

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await stageLocalImport(new File([ini], 'local.ini', { type: 'text/plain' }), [availableFile])
    await screen.findAllByText('Missing row')
    selectWorkspaceTab('Practice')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Enable Missing row for next combo'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-generate/ }))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(document.querySelector('.auto-generation-help')).toHaveTextContent('Missing row')
  })

  it('allows Auto-generate with an all-silent preset and an empty preload list', async () => {
    const ini = samplePreset('Silent only preset', 'Silent practice slot', 'silent.wav')
      .replace('SampleIsSilent=False', 'SampleIsSilent=True')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
      .replace('UseSample=True', 'UseSample=False')

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    await stageLocalImport(new File([ini], 'silent-only.ini', { type: 'text/plain' }))
    selectWorkspaceTab('Practice')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await screen.findByRole('img', { name: 'Sequence timeline: 128 legacy ticks, 8 events' })

    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-generate/ }))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(document.querySelector('.auto-generation-help')).toHaveTextContent('No audible samples need preloading')
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))

    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as CyclePlanOptions
    expect(options.preloadSampleIds).toEqual([])
    expect(options.nextPlan).toBeTypeOf('function')
    await act(async () => {
      const nextPlan = options.nextPlan?.({ completedRounds: 2, nextPlanIndex: 2 })
      expect(nextPlan?.slots[0]).toMatchObject({ kind: 'fixture' })
    })
  })

  it('discards an older waveform decode after a different preset replaces its file', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [{
        eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 8,
        startForward: true, endForward: false, silent: false,
      }],
      requestedRawTicks: 128,
      completedRawTicks: 8,
      remainingRawTicks: 120,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    let resolveOriginal: (value: unknown) => void = () => undefined
    const originalFile = (presetHarness.loaded as { audioFiles: File[] }).audioFiles[0]
    const originalWaveform = {
      durationSeconds: 0.1,
      peaks: Float32Array.from([1, 0.5]),
      path: 'M0 1 L1 2 Z',
    }
    const replacementWaveform = {
      durationSeconds: 0.1,
      peaks: Float32Array.from([0.5, 1]),
      path: 'M0 2 L1 1 Z',
    }
    const originalDecode = new Promise<unknown>((resolve) => { resolveOriginal = resolve })
    const replacementFile = new File(['replacement audio'], 'replacement.wav', { type: 'audio/wav' })
    waveformHarness.loadWaveform.mockImplementation((file: File) => file === originalFile
      ? originalDecode
      : Promise.resolve(replacementWaveform))

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await waitFor(() => expect(waveformHarness.loadWaveform).toHaveBeenCalledWith(originalFile))

    await stageLocalImport(
      new File([samplePreset('Replacement preset', 'Replacement kick', 'replacement.wav').replace('SampleRepeatMax=2', 'SampleRepeatMax=512')], 'replacement.ini', { type: 'text/plain' }),
      [replacementFile],
    )
    await screen.findAllByText('Replacement kick')
    selectWorkspaceTab('Practice')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    waveformHarness.loadWaveform.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await waitFor(() => expect(waveformHarness.loadWaveform.mock.calls.at(-1)?.[0]?.name).toBe(replacementFile.name))
    await waitFor(() => expect(document.querySelector('.sequence-event--waveform path')).toHaveAttribute('d', replacementWaveform.path))
    await act(async () => { resolveOriginal(originalWaveform); await originalDecode })

    const paths = Array.from(document.querySelectorAll('.sequence-event--waveform path'))
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((path) => path.getAttribute('d') === replacementWaveform.path)).toBe(true)
  })

  it('keeps the latest INI when an older file read finishes last', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Files')
    const input = screen.getByLabelText('Choose INI preset') as HTMLInputElement
    const older = delayedIniFile('older.ini')
    const newer = delayedIniFile('newer.ini')

    chooseFiles(input, [older.file])
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(screen.getAllByText('Bundled kick').length).toBeGreaterThan(0)
    chooseFiles(input, [newer.file])

    await act(async () => {
      newer.resolve(samplePreset('Current preset', 'Current sample', 'current.wav'))
      await Promise.resolve()
    })
    await screen.findByRole('heading', { name: 'Choose the audio files' })

    await act(async () => {
      older.resolve(samplePreset('Stale preset', 'Stale sample', 'stale.wav'))
      await Promise.resolve()
    })
    expect(screen.getByText('Current preset is staged. Choose the folder that contains its WAV files.')).toBeInTheDocument()
    expect(screen.queryByText(/Stale preset is staged/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Bundled kick').length).toBeGreaterThan(0)
    selectWorkspaceTab('Practice')
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
    selectWorkspaceTab('Files')
    chooseFiles(screen.getByLabelText('Choose audio folder') as HTMLInputElement, [new File(['current'], 'current.wav', { type: 'audio/wav' })])
    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
    await screen.findByRole('heading', { name: 'Review and load' })
    await waitFor(() => expect(document.querySelector('.import-wizard')).toHaveAttribute('aria-busy', 'false'))
    fireEvent.click(screen.getByRole('button', { name: 'Load preset' }))
    await screen.findAllByText('Current sample')
    expect(screen.queryByText('Stale sample')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
  })

  it('cancels a pending WAV snapshot and ignores its late result without replacing the active preset', async () => {
    let resolveSnapshot: (value: Awaited<ReturnType<typeof audioHarness.snapshotReferencedWavFiles>>) => void = () => undefined
    const pendingSnapshot = new Promise<Awaited<ReturnType<typeof audioHarness.snapshotReferencedWavFiles>>>((resolve) => {
      resolveSnapshot = resolve
    })
    audioHarness.snapshotReferencedWavFiles.mockImplementationOnce(() => pendingSnapshot)

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Files')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [
      new File([samplePreset('Cancelled candidate', 'Cancel kick', 'cancel.wav')], 'cancel.ini', { type: 'text/plain' }),
    ])
    await screen.findByRole('heading', { name: 'Choose the audio files' })
    const sourceWav = new File(['candidate audio'], 'cancel.wav', { type: 'audio/wav' })
    chooseFiles(screen.getByLabelText('Choose audio folder') as HTMLInputElement, [sourceWav])
    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
    await screen.findByRole('heading', { name: 'Review and load' })
    await waitFor(() => expect(document.querySelector('.import-wizard')).toHaveAttribute('aria-busy', 'true'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('heading', { name: 'Choose your INI preset' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Choose INI preset')))
    expect(screen.getByLabelText('Current session files')).toHaveTextContent('85 BPM - Beginner')

    const snapshotWav = new File([sourceWav], sourceWav.name, { type: sourceWav.type })
    await act(async () => {
      resolveSnapshot({
        filesBySource: new Map([[sourceWav, snapshotWav]]),
        validationBySource: new Map([[sourceWav, {
          status: 'valid', durationSeconds: 0.1, sampleRate: 44100, channelCount: 1, decodedChannelSamples: 1,
        }]]),
        copiedFileCount: 1,
        copiedBytes: sourceWav.size,
        decodeAttemptCount: 1,
        decodedFileCount: 1,
        decodedChannelSamples: 1,
        decodedDurationSeconds: 0.1,
      })
      await pendingSnapshot
    })

    expect(screen.getByRole('heading', { name: 'Choose your INI preset' })).toBeInTheDocument()
    expect(screen.queryByText('Cancelled candidate')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Current session files')).toHaveTextContent('85 BPM - Beginner')
    selectWorkspaceTab('Practice')
    expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-01')
  })

  it('resolves folder paths, keeps byte snapshots, and previews the copied WAV', async () => {
    render(<App />)
    const wav = fileWithPath('kick.wav', 'sounds/kick.wav')
    await stageLocalImport(
      new File([samplePreset('Local preset', 'Local kick', 'kick.wav')], 'local.ini', { type: 'text/plain' }),
      [wav],
    )
    expect(screen.getAllByText('sounds/kick.wav').length).toBeGreaterThan(0)

    selectWorkspaceTab('Samples')
    const preview = await screen.findByRole('button', { name: 'Preview Local kick' })
    fireEvent.click(preview)
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    const options = audioHarness.play.mock.calls[0]?.[0] as { assets: ReadonlyMap<string, File> }
    const retainedWav = options.assets.get('Sample01')
    expect(retainedWav).toBeInstanceOf(File)
    expect(retainedWav).not.toBe(wav)
    expect(retainedWav?.name).toBe('kick.wav')
  })

  it('loads a valid snapshotted preset when only a shorter combo length can generate, then plays that combo', async () => {
    const sourceWav = new File(['compatible audio'], 'compatible.wav', { type: 'audio/wav' })
    const ini = samplePreset('Compatible length preset', 'Compatible hit', 'compatible.wav')
      .replace('SampleRepeatMax=512', 'SampleRepeatMax=1')
      .replace('Sample16ths=8', 'Sample16ths=64')
      .replace('SampleEndsForward=False', 'SampleEndsForward=True')

    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    vi.mocked(domain.generateLegacyCombo).mockImplementation((_preset, requestedRawTicks) => requestedRawTicks === 128
      ? {
        events: [], requestedRawTicks, completedRawTicks: 0, remainingRawTicks: requestedRawTicks,
        terminalReason: 'selection-exhausted', restarts: 16,
      }
      : {
        events: [{
          eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 64,
          startForward: true, endForward: true, silent: false,
        }],
        requestedRawTicks, completedRawTicks: 64, remainingRawTicks: 0,
        terminalReason: 'length-budget-complete', restarts: 0,
      })
    await stageLocalImport(new File([ini], 'compatible.ini', { type: 'text/plain' }), [sourceWav])
    expect(screen.getByRole('button', { name: 'Preset loaded' })).toBeDisabled()
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()

    selectWorkspaceTab('Practice')
    expect(screen.getByRole('alert')).toHaveTextContent(/default 8-beat combo could not be prepared/i)
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await screen.findByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 1 events' })
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as { assets: ReadonlyMap<string, File> }
    const snapshottedWav = options.assets.get('Sample01')
    expect(snapshottedWav).toBeInstanceOf(File)
    expect(snapshottedWav).not.toBe(sourceWav)
    expect(snapshottedWav?.name).toBe(sourceWav.name)
  })

  it('keeps the current preset usable while a candidate INI is being read', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Files')
    const pending = delayedIniFile('pending.ini')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [pending.file])

    selectWorkspaceTab('Practice')
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(screen.getAllByText('Bundled kick').length).toBeGreaterThan(0)

    selectWorkspaceTab('Files')
    await act(async () => {
      pending.resolve(samplePreset('Ready preset', 'Ready sample', 'ready.wav'))
      await Promise.resolve()
    })
    await screen.findByRole('heading', { name: 'Choose the audio files' })
    selectWorkspaceTab('Practice')
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(screen.getAllByText('Bundled kick').length).toBeGreaterThan(0)
    selectWorkspaceTab('Files')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-01')
  })

  it('keeps the transport usable when a page is restored from the back-forward cache', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectDemoPreset()
    audioHarness.stop.mockClear()
    const pageHide = new Event('pagehide')
    Object.defineProperty(pageHide, 'persisted', { value: true })
    await act(async () => { window.dispatchEvent(pageHide) })

    expect(audioHarness.stop).toHaveBeenCalledTimes(1)
    expect(audioHarness.dispose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    expect(audioHarness.play).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText('Playing sequence.')).toBeInTheDocument())
  })

  it('starts with the Beginner preset fully loaded, Beat01 selected, and playback stopped', async () => {
    render(<App />)

    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Practice')
    expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-01')
    expect(screen.getByRole('option', { name: '85 BPM - Beginner · 85 BPM' })).toBeInTheDocument()
    selectWorkspaceTab('Session')
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(85)
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByRole('radio', { name: 'Preset' })).toBeChecked()
    expect(screen.getByRole('option', { name: 'Beat 01 · beat.wav' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Beat 02 · beat-two.wav' })).toBeInTheDocument()
    selectWorkspaceTab('Practice')
    expect(screen.getByRole('radio', { name: 'Q&A' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()
  })

  it('lets a custom INI override a pending built-in load without a late preset overwrite', async () => {
    let resolveBuiltIn: (value: unknown) => void = () => undefined
    presetHarness.loadBuiltInPreset.mockImplementationOnce(() => new Promise((resolve) => { resolveBuiltIn = resolve }))
    render(<App />)
    await waitFor(() => expect(presetHarness.loadBuiltInPreset).toHaveBeenCalledTimes(1))

    const custom = new File([samplePreset('Custom choice', 'Custom row', 'custom.wav')], 'custom.ini', { type: 'text/plain' })
    await stageLocalImport(custom, [new File(['custom audio'], 'custom.wav', { type: 'audio/wav' })])
    await screen.findAllByText('Custom row')

    await act(async () => {
      resolveBuiltIn(presetHarness.loaded)
      await Promise.resolve()
    })
    expect(screen.getAllByText(/Custom choice/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Custom row').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Current session files')).toHaveTextContent('Custom choice')
    selectWorkspaceTab('Practice')
    expect(screen.getByLabelText('Quick preset')).toHaveValue('custom')
  })

  it('applies demo BPM live and restores its source BPM without stopping playback', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectDemoPreset()
    selectWorkspaceTab('Session')
    audioHarness.stop.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    expect(audioHarness.play.mock.calls[0]?.[0]).toHaveProperty('referenceBpm', 100)
    audioHarness.setTempo.mockClear()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '110' } })
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(110)
    expect(audioHarness.setTempo).toHaveBeenLastCalledWith(110)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(100)
    expect(audioHarness.setTempo).toHaveBeenLastCalledWith(100)
    expect(audioHarness.stop).not.toHaveBeenCalled()
  })

  it('lets Your files cancel a pending built-in selection and focuses the INI picker', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Practice')
    let resolveBuiltIn: (value: unknown) => void = () => undefined
    presetHarness.loadBuiltInPreset.mockImplementationOnce(() => new Promise((resolve) => { resolveBuiltIn = resolve }))
    fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'SSC-085BPM-02' } })
    await waitFor(() => expect(presetHarness.loadBuiltInPreset).toHaveBeenCalledTimes(2))

    fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'custom' } })
    const iniPicker = screen.getByLabelText('Choose INI preset')
    await waitFor(() => expect(document.activeElement).toBe(iniPicker))
    expect(screen.getByLabelText('Quick preset')).toHaveValue('custom')
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(audioHarness.stop).toHaveBeenCalled()

    await act(async () => {
      resolveBuiltIn(presetHarness.loaded)
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Quick preset')).toHaveValue('custom')
    expect(screen.queryByText('Bundled kick')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(iniPicker)
  })

  it('keeps playback unavailable after a bundled file error and retries the selected preset', async () => {
    presetHarness.loadBuiltInPreset.mockRejectedValueOnce(new Error('Beat02 could not be fetched.'))
    render(<App />)
    selectWorkspaceTab('Files')

    const retry = await screen.findByRole('button', { name: 'Retry built-in preset' })
    expect(screen.getByRole('alert')).toHaveTextContent('Beat02 could not be fetched.')
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.queryByText('Bundled kick')).not.toBeInTheDocument()
    fireEvent.click(retry)

    selectWorkspaceTab('Practice')
    await screen.findByRole('heading', { name: 'Generated combo' })
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
  })

  it('keeps live tempo, pitch, levels, and reset available while locking fixture and beat-bed changes', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    audioHarness.stop.mockClear()
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as {
      bpm: number
      referenceBpm: number
      pitchSemitones: number
      beatFile?: File
    }
    expect(options).toEqual(expect.objectContaining({ bpm: 85, referenceBpm: 85, pitchSemitones: 0 }))
    expect(options.beatFile?.name).toBe('beat.wav')

    selectWorkspaceTab('Session')
    audioHarness.setTempo.mockClear()
    audioHarness.setPitchSemitones.mockClear()
    audioHarness.setSampleVolume.mockClear()
    audioHarness.setBeatVolume.mockClear()
    fireEvent.change(screen.getByRole('slider', { name: 'BPM range' }), { target: { value: '110' } })
    expect(audioHarness.setTempo).toHaveBeenCalledWith(110)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '100' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Pitch shift in semitones' }), { target: { value: '3' } })
    fireEvent.change(document.getElementById('sample-volume') as HTMLInputElement, { target: { value: '55' } })
    fireEvent.change(document.getElementById('beat-volume') as HTMLInputElement, { target: { value: '40' } })
    expect(screen.getByLabelText('Beat bed')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Beat bed'), { target: { value: '1' } })

    expect(audioHarness.setTempo).toHaveBeenCalledWith(100)
    expect(audioHarness.setPitchSemitones).toHaveBeenCalledWith(3)
    expect(audioHarness.setSampleVolume).toHaveBeenCalledWith(55)
    expect(audioHarness.setBeatVolume).toHaveBeenCalledWith(40)
    expect(audioHarness.stop).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByText('Stop playback to change combo options, beat source, or sample settings.')).toBeInTheDocument()
  })

  it('resets live tempo, pitch, and levels to the selected preset without stopping playback', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))

    selectWorkspaceTab('Session')
    audioHarness.stop.mockClear()
    audioHarness.setTempo.mockClear()
    audioHarness.setPitchSemitones.mockClear()
    audioHarness.setSampleVolume.mockClear()
    audioHarness.setBeatVolume.mockClear()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '100' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Pitch shift in semitones' }), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Sample level'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('Beat level'), { target: { value: '35' } })
    expect(audioHarness.setTempo).toHaveBeenCalledWith(100)

    fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(85)
    expect(screen.getByRole('slider', { name: 'Pitch shift in semitones' })).toHaveValue('0')
    expect(screen.getByLabelText('Sample level')).toHaveValue('80')
    expect(screen.getByLabelText('Beat level')).toHaveValue('60')
    expect(audioHarness.setTempo).toHaveBeenLastCalledWith(85)
    expect(audioHarness.setPitchSemitones).toHaveBeenLastCalledWith(0)
    expect(audioHarness.setSampleVolume).toHaveBeenLastCalledWith(80)
    expect(audioHarness.setBeatVolume).toHaveBeenLastCalledWith(60)
    expect(audioHarness.stop).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByText('Controls reset to the selected preset defaults. Playback continues.')).toBeInTheDocument()
  })

  it('edits sample parameters in memory and saves a working INI copy with the recorded BPM intact', async () => {
    const write = vi.fn(async (_text: string | Blob) => undefined)
    const close = vi.fn(async () => undefined)
    const createWritable = vi.fn(async () => ({ write, close }))
    const picker = vi.fn(async (options: { suggestedName: string }) => ({ name: options.suggestedName, createWritable }))
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker })
    try {
      render(<App />)
      await screen.findByRole('heading', { name: 'Generated combo' })
      selectWorkspaceTab('Samples')
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bundled kick' }))
      const duration = screen.getByRole('spinbutton', { name: 'Duration ticks' })
      await waitFor(() => expect(duration).toHaveFocus())
      fireEvent.change(duration, { target: { value: '12' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save sample changes' }))
      expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled()

      selectWorkspaceTab('Session')
      fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '100' } })
      fireEvent.change(screen.getByLabelText('Sample level'), { target: { value: '55' } })
      fireEvent.change(screen.getByLabelText('Beat level'), { target: { value: '40' } })
      selectWorkspaceTab('Samples')
      fireEvent.click(screen.getByRole('button', { name: 'Save Sample Data' }))
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'SSC-085BPM-01-edited.ini' }))
      const savedText = write.mock.calls[0]?.[0]
      expect(savedText).toContain('Sample16ths=12')
      expect(savedText).toContain('BPM01=85')
      expect(savedText).toContain('VOL_S=55')
      expect(savedText).toContain('VOL_B=40')
      expect(savedText).not.toContain('BPM01=100')
      await waitFor(() => expect(document.querySelector('.visually-hidden[aria-live="polite"]')).toHaveTextContent(/Working preset copy saved as SSC-085BPM-01-edited\.ini/))
      selectWorkspaceTab('Session')
      fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))
      expect(screen.getByLabelText('Sample level')).toHaveValue('80')
      expect(screen.getByLabelText('Beat level')).toHaveValue('60')
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    }
  })

  it('does not apply a delayed Save As completion to a newly selected preset', async () => {
    let finishClose: () => void = () => undefined
    const closePromise = new Promise<void>((resolve) => { finishClose = resolve })
    const write = vi.fn(async (_text: string | Blob) => undefined)
    const close = vi.fn(() => closePromise)
    const abort = vi.fn(async () => undefined)
    const createWritable = vi.fn(async () => ({ write, close, abort }))
    const picker = vi.fn(async (options: { suggestedName: string }) => ({ name: options.suggestedName, createWritable }))
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker })
    try {
      render(<App />)
      await screen.findByRole('heading', { name: 'Generated combo' })
      selectWorkspaceTab('Samples')
      fireEvent.click(screen.getByRole('button', { name: 'Save Sample Data' }))
      await waitFor(() => expect(close).toHaveBeenCalledOnce())

      selectWorkspaceTab('Practice')
      fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'SSC-085BPM-02' } })
      await waitFor(() => expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-02'))
      selectWorkspaceTab('Samples')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled())
      await act(async () => { finishClose(); await closePromise })

      expect(write).toHaveBeenCalledOnce()
      expect(abort).not.toHaveBeenCalled()
      expect(document.querySelector('.visually-hidden[aria-live="polite"]')).toHaveTextContent(/85 BPM - Average ready/)
      expect(screen.queryByText(/Working preset copy saved as SSC-085BPM-01-edited\.ini/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled()
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    }
  })

  it('allows unchanged legacy values above the web edit cap but rejects changed out-of-range values', async () => {
    render(<App />)
    const ini = samplePreset('Long legacy field', 'Long kick', 'kick.wav').replace('Sample16ths=8', 'Sample16ths=513')
    await stageLocalImport(
      new File([ini], 'long.ini', { type: 'text/plain' }),
      [new File(['kick'], 'kick.wav', { type: 'audio/wav' })],
    )
    selectWorkspaceTab('Samples')
    await screen.findByRole('button', { name: 'Edit Long kick' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Long kick' }))
    expect(screen.getByRole('spinbutton', { name: 'Duration ticks' })).toHaveValue(513)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Play weight' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save sample changes' }))
    expect(screen.getByText('513 legacy ticks')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Long kick' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Duration ticks' }), { target: { value: '999999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save sample changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('durationUnits must be an integer from 0 to 512')
  })

  it('does not dispose during StrictMode effect replay but disposes after real unmount', async () => {
    const { unmount } = render(<StrictMode><App /></StrictMode>)
    await act(async () => { await Promise.resolve() })
    expect(audioHarness.dispose).not.toHaveBeenCalled()

    unmount()
    await act(async () => { await Promise.resolve() })
    expect(audioHarness.dispose).toHaveBeenCalledTimes(1)
  })

  it.each([
    [4, 64],
    [8, 128],
    [16, 256],
    [32, 512],
  ])('plays a Q&A cycle for the generated %i-beat combo in raw legacy ticks', async (beats, rawTicks) => {
    render(<App />)
    const ini = samplePreset('Silent tick fixture', 'Silent pad', 'silent.wav')
      .replace('SampleIsSilent=False', 'SampleIsSilent=True')
      .replace('SampleRepeatsPoss=True', 'SampleRepeatsPoss=True')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
      .replace('UseSample=True', 'UseSample=False')
    await stageLocalImport(new File([ini], 'ticks.ini', { type: 'text/plain' }))
    selectWorkspaceTab('Practice')
    await screen.findByRole('button', { name: 'Generate combo' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: String(beats) } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await screen.findByRole('img', { name: `Sequence timeline: ${rawTicks} legacy ticks, ${rawTicks / 16} events` })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as { slots: Array<{ kind: string; fixture?: { totalUnits: number }; durationUnits?: number }>; unitsPerBeat: number }
    expect(options.slots).toHaveLength(2)
    expect(options.slots[0]).toEqual(expect.objectContaining({ kind: 'fixture', fixture: expect.objectContaining({ totalUnits: rawTicks }) }))
    expect(options.slots[1]).toEqual({ kind: 'silence', durationUnits: rawTicks })
    expect(options.unitsPerBeat).toBe(16)
  })

  it('keeps the generated timeline visible while Q&A reports its answer phase and large pause adds three silent cycles', async () => {
    render(<App />)
    const ini = samplePreset('Q&A cycle fixture', 'Silent pad', 'silent.wav')
      .replace('SampleIsSilent=False', 'SampleIsSilent=True')
      .replace('SampleRepeatsPoss=True', 'SampleRepeatsPoss=True')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
      .replace('UseSample=True', 'UseSample=False')
    await stageLocalImport(new File([ini], 'qa.ini', { type: 'text/plain' }))
    selectWorkspaceTab('Practice')
    await screen.findByRole('button', { name: 'Generate combo' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    const timeline = await screen.findByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })

    expect(screen.getByRole('radio', { name: 'Q&A' })).toBeChecked()
    expect(screen.getByText('1 audio cycle, then 1 silent cycle.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await screen.findByText('Q&A · question playback · cycle 1.')
    audioHarness.stop.mockClear()

    await act(async () => {
      audioHarness.emit({
        status: 'playing', progress: 0.75, cycleSlotIndex: 1, cycleIteration: 1, cycleSlotKind: 'silence',
        presentation: { started: true, progress: 0.75, positionUnits: 32, cycleSlotIndex: 1, cycleIteration: 1, cycleSlotKind: 'silence' },
      })
    })
    expect(await screen.findByText('Q&A · answer pause · cycle 2.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })).toBe(timeline)
    expect(document.querySelector('.timeline-playhead')).toHaveStyle({ left: '50%' })

    expect(screen.getByRole('checkbox', { name: /Large pause/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Large pause/ }))
    expect(screen.getByText('1 audio cycle, then 1 silent cycle.')).toBeInTheDocument()
    expect(audioHarness.stop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Large pause/ }))
    expect(audioHarness.stop).toHaveBeenCalled()
    expect(screen.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })).toBeInTheDocument()
    expect(screen.getByText('1 audio cycle, then 3 silent cycles.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(2))
    const options = audioHarness.playCyclePlan.mock.calls[1]?.[0] as { slots: Array<{ kind: string; durationUnits?: number }> }
    expect(options.slots.map((slot) => slot.kind)).toEqual(['fixture', 'silence', 'silence', 'silence'])
    expect(options.slots.slice(1).map((slot) => slot.durationUnits)).toEqual([64, 64, 64])

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Loop' }))
    expect(screen.queryByRole('checkbox', { name: /Large pause/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(3))
    const loopOptions = audioHarness.playCyclePlan.mock.calls[2]?.[0] as { slots: Array<{ kind: string }> }
    expect(loopOptions.slots).toEqual([{ kind: 'fixture', fixture: expect.any(Object) }])
  })

  it('keeps silent rows included and non-editable', async () => {
    render(<App />)
    selectWorkspaceTab('Files')
    const ini = samplePreset('Silent tick fixture', 'Silent pad', 'silent.wav')
      .replace('SampleIsSilent=False', 'SampleIsSilent=True')
      .replace('UseSample=True', 'UseSample=False')
    await stageLocalImport(new File([ini], 'silent.ini', { type: 'text/plain' }))
    selectWorkspaceTab('Samples')

    const silentToggle = await screen.findByRole('checkbox', { name: 'Enable Silent pad for next combo' })
    expect(silentToggle).toBeChecked()
    expect(silentToggle).toBeDisabled()
    expect(screen.getByText('Always included')).toBeInTheDocument()
  })

  it('blocks loading a preset when an enabled audible sample WAV is missing', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    const ini = samplePreset('Unresolved tick fixture', 'Unresolved kick', 'kick.wav')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
    await stageLocalImport(new File([ini], 'unresolved.ini', { type: 'text/plain' }), [], { load: false })

    expect(screen.getByRole('button', { name: 'Load preset' })).toBeDisabled()
    expect(screen.getByText('Required WAV missing')).toBeInTheDocument()
    expect(screen.getAllByText('kick.wav').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bundled kick').length).toBeGreaterThan(0)
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()
  })

  it('clears generated selection when an eligible sample is toggled', async () => {
    render(<App />)
    selectWorkspaceTab('Files')
    const ini = samplePreset('Toggle tick fixture', 'Kick', 'kick.wav')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
    await stageLocalImport(
      new File([ini], 'toggle.ini', { type: 'text/plain' }),
      [new File(['kick'], 'kick.wav', { type: 'audio/wav' })],
    )
    selectWorkspaceTab('Practice')
    await screen.findByRole('button', { name: 'Generate combo' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await screen.findByRole('img', { name: 'Sequence timeline: 128 legacy ticks, 8 events' })

    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Kick for next combo' }))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    selectWorkspaceTab('Practice')
    expect(screen.getByText('Generate a combo to preview the sequence')).toBeInTheDocument()
    expect(audioHarness.stop).toHaveBeenCalled()
  })

  it('omits zero-duration native picks only from the playable fixture and resolves only later audio picks', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValue({
      events: [
        { eventNumber: 1, sampleNumber: 1, sampleId: 'Sample01', startTick: 0, durationTicks: 0, startForward: true, endForward: true, silent: false },
        { eventNumber: 2, sampleNumber: 2, sampleId: 'Sample02', startTick: 0, durationTicks: 16, startForward: true, endForward: false, silent: false },
      ],
      requestedRawTicks: 64,
      completedRawTicks: 16,
      remainingRawTicks: 48,
      terminalReason: 'minimum-fit-exhausted',
      restarts: 0,
    })
    const ini = [
      '[Samples]', 'ConfigName=Zero duration fixture', 'BPM01=96', 'Beat01=beat.wav', 'VOL_B=60', 'VOL_S=80',
      '[Sample01]', 'SamplePlayFq=1', 'SampleIsSilent=False', 'SampleRepeatsPoss=False', 'SampleRepeatMax=0',
      'SampleFileName=zero.wav', 'SampleDisplayName=Zero tick', 'SampleStartsForward=True', 'SampleEndsForward=True',
      'Sample16ths=0', 'UseSample=True',
      '[Sample02]', 'SamplePlayFq=1', 'SampleIsSilent=False', 'SampleRepeatsPoss=True', 'SampleRepeatMax=512',
      'SampleFileName=positive.wav', 'SampleDisplayName=Positive hit', 'SampleStartsForward=True', 'SampleEndsForward=False',
      'Sample16ths=16', 'UseSample=True',
    ].join('\n')
    render(<App />)
    const positiveWav = new File(['local audio'], 'positive.wav', { type: 'audio/wav' })
    await stageLocalImport(new File([ini], 'zero-duration.ini', { type: 'text/plain' }), [positiveWav])
    selectWorkspaceTab('Practice')
    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await screen.findByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 2 events' })
    expect(screen.getByText('1 zero-length selection was omitted from audio preview.')).toBeInTheDocument()
    const timelineFigure = screen.getByRole('figure')
    expect(within(timelineFigure).getByText('Positive hit')).toBeInTheDocument()
    expect(within(timelineFigure).queryByText('Zero tick')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))

    expect(domain.generateLegacyCombo).toHaveBeenCalledWith(expect.anything(), 64, expect.any(Function))
    const playOptions = audioHarness.playCyclePlan.mock.calls[0]?.[0] as { slots: Array<{ kind: string; fixture?: { totalUnits: number; events: Array<{ sampleId: string; durationUnits: number }> } }>; unitsPerBeat: number; assets: ReadonlyMap<string, File> }
    expect(playOptions.slots[0]?.kind).toBe('fixture')
    expect(playOptions.slots[0]?.fixture?.totalUnits).toBe(64)
    expect(playOptions.slots[0]?.fixture?.events).toEqual([
      expect.objectContaining({ sampleId: 'Sample02', durationUnits: 16 }),
      expect.objectContaining({ sampleId: '__rest__', durationUnits: 48 }),
    ])
    expect(playOptions.assets.get('Sample02')).toBeInstanceOf(File)
    expect(playOptions.assets.get('Sample02')).not.toBe(positiveWav)
    expect(playOptions.assets.get('Sample02')?.name).toBe(positiveWav.name)
    expect(playOptions.assets.has('Sample01')).toBe(false)
    expect(playOptions.unitsPerBeat).toBe(16)
  })

  it('reviews a locally analyzed custom beat, keeps it separate from scratch BPM, and never autoplays', async () => {
    const beatBuffer = { duration: 6 } as AudioBuffer
    bpmHarness.analyzeLocalAudioFile.mockResolvedValue({
      buffer: beatBuffer,
      detection: { status: 'detected', bpm: 110, confidence: 0.78, alternatives: [55] },
      durationSeconds: 6,
      sampleRate: 44100,
      channelCount: 2,
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Session')
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    const beat = new File(['local beat'], 'club-loop.mp3', { type: 'audio/mpeg' })
    chooseFiles(screen.getByLabelText('Upload custom beat') as HTMLInputElement, [beat])

    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(await screen.findByText(/club-loop\.mp3: estimated 110 BPM/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(screen.getByLabelText('BPM')).toHaveValue(85)
    expect(screen.getByRole('radio', { name: 'Preset' })).not.toBeChecked()
    expect(screen.getByText(/No custom beat is applied/i)).toBeInTheDocument()
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use custom beat' }))
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByLabelText('BPM')).toHaveValue(110)
    expect(screen.getByLabelText('Recorded BPM for custom beat')).toHaveValue(110)
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()

    selectWorkspaceTab('Samples')
    fireEvent.click(screen.getByRole('button', { name: 'Preview Bundled kick' }))
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    const samplePreviewOptions = audioHarness.play.mock.calls[0]?.[0] as Record<string, unknown>
    expect(samplePreviewOptions).toHaveProperty('referenceBpm', 85)
    expect(samplePreviewOptions).not.toHaveProperty('beatReferenceBpm')
    expect(samplePreviewOptions).not.toHaveProperty('beatBuffer')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    selectWorkspaceTab('Session')
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as {
      referenceBpm: number
      beatReferenceBpm: number
      beatBuffer: AudioBuffer
      assets: ReadonlyMap<string, File>
    }
    expect(options.referenceBpm).toBe(85)
    expect(options.beatReferenceBpm).toBe(110)
    expect(options.beatBuffer).toBe(beatBuffer)
    expect(options.assets.has('Sample01')).toBe(true)
    expect(screen.getByLabelText('Upload custom beat')).toBeDisabled()
    expect(screen.getByLabelText('Recorded BPM for custom beat')).toBeDisabled()
    expect(screen.getByLabelText('BPM')).toBeEnabled()
  })

  it('keeps an accepted custom beat selected across a built-in sample preset change', async () => {
    const beatBuffer = { duration: 6 } as AudioBuffer
    bpmHarness.analyzeLocalAudioFile.mockResolvedValue({
      buffer: beatBuffer,
      detection: { status: 'detected', bpm: 120, confidence: 0.7, alternatives: [] },
      durationSeconds: 6,
      sampleRate: 44100,
      channelCount: 2,
    })
    const original = presetHarness.loaded as { preset: domain.Preset; audioFiles: File[]; iniText: string }
    const preset96 = domain.parseLegacyIni(samplePreset('96 BPM replacement', 'Replacement kick', 'kick.wav')
      .replace('BPM01=100', 'BPM01=96')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512'))
    presetHarness.loadBuiltInPreset.mockImplementation(async (entry: { iniFile: string }) => ({
      ...original,
      preset: entry.iniFile.includes('096BPM2') ? preset96 : original.preset,
      iniFile: new File([original.iniText], entry.iniFile, { type: 'text/plain' }),
    }))
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Session')
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    chooseFiles(screen.getByLabelText('Upload custom beat') as HTMLInputElement, [new File(['beat'], '120-loop.wav', { type: 'audio/wav' })])
    await screen.findByText(/estimated 120 BPM/)
    fireEvent.click(screen.getByRole('button', { name: 'Use custom beat' }))

    selectWorkspaceTab('Practice')
    fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'SSC-096BPM2-01' } })
    await waitFor(() => expect(document.querySelector('.visually-hidden[aria-live="polite"]')).toHaveTextContent(/96 BPM Set 2 ready/))
    selectWorkspaceTab('Session')
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByLabelText('Recorded BPM for custom beat')).toHaveValue(120)
    expect(screen.getByLabelText('BPM')).toHaveValue(120)
    expect(screen.getByText(/scratch source 96 · beat source 120/)).toBeInTheDocument()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as {
      referenceBpm: number
      beatReferenceBpm: number
      beatBuffer: AudioBuffer
      assets: ReadonlyMap<string, File>
    }
    expect(options.referenceBpm).toBe(96)
    expect(options.beatReferenceBpm).toBe(120)
    expect(options.beatBuffer).toBe(beatBuffer)
    expect(options.assets.has('Sample01')).toBe(true)
    selectWorkspaceTab('Samples')
    expect(within(screen.getByRole('table')).getByText('Replacement kick')).toBeInTheDocument()
  })

  it('keeps the current beat after an invalid custom beat and asks for a BPM when detection is ambiguous', async () => {
    const beatBuffer = { duration: 6 } as AudioBuffer
    bpmHarness.analyzeLocalAudioFile
      .mockResolvedValueOnce({
        buffer: beatBuffer,
        detection: { status: 'detected', bpm: 100, confidence: 0.72, alternatives: [] },
        durationSeconds: 6,
        sampleRate: 44100,
        channelCount: 2,
      })
      .mockRejectedValueOnce(new Error('Unsupported audio encoding.'))
      .mockResolvedValueOnce({
        buffer: { duration: 4 } as AudioBuffer,
        detection: { status: 'ambiguous', candidates: [80, 160], confidence: 0.41 },
        durationSeconds: 4,
        sampleRate: 44100,
        channelCount: 2,
      })
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectWorkspaceTab('Session')
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    chooseFiles(screen.getByLabelText('Upload custom beat') as HTMLInputElement, [new File(['beat'], 'good.wav', { type: 'audio/wav' })])
    await screen.findByText(/estimated 100 BPM/)
    fireEvent.click(screen.getByRole('button', { name: 'Use custom beat' }))

    chooseFiles(screen.getByLabelText('Upload custom beat') as HTMLInputElement, [new File(['broken'], 'broken.mp3', { type: 'audio/mpeg' })])
    expect(await screen.findByText(/Could not analyze broken\.mp3/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByLabelText('Recorded BPM for custom beat')).toHaveValue(100)
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()

    chooseFiles(screen.getByLabelText('Upload custom beat') as HTMLInputElement, [new File(['ambiguous'], 'ambiguous.wav', { type: 'audio/wav' })])
    expect(await screen.findByText(/pulse is ambiguous/)).toHaveTextContent('80, 160 BPM')
    expect(screen.getByRole('button', { name: 'Use custom beat' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Custom beat BPM' }), { target: { value: '160' } })
    expect(screen.getByRole('button', { name: 'Use custom beat' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Use custom beat' }))
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByLabelText('Recorded BPM for custom beat')).toHaveValue(160)
    expect(screen.getByLabelText('BPM')).toHaveValue(160)
  })
})
