export const WAVEFORM_PEAK_COUNT = 192
export const WAVEFORM_VIEWBOX_HEIGHT = 32

const DECODE_SAMPLE_RATE = 12_000
const MAX_CACHED_FILES = 96

export interface WaveformData {
  readonly durationSeconds: number
  readonly peaks: Float32Array
  readonly path: string
}

export interface WaveformDisplayGeometry {
  /** Width as a percentage of the configured event slot. */
  readonly widthPercent: number
  /** Horizontal viewBox extent; values above the visible slot are clipped. */
  readonly viewBoxWidth: number
}

export type WaveformDecoder = (file: File) => Promise<WaveformData | null>

export function waveformPath(peaks: ArrayLike<number>): string {
  if (peaks.length === 0) return ''

  const middle = WAVEFORM_VIEWBOX_HEIGHT / 2
  const amplitude = middle - 1
  const upper = Array.from({ length: peaks.length }, (_, index) => {
    const peak = Math.min(1, Math.max(0, Number(peaks[index]) || 0))
    return (index === 0 ? 'M' : 'L') + index + ' ' + (middle - peak * amplitude)
  }).join(' ')
  const lower = Array.from({ length: peaks.length }, (_, index) => {
    const point = peaks.length - index - 1
    const peak = Math.min(1, Math.max(0, Number(peaks[point]) || 0))
    return 'L' + point + ' ' + (middle + peak * amplitude)
  }).join(' ')

  return upper + ' ' + lower + ' Z'
}

/** Reduces PCM channels to a normalized, stereo-safe absolute peak envelope. */
export function analyzeWaveform(
  channels: readonly ArrayLike<number>[],
  sampleRate: number,
  peakCount = WAVEFORM_PEAK_COUNT,
): WaveformData | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null
  if (!Number.isSafeInteger(peakCount) || peakCount <= 0) return null

  const sampleCount = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0)
  if (sampleCount === 0) return null

  const peaks = new Float32Array(peakCount)
  let maximum = 0
  for (let bin = 0; bin < peakCount; bin += 1) {
    const start = Math.floor((bin * sampleCount) / peakCount)
    const end = Math.min(sampleCount, Math.max(start + 1, Math.ceil(((bin + 1) * sampleCount) / peakCount)))
    let binPeak = 0
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      for (const channel of channels) {
        if (sampleIndex >= channel.length) continue
        const sample = Number(channel[sampleIndex])
        if (!Number.isFinite(sample)) continue
        binPeak = Math.max(binPeak, Math.abs(sample))
      }
    }
    peaks[bin] = binPeak
    maximum = Math.max(maximum, binPeak)
  }

  if (maximum > 0) {
    for (let bin = 0; bin < peaks.length; bin += 1) peaks[bin] = peaks[bin]! / maximum
  }

  return {
    durationSeconds: sampleCount / sampleRate,
    peaks,
    path: waveformPath(peaks),
  }
}

/** Converts fixture units to their reference-time duration, before live tempo changes. */
export function timelineUnitsToSeconds(units: number, bpm: number, unitsPerBeat: number): number | null {
  if (!Number.isFinite(units) || units <= 0) return null
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(unitsPerBeat) || unitsPerBeat <= 0) return null
  return (units * 60) / (bpm * unitsPerBeat)
}

/** Fits only the source audio that belongs inside a slot, preserving its time scale. */
export function waveformDisplayGeometry(
  sourceDurationSeconds: number,
  slotDurationSeconds: number,
  peakCount: number,
): WaveformDisplayGeometry | null {
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) return null
  if (!Number.isFinite(slotDurationSeconds) || slotDurationSeconds <= 0) return null
  if (!Number.isSafeInteger(peakCount) || peakCount <= 0) return null

  const sourceToSlot = sourceDurationSeconds / slotDurationSeconds
  return {
    widthPercent: Math.min(sourceToSlot, 1) * 100,
    viewBoxWidth: peakCount / Math.max(1, sourceToSlot),
  }
}

async function decodeWaveformFile(file: File): Promise<WaveformData | null> {
  const OfflineContext = globalThis.OfflineAudioContext
  if (!OfflineContext || typeof file.arrayBuffer !== 'function') return null

  try {
    const context = new OfflineContext(2, 128, DECODE_SAMPLE_RATE)
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    return analyzeWaveform(channels, buffer.sampleRate)
  } catch {
    return null
  }
}

interface CacheEntry {
  promise: Promise<WaveformData | null>
  settled: boolean
}

/** Creates a File-identity LRU cache. Only compact envelopes are retained, never decoded AudioBuffers. */
export function createWaveformLoader(
  decoder: WaveformDecoder = decodeWaveformFile,
  capacity = MAX_CACHED_FILES,
): (file: File) => Promise<WaveformData | null> {
  const maximumEntries = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : MAX_CACHED_FILES
  const cache = new Map<File, CacheEntry>()

  const trimCache = () => {
    while (cache.size > maximumEntries) {
      let removable: File | undefined
      for (const [file, entry] of cache) {
        if (entry.settled) {
          removable = file
          break
        }
      }
      if (!removable) return
      cache.delete(removable)
    }
  }

  return (file) => {
    const cached = cache.get(file)
    if (cached) {
      cache.delete(file)
      cache.set(file, cached)
      return cached.promise
    }

    const entry: CacheEntry = { promise: Promise.resolve(null), settled: false }
    entry.promise = Promise.resolve()
      .then(() => decoder(file))
      .catch(() => null)
      .then((waveform) => {
        entry.settled = true
        trimCache()
        return waveform
      })
    cache.set(file, entry)
    trimCache()
    return entry.promise
  }
}

export const loadWaveform = createWaveformLoader()
