import type { Fixture, Preset } from '../domain'
import { DEFAULT_TEMPO_TRAINING_SETTINGS, isValidTempoTrainingSettings, type TempoTrainingSettings } from '../tempo-training'

export type SavedRecordKind = 'session' | 'favorite'
export type SavedPresetSource = 'builtin' | 'custom' | 'demo'
export type SavedTimebase = 'demo' | 'legacy'
export type SavedPracticeMode = 'qa' | 'loop'
export type SavedTimelineView = 'waveform' | 'ttm'
export type SavedTimelineLayout = 'grid' | 'inline'

export interface SavedBeatTrimRegion {
  startOffsetSeconds: number
  loopEndSeconds: number | null
}

export type SavedBeatTrims = Record<string, SavedBeatTrimRegion>

export interface SavedMedia {
  name: string
  type: string
  lastModified: number
  relativePath: string
  size: number
  data: Blob
}

export interface SavedSessionData {
  version: 1
  presetSource: SavedPresetSource
  selectedPresetId: string
  preset: Preset
  fixture: Fixture | null
  timebase: SavedTimebase
  timelineView: SavedTimelineView
  timelineLayout: SavedTimelineLayout
  ttmAnnotations: Record<string, string>
  comboBeats: number
  practiceMode: SavedPracticeMode
  largePause: boolean
  autoGenerate: boolean
  autoGenerateRounds: number
  countInBars: 0 | 1 | 2
  metronomeEnabled: boolean
  metronomeVolume: number
  tempoTraining: TempoTrainingSettings
  omittedZeroDurationCount: number
  presetFileName: string | null
  sourceIniText: string | null
  bpm: string
  pitchSemitones: number
  sampleVolume: number
  beatVolume: number
  selectedBeatIndex: string
  customBeatFile: SavedMedia | null
  customBeatSelected: boolean
  customBeatReferenceBpm: number | null
  customBeatReferenceBpmInput: string
  presetBeatTrimId: string
  customBeatTrimId: string | null
  beatTrims: SavedBeatTrims
  assets: SavedMedia[]
}

export interface SavedRecordSummary {
  id: string
  kind: SavedRecordKind
  name: string
  createdAt: number
  updatedAt: number
  assetBytes: number
  hasFixture: boolean
}

export interface SavedRecord extends SavedRecordSummary {
  snapshot: SavedSessionData
}

export interface SavedLibraryIndex {
  sessions: SavedRecordSummary[]
  favorites: SavedRecordSummary[]
  lastSavedSessionId: string | null
}

export const SESSION_LIBRARY_DB_NAME = 'scratch-combo-sessions-v1'
export const MAX_SAVED_RECORD_BYTES = 320 * 1024 * 1024
export const MAX_SAVED_LIBRARY_BYTES = 512 * 1024 * 1024
export const MAX_SAVED_SESSIONS = 12
export const MAX_FAVORITE_COMBOS = 30
const MAX_ASSETS_PER_RECORD = 256
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_INI_BYTES = 1024 * 1024
const MAX_SAMPLES = 500
const MAX_FIXTURE_EVENTS = 8192
const MAX_BEAT_TRIM_ENTRIES = MAX_ASSETS_PER_RECORD + 1
const MAX_BEAT_TRIM_SECONDS = 600
const DATABASE_VERSION = 1
const RECORDS_STORE = 'records'
const PAYLOADS_STORE = 'payloads'
const META_STORE = 'meta'
const LAST_SESSION_KEY = 'last-session'

export class SessionLibraryError extends Error {
  readonly code: 'unavailable' | 'limit' | 'quota' | 'corrupt' | 'missing' | 'storage'

  constructor(code: SessionLibraryError['code'], message: string) {
    super(message)
    this.name = 'SessionLibraryError'
    this.code = code
  }
}

export function createSavedRecordId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'saved-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}

export function mediaBytes(snapshot: SavedSessionData): number {
  return snapshot.assets.reduce((sum, asset) => sum + asset.size, snapshot.customBeatFile?.size ?? 0)
}

