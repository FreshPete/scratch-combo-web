import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControls, type SessionControlsProps } from './SessionControls'
import { DEFAULT_TEMPO_TRAINING_SETTINGS } from './tempo-training'
import { loadWaveform } from './waveforms/waveform'

vi.mock('./waveforms/waveform', async (importOriginal) => {
  const original = await importOriginal<typeof import('./waveforms/waveform')>()
  return { ...original, loadWaveform: vi.fn() }
})

function props(overrides: Partial<SessionControlsProps> = {}): SessionControlsProps {
  return {
    bpm: '85',
    referenceBpm: 85,
    pitchSemitones: 0,
    sampleVolume: 80,
    beatVolume: 60,
    beatFiles: ['Practice beat.wav'],
    beatResolutions: [{
      status: 'resolved',
      requested: 'Practice beat.wav',
      file: new File([], 'Practice beat.wav'),
      candidates: [],
    }],
    selectedBeatIndex: '0',
    customBeatFileName: null,
    customBeatSelected: false,
    customBeatReferenceBpm: null,
    customBeatReferenceBpmInput: '',
    customBeatAnalysisStatus: 'idle',
    customBeatCandidateFileName: null,
    customBeatCandidateBpm: '',
    customBeatCandidateMessage: '',
    customBeatCandidateReady: false,
    beatTrimSourceKey: null,
    beatTrimSourceName: null,
    beatTrimSourceReferenceBpm: null,
    beatTrimSourceFile: null,
    beatTrimSourceBuffer: null,
    beatTrim: null,
    tempoTraining: { ...DEFAULT_TEMPO_TRAINING_SETTINGS },
    tempoTrainingDisabled: false,
    repeatingPracticeAvailable: true,
    disabled: false,
    onBpmChange: vi.fn(),
    onPitchChange: vi.fn(),
    onSampleVolumeChange: vi.fn(),
    onBeatVolumeChange: vi.fn(),
    onBeatSelectionChange: vi.fn(),
    onCustomBeatFileChange: vi.fn(),
    onCustomBeatCandidateBpmChange: vi.fn(),
    onUseCustomBeat: vi.fn(),
    onCustomBeatReferenceBpmChange: vi.fn(),
    onApplyBeatTrim: vi.fn(),
    onResetBeatTrim: vi.fn(),
    onTempoTrainingEnabledChange: vi.fn(),
    onTempoTrainingTargetChange: vi.fn(),
    onTempoTrainingStepChange: vi.fn(),
    onTempoTrainingRoundsChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  }
}

