import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    emit({ status: 'playing', progress: 0, cycleSlotIndex: 0, cycleIteration: 1, cycleSlotKind: 'fixture' })
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
  }
  return {
    listeners, subscribe, getSnapshot, getProgress, play, playCyclePlan,
    setTempo, setPitchSemitones, setSampleVolume, setBeatVolume,
    stop, resetAssets, dispose, emit, reset,
  }
})

const presetHarness = vi.hoisted(() => ({
  fetchBuiltInPresetCatalog: vi.fn(),
  loadBuiltInPreset: vi.fn(),
  loaded: undefined as unknown,
}))

vi.mock('./audio', () => ({
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

vi.mock('./domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./domain')>()
  return { ...actual, generateLegacyCombo: vi.fn(actual.generateLegacyCombo) }
})

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
    'SampleRepeatMax=2',
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

function fileWithPath(fileName: string, relativePath: string) {
  const file = new File(['audio'], fileName, { type: 'audio/wav' })
  Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: relativePath })
  return file
}

function selectDemoPreset() {
  fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'demo' } })
}

beforeEach(() => {
  audioHarness.reset()
  vi.mocked(domain.generateLegacyCombo).mockClear()
  presetHarness.fetchBuiltInPresetCatalog.mockReset()
  presetHarness.loadBuiltInPreset.mockReset()
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
})
afterEach(async () => {
  cleanup()
  await Promise.resolve()
})

