import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  analyzeLocalAudioFile, AudioTransport, LocalWavSnapshotError, snapshotReferencedWavFiles,
  type CyclePlanOptions, type CycleSlot, type PlayOptions, type SnapshotFileValidation,
} from './audio'
import { PracticePrepControls, type CountInBars } from './PracticePrepControls'
import { getTempoRange, SessionControls, type CustomBeatAnalysisStatus } from './SessionControls'
import {
  DEFAULT_TEMPO_TRAINING_SETTINGS,
  isValidTempoTrainingSettings,
  tempoTrainingValidationMessage,
  type TempoTrainingSettings,
} from './tempo-training'
import { PracticeLibrary } from './PracticeLibrary'
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
import {
  customBeatTrimKey, deleteSavedRecord, listSavedRecords, loadSavedRecord, presetBeatTrimKey,
  saveSavedRecord, SessionLibraryError,
  type SavedBeatTrimRegion, type SavedLibraryIndex, type SavedMedia, type SavedRecordSummary, type SavedSessionData,
} from './session-library/storage'

const TARGET_UNITS = 32
const DEFAULT_COMBO_BEATS = 8
const COMBO_BEAT_OPTIONS = [4, 8, 16, 32] as const
const AUTO_GENERATE_ROUND_OPTIONS = [1, 2, 4, 8] as const
const LEGACY_TICKS_PER_BEAT = 16
const SYNTHETIC_SAMPLE_IDS = new Set(['synthPulse', 'synthBrush', 'synthSilence'])
const WAV_ACCEPT = '.wav,audio/wav,audio/x-wav'
const MAX_LOCAL_INI_BYTES = 1024 * 1024
const MAX_SELECTED_AUDIO_FILE_COUNT = 10_000
const MAX_LOCAL_IMPORT_REFERENCES = 512
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
type ImportWizardStep = 1 | 2 | 3
type ImportReferenceCheck = {
  subject: 'sample' | 'beat'
  id: string
  requested: string
  required: boolean
  resolution: AssetResolution
  validation: SnapshotFileValidation | null
}
type PreparedLocalImport = {
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

const WORKSPACE_TABS: ReadonlyArray<{ section: WorkspaceSection; label: string; href: string; id: string }> = [
  { section: 'sequence', label: 'Practice', href: '#sequence-section', id: 'tab-practice' },
  { section: 'session', label: 'Session', href: '#session-section', id: 'tab-session' },
  { section: 'samples', label: 'Samples', href: '#sample-section', id: 'tab-samples' },
  { section: 'files', label: 'Files', href: '#files-section', id: 'tab-files' },
]

function WorkspaceSectionIcon({ section }: { section: WorkspaceSection }) {
  return (
    <svg className="rail__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {section === 'sequence' && <>
        <path d="M3 5h14M3 10h14M3 15h14" />
        <path d="M6.5 3.5v3M11.5 8.5v3M15.5 13.5v3" />
      </>}
      {section === 'session' && <>
        <path d="M5 3v14M10 3v14M15 3v14" />
        <circle cx="5" cy="7" r="1.8" />
        <circle cx="10" cy="12" r="1.8" />
        <circle cx="15" cy="6" r="1.8" />
      </>}
      {section === 'samples' && <path d="M2.5 10h2l1.6-4.5 2.2 9 2.3-10 2.1 9 1.8-4.5 1.5 1h1.5" />}
      {section === 'files' && <path d="M2.5 6V4.3h5l1.7 1.8h8.3v9.6H2.5z" />}
    </svg>
  )
}

function workspaceSectionForHash(hash: string): WorkspaceSection | null {
  const target = hash.replace(/^#/, '')
  if (!target || target === 'workspace' || target === 'sequence-section' || target === 'sequence-heading' || target === 'timeline-caption') return 'sequence'
  if (target === 'session-section' || target === 'settings-heading') return 'session'
  if (target === 'sample-section' || target === 'samples-heading') return 'samples'
  if (target === 'files-section' || target === 'import-heading' || target === 'preset-file') return 'files'
  return null
}

function isSingleKeyShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || Boolean(target.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [role="combobox"], [role="switch"], [role="dialog"]',
  ))
}

