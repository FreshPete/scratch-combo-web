import { useEffect, useRef, type ChangeEvent, type InputHTMLAttributes } from 'react'
import type { SnapshotFileValidation } from './audio'
import type { AssetDiagnostic, AssetResolution, Preset, PresetAssetResolution } from './domain'

const WAV_ACCEPT = '.wav,audio/wav,audio/x-wav'

export type ImportWizardStep = 1 | 2 | 3
export type ImportReferenceCheck = {
  subject: 'sample' | 'beat'
  id: string
  requested: string
  required: boolean
  resolution: AssetResolution
  validation: SnapshotFileValidation | null
}
export type PreparedLocalImport = {
  iniFileName: string
  iniText: string
  preset: Preset
  resolution: PresetAssetResolution
  snapshotResolution: PresetAssetResolution
  snapshotFiles: File[]
  selectedAudioFileCount: number
  checks: ImportReferenceCheck[]
  copiedFileCount: number
  copiedBytes: number
  decodedFileCount: number
  decodeAttemptCount: number
  canLoad: boolean
  applied: boolean
  blockedMessage: string | null
}

function LocalFilePicker({
  inputId, label, description, accept, multiple = false, directory = false, disabled = false, onChange,
}: {
  inputId: string
  label: string
  description: string
  accept: string
  multiple?: boolean
  directory?: boolean
  disabled?: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!directory) return
    inputRef.current?.setAttribute('webkitdirectory', '')
    inputRef.current?.setAttribute('directory', '')
  }, [directory])
  const extraAttributes = directory
    ? ({ webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>)
    : {}

  return (
    <label className={disabled ? 'file-picker file-picker--disabled' : 'file-picker'} htmlFor={inputId}>
      <span className="file-picker__copy">
        <span className="file-picker__label">{label}</span>
        <span className="file-picker__description">{description}</span>
      </span>
      <span className="file-picker__action" aria-hidden="true">Browse</span>
      <input
        ref={inputRef}
        className="file-picker__input"
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple || directory}
        aria-label={label}
        disabled={disabled}
        onChange={onChange}
        {...extraAttributes}
      />
    </label>
  )
}

