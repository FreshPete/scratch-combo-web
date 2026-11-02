import { describe, expect, it } from 'vitest'
import { buildPreviewFixture, DEMO_PRESET } from '../domain'
import {
  mediaBytes,
  validateSavedSessionData,
  type SavedMedia,
  type SavedSessionData,
} from './storage'

function validSnapshot(): SavedSessionData {
  return {
    version: 1,
    presetSource: 'demo',
    selectedPresetId: 'demo',
    preset: structuredClone(DEMO_PRESET),
    fixture: buildPreviewFixture(DEMO_PRESET, 32),
    timebase: 'demo',
    timelineView: 'waveform',
    timelineLayout: 'grid',
    ttmAnnotations: {},
    comboBeats: 8,
    practiceMode: 'qa',
    largePause: false,
    autoGenerate: false,
    autoGenerateRounds: 2,
    omittedZeroDurationCount: 0,
    presetFileName: null,
    sourceIniText: null,
    bpm: String(DEMO_PRESET.bpm),
    pitchSemitones: 0,
    sampleVolume: DEMO_PRESET.sampleVolume,
    beatVolume: DEMO_PRESET.beatVolume,
    selectedBeatIndex: 'none',
    customBeatFile: null,
    customBeatSelected: false,
    customBeatReferenceBpm: null,
    customBeatReferenceBpmInput: '',
    assets: [],
  }
}

function smallMedia(name: string, relativePath: string): SavedMedia {
  const data = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })
  return { name, type: data.type, lastModified: 0, relativePath, size: data.size, data }
}

describe('saved session payload validation', () => {
  it('accepts a complete bounded snapshot without changing the exact fixture', () => {
    const snapshot = validSnapshot()
    const checked = validateSavedSessionData(snapshot)
    expect(checked.fixture).toEqual(snapshot.fixture)
    expect(checked.preset).toEqual(snapshot.preset)
  })

  it('rejects unsupported versions, invalid preset numbers, and out-of-range fixture events', () => {
    expect(() => validateSavedSessionData({ ...validSnapshot(), version: 2 })).toThrow(/format is not supported/i)

    const invalidPreset = validSnapshot()
    invalidPreset.preset.samples[0]!.weight = Number.POSITIVE_INFINITY
    expect(() => validateSavedSessionData(invalidPreset)).toThrow(/invalid settings or audio metadata/i)

    const invalidFixture = validSnapshot()
    invalidFixture.fixture!.events[0]!.durationUnits = invalidFixture.fixture!.totalUnits + 1
    expect(() => validateSavedSessionData(invalidFixture)).toThrow(/invalid settings or audio metadata/i)
  })

  it('requires a confirmed BPM for retained custom audio and counts every stored Blob', () => {
    const snapshot = validSnapshot()
    snapshot.customBeatFile = smallMedia('beat.wav', 'beat.wav')
    snapshot.customBeatSelected = false
    snapshot.customBeatReferenceBpm = null
    expect(() => validateSavedSessionData(snapshot)).toThrow(/confirmed BPM/i)

    snapshot.customBeatReferenceBpm = 96
    snapshot.assets = [smallMedia('sample.wav', 'folder/sample.wav')]
    expect(mediaBytes(snapshot)).toBe(snapshot.assets[0]!.size + snapshot.customBeatFile.size)
    expect(validateSavedSessionData(snapshot).customBeatFile).toEqual(snapshot.customBeatFile)
  })

  it('rejects unsafe saved relative paths before rebuilding browser Files', () => {
    const snapshot = validSnapshot()
    snapshot.assets = [smallMedia('sample.wav', '../outside/sample.wav')]
    expect(() => validateSavedSessionData(snapshot)).toThrow(/invalid settings or audio metadata/i)
  })
})
