import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type InputHTMLAttributes,
} from 'react'
import { analyzeLocalAudioFile, AudioTransport, type CyclePlanOptions, type CycleSlot, type PlayOptions } from './audio'
import { getTempoRange, SessionControls, type CustomBeatAnalysisStatus } from './SessionControls'
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
import {
  getTtmGuide, suggestedGuideForSampleName, ttmMotionSvgPath,
  UNTRANSCRIBED, TTM_GUIDES,
  type TtmSampleGuideSelection,
} from './notation/ttm-guides'
import {
  loadWaveform, timelineUnitsToSeconds, waveformDisplayGeometry,
  WAVEFORM_VIEWBOX_HEIGHT, type WaveformData,
} from './waveforms/waveform'
import { sampleColorForName } from './waveforms/sample-color'

const TARGET_UNITS = 32
const DEFAULT_COMBO_BEATS = 8
const COMBO_BEAT_OPTIONS = [4, 8, 16, 32] as const
const AUTO_GENERATE_ROUND_OPTIONS = [1, 2, 4, 8] as const
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
type TimelineView = 'waveform' | 'ttm'
type TimelineLayout = 'grid' | 'inline'
type WorkspaceSection = 'sequence' | 'files' | 'session' | 'samples'
type PresetSource = 'loading' | 'builtin' | 'custom' | 'demo'
type CustomBeatCandidate = { file: File; buffer: AudioBuffer | null }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeBpmDetection(fileName: string, detection: {
  status: 'detected' | 'ambiguous' | 'insufficient'
  bpm?: number
  alternatives?: readonly number[]
  candidates?: readonly number[]
  reason?: string
}): string {
  if (detection.status === 'detected') {
    const alternatives = detection.alternatives?.length
      ? ' Other possible tempos: ' + detection.alternatives.join(', ') + ' BPM.'
      : ''
    return fileName + ': estimated ' + detection.bpm + ' BPM. Check for half or double time before applying.' + alternatives
  }
  if (detection.status === 'ambiguous') {
    const candidates = detection.candidates?.length ? ' Possible tempos: ' + detection.candidates.join(', ') + ' BPM.' : ''
    return fileName + ': the pulse is ambiguous. Choose the recorded BPM manually.' + candidates
  }
  const reason = detection.reason === 'too-short'
    ? 'The beat is too short for a useful estimate.'
    : detection.reason === 'silence'
      ? 'No clear rhythmic pulse was found.'
      : detection.reason === 'invalid-audio'
        ? 'The audio could not provide a usable BPM estimate.'
        : 'A reliable periodic tempo could not be estimated.'
  return fileName + ': ' + reason + ' Enter the BPM recorded with the beat.'
}

