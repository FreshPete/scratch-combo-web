import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControls, type SessionControlsProps } from './SessionControls'

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
    selectedBeatIndex: 'none',
    customBeatFileName: null,
    customBeatSelected: false,
    customBeatReferenceBpm: null,
    customBeatReferenceBpmInput: '',
    customBeatAnalysisStatus: 'idle',
    customBeatCandidateFileName: null,
    customBeatCandidateBpm: '',
    customBeatCandidateMessage: '',
    customBeatCandidateReady: false,
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
    onReset: vi.fn(),
    ...overrides,
  }
}

describe('SessionControls', () => {
  afterEach(cleanup)

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

  it('disables reset and hides the beat selector when the parent gates controls or no beat is loaded', () => {
    const reset = vi.fn()
    const { rerender } = render(<SessionControls {...props({ disabled: true, onReset: reset })} />)
    expect(screen.getByRole('button', { name: 'Reset controls' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Beat bed' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reset controls' }))
    expect(reset).not.toHaveBeenCalled()

    rerender(<SessionControls {...props({ beatFiles: [], beatResolutions: undefined })} />)
    expect(screen.queryByRole('combobox', { name: 'Beat bed' })).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Beat level' })).toBeDisabled()
  })

  it('shows estimate review and applies a custom beat only after explicit confirmation', () => {
    const controlProps = props({
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

  it('keeps built-in beats available while the custom beat is selected and shows both BPM references', () => {
    const controlProps = props({
      bpm: '110',
      customBeatFileName: 'practice-loop.mp3',
      customBeatSelected: true,
      customBeatReferenceBpm: 120,
      customBeatReferenceBpmInput: '120',
      onCustomBeatReferenceBpmChange: vi.fn(),
    })
    render(<SessionControls {...controlProps} />)

    expect(screen.getByLabelText('Beat bed')).toHaveValue('custom')
    expect(screen.getByRole('option', { name: 'Beat 01 · Practice beat.wav' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Recorded BPM for custom beat' })).toHaveValue(120)
    expect(screen.getByText(/scratch source 85 · beat source 120/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Beat bed'), { target: { value: '0' } })
    expect(controlProps.onBeatSelectionChange).toHaveBeenCalledWith('0')
  })

  it('locks tempo when scratch and beat references have no shared playback range', () => {
    render(<SessionControls {...props({ customBeatFileName: 'fast.mp3', customBeatSelected: true, customBeatReferenceBpm: 400, customBeatReferenceBpmInput: '400' })} />)

    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toBeDisabled()
    expect(screen.getByText(/no shared playback range/)).toHaveAttribute('role', 'status')
  })
})
