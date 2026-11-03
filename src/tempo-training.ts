export interface TempoTrainingSettings {
  readonly enabled: boolean
  readonly targetBpm: number
  readonly stepBpm: number
  readonly roundsPerStep: number
}

export interface TempoTrainingRange {
  readonly min: number
  readonly max: number
}

export const DEFAULT_TEMPO_TRAINING_SETTINGS: TempoTrainingSettings = Object.freeze({
  enabled: false,
  targetBpm: 100,
  stepBpm: 1,
  roundsPerStep: 2,
})

export const MIN_TEMPO_TRAINING_BPM = 1
export const MAX_TEMPO_TRAINING_BPM = 2000
export const MIN_TEMPO_TRAINING_STEP_BPM = 1
export const MAX_TEMPO_TRAINING_STEP_BPM = 20
export const MIN_TEMPO_TRAINING_ROUNDS = 1
export const MAX_TEMPO_TRAINING_ROUNDS = 64

export function isValidTempoTrainingSettings(value: unknown): value is TempoTrainingSettings {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.enabled === 'boolean'
    && isFiniteWithin(candidate.targetBpm, MIN_TEMPO_TRAINING_BPM, MAX_TEMPO_TRAINING_BPM)
    && isFiniteIntegerWithin(candidate.stepBpm, MIN_TEMPO_TRAINING_STEP_BPM, MAX_TEMPO_TRAINING_STEP_BPM)
    && isFiniteIntegerWithin(candidate.roundsPerStep, MIN_TEMPO_TRAINING_ROUNDS, MAX_TEMPO_TRAINING_ROUNDS)
}

export function tempoTrainingValidationMessage(
  settings: TempoTrainingSettings,
  currentBpm: number,
  tempoRange: TempoTrainingRange | null,
  repeatingPracticeAvailable = true,
): string | null {
  if (!settings.enabled) return null
  if (!repeatingPracticeAvailable) return 'Tempo training needs an imported preset with repeating practice rounds.'
  if (!tempoRange) return 'The selected sources do not have a shared BPM range for tempo training.'
  if (!Number.isFinite(currentBpm) || currentBpm < tempoRange.min || currentBpm > tempoRange.max) {
    return 'Set the current BPM within the shared ' + tempoRange.min + '–' + tempoRange.max + ' BPM range first.'
  }
  if (!Number.isFinite(settings.targetBpm) || settings.targetBpm < MIN_TEMPO_TRAINING_BPM || settings.targetBpm > MAX_TEMPO_TRAINING_BPM) {
    return 'Enter a finite target from ' + MIN_TEMPO_TRAINING_BPM + ' to ' + MAX_TEMPO_TRAINING_BPM + ' BPM.'
  }
  if (settings.targetBpm < tempoRange.min || settings.targetBpm > tempoRange.max) {
    return 'Target BPM must stay within the selected sources’ shared ' + tempoRange.min + '–' + tempoRange.max + ' BPM range.'
  }
  if (settings.targetBpm < currentBpm) return 'Target BPM must be at least the current tempo of ' + currentBpm + ' BPM.'
  if (!isFiniteIntegerWithin(settings.stepBpm, MIN_TEMPO_TRAINING_STEP_BPM, MAX_TEMPO_TRAINING_STEP_BPM)) {
    return 'Increase by a whole number from ' + MIN_TEMPO_TRAINING_STEP_BPM + ' to ' + MAX_TEMPO_TRAINING_STEP_BPM + ' BPM.'
  }
  if (!isFiniteIntegerWithin(settings.roundsPerStep, MIN_TEMPO_TRAINING_ROUNDS, MAX_TEMPO_TRAINING_ROUNDS)) {
    return 'Choose between ' + MIN_TEMPO_TRAINING_ROUNDS + ' and ' + MAX_TEMPO_TRAINING_ROUNDS + ' full rounds between increases.'
  }
  return null
}

function isFiniteWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isFiniteIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
