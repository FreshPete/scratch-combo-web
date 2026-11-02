import { parseLegacyIni, type Preset } from '../domain'

export interface BuiltInPresetEntry {
  readonly id: string
  readonly label: string
  readonly bpm: number
  readonly iniFile: string
  readonly audioDirectory: string
}

export interface BuiltInPresetCatalog {
  readonly version: 1
  readonly defaultPresetId: string
  readonly presets: readonly BuiltInPresetEntry[]
}

export interface LoadedBuiltInPreset {
  readonly preset: Preset
  readonly iniFile: File
  readonly iniText: string
  readonly audioFiles: readonly File[]
}

export type PresetFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const SUPPORTED_PRESETS = new Map([
  ['SSC-085BPM-01', { iniFile: 'SSC-085BPM-01.ini', bpm: 85, audioDirectory: '085BPM' }],
  ['SSC-085BPM-02', { iniFile: 'SSC-085BPM-02.ini', bpm: 85, audioDirectory: '085BPM' }],
  ['SSC-085BPM-03', { iniFile: 'SSC-085BPM-03.ini', bpm: 85, audioDirectory: '085BPM' }],
  ['SSC-085BPM-04', { iniFile: 'SSC-085BPM-04.ini', bpm: 85, audioDirectory: '085BPM' }],
  ['SSC-085BPM-05', { iniFile: 'SSC-085BPM-05.ini', bpm: 85, audioDirectory: '085BPM' }],
  ['SSC-096BPM2-01', { iniFile: 'SSC-096BPM2-01.ini', bpm: 96, audioDirectory: '096BPM2' }],
])
const MAX_REFERENCED_WAVS = 256

function safePathSegments(value: string): string[] {
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('The built-in preset catalog contains an unsafe file path.')
  }
  return segments
}

function fileUrl(relativePath: string): string {
  const encodedPath = safePathSegments(relativePath).map((segment) => encodeURIComponent(segment)).join('/')
  const privatePresetPrefix = new URL(`${import.meta.env.BASE_URL}private-presets/`, window.location.origin)
  const url = new URL(`${import.meta.env.BASE_URL}private-presets/${encodedPath}`, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith(privatePresetPrefix.pathname)) {
    throw new Error('Built-in preset files must stay within this site’s private preset directory.')
  }
  return url.toString()
}

async function checkedResponse(
  fetcher: PresetFetch,
  url: string,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  const response = await fetcher(url, {
    ...(signal ? { signal } : {}),
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`Could not load ${label} (HTTP ${response.status}).`)
  if (response.url) {
    const responseUrl = new URL(response.url, window.location.origin)
    const privatePresetPrefix = new URL(`${import.meta.env.BASE_URL}private-presets/`, window.location.origin)
    if (responseUrl.origin !== window.location.origin || !responseUrl.pathname.startsWith(privatePresetPrefix.pathname)) {
      throw new Error(`Could not load ${label}: the response left the private preset directory.`)
    }
  }
  return response
}

function catalogEntry(value: unknown): value is BuiltInPresetEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const supported = typeof entry.id === 'string' ? SUPPORTED_PRESETS.get(entry.id) : undefined
  return typeof entry.id === 'string'
    && supported !== undefined
    && typeof entry.label === 'string'
    && entry.label.trim().length > 0
    && typeof entry.bpm === 'number'
    && Number.isFinite(entry.bpm)
    && entry.bpm === supported.bpm
    && typeof entry.iniFile === 'string'
    && entry.iniFile === supported.iniFile
    && typeof entry.audioDirectory === 'string'
    && entry.audioDirectory === supported.audioDirectory
}

export async function fetchBuiltInPresetCatalog(
  fetcher: PresetFetch = fetch,
  signal?: AbortSignal,
): Promise<BuiltInPresetCatalog> {
  const response = await checkedResponse(fetcher, fileUrl('catalog.json'), signal, 'the built-in preset list')
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null) throw new Error('The built-in preset list is invalid.')
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || typeof candidate.defaultPresetId !== 'string' || !Array.isArray(candidate.presets)) {
    throw new Error('The built-in preset list is invalid.')
  }
  if (!candidate.presets.every(catalogEntry) || candidate.presets.length !== SUPPORTED_PRESETS.size) {
    throw new Error('The built-in preset list has an invalid preset entry.')
  }
  const presets = candidate.presets as BuiltInPresetEntry[]
  if (new Set(presets.map(({ id }) => id)).size !== presets.length
    || !presets.some(({ id }) => id === candidate.defaultPresetId)) {
    throw new Error('The built-in preset list has duplicate ids or a missing default.')
  }
  return {
    version: 1,
    defaultPresetId: candidate.defaultPresetId,
    presets,
  }
}

export async function loadBuiltInPreset(
  entry: BuiltInPresetEntry,
  options: { readonly fetcher?: PresetFetch; readonly signal?: AbortSignal } = {},
): Promise<LoadedBuiltInPreset> {
  const fetcher = options.fetcher ?? fetch
  if (!catalogEntry(entry)) throw new Error('That built-in preset is not supported.')
  const iniResponse = await checkedResponse(fetcher, fileUrl(entry.iniFile), options.signal, entry.iniFile)
  const iniText = await iniResponse.text()
  const preset = parseLegacyIni(iniText)
  if (preset.legacyRootPath !== entry.audioDirectory) {
    throw new Error(`${entry.iniFile} references an unexpected audio folder.`)
  }
  if (preset.bpm !== entry.bpm) throw new Error(`${entry.iniFile} does not match its catalog BPM.`)

  const references = [...new Set([...preset.samples.map(({ fileName }) => fileName), ...preset.beatFiles])]
  if (references.length > MAX_REFERENCED_WAVS) throw new Error(`${entry.iniFile} references too many WAV files.`)
  const audioFiles = await Promise.all(references.map(async (reference) => {
    const referenceSegments = safePathSegments(reference)
    if (referenceSegments.length !== 1 || !referenceSegments[0]?.toLowerCase().endsWith('.wav')) {
      throw new Error(`${entry.iniFile} contains an invalid WAV reference: ${reference}`)
    }
    const relativePath = [...safePathSegments(entry.audioDirectory), ...referenceSegments].join('/')
    const response = await checkedResponse(
      fetcher,
      fileUrl(relativePath),
      options.signal,
      reference,
    )
    const blob = await response.blob()
    const fileName = safePathSegments(reference).at(-1)
    if (!fileName) throw new Error(`The built-in preset has an invalid WAV reference: ${reference}`)
    const file = new File([blob], fileName, { type: blob.type || 'audio/wav' })
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: relativePath,
    })
    return file
  }))

  return {
    preset,
    iniFile: new File([iniText], entry.iniFile, { type: 'text/plain' }),
    iniText,
    audioFiles,
  }
}
