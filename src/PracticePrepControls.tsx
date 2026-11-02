export type CountInBars = 0 | 1 | 2

export interface PracticePrepControlsProps {
  countInBars: CountInBars
  metronomeEnabled: boolean
  metronomeVolume: number
  settingsDisabled: boolean
  onCountInBarsChange: (value: CountInBars) => void
  onMetronomeEnabledChange: (enabled: boolean) => void
  onMetronomeVolumeChange: (value: number) => void
}

export function PracticePrepControls({
  countInBars,
  metronomeEnabled,
  metronomeVolume,
  settingsDisabled,
  onCountInBarsChange,
  onMetronomeEnabledChange,
  onMetronomeVolumeChange,
}: PracticePrepControlsProps) {
  const clickEnabled = countInBars > 0 || metronomeEnabled

  return (
    <fieldset className="playback-prep" aria-describedby="playback-prep-help">
      <legend>Playback prep</legend>
      <div className="playback-prep__controls">
        <label className="playback-prep__field" htmlFor="count-in-bars">
          <span>Count-in</span>
          <select
            id="count-in-bars"
            aria-label="Count-in"
            value={countInBars}
            disabled={settingsDisabled}
            onChange={(event) => onCountInBarsChange(Number(event.currentTarget.value) as CountInBars)}
          >
            <option value={0}>Off</option>
            <option value={1}>1 bar · 4 beats</option>
            <option value={2}>2 bars · 8 beats</option>
          </select>
        </label>
        <label className="playback-prep__toggle">
          <input
            id="metronome-enabled"
            type="checkbox"
            checked={metronomeEnabled}
            disabled={settingsDisabled}
            onChange={(event) => onMetronomeEnabledChange(event.currentTarget.checked)}
          />
          <span>Metronome</span>
        </label>
        <label className="playback-prep__level" htmlFor="metronome-volume">
          <span>Click level</span>
          <input
            id="metronome-volume"
            type="range"
            min={0}
            max={100}
            step={1}
            value={metronomeVolume}
            disabled={!clickEnabled}
            aria-label="Click level"
            onChange={(event) => onMetronomeVolumeChange(Number(event.currentTarget.value))}
            aria-describedby="playback-prep-help"
          />
          <output id="metronome-volume-value" htmlFor="metronome-volume">{metronomeVolume}%</output>
        </label>
      </div>
      <p id="playback-prep-help">Count-in clicks use 4 beats per bar. Metronome clicks continue through the sequence.</p>
    </fieldset>
  )
}
