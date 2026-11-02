import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type InputHTMLAttributes,
} from 'react'
import { AudioTransport, type CycleSlot, type PlayOptions } from './audio'
import { SessionControls } from './SessionControls'
import {
  buildAssetIndex, buildPreviewFixture, DEMO_PRESET, generateLegacyCombo, parseLegacyIni,
  patchLegacyIniText, resolvePresetAssets, REST_SAMPLE_ID, web24bitRnd, type AssetDiagnostic, type AssetIndex,
  type AssetResolution, type Fixture, type Preset, type PresetAssetResolution,
  type SampleDefinition,
} from './domain'
import {
  fetchBuiltInPresetCatalog, loadBuiltInPreset,
  type BuiltInPresetCatalog,
} from './presets/catalog'

const TARGET_UNITS = 32
const DEFAULT_COMBO_BEATS = 8
const COMBO_BEAT_OPTIONS = [4, 8, 16, 32] as const
const LEGACY_TICKS_PER_BEAT = 16
const SYNTHETIC_SAMPLE_IDS = new Set(['synthPulse', 'synthBrush', 'synthSilence'])
const WAV_ACCEPT = '.wav,audio/wav,audio/x-wav'
const TIMELINE_LABEL_COLUMN_WIDTH = 150
const TIMELINE_MIN_TICK_WIDTH = 8
const TIMELINE_BOARD_HORIZONTAL_PADDING = 24
const TIMELINE_MIN_BOARD_WIDTH = 760
const DEFAULT_BUILTIN_PRESET_ID = 'SSC-085BPM-01'

type IniWritableHandle = {
  name: string
  createWritable: () => Promise<{
    write: (value: string | Blob) => Promise<void>
    close: () => Promise<void>
    abort?: () => Promise<void>
  }>
}

type IniSavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<IniWritableHandle>
}

type PlaybackTarget =
  | { kind: 'sequence' }
  | { kind: 'sample'; sampleId: string; name: string }
  | null

type PracticeMode = 'qa' | 'loop'
type WorkspaceSection = 'sequence' | 'files' | 'session' | 'samples'
type PresetSource = 'loading' | 'builtin' | 'custom' | 'demo'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assetMapFor(resolution: PresetAssetResolution | undefined): ReadonlyMap<string, File> {
  const files = new Map<string, File>()
  resolution?.samplesById.forEach((asset, sampleId) => {
    if (asset.status === 'resolved' && asset.file) files.set(sampleId, asset.file)
  })
  return files
}

function resolutionForSample(
  sample: SampleDefinition,
  resolution: PresetAssetResolution | undefined,
): AssetResolution | undefined {
  return resolution?.samplesById.get(sample.id)
}

function sampleFileState(
  sample: SampleDefinition,
  resolution: PresetAssetResolution | undefined,
): { label: string; tone: 'ready' | 'missing' | 'muted' } {
  if (sample.silent) return { label: 'Marked silent', tone: 'muted' }
  if (SYNTHETIC_SAMPLE_IDS.has(sample.id)) return { label: 'Demo sound', tone: 'ready' }
  const asset = resolutionForSample(sample, resolution)
  if (asset?.status === 'resolved') return { label: asset.selectedPath ?? sample.fileName, tone: 'ready' }
  if (asset?.status === 'ambiguous') return { label: 'Ambiguous file match', tone: 'missing' }
  return { label: 'WAV needed', tone: 'missing' }
}

function formatWeight(weight: number): string {
  return Number.isInteger(weight) ? String(weight) : weight.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function legacyFixtureFor(preset: Preset, requestedRawTicks: number) {
  const result = generateLegacyCombo(preset, requestedRawTicks, web24bitRnd)
  if (
    result.terminalReason === 'selection-exhausted'
    || result.terminalReason === 'zero-duration-stall'
    || result.terminalReason === 'event-budget-exhausted'
  ) {
    const reason = result.terminalReason === 'selection-exhausted'
      ? 'The selector could not complete a combo within its bounded retries.'
      : result.terminalReason === 'event-budget-exhausted'
        ? 'Combo generation reached its bounded event limit before the raw length was filled.'
        : 'An enabled sample has zero duration, so combo generation stopped safely.'
    throw new Error(reason + ' Adjust the enabled samples and try again.')
  }

  const zeroDurationCount = result.events.filter((event) => event.durationTicks === 0).length
  const events = result.events.filter((event) => event.durationTicks > 0).map((event) => ({
    id: 'legacy-' + event.eventNumber + '-' + event.sampleId,
    sampleId: event.sampleId,
    startUnits: event.startTick,
    durationUnits: event.durationTicks,
    silent: event.silent,
  }))
  if (result.remainingRawTicks > 0) {
    events.push({
      id: 'legacy-rest-' + requestedRawTicks,
      sampleId: REST_SAMPLE_ID,
      startUnits: result.completedRawTicks,
      durationUnits: result.remainingRawTicks,
      silent: true,
    })
  }
  if (result.events.length === 0) {
    throw new Error('No enabled samples could be selected. Enable at least one sample with a positive weight and duration.')
  }
  return {
    fixture: { events, totalUnits: requestedRawTicks } satisfies Fixture,
    zeroDurationCount,
    remainingRawTicks: result.remainingRawTicks,
  }
}

function LocalFilePicker({
  inputId, label, description, accept, multiple = false, directory = false, onChange,
}: {
  inputId: string
  label: string
  description: string
  accept: string
  multiple?: boolean
  directory?: boolean
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
    <label className="file-picker" htmlFor={inputId}>
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
        onChange={onChange}
        {...extraAttributes}
      />
    </label>
  )
}

function LocalImportPanel({
  presetFileName, localFileCount, importMessage, presetError, selectionError,
  builtInCatalog, selectedPresetId, presetSource, isBootstrapLoading, bootstrapError,
  onBuiltInPresetChange, onRetryBuiltIn, onPresetChange, onFolderChange, onFilesChange,
}: {
  presetFileName: string | null
  localFileCount: number
  importMessage: string
  presetError: string | null
  selectionError: string | null
  builtInCatalog: BuiltInPresetCatalog | undefined
  selectedPresetId: string
  presetSource: PresetSource
  isBootstrapLoading: boolean
  bootstrapError: string | null
  onBuiltInPresetChange: (id: string) => void
  onRetryBuiltIn: () => void
  onPresetChange: (event: ChangeEvent<HTMLInputElement>) => void
  onFolderChange: (event: ChangeEvent<HTMLInputElement>) => void
  onFilesChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <section id="files-section" className="workspace-section import-section" aria-labelledby="import-heading">
      <div className="section-heading">
        <div>
          <h2 id="import-heading">Local files</h2>
          <p>Choose a built-in practice set, or load your own INI and WAV files.</p>
        </div>
        <span className="section-index" aria-hidden="true">LOCAL</span>
      </div>
      <div className="quick-preset-row">
        <label htmlFor="quick-preset">Quick preset</label>
        <select
          id="quick-preset"
          value={selectedPresetId}
          onChange={(event) => onBuiltInPresetChange(event.currentTarget.value)}
          aria-describedby="quick-preset-help"
        >
          {!builtInCatalog && <option value={DEFAULT_BUILTIN_PRESET_ID}>{isBootstrapLoading ? 'Loading built-in presets…' : 'Built-in presets unavailable'}</option>}
          <option value="demo">Synthetic demo</option>
          <option value="custom">Your files…</option>
          {builtInCatalog?.presets.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label} · {entry.bpm} BPM</option>
          ))}
        </select>
        <span id="quick-preset-help">Built-ins load their INI and every referenced WAV. Playback stays stopped until loading finishes.</span>
      </div>
      <div className="file-picker-grid">
        <LocalFilePicker inputId="preset-file" label="Choose INI preset" description="One .ini file" accept=".ini,text/plain" onChange={onPresetChange} />
        <LocalFilePicker inputId="audio-folder" label="Choose audio folder" description="Folder picker for WAV files" accept={WAV_ACCEPT} directory onChange={onFolderChange} />
        <LocalFilePicker inputId="audio-files" label="Choose WAV files" description="Multi-file fallback" accept={WAV_ACCEPT} multiple onChange={onFilesChange} />
      </div>
      <div className="import-status">
        <span className="status-led" aria-hidden="true" />
        <div className="import-status__copy">
          <strong>{presetFileName ?? (presetSource === 'loading' ? 'Loading built-in preset' : presetSource === 'custom' ? 'Custom preset' : presetSource === 'builtin' ? 'Built-in preset' : 'Synthetic demo preset')}</strong>
          <p>{importMessage}</p>
        </div>
        <span className="import-status__count">{localFileCount} WAV {localFileCount === 1 ? 'file' : 'files'}</span>
      </div>
      {isBootstrapLoading && <p className="inline-status" role="status">Loading the preset and its referenced WAV files. Playback is unavailable until every reference is ready.</p>}
      {bootstrapError && <div className="inline-error" role="alert"><p>{bootstrapError}</p><button className="button button--small" type="button" onClick={onRetryBuiltIn}>Retry built-in preset</button></div>}
      {presetError && <p className="inline-error" role="alert">{presetError}</p>}
      {selectionError && <p className="inline-error inline-error--quiet" role="status">{selectionError}</p>}
    </section>
  )
}