function initialPracticeTempo(scratchReferenceBpm: number, beatReferenceBpm?: number | null): number {
  const range = getTempoRange(scratchReferenceBpm, beatReferenceBpm)
  if (!range) return scratchReferenceBpm
  const preferred = beatReferenceBpm ?? scratchReferenceBpm
  return Math.min(range.max, Math.max(range.min, preferred))
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

type TimelineGuideState = 'suggested' | 'assigned' | 'unassigned' | 'untranscribed'

function eventAtTimelinePosition(fixture: Fixture, positionUnits: number): Fixture['events'][number] | null {
  if (!Number.isFinite(positionUnits) || positionUnits < 0) return null
  return fixture.events.find((event) => (
    !event.silent
    && event.sampleId !== REST_SAMPLE_ID
    && positionUnits >= event.startUnits
    && positionUnits < event.startUnits + event.durationUnits
  )) ?? null
}

function timelineGuideForSample(
  sampleId: string,
  sampleName: string,
  annotations: Readonly<Record<string, TtmSampleGuideSelection>>,
): { guide: ReturnType<typeof getTtmGuide>; state: TimelineGuideState } {
  if (Object.hasOwn(annotations, sampleId)) {
    const selected = annotations[sampleId]!
    if (typeof selected === 'string') return { guide: getTtmGuide(selected), state: 'assigned' }
    return { guide: null, state: 'untranscribed' }
  }

  const suggestion = suggestedGuideForSampleName(sampleName)
  return suggestion
    ? { guide: getTtmGuide(suggestion), state: 'suggested' }
    : { guide: null, state: 'unassigned' }
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

function LocalImportPanel({
  presetFileName, localFileCount, importMessage, presetError, selectionError,
  builtInCatalog, selectedPresetId, presetSource, isBootstrapLoading, bootstrapError,
  locked, onBuiltInPresetChange, onRetryBuiltIn, onPresetChange, onFolderChange, onFilesChange,
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
  locked: boolean
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
          disabled={locked || isBootstrapLoading}
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
        <LocalFilePicker inputId="preset-file" label="Choose INI preset" description="One .ini file" accept=".ini,text/plain" disabled={locked} onChange={onPresetChange} />
        <LocalFilePicker inputId="audio-folder" label="Choose audio folder" description="Folder picker for WAV files" accept={WAV_ACCEPT} directory disabled={locked} onChange={onFolderChange} />
        <LocalFilePicker inputId="audio-files" label="Choose WAV files" description="Multi-file fallback" accept={WAV_ACCEPT} multiple disabled={locked} onChange={onFilesChange} />
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
      {bootstrapError && <div className="inline-error" role="alert"><p>{bootstrapError}</p><button className="button button--small" type="button" disabled={locked} onClick={onRetryBuiltIn}>Retry built-in preset</button></div>}
      {presetError && <p className="inline-error" role="alert">{presetError}</p>}
      {selectionError && <p className="inline-error inline-error--quiet" role="status">{selectionError}</p>}
    </section>
  )
}

function PracticeCycleControls({
  mode, largePause, disabled, autoGenerate, autoGenerateRounds, autoGenerateHint,
  onModeChange, onLargePauseChange, onAutoGenerateChange, onAutoGenerateRoundsChange,
}: {
  mode: PracticeMode
  largePause: boolean
  disabled: boolean
  autoGenerate: boolean
  autoGenerateRounds: number
  autoGenerateHint: string
  onModeChange: (mode: PracticeMode) => void
  onLargePauseChange: (enabled: boolean) => void
  onAutoGenerateChange: (enabled: boolean) => void
  onAutoGenerateRoundsChange: (rounds: number) => void
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
      <div className="auto-generation-controls">
        <label className="auto-generate-toggle">
          <input type="checkbox" checked={autoGenerate} disabled={disabled} onChange={(event) => onAutoGenerateChange(event.currentTarget.checked)} />
          <span className="auto-generate-copy"><strong>Auto-generate</strong><small>Prepare a fresh combo after complete practice rounds.</small></span>
        </label>
        <label className="auto-generation-rounds" htmlFor="auto-generation-rounds">
          <span>New combo every</span>
          <select id="auto-generation-rounds" aria-label="New combo every" value={autoGenerateRounds} disabled={disabled || !autoGenerate} onChange={(event) => onAutoGenerateRoundsChange(Number(event.currentTarget.value))}>
            {AUTO_GENERATE_ROUND_OPTIONS.map((rounds) => <option key={rounds} value={rounds}>{rounds}</option>)}
          </select>
          <span>{autoGenerateRounds === 1 ? 'round' : 'rounds'}</span>
        </label>
        <p id="auto-generation-help" className="auto-generation-help" role="status" aria-live="polite">{autoGenerateHint}</p>
      </div>
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
  fixture, preset, assets, progress, isPlaying, presentationStarted, presentationPositionUnits, presentationCycleSlotKind,
  presentationCyclePlanIndex, activeSampleId, activeEventId, auditionedSampleId, timebase, view: requestedView, layout, ttmDebugEnabled, ttmAnnotations, onViewChange, onLayoutChange,
}: {
  fixture: Fixture
  preset: Preset
  assets: ReadonlyMap<string, File>
  progress: number
  isPlaying: boolean
  presentationStarted: boolean
  presentationPositionUnits: number | null
  presentationCycleSlotKind: CycleSlot['kind'] | undefined
  presentationCyclePlanIndex: number | undefined
  activeSampleId: string | null
  activeEventId: string | null
  auditionedSampleId: string | null
  timebase: 'demo' | 'legacy'
  view: TimelineView
  layout: TimelineLayout
  ttmDebugEnabled: boolean
  ttmAnnotations: Readonly<Record<string, TtmSampleGuideSelection>>
  onViewChange: (view: TimelineView) => void
  onLayoutChange: (layout: TimelineLayout) => void
}) {
  const [waveforms, setWaveforms] = useState<ReadonlyMap<string, WaveformData>>(() => new Map())
  const waveformGeneration = useRef(0)
  const totalUnits = Math.max(fixture.totalUnits, 1)
  const minBoardWidth = Math.max(
    TIMELINE_MIN_BOARD_WIDTH,
    TIMELINE_LABEL_COLUMN_WIDTH + totalUnits * TIMELINE_MIN_TICK_WIDTH + TIMELINE_BOARD_HORIZONTAL_PADDING,
  )
  const unitsPerBeat = timebase === 'legacy' ? LEGACY_TICKS_PER_BEAT : 4
  const unitsPerBar = unitsPerBeat * 4
  const unitDescription = timebase === 'legacy' ? 'legacy ticks' : 'sixteenth units'
  const view: TimelineView = ttmDebugEnabled ? requestedView : 'waveform'
  const handleViewChange = (nextView: TimelineView) => {
    if (!ttmDebugEnabled && nextView === 'ttm') return
    onViewChange(nextView)
  }

  useEffect(() => {
    const generation = waveformGeneration.current + 1
    waveformGeneration.current = generation
    let cancelled = false
    setWaveforms(new Map())

    const filesBySample = new Map<string, File>()
    for (const event of fixture.events) {
      if (event.silent || event.sampleId === REST_SAMPLE_ID || SYNTHETIC_SAMPLE_IDS.has(event.sampleId)) continue
      if (filesBySample.has(event.sampleId)) continue
      const file = assets.get(event.sampleId)
      if (file) filesBySample.set(event.sampleId, file)
    }

    const candidates = Array.from(filesBySample)
    let nextCandidate = 0
    const worker = async () => {
      while (!cancelled && waveformGeneration.current === generation) {
        const candidate = candidates[nextCandidate]
        nextCandidate += 1
        if (!candidate) return
        const [sampleId, file] = candidate
        const waveform = await loadWaveform(file)
        if (cancelled || waveformGeneration.current !== generation) return
        if (waveform) {
          setWaveforms((current) => {
            if (cancelled || waveformGeneration.current !== generation) return current
            const next = new Map(current)
            next.set(sampleId, waveform)
            return next
          })
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, candidates.length) }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [assets, fixture])

  const unitNumbers = Array.from({ length: totalUnits }, (_, index) => index)
  const bars = Array.from({ length: Math.ceil(totalUnits / unitsPerBar) }, (_, index) => {
    const unitsInBar = Math.min(unitsPerBar, totalUnits - index * unitsPerBar)
    return <span className="timeline-bar-label" key={index} style={{ width: (unitsInBar / totalUnits) * 100 + '%' }}>Bar {index + 1}</span>
  })
  const activeSampleIds = new Set(fixture.events.map((event) => event.sampleId))
  const lanes: Array<{ id: string; name: string; note: string; color: string | null }> = preset.samples.filter((sample) => activeSampleIds.has(sample.id)).map((sample) => {
    if (view === 'ttm' && !sample.silent) {
      const resolution = timelineGuideForSample(sample.id, sample.name, ttmAnnotations)
      const note = resolution.state === 'suggested'
        ? 'Suggested: ' + resolution.guide?.label
        : resolution.state === 'assigned'
          ? 'Guide: ' + (resolution.guide?.label ?? 'Unassigned')
          : resolution.state === 'untranscribed' ? 'Untranscribed' : 'Unassigned'
      return { id: sample.id, name: sample.name, note, color: sample.silent ? null : sampleColorForName(sample.name) }
    }
    return {
      id: sample.id,
      name: sample.name,
      note: sample.silent ? 'silent' : sample.durationUnits + (timebase === 'legacy' ? ' ticks' : ' units'),
      color: sample.silent ? null : sampleColorForName(sample.name),
    }
  })
  if (fixture.events.some((event) => event.sampleId === REST_SAMPLE_ID)) {
    lanes.push({ id: REST_SAMPLE_ID, name: 'Rest', note: 'unused time', color: null })
  }
  for (const event of fixture.events) {
    if (!lanes.some((lane) => lane.id === event.sampleId)) {
      lanes.push({ id: event.sampleId, name: event.sampleId, note: 'event', color: event.silent ? null : sampleColorForName(event.sampleId) })
    }
  }
  const eventDescription = fixture.events.map((event, index) => {
    const sample = preset.samples.find((candidate) => candidate.id === event.sampleId)
    const name = event.sampleId === REST_SAMPLE_ID ? 'Rest' : sample?.name ?? event.sampleId
    const startLabel = timebase === 'legacy' ? 'legacy tick ' : 'sixteenth unit '
    const durationLabel = timebase === 'legacy' ? ' legacy ticks' : ' units'
    const guideResolution = sample && !event.silent
      ? timelineGuideForSample(event.sampleId, sample.name, ttmAnnotations)
      : null
    const guideDescription = view === 'ttm' && !event.silent
      ? guideResolution?.guide
        ? (guideResolution.state === 'suggested' ? ', suggested illustrative TTM guide: ' : ', illustrative TTM guide: ')
          + guideResolution.guide.label + ', not an audio transcription'
        : guideResolution?.state === 'unassigned' ? ', TTM guide: Unassigned (Untranscribed)' : ', TTM guide: Untranscribed'
      : ''
    return <li key={event.id}>Event {index + 1}: {name}, starts at {startLabel}{event.startUnits + 1}, lasts {event.durationUnits}{durationLabel}{event.silent ? ', silent' : ''}{event.id === activeEventId ? ', now playing' : ''}{guideDescription}</li>
  })
  const renderSequenceEvent = (event: Fixture['events'][number], inline = false) => {
    const waveform = event.silent ? undefined : waveforms.get(event.sampleId)
    const sample = preset.samples.find((candidate) => candidate.id === event.sampleId)
    const name = event.sampleId === REST_SAMPLE_ID ? 'Rest' : sample?.name ?? event.sampleId
    const guideResolution = !event.silent
      ? timelineGuideForSample(event.sampleId, sample?.name ?? event.sampleId, ttmAnnotations)
      : null
    const guide = guideResolution?.guide ?? null
    const sampleColor = event.silent ? null : sampleColorForName(sample?.name ?? event.sampleId)
    const active = event.id === activeEventId
    const slotDurationSeconds = timelineUnitsToSeconds(event.durationUnits, preset.bpm, unitsPerBeat)
    const geometry = waveform && slotDurationSeconds
      ? waveformDisplayGeometry(waveform.durationSeconds, slotDurationSeconds, waveform.peaks.length)
      : null
    const waveformClass = view === 'waveform' && waveform && geometry ? ' sequence-event--waveform' : ''
    const guideClass = view === 'ttm' && !event.silent
      ? guide ? ' sequence-event--ttm-guide' : ' sequence-event--ttm-' + guideResolution?.state
      : ''
    const sampleColorClass = sampleColor ? ' sequence-event--colored' : ''
    const inlineClass = inline ? ' sequence-event--inline' : ''
    const activeClass = active ? ' sequence-event--active' : ''
    const guideDescription = guide
      ? (guideResolution?.state === 'suggested' ? ' Suggested illustrative TTM guide: ' : ' Illustrative TTM guide: ')
        + guide.label + '; not an audio transcription.'
      : guideResolution?.state === 'unassigned'
        ? ' TTM guide is unassigned (Untranscribed).'
        : guideResolution?.state === 'untranscribed' ? ' TTM guide is explicitly set to Untranscribed.' : ''

    return (
      <span
        key={event.id}
        data-event-id={event.id}
        data-active={active ? 'true' : undefined}
        className={'sequence-event' + (event.silent ? ' sequence-event--silent' : '') + sampleColorClass + waveformClass + guideClass + inlineClass + activeClass}
        style={{ ...(sampleColor ? { '--sample-color': sampleColor } : {}), left: (event.startUnits / totalUnits) * 100 + '%', width: (event.durationUnits / totalUnits) * 100 + '%' } as CSSProperties}
        title={event.silent ? name + ': silent event' : (active ? 'Now playing · ' : '') + name + ': ' + event.durationUnits + ' units' + guideDescription}
      >
        {inline && <span className="sequence-inline-event-label">{active ? 'Now playing · ' : ''}{name}</span>}
        {view === 'waveform' && waveform && geometry && (
          <svg
            className="sequence-waveform"
            aria-hidden="true"
            preserveAspectRatio="none"
            viewBox={'0 0 ' + geometry.viewBoxWidth + ' ' + WAVEFORM_VIEWBOX_HEIGHT}
            style={{ width: geometry.widthPercent + '%' }}
          >
            <line x1="0" y1={WAVEFORM_VIEWBOX_HEIGHT / 2} x2={waveform.peaks.length} y2={WAVEFORM_VIEWBOX_HEIGHT / 2} />
            <path d={waveform.path} />
          </svg>
        )}
        {view === 'ttm' && guide && (
          <>
            <svg className="sequence-ttm-motion" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
              <path d={ttmMotionSvgPath(guide.motion)} />
            </svg>
            <span className="sequence-ttm-fader" aria-hidden="true">
              {guide.faderIntervals.map((interval, index) => (
                <span
                  className={'sequence-ttm-fader__interval sequence-ttm-fader__interval--' + interval.state}
                  key={guide.id + '-fader-' + index}
                  style={{ left: interval.start * 100 + '%', width: (interval.end - interval.start) * 100 + '%' }}
                />
              ))}
            </span>
          </>
        )}
        {view === 'ttm' && !event.silent && !guide && (
          <span className="sequence-ttm-placeholder-mark" aria-hidden="true">
            {guideResolution?.state === 'untranscribed' ? '—' : '?'}
          </span>
        )}
      </span>
    )
  }

  return (
    <figure className="timeline-figure" aria-labelledby="timeline-caption">
      <figcaption id="timeline-caption" className="timeline-caption">
        <span>
          <strong>Sequence timeline</strong>
          <span>{fixture.totalUnits} {unitDescription} across {Math.ceil(fixture.totalUnits / unitsPerBar)} bars</span>
        </span>
        <fieldset className="timeline-layout-control" aria-label="Timeline layout">
          <legend>Layout</legend>
          <label><input type="radio" name="timeline-layout" value="grid" checked={layout === 'grid'} onChange={() => onLayoutChange('grid')} />Grid</label>
          <label><input type="radio" name="timeline-layout" value="inline" checked={layout === 'inline'} onChange={() => onLayoutChange('inline')} />Inline</label>
        </fieldset>
        <fieldset className="timeline-view-control" aria-label="Timeline view">
          <legend>View</legend>
          <label><input type="radio" name="timeline-view" value="waveform" checked={view === 'waveform'} onChange={() => handleViewChange('waveform')} />Waveform</label>
          <label className={ttmDebugEnabled ? undefined : 'timeline-view-option--disabled'}><input type="radio" name="timeline-view" value="ttm" checked={view === 'ttm'} disabled={!ttmDebugEnabled} aria-describedby={ttmDebugEnabled ? undefined : 'ttm-local-debug-note'} onChange={() => handleViewChange('ttm')} />TTM practice guides</label>
          {!ttmDebugEnabled && <small className="timeline-debug-note" id="ttm-local-debug-note">Local debug only</small>}
        </fieldset>
        <span className="timing-readout">{fixture.events.length} events</span>
      </figcaption>
      <div
        className="timeline-scroll"
        role="img"
        tabIndex={0}
        aria-label={'Sequence timeline: ' + fixture.totalUnits + ' ' + unitDescription + ', ' + fixture.events.length + ' events'}
        data-presentation-started={presentationStarted ? 'true' : 'false'}
        data-presentation-position-units={presentationPositionUnits === null ? undefined : String(presentationPositionUnits)}
        data-cycle-slot-kind={presentationCycleSlotKind}
        data-cycle-plan-index={presentationCyclePlanIndex}
      >
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
          {layout === 'grid' && lanes.map((lane) => {
            const events = fixture.events.filter((event) => event.sampleId === lane.id)
            return (
              <div className={'timeline-lane' + (lane.id === auditionedSampleId ? ' timeline-lane--auditioned' : '') + (lane.id === activeSampleId ? ' timeline-lane--active' : '')} key={lane.id} style={lane.color ? { '--sample-color': lane.color } as CSSProperties : undefined}>
                <span className={view === 'ttm' ? 'timeline-lane-label timeline-lane-label--ttm' : 'timeline-lane-label'}>
                  <span className="timeline-lane-name"><span className={lane.color ? 'timeline-color-swatch' : 'timeline-color-swatch timeline-color-swatch--silent'} aria-hidden="true" /><span className="timeline-lane-name-text">{lane.name}</span></span>
                  <small>{lane.note}</small>
                  {lane.id === activeSampleId && <span className="timeline-now-playing">Now playing</span>}
                </span>
                <span className="timeline-track" aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                  {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                  {events.map((event) => renderSequenceEvent(event))}
                  {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
                </span>
              </div>
            )
          })}
          {layout === 'inline' && (
            <div className="timeline-inline-row">
              <span className="timeline-axis-label">EVENT</span>
              <span className="timeline-track timeline-track--inline" aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                {fixture.events.map((event) => renderSequenceEvent(event, true))}
                {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
              </span>
            </div>
          )}
        </div>
      </div>
      {view === 'ttm' && <p className="timeline-guide-note">TTM practice guides are illustrative examples, not WAV transcriptions. Exact Baby/Baby(F)/Baby(R) labels only suggest a guide; unassigned rows are marked. <a href="#sample-section">Edit a sample</a> to assign another guide or choose Untranscribed. Record motion: forward ↑, backward ↓; the bottom strip shows the fader open or closed.</p>}
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
  sample, draft, disabled, ttmDebugEnabled, ttmGuide, ttmGuideIsExplicit, onDraftChange, onTtmGuideChange, onSave, onCancel,
}: {
  sample: SampleDefinition
  draft: SampleDefinition
  disabled: boolean
  ttmDebugEnabled: boolean
  ttmGuide: TtmSampleGuideSelection
  ttmGuideIsExplicit: boolean
  onDraftChange: (next: SampleDefinition) => void
  onTtmGuideChange: (selection: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const durationRef = useRef<HTMLInputElement>(null)
  useEffect(() => { durationRef.current?.focus() }, [sample.id])
  const numericValue = (value: number) => Number.isFinite(value) ? value : ''
  const setNumeric = (field: 'durationUnits' | 'weight' | 'maxRepeat', raw: string) => {
    onDraftChange({ ...draft, [field]: raw === '' ? Number.NaN : Number(raw) })
  }
  const suggestedGuide = suggestedGuideForSampleName(sample.name)
  const selectedGuideId = typeof ttmGuide === 'string'
    ? ttmGuide
    : !ttmGuideIsExplicit && suggestedGuide ? suggestedGuide : UNTRANSCRIBED.kind
  const guideHelperText = !ttmGuideIsExplicit && suggestedGuide
    ? 'Suggested from the exact sample label only: ' + TTM_GUIDES[suggestedGuide].label + '. Choose a guide or Untranscribed; no audio is analyzed.'
    : !ttmGuideIsExplicit
      ? 'No guide is assigned. Choose an illustrative guide or leave this sample Untranscribed.'
      : typeof ttmGuide !== 'string'
        ? 'Explicitly Untranscribed for this session. Choose a guide to add an illustrative pattern.'
        : 'Session-only illustrative guide; this does not change audio or INI data.'
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
        {ttmDebugEnabled && <label className="sample-editor__field sample-editor__field--guide" htmlFor="sample-ttm-guide">
          <span>TTM guide</span>
          <select id="sample-ttm-guide" aria-label={'TTM guide for ' + sample.name} value={selectedGuideId} disabled={disabled} onChange={(event) => onTtmGuideChange(event.currentTarget.value)}>
            <option value={UNTRANSCRIBED.kind}>{!ttmGuideIsExplicit && !suggestedGuide ? 'Unassigned · Untranscribed' : 'Untranscribed'}</option>
            {Object.values(TTM_GUIDES).map((guide) => <option key={guide.id} value={guide.id}>{!ttmGuideIsExplicit && suggestedGuide === guide.id ? 'Suggested: ' : ''}{guide.label}</option>)}
          </select>
          <small>{guideHelperText}</small>
        </label>}
      </div>
      <div className="sample-editor__actions">
        <button className="button button--small" type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
        <button className="button button--small button--primary" type="submit" disabled={disabled}>Save sample changes</button>
      </div>
    </form>
  )
}

function SampleTable({
  preset, resolution, actionsDisabled, legacyMode, sourceAvailable, editingSample, saveError, isSavingData, ttmDebugEnabled,
  ttmAnnotations, onTtmGuideChange, onToggle, onPreview, onEdit, onDraftChange, onSaveEdit, onCancelEdit, onSaveData,
}: {
  preset: Preset
  resolution: PresetAssetResolution | undefined
  actionsDisabled: boolean
  legacyMode: boolean
  sourceAvailable: boolean
  editingSample: SampleDefinition | null
  saveError: string | null
  isSavingData: boolean
  ttmDebugEnabled: boolean
  ttmAnnotations: Readonly<Record<string, TtmSampleGuideSelection>>
  onTtmGuideChange: (sampleId: string, selection: string) => void
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
      {editingSample && <SampleEditor
        sample={preset.samples.find((sample) => sample.id === editingSample.id) ?? editingSample}
        draft={editingSample}
        disabled={actionsDisabled}
        ttmDebugEnabled={ttmDebugEnabled}
        ttmGuide={ttmAnnotations[editingSample.id] ?? UNTRANSCRIBED}
        ttmGuideIsExplicit={Object.hasOwn(ttmAnnotations, editingSample.id)}
        onDraftChange={onDraftChange}
        onTtmGuideChange={(selection) => { if (ttmDebugEnabled) onTtmGuideChange(editingSample.id, selection) }}
        onSave={onSaveEdit}
        onCancel={onCancelEdit}
      />}
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
  const ttmDebugEnabled = import.meta.env.DEV
  const [transport] = useState(() => new AudioTransport())
  const transportSnapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot, transport.getSnapshot)
  const presentation = transportSnapshot.presentation
  const presentationCycleSlotKind = presentation?.cycleSlotKind
  const presentationCycleSlotIndex = presentation?.cycleSlotIndex
  const presentationCycleIteration = presentation?.cycleIteration
  const presentationCyclePlanIndex = presentation?.cyclePlanIndex
  const isPlaybackLocked = transportSnapshot.status === 'loading' || transportSnapshot.status === 'playing'
  const isPlaybackLockedNow = () => {
    const status = transport.getSnapshot().status
    return status === 'loading' || status === 'playing'
  }
  const [preset, setPreset] = useState<Preset>(DEMO_PRESET)
  const [fixture, setFixture] = useState<Fixture | null>(null)
  const [visibleCyclePlanIndex, setVisibleCyclePlanIndex] = useState<number | null>(null)
  const [timebase, setTimebase] = useState<'demo' | 'legacy'>('demo')
  const [timelineView, setTimelineView] = useState<TimelineView>('waveform')
  const [timelineLayout, setTimelineLayout] = useState<TimelineLayout>('grid')
  const [ttmAnnotations, setTtmAnnotations] = useState<Record<string, TtmSampleGuideSelection>>({})
  const [comboBeats, setComboBeats] = useState<number>(DEFAULT_COMBO_BEATS)
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('qa')
  const [largePause, setLargePause] = useState(false)
  const [autoGenerate, setAutoGenerate] = useState(false)
  const [autoGenerateRounds, setAutoGenerateRounds] = useState<number>(2)
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
  const [customBeatFile, setCustomBeatFile] = useState<File | null>(null)
  const [customBeatBuffer, setCustomBeatBuffer] = useState<AudioBuffer | null>(null)
  const [customBeatSelected, setCustomBeatSelected] = useState(false)
  const [customBeatReferenceBpm, setCustomBeatReferenceBpm] = useState<number | null>(null)
  const [customBeatReferenceBpmInput, setCustomBeatReferenceBpmInput] = useState('')
  const [customBeatCandidate, setCustomBeatCandidate] = useState<CustomBeatCandidate | null>(null)
  const [customBeatCandidateBpm, setCustomBeatCandidateBpm] = useState('')
  const [customBeatAnalysisStatus, setCustomBeatAnalysisStatus] = useState<CustomBeatAnalysisStatus>('idle')
  const [customBeatAnalysisMessage, setCustomBeatAnalysisMessage] = useState('')
  const [playbackTarget, setPlaybackTarget] = useState<PlaybackTarget>(null)
  const [transportNote, setTransportNote] = useState('Ready to play.')
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('sequence')

  const assetIndexRef = useRef(assetIndex)
  const presetImportGeneration = useRef(0)
  const presetSourceRef = useRef<PresetSource>('loading')
  const activePresetLoadRef = useRef<AbortController | undefined>(undefined)
  const builtInCatalogRef = useRef<BuiltInPresetCatalog | undefined>(undefined)
  const customWavFilesRef = useRef<File[]>([])
  const customBeatAnalysisGeneration = useRef(0)
  const lifecycleGeneration = useRef(0)
  const autoGenerateGeneration = useRef(0)
  const sourceControlDefaultsRef = useRef({
    bpm: DEMO_PRESET.bpm,
    sampleVolume: DEMO_PRESET.sampleVolume,
    beatVolume: DEMO_PRESET.beatVolume,
  })
  const sampleAssets = useMemo(() => assetMapFor(assetResolution), [assetResolution])
  const selectedBeatResolution = selectedBeatIndex === 'none' ? undefined : assetResolution?.beats[Number(selectedBeatIndex)]
  const selectedBeatFile = customBeatSelected
    ? undefined
    : selectedBeatResolution?.status === 'resolved' ? selectedBeatResolution.file : undefined
  const selectedBeatReferenceBpm = customBeatSelected ? customBeatReferenceBpm : null
  const selectedTempoRange = getTempoRange(preset.bpm, selectedBeatReferenceBpm)
  const isCustomBeatAnalysisBusy = customBeatAnalysisStatus === 'analyzing'
  const customBeatReferenceInputNumber = Number(customBeatReferenceBpmInput)
  const customBeatReferenceInputValid = !customBeatSelected
    || (Number.isFinite(customBeatReferenceInputNumber) && customBeatReferenceInputNumber >= 1)
  const sessionTempoNumber = Number(bpm)
  const sessionTempoValid = selectedTempoRange !== null
    && Number.isFinite(sessionTempoNumber)
    && sessionTempoNumber >= selectedTempoRange.min
    && sessionTempoNumber <= selectedTempoRange.max
  const diagnostics = assetResolution?.diagnostics ?? []
  const autoGenerateSampleIds = preset.samples
    .filter((sample) => sample.enabled && !sample.silent && sample.weight > 0)
    .map((sample) => sample.id)
  const autoGenerateMissingSampleNames = autoGenerateSampleIds
    .filter((sampleId) => !sampleAssets.has(sampleId))
    .map((sampleId) => preset.samples.find((sample) => sample.id === sampleId)?.name ?? sampleId)
  const autoGenerateBlocked = autoGenerate && autoGenerateMissingSampleNames.length > 0
  const practiceRoundDescription = practiceMode === 'loop'
    ? 'One round is one complete Loop pass.'
    : 'One round is the question plus its full answer window (' + (largePause ? '3 silent cycles' : '1 silent cycle') + ').'
  const autoGenerateHint = !autoGenerate
    ? 'Off. ' + practiceRoundDescription + ' Turn it on to prepare a new combo after ' + autoGenerateRounds + ' ' + (autoGenerateRounds === 1 ? 'round.' : 'rounds.')
    : autoGenerateMissingSampleNames.length > 0
      ? 'Resolve local WAV files for every enabled, non-silent sample with positive weight: ' + autoGenerateMissingSampleNames.join(', ') + '.'
      : autoGenerateSampleIds.length === 0
        ? practiceRoundDescription + ' No audible samples need preloading; the preset’s silent-sample rules still apply.'
        : practiceRoundDescription + ' The next combo starts after ' + autoGenerateRounds + ' ' + (autoGenerateRounds === 1 ? 'round.' : 'rounds.')
  const cycleSlotCount = playbackTarget?.kind === 'sequence' && presetFileName
    ? practiceMode === 'loop' ? 1 : largePause ? 4 : 2
    : 1

  const invalidateAutoGeneration = () => {
    autoGenerateGeneration.current += 1
  }

  const resetAutoGeneration = () => {
    invalidateAutoGeneration()
    setAutoGenerate(false)
  }

  const startBuiltInPresetLoad = (presetId: string) => {
    resetAutoGeneration()
    setTtmAnnotations({})
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
        setBpm(String(initialPracticeTempo(loaded.preset.bpm, customBeatSelected ? customBeatReferenceBpm : null)))
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
    resetAutoGeneration()
    setTtmAnnotations({})
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
    setBpm(String(initialPracticeTempo(DEMO_PRESET.bpm, customBeatSelected ? customBeatReferenceBpm : null)))
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
    resetAutoGeneration()
    setTtmAnnotations({})
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
      autoGenerateGeneration.current += 1
      if (event.persisted) transport.stop()
      else transport.dispose()
    }
    window.addEventListener('pagehide', stopOnPageHide)
    return () => {
      window.removeEventListener('pagehide', stopOnPageHide)
      customBeatAnalysisGeneration.current += 1
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
      } else if (playbackTarget?.kind === 'sequence' && presentationCycleSlotKind) {
        const iteration = presentationCycleIteration ?? 1
        const slotIndex = presentationCycleSlotIndex ?? 0
        const cycleNumber = ((iteration - 1) * cycleSlotCount) + slotIndex + 1
        const planPrefix = presentationCyclePlanIndex === undefined
          ? ''
          : 'Auto-generate · combo ' + presentationCyclePlanIndex + ' · '
        if (practiceMode === 'loop') {
          setTransportNote(planPrefix + 'Loop · combo cycle ' + cycleNumber + '.')
        } else {
          setTransportNote(planPrefix + (presentationCycleSlotKind === 'fixture'
            ? 'Q&A · question playback · cycle ' + cycleNumber + '.'
            : 'Q&A · answer pause · cycle ' + cycleNumber + '.'))
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
  }, [transportSnapshot.status, transportSnapshot.error, presentationCycleSlotKind, presentationCycleSlotIndex, presentationCycleIteration, presentationCyclePlanIndex, playbackTarget, practiceMode, cycleSlotCount])

  const handlePresetChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || isPlaybackLockedNow()) return

    const generation = ++presetImportGeneration.current
    resetAutoGeneration()
    setTtmAnnotations({})
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
        setBpm(String(initialPracticeTempo(nextPreset.bpm, customBeatSelected ? customBeatReferenceBpm : null)))
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
    if (chosenFiles.length === 0 || isPlaybackLockedNow()) return

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
      invalidateAutoGeneration()
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
    if (isPlaybackLockedNow()) return
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
    if (isPlaybackLockedNow()) return
    startBuiltInPresetLoad(selectedPresetId === 'demo' || selectedPresetId === 'custom'
      ? DEFAULT_BUILTIN_PRESET_ID
      : selectedPresetId)
  }

  const handleCustomBeatFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file || isPlaybackLockedNow() || isCustomBeatAnalysisBusy) return

    const generation = ++customBeatAnalysisGeneration.current
    setCustomBeatCandidate({ file, buffer: null })
    setCustomBeatCandidateBpm('')
    setCustomBeatAnalysisStatus('analyzing')
    setCustomBeatAnalysisMessage('Analyzing ' + file.name + ' locally. Your current beat stays selected until you apply this file.')
    setActionError(null)
    setTransportNote('Analyzing the custom beat locally. Playback is paused until its BPM is ready for review.')

    void (async () => {
      let context: AudioContext | undefined
      try {
        context = new AudioContext()
        const analysis = await analyzeLocalAudioFile(context, file)
        if (generation !== customBeatAnalysisGeneration.current) return
        setCustomBeatCandidate({ file, buffer: analysis.buffer })
        setCustomBeatAnalysisStatus(analysis.detection.status)
        setCustomBeatCandidateBpm(analysis.detection.status === 'detected' ? String(analysis.detection.bpm) : '')
        setCustomBeatAnalysisMessage(describeBpmDetection(file.name, analysis.detection))
        setTransportNote('Beat analysis ready for review. Check the recorded BPM and apply the beat when ready.')
      } catch (error) {
        if (generation !== customBeatAnalysisGeneration.current) return
        setCustomBeatCandidate({ file, buffer: null })
        setCustomBeatAnalysisStatus('error')
        setCustomBeatAnalysisMessage('Could not analyze ' + file.name + ': ' + describeError(error) + ' Your current beat remains selected. Choose a WAV or MP3 file that can be read locally.')
        setTransportNote('The custom beat could not be analyzed. Your current beat is still selected.')
      } finally {
        if (context && context.state !== 'closed') {
          await context.close().catch(() => undefined)
        }
      }
    })()
  }

  const handleUseCustomBeat = () => {
    if (isPlaybackLockedNow() || isCustomBeatAnalysisBusy || !customBeatCandidate?.buffer) return
    const referenceBpm = Number(customBeatCandidateBpm)
    const tempoRange = getTempoRange(preset.bpm, referenceBpm)
    if (!Number.isFinite(referenceBpm) || referenceBpm < 1 || !tempoRange) return

    const practiceTempo = Math.min(tempoRange.max, Math.max(tempoRange.min, referenceBpm))
    setCustomBeatFile(customBeatCandidate.file)
    setCustomBeatBuffer(customBeatCandidate.buffer)
    setCustomBeatSelected(true)
    setCustomBeatReferenceBpm(referenceBpm)
    setCustomBeatReferenceBpmInput(String(referenceBpm))
    setBpm(String(practiceTempo))
    setCustomBeatCandidate(null)
    setCustomBeatCandidateBpm('')
    setCustomBeatAnalysisStatus('idle')
    setCustomBeatAnalysisMessage('')
    setActionError(null)
    setTransportNote(
      'Custom beat selected at a recorded ' + referenceBpm + ' BPM. Practice tempo set to ' + practiceTempo + ' BPM. Playback has not started.'
      + (practiceTempo !== referenceBpm ? ' The selected tempo is clamped to the supported range for both sources.' : ''),
    )
  }

  const handleBpmChange = (value: string) => {
    setBpm(value)
    const nextBpm = Number(value)
    if (selectedTempoRange && Number.isFinite(nextBpm) && nextBpm >= selectedTempoRange.min && nextBpm <= selectedTempoRange.max) {
      if (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading') transport.setTempo(nextBpm)
      setActionError(null)
    }
  }

  const handleCustomBeatReferenceBpmChange = (value: string) => {
    setCustomBeatReferenceBpmInput(value)
    const nextReferenceBpm = Number(value)
    if (!Number.isFinite(nextReferenceBpm) || nextReferenceBpm < 1) return

    setCustomBeatReferenceBpm(nextReferenceBpm)
    const nextRange = getTempoRange(preset.bpm, nextReferenceBpm)
    const currentTempo = Number(bpm)
    if (!nextRange) {
      setTransportNote('The custom beat and scratch preset have no shared playback range. Correct the beat BPM or choose a different beat.')
      return
    }

    if (Number.isFinite(currentTempo) && (currentTempo < nextRange.min || currentTempo > nextRange.max)) {
      const clampedTempo = Math.min(nextRange.max, Math.max(nextRange.min, currentTempo))
      setBpm(String(clampedTempo))
      setTransportNote('Tempo moved to ' + clampedTempo + ' BPM, the nearest value supported by both recorded sources.')
    } else {
      setTransportNote('Custom beat recorded BPM corrected to ' + nextReferenceBpm + '. Both layers continue to follow the Tempo setting.')
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
    const customRange = customBeatSelected && customBeatReferenceBpm !== null
      ? getTempoRange(preset.bpm, customBeatReferenceBpm)
      : null
    const resetBpmValue = customRange
      ? Math.min(customRange.max, Math.max(customRange.min, customBeatReferenceBpm ?? defaults.bpm))
      : defaults.bpm
    const resetBpm = String(resetBpmValue)
    setBpm(resetBpm)
    setPitchSemitones(0)
    setSampleVolume(defaults.sampleVolume)
    setBeatVolume(defaults.beatVolume)
    if (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading') transport.setTempo(resetBpmValue)
    transport.setPitchSemitones(0)
    transport.setSampleVolume(defaults.sampleVolume)
    transport.setBeatVolume(defaults.beatVolume)
    setActionError(null)
    setTransportNote(customRange
      ? 'Controls reset. Practice tempo is ' + resetBpmValue + ' BPM for the selected custom beat. Playback continues.'
      : 'Controls reset to the selected preset defaults. Playback continues.')
  }

  const handleBeatSelectionChange = (value: string) => {
    if (isPlaybackLockedNow() || isCustomBeatAnalysisBusy) return
    if (value === 'custom') {
      if (!customBeatFile || !customBeatBuffer || customBeatReferenceBpm === null) return
      const range = getTempoRange(preset.bpm, customBeatReferenceBpm)
      if (!range) return
      const target = Math.min(range.max, Math.max(range.min, customBeatReferenceBpm))
      setCustomBeatSelected(true)
      setBpm(String(target))
      setActionError(null)
      setTransportNote('Custom beat selected. Practice tempo set to ' + target + ' BPM; playback has not started.')
      return
    }
    if (value === selectedBeatIndex && !customBeatSelected) return
    const range = getTempoRange(preset.bpm)
    const currentTempo = Number(bpm)
    if (range && Number.isFinite(currentTempo)) {
      const target = Math.min(range.max, Math.max(range.min, currentTempo))
      if (target !== currentTempo) setBpm(String(target))
    }
    setSelectedBeatIndex(value)
    setCustomBeatSelected(false)
    setActionError(null)
    setTransportNote(value === 'none' ? 'No beat bed selected.' : 'Built-in beat selected. Playback has not started.')
  }

  const handleTtmGuideChange = (sampleId: string, selection: string) => {
    if (!import.meta.env.DEV || isPlaybackLockedNow()) return
    const nextSelection: TtmSampleGuideSelection = selection === UNTRANSCRIBED.kind
      ? UNTRANSCRIBED
      : getTtmGuide(selection)?.id ?? UNTRANSCRIBED
    setTtmAnnotations((current) => ({ ...current, [sampleId]: nextSelection }))
  }

  const handleToggle = (sample: SampleDefinition, enabled: boolean) => {
    if (sample.silent || isPlaybackLockedNow()) return
    invalidateAutoGeneration()
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
    if (isPlaybackLockedNow()) return
    setSaveIniError(null)
    setEditingSample({ ...sample })
  }

  const handleSampleDraftChange = (sample: SampleDefinition) => {
    if (isPlaybackLockedNow()) return
    setEditingSample(sample)
  }

  const handleSaveSampleEdit = () => {
    if (!sourceIniText || !editingSample || isPlaybackLockedNow()) return
    try {
      const nextPreset: Preset = {
        ...preset,
        sampleVolume,
        beatVolume,
        samples: preset.samples.map((sample) => sample.id === editingSample.id ? editingSample : sample),
      }
      const checked = patchLegacyIniText(sourceIniText, nextPreset)
      invalidateAutoGeneration()
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
    if (!sourceIniText || isSavingIni || editingSample || isPlaybackLockedNow()) return
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
    if (!isPresetReady || isReadingPreset || isGenerating || isPlaybackLockedNow()) return
    invalidateAutoGeneration()
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
    if (isPlaybackLockedNow() || !COMBO_BEAT_OPTIONS.includes(nextBeats as (typeof COMBO_BEAT_OPTIONS)[number])) return
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setFixture(null)
    setOmittedZeroDurationCount(0)
    setActionError(null)
    setComboBeats(nextBeats)
    setTransportNote('Combo length changed. Generate a new combo to continue.')
  }

  const handlePracticeModeChange = (mode: PracticeMode) => {
    if (isPlaybackLockedNow() || mode === practiceMode) return
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setPracticeMode(mode)
    setTransportNote(mode === 'loop' ? 'Loop mode selected. The combo will play every cycle.' : 'Q&A mode selected. The combo will alternate with a silent practice pause.')
  }

  const handleLargePauseChange = (enabled: boolean) => {
    if (isPlaybackLockedNow() || enabled === largePause) return
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setLargePause(enabled)
    setTransportNote(enabled ? 'Large pause enabled. One audio cycle is followed by three silent cycles.' : 'Large pause disabled. One audio cycle is followed by one silent cycle.')
  }

  const handleAutoGenerateChange = (enabled: boolean) => {
    if (isPlaybackLockedNow() || enabled === autoGenerate) return
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setAutoGenerate(enabled)
    setTransportNote(enabled ? 'Auto-generate enabled. Play the sequence to start.' : 'Auto-generate disabled. The current combo will keep repeating until stopped.')
  }

  const handleAutoGenerateRoundsChange = (rounds: number) => {
    if (isPlaybackLockedNow() || !AUTO_GENERATE_ROUND_OPTIONS.includes(rounds as (typeof AUTO_GENERATE_ROUND_OPTIONS)[number])) return
    if (rounds === autoGenerateRounds) return
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setActionError(null)
    setAutoGenerateRounds(rounds)
    setTransportNote('Auto-generate will prepare a new combo after ' + rounds + ' complete practice ' + (rounds === 1 ? 'round.' : 'rounds.'))
  }

  const startPlayback = (playFixture: Fixture, target: PlaybackTarget, includeBeat: boolean) => {
    if (!isPresetReady || isReadingPreset || isGenerating || isCustomBeatAnalysisBusy || isPlaybackLockedNow()) return
    const bpmValue = Number(bpm)
    const beatReferenceBpm = includeBeat && customBeatSelected ? customBeatReferenceBpm : null
    const tempoRange = getTempoRange(preset.bpm, beatReferenceBpm)
    if (includeBeat && customBeatSelected && (!customBeatReferenceInputValid || !customBeatBuffer)) {
      setActionError('Enter a valid recorded BPM for the custom beat before playback.')
      setTransportNote('Playback needs a valid custom beat BPM.')
      return
    }
    if (!tempoRange || !Number.isFinite(bpmValue) || bpmValue < tempoRange.min || bpmValue > tempoRange.max) {
      const rangeText = tempoRange ? tempoRange.min + '–' + tempoRange.max : 'no shared'
      setActionError('Tempo must stay within ' + rangeText + ' BPM for the selected audio sources.')
      setTransportNote('Playback needs a valid BPM value.')
      return
    }
    invalidateAutoGeneration()
    setActionError(null)
    setPlaybackTarget(target)
    setVisibleCyclePlanIndex(null)
    const options = {
      referenceBpm: preset.bpm,
      bpm: bpmValue,
      pitchSemitones,
      unitsPerBeat: timebase === 'legacy' ? LEGACY_TICKS_PER_BEAT : 4,
      assets: sampleAssets,
      sampleVolume,
      beatVolume,
      ...(includeBeat && selectedBeatFile ? { beatFile: selectedBeatFile } : {}),
      ...(includeBeat && customBeatSelected && customBeatBuffer && beatReferenceBpm !== null
        ? { beatBuffer: customBeatBuffer, beatReferenceBpm }
        : {}),
    }
    if (target?.kind === 'sequence' && presetFileName) {
      if (autoGenerate) {
        const generation = autoGenerateGeneration.current
        const generatedByPlan = new Map<number, ReturnType<typeof legacyFixtureFor>>()
        const nextPlan: NonNullable<CyclePlanOptions['nextPlan']> = ({ nextPlanIndex }) => {
          if (autoGenerateGeneration.current !== generation) {
            throw new Error('This Auto-generate run was replaced before the next combo was ready.')
          }
          const generated = legacyFixtureFor(preset, comboBeats * LEGACY_TICKS_PER_BEAT)
          generatedByPlan.set(nextPlanIndex, generated)
          return { slots: cycleSlotsFor(generated.fixture, practiceMode, largePause) }
        }
        const onPlanBoundary: NonNullable<CyclePlanOptions['onPlanBoundary']> = (boundary) => {
          if (autoGenerateGeneration.current !== generation) return
          const activeFixture = boundary.plan.slots.find((slot) => slot.kind === 'fixture')
          if (!activeFixture || activeFixture.kind !== 'fixture') return
          setVisibleCyclePlanIndex(boundary.planIndex)
          setFixture(activeFixture.fixture)
          const generated = generatedByPlan.get(boundary.planIndex)
          if (generated) {
            setOmittedZeroDurationCount(generated.zeroDurationCount)
            generatedByPlan.delete(boundary.planIndex)
          }
        }
        const cyclePlanOptions: CyclePlanOptions = {
          ...options,
          slots: cycleSlotsFor(playFixture, practiceMode, largePause),
          cyclesPerPlan: autoGenerateRounds,
          nextPlan,
          onPlanBoundary,
          preloadSampleIds: autoGenerateSampleIds,
        }
        setVisibleCyclePlanIndex(1)
        void transport.playCyclePlan(cyclePlanOptions)
        return
      }
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
    if (!isPresetReady || isReadingPreset || isGenerating || isPlaybackLockedNow()) return
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
    if (!fixture || !isPresetReady || isCustomBeatAnalysisBusy || isPlaybackLockedNow()) return
    if (autoGenerateBlocked) {
      const message = 'Auto-generate needs local WAV files for: ' + autoGenerateMissingSampleNames.join(', ') + '.'
      setActionError(message)
      setTransportNote('Auto-generate cannot preload every eligible sample yet.')
      return
    }
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
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setVisibleCyclePlanIndex(null)
    setActionError(null)
    setTransportNote('Playback stopped.')
  }

  const playDisabled = transportSnapshot.status === 'disposed' || !isPresetReady || !fixture || isReadingPreset || isGenerating || isCustomBeatAnalysisBusy || isPlaybackLocked || autoGenerateBlocked || !customBeatReferenceInputValid || !sessionTempoValid
  const stopDisabled = transportSnapshot.status !== 'playing' && transportSnapshot.status !== 'loading'
  const isSequencePlaying = playbackTarget?.kind === 'sequence' && transportSnapshot.status === 'playing'
  const displayedProgress = transportSnapshot.status === 'playing' ? presentation?.progress : undefined
  const progressPercent = transportSnapshot.status === 'completed'
    ? 1
    : Math.max(0, Math.min(1, displayedProgress ?? transportSnapshot.progress))
  const timelineProgressPercent = presentation?.started && fixture
    ? Math.max(0, Math.min(1, presentation.positionUnits / Math.max(fixture.totalUnits, 1)))
    : progressPercent
  const visibleFixturePlanMatches = visibleCyclePlanIndex === null
    ? presentationCyclePlanIndex === undefined
    : presentationCyclePlanIndex === visibleCyclePlanIndex
  const timelineIsPlaying = isSequencePlaying && Boolean(presentation?.started) && visibleFixturePlanMatches
  const activeSequenceEvent = isSequencePlaying
    && presentation?.started
    && presentationCycleSlotKind !== 'silence'
    && visibleFixturePlanMatches
    && fixture
    ? eventAtTimelinePosition(fixture, presentation.positionUnits)
    : null
  const activeSequenceSampleId = activeSequenceEvent?.sampleId ?? null
  const timelinePresentationStarted = Boolean(isSequencePlaying && presentation?.started && visibleFixturePlanMatches)
  const presentationPositionUnits = timelinePresentationStarted && presentation ? presentation.positionUnits : null
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
                  <select id="combo-length" value={comboBeats} onChange={(event) => handleComboLengthChange(event.currentTarget.value)} disabled={!isPresetReady || isReadingPreset || isGenerating || isPlaybackLocked}>
                    {COMBO_BEAT_OPTIONS.map((beats) => <option key={beats} value={beats}>{beats} Beats</option>)}
                  </select>
                </label>
              )}
              <button className="button button--primary" type="button" onClick={handleBuildPreview} disabled={!isPresetReady || isReadingPreset || isGenerating || isPlaybackLocked}>
                {isGenerating ? 'Generating…' : isImportedPreset ? 'Generate combo' : 'Build preview'}
              </button>
            </div>
          </div>
          {isImportedPreset && (
            <PracticeCycleControls
              mode={practiceMode}
              largePause={largePause}
              disabled={isReadingPreset || isGenerating || isPlaybackLocked}
              autoGenerate={autoGenerate}
              autoGenerateRounds={autoGenerateRounds}
              autoGenerateHint={autoGenerateHint}
              onModeChange={handlePracticeModeChange}
              onLargePauseChange={handleLargePauseChange}
              onAutoGenerateChange={handleAutoGenerateChange}
              onAutoGenerateRoundsChange={handleAutoGenerateRoundsChange}
            />
          )}
          {isPlaybackLocked && <p className="playback-lock-note" role="status">Stop playback to change combo options or sample settings.</p>}
          {isCustomBeatAnalysisBusy && <p className="playback-lock-note" role="status">Custom beat is loading locally. Playback will stay stopped until analysis finishes.</p>}
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
          {fixture
            ? <SequenceTimeline
                fixture={fixture}
                preset={preset}
                assets={sampleAssets}
                progress={timelineProgressPercent}
                isPlaying={timelineIsPlaying}
                presentationStarted={timelinePresentationStarted}
                presentationPositionUnits={presentationPositionUnits}
                presentationCycleSlotKind={isSequencePlaying && visibleFixturePlanMatches ? presentationCycleSlotKind : undefined}
                presentationCyclePlanIndex={isSequencePlaying && visibleFixturePlanMatches ? presentationCyclePlanIndex : undefined}
                activeSampleId={activeSequenceSampleId}
                activeEventId={activeSequenceEvent?.id ?? null}
                auditionedSampleId={playbackTarget?.kind === 'sample' ? playbackTarget.sampleId : null}
                timebase={timebase}
                view={timelineView}
                layout={timelineLayout}
                ttmDebugEnabled={ttmDebugEnabled}
                ttmAnnotations={ttmAnnotations}
                onViewChange={setTimelineView}
                onLayoutChange={setTimelineLayout}
              />
            : <div className="sequence-empty" role="status" aria-live="polite">
                <strong>{isBootstrapLoading ? 'Loading built-in preset' : isReadingPreset ? 'Reading preset' : !isPresetReady ? 'Preset is not ready' : isImportedPreset ? 'Generate a combo to preview the sequence' : 'Build a preview to see the sequence'}</strong>
                <span>{isBootstrapLoading ? 'The selected INI and every referenced WAV must load before playback is enabled.' : isReadingPreset ? 'The previous sequence was cleared while the local file is read.' : !isPresetReady ? 'Retry the built-in preset or choose a valid custom INI in Local files.' : isImportedPreset ? comboBeats + ' beats · ' + comboLengthTicks + ' legacy ticks' : 'The fixed demo uses synthetic sounds.'}</span>
              </div>}
        </section>

        <LocalImportPanel
          locked={isPlaybackLocked}
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
          customBeatFileName={customBeatFile?.name ?? null}
          customBeatSelected={customBeatSelected}
          customBeatReferenceBpm={customBeatReferenceBpm}
          customBeatReferenceBpmInput={customBeatReferenceBpmInput}
          customBeatAnalysisStatus={customBeatAnalysisStatus}
          customBeatCandidateFileName={customBeatCandidate?.file.name ?? null}
          customBeatCandidateBpm={customBeatCandidateBpm}
          customBeatCandidateMessage={customBeatAnalysisMessage}
          customBeatCandidateReady={Boolean(customBeatCandidate?.buffer)}
          disabled={!isPresetReady || isReadingPreset || isGenerating || isSavingIni || isCustomBeatAnalysisBusy}
          beatSelectionDisabled={isPlaybackLocked || isCustomBeatAnalysisBusy}
          onBpmChange={handleBpmChange}
          onPitchChange={handlePitchChange}
          onSampleVolumeChange={handleSampleVolumeChange}
          onBeatVolumeChange={handleBeatVolumeChange}
          onBeatSelectionChange={handleBeatSelectionChange}
          onCustomBeatFileChange={handleCustomBeatFileChange}
          onCustomBeatCandidateBpmChange={setCustomBeatCandidateBpm}
          onUseCustomBeat={handleUseCustomBeat}
          onCustomBeatReferenceBpmChange={handleCustomBeatReferenceBpmChange}
          onReset={handleResetSessionControls}
        />

        {isPresetReady
          ? <SampleTable
              preset={preset}
              resolution={assetResolution}
              actionsDisabled={isReadingPreset || isGenerating || isSavingIni || isPlaybackLocked}
              legacyMode={isImportedPreset}
              sourceAvailable={sourceIniText !== null}
              editingSample={editingSample}
              ttmDebugEnabled={ttmDebugEnabled}
              ttmAnnotations={ttmAnnotations}
              saveError={saveIniError}
              isSavingData={isSavingIni}
              onToggle={handleToggle}
              onTtmGuideChange={handleTtmGuideChange}
              onPreview={handleSamplePreview}
              onEdit={handleEditSample}
              onDraftChange={handleSampleDraftChange}
              onSaveEdit={handleSaveSampleEdit}
              onCancelEdit={() => { if (!isPlaybackLockedNow()) { setEditingSample(null); setSaveIniError(null) } }}
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