/** Stable identity for a beat ordinal until the loaded preset is replaced. */
export function presetBeatTrimKey(presetTrimId: string, beatIndex: number): string {
  return 'preset:' + presetTrimId + ':' + beatIndex
}

export function customBeatTrimKey(id: string): string {
  return 'custom:' + id
}

export async function listSavedRecords(): Promise<SavedLibraryIndex> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([RECORDS_STORE, META_STORE], 'readonly')
    const complete = transactionComplete(transaction)
    const [records, lastSession] = await Promise.all([
      requestValue(transaction.objectStore(RECORDS_STORE).getAll() as IDBRequest<unknown[]>),
      requestValue(transaction.objectStore(META_STORE).get(LAST_SESSION_KEY) as IDBRequest<{ key: string; recordId: string } | undefined>),
    ])
    await complete
    const summaries = records.filter(isRecordSummary).sort((left, right) => right.updatedAt - left.updatedAt)
    const sessions = summaries.filter((record) => record.kind === 'session')
    const favorites = summaries.filter((record) => record.kind === 'favorite')
    const latest = sessions.find((record) => record.id === lastSession?.recordId) ?? sessions[0]
    return { sessions, favorites, lastSavedSessionId: latest?.id ?? null }
  } finally {
    database.close()
  }
}

export async function loadSavedRecord(id: string): Promise<SavedRecord> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([RECORDS_STORE, PAYLOADS_STORE], 'readonly')
    const complete = transactionComplete(transaction)
    const [summaryValue, payloadValue] = await Promise.all([
      requestValue(transaction.objectStore(RECORDS_STORE).get(id) as IDBRequest<unknown>),
      requestValue(transaction.objectStore(PAYLOADS_STORE).get(id) as IDBRequest<unknown>),
    ])
    await complete
    if (!isRecordSummary(summaryValue) || !isRecordPayload(payloadValue)) {
      throw new SessionLibraryError('missing', 'That saved item is no longer available. Refresh the saved list and try again.')
    }
    if (payloadValue.id !== id || payloadValue.kind !== summaryValue.kind || payloadValue.version !== 1) {
      throw new SessionLibraryError('corrupt', 'That saved item is incomplete or was written by an incompatible version.')
    }
    const snapshot = validateSavedSessionData(payloadValue.snapshot)
    const bytes = mediaBytes(snapshot)
    if (bytes !== summaryValue.assetBytes || bytes > MAX_SAVED_RECORD_BYTES || summaryValue.hasFixture !== Boolean(snapshot.fixture)) {
      throw new SessionLibraryError('corrupt', 'That saved item failed its local integrity check. Delete it and save it again.')
    }
    if (summaryValue.kind === 'favorite' && !snapshot.fixture) {
      throw new SessionLibraryError('corrupt', 'That favourite no longer contains a combo. Delete it and save a combo again.')
    }
    return { ...summaryValue, snapshot }
  } catch (error) {
    throw normalizeStorageError(error)
  } finally {
    database.close()
  }
}

