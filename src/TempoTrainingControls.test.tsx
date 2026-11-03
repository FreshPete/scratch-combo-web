import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TEMPO_TRAINING_SETTINGS, type TempoTrainingSettings } from './tempo-training'
import { TempoTrainingControls, type TempoTrainingControlsProps } from './TempoTrainingControls'

function props(overrides: Partial<TempoTrainingControlsProps> = {}): TempoTrainingControlsProps {
  return {
    settings: { ...DEFAULT_TEMPO_TRAINING_SETTINGS },
    currentBpm: 85,
    tempoRange: { min: 42.5, max: 170 },
    repeatingPracticeAvailable: true,
    disabled: false,
    onEnabledChange: vi.fn(),
    onTargetBpmChange: vi.fn(),
    onStepBpmChange: vi.fn(),
    onRoundsPerStepChange: vi.fn(),
    ...overrides,
  }
}

describe('TempoTrainingControls', () => {
  afterEach(cleanup)

  it('keeps configuration in a collapsed Session disclosure and exposes the stored fields', () => {
    render(<TempoTrainingControls {...props()} />)

    const details = document.getElementById('tempo-training')
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText('Off')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Tempo trainer'))
    expect(screen.getByRole('checkbox', { name: 'Enable tempo training' })).not.toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Target BPM' })).toHaveValue(100)
    expect(screen.getByRole('spinbutton', { name: 'Increase by (BPM)' })).toHaveValue(1)
    expect(screen.getByRole('spinbutton', { name: 'Every full practice rounds' })).toHaveValue(2)
  })

  it('routes enabled settings and whole-number round increments to the App', () => {
    const controlProps = props({
      onEnabledChange: vi.fn(),
      onTargetBpmChange: vi.fn(),
      onStepBpmChange: vi.fn(),
      onRoundsPerStepChange: vi.fn(),
    })
    render(<TempoTrainingControls {...controlProps} />)

    fireEvent.click(screen.getByText('Tempo trainer'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable tempo training' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target BPM' }), { target: { value: '100.5' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Increase by (BPM)' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every full practice rounds' }), { target: { value: '4' } })

    expect(controlProps.onEnabledChange).toHaveBeenCalledWith(true)
    expect(controlProps.onTargetBpmChange).toHaveBeenCalledWith(100.5)
    expect(controlProps.onStepBpmChange).toHaveBeenCalledWith(3)
    expect(controlProps.onRoundsPerStepChange).toHaveBeenCalledWith(4)
  })

  it('shows a source-change warning when the saved target leaves the active shared range', () => {
    const settings: TempoTrainingSettings = { enabled: true, targetBpm: 100, stepBpm: 2, roundsPerStep: 2 }
    render(<TempoTrainingControls {...props({ settings, tempoRange: { min: 60, max: 90 } })} />)

    fireEvent.click(screen.getByText('Tempo trainer'))
    expect(screen.getByRole('status')).toHaveTextContent(/selected sources’ shared 60–90 BPM range/i)
    expect(screen.getByRole('spinbutton', { name: 'Target BPM' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('spinbutton', { name: 'Target BPM' })).toHaveAttribute('max', '90')
  })

  it('locks structural trainer fields during playback while leaving the summary readable', () => {
    render(<TempoTrainingControls {...props({
      settings: { enabled: true, targetBpm: 100, stepBpm: 2, roundsPerStep: 2 },
      disabled: true,
    })} />)

    fireEvent.click(screen.getByText('Tempo trainer'))
    expect(screen.getByRole('checkbox', { name: 'Enable tempo training' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Target BPM' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Increase by (BPM)' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Every full practice rounds' })).toBeDisabled()
    expect(screen.getByText('On')).toBeInTheDocument()
  })
})