function PracticeCycleControls({
  mode, largePause, disabled, onModeChange, onLargePauseChange,
}: {
  mode: PracticeMode
  largePause: boolean
  disabled: boolean
  onModeChange: (mode: PracticeMode) => void
  onLargePauseChange: (enabled: boolean) => void
}) {
  return (
    <div className="practice-cycle-controls" role="group" aria-label="Practice cycle settings">
      <fieldset className="practice-mode-control" disabled={disabled}>
        <legend>Practice mode</legend>
        <label><input type="radio" name="practice-mode" value="qa" checked={mode === 'qa'} onChange={() => onModeChange('qa')} />Q&amp;A</label>
        <label><input type="radio" name="practice-mode" value="loop" checked={mode === 'loop'} onChange={() => onModeChange('loop')} />Loop</label>
      </fieldset>
      {mode === 'qa' && (
        <label className="large-pause-control">
          <input type="checkbox" checked={largePause} disabled={disabled} onChange={(event) => onLargePauseChange(event.currentTarget.checked)} />
          <span><strong>Large pause</strong><small>{largePause ? '1 audio cycle, then 3 silent cycles.' : '1 audio cycle, then 1 silent cycle.'}</small></span>
        </label>
      )}
    </div>
  )
}

function cycleSlotsFor(fixture: Fixture, mode: PracticeMode, largePause: boolean): CycleSlot[] {
  if (mode === 'loop') return [{ kind: 'fixture', fixture }]

  return [
    { kind: 'fixture', fixture },
    ...Array.from({ length: largePause ? 3 : 1 }, () => ({
      kind: 'silence' as const,
      durationUnits: fixture.totalUnits,
    })),
  ]
}