export async function saveSavedRecord(
  input: { id?: string; kind: SavedRecordKind; name: string; snapshot: SavedSessionData },
): Promise<SavedRecordSummary> {
  const snapshot = validateSavedSessionData(input.snapshot)
  const name = input.name.trim()
  if (!name || name.length > 64) throw new SessionLibraryError('limit', 'Enter a name between 1 and 64 characters.')
  if (input.kind === 'favorite' && !snapshot.fixture) {
    throw new SessionLibraryError('limit', 'Generate a combo before saving it as a favourite.')
  }
  const assetBytes = mediaBytes(snapshot)
  if (assetBytes > MAX_SAVED_RECORD_BYTES) {
    throw new SessionLibraryError('limit', 'This item is larger than the 320 MiB per-item storage limit. Remove a large audio file and try again.')
  }

  const id = input.id || createSavedRecordId()
  const database = await openDatabase()
  try {
    return await new Promise<SavedRecordSummary>((resolve, reject) => {
      const transaction = database.transaction([RECORDS_STORE, PAYLOADS_STORE, META_STORE], 'readwrite')
      const records = transaction.objectStore(RECORDS_STORE)
      let failure: unknown
      const request = records.getAll() as IDBRequest<unknown[]>
      request.onsuccess = () => {
        try {
          const existingRecords = request.result.filter(isRecordSummary)
          const existing = existingRecords.find((record) => record.id === id)
          if (existing && existing.kind !== input.kind) {
            throw new SessionLibraryError('storage', 'That save identifier belongs to a different kind of saved item.')
          }
          const count = existingRecords.filter((record) => record.kind === input.kind && record.id !== id).length
          const maximum = input.kind === 'session' ? MAX_SAVED_SESSIONS : MAX_FAVORITE_COMBOS
          if (count >= maximum) {
            const label = input.kind === 'session' ? 'saved sessions' : 'favourite combos'
            throw new SessionLibraryError('limit', `This browser has reached the limit of ${maximum} ${label}. Delete an older item before saving another.`)
          }
          const currentBytes = existingRecords.reduce((sum, record) => sum + (record.id === id ? 0 : record.assetBytes), 0)
          if (currentBytes + assetBytes > MAX_SAVED_LIBRARY_BYTES) {
            throw new SessionLibraryError('limit', 'Saved items are limited to 512 MiB in this browser. Delete an older session or favourite to make room.')
          }
          const now = Date.now()
          const summary: SavedRecordSummary = {
            id,
            kind: input.kind,
            name,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            assetBytes,
            hasFixture: Boolean(snapshot.fixture),
          }
          records.put(summary)
          transaction.objectStore(PAYLOADS_STORE).put({ id, kind: input.kind, version: 1, snapshot })
          if (input.kind === 'session') {
            transaction.objectStore(META_STORE).put({ key: LAST_SESSION_KEY, recordId: id })
          }
          transaction.addEventListener('complete', () => resolve(summary), { once: true })
        } catch (error) {
          failure = error
          try { transaction.abort() } catch { /* The transaction may already be inactive. */ }
        }
      }
      request.onerror = () => {
        failure = request.error
        try { transaction.abort() } catch { /* The transaction may already be inactive. */ }
      }
      transaction.addEventListener('abort', () => reject(normalizeStorageError(failure ?? transaction.error)), { once: true })
      transaction.addEventListener('error', () => {
        failure ??= transaction.error
      }, { once: true })
    })
  } catch (error) {
    throw normalizeStorageError(error)
  } finally {
    database.close()
  }
}

export async function deleteSavedRecord(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([RECORDS_STORE, PAYLOADS_STORE, META_STORE], 'readwrite')
      const records = transaction.objectStore(RECORDS_STORE)
      const request = records.getAll() as IDBRequest<unknown[]>
      let failure: unknown
      request.onsuccess = () => {
        const valid = request.result.filter(isRecordSummary)
        const deleted = valid.find((record) => record.id === id)
        records.delete(id)
        transaction.objectStore(PAYLOADS_STORE).delete(id)
        if (deleted?.kind === 'session') {
          const next = valid
            .filter((record) => record.kind === 'session' && record.id !== id)
            .sort((left, right) => right.updatedAt - left.updatedAt)[0]
          const meta = transaction.objectStore(META_STORE)
          if (next) meta.put({ key: LAST_SESSION_KEY, recordId: next.id })
          else meta.delete(LAST_SESSION_KEY)
        }
      }
      request.onerror = () => {
        failure = request.error
        try { transaction.abort() } catch { /* The transaction may already be inactive. */ }
      }
      transaction.addEventListener('complete', () => resolve(), { once: true })
      transaction.addEventListener('abort', () => reject(normalizeStorageError(failure ?? transaction.error)), { once: true })
    })
  } catch (error) {
    throw normalizeStorageError(error)
  } finally {
    database.close()
  }
}