function KeyboardShortcutsDialog({
  open,
  shortcutsEnabled,
  onToggleShortcuts,
  onClose,
  returnFocus,
}: {
  open: boolean
  shortcutsEnabled: boolean
  onToggleShortcuts: (enabled: boolean) => void
  onClose: () => void
  returnFocus: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  const returnFocusRef = useRef(returnFocus)
  closeRef.current = onClose
  returnFocusRef.current = returnFocus

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !open) return
    const hasNativeModal = typeof dialog.showModal === 'function'
    if (hasNativeModal) {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    closeButtonRef.current?.focus()

    const keepFocusInsideFallback = (event: KeyboardEvent) => {
      if (hasNativeModal || event.key !== 'Tab') return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const handleEscapeFallback = (event: KeyboardEvent) => {
      if (!hasNativeModal && event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
    }
    dialog.addEventListener('keydown', keepFocusInsideFallback)
    dialog.addEventListener('keydown', handleEscapeFallback)
    return () => {
      dialog.removeEventListener('keydown', keepFocusInsideFallback)
      dialog.removeEventListener('keydown', handleEscapeFallback)
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close()
        else dialog.removeAttribute('open')
      }
      returnFocusRef.current()
    }
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      className="shortcut-dialog"
      aria-labelledby="shortcut-dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="shortcut-dialog__heading">
        <h2 id="shortcut-dialog-title">Keyboard shortcuts</h2>
        <button ref={closeButtonRef} className="button button--small" type="button" onClick={onClose}>Close shortcuts</button>
      </div>
      <label className="shortcut-dialog__toggle">
        <input
          type="checkbox"
          checked={shortcutsEnabled}
          onChange={(event) => onToggleShortcuts(event.currentTarget.checked)}
        />
        <span>Enable single-character shortcuts</span>
      </label>
      <p className="shortcut-dialog__note">Shortcuts work outside text fields, buttons, links, and other controls. Press Escape or Close shortcuts to leave this help.</p>
      <dl className="shortcut-dialog__list">
        <div><dt><kbd>P</kbd></dt><dd>Play the sequence, or stop playback</dd></div>
        <div><dt><kbd>G</kbd></dt><dd>Generate a combo or build the demo preview</dd></div>
        <div><dt><kbd>R</kbd></dt><dd>Reset session controls</dd></div>
      </dl>
      {!shortcutsEnabled && <p className="shortcut-dialog__off-note" role="status">Single-character shortcuts are off. This help button remains available.</p>}
    </dialog>
  )
}

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

function createBeatTrimId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'trim-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}

function retainedBeatTrimsForPreset(
  trims: SavedSessionData['beatTrims'],
  presetTrimId: string,
  customTrimId: string | null,
): SavedSessionData['beatTrims'] {
  const presetPrefix = presetBeatTrimKey(presetTrimId, 0).slice(0, -1)
  const customKey = customTrimId ? customBeatTrimKey(customTrimId) : null
  return Object.fromEntries(Object.entries(trims).filter(([key]) => (
    key.startsWith(presetPrefix) || key === customKey
  )))
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

function handleWorkspaceTabKeyDown(event: ReactKeyboardEvent<HTMLAnchorElement>, section: WorkspaceSection) {
  const currentIndex = WORKSPACE_TABS.findIndex((tab) => tab.section === section)
  let nextIndex: number | null = null
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % WORKSPACE_TABS.length
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex + WORKSPACE_TABS.length - 1) % WORKSPACE_TABS.length
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = WORKSPACE_TABS.length - 1
  if (nextIndex === null) return
  event.preventDefault()
  const nextTab = document.getElementById(WORKSPACE_TABS[nextIndex]!.id)
  nextTab?.focus()
  nextTab?.click()
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

function requiredImportSample(sample: SampleDefinition): boolean {
  return sample.enabled && !sample.silent && sample.weight > 0 && sample.durationUnits > 0
}

function resolvedReferencedFiles(resolution: PresetAssetResolution): File[] {
  const files = new Set<File>()
  for (const asset of resolution.samplesById.values()) {
    if (asset.status === 'resolved' && asset.file) files.add(asset.file)
  }
  for (const asset of resolution.beats) {
    if (asset.status === 'resolved' && asset.file) files.add(asset.file)
  }
  return [...files]
}

function referenceChecksForImport(
  preset: Preset,
  resolution: PresetAssetResolution,
  validationBySource: ReadonlyMap<File, SnapshotFileValidation> = new Map(),
): ImportReferenceCheck[] {
  const samples = preset.samples.map((sample): ImportReferenceCheck => {
    const asset = resolution.samplesById.get(sample.id)
      ?? { status: 'missing', requested: sample.fileName, candidates: [] }
    return {
      subject: 'sample',
      id: sample.id,
      requested: sample.fileName,
      required: requiredImportSample(sample),
      resolution: asset,
      validation: asset.status === 'resolved' && asset.file ? validationBySource.get(asset.file) ?? null : null,
    }
  })
  const beats = preset.beatFiles.map((fileName, index): ImportReferenceCheck => {
    const asset = resolution.beats[index]
      ?? { status: 'missing', requested: fileName, candidates: [] }
    return {
      subject: 'beat',
      id: 'Beat' + String(index + 1).padStart(2, '0'),
      requested: fileName,
      required: false,
      resolution: asset,
      validation: asset.status === 'resolved' && asset.file ? validationBySource.get(asset.file) ?? null : null,
    }
  })
  return [...samples, ...beats]
}

function mapPresetResolutionToSnapshots(
  resolution: PresetAssetResolution,
  filesBySource: ReadonlyMap<File, File>,
  validationBySource: ReadonlyMap<File, SnapshotFileValidation>,
): PresetAssetResolution {
  const mapOne = (asset: AssetResolution): AssetResolution => {
    if (asset.status !== 'resolved' || !asset.file) return asset
    if (validationBySource.get(asset.file)?.status === 'invalid') {
      const unavailable: AssetResolution = {
        status: 'missing',
        requested: asset.requested,
        candidates: asset.candidates,
      }
      if (asset.selectedPath) unavailable.selectedPath = asset.selectedPath
      return unavailable
    }
    const snapshot = filesBySource.get(asset.file)
    if (!snapshot) throw new Error('A referenced WAV was not copied into session memory.')
    return { ...asset, file: snapshot }
  }
  return {
    samplesById: new Map(Array.from(resolution.samplesById, ([sampleId, asset]) => [sampleId, mapOne(asset)])),
    beats: resolution.beats.map(mapOne),
    diagnostics: resolution.diagnostics,
  }
}

function mappedReferenceChecks(
  checks: ImportReferenceCheck[],
  resolution: PresetAssetResolution,
): ImportReferenceCheck[] {
  let beatIndex = 0
  return checks.map((check) => {
    const mapped = check.subject === 'sample'
      ? resolution.samplesById.get(check.id) ?? check.resolution
      : resolution.beats[beatIndex++] ?? check.resolution
    return { ...check, resolution: mapped }
  })
}

function snapshotErrorForImport(error: unknown, resolution: PresetAssetResolution): string {
  if (error instanceof LocalWavSnapshotError && error.file) {
    const paths = [
      ...Array.from(resolution.samplesById.values())
        .filter((asset) => asset.file === error.file)
        .map((asset) => asset.selectedPath),
      ...resolution.beats
        .filter((asset) => asset.file === error.file)
        .map((asset) => asset.selectedPath),
    ].filter((path): path is string => Boolean(path))
    const reference = [...new Set(paths)].join(', ') || error.file.name
    return reference + ': ' + error.message + ' Choose another folder or smaller referenced WAVs, then review again.'
  }
  return describeError(error) + ' Choose another folder or smaller referenced WAVs, then review again.'
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

function ImportWizard({
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

function QuickPresetControl({
  builtInCatalog,
  selectedPresetId,
  locked,
  isBootstrapLoading,
  onChange,
}: {
  builtInCatalog: BuiltInPresetCatalog | undefined
  selectedPresetId: string
  locked: boolean
  isBootstrapLoading: boolean
  onChange: (id: string) => void
}) {
  return (
    <div className="quick-preset-row">
      <label htmlFor="quick-preset">Quick preset</label>
      <select
        id="quick-preset"
        value={selectedPresetId}
        disabled={locked || isBootstrapLoading}
        onChange={(event) => onChange(event.currentTarget.value)}
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
  fixture, preset, assets, progress, isPlaying, isPaused, presentationStarted, presentationPositionUnits, presentationCycleSlotKind,
  presentationCyclePlanIndex, activeSampleId, activeEventId, auditionedSampleId, timebase, view: requestedView, layout, ttmAnnotations, onViewChange, onLayoutChange,
}: {
  fixture: Fixture
  preset: Preset
  assets: ReadonlyMap<string, File>
  progress: number
  isPlaying: boolean
  isPaused: boolean
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
  const view = import.meta.env.DEV ? requestedView : 'waveform'
  const activePlaybackLabel = isPaused ? 'Paused here' : 'Now playing'

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
    return <li key={event.id}>Event {index + 1}: {name}, starts at {startLabel}{event.startUnits + 1}, lasts {event.durationUnits}{durationLabel}{event.silent ? ', silent' : ''}{event.id === activeEventId ? (isPaused ? ', playback paused here' : ', now playing') : ''}{guideDescription}</li>
  })
  const renderSequenceEvent = (event: Fixture['events'][number], inline = false, eventNumber = 0) => {
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
        title={event.silent ? name + ': silent event' : (active ? activePlaybackLabel + ' · ' : '') + name + ': ' + event.durationUnits + ' units' + guideDescription}
      >
        {inline && <span className={view === 'ttm' ? 'sequence-inline-event-label sequence-inline-event-label--ttm' : 'sequence-inline-event-label'}>{view === 'ttm' ? eventNumber + ' · ' + name : (active ? activePlaybackLabel + ' · ' : '') + name}</span>}
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
                  style={{ left: (6 + interval.start * 88) + '%', width: ((interval.end - interval.start) * 88) + '%' }}
                ><span>{interval.state === 'open' ? 'OPEN' : 'CUT'}</span></span>
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
          <label><input type="radio" name="timeline-view" value="waveform" checked={view === 'waveform'} onChange={() => onViewChange('waveform')} />Waveform</label>
          <label className={import.meta.env.DEV ? undefined : 'timeline-view-option--disabled'}>
            <input type="radio" name="timeline-view" value="ttm" checked={view === 'ttm'} disabled={!import.meta.env.DEV} onChange={() => { if (import.meta.env.DEV) onViewChange('ttm') }} />
            TTM practice guides{!import.meta.env.DEV && <small>Local debug only</small>}
          </label>
        </fieldset>
        <span className="timing-readout">{fixture.events.length} events</span>
      </figcaption>
      {view === 'ttm' && <div className="ttm-guide-legend" aria-label="TTM notation key">
        <span className="ttm-guide-legend__example">
          <svg viewBox="0 0 100 100" aria-hidden="true"><path d={ttmMotionSvgPath(TTM_GUIDES['baby-rub'].motion)} /></svg>
          <span>Example · {TTM_GUIDES['baby-rub'].label}</span>
        </span>
        <span>Time → · record forward ↑ / backward ↓</span>
        <span className="ttm-guide-legend__key"><span className="ttm-guide-legend__gate ttm-guide-legend__gate--open">OPEN</span> audible <span className="ttm-guide-legend__gate ttm-guide-legend__gate--closed">CUT</span> closed / muted</span>
        <span className="ttm-guide-legend__disclaimer">Illustrative guides only · not WAV transcriptions</span>
      </div>}
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
              <div className={'timeline-lane' + (view === 'ttm' ? ' timeline-lane--ttm' : '') + (lane.id === auditionedSampleId ? ' timeline-lane--auditioned' : '') + (lane.id === activeSampleId ? ' timeline-lane--active' : '')} key={lane.id} style={lane.color ? { '--sample-color': lane.color } as CSSProperties : undefined}>
                <span className={view === 'ttm' ? 'timeline-lane-label timeline-lane-label--ttm' : 'timeline-lane-label'}>
                  <span className="timeline-lane-name"><span className={lane.color ? 'timeline-color-swatch' : 'timeline-color-swatch timeline-color-swatch--silent'} aria-hidden="true" /><span className="timeline-lane-name-text">{lane.name}</span></span>
                  <small>{lane.note}</small>
                  {lane.id === activeSampleId && <span className="timeline-now-playing">{activePlaybackLabel}</span>}
                </span>
                <span className={view === 'ttm' ? 'timeline-track timeline-track--ttm' : 'timeline-track'} aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                  {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                  {events.map((event) => renderSequenceEvent(event, false, fixture.events.findIndex((candidate) => candidate.id === event.id) + 1))}
                  {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
                </span>
              </div>
            )
          })}
          {layout === 'inline' && (
            <div className="timeline-inline-row">
              <span className="timeline-axis-label">EVENT</span>
              <span className={view === 'ttm' ? 'timeline-track timeline-track--inline timeline-track--inline-ttm' : 'timeline-track timeline-track--inline'} aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                {fixture.events.map((event, index) => renderSequenceEvent(event, true, index + 1))}
                {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
              </span>
            </div>
          )}
        </div>
      </div>
      {view === 'ttm' && <p className="timeline-guide-note">TTM practice guides are finite teaching examples, not WAV transcriptions. Exact labels Baby, Baby (F), Baby F, Baby(F), Baby (R), Baby Rev, Baby(R), and Chirp may suggest an example; other labels stay Unassigned. Baby scratch / rub keeps the fader open, forward movement is one open stroke, forward scratch / cut mutes the return, and Chirp shows a narrow illustrative cut at the turn. <a href="#sample-section">Edit a sample</a> to assign a guide or explicitly choose Untranscribed. <a href="https://www.ttm-dj.com/ttm-01-01-basics/" target="_blank" rel="noreferrer">TTM basics</a>.</p>}
      <ol className="visually-hidden" aria-label="Sequence events">{eventDescription}</ol>
    </figure>
  )
}

function DiagnosticList({ diagnostics }: { diagnostics: AssetDiagnostic[] }) {
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

function SampleEditor({
  sample, draft, disabled, ttmGuide, ttmGuideIsExplicit, onDraftChange, onTtmGuideChange, onSave, onCancel,
}: {
  sample: SampleDefinition
  draft: SampleDefinition
  disabled: boolean
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
        {import.meta.env.DEV && <label className="sample-editor__field sample-editor__field--guide" htmlFor="sample-ttm-guide">
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
  preset, resolution, actionsDisabled, legacyMode, sourceAvailable, editingSample, saveError, isSavingData,
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
        ttmGuide={ttmAnnotations[editingSample.id] ?? UNTRANSCRIBED}
        ttmGuideIsExplicit={Object.hasOwn(ttmAnnotations, editingSample.id)}
        onDraftChange={onDraftChange}
        onTtmGuideChange={(selection) => onTtmGuideChange(editingSample.id, selection)}
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
  const [transport] = useState(() => new AudioTransport())
  const transportSnapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot, transport.getSnapshot)
  const presentation = transportSnapshot.presentation
  const presentationCycleSlotKind = presentation?.cycleSlotKind
  const presentationCycleSlotIndex = presentation?.cycleSlotIndex
  const presentationCycleIteration = presentation?.cycleIteration
  const presentationCyclePlanIndex = presentation?.cyclePlanIndex
  const isCountInActive = transportSnapshot.status === 'counting-in'
  const isCountInPaused = transportSnapshot.status === 'paused' && transportSnapshot.pausedFrom === 'counting-in'
  const isCountInSuspended = isCountInActive || isCountInPaused
  const isPlaybackLocked = transportSnapshot.status === 'loading' || isCountInActive || transportSnapshot.status === 'playing' || transportSnapshot.status === 'paused'
  const isPlaybackLockedNow = () => {
    const status = transport.getSnapshot().status
    return status === 'loading' || status === 'counting-in' || status === 'playing' || status === 'paused'
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
  const [countInBars, setCountInBars] = useState<CountInBars>(0)
  const [metronomeEnabled, setMetronomeEnabled] = useState(false)
  const [metronomeVolume, setMetronomeVolume] = useState(60)
  const [tempoTraining, setTempoTraining] = useState<TempoTrainingSettings>(() => ({ ...DEFAULT_TEMPO_TRAINING_SETTINGS }))
  const [tempoTrainingCancelledNotice, setTempoTrainingCancelledNotice] = useState('')
  const [omittedZeroDurationCount, setOmittedZeroDurationCount] = useState(0)
  const [presetFileName, setPresetFileName] = useState<string | null>(null)
  const [sourceIniText, setSourceIniText] = useState<string | null>(null)
  const [editingSample, setEditingSample] = useState<SampleDefinition | null>(null)
  const [isSavingIni, setIsSavingIni] = useState(false)
  const [saveIniError, setSaveIniError] = useState<string | null>(null)
  const [localWavFiles, setLocalWavFiles] = useState<File[]>([])
  const [assetIndex, setAssetIndex] = useState<AssetIndex>(() => buildAssetIndex([]))
  const [assetResolution, setAssetResolution] = useState<PresetAssetResolution>()
  const [importStep, setImportStep] = useState<ImportWizardStep>(1)
  const [importFileMode, setImportFileMode] = useState<'folder' | 'files'>('folder')
  const [stagedIniFile, setStagedIniFile] = useState<File | null>(null)
  const [stagedIniText, setStagedIniText] = useState<string | null>(null)
  const [stagedPreset, setStagedPreset] = useState<Preset | null>(null)
  const [stagedAudioFiles, setStagedAudioFiles] = useState<File[]>([])
  const [preparedLocalImport, setPreparedLocalImport] = useState<PreparedLocalImport | null>(null)
  const [isPreparingLocalImport, setIsPreparingLocalImport] = useState(false)
  const [localImportError, setLocalImportError] = useState<string | null>(null)
  const [localImportSelectionNote, setLocalImportSelectionNote] = useState<string | null>(null)
  const [isReadingPreset, setIsReadingPreset] = useState(true)
  const [isPresetReady, setIsPresetReady] = useState(false)
  const [presetSource, setPresetSource] = useState<PresetSource>('loading')
  const [builtInCatalog, setBuiltInCatalog] = useState<BuiltInPresetCatalog>()
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_BUILTIN_PRESET_ID)
  const [isBootstrapLoading, setIsBootstrapLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [importMessage, setImportMessage] = useState('Loading the 85 BPM Beginner preset and its referenced WAV files.')
  const [actionError, setActionError] = useState<string | null>(null)
  const [savedLibrary, setSavedLibrary] = useState<SavedLibraryIndex>({ sessions: [], favorites: [], lastSavedSessionId: null })
  const [savedLibraryAvailable, setSavedLibraryAvailable] = useState(false)
  const [savedLibraryBusy, setSavedLibraryBusy] = useState(false)
  const [savedLibraryMessage, setSavedLibraryMessage] = useState('')
  const [savedLibraryError, setSavedLibraryError] = useState<string | null>(null)
  const [savedSessionName, setSavedSessionName] = useState('')
  const [favoriteComboName, setFavoriteComboName] = useState('')
  const [selectedSavedSessionId, setSelectedSavedSessionId] = useState('')
  const [selectedFavoriteId, setSelectedFavoriteId] = useState('')
  const [activeSavedSessionId, setActiveSavedSessionId] = useState<string | null>(null)
  const [bpm, setBpm] = useState(String(DEMO_PRESET.bpm))
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const [sampleVolume, setSampleVolume] = useState(DEMO_PRESET.sampleVolume)
  const [beatVolume, setBeatVolume] = useState(DEMO_PRESET.beatVolume)
  const [selectedBeatIndex, setSelectedBeatIndex] = useState('none')
  const [customBeatFile, setCustomBeatFile] = useState<File | null>(null)
  const [customBeatBuffer, setCustomBeatBuffer] = useState<AudioBuffer | null>(null)
  const [presetBeatTrimId, setPresetBeatTrimId] = useState(() => createBeatTrimId())
  const [customBeatTrimId, setCustomBeatTrimId] = useState<string | null>(null)
  const [beatTrims, setBeatTrims] = useState<SavedSessionData['beatTrims']>({})
  const [customBeatSelected, setCustomBeatSelected] = useState(false)
  const [customBeatReferenceBpm, setCustomBeatReferenceBpm] = useState<number | null>(null)
  const [customBeatReferenceBpmInput, setCustomBeatReferenceBpmInput] = useState('')
  const [customBeatCandidate, setCustomBeatCandidate] = useState<CustomBeatCandidate | null>(null)
  const [customBeatCandidateBpm, setCustomBeatCandidateBpm] = useState('')
  const [customBeatAnalysisStatus, setCustomBeatAnalysisStatus] = useState<CustomBeatAnalysisStatus>('idle')
  const [customBeatAnalysisMessage, setCustomBeatAnalysisMessage] = useState('')
  const [playbackTarget, setPlaybackTarget] = useState<PlaybackTarget>(null)
  const [transportNote, setTransportNote] = useState('Ready to play.')
  const [activeSection, setActiveSection] = useState<WorkspaceSection>(() => workspaceSectionForHash(window.location.hash) ?? 'sequence')
  const [shortcutsEnabled, setShortcutsEnabled] = useState(() => {
    try { return window.localStorage.getItem('scratch-combo-shortcuts') !== 'off' } catch { return true }
  })
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)
  const keyboardHelpButtonRef = useRef<HTMLButtonElement>(null)
  const shortcutActionsRef = useRef<{
    playDisabled: boolean
    stopDisabled: boolean
    resetDisabled: boolean
    play: () => void
    stop: () => void
    generate: () => void
    reset: () => void
  } | null>(null)

  const assetIndexRef = useRef(assetIndex)
  const presetImportGeneration = useRef(0)
  const localImportGeneration = useRef(0)
  const localImportController = useRef<AbortController | undefined>(undefined)
  const activeQuickPresetIdRef = useRef(DEFAULT_BUILTIN_PRESET_ID)
  const presetSourceRef = useRef<PresetSource>('loading')
  const activePresetLoadRef = useRef<AbortController | undefined>(undefined)
  const builtInCatalogRef = useRef<BuiltInPresetCatalog | undefined>(undefined)
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
  const beatTrimSourceName = customBeatSelected
    ? customBeatFile?.name ?? null
    : selectedBeatIndex === 'none'
      ? null
      : selectedBeatResolution?.selectedPath ?? selectedBeatResolution?.requested ?? preset.beatFiles[Number(selectedBeatIndex)] ?? null
  const activeBeatTrimKey = customBeatSelected
    ? customBeatFile && customBeatTrimId ? customBeatTrimKey(customBeatTrimId) : null
    : selectedBeatIndex === 'none'
      ? null
      : presetBeatTrimKey(presetBeatTrimId, Number(selectedBeatIndex))
  const activeBeatTrim = activeBeatTrimKey ? beatTrims[activeBeatTrimKey] ?? null : null
  const selectedBeatReferenceBpm = customBeatSelected ? customBeatReferenceBpm : null
  const selectedTempoRange = getTempoRange(preset.bpm, selectedBeatReferenceBpm)
  const isCustomBeatAnalysisBusy = customBeatAnalysisStatus === 'analyzing'
  const customBeatReferenceInputNumber = Number(customBeatReferenceBpmInput)
  const customBeatReferenceInputValid = !customBeatSelected || !customBeatBuffer
    || (Number.isFinite(customBeatReferenceInputNumber) && customBeatReferenceInputNumber >= 1)
  const sessionTempoNumber = Number(bpm)
  const sessionTempoValid = selectedTempoRange !== null
    && Number.isFinite(sessionTempoNumber)
    && sessionTempoNumber >= selectedTempoRange.min
    && sessionTempoNumber <= selectedTempoRange.max
  const tempoTrainingError = tempoTrainingValidationMessage(
    tempoTraining,
    sessionTempoNumber,
    selectedTempoRange,
    Boolean(presetFileName),
  )
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

  const refreshSavedLibrary = async () => {
    try {
      const next = await listSavedRecords()
      setSavedLibrary(next)
      setSavedLibraryAvailable(true)
      setSavedLibraryError(null)
      setSelectedSavedSessionId((current) => next.sessions.some((record) => record.id === current)
        ? current
        : next.lastSavedSessionId ?? next.sessions[0]?.id ?? '')
      setSelectedFavoriteId((current) => next.favorites.some((record) => record.id === current)
        ? current
        : next.favorites[0]?.id ?? '')
      return next
    } catch (error) {
      setSavedLibraryAvailable(false)
      if (error instanceof SessionLibraryError && error.code === 'unavailable') {
        setSavedLibraryMessage('Saved sessions and favourites are unavailable in this browser.')
        setSavedLibraryError(null)
      } else {
        setSavedLibraryError(describeError(error))
      }
      return null
    }
  }

  const captureCurrentSession = (): SavedSessionData => {
    if (!isPresetReady || presetSource === 'loading') throw new Error('Wait for a preset to finish loading before saving this session.')
    const persistedAssetPath = (file: File, fallback: string) => {
      const resolutions = assetResolution
        ? [...assetResolution.samplesById.values(), ...assetResolution.beats]
        : []
      return resolutions.find((asset) => asset.status === 'resolved' && asset.file === file && asset.selectedPath)?.selectedPath ?? fallback
    }
    const assets: SavedMedia[] = assetIndex.files.map(({ file, relativePath }) => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      relativePath: persistedAssetPath(file, relativePath),
      size: file.size,
      data: file.slice(0, file.size, file.type),
    }))
    const customBeat = customBeatFile ? {
      name: customBeatFile.name,
      type: customBeatFile.type,
      lastModified: customBeatFile.lastModified,
      relativePath: customBeatFile.name,
      size: customBeatFile.size,
      data: customBeatFile.slice(0, customBeatFile.size, customBeatFile.type),
    } satisfies SavedMedia : null
    return {
      version: 1,
      presetSource,
      selectedPresetId,
      preset: {
        ...preset,
        beatFiles: [...preset.beatFiles],
        samples: preset.samples.map((sample) => ({ ...sample })),
      },
      fixture: fixture ? { totalUnits: fixture.totalUnits, events: fixture.events.map((event) => ({ ...event })) } : null,
      timebase,
      timelineView,
      timelineLayout,
      ttmAnnotations: Object.fromEntries(Object.entries(ttmAnnotations).map(([sampleId, selection]) => [sampleId, typeof selection === 'string' ? selection : selection.kind])),
      comboBeats,
      practiceMode,
      largePause,
      autoGenerate,
      autoGenerateRounds,
      countInBars,
      metronomeEnabled,
      metronomeVolume,
      tempoTraining,
      omittedZeroDurationCount,
      presetFileName,
      sourceIniText,
      bpm,
      pitchSemitones,
      sampleVolume,
      beatVolume,
      selectedBeatIndex,
      customBeatFile: customBeat,
      customBeatSelected,
      customBeatReferenceBpm,
      customBeatReferenceBpmInput,
      presetBeatTrimId,
      customBeatTrimId,
      beatTrims,
      assets,
    }
  }

  const handleSaveSession = async (saveAsNew = false) => {
    if (!savedLibraryAvailable || savedLibraryBusy || isPlaybackLockedNow() || isReadingPreset || isGenerating || isSavingIni) return
    setSavedLibraryBusy(true)
    setSavedLibraryError(null)
    setSavedLibraryMessage('Saving the session and copying its referenced audio into this browser…')
    try {
      const snapshot = captureCurrentSession()
      const name = savedSessionName.trim() || currentPresetName
      const record = await saveSavedRecord({
        ...(!saveAsNew && activeSavedSessionId ? { id: activeSavedSessionId } : {}),
        kind: 'session',
        name,
        snapshot,
      })
      setActiveSavedSessionId(record.id)
      setSavedSessionName(record.name)
      setSelectedSavedSessionId(record.id)
      setSavedLibraryMessage('Saved “' + record.name + '” in this browser. Press Reload last saved after a page refresh to restore it.')
      void refreshSavedLibrary()
    } catch (error) {
      setSavedLibraryError(describeError(error))
    } finally {
      setSavedLibraryBusy(false)
    }
  }

  const handleSaveFavorite = async () => {
    if (!savedLibraryAvailable || savedLibraryBusy || isPlaybackLockedNow() || isReadingPreset || isGenerating || isSavingIni || !fixture) return
    setSavedLibraryBusy(true)
    setSavedLibraryError(null)
    setSavedLibraryMessage('Saving the exact combo and copying its referenced audio into this browser…')
    try {
      const snapshot = captureCurrentSession()
      const name = favoriteComboName.trim() || (currentPresetName + ' · ' + (isImportedPreset ? comboBeats + ' beat' : 'demo') + ' combo')
      const record = await saveSavedRecord({ kind: 'favorite', name, snapshot })
      setFavoriteComboName('')
      setSelectedFavoriteId(record.id)
      setSavedLibraryMessage('Saved the exact current combo as “' + record.name + '”.')
      void refreshSavedLibrary()
    } catch (error) {
      setSavedLibraryError(describeError(error))
    } finally {
      setSavedLibraryBusy(false)
    }
  }

  const restoreSavedRecord = async (summary: SavedRecordSummary) => {
    if (!savedLibraryAvailable || savedLibraryBusy || isPlaybackLockedNow() || isReadingPreset || isGenerating || isPreparingLocalImport || isSavingIni) return
    setSavedLibraryBusy(true)
    setSavedLibraryError(null)
    setSavedLibraryMessage('Checking saved audio and rebuilding the session. Playback stays stopped.')
    setIsReadingPreset(true)
    invalidateAutoGeneration()
    transport.stop()
    setPlaybackTarget(null)
    setVisibleCyclePlanIndex(null)
    try {
      const record = await loadSavedRecord(summary.id)
      if (record.kind !== summary.kind) throw new SessionLibraryError('corrupt', 'That saved item changed while it was being loaded. Refresh the list and try again.')
      const data = record.snapshot
      if (data.fixture) {
        const samplesById = new Map(data.preset.samples.map((sample) => [sample.id, sample]))
        for (const event of data.fixture.events) {
          const sample = samplesById.get(event.sampleId)
          if ((event.sampleId === REST_SAMPLE_ID && !event.silent)
            || (event.sampleId !== REST_SAMPLE_ID && (!sample || event.silent !== sample.silent))) {
            throw new SessionLibraryError('corrupt', 'The saved combo refers to a missing or mismatched sample. Delete it and save again.')
          }
        }
        if (data.presetFileName !== null && data.fixture.totalUnits !== data.comboBeats * LEGACY_TICKS_PER_BEAT) {
          throw new SessionLibraryError('corrupt', 'The saved combo length does not match its session settings. Delete it and save again.')
        }
      }
      if (data.presetSource === 'custom') parseLegacyIni(data.sourceIniText ?? '')

      const storedFiles = data.assets.map((asset) => {
        const file = new File([asset.data], asset.name, { type: asset.type, lastModified: asset.lastModified })
        Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: asset.relativePath })
        return file
      })
      let nextIndex = buildAssetIndex(storedFiles)
      let nextResolution: PresetAssetResolution | undefined = data.presetSource === 'demo'
        ? undefined
        : resolvePresetAssets(data.preset, nextIndex)
      const selectedBeatNumber = data.selectedBeatIndex === 'none' ? null : Number(data.selectedBeatIndex)
      if (data.selectedBeatIndex !== 'none' && (!Number.isSafeInteger(selectedBeatNumber) || selectedBeatNumber === null
        || selectedBeatNumber < 0 || selectedBeatNumber >= (nextResolution?.beats.length ?? 0))) {
        throw new SessionLibraryError('corrupt', 'The saved beat selection is outside this preset. Delete it and save again.')
      }

      const filesToDecode = new Set<File>()
      const requiredFilesBySampleId = new Map<string, File>()
      const trimmedPresetBeatFiles = new Map<number, File>()
      let selectedPresetBeatFile: File | null = null
      if (nextResolution) {
        for (const sample of data.preset.samples.filter(requiredImportSample)) {
          const resolution = nextResolution.samplesById.get(sample.id)
          if (resolution?.status !== 'resolved' || !resolution.file) {
            throw new SessionLibraryError('corrupt', 'The saved session is missing the WAV for “' + sample.name + '”. Save it again while the required audio is available.')
          }
          filesToDecode.add(resolution.file)
          requiredFilesBySampleId.set(sample.id, resolution.file)
        }
        if (selectedBeatNumber !== null) {
          const resolution = nextResolution.beats[selectedBeatNumber]
          if (resolution?.status !== 'resolved' || !resolution.file) {
            throw new SessionLibraryError('corrupt', 'The saved session is missing its selected preset beat. Save it again while the beat is available.')
          }
          filesToDecode.add(resolution.file)
          selectedPresetBeatFile = resolution.file
        }
        for (let beatIndex = 0; beatIndex < data.preset.beatFiles.length; beatIndex += 1) {
          const trimKey = presetBeatTrimKey(data.presetBeatTrimId, beatIndex)
          if (!data.beatTrims[trimKey]) continue
          const resolution = nextResolution.beats[beatIndex]
          if (resolution?.status !== 'resolved' || !resolution.file) {
            throw new SessionLibraryError('corrupt', 'The saved trim refers to a missing preset beat. Delete it and save again while that beat is available.')
          }
          filesToDecode.add(resolution.file)
          trimmedPresetBeatFiles.set(beatIndex, resolution.file)
        }
      }

      const copied = storedFiles.length > 0
        ? await snapshotReferencedWavFiles(storedFiles, { decodeFiles: [...filesToDecode] })
        : undefined
      const restoredFiles = storedFiles.map((file, index) => {
        const restored = copied?.filesBySource.get(file) ?? file
        const path = data.assets[index]?.relativePath
        if (path) Object.defineProperty(restored, 'webkitRelativePath', { configurable: true, value: path })
        return restored
      })
      nextIndex = buildAssetIndex(restoredFiles)
      nextResolution = data.presetSource === 'demo' ? undefined : resolvePresetAssets(data.preset, nextIndex)

      if (nextResolution) {
        for (const sample of data.preset.samples.filter(requiredImportSample)) {
          const resolution = nextResolution.samplesById.get(sample.id)
          const originalFile = requiredFilesBySampleId.get(sample.id)
          const expectedSnapshot = originalFile ? copied?.filesBySource.get(originalFile) : undefined
          const validation = originalFile ? copied?.validationBySource.get(originalFile) : undefined
          if (resolution?.status !== 'resolved' || !resolution.file || resolution.file !== expectedSnapshot || validation?.status !== 'valid') {
            throw new SessionLibraryError('corrupt', 'Could not decode the saved WAV for “' + sample.name + '”. Delete the saved item and check the original audio file.')
          }
        }
        if (selectedBeatNumber !== null) {
          const resolution = nextResolution.beats[selectedBeatNumber]
          const originalFile = selectedPresetBeatFile
          const expectedSnapshot = originalFile ? copied?.filesBySource.get(originalFile) : undefined
          const validation = originalFile ? copied?.validationBySource.get(originalFile) : undefined
          if (resolution?.status !== 'resolved' || !resolution.file || resolution.file !== expectedSnapshot || validation?.status !== 'valid') {
            throw new SessionLibraryError('corrupt', 'Could not decode the saved preset beat. Delete the saved item and check the original audio file.')
          }
        }
        for (const [beatIndex, originalFile] of trimmedPresetBeatFiles) {
          const validation = copied?.validationBySource.get(originalFile)
          const region = data.beatTrims[presetBeatTrimKey(data.presetBeatTrimId, beatIndex)]
          if (validation?.status !== 'valid' || !region) {
            throw new SessionLibraryError('corrupt', 'A saved manual trim falls outside the decoded preset beat. Delete it and save a valid trim.')
          }
          const loopEndSeconds = region.loopEndSeconds ?? validation.durationSeconds
          if (region.startOffsetSeconds >= validation.durationSeconds
            || loopEndSeconds <= region.startOffsetSeconds || loopEndSeconds > validation.durationSeconds) {
            throw new SessionLibraryError('corrupt', 'A saved manual trim falls outside the decoded preset beat. Delete it and save a valid trim.')
          }
        }
      }

      let restoredCustomBeatFile: File | null = null
      let restoredCustomBeatBuffer: AudioBuffer | null = null
      if (data.customBeatFile) {
        const asset = data.customBeatFile
        restoredCustomBeatFile = new File([asset.data], asset.name, { type: asset.type, lastModified: asset.lastModified })
        let context: AudioContext | undefined
        try {
          context = new AudioContext()
          restoredCustomBeatBuffer = (await analyzeLocalAudioFile(context, restoredCustomBeatFile)).buffer
        } catch (error) {
          throw new SessionLibraryError('corrupt', 'Could not decode the saved custom beat: ' + describeError(error) + ' Delete the saved item and choose a readable audio file.')
        } finally {
          if (context && context.state !== 'closed') await context.close().catch(() => undefined)
        }
      }

      if (data.customBeatTrimId) {
        const customRegion = data.beatTrims[customBeatTrimKey(data.customBeatTrimId)]
        if (customRegion) {
          const duration = restoredCustomBeatBuffer?.duration
          const loopEndSeconds = customRegion.loopEndSeconds ?? duration
          if (!Number.isFinite(duration) || duration === undefined || duration <= 0
            || customRegion.startOffsetSeconds >= duration
            || loopEndSeconds === undefined || loopEndSeconds <= customRegion.startOffsetSeconds
            || loopEndSeconds > duration) {
            throw new SessionLibraryError('corrupt', 'The saved manual trim falls outside the decoded custom beat. Delete it and save a valid trim.')
          }
        }
      }

      if (data.selectedBeatIndex !== 'none' && selectedBeatNumber === null) {
        throw new SessionLibraryError('corrupt', 'The saved beat selection is invalid. Delete it and save again.')
      }
      clearLocalImportDraft()
      transport.resetAssets()
      transport.stop()
      assetIndexRef.current = nextIndex
      presetSourceRef.current = data.presetSource
      activeQuickPresetIdRef.current = data.presetSource === 'builtin' ? data.selectedPresetId : data.presetSource
      setPresetSource(data.presetSource)
      setSelectedPresetId(data.selectedPresetId)
      setPreset(data.preset)
      setFixture(data.fixture)
      setTimebase(data.timebase)
      setTimelineView(import.meta.env.DEV ? data.timelineView : 'waveform')
      setTimelineLayout(data.timelineLayout)
      setTtmAnnotations(import.meta.env.DEV
        ? Object.fromEntries(Object.entries(data.ttmAnnotations).map(([id, value]) => [id, value === UNTRANSCRIBED.kind || Object.values(TTM_GUIDES).some((guide) => guide.id === value) ? value as TtmSampleGuideSelection : UNTRANSCRIBED]))
        : {})
      setComboBeats(data.comboBeats)
      setPracticeMode(data.practiceMode)
      setLargePause(data.largePause)
      setAutoGenerate(data.autoGenerate)
      setAutoGenerateRounds(data.autoGenerateRounds)
      setCountInBars(data.countInBars)
      setMetronomeEnabled(data.metronomeEnabled)
      setMetronomeVolume(data.metronomeVolume)
      setTempoTraining(data.tempoTraining)
      setOmittedZeroDurationCount(data.omittedZeroDurationCount)
      setPresetFileName(data.presetFileName)
      setSourceIniText(data.sourceIniText)
      setLocalWavFiles(data.presetSource === 'custom' ? restoredFiles : [])
      setAssetIndex(nextIndex)
      setAssetResolution(nextResolution)
      setBpm(data.bpm)
      setPitchSemitones(data.pitchSemitones)
      setSampleVolume(data.sampleVolume)
      setBeatVolume(data.beatVolume)
      setSelectedBeatIndex(data.selectedBeatIndex)
      setCustomBeatFile(restoredCustomBeatFile)
      setCustomBeatBuffer(restoredCustomBeatBuffer)
      setPresetBeatTrimId(data.presetBeatTrimId)
      setCustomBeatTrimId(data.customBeatTrimId)
      setBeatTrims(data.beatTrims)
      setCustomBeatSelected(data.customBeatSelected)
      setCustomBeatReferenceBpm(data.customBeatReferenceBpm)
      setCustomBeatReferenceBpmInput(data.customBeatReferenceBpmInput)
      setCustomBeatCandidate(null)
      setCustomBeatCandidateBpm('')
      setCustomBeatAnalysisStatus('idle')
      setCustomBeatAnalysisMessage('')
      setEditingSample(null)
      setIsSavingIni(false)
      setSaveIniError(null)
      sourceControlDefaultsRef.current = {
        bpm: data.preset.bpm,
        sampleVolume: data.preset.sampleVolume,
        beatVolume: data.preset.beatVolume,
      }
      transport.setPitchSemitones(data.pitchSemitones)
      transport.setSampleVolume(data.sampleVolume)
      transport.setBeatVolume(data.beatVolume)
      transport.setMetronomeVolume(data.metronomeVolume)
      setIsPresetReady(true)
      setIsBootstrapLoading(false)
      setBootstrapError(null)
      setActionError(null)
      setPlaybackTarget(null)
      setVisibleCyclePlanIndex(null)
      setActiveSavedSessionId(record.kind === 'session' ? record.id : null)
      setSavedSessionName(record.kind === 'session' ? record.name : '')
      if (record.kind === 'session') setSelectedSavedSessionId(record.id)
      else setSelectedFavoriteId(record.id)
      setImportMessage('Restored “' + record.name + '” from this browser. Saved audio was rechecked locally.')
      setTransportNote('Loaded “' + record.name + '”. Playback is stopped; press Play when ready.')
      setSavedLibraryMessage('Loaded “' + record.name + '”. Playback is stopped; press Play when ready.')
    } catch (error) {
      setSavedLibraryMessage('')
      setSavedLibraryError(describeError(error))
      setTransportNote('Could not restore the saved item. Playback is stopped; the current preset remains active.')
    } finally {
      setIsReadingPreset(false)
      setSavedLibraryBusy(false)
    }
  }

  const handleLoadSelectedSession = () => {
    const record = savedLibrary.sessions.find((candidate) => candidate.id === selectedSavedSessionId)
    if (record) void restoreSavedRecord(record)
  }

  const handleReloadLastSession = () => {
    const record = savedLibrary.sessions.find((candidate) => candidate.id === savedLibrary.lastSavedSessionId)
    if (record) void restoreSavedRecord(record)
  }

  const handleLoadSelectedFavorite = () => {
    const record = savedLibrary.favorites.find((candidate) => candidate.id === selectedFavoriteId)
    if (record) void restoreSavedRecord(record)
  }

  const handleDeleteSelectedSavedItem = async (kind: 'session' | 'favorite') => {
    const record = kind === 'session'
      ? savedLibrary.sessions.find((candidate) => candidate.id === selectedSavedSessionId)
      : savedLibrary.favorites.find((candidate) => candidate.id === selectedFavoriteId)
    if (!record || !window.confirm('Delete “' + record.name + '” and its saved audio from this browser?')) return
    setSavedLibraryBusy(true)
    setSavedLibraryError(null)
    setSavedLibraryMessage('Deleting the selected item and its local audio…')
    try {
      await deleteSavedRecord(record.id)
      if (activeSavedSessionId === record.id) setActiveSavedSessionId(null)
      setSavedLibraryMessage('Deleted “' + record.name + '” and its locally saved audio.')
      void refreshSavedLibrary()
    } catch (error) {
      setSavedLibraryError(describeError(error))
    } finally {
      setSavedLibraryBusy(false)
    }
  }

  const cancelLocalImportWork = () => {
    localImportGeneration.current += 1
    localImportController.current?.abort()
    localImportController.current = undefined
    setIsPreparingLocalImport(false)
  }

  const clearLocalImportDraft = (restoreQuickPreset = false) => {
    cancelLocalImportWork()
    setImportStep(1)
    setImportFileMode('folder')
    setStagedIniFile(null)
    setStagedIniText(null)
    setStagedPreset(null)
    setStagedAudioFiles([])
    setPreparedLocalImport(null)
    setLocalImportError(null)
    setLocalImportSelectionNote(null)
    if (restoreQuickPreset) setSelectedPresetId(activeQuickPresetIdRef.current)
  }

  const focusLocalImportTarget = (step: ImportWizardStep, fileMode = importFileMode, target: 'heading' | 'picker' = 'heading') => {
    requestAnimationFrame(() => {
      const targetId = target === 'heading'
        ? 'import-step-' + step + '-heading'
        : step === 1 ? 'preset-file' : step === 2 ? fileMode === 'folder' ? 'audio-folder' : 'audio-files' : 'import-step-3-heading'
      requestAnimationFrame(() => document.getElementById(targetId)?.focus({ preventScroll: true }))
    })
  }

  const invalidateAutoGeneration = () => {
    autoGenerateGeneration.current += 1
  }

  const resetAutoGeneration = () => {
    invalidateAutoGeneration()
    setAutoGenerate(false)
  }

  const startBuiltInPresetLoad = (presetId: string) => {
    clearLocalImportDraft()
    resetAutoGeneration()
    setActiveSavedSessionId(null)
    setSavedSessionName('')
    setTtmAnnotations({})
    const generation = ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    const controller = new AbortController()
    activePresetLoadRef.current = controller
    presetSourceRef.current = 'builtin'
    activeQuickPresetIdRef.current = presetId
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
        const nextPresetBeatTrimId = createBeatTrimId()

        assetIndexRef.current = nextIndex
        setAssetIndex(nextIndex)
        setAssetResolution(nextResolution)
        setPreset(loaded.preset)
        setPresetBeatTrimId(nextPresetBeatTrimId)
        setBeatTrims((current) => retainedBeatTrimsForPreset(current, nextPresetBeatTrimId, customBeatTrimId))
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
    const nextPresetBeatTrimId = createBeatTrimId()
    clearLocalImportDraft()
    resetAutoGeneration()
    setActiveSavedSessionId(null)
    setSavedSessionName('')
    setTtmAnnotations({})
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    presetSourceRef.current = 'demo'
    activeQuickPresetIdRef.current = 'demo'
    setPresetSource('demo')
    setSelectedPresetId('demo')
    setBootstrapError(null)
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    setIsPresetReady(true)
    setPreset(DEMO_PRESET)
    setPresetBeatTrimId(nextPresetBeatTrimId)
    setBeatTrims((current) => retainedBeatTrimsForPreset(current, nextPresetBeatTrimId, customBeatTrimId))
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
    clearLocalImportDraft()
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    setSelectedPresetId('custom')
    setActiveSection('files')
    if (window.location.hash !== '#files-section') window.history.pushState(null, '', '#files-section')
    requestAnimationFrame(() => {
      const filesSection = document.getElementById('files-section')
      filesSection?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      focusLocalImportTarget(1, importFileMode, 'picker')
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
    const progress = transportSnapshot.tempoTraining
    if (!progress) return
    setBpm(String(progress.currentBpm))
  }, [transportSnapshot.tempoTraining?.currentBpm])

  useEffect(() => {
    const selectSectionFromHash = () => {
      const nextSection = workspaceSectionForHash(window.location.hash)
      if (!nextSection) return
      setActiveSection(nextSection)
      const targetId = window.location.hash.replace(/^#/, '')
      if (targetId === 'workspace') return
      window.requestAnimationFrame(() => {
        const target = targetId ? document.getElementById(targetId) : document.getElementById('panel-practice')
        target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        target?.closest<HTMLElement>('[role="tabpanel"]')?.focus({ preventScroll: true })
      })
    }
    selectSectionFromHash()
    window.addEventListener('hashchange', selectSectionFromHash)
    window.addEventListener('popstate', selectSectionFromHash)
    return () => {
      window.removeEventListener('hashchange', selectSectionFromHash)
      window.removeEventListener('popstate', selectSectionFromHash)
    }
  }, [])

  useEffect(() => {
    if (transportSnapshot.status === 'loading') setTransportNote('Preparing preview audio.')
    if (transportSnapshot.status === 'paused') setTransportNote('Playback paused. Press Resume playback to continue.')
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

  const handleLocalIniChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file || isPlaybackLockedNow()) return

    cancelLocalImportWork()
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    const generation = ++localImportGeneration.current
    setSelectedPresetId('custom')
    setStagedIniFile(file)
    setStagedIniText(null)
    setStagedPreset(null)
    setStagedAudioFiles([])
    setPreparedLocalImport(null)
    setLocalImportError(null)
    setLocalImportSelectionNote(null)
    setImportStep(1)
    if (!file.name.toLowerCase().endsWith('.ini')) {
      setLocalImportError('Choose a file ending in .ini for the legacy preset.')
      return
    }
    if (file.size > MAX_LOCAL_INI_BYTES) {
      setLocalImportError('This INI is larger than 1 MiB. Choose the original preset file or a smaller copy.')
      return
    }

    setIsPreparingLocalImport(true)
    void file.text()
      .then((text) => {
        if (generation !== localImportGeneration.current) return
        const nextPreset = parseLegacyIni(text)
        const referenceCount = nextPreset.samples.length + nextPreset.beatFiles.length
        if (referenceCount > MAX_LOCAL_IMPORT_REFERENCES) {
          throw new Error('This INI has more than ' + MAX_LOCAL_IMPORT_REFERENCES + ' sample and beat references. Choose a smaller preset file.')
        }
        setStagedIniText(text)
        setStagedPreset(nextPreset)
        setLocalImportError(null)
        setImportStep(2)
        focusLocalImportTarget(2)
      })
      .catch((error: unknown) => {
        if (generation !== localImportGeneration.current) return
        setLocalImportError('Could not read ' + file.name + ': ' + describeError(error) + ' Choose a valid legacy INI to try again.')
      })
      .finally(() => {
        if (generation === localImportGeneration.current) setIsPreparingLocalImport(false)
      })
  }

  const handleLocalAudioSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const fileList = input.files
    const selectedFileCount = fileList?.length ?? 0
    if (selectedFileCount > MAX_SELECTED_AUDIO_FILE_COUNT) {
      input.value = ''
      if (isPlaybackLockedNow() || !stagedPreset) return
      setStagedAudioFiles([])
      setPreparedLocalImport(null)
      setLocalImportError('This selection contains more than ' + MAX_SELECTED_AUDIO_FILE_COUNT.toLocaleString() + ' files. Choose a smaller folder or select WAV files instead.')
      setLocalImportSelectionNote(null)
      return
    }
    // Copy the browser-owned FileList before clearing the input so the staged files remain stable.
    const chosenFiles = Array.from(fileList ?? [])
    input.value = ''
    if (isPlaybackLockedNow() || !stagedPreset) return
    if (chosenFiles.length === 0) {
      setStagedAudioFiles([])
      setPreparedLocalImport(null)
      setLocalImportSelectionNote(null)
      setLocalImportError('No WAV files were found in that selection. Choose another folder or use the file picker.')
      return
    }
    const wavFiles = chosenFiles.filter((file) => file.name.toLowerCase().endsWith('.wav'))
    const ignoredCount = chosenFiles.length - wavFiles.length
    setStagedAudioFiles(wavFiles)
    setPreparedLocalImport(null)
    setLocalImportError(wavFiles.length === 0
      ? 'No .wav files were found in that selection. Choose another folder or use the file picker.'
      : null)
    setLocalImportSelectionNote(ignoredCount > 0
      ? ignoredCount + ' non-WAV ' + (ignoredCount === 1 ? 'file was' : 'files were') + ' ignored. Only referenced WAV files are copied into session memory.'
      : null)
  }

  const handleReviewLocalImport = () => {
    if (isPlaybackLockedNow() || !stagedIniFile || !stagedIniText || !stagedPreset) return

    cancelLocalImportWork()
    const generation = ++localImportGeneration.current
    const controller = new AbortController()
    localImportController.current = controller
    const audioIndex = buildAssetIndex(stagedAudioFiles)
    const resolution = resolvePresetAssets(stagedPreset, audioIndex)
    const baseChecks = referenceChecksForImport(stagedPreset, resolution)
    const requiredMissing = baseChecks.filter((check) => check.required && check.resolution.status !== 'resolved')
    const base: PreparedLocalImport = {
      iniFileName: stagedIniFile.name,
      iniText: stagedIniText,
      preset: stagedPreset,
      resolution,
      snapshotResolution: resolution,
      snapshotFiles: [],
      selectedAudioFileCount: stagedAudioFiles.length,
      checks: baseChecks,
      copiedFileCount: 0,
      copiedBytes: 0,
      decodedFileCount: 0,
      decodeAttemptCount: 0,
      canLoad: false,
      applied: false,
      blockedMessage: null,
    }
    setLocalImportError(null)
    setPreparedLocalImport(null)
    setIsPreparingLocalImport(true)
    setImportStep(3)
    focusLocalImportTarget(3)

    const referencedFiles = resolvedReferencedFiles(resolution)
    const decodeFiles = [
      ...stagedPreset.samples
        .filter(requiredImportSample)
        .flatMap((sample) => {
          const asset = resolution.samplesById.get(sample.id)
          return asset?.status === 'resolved' && asset.file ? [asset.file] : []
        }),
      ...resolution.beats.flatMap((asset) => asset.status === 'resolved' && asset.file ? [asset.file] : []),
    ]

    void (async () => {
      try {
        const snapshot = await snapshotReferencedWavFiles(referencedFiles, {
          decodeFiles,
          signal: controller.signal,
        })
        if (generation !== localImportGeneration.current) return
        const snapshotResolution = mapPresetResolutionToSnapshots(
          resolution,
          snapshot.filesBySource,
          snapshot.validationBySource,
        )
        const checks = referenceChecksForImport(stagedPreset, resolution, snapshot.validationBySource)
        const requiredDecodeFailures = checks.filter((check) => check.required && check.validation?.status === 'invalid')
        const failed = requiredDecodeFailures[0]
        const blockedMessage = requiredMissing.length > 0
          ? requiredDecodeFailures.length > 0
            ? 'Resolve missing or ambiguous sample references and replace any required WAVs that failed decoding before loading this preset.'
            : 'Resolve the missing or ambiguous WAV files for enabled, audible samples before loading this preset.'
          : failed
            ? (failed.resolution.selectedPath ?? failed.requested) + ': this required sample WAV could not be decoded. ' + (failed.validation?.status === 'invalid' ? failed.validation.message : '') + ' Choose a valid WAV, then review the selection again.'
            : null
        const prepared: PreparedLocalImport = {
          ...base,
          resolution,
          snapshotResolution,
          snapshotFiles: resolvedReferencedFiles(snapshotResolution),
          checks,
          copiedFileCount: snapshot.copiedFileCount,
          copiedBytes: snapshot.copiedBytes,
          decodedFileCount: snapshot.decodedFileCount,
          decodeAttemptCount: snapshot.decodeAttemptCount,
          canLoad: requiredMissing.length === 0 && requiredDecodeFailures.length === 0,
          blockedMessage,
        }
        setPreparedLocalImport(prepared)
      } catch (error) {
        if (controller.signal.aborted || generation !== localImportGeneration.current) return
        setPreparedLocalImport({
          ...base,
          checks: referenceChecksForImport(stagedPreset, resolution),
          blockedMessage: snapshotErrorForImport(error, resolution),
        })
      } finally {
        if (generation === localImportGeneration.current) {
          setIsPreparingLocalImport(false)
          if (localImportController.current === controller) localImportController.current = undefined
        }
      }
    })()
  }

  const handleLocalImportBack = () => {
    if (isPreparingLocalImport) cancelLocalImportWork()
    if (importStep === 3) {
      setPreparedLocalImport(null)
      setLocalImportError(null)
      setImportStep(2)
      focusLocalImportTarget(2, importFileMode, 'picker')
    } else if (importStep === 2) {
      setLocalImportError(null)
      setImportStep(1)
      focusLocalImportTarget(1, importFileMode, 'picker')
    }
  }

  const handleLocalImportCancel = () => {
    clearLocalImportDraft(true)
    focusLocalImportTarget(1, importFileMode, 'picker')
  }

  const handleStartAnotherLocalImport = () => {
    if (isPlaybackLockedNow()) return
    clearLocalImportDraft(true)
    focusLocalImportTarget(1, importFileMode, 'picker')
  }

  const handleLoadLocalImport = () => {
    const prepared = preparedLocalImport
    if (!prepared?.canLoad || prepared.applied || isPlaybackLockedNow()) return

    const nextIndex = buildAssetIndex(prepared.snapshotFiles)
    let generated: ReturnType<typeof legacyFixtureFor> | null = null
    let generationNote: string | null = null
    try {
      generated = legacyFixtureFor(prepared.preset, DEFAULT_COMBO_BEATS * LEGACY_TICKS_PER_BEAT)
    } catch (error) {
      const hasEligibleSample = prepared.preset.samples.some(requiredImportSample)
      generationNote = hasEligibleSample
        ? 'The preset loaded, but its default 8-beat combo could not be prepared: ' + describeError(error) + ' Choose a compatible combo length or adjust sample settings, then generate.'
        : 'The preset loaded without an initial combo because it has no eligible audible samples. Adjust sample settings before generating.'
    }
    const firstReadyBeat = prepared.snapshotResolution.beats.findIndex((asset) => asset.status === 'resolved' && Boolean(asset.file))
    const nextTempo = String(initialPracticeTempo(prepared.preset.bpm, customBeatSelected ? customBeatReferenceBpm : null))
    const nextPresetBeatTrimId = createBeatTrimId()

    resetAutoGeneration()
    setActiveSavedSessionId(null)
    setSavedSessionName('')
    setTtmAnnotations({})
    ++presetImportGeneration.current
    activePresetLoadRef.current?.abort()
    activePresetLoadRef.current = undefined
    assetIndexRef.current = nextIndex
    presetSourceRef.current = 'custom'
    activeQuickPresetIdRef.current = 'custom'
    setPresetSource('custom')
    setSelectedPresetId('custom')
    setIsBootstrapLoading(false)
    setIsReadingPreset(false)
    setIsPresetReady(true)
    setPreset(prepared.preset)
    setPresetBeatTrimId(nextPresetBeatTrimId)
    setBeatTrims((current) => retainedBeatTrimsForPreset(current, nextPresetBeatTrimId, customBeatTrimId))
    setPresetFileName(prepared.iniFileName)
    setSourceIniText(prepared.iniText)
    setEditingSample(null)
    setIsSavingIni(false)
    setSaveIniError(null)
    setBootstrapError(null)
    setAssetIndex(nextIndex)
    setLocalWavFiles(prepared.snapshotFiles)
    setAssetResolution(prepared.snapshotResolution)
    setFixture(generated?.fixture ?? null)
    setTimebase('legacy')
    setComboBeats(DEFAULT_COMBO_BEATS)
    setOmittedZeroDurationCount(generated?.zeroDurationCount ?? 0)
    setBpm(nextTempo)
    setPitchSemitones(0)
    setSampleVolume(prepared.preset.sampleVolume)
    setBeatVolume(prepared.preset.beatVolume)
    setSelectedBeatIndex(firstReadyBeat >= 0 ? String(firstReadyBeat) : 'none')
    sourceControlDefaultsRef.current = {
      bpm: prepared.preset.bpm,
      sampleVolume: prepared.preset.sampleVolume,
      beatVolume: prepared.preset.beatVolume,
    }
    setActionError(null)
    setPlaybackTarget(null)
    transport.resetAssets()
    transport.stop()
    transport.setPitchSemitones(0)
    transport.setSampleVolume(prepared.preset.sampleVolume)
    transport.setBeatVolume(prepared.preset.beatVolume)
    const resolvedSamples = Array.from(prepared.snapshotResolution.samplesById.values()).filter((item) => item.status === 'resolved').length
    const resolvedBeats = prepared.snapshotResolution.beats.filter((item) => item.status === 'resolved').length
    setImportMessage(prepared.preset.name + ' loaded. ' + resolvedSamples + ' sample WAVs and ' + resolvedBeats + ' preset beats are available in this session.')
    setTransportNote(generationNote ?? (generated ? 'Preset loaded. Combo generated; ready to play.' : 'Preset loaded. Generate a combo when ready.'))
    const appliedChecks = mappedReferenceChecks(prepared.checks, prepared.snapshotResolution)
    setPreparedLocalImport({
      ...prepared,
      iniText: '',
      resolution: prepared.snapshotResolution,
      checks: appliedChecks,
      applied: true,
    })
    setStagedIniFile(null)
    setStagedIniText(null)
    setStagedAudioFiles([])
    setStagedPreset(prepared.preset)
    if (generationNote) setActionError(generationNote)
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
    if (!file || !customBeatSelected || isPlaybackLockedNow() || isCustomBeatAnalysisBusy) return

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
    if (isPlaybackLockedNow() || isCustomBeatAnalysisBusy || !customBeatSelected || !customBeatCandidate?.buffer) return
    const referenceBpm = Number(customBeatCandidateBpm)
    const tempoRange = getTempoRange(preset.bpm, referenceBpm)
    if (!Number.isFinite(referenceBpm) || referenceBpm < 1 || !tempoRange) return

    const practiceTempo = Math.min(tempoRange.max, Math.max(tempoRange.min, referenceBpm))
    const nextCustomBeatTrimId = createBeatTrimId()
    setCustomBeatFile(customBeatCandidate.file)
    setCustomBeatBuffer(customBeatCandidate.buffer)
    setCustomBeatTrimId(nextCustomBeatTrimId)
    setBeatTrims((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key.startsWith('preset:'))))
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
    const activeTransport = transport.getSnapshot()
    const isPausedCountIn = activeTransport.status === 'paused' && activeTransport.pausedFrom === 'counting-in'
    if (activeTransport.status === 'counting-in' || isPausedCountIn) return
    const tempoCanChangeLive = activeTransport.status === 'playing' || activeTransport.status === 'loading'
      || (activeTransport.status === 'paused' && activeTransport.pausedFrom === 'playing')
    const liveTempoTraining = tempoCanChangeLive
      ? activeTransport.tempoTraining
      : undefined
    setBpm(value)
    const nextBpm = Number(value)
    const nextTempoValid = selectedTempoRange !== null
      && Number.isFinite(nextBpm)
      && nextBpm >= selectedTempoRange.min
      && nextBpm <= selectedTempoRange.max
    if (liveTempoTraining) {
      transport.setTempo(nextTempoValid ? nextBpm : liveTempoTraining.currentBpm)
      setTempoTrainingCancelledNotice(
        'Tempo training stopped at ' + (nextTempoValid ? nextBpm : liveTempoTraining.currentBpm) + ' BPM. Press Play to restart from this tempo.',
      )
    } else if (nextTempoValid && tempoCanChangeLive) {
      transport.setTempo(nextBpm)
      if (tempoTrainingCancelledNotice) {
        setTempoTrainingCancelledNotice('Tempo training stopped at ' + nextBpm + ' BPM. Press Play to restart from this tempo.')
      }
    }
    if (nextTempoValid) {
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

  const handleCountInBarsChange = (value: CountInBars) => {
    if (isPlaybackLockedNow() || ![0, 1, 2].includes(value)) return
    setCountInBars(value)
    setTransportNote(value === 0
      ? 'Count-in is off. Play the sequence to start immediately.'
      : 'Count-in set to ' + value + ' ' + (value === 1 ? 'bar' : 'bars') + ' before the sequence.')
  }

  const handleMetronomeEnabledChange = (enabled: boolean) => {
    if (isPlaybackLockedNow() || enabled === metronomeEnabled) return
    setMetronomeEnabled(enabled)
    setTransportNote(enabled
      ? 'Metronome enabled. Clicks will continue through the sequence.'
      : 'Metronome disabled. Any selected count-in will still click.')
  }

  const handleMetronomeVolumeChange = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 100) return
    const nextVolume = Math.round(value)
    setMetronomeVolume(nextVolume)
    transport.setMetronomeVolume(nextVolume)
  }

  const updateTempoTrainingSettings = (change: Partial<TempoTrainingSettings>) => {
    if (isPlaybackLockedNow() || isReadingPreset || isGenerating || isSavingIni || isCustomBeatAnalysisBusy || savedLibraryBusy) return
    setTempoTraining((current) => {
      const next = { ...current, ...change }
      return isValidTempoTrainingSettings(next) ? next : current
    })
  }

  const handleResetSessionControls = () => {
    const activeTransport = transport.getSnapshot()
    if (activeTransport.status === 'counting-in' || (activeTransport.status === 'paused' && activeTransport.pausedFrom === 'counting-in')) return
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
    setMetronomeVolume(60)
    if (activeTransport.status === 'playing' || activeTransport.status === 'loading' || (activeTransport.status === 'paused' && activeTransport.pausedFrom === 'playing')) {
      transport.setTempo(resetBpmValue)
      if (activeTransport.tempoTraining) {
        setTempoTrainingCancelledNotice('Tempo training stopped at ' + resetBpmValue + ' BPM. Press Play to restart from this tempo.')
      }
    }
    transport.setPitchSemitones(0)
    transport.setSampleVolume(defaults.sampleVolume)
    transport.setBeatVolume(defaults.beatVolume)
    transport.setMetronomeVolume(60)
    setActionError(null)
    setTransportNote(customRange
      ? 'Controls reset. Practice tempo is ' + resetBpmValue + ' BPM for the selected custom beat. Playback continues.'
      : 'Controls reset to the selected preset defaults. Playback continues.')
  }

  const handleBeatSelectionChange = (value: string) => {
    if (isPlaybackLockedNow() || isCustomBeatAnalysisBusy) return
    if (value === 'custom') {
      if (customBeatSelected) return
      if (!customBeatFile || !customBeatBuffer || customBeatReferenceBpm === null) {
        setCustomBeatSelected(true)
        setActionError(null)
        setTransportNote('Custom beat source selected. No custom beat is applied yet; sample-only playback remains available.')
        return
      }
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

  const handleApplyBeatTrim = (region: SavedBeatTrimRegion, decodedDurationSeconds: number) => {
    if (isPlaybackLockedNow() || savedLibraryBusy || !activeBeatTrimKey) return
    const { startOffsetSeconds, loopEndSeconds } = region
    const endSeconds = loopEndSeconds ?? decodedDurationSeconds
    if (!Number.isFinite(decodedDurationSeconds) || decodedDurationSeconds <= 0 || decodedDurationSeconds > 600
      || !Number.isFinite(startOffsetSeconds) || startOffsetSeconds < 0
      || !Number.isFinite(endSeconds) || endSeconds <= startOffsetSeconds || endSeconds > decodedDurationSeconds + 0.000001) return

    const normalizedRegion: SavedBeatTrimRegion = {
      startOffsetSeconds,
      loopEndSeconds: loopEndSeconds === null || endSeconds >= decodedDurationSeconds - 0.000001 ? null : endSeconds,
    }
    setBeatTrims((current) => {
      if (normalizedRegion.startOffsetSeconds === 0 && normalizedRegion.loopEndSeconds === null) {
        const next = { ...current }
        delete next[activeBeatTrimKey]
        return next
      }
      return { ...current, [activeBeatTrimKey]: normalizedRegion }
    })
    setActionError(null)
    setTransportNote(normalizedRegion.startOffsetSeconds === 0 && normalizedRegion.loopEndSeconds === null
      ? 'Full-clip playback selected for ' + (beatTrimSourceName ?? 'the selected beat') + '. The next Play will use the whole clip.'
      : 'Manual cue and loop trim applied to ' + (beatTrimSourceName ?? 'the selected beat') + '. Playback will use this region on the next Play.')
  }

  const handleResetBeatTrim = () => {
    if (isPlaybackLockedNow() || savedLibraryBusy || !activeBeatTrimKey) return
    setBeatTrims((current) => {
      if (!(activeBeatTrimKey in current)) return current
      const next = { ...current }
      delete next[activeBeatTrimKey]
      return next
    })
    setActionError(null)
    setTransportNote('Manual trim cleared for ' + (beatTrimSourceName ?? 'the selected beat') + '. The full beat clip will play next time.')
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
    if (target?.kind === 'sequence' && presetFileName && tempoTraining.enabled && tempoTrainingError) {
      setActionError(tempoTrainingError)
      setTransportNote('Correct the tempo trainer settings in Session before starting this run.')
      return
    }
    const bpmValue = Number(bpm)
    const beatReferenceBpm = includeBeat && customBeatSelected ? customBeatReferenceBpm : null
    const tempoRange = getTempoRange(preset.bpm, beatReferenceBpm)
    if (includeBeat && customBeatSelected && customBeatBuffer && (!customBeatReferenceInputValid || customBeatReferenceBpm === null)) {
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
    setTempoTrainingCancelledNotice('')
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
      ...(target?.kind === 'sequence' ? { countInBars, metronomeEnabled, metronomeVolume } : {}),
      ...(target?.kind === 'sequence' && presetFileName && tempoTraining.enabled
        ? { tempoTraining: { targetBpm: tempoTraining.targetBpm, stepBpm: tempoTraining.stepBpm, roundsPerStep: tempoTraining.roundsPerStep } }
        : {}),
      ...(includeBeat && selectedBeatFile ? { beatFile: selectedBeatFile } : {}),
      ...(includeBeat && activeBeatTrim ? { beatPlaybackRegion: activeBeatTrim } : {}),
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
    setTempoTrainingCancelledNotice('')
    setActionError(null)
    setTransportNote('Playback stopped.')
  }
  const handleTogglePlayback = () => {
    const status = transport.getSnapshot().status
    if (status === 'paused') {
      setActionError(null)
      void transport.resume().catch((error: unknown) => {
        setActionError('Playback could not resume: ' + describeError(error))
      })
      return
    }
    if (status === 'playing' || status === 'counting-in') {
      setActionError(null)
      void transport.pause().catch((error: unknown) => {
        setActionError('Playback could not pause: ' + describeError(error))
      })
      return
    }
    handlePlaySequence()
  }

  const tempoTrainingBlockingError = tempoTraining.enabled && Boolean(presetFileName) ? tempoTrainingError : null
  const playDisabled = transportSnapshot.status === 'disposed' || !isPresetReady || !fixture || isReadingPreset || isGenerating || isCustomBeatAnalysisBusy || isPlaybackLocked || autoGenerateBlocked || !customBeatReferenceInputValid || !sessionTempoValid || Boolean(tempoTrainingBlockingError) || savedLibraryBusy
  const stopDisabled = transportSnapshot.status !== 'playing' && transportSnapshot.status !== 'loading' && !isCountInActive && transportSnapshot.status !== 'paused'
  const pauseResumeDisabled = transportSnapshot.status === 'loading' || transportSnapshot.status === 'disposed'
    ? true
    : transportSnapshot.status === 'playing' || isCountInActive || transportSnapshot.status === 'paused'
      ? false
      : playDisabled || isReadingPreset
  const playbackActionLabel = transportSnapshot.status === 'paused'
    ? 'Resume playback'
    : transportSnapshot.status === 'playing' || isCountInActive
      ? 'Pause playback'
      : 'Play sequence'
  const isSequencePlaying = playbackTarget?.kind === 'sequence' && (transportSnapshot.status === 'playing' || transportSnapshot.status === 'paused')
  const displayedProgress = transportSnapshot.status === 'playing' || transportSnapshot.status === 'paused' ? presentation?.progress : undefined
  const progressPercent = isCountInSuspended
    ? 0
    : transportSnapshot.status === 'completed'
    ? 1
    : Math.max(0, Math.min(1, displayedProgress ?? transportSnapshot.progress))
  const timelineProgressPercent = isCountInSuspended
    ? 0
    : presentation?.started && fixture
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
  const currentPresetName = !isPresetReady
    ? presetSource === 'loading' ? 'Loading built-in preset' : 'No ready preset'
    : preset.name || activeBuiltInEntry?.label || 'Current preset'
  const visibleStagedIniName = stagedIniFile?.name ?? preparedLocalImport?.iniFileName ?? null
  const visibleStagedPresetName = stagedPreset?.name ?? preparedLocalImport?.preset.name ?? null
  const visibleStagedAudioCount = stagedAudioFiles.length || preparedLocalImport?.selectedAudioFileCount || 0
  const sessionControlsDisabled = !isPresetReady || isReadingPreset || isGenerating || isSavingIni || isCustomBeatAnalysisBusy || savedLibraryBusy
  const savedLibraryControlsBusy = savedLibraryBusy || isReadingPreset || isGenerating || isPreparingLocalImport || isPlaybackLocked || isCustomBeatAnalysisBusy || isSavingIni
  const resetControlsDisabled = sessionControlsDisabled || isCountInSuspended
  const tempoTrainingProgressText = transportSnapshot.tempoTraining
    ? transportSnapshot.tempoTraining.goalReached
      ? 'Tempo training · holding at ' + transportSnapshot.tempoTraining.currentBpm + ' BPM · ' + transportSnapshot.tempoTraining.completedRounds + ' full ' + (transportSnapshot.tempoTraining.completedRounds === 1 ? 'round' : 'rounds') + ' completed.'
      : 'Tempo training · ' + transportSnapshot.tempoTraining.currentBpm + ' of ' + transportSnapshot.tempoTraining.targetBpm + ' BPM · '
        + (transportSnapshot.tempoTraining.completedRounds === 0
          ? 'starting tempo'
          : transportSnapshot.tempoTraining.completedRounds + ' full ' + (transportSnapshot.tempoTraining.completedRounds === 1 ? 'round' : 'rounds'))
        + ' · next +' + Math.min(transportSnapshot.tempoTraining.stepBpm, transportSnapshot.tempoTraining.targetBpm - transportSnapshot.tempoTraining.currentBpm) + ' BPM in '
        + (transportSnapshot.tempoTraining.roundsPerStep - transportSnapshot.tempoTraining.roundsIntoStep) + ' full '
        + (transportSnapshot.tempoTraining.roundsPerStep - transportSnapshot.tempoTraining.roundsIntoStep === 1 ? 'round.' : 'rounds.')
    : null
  const transportStatusText = transportSnapshot.status === 'paused'
    ? isCountInPaused && transportSnapshot.countIn
      ? 'Playback paused · count-in beat ' + transportSnapshot.countIn.beat + ' of ' + transportSnapshot.countIn.beats + '.'
      : 'Playback paused. Press Resume playback to continue.'
    : isCountInActive && transportSnapshot.countIn
      ? 'Count-in · beat ' + transportSnapshot.countIn.beat + ' of ' + transportSnapshot.countIn.beats + '.'
      : isCountInActive
        ? 'Count-in in progress.'
        : tempoTrainingProgressText
          ? tempoTrainingProgressText
          : tempoTrainingCancelledNotice && (transportSnapshot.status === 'playing' || transportSnapshot.status === 'loading')
            ? tempoTrainingCancelledNotice
            : tempoTraining.enabled && tempoTrainingError
              ? tempoTrainingError
              : transportNote

  shortcutActionsRef.current = {
    playDisabled: playDisabled || isReadingPreset,
    stopDisabled,
    resetDisabled: resetControlsDisabled,
    play: handlePlaySequence,
    stop: handleStop,
    generate: handleBuildPreview,
    reset: handleResetSessionControls,
  }

  useEffect(() => {
    try { window.localStorage.setItem('scratch-combo-shortcuts', shortcutsEnabled ? 'on' : 'off') } catch { /* Private browsing can disable storage. */ }
  }, [shortcutsEnabled])

  useEffect(() => {
    void refreshSavedLibrary()
  }, [])

  useEffect(() => {
    if (!shortcutsEnabled || shortcutsHelpOpen) return
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || isSingleKeyShortcutTarget(event.target)) return
      const actions = shortcutActionsRef.current
      if (!actions) return
      const key = event.key.toLowerCase()
      if (key === 'p') {
        if (!actions.stopDisabled) {
          event.preventDefault()
          actions.stop()
        } else if (!actions.playDisabled) {
          event.preventDefault()
          actions.play()
        }
      } else if (key === 'g' && !isPlaybackLocked && isPresetReady && !isReadingPreset && !isGenerating) {
        event.preventDefault()
        actions.generate()
      } else if (key === 'r' && !actions.resetDisabled) {
        event.preventDefault()
        actions.reset()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [shortcutsEnabled, shortcutsHelpOpen, isPlaybackLocked, isPresetReady, isReadingPreset, isGenerating])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <aside className="rail" aria-label="Workspace navigation">
        <a className="rail__brand" href="#workspace" aria-label="Scratch Combo workspace"><span aria-hidden="true">SC</span></a>
        <nav className="rail__nav" role="tablist" aria-label="Workspace sections" aria-orientation="vertical">
          {WORKSPACE_TABS.map((tab) => {
            const selected = activeSection === tab.section
            const panelId = tab.section === 'sequence' ? 'panel-practice' : 'panel-' + tab.section
            return (
              <a
                key={tab.section}
                id={tab.id}
                role="tab"
                href={tab.href}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={(event) => {
                  event.preventDefault()
                  setActiveSection(tab.section)
                  if (window.location.hash !== tab.href) window.history.pushState(null, '', tab.href)
                }}
                onKeyDown={(event) => handleWorkspaceTabKeyDown(event, tab.section)}
              >
                <WorkspaceSectionIcon section={tab.section} />
                <span>{tab.label}</span>
              </a>
            )
          })}
        </nav>
        <span className="rail__foot" title="Local browser session">LOCAL</span>
      </aside>

      <main className="workspace" id="workspace">
        <header className="workspace-header">
          <div><h1>Scratch Combo</h1><p>Practice workspace</p></div>
          <div className="session-state"><span className="session-state__dot" aria-hidden="true" /><span>Local browser workspace</span></div>
        </header>

        <section className="transport-dock" aria-label="Playback controls">
          <div className="transport-dock__actions">
            <button className="button button--play" type="button" onClick={handleTogglePlayback} disabled={pauseResumeDisabled}>
              {transportSnapshot.status === 'playing' || isCountInActive
                ? <span className="pause-glyph" aria-hidden="true"><span /><span /></span>
                : <span className="play-glyph" aria-hidden="true" />}{playbackActionLabel}
            </button>
            <button className="button button--stop" type="button" onClick={handleStop} disabled={stopDisabled}>
              <span className="stop-glyph" aria-hidden="true" />Stop
            </button>
            <button
              ref={keyboardHelpButtonRef}
              className="button transport-dock__help"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={shortcutsHelpOpen}
              onClick={() => setShortcutsHelpOpen(true)}
            >Keyboard shortcuts</button>
          </div>
          <div className="transport-dock__meter">
            <progress value={progressPercent} max="1" aria-label="Preview progress" />
            <span id="tempo-training-status" className="transport-status" role="status" aria-live="polite" aria-atomic="true">{transportStatusText}</span>
          </div>
          {isPlaybackLocked && <p className="playback-lock-note" role="status">Stop playback to change combo options, beat source, or sample settings.</p>}
          {isCustomBeatAnalysisBusy && <p className="playback-lock-note" role="status">Custom beat is loading locally. Playback will stay stopped until analysis finishes.</p>}
          {actionError && <p className="inline-error" role="alert">{actionError}</p>}
          {transportSnapshot.status === 'error' && <p className="inline-error" role="alert">{transportSnapshot.error ?? 'Audio could not start.'}</p>}
        </section>
        <KeyboardShortcutsDialog
          open={shortcutsHelpOpen}
          shortcutsEnabled={shortcutsEnabled}
          onToggleShortcuts={setShortcutsEnabled}
          onClose={() => setShortcutsHelpOpen(false)}
          returnFocus={() => keyboardHelpButtonRef.current?.focus()}
        />

        <div id="panel-practice" role="tabpanel" aria-labelledby="tab-practice" tabIndex={0} hidden={activeSection !== 'sequence'}>
        <section id="sequence-section" className="workspace-section sequence-section" aria-labelledby="sequence-heading">
          <div className="section-heading sequence-heading">
            <div><h2 id="sequence-heading">{!isPresetReady ? 'Starting workspace' : isImportedPreset ? 'Generated combo' : 'Sequence preview'}</h2><p>{isPresetReady ? preset.name + ' / ' + (isImportedPreset ? (fixture ? fixture.totalUnits : comboLengthTicks) + ' legacy ticks' : 'fixed ' + TARGET_UNITS + '-unit window') : activeBuiltInEntry?.label ?? 'Built-in practice preset'}{fixture && omittedZeroDurationCount > 0 && <small className="sequence-note">{omittedZeroDurationCount} zero-length {omittedZeroDurationCount === 1 ? 'selection was' : 'selections were'} omitted from audio preview.</small>}</p></div>
            <div className="sequence-actions">
              {isImportedPreset && (
                <label className="combo-length-control" htmlFor="combo-length">
                  <span>Combo length</span>
                  <select id="combo-length" value={comboBeats} onChange={(event) => handleComboLengthChange(event.currentTarget.value)} disabled={!isPresetReady || isReadingPreset || isGenerating || isPlaybackLocked || savedLibraryBusy}>
                    {COMBO_BEAT_OPTIONS.map((beats) => <option key={beats} value={beats}>{beats} Beats</option>)}
                  </select>
                </label>
              )}
              <button className="button button--primary" type="button" onClick={handleBuildPreview} disabled={!isPresetReady || isReadingPreset || isGenerating || isPlaybackLocked || savedLibraryBusy}>
                {isGenerating ? 'Generating…' : isImportedPreset ? 'Generate combo' : 'Build preview'}
              </button>
            </div>
          </div>
          <QuickPresetControl
            builtInCatalog={builtInCatalog}
            selectedPresetId={selectedPresetId}
            locked={isPlaybackLocked || isReadingPreset || savedLibraryBusy}
            isBootstrapLoading={isBootstrapLoading}
            onChange={handleBuiltInPresetChange}
          />
          <PracticeLibrary
            sessionName={savedSessionName}
            favoriteName={favoriteComboName}
            sessions={savedLibrary.sessions}
            favorites={savedLibrary.favorites}
            lastSavedSessionId={savedLibrary.lastSavedSessionId}
            selectedSessionId={selectedSavedSessionId}
            selectedFavoriteId={selectedFavoriteId}
            currentSessionName={currentPresetName}
            busy={savedLibraryControlsBusy}
            canSave={isPresetReady}
            available={savedLibraryAvailable}
            hasFixture={Boolean(fixture)}
            message={savedLibraryMessage}
            error={savedLibraryError}
            onSessionNameChange={setSavedSessionName}
            onFavoriteNameChange={setFavoriteComboName}
            onSelectedSessionChange={setSelectedSavedSessionId}
            onSelectedFavoriteChange={setSelectedFavoriteId}
            onSaveSession={() => { void handleSaveSession() }}
            onSaveSessionAsNew={() => { void handleSaveSession(true) }}
            onLoadSession={handleLoadSelectedSession}
            onReloadLast={handleReloadLastSession}
            onDeleteSession={() => { void handleDeleteSelectedSavedItem('session') }}
            onSaveFavorite={() => { void handleSaveFavorite() }}
            onLoadFavorite={handleLoadSelectedFavorite}
            onDeleteFavorite={() => { void handleDeleteSelectedSavedItem('favorite') }}
          />
          <details className="preview-help">
            <summary>About this preview</summary>
            {isImportedPreset
              ? <p>Selection follows the recovered weighted, direction, and repeat rules. This browser uses quantized 24-bit random draws; the original VB6 time-seeded sequence is not reproduced. Playback follows the exact BPM clock in Web Audio, not Windows timer intervals or their jitter.</p>
              : <p>Fixed preview; legacy generator not recovered. This ordered fixture fills a 32-unit window for practice and transport review.</p>}
          </details>
          <div className="practice-settings">
            <PracticePrepControls
              countInBars={countInBars}
              metronomeEnabled={metronomeEnabled}
              metronomeVolume={metronomeVolume}
              settingsDisabled={!isPresetReady || isReadingPreset || isGenerating || isPlaybackLocked || savedLibraryBusy}
              onCountInBarsChange={handleCountInBarsChange}
              onMetronomeEnabledChange={handleMetronomeEnabledChange}
              onMetronomeVolumeChange={handleMetronomeVolumeChange}
            />
            {isImportedPreset && (
              <PracticeCycleControls
                mode={practiceMode}
                largePause={largePause}
                disabled={isReadingPreset || isGenerating || isPlaybackLocked || savedLibraryBusy}
                autoGenerate={autoGenerate}
                autoGenerateRounds={autoGenerateRounds}
                autoGenerateHint={autoGenerateHint}
                onModeChange={handlePracticeModeChange}
                onLargePauseChange={handleLargePauseChange}
                onAutoGenerateChange={handleAutoGenerateChange}
                onAutoGenerateRoundsChange={handleAutoGenerateRoundsChange}
              />
            )}
          </div>
          {fixture
            ? <SequenceTimeline
                fixture={fixture}
                preset={preset}
                assets={sampleAssets}
                progress={timelineProgressPercent}
                isPlaying={timelineIsPlaying}
                isPaused={transportSnapshot.status === 'paused'}
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
                ttmAnnotations={ttmAnnotations}
                onViewChange={(view) => { if (import.meta.env.DEV) setTimelineView(view) }}
                onLayoutChange={setTimelineLayout}
              />
            : <div className="sequence-empty" role="status" aria-live="polite">
                <strong>{isBootstrapLoading ? 'Loading built-in preset' : isReadingPreset ? 'Reading preset' : !isPresetReady ? 'Preset is not ready' : isImportedPreset ? 'Generate a combo to preview the sequence' : 'Build a preview to see the sequence'}</strong>
                <span>{isBootstrapLoading ? 'The selected INI and every referenced WAV must load before playback is enabled.' : isReadingPreset ? 'The previous sequence was cleared while the local file is read.' : !isPresetReady ? 'Retry the built-in preset or choose a valid custom INI in Local files.' : isImportedPreset ? comboBeats + ' beats · ' + comboLengthTicks + ' legacy ticks' : 'The fixed demo uses synthetic sounds.'}</span>
              </div>}
        </section>
        </div>

        <div id="panel-files" role="tabpanel" aria-labelledby="tab-files" tabIndex={0} hidden={activeSection !== 'files'}>
        <ImportWizard
          step={importStep}
          fileMode={importFileMode}
          stagedIniFileName={visibleStagedIniName}
          stagedPresetName={visibleStagedPresetName}
          stagedAudioCount={visibleStagedAudioCount}
          currentPresetName={currentPresetName}
          currentAudioCount={activeWavCount}
          busy={isPreparingLocalImport}
          wizardError={localImportError}
          selectionNote={localImportSelectionNote}
          prepared={preparedLocalImport}
          locked={isPlaybackLocked || savedLibraryBusy || isReadingPreset}
          isBootstrapLoading={isBootstrapLoading}
          bootstrapError={bootstrapError}
          onRetryBuiltIn={handleRetryBuiltIn}
          onIniChange={handleLocalIniChange}
          onAudioChange={handleLocalAudioSelection}
          onFileModeChange={(mode) => { setImportFileMode(mode); focusLocalImportTarget(2, mode, 'picker') }}
          onBack={handleLocalImportBack}
          onCancel={handleLocalImportCancel}
          onReviewEmptySelection={handleReviewLocalImport}
          onLoad={handleLoadLocalImport}
          onStartAnother={handleStartAnotherLocalImport}
        />
        {assetResolution && <DiagnosticList diagnostics={diagnostics} />}
        </div>

        <div id="panel-session" role="tabpanel" aria-labelledby="tab-session" tabIndex={0} hidden={activeSection !== 'session'}>
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
          beatTrimSourceKey={activeBeatTrimKey}
          beatTrimSourceName={beatTrimSourceName}
          beatTrimSourceReferenceBpm={customBeatSelected
            ? customBeatFile && customBeatReferenceBpm !== null ? customBeatReferenceBpm : null
            : selectedBeatFile ? preset.bpm : null}
          beatTrimSourceFile={customBeatSelected ? customBeatFile : selectedBeatFile ?? null}
          beatTrimSourceBuffer={customBeatSelected ? customBeatBuffer : null}
          beatTrim={activeBeatTrim}
          tempoTraining={tempoTraining}
          tempoTrainingDisabled={!isPresetReady || isReadingPreset || isGenerating || isSavingIni || isCustomBeatAnalysisBusy || savedLibraryBusy || isPlaybackLocked}
          repeatingPracticeAvailable={Boolean(presetFileName)}
          disabled={sessionControlsDisabled}
          tempoLocked={isCountInSuspended}
          resetDisabled={resetControlsDisabled}
          beatSelectionDisabled={isPlaybackLocked || isCustomBeatAnalysisBusy || savedLibraryBusy}
          onBpmChange={handleBpmChange}
          onPitchChange={handlePitchChange}
          onSampleVolumeChange={handleSampleVolumeChange}
          onBeatVolumeChange={handleBeatVolumeChange}
          onBeatSelectionChange={handleBeatSelectionChange}
          onCustomBeatFileChange={handleCustomBeatFileChange}
          onCustomBeatCandidateBpmChange={setCustomBeatCandidateBpm}
          onUseCustomBeat={handleUseCustomBeat}
          onCustomBeatReferenceBpmChange={handleCustomBeatReferenceBpmChange}
          onApplyBeatTrim={handleApplyBeatTrim}
          onResetBeatTrim={handleResetBeatTrim}
          onTempoTrainingEnabledChange={(enabled) => updateTempoTrainingSettings({ enabled })}
          onTempoTrainingTargetChange={(targetBpm) => updateTempoTrainingSettings({ targetBpm })}
          onTempoTrainingStepChange={(stepBpm) => updateTempoTrainingSettings({ stepBpm })}
          onTempoTrainingRoundsChange={(roundsPerStep) => updateTempoTrainingSettings({ roundsPerStep })}
          onReset={handleResetSessionControls}
        />
        </div>

        <div id="panel-samples" role="tabpanel" aria-labelledby="tab-samples" tabIndex={0} hidden={activeSection !== 'samples'}>
        {isPresetReady
          ? <SampleTable
              preset={preset}
              resolution={assetResolution}
              actionsDisabled={isReadingPreset || isGenerating || isSavingIni || isPlaybackLocked || savedLibraryBusy}
              legacyMode={isImportedPreset}
              sourceAvailable={sourceIniText !== null}
              editingSample={editingSample}
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
        </div>

        <footer className="workspace-footer">
          <span>Unsaved files stay in this browser session. Saved audio stays local until deleted or browser storage is cleared.</span>
          <span>Saved audio stays in this browser on this device and is never uploaded; localhost and the hosted site keep separate copies.</span>
        </footer>
      </main>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">{importMessage}</span>
    </div>
  )
}