describe('SessionControls', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(loadWaveform).mockReset()
  })

  it('keeps numeric tempo and its range connected to the same change handler', () => {
    const onBpmChange = vi.fn()
    render(<SessionControls {...props({ onBpmChange })} />)

    const bpmField = screen.getByRole('spinbutton', { name: 'BPM' })
    const bpmRange = screen.getByRole('slider', { name: 'BPM range' })
    expect(bpmField).toHaveValue(85)
    expect(bpmRange).toHaveAttribute('min', '42.5')
    expect(bpmRange).toHaveAttribute('max', '170')

    fireEvent.change(bpmField, { target: { value: '92' } })
    fireEvent.change(bpmRange, { target: { value: '100' } })

    expect(onBpmChange.mock.calls).toEqual([['92'], ['100']])
  })

  it('routes pitch, levels, beat selection, and reset to their handlers', () => {
    const controlProps = props()
    render(<SessionControls {...controlProps} />)

    fireEvent.change(screen.getByRole('slider', { name: 'Pitch shift in semitones' }), { target: { value: '-12' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Sample level' }), { target: { value: '0' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Beat level' }), { target: { value: '100' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Beat bed' }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))

    expect(controlProps.onPitchChange).toHaveBeenCalledWith(-12)
    expect(controlProps.onSampleVolumeChange).toHaveBeenCalledWith(0)
    expect(controlProps.onBeatVolumeChange).toHaveBeenCalledWith(100)
    expect(controlProps.onBeatSelectionChange).toHaveBeenCalledWith('0')
    expect(controlProps.onReset).toHaveBeenCalledOnce()
  })

  it('disables reset when gated and keeps an explicit no-beat choice when no preset beat is loaded', () => {
    const reset = vi.fn()
    const { rerender } = render(<SessionControls {...props({ disabled: true, onReset: reset })} />)
    expect(screen.getByRole('button', { name: 'Reset controls' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Beat bed' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))
    expect(reset).not.toHaveBeenCalled()

    rerender(<SessionControls {...props({ beatFiles: [], beatResolutions: undefined, selectedBeatIndex: 'none' })} />)
    expect(screen.getByRole('combobox', { name: 'Beat bed' })).toHaveValue('none')
    expect(screen.getByRole('option', { name: 'No beat bed' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Beat level' })).toBeDisabled()
  })

  it('shows estimate review and applies a custom beat only after explicit confirmation', () => {
    const controlProps = props({
      customBeatSelected: true,
      customBeatAnalysisStatus: 'detected',
      customBeatCandidateFileName: 'practice-loop.mp3',
      customBeatCandidateBpm: '120',
      customBeatCandidateMessage: 'Estimated 120 BPM. Check the beat before applying.',
      customBeatCandidateReady: true,
      onUseCustomBeat: vi.fn(),
      onCustomBeatCandidateBpmChange: vi.fn(),
    })
    render(<SessionControls {...controlProps} />)

    expect(screen.getByText('Estimated 120 BPM. Check the beat before applying.')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('spinbutton', { name: 'Custom beat BPM' })).toHaveValue(120)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Custom beat BPM' }), { target: { value: '122' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use custom beat' }))

    expect(controlProps.onCustomBeatCandidateBpmChange).toHaveBeenCalledWith('122')
    expect(controlProps.onUseCustomBeat).toHaveBeenCalledOnce()
  })

  it('keeps the preset choice cached but disabled while the custom source is active', () => {
    const controlProps = props({
      bpm: '110',
      customBeatFileName: 'practice-loop.mp3',
      customBeatSelected: true,
      customBeatReferenceBpm: 120,
      customBeatReferenceBpmInput: '120',
      onCustomBeatReferenceBpmChange: vi.fn(),
    })
    render(<SessionControls {...controlProps} />)

    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Preset' })).toBeEnabled()
    expect(screen.getByLabelText('Beat bed')).toHaveValue('0')
    expect(screen.getByLabelText('Beat bed')).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Beat 01 · Practice beat.wav' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(120)
    expect(screen.getByText(/scratch source 85 · beat source 120/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Preset' }))
    expect(controlProps.onBeatSelectionChange).toHaveBeenCalledWith('0')
  })

  it('lets the user choose Custom before upload and visibly mutes Custom controls in Preset mode', () => {
    const controlProps = props({ selectedBeatIndex: '0' })
    const { rerender } = render(<SessionControls {...controlProps} />)

    expect(screen.getByRole('radio', { name: 'Preset' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeEnabled()
    expect(screen.getByLabelText('Upload custom beat')).toBeDisabled()
    expect(document.querySelector('.session-controls__custom-beat-upload--inactive')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(controlProps.onBeatSelectionChange).toHaveBeenCalledWith('custom')

    rerender(<SessionControls {...props({ customBeatSelected: true, selectedBeatIndex: '0' })} />)
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked()
    expect(screen.getByLabelText('Beat bed')).toBeDisabled()
    expect(screen.getByLabelText('Upload custom beat')).toBeEnabled()
    expect(screen.getByText(/No custom beat is applied/)).toBeInTheDocument()
    expect(screen.getByText(/Sample playback remains available without a beat bed/i)).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Beat level' })).toBeDisabled()
  })

  it('locks tempo when scratch and beat references have no shared playback range', () => {
    render(<SessionControls {...props({ customBeatFileName: 'fast.mp3', customBeatSelected: true, customBeatReferenceBpm: 400, customBeatReferenceBpmInput: '400' })} />)

    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toBeDisabled()
    expect(screen.getByText(/no shared playback range/)).toHaveAttribute('role', 'status')
  })

  it('keeps manual trim collapsed, validates decoded bounds, and applies or resets explicitly', async () => {
    vi.mocked(loadWaveform).mockResolvedValue({
      durationSeconds: 4,
      peaks: new Float32Array([0.2, 0.8, 0.3, 1]),
      path: 'M0 10 L1 4 L2 9 L3 1 Z',
    })
    const onApplyBeatTrim = vi.fn()
    const onResetBeatTrim = vi.fn()
    const selectedFile = new File(['beat'], 'practice-loop.wav', { type: 'audio/wav' })
    const controlProps = props({
      beatTrimSourceKey: 'preset:abc:0',
      beatTrimSourceName: 'Practice loop.wav',
      beatTrimSourceReferenceBpm: 92,
      beatTrimSourceFile: selectedFile,
      onApplyBeatTrim,
      onResetBeatTrim,
    })
    const { rerender } = render(<SessionControls {...controlProps} />)

    const details = screen.getByText('Manual beat trim').closest('details')
    expect(details).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('Manual beat trim'))
    await waitFor(() => expect(loadWaveform).toHaveBeenCalledWith(selectedFile))
    expect(screen.getByRole('img', { name: /Waveform of Practice loop\.wav/ })).toBeInTheDocument()
    expect(screen.getByLabelText('First downbeat / loop start (seconds)')).toHaveValue(0)
    expect(screen.getByLabelText('Loop end (seconds)')).toHaveValue(null)
    expect(screen.getByText(/source BPM 92/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('First downbeat / loop start (seconds)'), { target: { value: '1.25' } })
    fireEvent.change(screen.getByLabelText('Loop end (seconds)'), { target: { value: '1' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/Loop end must be after the first downbeat/)
    expect(screen.getByRole('button', { name: 'Apply beat trim' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Loop end (seconds)'), { target: { value: '3.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply beat trim' }))
    expect(onApplyBeatTrim).toHaveBeenCalledWith({ startOffsetSeconds: 1.25, loopEndSeconds: 3.5 }, 4)

    rerender(<SessionControls {...props({ ...controlProps, beatTrim: { startOffsetSeconds: 1.25, loopEndSeconds: 3.5 } })} />)
    expect(screen.getByText(/Applied: cue 1\.250s · loop end 3\.500s/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset beat trim' }))
    expect(onResetBeatTrim).toHaveBeenCalledOnce()
  })
})
