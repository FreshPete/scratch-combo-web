import type { AssetResolution } from './domain'
import './SessionControls.css'

export type SessionControlsProps = {
  bpm: string
  referenceBpm: number
  pitchSemitones: number
  sampleVolume: number
  beatVolume: number
  beatFiles: string[]
  beatResolutions: AssetResolution[] | undefined
  selectedBeatIndex: string
  disabled: boolean
  onBpmChange: (value: string) => void
  onPitchChange: (value: number) => void
  onSampleVolumeChange: (value: number) => void
  onBeatVolumeChange: (value: number) => void
  onBeatSelectionChange: (value: string) => void
  onReset: () => void
}

export function SessionControls({
  bpm,
  referenceBpm,
  pitchSemitones,
  sampleVolume,
  beatVolume,
  beatFiles,
  beatResolutions,
  selectedBeatIndex,
  disabled,
  onBpmChange,
  onPitchChange,
  onSampleVolumeChange,
  onBeatVolumeChange,
  onBeatSelectionChange,
  onReset,
}: SessionControlsProps) {
  const minBpm = Math.max(1, referenceBpm * 0.5)
  const maxBpm = Math.max(minBpm, referenceBpm * 2)
  const numericBpm = Number(bpm)
  const sliderBpm = Number.isFinite(numericBpm)
    ? Math.min(maxBpm, Math.max(minBpm, numericBpm))
    : referenceBpm

  return (
    <section id="session-section" className="workspace-section session-controls" aria-labelledby="settings-heading">
      <div className="session-controls__heading">
        <div>
          <h2 id="settings-heading">Session controls</h2>
          <p>Adjustments apply to this preview only.</p>
        </div>
        <button className="button session-controls__reset" type="button" disabled={disabled} onClick={onReset}>
          Reset controls
        </button>
      </div>

      <div className="session-controls__grid">
        <div className="session-controls__field">
          <label className="session-controls__label" htmlFor="bpm-field">Tempo</label>
          <label className="session-controls__number-field" htmlFor="bpm-field">
            <input
              id="bpm-field"
              aria-label="BPM"
              type="number"
              inputMode="decimal"
              min={minBpm}
              max={maxBpm}
              step="0.5"
              value={bpm}
              disabled={disabled}
              onChange={(event) => onBpmChange(event.currentTarget.value)}
            />
            <span aria-hidden="true">BPM</span>
          </label>
          <label className="session-controls__range" htmlFor="bpm-range">
            <input
              id="bpm-range"
              aria-label="BPM range"
              type="range"
              min={minBpm}
              max={maxBpm}
              step="0.5"
              value={sliderBpm}
              disabled={disabled}
              onChange={(event) => onBpmChange(event.currentTarget.value)}
            />
          </label>
          <small className="session-controls__hint">{minBpm}–{maxBpm} BPM · source {referenceBpm}</small>
        </div>

        <div className="session-controls__field">
          <label className="session-controls__label" htmlFor="pitch-shift">Pitch shift</label>
          <output className="session-controls__readout">
            {pitchSemitones > 0 ? '+' : ''}{pitchSemitones} st
          </output>
          <input
            className="session-controls__slider"
            id="pitch-shift"
            aria-label="Pitch shift in semitones"
            type="range"
            min="-12"
            max="12"
            step="1"
            value={pitchSemitones}
            disabled={disabled}
            onChange={(event) => onPitchChange(Number(event.currentTarget.value))}
          />
        </div>

        <div className="session-controls__field">
          <label className="session-controls__label" htmlFor="sample-volume">Sample level</label>
          <output className="session-controls__readout">{sampleVolume}%</output>
          <input
            className="session-controls__slider"
            id="sample-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={sampleVolume}
            disabled={disabled}
            onChange={(event) => onSampleVolumeChange(Number(event.currentTarget.value))}
          />
        </div>

        <div className="session-controls__field">
          <label className="session-controls__label" htmlFor="beat-volume">Beat level</label>
          <output className="session-controls__readout">{beatVolume}%</output>
          <input
            className="session-controls__slider"
            id="beat-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={beatVolume}
            disabled={disabled || beatFiles.length === 0}
            onChange={(event) => onBeatVolumeChange(Number(event.currentTarget.value))}
          />
        </div>
      </div>

      {beatFiles.length > 0 && (
        <div className="session-controls__beat-bed">
          <label className="session-controls__label" htmlFor="beat-selection">Beat bed</label>
          <select
            id="beat-selection"
            value={selectedBeatIndex}
            disabled={disabled}
            onChange={(event) => onBeatSelectionChange(event.currentTarget.value)}
          >
            <option value="none">No beat bed</option>
            {beatFiles.map((fileName, index) => {
              const resolution = beatResolutions?.[index]
              const ready = resolution?.status === 'resolved' && Boolean(resolution.file)
              const label = 'Beat ' + String(index + 1).padStart(2, '0') + ' · ' + fileName
              return <option key={index} value={String(index)} disabled={!ready}>{ready ? label : label + ' (WAV needed)'}</option>
            })}
          </select>
        </div>
      )}
    </section>
  )
}
