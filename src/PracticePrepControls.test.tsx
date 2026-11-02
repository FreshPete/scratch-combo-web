import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PracticePrepControls } from './PracticePrepControls'

afterEach(cleanup)

describe('playback preparation controls', () => {
  it('offers an optional four-beat-bar count-in and ongoing metronome with one click level', () => {
    const onCountInBarsChange = vi.fn()
    const onMetronomeEnabledChange = vi.fn()
    const onMetronomeVolumeChange = vi.fn()

    const { rerender } = render(
      <PracticePrepControls
        countInBars={0}
        metronomeEnabled={false}
        metronomeVolume={60}
        settingsDisabled={false}
        onCountInBarsChange={onCountInBarsChange}
        onMetronomeEnabledChange={onMetronomeEnabledChange}
        onMetronomeVolumeChange={onMetronomeVolumeChange}
      />,
    )

    const countIn = screen.getByRole('combobox', { name: 'Count-in' })
    const metronome = screen.getByRole('checkbox', { name: 'Metronome' })
    const level = screen.getByRole('slider', { name: 'Click level' })
    expect(countIn).toHaveValue('0')
    expect(countIn).toHaveDisplayValue('Off')
    expect(metronome).not.toBeChecked()
    expect(level).toHaveValue('60')
    expect(level).toBeDisabled()

    fireEvent.change(countIn, { target: { value: '2' } })
    fireEvent.click(metronome)
    expect(onCountInBarsChange).toHaveBeenCalledWith(2)
    expect(onMetronomeEnabledChange).toHaveBeenCalledWith(true)
    rerender(
      <PracticePrepControls
        countInBars={2}
        metronomeEnabled
        metronomeVolume={60}
        settingsDisabled={false}
        onCountInBarsChange={onCountInBarsChange}
        onMetronomeEnabledChange={onMetronomeEnabledChange}
        onMetronomeVolumeChange={onMetronomeVolumeChange}
      />,
    )
    const activeLevel = screen.getByRole('slider', { name: 'Click level' })
    fireEvent.change(activeLevel, { target: { value: '73' } })

    expect(onMetronomeVolumeChange).toHaveBeenCalledWith(73)
    expect(activeLevel).toBeEnabled()
    expect(screen.getByText('Count-in clicks use 4 beats per bar. Metronome clicks continue through the sequence.')).toBeInTheDocument()
  })

  it('locks structural settings during playback while keeping an active click level live', () => {
    render(
      <PracticePrepControls
        countInBars={1}
        metronomeEnabled
        metronomeVolume={60}
        settingsDisabled
        onCountInBarsChange={vi.fn()}
        onMetronomeEnabledChange={vi.fn()}
        onMetronomeVolumeChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Count-in' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Metronome' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Click level' })).toBeEnabled()
  })
})
