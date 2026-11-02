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
    disabled: false,
    onBpmChange: vi.fn(),
    onPitchChange: vi.fn(),
    onSampleVolumeChange: vi.fn(),
    onBeatVolumeChange: vi.fn(),
    onBeatSelectionChange: vi.fn(),
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
})
