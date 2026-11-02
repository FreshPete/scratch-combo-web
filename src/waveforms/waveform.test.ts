import { describe, expect, it, vi } from 'vitest'
import {
  analyzeWaveform, createWaveformLoader, timelineUnitsToSeconds, waveformDisplayGeometry,
} from './waveform'

describe('waveform extraction', () => {
  it('keeps the envelope of a real sine wave instead of returning decorative peaks', () => {
    const sine = Float32Array.from({ length: 16 }, (_, index) => Math.sin((index * Math.PI * 2) / 16))
    const waveform = analyzeWaveform([sine], 16, 8)

    expect(waveform?.durationSeconds).toBe(1)
    expect(waveform?.peaks[0]).toBeCloseTo(waveform?.peaks[4] ?? 0, 5)
    expect(waveform?.peaks[2]).toBeCloseTo(1, 5)
    expect(waveform?.peaks[0]).toBeLessThan(waveform?.peaks[2] ?? 0)
  })

  it('preserves silence as zero amplitude', () => {
    const waveform = analyzeWaveform([
      new Float32Array(24),
      new Float32Array(24),
    ], 12, 6)

    expect(waveform?.peaks).toEqual(new Float32Array(6))
  })

  it('combines stereo channels by their strongest absolute sample', () => {
    const waveform = analyzeWaveform([
      Float32Array.from([0.1, 0.1, 0, 0]),
      Float32Array.from([0, 0, -0.8, 0.8]),
    ], 4, 4)

    expect(Array.from(waveform?.peaks ?? [])).toEqual([0.125, 0.125, 1, 1])
  })

  it('includes the partial final bin when reducing short files', () => {
    const waveform = analyzeWaveform([Float32Array.from([0, 0, 0, 0, 0.7])], 5, 4)

    expect(waveform?.durationSeconds).toBe(1)
    expect(waveform?.peaks[3]).toBe(1)
  })

  it('uses the preset reference tempo and each timebase to size an event slot', () => {
    expect(timelineUnitsToSeconds(16, 85, 16)).toBeCloseTo(60 / 85)
    expect(timelineUnitsToSeconds(4, 100, 4)).toBeCloseTo(0.6)
    expect(timelineUnitsToSeconds(0, 100, 4)).toBeNull()
  })

  it('clips a long source at the slot while keeping a short source blank after its real end', () => {
    const clipped = waveformDisplayGeometry(0.6, 0.3, 192)
    expect(clipped?.widthPercent).toBe(100)
    expect(clipped?.viewBoxWidth).toBe(96)

    const short = waveformDisplayGeometry(0.15, 0.3, 192)
    expect(short?.widthPercent).toBe(50)
    expect(short?.viewBoxWidth).toBe(192)
  })
})

describe('waveform file cache', () => {
  it('shares in-flight decoding and bounds retained file envelopes', async () => {
    const waveform = analyzeWaveform([Float32Array.from([0, 1, 0])], 3, 3)!
    const decode = vi.fn(async () => waveform)
    const load = createWaveformLoader(decode, 1)
    const first = new File(['one'], 'one.wav')
    const second = new File(['two'], 'two.wav')

    const firstLoad = load(first)
    expect(load(first)).toBe(firstLoad)
    await firstLoad
    await load(second)
    await load(first)

    expect(decode).toHaveBeenCalledTimes(3)
  })

  it('turns decoder failures into a cached absence so the event can fall back cleanly', async () => {
    const decode = vi.fn(async () => { throw new Error('corrupt WAV') })
    const load = createWaveformLoader(decode)
    const file = new File(['bad audio'], 'broken.wav')

    await expect(load(file)).resolves.toBeNull()
    await expect(load(file)).resolves.toBeNull()
    expect(decode).toHaveBeenCalledTimes(1)
  })
})
