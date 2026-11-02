import type { ChangeEvent } from 'react'
import type { AssetResolution } from './domain'
import './SessionControls.css'

export type CustomBeatAnalysisStatus = 'idle' | 'analyzing' | 'detected' | 'ambiguous' | 'insufficient' | 'error'

export type TempoRange = { min: number; max: number }

export function getTempoRange(referenceBpm: number, beatReferenceBpm?: number | null): TempoRange | null {
  const min = Math.max(1, referenceBpm * 0.5, beatReferenceBpm ? beatReferenceBpm * 0.5 : 1)
  const max = Math.min(referenceBpm * 2, beatReferenceBpm ? beatReferenceBpm * 2 : referenceBpm * 2)
  return max >= min ? { min, max } : null
}

export type SessionControlsProps = {
  bpm: string
  referenceBpm: number
  pitchSemitones: number
  sampleVolume: number
  beatVolume: number
  beatFiles: string[]
  beatResolutions: AssetResolution[] | undefined
  selectedBeatIndex: string
  customBeatFileName: string | null
  customBeatSelected: boolean
  customBeatReferenceBpm: number | null
  customBeatReferenceBpmInput: string
  customBeatAnalysisStatus: CustomBeatAnalysisStatus
  customBeatCandidateFileName: string | null
  customBeatCandidateBpm: string
  customBeatCandidateMessage: string
  customBeatCandidateReady: boolean
  disabled: boolean
  beatSelectionDisabled?: boolean
  onBpmChange: (value: string) => void
  onPitchChange: (value: number) => void
  onSampleVolumeChange: (value: number) => void
  onBeatVolumeChange: (value: number) => void
  onBeatSelectionChange: (value: string) => void
  onCustomBeatFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onCustomBeatCandidateBpmChange: (value: string) => void
  onUseCustomBeat: () => void
  onCustomBeatReferenceBpmChange: (value: string) => void
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
  customBeatFileName,
  customBeatSelected,
  customBeatReferenceBpm,
  customBeatReferenceBpmInput,
  customBeatAnalysisStatus,
  customBeatCandidateFileName,
  customBeatCandidateBpm,
  customBeatCandidateMessage,
  customBeatCandidateReady,
  disabled,
  beatSelectionDisabled = false,
  onBpmChange,
  onPitchChange,
  onSampleVolumeChange,
  onBeatVolumeChange,
  onBeatSelectionChange,
  onCustomBeatFileChange,
  onCustomBeatCandidateBpmChange,
  onUseCustomBeat,
  onCustomBeatReferenceBpmChange,
  onReset,
}: SessionControlsProps) {
  const beatReferenceBpm = customBeatSelected ? customBeatReferenceBpm : null
  const tempoRange = getTempoRange(referenceBpm, beatReferenceBpm)
  const minBpm = tempoRange?.min ?? Math.max(1, referenceBpm * 0.5, (beatReferenceBpm ?? 1) * 0.5)
  const maxBpm = tempoRange?.max ?? minBpm
  const hasTempoRange = tempoRange !== null
  const numericBpm = Number(bpm)
  const sliderBpm = Number.isFinite(numericBpm)
    ? Math.min(Math.max(maxBpm, minBpm), Math.max(minBpm, numericBpm))
    : Math.min(Math.max(maxBpm, minBpm), Math.max(minBpm, referenceBpm))
  const selectedPresetBeat = selectedBeatIndex === 'none'
    ? undefined
    : beatResolutions?.[Number(selectedBeatIndex)]
  const selectedPresetBeatReady = selectedPresetBeat?.status === 'resolved' && Boolean(selectedPresetBeat.file)
  const activeBeatReady = customBeatSelected
    ? Boolean(customBeatFileName && customBeatReferenceBpm !== null)
    : selectedPresetBeatReady
  const customSourceControlsDisabled = disabled || beatSelectionDisabled || !customBeatSelected || customBeatAnalysisStatus === 'analyzing'
  const uploadDisabled = customSourceControlsDisabled
  const sourceSelectionDisabled = disabled || beatSelectionDisabled
  const candidateBpmValue = Number(customBeatCandidateBpm)
  const hasCandidateBpm = Number.isFinite(candidateBpmValue) && candidateBpmValue >= 1
  const candidateRange = hasCandidateBpm ? getTempoRange(referenceBpm, candidateBpmValue) : null
  const candidateMinBpm = candidateRange?.min ?? 0
  const candidateMaxBpm = candidateRange?.max ?? 0
  const candidateHasTempoRange = candidateRange !== null
  const activeReferenceInput = Number(customBeatReferenceBpmInput)
  const activeReferenceInputValid = Number.isFinite(activeReferenceInput) && activeReferenceInput >= 1

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
              disabled={disabled || !hasTempoRange}
              onChange={(event) => onBpmChange(event.currentTarget.value)}
            />
            <span aria-hidden="true">BPM</span>
          </label>
          <label className="session-controls__range session-controls__range--tempo" htmlFor="bpm-range">
            <input
              id="bpm-range"
              aria-label="BPM range"
              type="range"
              min={minBpm}
              max={maxBpm}
              step="0.5"
              value={sliderBpm}
              disabled={disabled || !hasTempoRange}
              onChange={(event) => onBpmChange(event.currentTarget.value)}
            />
          </label>
          <small className="session-controls__hint">
            {hasTempoRange
              ? minBpm + '–' + maxBpm + ' BPM · scratch source ' + referenceBpm + (beatReferenceBpm ? ' · beat source ' + beatReferenceBpm : '')
              : 'No shared tempo range · scratch source ' + referenceBpm + ' · beat source ' + beatReferenceBpm}
          </small>
        </div>

        <div className="session-controls__field">
          <label className="session-controls__label" htmlFor="pitch-shift">Pitch shift</label>
          <output className="session-controls__readout">
            {pitchSemitones > 0 ? '+' : ''}{pitchSemitones} st
          </output>
          <input
            className="session-controls__slider session-controls__slider--pitch"
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
            className="session-controls__slider session-controls__slider--sample"
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

        <div className={activeBeatReady ? 'session-controls__field' : 'session-controls__field session-controls__field--inactive'}>
          <label className="session-controls__label" htmlFor="beat-volume">Beat level</label>
          <output className="session-controls__readout">{beatVolume}%</output>
          <input
            className="session-controls__slider session-controls__slider--beat"
            id="beat-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={beatVolume}
            disabled={disabled || !activeBeatReady}
            onChange={(event) => onBeatVolumeChange(Number(event.currentTarget.value))}
          />
          {!activeBeatReady && <small className="session-controls__hint">Select an applied beat to adjust its level.</small>}
        </div>
      </div>

      <fieldset className="session-controls__beat-source" aria-describedby="beat-source-help">
        <legend>Beat source</legend>
        <div className="session-controls__source-options">
          <label className={!customBeatSelected ? 'session-controls__source-option session-controls__source-option--selected' : 'session-controls__source-option'}>
            <input
              type="radio"
              name="beat-source"
              value="preset"
              checked={!customBeatSelected}
              disabled={sourceSelectionDisabled}
              onChange={() => onBeatSelectionChange(selectedBeatIndex)}
            />
            <span>Preset</span>
          </label>
          <label className={customBeatSelected ? 'session-controls__source-option session-controls__source-option--selected' : 'session-controls__source-option'}>
            <input
              type="radio"
              name="beat-source"
              value="custom"
              checked={customBeatSelected}
              disabled={sourceSelectionDisabled}
              onChange={() => onBeatSelectionChange('custom')}
            />
            <span>Custom</span>
          </label>
        </div>
        <small id="beat-source-help" className="session-controls__hint">Choose one source. The other source stays loaded for this session and does not play.</small>

        <div className={'session-controls__source-panel' + (customBeatSelected ? ' session-controls__source-panel--inactive' : '')}>
          <label className="session-controls__label" htmlFor="beat-selection">Preset beat</label>
          <select
            id="beat-selection"
            aria-label="Beat bed"
            value={selectedBeatIndex}
            disabled={disabled || beatSelectionDisabled || customBeatSelected}
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

        <div className={'session-controls__source-panel session-controls__custom-source-panel' + (!customBeatSelected ? ' session-controls__source-panel--inactive' : '')}>
          {customBeatFileName && customBeatReferenceBpm !== null ? (
            <>
              <label className="session-controls__label" htmlFor="custom-beat-reference-bpm">Recorded BPM for {customBeatFileName}</label>
              <input
                className="session-controls__bpm-correction"
                id="custom-beat-reference-bpm"
                aria-label="Recorded BPM for custom beat"
                aria-describedby="custom-beat-sync"
                type="number"
                inputMode="decimal"
                min="1"
                step="0.1"
                value={customBeatReferenceBpmInput}
                disabled={uploadDisabled || !customBeatSelected}
                onChange={(event) => onCustomBeatReferenceBpmChange(event.currentTarget.value)}
              />
              <p id="custom-beat-sync" className="session-controls__beat-sync" role="status">
                {customBeatSelected
                  ? 'This applied beat is active. Recorded BPM is its source reference; Tempo sets the shared practice target for the beat and scratch samples.'
                  : 'Applied for this session. Choose Custom to play it.'}
                {customBeatSelected && !activeReferenceInputValid && ' Enter a recorded BPM of at least 1 before playback.'}
                {customBeatSelected && !hasTempoRange && ' These source BPM values have no shared playback range yet; correct the beat BPM to continue.'}
              </p>
            </>
          ) : (
            <p className="session-controls__beat-sync">No custom beat is applied. Upload a WAV or MP3 below, review its BPM, then choose Use custom beat. Sample playback remains available without a beat bed.</p>
          )}
        </div>
      </fieldset>

      <div className={'session-controls__custom-beat-upload' + (!customBeatSelected ? ' session-controls__custom-beat-upload--inactive' : '')}>
        <div>
          <label className="session-controls__label" htmlFor="custom-beat-file">Upload custom beat</label>
          <small id="custom-beat-file-help" className="session-controls__hint">WAV or MP3 · analyzed in this browser and held for this session</small>
        </div>
        <input
          id="custom-beat-file"
          aria-label="Upload custom beat"
          aria-describedby="custom-beat-file-help"
          type="file"
          accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg"
          disabled={customSourceControlsDisabled}
          onChange={onCustomBeatFileChange}
        />
        {customBeatCandidateFileName && (
          <div className="session-controls__candidate">
            <p id="custom-beat-analysis" className={'session-controls__analysis session-controls__analysis--' + customBeatAnalysisStatus} role="status" aria-live="polite" aria-atomic="true">
              {customBeatCandidateMessage}
            </p>
            {customBeatCandidateReady && (
              <>
                <label className="session-controls__label" htmlFor="custom-beat-candidate-bpm">Recorded BPM for {customBeatCandidateFileName}</label>
                <input
                  className="session-controls__bpm-correction"
                  id="custom-beat-candidate-bpm"
                  aria-label="Custom beat BPM"
                  aria-describedby="custom-beat-analysis custom-beat-candidate-help"
                  type="number"
                  inputMode="decimal"
                  min="1"
                  step="0.1"
                  value={customBeatCandidateBpm}
                  disabled={customSourceControlsDisabled}
                  onChange={(event) => onCustomBeatCandidateBpmChange(event.currentTarget.value)}
                />
                <p id="custom-beat-candidate-help" className="session-controls__hint">
                  {candidateHasTempoRange
                    ? 'Review the estimate before applying. Practice tempo will start at the nearest supported value (' + candidateMinBpm + '–' + candidateMaxBpm + ' BPM).'
                    : 'This BPM and the scratch preset have no shared playback range. Enter a corrected BPM before applying.'}
                </p>
                <button
                  className="button button--small"
                  type="button"
                  disabled={customSourceControlsDisabled || !hasCandidateBpm || !candidateHasTempoRange}
                  onClick={onUseCustomBeat}
                >
                  Use custom beat
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
