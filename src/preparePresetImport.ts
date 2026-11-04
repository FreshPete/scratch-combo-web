import { LocalWavSnapshotError, snapshotReferencedWavFiles, type SnapshotFileValidation } from './audio'
import { buildAssetIndex, resolvePresetAssets, type AssetResolution, type Preset, type PresetAssetResolution, type SampleDefinition } from './domain'

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

export function requiredImportSample(sample: SampleDefinition): boolean {
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

export function mappedReferenceChecks(
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
  return (error instanceof Error ? error.message : String(error)) + ' Choose another folder or smaller referenced WAVs, then review again.'
}

export async function preparePresetImport(
  iniFileName: string, iniText: string, preset: Preset, audioFiles: File[], signal: AbortSignal,
): Promise<PreparedLocalImport> {
  const audioIndex = buildAssetIndex(audioFiles)
  const resolution = resolvePresetAssets(preset, audioIndex)
  const baseChecks = referenceChecksForImport(preset, resolution)
  const requiredMissing = baseChecks.filter((check) => check.required && check.resolution.status !== 'resolved')
  const base: PreparedLocalImport = {
    iniFileName,
    iniText,
    preset,
    resolution,
    snapshotResolution: resolution,
    snapshotFiles: [],
    selectedAudioFileCount: audioFiles.length,
    checks: baseChecks,
    copiedFileCount: 0,
    copiedBytes: 0,
    decodedFileCount: 0,
    decodeAttemptCount: 0,
    canLoad: false,
    applied: false,
    blockedMessage: null,
  }
  const referencedFiles = resolvedReferencedFiles(resolution)
  const decodeFiles = [
    ...preset.samples
      .filter(requiredImportSample)
      .flatMap((sample) => {
        const asset = resolution.samplesById.get(sample.id)
        return asset?.status === 'resolved' && asset.file ? [asset.file] : []
      }),
    ...resolution.beats.flatMap((asset) => asset.status === 'resolved' && asset.file ? [asset.file] : []),
  ]
  try {
    const snapshot = await snapshotReferencedWavFiles(referencedFiles, {
      decodeFiles,
      signal,
    })
    const snapshotResolution = mapPresetResolutionToSnapshots(
      resolution,
      snapshot.filesBySource,
      snapshot.validationBySource,
    )
    const checks = referenceChecksForImport(preset, resolution, snapshot.validationBySource)
    const requiredDecodeFailures = checks.filter((check) => check.required && check.validation?.status === 'invalid')
    const failed = requiredDecodeFailures[0]
    const blockedMessage = requiredMissing.length > 0
      ? requiredDecodeFailures.length > 0
        ? 'Resolve missing or ambiguous sample references and replace any required WAVs that failed decoding before loading this preset.'
        : 'Resolve the missing or ambiguous WAV files for enabled, audible samples before loading this preset.'
      : failed
        ? (failed.resolution.selectedPath ?? failed.requested) + ': this required sample WAV could not be decoded. ' + (failed.validation?.status === 'invalid' ? failed.validation.message : '') + ' Choose a valid WAV, then review the selection again.'
        : null
    return {
      ...base,
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
  } catch (error) {
    if (signal.aborted) throw error
    return { ...base, blockedMessage: snapshotErrorForImport(error, resolution) }
  }
}