export function validateSavedSessionData(value: unknown): SavedSessionData {
  if (!isObject(value) || value.version !== 1) throw corrupt('The saved session format is not supported.')
  const candidate = value as Record<string, unknown>
  if (!oneOf(candidate.presetSource, ['builtin', 'custom', 'demo'])
    || !nonEmptyString(candidate.selectedPresetId, 128)
    || !validPreset(candidate.preset)
    || !(candidate.fixture === null || validFixture(candidate.fixture))
    || !oneOf(candidate.timebase, ['demo', 'legacy'])
    || !oneOf(candidate.timelineView, ['waveform', 'ttm'])
    || !oneOf(candidate.timelineLayout, ['grid', 'inline'])
    || !validAnnotations(candidate.ttmAnnotations)
    || !oneOf(candidate.comboBeats, [4, 8, 16, 32])
    || !oneOf(candidate.practiceMode, ['qa', 'loop'])
    || typeof candidate.largePause !== 'boolean'
    || typeof candidate.autoGenerate !== 'boolean'
    || !oneOf(candidate.autoGenerateRounds, [1, 2, 4, 8])
    || !(candidate.countInBars === undefined || oneOf(candidate.countInBars, [0, 1, 2]))
    || !(candidate.metronomeEnabled === undefined || typeof candidate.metronomeEnabled === 'boolean')
    || !(candidate.metronomeVolume === undefined || integer(candidate.metronomeVolume, 0, 100))
    || !(candidate.tempoTraining === undefined || isValidTempoTrainingSettings(candidate.tempoTraining))
    || !integer(candidate.omittedZeroDurationCount, 0, 8192)
    || !(candidate.presetFileName === null || string(candidate.presetFileName, 512))
    || !(candidate.sourceIniText === null || string(candidate.sourceIniText, MAX_INI_BYTES))
    || !string(candidate.bpm, 32)
    || !finite(candidate.pitchSemitones, -12, 12)
    || !integer(candidate.sampleVolume, 0, 100)
    || !integer(candidate.beatVolume, 0, 100)
    || !string(candidate.selectedBeatIndex, 8)
    || !(candidate.customBeatFile === null || validMedia(candidate.customBeatFile))
    || typeof candidate.customBeatSelected !== 'boolean'
    || !(candidate.customBeatReferenceBpm === null || finite(candidate.customBeatReferenceBpm, 1, 1000))
    || !string(candidate.customBeatReferenceBpmInput, 32)
    || !(candidate.presetBeatTrimId === undefined || validTrimId(candidate.presetBeatTrimId))
    || !(candidate.customBeatTrimId === undefined || candidate.customBeatTrimId === null || validTrimId(candidate.customBeatTrimId))
    || !(candidate.beatTrims === undefined || validBeatTrims(candidate.beatTrims))
    || !Array.isArray(candidate.assets)
    || candidate.assets.length > MAX_ASSETS_PER_RECORD
    || !candidate.assets.every(validMedia)) {
    throw corrupt('The saved session contains invalid settings or audio metadata. Delete it and save the session again.')
  }
  const legacyCustomBeatTrimId = candidate.customBeatFile
    ? 'legacy-' + stableHash(candidate.customBeatFile.name + ':' + candidate.customBeatFile.size + ':' + candidate.customBeatFile.lastModified)
    : null
  const legacyPresetBeatTrimId = 'legacy-' + stableHash(JSON.stringify([
    candidate.presetSource,
    candidate.selectedPresetId,
    candidate.presetFileName,
    (candidate.preset as Preset).bpm,
    (candidate.preset as Preset).beatFiles,
  ]))
  const data = {
    ...candidate,
    countInBars: candidate.countInBars === undefined ? 0 : candidate.countInBars,
    metronomeEnabled: candidate.metronomeEnabled === undefined ? false : candidate.metronomeEnabled,
    metronomeVolume: candidate.metronomeVolume === undefined ? 60 : candidate.metronomeVolume,
    tempoTraining: candidate.tempoTraining === undefined ? { ...DEFAULT_TEMPO_TRAINING_SETTINGS } : candidate.tempoTraining,
    presetBeatTrimId: candidate.presetBeatTrimId === undefined ? legacyPresetBeatTrimId : candidate.presetBeatTrimId,
    customBeatTrimId: candidate.customBeatTrimId === undefined ? legacyCustomBeatTrimId : candidate.customBeatTrimId,
    beatTrims: candidate.beatTrims === undefined ? {} : candidate.beatTrims,
  } as unknown as SavedSessionData
  if (!validBeatTrimOwnership(data)) {
    throw corrupt('The saved beat trim refers to a different or unavailable beat source. Delete it and save the session again.')
  }
  const assetBytes = mediaBytes(data)
  if (!Number.isSafeInteger(assetBytes) || assetBytes > MAX_SAVED_RECORD_BYTES) {
    throw corrupt('The saved session exceeds the supported local audio size. Delete it and save a smaller session.')
  }
  if (data.fixture && data.fixture.totalUnits !== (data.timebase === 'demo' ? 32 : data.comboBeats * 16)) {
    throw corrupt('The saved combo length does not match its timeline mode and settings.')
  }
  if (data.customBeatFile && data.customBeatReferenceBpm === null) {
    throw corrupt('The saved custom beat has no confirmed BPM. Delete it and save again after correcting the BPM.')
  }
  if (data.presetFileName !== null && data.sourceIniText === null) {
    throw corrupt('The saved local preset is missing its INI text. Delete it and save again.')
  }
  if (data.presetSource === 'custom' && data.presetFileName === null) {
    throw corrupt('The saved local preset is missing its file name. Delete it and save again.')
  }
  return data
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new SessionLibraryError('unavailable', 'This browser does not provide local saved-item storage.'))
  }
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(SESSION_LIBRARY_DB_NAME, DATABASE_VERSION)
    } catch (error) {
      reject(normalizeStorageError(error))
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(RECORDS_STORE)) database.createObjectStore(RECORDS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(PAYLOADS_STORE)) database.createObjectStore(PAYLOADS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(normalizeStorageError(request.error))
    request.onblocked = () => reject(new SessionLibraryError('storage', 'Saved-item storage is busy in another tab. Close that tab and try again.'))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}

