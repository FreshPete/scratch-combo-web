import { useEffect, useState, type ChangeEvent } from 'react'
import type { AssetResolution } from './domain'
import { loadWaveform, WAVEFORM_VIEWBOX_HEIGHT, type WaveformData } from './waveforms/waveform'
import type { SavedBeatTrimRegion } from './session-library/storage'
import { TempoTrainingControls } from './TempoTrainingControls'
import type { TempoTrainingSettings } from './tempo-training'
import './SessionControls.css'

export type CustomBeatAnalysisStatus = 'idle' | 'analyzing' | 'detected' | 'ambiguous' | 'insufficient' | 'error'

export type TempoRange = { min: number; max: number }

type BeatTrimControlsProps = {
  sourceKey: string | null
  sourceName: string | null
  sourceReferenceBpm: number | null
  sourceFile: File | null
  sourceBuffer: AudioBuffer | null
  appliedRegion: SavedBeatTrimRegion | null
  disabled: boolean
  onApply: (region: SavedBeatTrimRegion, decodedDurationSeconds: number) => void
  onReset: () => void
}

function BeatTrimControls({
  sourceKey,
  sourceName,
  sourceReferenceBpm,
  sourceFile,
  sourceBuffer,
  appliedRegion,
  disabled,
  onApply,
  onReset,
}: BeatTrimControlsProps) {
  const [expanded, setExpanded] = useState(false)
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [waveformStatus, setWaveformStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const [startInput, setStartInput] = useState('0')
  const [endInput, setEndInput] = useState('')

  useEffect(() => {
    setStartInput(appliedRegion ? String(appliedRegion.startOffsetSeconds) : '0')
    setEndInput(appliedRegion?.loopEndSeconds === null || !appliedRegion ? '' : String(appliedRegion.loopEndSeconds))
  }, [sourceKey, appliedRegion?.startOffsetSeconds, appliedRegion?.loopEndSeconds])

  useEffect(() => {
    if (!expanded || !sourceFile) {
      setWaveform(null)
      setWaveformStatus('idle')
      return
    }
    let cancelled = false
    setWaveform(null)
    setWaveformStatus('loading')
    void loadWaveform(sourceFile).then((result) => {
      if (cancelled) return
      setWaveform(result)
      setWaveformStatus(result ? 'ready' : 'unavailable')
    })
    return () => { cancelled = true }
  }, [expanded, sourceKey, sourceFile])

  const decodedDurationSeconds = sourceBuffer?.duration ?? waveform?.durationSeconds ?? null
  const numericStart = Number(startInput)
  const numericEnd = endInput.trim() === '' ? decodedDurationSeconds : Number(endInput)
  const sourceReady = Boolean(sourceKey && sourceFile && sourceName && sourceReferenceBpm !== null)
  const durationReady = decodedDurationSeconds !== null && Number.isFinite(decodedDurationSeconds) && decodedDurationSeconds > 0
  const startValid = Number.isFinite(numericStart) && numericStart >= 0 && durationReady && numericStart < decodedDurationSeconds
  const endValid = durationReady && numericEnd !== null && Number.isFinite(numericEnd)
    && numericEnd > numericStart && numericEnd <= decodedDurationSeconds
  const rangeValid = sourceReady && startValid && endValid
  const showRangeError = sourceReady && durationReady && (startInput !== '' || endInput !== '') && !rangeValid
  const rangeMessage = !startValid
    ? 'The first downbeat must be at or after 0 seconds and before the decoded clip end (' + (decodedDurationSeconds?.toFixed(3) ?? '—') + ' seconds).'
    : 'Loop end must be after the first downbeat and no later than the decoded clip end (' + (decodedDurationSeconds?.toFixed(3) ?? '—') + ' seconds).'
  const startFraction = durationReady && Number.isFinite(numericStart)
    ? Math.max(0, Math.min(1, numericStart / decodedDurationSeconds))
    : 0
  const endFraction = durationReady && numericEnd !== null && Number.isFinite(numericEnd)
    ? Math.max(0, Math.min(1, numericEnd / decodedDurationSeconds))
    : 1
  const markerWidth = waveform?.peaks.length ?? 192
  const startMarker = startFraction * markerWidth
  const endMarker = endFraction * markerWidth

  const apply = () => {
    if (!rangeValid || decodedDurationSeconds === null) return
    const fullEnd = numericEnd !== null && numericEnd >= decodedDurationSeconds - 0.000001
    onApply({
      startOffsetSeconds: numericStart,
      loopEndSeconds: fullEnd ? null : numericEnd,
    }, decodedDurationSeconds)
  }

  return (
    <details
      className="session-controls__beat-trim"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Manual beat trim</summary>
      <div className="session-controls__beat-trim-body">
        {sourceReady ? (
          <>
            <p className="session-controls__beat-trim-context">
              {sourceName} · source BPM {sourceReferenceBpm} · {durationReady ? decodedDurationSeconds.toFixed(3) + ' seconds decoded' : waveformStatus === 'loading' ? 'checking decoded length…' : 'decoded length unavailable'}
            </p>
            {waveform?.path && durationReady && (
              <svg
                className="session-controls__trim-waveform"
                viewBox={'0 0 ' + markerWidth + ' ' + WAVEFORM_VIEWBOX_HEIGHT}
                role="img"
                aria-label={'Waveform of ' + sourceName + ', with cue and loop-end markers'}
                preserveAspectRatio="none"
              >
                <rect x="0" y="0" width={markerWidth} height={WAVEFORM_VIEWBOX_HEIGHT} className="session-controls__trim-waveform-track" />
                <rect x={startMarker} y="0" width={Math.max(0, endMarker - startMarker)} height={WAVEFORM_VIEWBOX_HEIGHT} className="session-controls__trim-waveform-region" />
                <path d={waveform.path} className="session-controls__trim-waveform-path" />
                <line x1={startMarker} y1="0" x2={startMarker} y2={WAVEFORM_VIEWBOX_HEIGHT} className="session-controls__trim-waveform-cue" />
                <line x1={endMarker} y1="0" x2={endMarker} y2={WAVEFORM_VIEWBOX_HEIGHT} className="session-controls__trim-waveform-end" />
              </svg>
            )}
            {waveformStatus === 'unavailable' && (
              <p className="session-controls__hint">Waveform preview is unavailable in this browser. The numeric cue and loop controls use the decoded clip length.</p>
            )}
            {!durationReady && (
              <p className="session-controls__hint" role="status" aria-live="polite">
                {waveformStatus === 'loading' ? 'Decoding the selected beat to bound trim values…' : 'Could not read a decoded clip length for this beat. Choose another beat or reload the preset.'}
              </p>
            )}
            <div className="session-controls__trim-fields">
              <label className="session-controls__trim-field" htmlFor="beat-trim-start">
                <span>First downbeat / loop start (seconds)</span>
                <input
                  id="beat-trim-start"
                  aria-label="First downbeat / loop start (seconds)"
                  aria-describedby="beat-trim-help"
                  aria-invalid={durationReady && !startValid}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max={durationReady ? decodedDurationSeconds : undefined}
                  step="0.001"
                  value={startInput}
                  disabled={disabled || !durationReady}
                  onChange={(event) => setStartInput(event.currentTarget.value)}
                />
              </label>
              <label className="session-controls__trim-field" htmlFor="beat-trim-end">
                <span>Loop end (seconds)</span>
                <input
                  id="beat-trim-end"
                  aria-label="Loop end (seconds)"
                  aria-describedby="beat-trim-help"
                  aria-invalid={durationReady && endInput !== '' && !endValid}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max={durationReady ? decodedDurationSeconds : undefined}
                  step="0.001"
                  placeholder={durationReady ? decodedDurationSeconds.toFixed(3) + ' · full length' : 'Full length'}
                  value={endInput}
                  disabled={disabled || !durationReady}
                  onChange={(event) => setEndInput(event.currentTarget.value)}
                />
              </label>
            </div>
            <p id="beat-trim-help" className="session-controls__hint">
              The first downbeat is the playback cue and loop start. Leave loop end blank to use the decoded end; its boundary is exclusive.
            </p>
            {showRangeError && <p className="session-controls__trim-error" role="alert">{rangeMessage}</p>}
            <p className="session-controls__trim-status" role="status" aria-live="polite" aria-atomic="true">
              {appliedRegion
                ? 'Applied: cue ' + appliedRegion.startOffsetSeconds.toFixed(3) + 's · loop end ' + (appliedRegion.loopEndSeconds === null ? 'full length' : appliedRegion.loopEndSeconds.toFixed(3) + 's') + '. Changes take effect on the next Play.'
                : 'Full clip — no manual trim applied.'}
            </p>
            <div className="session-controls__trim-actions">
              <button className="button button--small" type="button" disabled={disabled || !rangeValid} onClick={apply}>Apply beat trim</button>
              <button className="button button--small" type="button" disabled={disabled || !appliedRegion} onClick={onReset}>Reset beat trim</button>
            </div>
          </>
        ) : (
          <p className="session-controls__hint">Choose an applied preset or custom beat to set its first downbeat and clean loop end.</p>
        )}
      </div>
    </details>
  )
}

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
  beatTrimSourceKey: string | null
  beatTrimSourceName: string | null
  beatTrimSourceReferenceBpm: number | null
  beatTrimSourceFile: File | null
  beatTrimSourceBuffer: AudioBuffer | null
  beatTrim: SavedBeatTrimRegion | null
  tempoTraining: TempoTrainingSettings
  tempoTrainingDisabled: boolean
  repeatingPracticeAvailable: boolean
  disabled: boolean
  tempoLocked?: boolean
  resetDisabled?: boolean
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
  onApplyBeatTrim: (region: SavedBeatTrimRegion, decodedDurationSeconds: number) => void
  onResetBeatTrim: () => void
  onTempoTrainingEnabledChange: (enabled: boolean) => void
  onTempoTrainingTargetChange: (targetBpm: number) => void
  onTempoTrainingStepChange: (stepBpm: number) => void
  onTempoTrainingRoundsChange: (roundsPerStep: number) => void
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
  beatTrimSourceKey,
  beatTrimSourceName,
  beatTrimSourceReferenceBpm,
  beatTrimSourceFile,
  beatTrimSourceBuffer,
  beatTrim,
  tempoTraining,
  tempoTrainingDisabled,
  repeatingPracticeAvailable,
  disabled,
  tempoLocked = false,
  resetDisabled = false,
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
  onApplyBeatTrim,
  onResetBeatTrim,
  onTempoTrainingEnabledChange,
  onTempoTrainingTargetChange,
  onTempoTrainingStepChange,
  onTempoTrainingRoundsChange,
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
  const tempoDisabled = disabled || tempoLocked || !hasTempoRange

  return (
    <section id="session-section" className="workspace-section session-controls" aria-labelledby="settings-heading">
      <div className="session-controls__heading">
        <div>
          <h2 id="settings-heading">Session controls</h2>
          <p>Adjustments apply to this preview only.</p>
        </div>
        <button className="button session-controls__reset" type="button" disabled={disabled || resetDisabled} onClick={onReset}>
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
              disabled={tempoDisabled}
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
              disabled={tempoDisabled}
              onChange={(event) => onBpmChange(event.currentTarget.value)}
            />
          </label>
          <small className="session-controls__hint">
            {tempoLocked
              ? 'Tempo stays fixed through the count-in and becomes live when the sequence starts.'
              : hasTempoRange
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

      <TempoTrainingControls
        settings={tempoTraining}
        currentBpm={numericBpm}
        tempoRange={tempoRange}
        repeatingPracticeAvailable={repeatingPracticeAvailable}
        disabled={tempoTrainingDisabled}
        onEnabledChange={onTempoTrainingEnabledChange}
        onTargetBpmChange={onTempoTrainingTargetChange}
        onStepBpmChange={onTempoTrainingStepChange}
        onRoundsPerStepChange={onTempoTrainingRoundsChange}
      />

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

      <BeatTrimControls
        sourceKey={beatTrimSourceKey}
        sourceName={beatTrimSourceName}
        sourceReferenceBpm={beatTrimSourceReferenceBpm}
        sourceFile={beatTrimSourceFile}
        sourceBuffer={beatTrimSourceBuffer}
        appliedRegion={beatTrim}
        disabled={disabled || beatSelectionDisabled}
        onApply={onApplyBeatTrim}
        onReset={onResetBeatTrim}
      />
    </section>
  )
}