export function ImportWizard({
  step, fileMode, stagedIniFileName, stagedPresetName, stagedAudioCount, currentPresetName,
  currentAudioCount, busy, wizardError, selectionNote, prepared, locked, isBootstrapLoading,
  bootstrapError, onRetryBuiltIn, onIniChange, onAudioChange, onFileModeChange, onBack,
  onCancel, onReviewEmptySelection, onLoad, onStartAnother,
}: {
  step: ImportWizardStep
  fileMode: 'folder' | 'files'
  stagedIniFileName: string | null
  stagedPresetName: string | null
  stagedAudioCount: number
  currentPresetName: string
  currentAudioCount: number
  busy: boolean
  wizardError: string | null
  selectionNote: string | null
  prepared: PreparedLocalImport | null
  locked: boolean
  isBootstrapLoading: boolean
  bootstrapError: string | null
  onRetryBuiltIn: () => void
  onIniChange: (event: ChangeEvent<HTMLInputElement>) => void
  onAudioChange: (event: ChangeEvent<HTMLInputElement>) => void
  onFileModeChange: (mode: 'folder' | 'files') => void
  onBack: () => void
  onCancel: () => void
  onReviewEmptySelection: () => void
  onLoad: () => void
  onStartAnother: () => void
}) {
  const stepTitle = step === 1
    ? 'Choose your INI preset'
    : step === 2
      ? 'Choose the audio files'
      : 'Review and load'
  const referenceRows = prepared?.checks ?? []
  const requiredMissing = referenceRows.filter((check) => check.required && check.resolution.status !== 'resolved')
  const requiredDecodeFailures = referenceRows.filter((check) => check.required && check.validation?.status === 'invalid')
  return (
    <section id="files-section" className="workspace-section import-section" aria-labelledby="import-heading">
      <div className="section-heading">
        <div>
          <h2 id="import-heading">Your files</h2>
          <p>Stage a preset and its referenced WAVs, review the matches, then load them into this session.</p>
        </div>
        <span className="section-index" aria-hidden="true">LOCAL</span>
      </div>

      <div className="import-current" aria-label="Current session files">
        <div>
          <span className="import-current__label">Current setup</span>
          <strong>{currentPresetName}</strong>
        </div>
        <span className="import-current__count">{currentAudioCount} WAV {currentAudioCount === 1 ? 'file' : 'files'} in session</span>
      </div>

      <ol className="import-steps" aria-label="Preset import steps">
        {(['INI', 'Audio', 'Review'] as const).map((label, index) => (
          <li key={label} className={step === index + 1 ? 'import-steps__item import-steps__item--current' : step > index + 1 ? 'import-steps__item import-steps__item--complete' : 'import-steps__item'} aria-current={step === index + 1 ? 'step' : undefined}>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <div className="import-wizard" aria-busy={busy}>
        <div className="import-wizard__heading">
          <h3 id={'import-step-' + step + '-heading'} tabIndex={-1}>{stepTitle}</h3>
          {stagedIniFileName && <span className="import-wizard__file-name">{stagedIniFileName}</span>}
        </div>

        {step === 1 && (
          <div className="import-wizard__step">
            <p>Choose one legacy INI file. It will be read in this browser and checked before your current setup changes.</p>
            {busy && <p className="inline-status" role="status">Reading {stagedIniFileName} locally. Your current setup stays active.</p>}
            <LocalFilePicker inputId="preset-file" label="Choose INI preset" description="One .ini file · up to 1 MiB" accept=".ini,text/plain" disabled={locked} onChange={onIniChange} />
          </div>
        )}

        {step === 2 && (
          <div className="import-wizard__step">
            <p>{stagedPresetName ? stagedPresetName + ' is staged. Choose the folder that contains its WAV files.' : 'Choose the folder that contains the WAV files referenced by this INI.'}</p>
            {fileMode === 'folder' ? (
              <>
                <LocalFilePicker inputId="audio-folder" label="Choose audio folder" description="One folder · WAV references are matched locally" accept={WAV_ACCEPT} directory disabled={locked || busy} onChange={onAudioChange} />
                <button className="button button--text import-wizard__alternate" type="button" disabled={locked || busy} onClick={() => onFileModeChange('files')}>Choose files instead</button>
              </>
            ) : (
              <>
                <LocalFilePicker inputId="audio-files" label="Choose WAV files" description="Select multiple files for this preset" accept={WAV_ACCEPT} multiple disabled={locked || busy} onChange={onAudioChange} />
                <button className="button button--text import-wizard__alternate" type="button" disabled={locked || busy} onClick={() => onFileModeChange('folder')}>Choose a folder instead</button>
              </>
            )}
            <p className="import-wizard__selection">{stagedAudioCount} WAV {stagedAudioCount === 1 ? 'file' : 'files'} selected for this draft.</p>
            <div className="import-wizard__actions">
              <button className="button button--secondary" type="button" disabled={busy} onClick={onBack}>Back</button>
              <button className="button button--primary" type="button" disabled={locked || busy} onClick={onReviewEmptySelection}>Review selection</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="import-wizard__step">
            {busy ? (
              <>
                <p className="inline-status" role="status">Copying referenced WAVs into session memory and checking eligible audio. Your current setup stays active.</p>
                <div className="import-wizard__actions">
                  <button className="button button--secondary" type="button" onClick={onBack}>Back</button>
                  <button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button>
                </div>
              </>
            ) : prepared ? (
              <>
                <p className="import-wizard__summary">{prepared.preset.name} · {prepared.selectedAudioFileCount} WAV {prepared.selectedAudioFileCount === 1 ? 'file' : 'files'} selected · {prepared.copiedFileCount} referenced WAV {prepared.copiedFileCount === 1 ? 'file' : 'files'} copied · {prepared.decodedFileCount} of {prepared.decodeAttemptCount} eligible WAVs decoded.</p>
                {prepared.applied
                  ? <p className="import-wizard__loaded" role="status">Preset loaded. Generate a combo when you are ready; playback has not started.</p>
                  : <p className="import-wizard__preserve">Your current setup stays active until you load this preset. Nothing is written back to the selected files.</p>}
                {(requiredMissing.length > 0 || requiredDecodeFailures.length > 0 || prepared.blockedMessage) && (
                  <p className="inline-error" role="alert">
                    {prepared.blockedMessage ?? 'Resolve the required sample WAVs below before loading this preset.'}
                  </p>
                )}
                {selectionNote && <p className="inline-status" role="status">{selectionNote}</p>}
                <div className="import-review-scroll">
                  <table className="import-review-table">
                    <thead><tr><th scope="col">Reference</th><th scope="col">Match</th><th scope="col">Check</th></tr></thead>
                    <tbody>
                      {referenceRows.map((check) => {
                        const resolution = check.resolution
                        const title = check.subject === 'sample'
                          ? prepared.preset.samples.find((sample) => sample.id === check.id)?.name ?? check.id
                          : 'Beat ' + check.id.replace(/^Beat/i, '')
                        const path = resolution.status === 'resolved'
                          ? resolution.selectedPath ?? check.requested
                          : resolution.candidates.join(', ')
                        const status = check.validation?.status === 'invalid'
                          ? 'WAV could not decode'
                          : resolution.status !== 'resolved'
                            ? resolution.status === 'ambiguous' ? 'Ambiguous' : check.required ? 'Required WAV missing' : 'Not selected'
                            : check.validation === null
                              ? 'Matched · not copied or validated'
                            : check.validation?.status === 'not-requested'
                              ? 'Copied · decode not needed now'
                              : 'Copied · audio decoded'
                        const detail = check.validation?.status === 'invalid'
                          ? check.validation.message
                          : resolution.status === 'ambiguous'
                            ? 'Matches ' + resolution.candidates.join(', ')
                            : resolution.status === 'missing'
                              ? 'INI references ' + JSON.stringify(check.requested)
                              : check.validation === null
                                ? 'Snapshot copy or validation did not complete for this matched WAV.'
                              : check.required
                                ? 'Required for an enabled, audible sample.'
                                : check.subject === 'beat'
                                  ? 'Optional beat bed; unavailable beats will stay unselected.'
                                  : 'Not required now because this sample is disabled, silent, weightless, or zero duration.'
                        return (
                          <tr key={check.subject + '-' + check.id} className={check.required && (resolution.status !== 'resolved' || check.validation?.status === 'invalid') ? 'import-review-table__row--error' : undefined}>
                            <th scope="row"><span>{title}</span><small>{check.subject === 'sample' ? 'Sample' : 'Preset beat'} · {check.id}</small></th>
                            <td><code>{path || check.requested}</code></td>
                            <td><strong>{status}</strong><small>{detail}</small></td>
                          </tr>
                        )
                      })}
                      {referenceRows.length === 0 && <tr><td colSpan={3}>This preset has no sample or beat file references.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="import-wizard__actions">
                  {!prepared.applied && <button className="button button--secondary" type="button" disabled={busy} onClick={onBack}>Back</button>}
                  {!prepared.applied && <button className="button button--secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
                  {prepared.applied
                    ? <button className="button button--primary" type="button" disabled>Preset loaded</button>
                    : prepared.canLoad
                      ? <button className="button button--primary" type="button" disabled={locked || busy} onClick={onLoad}>Load preset</button>
                      : <button className="button button--primary" type="button" disabled>Load preset</button>}
                  <button className="button button--text" type="button" disabled={locked || busy} onClick={onStartAnother}>Start another import</button>
                </div>
              </>
            ) : (
              <p className="inline-status" role="status">Select or review an audio folder to prepare this preset.</p>
            )}
          </div>
        )}

        {wizardError && <p className="inline-error" role="alert">{wizardError}</p>}
        {step === 1 && <div className="import-wizard__actions"><button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button></div>}
        {step === 2 && <div className="import-wizard__actions import-wizard__actions--cancel"><button className="button button--secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>}
      </div>

      {isBootstrapLoading && <p className="inline-status" role="status">Loading the built-in preset. Your current files panel will be ready when it finishes.</p>}
      {bootstrapError && <div className="inline-error" role="alert"><p>{bootstrapError}</p><button className="button button--small" type="button" disabled={locked} onClick={onRetryBuiltIn}>Retry built-in preset</button></div>}
    </section>
  )
}

export function DiagnosticList({ diagnostics }: { diagnostics: AssetDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return <div className="asset-check asset-check--ready" role="status"><span className="asset-check__mark" aria-hidden="true" /><p>Current setup: all referenced files are ready.</p></div>
  }
  return (
    <div className="diagnostics" role="status" aria-live="polite">
      <div className="diagnostics__heading">
        <strong>Current setup: {diagnostics.length} file {diagnostics.length === 1 ? 'reference needs' : 'references need'} attention</strong>
        <span>Resolve these locally before playback.</span>
      </div>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li className={diagnostic.severity === 'error' ? 'diagnostic diagnostic--error' : 'diagnostic'} key={diagnostic.code + diagnostic.requested + index}>
            <span className="diagnostic__kind">{diagnostic.subject}</span>
            <span className="diagnostic__message">{diagnostic.message}</span>
            {diagnostic.candidates.length > 0 && <span className="diagnostic__candidates">Matches: {diagnostic.candidates.join(', ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
