import { describe, expect, it } from 'vitest'
import { buildPreviewFixture, DEMO_PRESET } from '../domain'
import {
  presetBeatTrimKey,
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
    countInBars: 0,
    metronomeEnabled: false,
    metronomeVolume: 60,
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
    presetBeatTrimId: 'preset-trim-id',
    customBeatTrimId: null,
    beatTrims: {},
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

  it('defaults missing trim fields in older v1 snapshots to full-clip playback', () => {
    const legacy = { ...validSnapshot() } as Partial<SavedSessionData>
    delete legacy.presetBeatTrimId
    delete legacy.customBeatTrimId
    delete legacy.beatTrims

    const restored = validateSavedSessionData(legacy)
    expect(restored.beatTrims).toEqual({})
    expect(restored.presetBeatTrimId).toMatch(/^legacy-/)
    expect(restored.customBeatTrimId).toBeNull()

    const legacyWithCustomBeat = { ...validSnapshot() } as Partial<SavedSessionData>
    legacyWithCustomBeat.customBeatFile = smallMedia('practice.wav', 'practice.wav')
    legacyWithCustomBeat.customBeatReferenceBpm = 120
    delete legacyWithCustomBeat.presetBeatTrimId
    delete legacyWithCustomBeat.customBeatTrimId
    delete legacyWithCustomBeat.beatTrims
    const legacyCustom = validateSavedSessionData(legacyWithCustomBeat)
    expect(legacyCustom.beatTrims).toEqual({})
    expect(legacyCustom.customBeatTrimId).toMatch(/^legacy-/)
  })

  it('defaults older v1 playback-prep fields and strictly validates new settings', () => {
    const legacy = { ...validSnapshot() } as Partial<SavedSessionData>
    delete legacy.countInBars
    delete legacy.metronomeEnabled
    delete legacy.metronomeVolume

    const restored = validateSavedSessionData(legacy)
    expect(restored.countInBars).toBe(0)
    expect(restored.metronomeEnabled).toBe(false)
    expect(restored.metronomeVolume).toBe(60)

    const configured = { ...validSnapshot(), countInBars: 2 as const, metronomeEnabled: true, metronomeVolume: 37 }
    expect(validateSavedSessionData(configured)).toEqual(expect.objectContaining({
      countInBars: 2,
      metronomeEnabled: true,
      metronomeVolume: 37,
    }))
    expect(() => validateSavedSessionData({ ...configured, countInBars: 3 })).toThrow(/invalid settings or audio metadata/i)
    expect(() => validateSavedSessionData({ ...configured, metronomeVolume: Number.POSITIVE_INFINITY })).toThrow(/invalid settings or audio metadata/i)
    expect(() => validateSavedSessionData({ ...configured, metronomeVolume: 101 })).toThrow(/invalid settings or audio metadata/i)
  })

  it('accepts source-scoped cue and loop regions and rejects invalid bounds or ownership', () => {
    const snapshot = validSnapshot()
    snapshot.presetSource = 'builtin'
    snapshot.selectedPresetId = 'SSC-085BPM-01'
    snapshot.presetFileName = null
    snapshot.preset.beatFiles = ['Practice beat.wav']
    snapshot.beatTrims = {
      [presetBeatTrimKey(snapshot.presetBeatTrimId, 0)]: {
        startOffsetSeconds: 0.25,
        loopEndSeconds: 3.5,
      },
    }
    expect(validateSavedSessionData(snapshot).beatTrims).toEqual(snapshot.beatTrims)
    snapshot.preset.samples[0]!.enabled = false
    snapshot.preset.samples[0]!.weight = 12
    expect(validateSavedSessionData(snapshot).beatTrims).toEqual(snapshot.beatTrims)

    expect(() => validateSavedSessionData({ ...snapshot, beatTrims: {
      [Object.keys(snapshot.beatTrims)[0]!]: { startOffsetSeconds: -0.1, loopEndSeconds: 3.5 },
    } })).toThrow(/invalid settings or audio metadata/i)
    expect(() => validateSavedSessionData({ ...snapshot, beatTrims: {
      [Object.keys(snapshot.beatTrims)[0]!]: { startOffsetSeconds: 1.5, loopEndSeconds: 1.5 },
    } })).toThrow(/invalid settings or audio metadata/i)
    expect(() => validateSavedSessionData({ ...snapshot, beatTrims: {
      'preset:abc:1': { startOffsetSeconds: 0.25, loopEndSeconds: 3.5 },
    } })).toThrow(/different or unavailable beat source/i)
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
    snapshot.customBeatTrimId = 'custom-test-id'
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