function SequenceTimeline({
  fixture, preset, progress, isPlaying, auditionedSampleId, timebase,
}: {
  fixture: Fixture
  preset: Preset
  progress: number
  isPlaying: boolean
  auditionedSampleId: string | null
  timebase: 'demo' | 'legacy'
}) {
  const totalUnits = Math.max(fixture.totalUnits, 1)
  const minBoardWidth = Math.max(
    TIMELINE_MIN_BOARD_WIDTH,
    TIMELINE_LABEL_COLUMN_WIDTH + totalUnits * TIMELINE_MIN_TICK_WIDTH + TIMELINE_BOARD_HORIZONTAL_PADDING,
  )
  const unitsPerBeat = timebase === 'legacy' ? LEGACY_TICKS_PER_BEAT : 4
  const unitsPerBar = unitsPerBeat * 4
  const unitDescription = timebase === 'legacy' ? 'legacy ticks' : 'sixteenth units'
  const unitNumbers = Array.from({ length: totalUnits }, (_, index) => index)
  const bars = Array.from({ length: Math.ceil(totalUnits / unitsPerBar) }, (_, index) => {
    const unitsInBar = Math.min(unitsPerBar, totalUnits - index * unitsPerBar)
    return <span className="timeline-bar-label" key={index} style={{ width: (unitsInBar / totalUnits) * 100 + '%' }}>Bar {index + 1}</span>
  })
  const activeSampleIds = new Set(fixture.events.map((event) => event.sampleId))
  const lanes: Array<{ id: string; name: string; note: string }> = preset.samples.filter((sample) => activeSampleIds.has(sample.id)).map((sample) => ({
    id: sample.id, name: sample.name,
    note: sample.silent ? 'silent' : sample.durationUnits + (timebase === 'legacy' ? ' ticks' : ' units'),
  }))
  if (fixture.events.some((event) => event.sampleId === REST_SAMPLE_ID)) {
    lanes.push({ id: REST_SAMPLE_ID, name: 'Rest', note: 'unused time' })
  }
  for (const event of fixture.events) {
    if (!lanes.some((lane) => lane.id === event.sampleId)) {
      lanes.push({ id: event.sampleId, name: event.sampleId, note: 'event' })
    }
  }
  const eventDescription = fixture.events.map((event, index) => {
    const sample = preset.samples.find((candidate) => candidate.id === event.sampleId)
    const name = event.sampleId === REST_SAMPLE_ID ? 'Rest' : sample?.name ?? event.sampleId
    const startLabel = timebase === 'legacy' ? 'legacy tick ' : 'sixteenth unit '
    const durationLabel = timebase === 'legacy' ? ' legacy ticks' : ' units'
    return <li key={event.id}>Event {index + 1}: {name}, starts at {startLabel}{event.startUnits + 1}, lasts {event.durationUnits}{durationLabel}{event.silent ? ', silent' : ''}</li>
  })

  return (
    <figure className="timeline-figure" aria-labelledby="timeline-caption">
      <figcaption id="timeline-caption" className="timeline-caption">
        <span>
          <strong>Sequence timeline</strong>
          <span>{fixture.totalUnits} {unitDescription} across {Math.ceil(fixture.totalUnits / unitsPerBar)} bars</span>
        </span>
        <span className="timing-readout">{fixture.events.length} events</span>
      </figcaption>
      <div className="timeline-scroll" role="img" tabIndex={0} aria-label={'Sequence timeline: ' + fixture.totalUnits + ' ' + unitDescription + ', ' + fixture.events.length + ' events'}>
        <div className="timeline-board" style={{ minWidth: minBoardWidth }}>
          <div className="timeline-bar-row">
            <span className="timeline-axis-label">BAR</span>
            <div className="timeline-bar-labels">{bars}</div>
          </div>
          <div className="timeline-ruler-row">
            <span className="timeline-axis-label">BEAT</span>
            <div className="timeline-ruler" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
              {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'ruler-cell ruler-cell--beat' : 'ruler-cell'} key={unit}>{unit % unitsPerBeat === 0 ? String((Math.floor(unit / unitsPerBeat) % 4) + 1) : ''}</span>)}
            </div>
          </div>
          {lanes.map((lane) => {
            const events = fixture.events.filter((event) => event.sampleId === lane.id)
            return (
              <div className={lane.id === auditionedSampleId ? 'timeline-lane timeline-lane--auditioned' : 'timeline-lane'} key={lane.id}>
                <span className="timeline-lane-label"><span>{lane.name}</span><small>{lane.note}</small></span>
                <span className="timeline-track" aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                  {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                  {events.map((event) => (
                    <span
                      key={event.id}
                      className={event.silent ? 'sequence-event sequence-event--silent' : 'sequence-event'}
                      style={{ left: (event.startUnits / totalUnits) * 100 + '%', width: (event.durationUnits / totalUnits) * 100 + '%' }}
                      title={event.silent ? lane.name + ': silent event' : lane.name + ': ' + event.durationUnits + ' units'}
                    />
                  ))}
                  {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <ol className="visually-hidden" aria-label="Sequence events">{eventDescription}</ol>
    </figure>
  )
}

function DiagnosticList({ diagnostics }: { diagnostics: AssetDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return <div className="asset-check asset-check--ready" role="status"><span className="asset-check__mark" aria-hidden="true" /><p>All referenced files are ready.</p></div>
  }
  return (
    <div className="diagnostics" role="status" aria-live="polite">
      <div className="diagnostics__heading">
        <strong>{diagnostics.length} file {diagnostics.length === 1 ? 'reference needs' : 'references need'} attention</strong>
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

function SampleEditor({
  sample, draft, disabled, onDraftChange, onSave, onCancel,
}: {
  sample: SampleDefinition
  draft: SampleDefinition
  disabled: boolean
  onDraftChange: (next: SampleDefinition) => void
  onSave: () => void
  onCancel: () => void
}) {
  const durationRef = useRef<HTMLInputElement>(null)
  useEffect(() => { durationRef.current?.focus() }, [sample.id])
  const numericValue = (value: number) => Number.isFinite(value) ? value : ''
  const setNumeric = (field: 'durationUnits' | 'weight' | 'maxRepeat', raw: string) => {
    onDraftChange({ ...draft, [field]: raw === '' ? Number.NaN : Number(raw) })
  }
  return (
    <form className="sample-editor" aria-label={'Edit ' + sample.name} noValidate onSubmit={(event) => { event.preventDefault(); onSave() }}>
      <div className="sample-editor__heading">
        <div>
          <h3>Edit {sample.name}</h3>
          <p>These values apply to the next generated combo. File and sample metadata stay read-only.</p>
        </div>
        <span className="sample-editor__id">{sample.id}</span>
      </div>
      <div className="sample-editor__fields">
        <label className="sample-editor__field" htmlFor="sample-duration">
          <span>Duration ticks</span>
          <input ref={durationRef} id="sample-duration" aria-label="Duration ticks" type="number" min="0" max="512" step="1" value={numericValue(draft.durationUnits)} disabled={disabled} onChange={(event) => setNumeric('durationUnits', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__field" htmlFor="sample-weight">
          <span>Play weight</span>
          <input id="sample-weight" aria-label="Play weight" type="number" min="0" max="10000" step="1" value={numericValue(draft.weight)} disabled={disabled} onChange={(event) => setNumeric('weight', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__field" htmlFor="sample-start-direction">
          <span>Start direction</span>
          <select id="sample-start-direction" value={draft.startForward ? 'forward' : 'reverse'} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, startForward: event.currentTarget.value === 'forward' })}>
            <option value="forward">Forward</option><option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="sample-editor__field" htmlFor="sample-end-direction">
          <span>End direction</span>
          <select id="sample-end-direction" value={draft.endForward ? 'forward' : 'reverse'} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, endForward: event.currentTarget.value === 'forward' })}>
            <option value="forward">Forward</option><option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="sample-editor__field" htmlFor="sample-repeat-max">
          <span>Repeat maximum</span>
          <input id="sample-repeat-max" aria-label="Repeat maximum" type="number" min="0" max="8192" step="1" value={numericValue(draft.maxRepeat)} disabled={disabled} onChange={(event) => setNumeric('maxRepeat', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__check" htmlFor="sample-can-repeat">
          <input id="sample-can-repeat" type="checkbox" checked={draft.canRepeat} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, canRepeat: event.currentTarget.checked })} />
          <span>Repeat allowed</span>
        </label>
        <label className="sample-editor__check" htmlFor="sample-use">
          <input id="sample-use" type="checkbox" checked={draft.enabled || draft.silent} disabled={disabled || draft.silent} onChange={(event) => onDraftChange({ ...draft, enabled: event.currentTarget.checked })} />
          <span>{draft.silent ? 'Use sample · always included (silent)' : 'Use sample'}</span>
        </label>
      </div>
      <div className="sample-editor__actions">
        <button className="button button--small" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button--small button--primary" type="submit" disabled={disabled}>Save sample changes</button>
      </div>
    </form>
  )
}

function SampleTable({
  preset, resolution, actionsDisabled, legacyMode, sourceAvailable, editingSample, saveError, isSavingData,
  onToggle, onPreview, onEdit, onDraftChange, onSaveEdit, onCancelEdit, onSaveData,
}: {
  preset: Preset
  resolution: PresetAssetResolution | undefined
  actionsDisabled: boolean
  legacyMode: boolean
  sourceAvailable: boolean
  editingSample: SampleDefinition | null
  saveError: string | null
  isSavingData: boolean
  onToggle: (sample: SampleDefinition, enabled: boolean) => void
  onPreview: (sample: SampleDefinition) => void
  onEdit: (sample: SampleDefinition) => void
  onDraftChange: (sample: SampleDefinition) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onSaveData: () => void
}) {
  return (
    <section id="sample-section" className="workspace-section sample-section" aria-labelledby="samples-heading">
      <div className="section-heading">
        <div>
          <h2 id="samples-heading">Sample settings</h2>
          <p>{legacyMode ? 'Choose and edit eligible samples for the next generated combo. Silent rows stay included. Changes are held in this session until you save a working INI copy.' : 'Enable or disable samples for the next preview. Source files are never changed.'}</p>
        </div>
        <div className="sample-section__actions">
          {sourceAvailable && <button className="button button--small" type="button" disabled={actionsDisabled || Boolean(editingSample) || isSavingData} onClick={onSaveData}>{isSavingData ? 'Saving…' : 'Save Sample Data'}</button>}
          <span className="sample-count">{preset.samples.length} {preset.samples.length === 1 ? 'sample' : 'samples'}</span>
        </div>
      </div>
      {editingSample && <SampleEditor sample={preset.samples.find((sample) => sample.id === editingSample.id) ?? editingSample} draft={editingSample} disabled={actionsDisabled} onDraftChange={onDraftChange} onSave={onSaveEdit} onCancel={onCancelEdit} />}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div
        className="sample-table-scroll"
        role="region"
        aria-labelledby="samples-heading"
        aria-describedby="sample-table-scroll-help"
        tabIndex={0}
      >
        <span className="visually-hidden" id="sample-table-scroll-help">Use the arrow keys to scroll through the sample rows and columns.</span>
        <table className="sample-table">
          <thead><tr>
            <th scope="col">Sample</th><th scope="col">File reference</th><th scope="col">Length</th>
            <th scope="col">Weight</th><th scope="col">Direction</th><th scope="col">Repeat</th>
            <th scope="col">Use</th>{sourceAvailable && <th scope="col">Edit</th>}<th scope="col">Preview</th>
          </tr></thead>
          <tbody>
            {preset.samples.map((sample) => {
              const fileState = sampleFileState(sample, resolution)
              const asset = resolutionForSample(sample, resolution)
              return (
                <tr key={sample.id}>
                  <th scope="row"><span className="sample-name">{sample.name}</span><span className="sample-id">{sample.id}</span></th>
                  <td>
                    <span className={'file-state file-state--' + fileState.tone}>{fileState.label}</span>
                    {sample.fileName && <code className="file-reference" title={sample.fileName}>{sample.fileName}</code>}
                    {asset?.status === 'ambiguous' && <span className="file-detail">{asset.candidates.length} matching files</span>}
                  </td>
                  <td className="numeric-cell">{sample.durationUnits} {legacyMode ? 'legacy ticks' : 'units'}</td>
                  <td className="numeric-cell">{formatWeight(sample.weight)}</td>
                  <td><span className="direction-value">{sample.startForward ? 'Forward' : 'Reverse'} / {sample.endForward ? 'Forward' : 'Reverse'}</span><span className="file-detail">start / end</span></td>
                  <td><span>{sample.canRepeat ? 'Repeat flag on' : 'Repeat flag off'}</span><span className="file-detail">Configured value: {sample.maxRepeat}</span></td>
                  <td>
                    <label className="toggle-control">
                      <input type="checkbox" checked={sample.enabled || sample.silent} aria-label={'Enable ' + sample.name + ' for ' + (legacyMode ? 'next combo' : 'preview')} disabled={actionsDisabled || sample.silent} onChange={(event) => onToggle(sample, event.currentTarget.checked)} />
                      <span className="toggle-control__track" aria-hidden="true"><span /></span>
                      <span className="toggle-control__text">{sample.silent ? 'Always included' : sample.enabled ? 'On' : 'Off'}</span>
                    </label>
                  </td>
                  {sourceAvailable && <td><button className="button button--small" type="button" aria-label={'Edit ' + sample.name} disabled={actionsDisabled} onClick={() => onEdit(sample)}>Edit</button></td>}
                  <td>
                    {sample.silent
                      ? <span className="file-state file-state--muted" title="Silent samples remain included in generated combos, but have no audio preview.">Silent</span>
                      : <button className="button button--small" type="button" aria-label={'Preview ' + sample.name} title={actionsDisabled ? 'Wait for the preset import or combo generation to finish.' : undefined} disabled={actionsDisabled} onClick={() => onPreview(sample)}>Preview</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function App() {
  const [transport] = useState(() => new AudioTransport())
  const transportSnapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot, transport.getSnapshot)
  const [preset, setPreset] = useState<Preset>(DEMO_PRESET)
  const [fixture, setFixture] = useState<Fixture | null>(null)
  const [timebase, setTimebase] = useState<'demo' | 'legacy'>('demo')
  const [comboBeats, setComboBeats] = useState<number>(DEFAULT_COMBO_BEATS)
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('qa')
  const [largePause, setLargePause] = useState(false)
  const [omittedZeroDurationCount, setOmittedZeroDurationCount] = useState(0)
  const [presetFileName, setPresetFileName] = useState<string | null>(null)
  const [sourceIniText, setSourceIniText] = useState<string | null>(null)
  const [editingSample, setEditingSample] = useState<SampleDefinition | null>(null)
  const [isSavingIni, setIsSavingIni] = useState(false)
  const [saveIniError, setSaveIniError] = useState<string | null>(null)
  const [localWavFiles, setLocalWavFiles] = useState<File[]>([])
  const [assetIndex, setAssetIndex] = useState<AssetIndex>(() => buildAssetIndex([]))
  const [assetResolution, setAssetResolution] = useState<PresetAssetResolution>()
  const [isReadingPreset, setIsReadingPreset] = useState(true)
  const [isPresetReady, setIsPresetReady] = useState(false)
  const [presetSource, setPresetSource] = useState<PresetSource>('loading')
  const [builtInCatalog, setBuiltInCatalog] = useState<BuiltInPresetCatalog>()
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_BUILTIN_PRESET_ID)
  const [isBootstrapLoading, setIsBootstrapLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [importMessage, setImportMessage] = useState('Loading the 85 BPM Beginner preset and its referenced WAV files.')
  const [presetError, setPresetError] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [bpm, setBpm] = useState(String(DEMO_PRESET.bpm))
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const [sampleVolume, setSampleVolume] = useState(DEMO_PRESET.sampleVolume)
  const [beatVolume, setBeatVolume] = useState(DEMO_PRESET.beatVolume)
  const [selectedBeatIndex, setSelectedBeatIndex] = useState('none')
  const [playbackTarget, setPlaybackTarget] = useState<PlaybackTarget>(null)
  const [transportNote, setTransportNote] = useState('Ready to play.')
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('sequence')

  const assetIndexRef = useRef(assetIndex)
  const presetImportGeneration = useRef(0)
  const presetSourceRef = useRef<PresetSource>('loading')
  const activePresetLoadRef = useRef<AbortController | undefined>(undefined)
  const builtInCatalogRef = useRef<BuiltInPresetCatalog | undefined>(undefined)
  const customWavFilesRef = useRef<File[]>([])
  const lifecycleGeneration = useRef(0)
  const sourceControlDefaultsRef = useRef({
    bpm: DEMO_PRESET.bpm,
    sampleVolume: DEMO_PRESET.sampleVolume,
    beatVolume: DEMO_PRESET.beatVolume,
  })
  const sampleAssets = useMemo(() => assetMapFor(assetResolution), [assetResolution])
  const selectedBeatResolution = selectedBeatIndex === 'none' ? undefined : assetResolution?.beats[Number(selectedBeatIndex)]
  const selectedBeatFile = selectedBeatResolution?.status === 'resolved' ? selectedBeatResolution.file : undefined
  const diagnostics = assetResolution?.diagnostics ?? []
  const cycleSlotCount = playbackTarget?.kind === 'sequence' && presetFileName
    ? practiceMode === 'loop' ? 1 : largePause ? 4 : 2
    : 1

  const startBuiltInPresetLoad = (presetId: string) => {
    const generation = ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    const controller = new AbortController()
    activePresetLoadRef.current = controller
    presetSourceRef.current = 'builtin'
    setPresetSource('builtin')
    setSelectedPresetId(presetId)
    setPresetFileName(null)
    setSourceIniText(null)
    setEditingSample(null)
    setIsSavingIni(false)
    setSaveIniError(null)
    setIsPresetReady(false)
    setIsBootstrapLoading(true)
    setIsReadingPreset(true)
    setBootstrapError(null)
    setPresetError(null)
    setSelectionError(null)
    setActionError(null)
    setFixture(null)
    setPlaybackTarget(null)
    setOmittedZeroDurationCount(0)
    setTimebase('legacy')
    const emptyIndex = buildAssetIndex([])
    assetIndexRef.current = emptyIndex
    setAssetIndex(emptyIndex)
    setAssetResolution(undefined)
    setImportMessage('Loading the selected preset and its referenced WAV files.')
    setTransportNote('Loading preset resources. Playback is stopped until loading finishes.')
    transport.stop()
    transport.resetAssets()

    void (async () => {
      try {
        const catalog = builtInCatalogRef.current
          ?? await fetchBuiltInPresetCatalog(fetch, controller.signal)
        if (generation !== presetImportGeneration.current) return
        builtInCatalogRef.current = catalog
        setBuiltInCatalog(catalog)
        const entry = catalog.presets.find((candidate) => candidate.id === presetId)
        if (!entry) throw new Error('That built-in preset is not available in the catalog.')

        const loaded = await loadBuiltInPreset(entry, { signal: controller.signal })
        if (generation !== presetImportGeneration.current) return
        const nextIndex = buildAssetIndex(loaded.audioFiles)
        const nextResolution = resolvePresetAssets(loaded.preset, nextIndex)
        const samplesReady = loaded.preset.samples.every((sample) => nextResolution.samplesById.get(sample.id)?.status === 'resolved')
        const beatsReady = nextResolution.beats.every((beat) => beat.status === 'resolved')
        if (!samplesReady || !beatsReady || nextResolution.diagnostics.length > 0) {
          throw new Error('Some referenced WAV files could not be matched safely. Retry this preset.')
        }
        const requestedRawTicks = DEFAULT_COMBO_BEATS * LEGACY_TICKS_PER_BEAT
        const generated = legacyFixtureFor(loaded.preset, requestedRawTicks)

        assetIndexRef.current = nextIndex
        setAssetIndex(nextIndex)
        setAssetResolution(nextResolution)
        setPreset(loaded.preset)
        sourceControlDefaultsRef.current = {
          bpm: loaded.preset.bpm,
          sampleVolume: loaded.preset.sampleVolume,
          beatVolume: loaded.preset.beatVolume,
        }
        setPresetFileName(loaded.iniFile.name)
        setSourceIniText(loaded.iniText)
        setEditingSample(null)
        setFixture(generated.fixture)
        setTimebase('legacy')
        setComboBeats(DEFAULT_COMBO_BEATS)
        setOmittedZeroDurationCount(generated.zeroDurationCount)
        setBpm(String(loaded.preset.bpm))
        setPitchSemitones(0)
        setSampleVolume(loaded.preset.sampleVolume)
        setBeatVolume(loaded.preset.beatVolume)
        setSelectedBeatIndex(nextResolution.beats[0]?.status === 'resolved' ? '0' : 'none')
        transport.setPitchSemitones(0)
        transport.setSampleVolume(loaded.preset.sampleVolume)
        transport.setBeatVolume(loaded.preset.beatVolume)
        setIsPresetReady(true)
        setIsBootstrapLoading(false)
        setImportMessage(entry.label + ' ready. All ' + loaded.preset.samples.length + ' sample references and ' + nextResolution.beats.length + ' beat files are loaded; an 8-beat combo is ready. Playback has not started.')
        setTransportNote('Built-in preset ready. Combo generated; ready to play.')
      } catch (error) {
        if (controller.signal.aborted || generation !== presetImportGeneration.current) return
        controller.abort()
        setFixture(null)
        setIsPresetReady(false)
        setBootstrapError(describeError(error) + ' Retry the built-in preset or choose your own INI below.')
        setIsBootstrapLoading(false)
        setImportMessage('The selected built-in preset is not ready. Playback is disabled until all files load.')
        setTransportNote('Built-in preset could not be loaded.')
      } finally {
        if (generation === presetImportGeneration.current) setIsReadingPreset(false)
      }
    })()

    return controller
  }

  const selectDemoPreset = () => {
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    presetSourceRef.current = 'demo'
    setPresetSource('demo')
    setSelectedPresetId('demo')
    setPresetError(null)
    setBootstrapError(null)
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    setIsPresetReady(true)
    setPreset(DEMO_PRESET)
    sourceControlDefaultsRef.current = {
      bpm: DEMO_PRESET.bpm,
      sampleVolume: DEMO_PRESET.sampleVolume,
      beatVolume: DEMO_PRESET.beatVolume,
    }
    setPresetFileName(null)
    setSourceIniText(null)
    setEditingSample(null)
    setIsSavingIni(false)
    setSaveIniError(null)
    setAssetResolution(undefined)
    setFixture(buildPreviewFixture(DEMO_PRESET, TARGET_UNITS))
    setTimebase('demo')
    setOmittedZeroDurationCount(0)
    setBpm(String(DEMO_PRESET.bpm))
    setPitchSemitones(0)
    setSampleVolume(DEMO_PRESET.sampleVolume)
    setBeatVolume(DEMO_PRESET.beatVolume)
    setSelectedBeatIndex('none')
    setActionError(null)
    setPlaybackTarget(null)
    setImportMessage('Synthetic demo ready. Choose a built-in set or load your own INI.')
    setTransportNote('Synthetic demo ready. Build a preview when you are ready.')
    transport.stop()
    transport.resetAssets()
    transport.setPitchSemitones(0)
    transport.setSampleVolume(DEMO_PRESET.sampleVolume)
    transport.setBeatVolume(DEMO_PRESET.beatVolume)
  }

  const selectCustomFiles = () => {
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    presetSourceRef.current = 'custom'
    setPresetSource('custom')
    setSelectedPresetId('custom')
    setPresetError(null)
    setBootstrapError(null)
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    setIsPresetReady(false)
    setPresetFileName(null)
    setSourceIniText(null)
    setEditingSample(null)
    setIsSavingIni(false)
    setSaveIniError(null)
    setFixture(null)
    setAssetResolution(undefined)
    setOmittedZeroDurationCount(0)
    setActionError(null)
    setPlaybackTarget(null)
    const customIndex = buildAssetIndex(customWavFilesRef.current)
    assetIndexRef.current = customIndex
    setAssetIndex(customIndex)
    setLocalWavFiles(customWavFilesRef.current)
    setImportMessage('Choose your own INI and WAV files below. Playback stays disabled until the INI is read.')
    setTransportNote('Choose your own preset files to continue.')
    transport.stop()
    transport.resetAssets()
    requestAnimationFrame(() => {
      const filesSection = document.getElementById('files-section')
      filesSection?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      document.getElementById('preset-file')?.focus()
    })
  }

  useEffect(() => {
    const generation = ++lifecycleGeneration.current
    const stopOnPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) transport.stop()
      else transport.dispose()
    }
    window.addEventListener('pagehide', stopOnPageHide)
    return () => {
      window.removeEventListener('pagehide', stopOnPageHide)
      queueMicrotask(() => {
        if (lifecycleGeneration.current === generation) transport.dispose()
      })
    }
  }, [transport])

  useEffect(() => {
    const controller = startBuiltInPresetLoad(DEFAULT_BUILTIN_PRESET_ID)
    return () => {
      controller.abort()
      if (activePresetLoadRef.current === controller) presetImportGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    const sections: ReadonlyArray<{ id: string; section: WorkspaceSection }> = [
      { id: 'sequence-section', section: 'sequence' },
      { id: 'files-section', section: 'files' },
      { id: 'session-section', section: 'session' },
      { id: 'sample-section', section: 'samples' },
    ]
    const updateActiveSection = () => {
      const markerY = Math.min(120, window.innerHeight * 0.22)
      const visibleSections = sections.flatMap(({ id, section }) => {
        const element = document.getElementById(id)
        if (!element) return []
        const rect = element.getBoundingClientRect()
        return [{ section, top: rect.top, bottom: rect.bottom }]
      })
      const atPageEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
      const lastSection = visibleSections.at(-1)
      if (atPageEnd && lastSection && lastSection.top < window.innerHeight && lastSection.bottom > 0) {
        setActiveSection(lastSection.section)
        return
      }
      const current = visibleSections.find(({ top, bottom }) => top <= markerY && bottom > markerY)
        ?? visibleSections.find(({ top }) => top > markerY)
        ?? visibleSections.at(-1)
      if (current) setActiveSection(current.section)
    }
    let scheduledFrame: number | undefined
    const scheduleUpdate = () => {
      if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame)
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = undefined
        updateActiveSection()
      })
    }
    updateActiveSection()
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('hashchange', scheduleUpdate)
    return () => {
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('hashchange', scheduleUpdate)
      if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame)
    }
  }, [])

  useEffect(() => {
    if (transportSnapshot.status === 'loading') setTransportNote('Preparing preview audio.')
    if (transportSnapshot.status === 'playing') {
      if (playbackTarget?.kind === 'sample') {
        setTransportNote('Previewing ' + playbackTarget.name + '.')
      } else if (playbackTarget?.kind === 'sequence' && transportSnapshot.cycleSlotKind) {
        const iteration = transportSnapshot.cycleIteration ?? 1
        const slotIndex = transportSnapshot.cycleSlotIndex ?? 0
        const cycleNumber = ((iteration - 1) * cycleSlotCount) + slotIndex + 1
        if (practiceMode === 'loop') {
          setTransportNote('Loop · combo cycle ' + cycleNumber + '.')
        } else {
          setTransportNote(transportSnapshot.cycleSlotKind === 'fixture'
            ? 'Q&A · question playback · cycle ' + cycleNumber + '.'
            : 'Q&A · answer pause · cycle ' + cycleNumber + '.')
        }
      } else {
        setTransportNote('Playing sequence.')
      }
    }
    if (transportSnapshot.status === 'completed') {
      setTransportNote('Preview complete.')
      setPlaybackTarget(null)
    }
    if (transportSnapshot.status === 'error') setTransportNote(transportSnapshot.error ?? 'Playback could not start.')
  }, [transportSnapshot.status, transportSnapshot.error, transportSnapshot.cycleSlotKind, transportSnapshot.cycleSlotIndex, transportSnapshot.cycleIteration, playbackTarget, practiceMode, cycleSlotCount])

  const handlePresetChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    const generation = ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    presetSourceRef.current = 'custom'
    setPresetSource('custom')
    setSelectedPresetId('custom')
    setIsPresetReady(false)
    setIsBootstrapLoading(false)
    setIsReadingPreset(true)
    setPresetFileName(null)
    setSourceIniText(null)
    setEditingSample(null)
    setIsSavingIni(false)
    setSaveIniError(null)
    setBootstrapError(null)
    transport.resetAssets()
    transport.stop()
    setPlaybackTarget(null)
    setFixture(null)
    setTimebase('legacy')
    setOmittedZeroDurationCount(0)
    setActionError(null)
    setPresetError(null)
    setSelectionError(null)
    const customIndex = buildAssetIndex(customWavFilesRef.current)
    assetIndexRef.current = customIndex
    setAssetIndex(customIndex)
    setLocalWavFiles(customWavFilesRef.current)
    setAssetResolution(undefined)
    setImportMessage('Reading preset locally...')
    setTransportNote('Reading preset. Playback is stopped until import completes.')
    void file.text()
      .then((text) => {
        if (generation !== presetImportGeneration.current) return
        const nextPreset = parseLegacyIni(text)
        const nextIndex = buildAssetIndex(customWavFilesRef.current)
        assetIndexRef.current = nextIndex
        const nextResolution = resolvePresetAssets(nextPreset, nextIndex)
        setPreset(nextPreset)
        setPresetFileName(file.name)
        setSourceIniText(text)
        setAssetIndex(nextIndex)
        setAssetResolution(nextResolution)
        setFixture(null)
        setTimebase('legacy')
        setComboBeats(DEFAULT_COMBO_BEATS)
        setOmittedZeroDurationCount(0)
        setBpm(String(nextPreset.bpm))
        setPitchSemitones(0)
        setSampleVolume(nextPreset.sampleVolume)
        setBeatVolume(nextPreset.beatVolume)
        setSelectedBeatIndex(nextResolution.beats[0]?.status === 'resolved' ? '0' : 'none')
        const resolvedSamples = Array.from(nextResolution.samplesById.values()).filter((item) => item.status === 'resolved').length
        const resolvedBeats = nextResolution.beats.filter((item) => item.status === 'resolved').length
        setIsPresetReady(true)
        sourceControlDefaultsRef.current = {
          bpm: nextPreset.bpm,
          sampleVolume: nextPreset.sampleVolume,
          beatVolume: nextPreset.beatVolume,
        }
        transport.setPitchSemitones(0)
        transport.setSampleVolume(nextPreset.sampleVolume)
        transport.setBeatVolume(nextPreset.beatVolume)
        setImportMessage(nextPreset.samples.length + ' sample references parsed; ' + resolvedSamples + ' samples and ' + resolvedBeats + ' beat files resolved from your selected WAVs.')
        setTransportNote('Preset loaded. Generate a combo when ready.')
      })
      .catch((error: unknown) => {
        if (generation !== presetImportGeneration.current) return
        setPresetError('Could not read ' + file.name + ': ' + describeError(error))
        setIsPresetReady(false)
        setImportMessage('Preset data is not ready. Choose a valid INI file to try again.')
      })
      .finally(() => {
        if (generation === presetImportGeneration.current) setIsReadingPreset(false)
      })
  }

  const handleWavChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const chosenFiles = Array.from(input.files ?? [])
    input.value = ''
    if (chosenFiles.length === 0) return

    const wavFiles = chosenFiles.filter((file) => file.name.toLowerCase().endsWith('.wav'))
    const ignoredCount = chosenFiles.length - wavFiles.length
    customWavFilesRef.current = wavFiles
    setLocalWavFiles(wavFiles)
    setSelectionError(
      wavFiles.length === 0
        ? 'No .wav files were found in that selection. Choose a folder or multiple WAV files.'
        : ignoredCount > 0
          ? ignoredCount + ' non-WAV ' + (ignoredCount === 1 ? 'file was' : 'files were') + ' ignored.'
          : null,
    )

    if (presetSourceRef.current === 'custom') {
      const nextIndex = buildAssetIndex(wavFiles)
      assetIndexRef.current = nextIndex
      setAssetIndex(nextIndex)
      transport.resetAssets()
      transport.stop()
      setPlaybackTarget(null)
      setFixture(null)
      setOmittedZeroDurationCount(0)
      setActionError(null)
      if (presetFileName) {
        const nextResolution = resolvePresetAssets(preset, nextIndex)
        setAssetResolution(nextResolution)
        const foundSamples = Array.from(nextResolution.samplesById.values()).filter((entry) => entry.status === 'resolved').length
        const foundBeats = nextResolution.beats.filter((entry) => entry.status === 'resolved').length
        if (selectedBeatIndex === 'none' && nextResolution.beats[0]?.status === 'resolved') setSelectedBeatIndex('0')
        setImportMessage(foundSamples + ' of ' + preset.samples.length + ' sample references and ' + foundBeats + ' of ' + nextResolution.beats.length + ' beat files resolved from local WAVs.')
      } else {
        setImportMessage(wavFiles.length + ' custom WAV ' + (wavFiles.length === 1 ? 'file is' : 'files are') + ' staged for the selected INI.')
      }
    } else if (presetSourceRef.current !== 'builtin' && presetSourceRef.current !== 'loading') {
      const nextIndex = buildAssetIndex(wavFiles)
      assetIndexRef.current = nextIndex
      setAssetIndex(nextIndex)
      setImportMessage(wavFiles.length + ' custom WAV ' + (wavFiles.length === 1 ? 'file is' : 'files are') + ' held in this session. Choose a custom INI to match filenames.')
    }
  }

  const handleBuiltInPresetChange = (presetId: string) => {
    if (presetId === 'demo') {
      selectDemoPreset()
      return
    }
    if (presetId === 'custom') {
      selectCustomFiles()
      return
    }
    startBuiltInPresetLoad(presetId)
  }

  const handleRetryBuiltIn = () => {
    startBuiltInPresetLoad(selectedPresetId === 'demo' || selectedPresetId === 'custom'
      ? DEFAULT_BUILTIN_PRESET_ID
      : selectedPresetId)
  }

  const handleBpmChange = (value: string) => {
    setBpm(value)
    const nextBpm = Number(value)
    const minBpm = Math.max(1, preset.bpm * 0.5)
    const maxBpm = Math.max(minBpm, preset.bpm * 2)
    if (Number.isFinite(nextBpm) && nextBpm >= minBpm && nextBpm <= maxBpm) {
      if (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading') transport.setTempo(nextBpm)
      setActionError(null)
    }
  }

  const handlePitchChange = (value: number) => {
    setPitchSemitones(value)
    transport.setPitchSemitones(value)
  }

  const handleSampleVolumeChange = (value: number) => {
    setSampleVolume(value)
    transport.setSampleVolume(value)
  }

  const handleBeatVolumeChange = (value: number) => {
    setBeatVolume(value)
    transport.setBeatVolume(value)
  }

  const handleResetSessionControls = () => {
    const defaults = sourceControlDefaultsRef.current
    const resetBpm = String(defaults.bpm)
    setBpm(resetBpm)
    setPitchSemitones(0)
    setSampleVolume(defaults.sampleVolume)
    setBeatVolume(defaults.beatVolume)
    if (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading') transport.setTempo(defaults.bpm)
    transport.setPitchSemitones(0)
    transport.setSampleVolume(defaults.sampleVolume)
    transport.setBeatVolume(defaults.beatVolume)
    setActionError(null)
    setTransportNote('Controls reset to the selected preset defaults. Playback continues.')
  }

  const handleBeatSelectionChange = (value: string) => {
    if (value === selectedBeatIndex) return
    if (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading') {
      transport.stop()
      setPlaybackTarget(null)
      setTransportNote('Playback stopped. Beat selection changed; play again to hear it.')
    }
    setSelectedBeatIndex(value)
  }

  const handleToggle = (sample: SampleDefinition, enabled: boolean) => {
    if (sample.silent) return
    transport.stop()
    setPlaybackTarget(null)
    setFixture(null)
    setOmittedZeroDurationCount(0)
    setActionError(null)
    setPreset((current) => ({
      ...current,
      samples: current.samples.map((candidate) => candidate.id === sample.id ? { ...candidate, enabled } : candidate),
    }))
    setTransportNote(sample.name + (enabled ? ' enabled' : ' disabled') + (presetFileName ? ' for the next combo.' : ' for the next preview.'))
  }

  const handleEditSample = (sample: SampleDefinition) => {
    setSaveIniError(null)
    setEditingSample({ ...sample })
  }

  const handleSampleDraftChange = (sample: SampleDefinition) => {
    setEditingSample(sample)
  }

  const handleSaveSampleEdit = () => {
    if (!sourceIniText || !editingSample) return
    try {
      const nextPreset: Preset = {
        ...preset,
        sampleVolume,
        beatVolume,
        samples: preset.samples.map((sample) => sample.id === editingSample.id ? editingSample : sample),
      }
      const checked = patchLegacyIniText(sourceIniText, nextPreset)
      transport.stop()
      setPlaybackTarget(null)
      setPreset({ ...checked.preset, sampleVolume: sourceControlDefaultsRef.current.sampleVolume, beatVolume: sourceControlDefaultsRef.current.beatVolume })
      setFixture(null)
      setOmittedZeroDurationCount(0)
      setActionError(null)
      setSaveIniError(null)
      setEditingSample(null)
      setTransportNote('Sample settings saved in this session. Generate a fresh combo to use them.')
    } catch (error) {
      setSaveIniError('Could not save sample changes: ' + describeError(error))
    }
  }

  const handleSaveSampleData = async () => {
    if (!sourceIniText || isSavingIni || editingSample) return
    const saveGeneration = presetImportGeneration.current
    setIsSavingIni(true)
    setSaveIniError(null)
    try {
      const workingIni = patchLegacyIniText(sourceIniText, { ...preset, sampleVolume, beatVolume })
      const originalName = presetFileName ?? 'Working-preset.ini'
      const basename = originalName.replace(/\.ini$/i, '') || 'Working-preset'
      const suggestedName = basename + '-edited.ini'
      const picker = (window as IniSavePickerWindow).showSaveFilePicker
      let savedName = suggestedName
      if (picker) {
        const handle = await picker.call(window, {
          suggestedName,
          types: [{ description: 'INI preset', accept: { 'text/plain': ['.ini'] } }],
        })
        if (saveGeneration !== presetImportGeneration.current) return
        savedName = handle.name
        const writable = await handle.createWritable()
        if (saveGeneration !== presetImportGeneration.current) {
          await writable.abort?.()
          return
        }
        try {
          await writable.write(workingIni.text)
          if (saveGeneration !== presetImportGeneration.current) {
            await writable.abort?.()
            return
          }
          await writable.close()
        } catch (error) {
          await writable.abort?.()
          throw error
        }
        if (saveGeneration !== presetImportGeneration.current) return
      } else {
        const url = URL.createObjectURL(new Blob([workingIni.text], { type: 'text/plain;charset=utf-8' }))
        const link = document.createElement('a')
        link.href = url
        link.download = suggestedName
        link.style.display = 'none'
        document.body.append(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      if (saveGeneration !== presetImportGeneration.current) return
      setSourceIniText(workingIni.text)
      setPreset({ ...workingIni.preset, sampleVolume: sourceControlDefaultsRef.current.sampleVolume, beatVolume: sourceControlDefaultsRef.current.beatVolume })
      setImportMessage('Working preset copy saved as ' + savedName + '. The selected source file was not changed.')
      setTransportNote('Sample data saved to working copy ' + savedName + '.')
    } catch (error) {
      if (saveGeneration !== presetImportGeneration.current) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSaveIniError('Could not save the working INI copy: ' + describeError(error))
    } finally {
      if (saveGeneration === presetImportGeneration.current) setIsSavingIni(false)
    }
  }

  const handleBuildPreview = () => {
    if (!isPresetReady || isReadingPreset || isGenerating) return
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setFixture(null)
    setOmittedZeroDurationCount(0)
    setIsGenerating(true)
    try {
      if (!presetFileName) {
        const nextFixture = buildPreviewFixture(preset, TARGET_UNITS)
        setFixture(nextFixture)
        setTimebase('demo')
        setTransportNote('Fixed demo preview built. Ready to play.')
      } else {
        const requestedRawTicks = comboBeats * LEGACY_TICKS_PER_BEAT
        const generated = legacyFixtureFor(preset, requestedRawTicks)
        setFixture(generated.fixture)
        setTimebase('legacy')
        setOmittedZeroDurationCount(generated.zeroDurationCount)
        const generationNotes = [
          generated.remainingRawTicks > 0 ? generated.remainingRawTicks + ' trailing legacy ticks of rest.' : '',
          generated.zeroDurationCount > 0 ? generated.zeroDurationCount + ' zero-length ' + (generated.zeroDurationCount === 1 ? 'selection was' : 'selections were') + ' omitted from audio preview.' : '',
        ].filter(Boolean)
        setTransportNote('Combo generated. ' + (generationNotes.length ? generationNotes.join(' ') + ' ' : '') + 'Ready to play.')
      }
    } catch (error) {
      setActionError((presetFileName ? 'Could not generate the combo: ' : 'Could not build the preview: ') + describeError(error))
      setTransportNote(presetFileName ? 'Combo generation needs attention.' : 'Preview could not be built.')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleComboLengthChange = (value: string) => {
    const nextBeats = Number(value)
    if (!COMBO_BEAT_OPTIONS.includes(nextBeats as (typeof COMBO_BEAT_OPTIONS)[number])) return
    transport.stop()
    setPlaybackTarget(null)
    setFixture(null)
    setOmittedZeroDurationCount(0)
    setActionError(null)
    setComboBeats(nextBeats)
    setTransportNote('Combo length changed. Generate a new combo to continue.')
  }

  const handlePracticeModeChange = (mode: PracticeMode) => {
    if (mode === practiceMode) return
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setPracticeMode(mode)
    setTransportNote(mode === 'loop' ? 'Loop mode selected. The combo will play every cycle.' : 'Q&A mode selected. The combo will alternate with a silent practice pause.')
  }

  const handleLargePauseChange = (enabled: boolean) => {
    if (enabled === largePause) return
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setLargePause(enabled)
    setTransportNote(enabled ? 'Large pause enabled. One audio cycle is followed by three silent cycles.' : 'Large pause disabled. One audio cycle is followed by one silent cycle.')
  }

  const startPlayback = (playFixture: Fixture, target: PlaybackTarget, includeBeat: boolean) => {
    if (!isPresetReady || isReadingPreset || isGenerating) return
    const bpmValue = Number(bpm)
    const minBpm = Math.max(1, preset.bpm * 0.5)
    const maxBpm = Math.max(minBpm, preset.bpm * 2)
    if (!Number.isFinite(bpmValue) || bpmValue < minBpm || bpmValue > maxBpm) {
      setActionError('BPM must stay between ' + minBpm + ' and ' + maxBpm + ' for this preset.')
      setTransportNote('Playback needs a valid BPM value.')
      return
    }
    setActionError(null)
    setPlaybackTarget(target)
    const options = {
      referenceBpm: preset.bpm,
      bpm: bpmValue,
      pitchSemitones,
      unitsPerBeat: timebase === 'legacy' ? LEGACY_TICKS_PER_BEAT : 4,
      assets: sampleAssets,
      sampleVolume,
      beatVolume,
      ...(includeBeat && selectedBeatFile ? { beatFile: selectedBeatFile } : {}),
    }
    if (target?.kind === 'sequence' && presetFileName) {
      void transport.playCyclePlan({
        ...options,
        slots: cycleSlotsFor(playFixture, practiceMode, largePause),
      })
    } else {
      const playOptions: PlayOptions = { ...options, fixture: playFixture }
      void transport.play(playOptions)
    }
  }

  const handleSamplePreview = (sample: SampleDefinition) => {
    if (!isPresetReady || isReadingPreset || isGenerating) return
    if (sample.silent) {
      setActionError(sample.name + ' is marked silent and has no audio preview.')
      return
    }
    const resolution = resolutionForSample(sample, assetResolution)
    if (!SYNTHETIC_SAMPLE_IDS.has(sample.id) && (resolution?.status !== 'resolved' || !resolution.file)) {
      setActionError('Cannot preview ' + sample.name + ' yet. Choose its WAV file or resolve the file warning above.')
      setTransportNote('Sample preview needs a local WAV file.')
      return
    }
    const durationUnits = Math.max(1, sample.durationUnits)
    const sampleFixture: Fixture = {
      events: [{ id: 'sample-preview', sampleId: sample.id, startUnits: 0, durationUnits, silent: false }],
      totalUnits: durationUnits,
    }
    startPlayback(sampleFixture, { kind: 'sample', sampleId: sample.id, name: sample.name }, false)
  }

  const handlePlaySequence = () => {
    if (!fixture || !isPresetReady) return
    if (presetFileName) {
      const unresolvedNames = [...new Set(fixture.events
        .filter((item) => !item.silent && !SYNTHETIC_SAMPLE_IDS.has(item.sampleId))
        .filter((item) => {
          const resolution = assetResolution?.samplesById.get(item.sampleId)
          return resolution?.status !== 'resolved' || !resolution.file
        })
        .map((item) => preset.samples.find((sample) => sample.id === item.sampleId)?.name ?? item.sampleId))]
      if (unresolvedNames.length > 0) {
        const names = unresolvedNames.join(', ')
        setActionError('This combo uses WAV files that are not ready: ' + names + '. Choose the matching local files, then generate a fresh combo.')
        setTransportNote('Playback needs the WAV files for the selected samples.')
        return
      }
    }
    startPlayback(fixture, { kind: 'sequence' }, true)
  }
  const handleStop = () => {
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setTransportNote('Playback stopped.')
  }

  const playDisabled = transportSnapshot.status === 'disposed' || !isPresetReady || !fixture || isReadingPreset || isGenerating
  const stopDisabled = transportSnapshot.status !== 'playing' && transportSnapshot.status !== 'loading'
  const isSequencePlaying = playbackTarget?.kind === 'sequence' && transportSnapshot.status === 'playing'
  const progressPercent = transportSnapshot.status === 'completed' ? 1 : Math.max(0, Math.min(1, transportSnapshot.progress))
  const timelineProgressPercent = isSequencePlaying && transportSnapshot.cycleSlotKind
    ? (progressPercent * cycleSlotCount) % 1
    : progressPercent
  const isImportedPreset = presetFileName !== null
  const comboLengthTicks = comboBeats * LEGACY_TICKS_PER_BEAT
  const activeBuiltInEntry = builtInCatalog?.presets.find((entry) => entry.id === selectedPresetId)
  const activeWavCount = presetSource === 'builtin' ? assetIndex.files.length : localWavFiles.length

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <aside className="rail" aria-label="Workspace navigation">
        <a className="rail__brand" href="#sequence-section" aria-label="Scratch Combo sequence"><span aria-hidden="true">SC</span></a>
        <nav className="rail__nav" aria-label="Workspace sections">
          <a href="#sequence-section" aria-current={activeSection === 'sequence' ? 'location' : undefined} onClick={() => setActiveSection('sequence')}><span className="rail__marker" aria-hidden="true" /><span>Sequence</span></a>
          <a href="#files-section" aria-current={activeSection === 'files' ? 'location' : undefined} onClick={() => setActiveSection('files')}><span className="rail__marker" aria-hidden="true" /><span>Files</span></a>
          <a href="#session-section" aria-current={activeSection === 'session' ? 'location' : undefined} onClick={() => setActiveSection('session')}><span className="rail__marker" aria-hidden="true" /><span>Session</span></a>
          <a href="#sample-section" aria-current={activeSection === 'samples' ? 'location' : undefined} onClick={() => setActiveSection('samples')}><span className="rail__marker" aria-hidden="true" /><span>Samples</span></a>
        </nav>
        <span className="rail__foot" title="Local browser session">LOCAL</span>
      </aside>

      <main className="workspace" id="workspace">
        <header className="workspace-header">
          <div><h1>Scratch Combo</h1><p>Practice workspace</p></div>
          <div className="session-state"><span className="session-state__dot" aria-hidden="true" /><span>Private browser session</span></div>
        </header>

        <section id="sequence-section" className="workspace-section sequence-section" aria-labelledby="sequence-heading">
          <div className="section-heading sequence-heading">
            <div><h2 id="sequence-heading">{!isPresetReady ? 'Starting workspace' : isImportedPreset ? 'Generated combo' : 'Sequence preview'}</h2><p>{isPresetReady ? preset.name + ' / ' + (isImportedPreset ? (fixture ? fixture.totalUnits : comboLengthTicks) + ' legacy ticks' : 'fixed ' + TARGET_UNITS + '-unit window') : activeBuiltInEntry?.label ?? 'Built-in practice preset'}{fixture && omittedZeroDurationCount > 0 && <small className="sequence-note">{omittedZeroDurationCount} zero-length {omittedZeroDurationCount === 1 ? 'selection was' : 'selections were'} omitted from audio preview.</small>}</p></div>
            <div className="sequence-actions">
              {isImportedPreset && (
                <label className="combo-length-control" htmlFor="combo-length">
                  <span>Combo length</span>
                  <select id="combo-length" value={comboBeats} onChange={(event) => handleComboLengthChange(event.currentTarget.value)} disabled={!isPresetReady || isReadingPreset || isGenerating}>
                    {COMBO_BEAT_OPTIONS.map((beats) => <option key={beats} value={beats}>{beats} Beats</option>)}
                  </select>
                </label>
              )}
              <button className="button button--primary" type="button" onClick={handleBuildPreview} disabled={!isPresetReady || isReadingPreset || isGenerating}>
                {isGenerating ? 'Generating…' : isImportedPreset ? 'Generate combo' : 'Build preview'}
              </button>
            </div>
          </div>
          {isImportedPreset && (
            <PracticeCycleControls
              mode={practiceMode}
              largePause={largePause}
              disabled={isReadingPreset || isGenerating}
              onModeChange={handlePracticeModeChange}
              onLargePauseChange={handleLargePauseChange}
            />
          )}
          {fixture
            ? <SequenceTimeline
                fixture={fixture}
                preset={preset}
                progress={timelineProgressPercent}
                isPlaying={isSequencePlaying}
                auditionedSampleId={playbackTarget?.kind === 'sample' ? playbackTarget.sampleId : null}
                timebase={timebase}
              />
            : <div className="sequence-empty" role="status" aria-live="polite">
                <strong>{isBootstrapLoading ? 'Loading built-in preset' : isReadingPreset ? 'Reading preset' : !isPresetReady ? 'Preset is not ready' : isImportedPreset ? 'Generate a combo to preview the sequence' : 'Build a preview to see the sequence'}</strong>
                <span>{isBootstrapLoading ? 'The selected INI and every referenced WAV must load before playback is enabled.' : isReadingPreset ? 'The previous sequence was cleared while the local file is read.' : !isPresetReady ? 'Retry the built-in preset or choose a valid custom INI in Local files.' : isImportedPreset ? comboBeats + ' beats · ' + comboLengthTicks + ' legacy ticks' : 'The fixed demo uses synthetic sounds.'}</span>
              </div>}
          <div className="transport-row">
            <div className="transport-actions">
              <button className="button button--play" type="button" onClick={handlePlaySequence} disabled={playDisabled || isReadingPreset}>
                <span className="play-glyph" aria-hidden="true" />Play sequence
              </button>
              <button className="button button--stop" type="button" onClick={handleStop} disabled={stopDisabled}>
                <span className="stop-glyph" aria-hidden="true" />Stop
              </button>
              <details className="preview-help">
                <summary>About this preview</summary>
                {isImportedPreset
                  ? <p>Selection follows the recovered weighted, direction, and repeat rules. This browser uses quantized 24-bit random draws; the original VB6 time-seeded sequence is not reproduced. Playback follows the exact BPM clock in Web Audio, not Windows timer intervals or their jitter.</p>
                  : <p>Fixed preview; legacy generator not recovered. This ordered fixture fills a 32-unit window for practice and transport review.</p>}
              </details>
            </div>
            <div className="transport-meter">
              <progress value={progressPercent} max="1" aria-label="Preview progress" />
              <span className="transport-status" role="status" aria-live="polite" aria-atomic="true">{transportNote}</span>
            </div>
          </div>
          {actionError && <p className="inline-error" role="alert">{actionError}</p>}
          {transportSnapshot.status === 'error' && <p className="inline-error" role="alert">{transportSnapshot.error ?? 'Audio could not start.'}</p>}
        </section>

        <LocalImportPanel
          presetFileName={presetFileName}
          localFileCount={activeWavCount}
          importMessage={importMessage}
          presetError={presetError}
          selectionError={selectionError}
          builtInCatalog={builtInCatalog}
          selectedPresetId={selectedPresetId}
          presetSource={presetSource}
          isBootstrapLoading={isBootstrapLoading}
          bootstrapError={bootstrapError}
          onBuiltInPresetChange={handleBuiltInPresetChange}
          onRetryBuiltIn={handleRetryBuiltIn}
          onPresetChange={handlePresetChange}
          onFolderChange={handleWavChange}
          onFilesChange={handleWavChange}
        />
        {assetResolution && <DiagnosticList diagnostics={diagnostics} />}

        <SessionControls
          bpm={bpm}
          referenceBpm={preset.bpm}
          pitchSemitones={pitchSemitones}
          sampleVolume={sampleVolume}
          beatVolume={beatVolume}
          beatFiles={preset.beatFiles}
          beatResolutions={assetResolution?.beats}
          selectedBeatIndex={selectedBeatIndex}
          disabled={!isPresetReady || isReadingPreset || isGenerating || isSavingIni}
          onBpmChange={handleBpmChange}
          onPitchChange={handlePitchChange}
          onSampleVolumeChange={handleSampleVolumeChange}
          onBeatVolumeChange={handleBeatVolumeChange}
          onBeatSelectionChange={handleBeatSelectionChange}
          onReset={handleResetSessionControls}
        />

        {isPresetReady
          ? <SampleTable
              preset={preset}
              resolution={assetResolution}
              actionsDisabled={isReadingPreset || isGenerating || isSavingIni}
              legacyMode={isImportedPreset}
              sourceAvailable={sourceIniText !== null}
              editingSample={editingSample}
              saveError={saveIniError}
              isSavingData={isSavingIni}
              onToggle={handleToggle}
              onPreview={handleSamplePreview}
              onEdit={handleEditSample}
              onDraftChange={handleSampleDraftChange}
              onSaveEdit={handleSaveSampleEdit}
              onCancelEdit={() => { setEditingSample(null); setSaveIniError(null) }}
              onSaveData={() => { void handleSaveSampleData() }}
            />
          : <section id="sample-section" className="workspace-section sample-section" aria-labelledby="samples-heading"><div className="section-heading"><div><h2 id="samples-heading">Sample settings</h2><p>Sample rows appear after the selected preset and its files are ready.</p></div></div></section>}

        <footer className="workspace-footer">
          <span>Files remain on this device for the current session.</span>
          <span>Nothing is written back to the selected INI or WAV files.</span>
        </footer>
      </main>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">{importMessage}</span>
    </div>
  )
}