describe('workspace import and transport lifecycle', () => {
  it('keeps the latest INI when an older file read finishes last', async () => {
    render(<App />)
    const input = screen.getByLabelText('Choose INI preset') as HTMLInputElement
    const older = delayedIniFile('older.ini')
    const newer = delayedIniFile('newer.ini')

    chooseFiles(input, [older.file])
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    chooseFiles(input, [newer.file])

    await act(async () => {
      newer.resolve(samplePreset('Current preset', 'Current sample', 'current.wav'))
      await Promise.resolve()
    })
    await screen.findAllByText('Current sample')

    await act(async () => {
      older.resolve(samplePreset('Stale preset', 'Stale sample', 'stale.wav'))
      await Promise.resolve()
    })
    expect(screen.getAllByText('Current sample')).toHaveLength(1)
    expect(screen.queryByText('Stale sample')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
  })

  it('resolves against WAV files selected while an INI read is pending', async () => {
    render(<App />)
    const ini = delayedIniFile('local.ini')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [ini.file])
    const wav = new File(['local audio'], 'kick.wav', { type: 'audio/wav' })
    chooseFiles(screen.getByLabelText('Choose WAV files') as HTMLInputElement, [wav])

    await act(async () => {
      ini.resolve(samplePreset('Local preset', 'Local kick', 'kick.wav'))
      await Promise.resolve()
    })

    const preview = await screen.findByRole('button', { name: 'Preview Local kick' })
    fireEvent.click(preview)
    await waitFor(() => expect(audioHarness.play).toHaveBeenCalledTimes(1))
    const options = audioHarness.play.mock.calls[0]?.[0] as { assets: ReadonlyMap<string, File> }
    expect(options.assets.get('Sample01')).toBe(wav)
  })

  it('gates build, sequence play, and sample preview while reading an INI', async () => {
    render(<App />)
    const pending = delayedIniFile('pending.ini')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [pending.file])

    expect(screen.getByRole('button', { name: 'Build preview' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Preview Tone' })).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(samplePreset('Ready preset', 'Ready sample', 'ready.wav'))
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate combo' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
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
    expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-01')
    expect(screen.getByRole('option', { name: '85 BPM - Beginner · 85 BPM' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(85)
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByRole('option', { name: 'Beat 01 · beat.wav' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Beat 02 · beat-two.wav' })).toBeInTheDocument()
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
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [custom])
    await screen.findByText('Custom row')

    await act(async () => {
      resolveBuiltIn(presetHarness.loaded)
      await Promise.resolve()
    })
    expect(screen.getByText(/Custom choice/)).toBeInTheDocument()
    expect(screen.getByText('Custom row')).toBeInTheDocument()
    expect(screen.queryByText('Bundled kick')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Quick preset')).toHaveValue('custom')
  })

  it('applies demo BPM live and restores its source BPM without stopping playback', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    selectDemoPreset()
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

    const retry = await screen.findByRole('button', { name: 'Retry built-in preset' })
    expect(screen.getByRole('alert')).toHaveTextContent('Beat02 could not be fetched.')
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.queryByText('Bundled kick')).not.toBeInTheDocument()
    fireEvent.click(retry)

    await screen.findByRole('heading', { name: 'Generated combo' })
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeEnabled()
  })

  it('keeps tempo, pitch, sample level, beat level, and beat selection independent while playing', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))
    const options = audioHarness.playCyclePlan.mock.calls[0]?.[0] as {
      bpm: number
      referenceBpm: number
      pitchSemitones: number
      beatFile?: File
    }
    expect(options).toEqual(expect.objectContaining({ bpm: 85, referenceBpm: 85, pitchSemitones: 0 }))
    expect(options.beatFile?.name).toBe('beat.wav')

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
    fireEvent.change(screen.getByLabelText('Beat bed'), { target: { value: '1' } })

    expect(audioHarness.setTempo).toHaveBeenCalledWith(100)
    expect(audioHarness.setPitchSemitones).toHaveBeenCalledWith(3)
    expect(audioHarness.setSampleVolume).toHaveBeenCalledWith(55)
    expect(audioHarness.setBeatVolume).toHaveBeenCalledWith(40)
    expect(audioHarness.stop).toHaveBeenCalled()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('1')
    expect(screen.getByText('Playback stopped. Beat selection changed; play again to hear it.')).toBeInTheDocument()
  })

  it('resets live tempo, pitch, and levels to the selected preset without stopping playback', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Generated combo' })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(1))

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
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bundled kick' }))
      const duration = screen.getByRole('spinbutton', { name: 'Duration ticks' })
      await waitFor(() => expect(duration).toHaveFocus())
      fireEvent.change(duration, { target: { value: '12' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save sample changes' }))
      expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled()

      fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '100' } })
      fireEvent.change(screen.getByLabelText('Sample level'), { target: { value: '55' } })
      fireEvent.change(screen.getByLabelText('Beat level'), { target: { value: '40' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Sample Data' }))
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'SSC-085BPM-01-edited.ini' }))
      const savedText = write.mock.calls[0]?.[0]
      expect(savedText).toContain('Sample16ths=12')
      expect(savedText).toContain('BPM01=85')
      expect(savedText).toContain('VOL_S=55')
      expect(savedText).toContain('VOL_B=40')
      expect(savedText).not.toContain('BPM01=100')
      await waitFor(() => expect(within(document.querySelector('.import-status') as HTMLElement).getByText(/Working preset copy saved as SSC-085BPM-01-edited\.ini/)).toBeInTheDocument())
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
      fireEvent.click(screen.getByRole('button', { name: 'Save Sample Data' }))
      await waitFor(() => expect(close).toHaveBeenCalledOnce())

      fireEvent.change(screen.getByLabelText('Quick preset'), { target: { value: 'SSC-085BPM-02' } })
      await waitFor(() => expect(screen.getByLabelText('Quick preset')).toHaveValue('SSC-085BPM-02'))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled())
      await act(async () => { finishClose(); await closePromise })

      expect(write).toHaveBeenCalledOnce()
      expect(abort).not.toHaveBeenCalled()
      expect(within(document.querySelector('.import-status') as HTMLElement).getByText(/85 BPM - Average ready/)).toBeInTheDocument()
      expect(screen.queryByText(/Working preset copy saved as SSC-085BPM-01-edited\.ini/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save Sample Data' })).toBeEnabled()
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    }
  })

  it('allows unchanged legacy values above the web edit cap but rejects changed out-of-range values', async () => {
    render(<App />)
    const ini = samplePreset('Long legacy field', 'Long kick', 'kick.wav').replace('Sample16ths=8', 'Sample16ths=513')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'long.ini', { type: 'text/plain' })])
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
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'ticks.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })

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
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'qa.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })
    fireEvent.change(screen.getByLabelText('Combo length'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    const timeline = await screen.findByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })

    expect(screen.getByRole('radio', { name: 'Q&A' })).toBeChecked()
    expect(screen.getByText('1 audio cycle, then 1 silent cycle.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await screen.findByText('Q&A · question playback · cycle 1.')

    await act(async () => {
      audioHarness.emit({ status: 'playing', progress: 0.75, cycleSlotIndex: 1, cycleIteration: 1, cycleSlotKind: 'silence' })
    })
    expect(await screen.findByText('Q&A · answer pause · cycle 2.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })).toBe(timeline)
    expect(document.querySelector('.timeline-playhead')).toHaveStyle({ left: '50%' })

    fireEvent.click(screen.getByRole('checkbox', { name: /Large pause/ }))
    expect(audioHarness.stop).toHaveBeenCalled()
    expect(screen.getByRole('img', { name: 'Sequence timeline: 64 legacy ticks, 4 events' })).toBeInTheDocument()
    expect(screen.getByText('1 audio cycle, then 3 silent cycles.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(2))
    const options = audioHarness.playCyclePlan.mock.calls[1]?.[0] as { slots: Array<{ kind: string; durationUnits?: number }> }
    expect(options.slots.map((slot) => slot.kind)).toEqual(['fixture', 'silence', 'silence', 'silence'])
    expect(options.slots.slice(1).map((slot) => slot.durationUnits)).toEqual([64, 64, 64])

    fireEvent.click(screen.getByRole('radio', { name: 'Loop' }))
    expect(screen.queryByRole('checkbox', { name: /Large pause/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    await waitFor(() => expect(audioHarness.playCyclePlan).toHaveBeenCalledTimes(3))
    const loopOptions = audioHarness.playCyclePlan.mock.calls[2]?.[0] as { slots: Array<{ kind: string }> }
    expect(loopOptions.slots).toEqual([{ kind: 'fixture', fixture: expect.any(Object) }])
  })

  it('keeps silent rows included and non-editable', async () => {
    render(<App />)
    const ini = samplePreset('Silent tick fixture', 'Silent pad', 'silent.wav')
      .replace('SampleIsSilent=False', 'SampleIsSilent=True')
      .replace('UseSample=True', 'UseSample=False')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'silent.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })

    const silentToggle = screen.getByRole('checkbox', { name: 'Enable Silent pad for next combo' })
    expect(silentToggle).toBeChecked()
    expect(silentToggle).toBeDisabled()
    expect(screen.getByText('Always included')).toBeInTheDocument()
  })

  it('allows generation without WAVs but blocks playback when the chosen event is unresolved', async () => {
    render(<App />)
    const ini = samplePreset('Unresolved tick fixture', 'Unresolved kick', 'kick.wav')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'unresolved.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))

    await screen.findByRole('img', { name: 'Sequence timeline: 128 legacy ticks, 8 events' })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('WAV files that are not ready: Unresolved kick')
    expect(audioHarness.play).not.toHaveBeenCalled()
    expect(audioHarness.playCyclePlan).not.toHaveBeenCalled()
  })

  it('clears generated selection when an eligible sample is toggled', async () => {
    render(<App />)
    const ini = samplePreset('Toggle tick fixture', 'Kick', 'kick.wav')
      .replace('SampleRepeatMax=2', 'SampleRepeatMax=512')
      .replace('Sample16ths=8', 'Sample16ths=16')
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'toggle.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate combo' }))
    await screen.findByRole('img', { name: 'Sequence timeline: 128 legacy ticks, 8 events' })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Kick for next combo' }))
    expect(screen.getByRole('button', { name: 'Play sequence' })).toBeDisabled()
    expect(screen.getByText('Generate a combo to preview the sequence')).toBeInTheDocument()
    expect(audioHarness.stop).toHaveBeenCalled()
  })

  it('omits zero-duration native picks only from the playable fixture and resolves only later audio picks', async () => {
    vi.mocked(domain.generateLegacyCombo).mockReturnValueOnce({
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
    chooseFiles(screen.getByLabelText('Choose INI preset') as HTMLInputElement, [new File([ini], 'zero-duration.ini', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Generate combo' })
    const positiveWav = new File(['local audio'], 'positive.wav', { type: 'audio/wav' })
    chooseFiles(screen.getByLabelText('Choose WAV files') as HTMLInputElement, [positiveWav])
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
    expect(playOptions.assets.get('Sample02')).toBe(positiveWav)
    expect(playOptions.assets.has('Sample01')).toBe(false)
    expect(playOptions.unitsPerBeat).toBe(16)
  })
})