function isRecordSummary(value: unknown): value is SavedRecordSummary {
  if (!isObject(value)) return false
  return nonEmptyString(value.id, 128)
    && oneOf(value.kind, ['session', 'favorite'])
    && nonEmptyString(value.name, 64)
    && integer(value.createdAt, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.assetBytes, 0, MAX_SAVED_RECORD_BYTES)
    && typeof value.hasFixture === 'boolean'
}

function isRecordPayload(value: unknown): value is { id: string; kind: SavedRecordKind; version: number; snapshot: unknown } {
  return isObject(value)
    && nonEmptyString(value.id, 128)
    && oneOf(value.kind, ['session', 'favorite'])
    && typeof value.version === 'number'
    && 'snapshot' in value
}

function validMedia(value: unknown): value is SavedMedia {
  if (!isObject(value)) return false
  return nonEmptyString(value.name, 512)
    && string(value.type, 255)
    && integer(value.lastModified, 0, Number.MAX_SAFE_INTEGER)
    && safeRelativePath(value.relativePath)
    && integer(value.size, 1, MAX_FILE_BYTES)
    && typeof Blob !== 'undefined'
    && value.data instanceof Blob
    && value.data.size === value.size
}

function validBeatTrims(value: unknown): value is SavedBeatTrims {
  if (!isObject(value) || Object.keys(value).length > MAX_BEAT_TRIM_ENTRIES) return false
  return Object.entries(value).every(([key, region]) => {
    if (!/^(?:preset:[A-Za-z0-9_-]{1,128}:\d{1,3}|custom:[A-Za-z0-9_-]{1,128})$/.test(key) || !isObject(region)) return false
    if (!finite(region.startOffsetSeconds, 0, MAX_BEAT_TRIM_SECONDS)
      || !(region.loopEndSeconds === null || finite(region.loopEndSeconds, 0, MAX_BEAT_TRIM_SECONDS))) return false
    return region.loopEndSeconds === null || region.loopEndSeconds > region.startOffsetSeconds
  })
}

function validTrimId(value: unknown): value is string {
  return nonEmptyString(value, 128) && /^[A-Za-z0-9_-]+$/.test(value)
}

