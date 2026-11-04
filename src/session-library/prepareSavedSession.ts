import { analyzeLocalAudioFile, snapshotReferencedWavFiles } from '../audio'
import { buildAssetIndex, LEGACY_TICKS_PER_BEAT, parseLegacyIni, resolvePresetAssets, REST_SAMPLE_ID, type PresetAssetResolution } from '../domain'
import { requiredImportSample } from '../preparePresetImport'
import { customBeatTrimKey, loadSavedRecord, presetBeatTrimKey, SessionLibraryError, type SavedRecordSummary } from './storage'

export async function prepareSavedSession(summary: SavedRecordSummary) {
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
      throw new SessionLibraryError('corrupt', 'Could not decode the saved custom beat: ' + (error instanceof Error ? error.message : String(error)) + ' Delete the saved item and choose a readable audio file.')
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
  return { record, data, restoredFiles, nextIndex, nextResolution, restoredCustomBeatFile, restoredCustomBeatBuffer }
}
