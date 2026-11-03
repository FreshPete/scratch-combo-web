import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPO_TRAINING_SETTINGS,
  isValidTempoTrainingSettings,
  tempoTrainingValidationMessage,
} from './tempo-training'

describe('tempo training settings', () => {
  it('defaults to Off and accepts a finite target with whole-number steps and rounds', () => {
    expect(DEFAULT_TEMPO_TRAINING_SETTINGS).toEqual({
      enabled: false,
      targetBpm: 100,
      stepBpm: 1,
      roundsPerStep: 2,
    })
    expect(isValidTempoTrainingSettings({ enabled: true, targetBpm: 100.5, stepBpm: 2, roundsPerStep: 3 })).toBe(true)
  })

  it('rejects non-finite or out-of-bound settings and fractional steps or round counts', () => {
    const valid = { enabled: true, targetBpm: 100, stepBpm: 1, roundsPerStep: 2 }
    expect(isValidTempoTrainingSettings({ ...valid, targetBpm: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, targetBpm: Number.NaN })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, targetBpm: 2001 })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, stepBpm: 0.5 })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, stepBpm: 21 })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, roundsPerStep: 1.5 })).toBe(false)
    expect(isValidTempoTrainingSettings({ ...valid, roundsPerStep: 65 })).toBe(false)
  })

  it('validates the current tempo and goal against the shared scratch and beat range', () => {
    const settings = { enabled: true, targetBpm: 100.5, stepBpm: 2, roundsPerStep: 3 }
    const sharedRange = { min: 60, max: 170 }

    expect(tempoTrainingValidationMessage(settings, 85, sharedRange)).toBeNull()
    expect(tempoTrainingValidationMessage({ ...settings, targetBpm: 59.5 }, 85, sharedRange)).toMatch(/shared 60–170 BPM range/i)
    expect(tempoTrainingValidationMessage({ ...settings, targetBpm: 84 }, 85, sharedRange)).toMatch(/at least the current tempo/i)
    expect(tempoTrainingValidationMessage(settings, 171, sharedRange)).toMatch(/current BPM within the shared 60–170 BPM range/i)
    expect(tempoTrainingValidationMessage(settings, 85, null)).toMatch(/do not have a shared BPM range/i)
    expect(tempoTrainingValidationMessage({ ...settings, enabled: false }, 171, null)).toBeNull()
  })
})