function validBeatTrimOwnership(data: SavedSessionData): boolean {
  if (!data.presetBeatTrimId || Boolean(data.customBeatFile) !== (data.customBeatTrimId !== null)) return false
  const allowedCustomKey = data.customBeatTrimId === null ? null : customBeatTrimKey(data.customBeatTrimId)
  for (const key of Object.keys(data.beatTrims)) {
    if (key.startsWith('custom:')) {
      if (!data.customBeatFile || key !== allowedCustomKey) return false
      continue
    }

    const prefix = presetBeatTrimKey(data.presetBeatTrimId, 0).slice(0, -1)
    if (!key.startsWith(prefix)) return false
    const indexText = key.slice(prefix.length)
    const beatIndex = Number(indexText)
    if (!Number.isSafeInteger(beatIndex) || beatIndex < 0 || beatIndex >= data.preset.beatFiles.length) return false
  }
  return true
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function safeRelativePath(value: unknown): value is string {
  return string(value, 2048)
    && value.trim().length > 0
    && !value.startsWith('/')
    && !/^[a-z]:/i.test(value)
    && !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..')
}

function validPreset(value: unknown): value is Preset {
  if (!isObject(value) || !nonEmptyString(value.name, 512) || !finite(value.bpm, 1, 1000)
    || !Array.isArray(value.beatFiles) || value.beatFiles.length > MAX_ASSETS_PER_RECORD
    || !value.beatFiles.every((entry) => string(entry, 2048))
    || !integer(value.beatVolume, 0, 100) || !integer(value.sampleVolume, 0, 100)
    || !Array.isArray(value.samples) || value.samples.length > MAX_SAMPLES
    || !value.samples.every(validSample)) return false
  if (value.legacyRootPath !== undefined && !string(value.legacyRootPath, 2048)) return false
  return new Set(value.samples.map((sample) => (sample as { id: string }).id)).size === value.samples.length
}

function validSample(value: unknown): boolean {
  if (!isObject(value)) return false
  return nonEmptyString(value.id, 128)
    && nonEmptyString(value.name, 512)
    && string(value.fileName, 2048)
    && integer(value.durationUnits, 0, 2_147_483_647)
    && integer(value.weight, 0, 2_147_483_647)
    && typeof value.startForward === 'boolean'
    && typeof value.endForward === 'boolean'
    && typeof value.canRepeat === 'boolean'
    && integer(value.maxRepeat, 0, 2_147_483_647)
    && typeof value.enabled === 'boolean'
    && typeof value.silent === 'boolean'
}

function validFixture(value: unknown): value is Fixture {
  if (!isObject(value) || !integer(value.totalUnits, 1, 4096)
    || !Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_FIXTURE_EVENTS) return false
  let priorEnd = 0
  return value.events.every((event) => {
    if (!isObject(event)
      || !nonEmptyString(event.id, 256)
      || !nonEmptyString(event.sampleId, 128)
      || !integer(event.startUnits, 0, value.totalUnits as number)
      || !integer(event.durationUnits, 1, value.totalUnits as number)
      || typeof event.silent !== 'boolean'
      || (event.startUnits as number) < priorEnd
      || (event.startUnits as number) + (event.durationUnits as number) > (value.totalUnits as number)) return false
    priorEnd = (event.startUnits as number) + (event.durationUnits as number)
    return true
  })
}

function validAnnotations(value: unknown): value is Record<string, string> {
  if (!isObject(value) || Object.keys(value).length > MAX_SAMPLES) return false
  return Object.entries(value).every(([key, selection]) => string(key, 128) && string(selection, 128))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return string(value, maximum) && value.trim().length > 0
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.includes(value as T)
}

function corrupt(message: string): SessionLibraryError {
  return new SessionLibraryError('corrupt', message)
}

function normalizeStorageError(error: unknown): SessionLibraryError {
  if (error instanceof SessionLibraryError) return error
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new SessionLibraryError('quota', 'Browser storage is full. Delete a saved session or favourite to make room, then try again.')
  }
  return new SessionLibraryError('storage', 'Could not access saved items in this browser. Check browser storage settings and try again.')
}
