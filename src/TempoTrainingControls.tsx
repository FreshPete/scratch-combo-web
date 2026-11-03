import type { TempoTrainingRange, TempoTrainingSettings } from './tempo-training'
import {
  MAX_TEMPO_TRAINING_BPM,
  MAX_TEMPO_TRAINING_ROUNDS,
  MAX_TEMPO_TRAINING_STEP_BPM,
  MIN_TEMPO_TRAINING_BPM,
  MIN_TEMPO_TRAINING_ROUNDS,
  MIN_TEMPO_TRAINING_STEP_BPM,
  tempoTrainingValidationMessage,
} from './tempo-training'

export interface TempoTrainingControlsProps {
  settings: TempoTrainingSettings
  currentBpm: number
  tempoRange: TempoTrainingRange | null
  repeatingPracticeAvailable: boolean
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onTargetBpmChange: (targetBpm: number) => void
  onStepBpmChange: (stepBpm: number) => void
  onRoundsPerStepChange: (roundsPerStep: number) => void
}

export function TempoTrainingControls({
  settings,
  currentBpm,
  tempoRange,
  repeatingPracticeAvailable,
  disabled,
  onEnabledChange,
  onTargetBpmChange,
  onStepBpmChange,
  onRoundsPerStepChange,
}: TempoTrainingControlsProps) {
  const validationMessage = tempoTrainingValidationMessage(
    settings,
    currentBpm,
    tempoRange,
    repeatingPracticeAvailable,
  )
  const targetInvalid = Boolean(validationMessage && /target bpm|finite target/i.test(validationMessage))
  const stepInvalid = Boolean(validationMessage && /increase by a whole number/i.test(validationMessage))
  const roundsInvalid = Boolean(validationMessage && /full rounds between increases/i.test(validationMessage))
  const fieldsDisabled = disabled
  const minimumTarget = tempoRange ? Math.max(MIN_TEMPO_TRAINING_BPM, tempoRange.min) : MIN_TEMPO_TRAINING_BPM
  const maximumTarget = tempoRange ? Math.min(MAX_TEMPO_TRAINING_BPM, tempoRange.max) : MAX_TEMPO_TRAINING_BPM

  return (
    <details id="tempo-training" className="session-controls__tempo-trainer">
      <summary>
        <span>Tempo trainer</span>
        <span className="session-controls__tempo-trainer-state">{settings.enabled ? 'On' : 'Off'}</span>
      </summary>
      <div className="session-controls__tempo-trainer-body">
        <label className="session-controls__tempo-trainer-toggle">
          <input
            id="tempo-training-enabled"
            type="checkbox"
            checked={settings.enabled}
            disabled={disabled}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          />
          <span>Enable tempo training</span>
        </label>
        <label className="session-controls__tempo-trainer-field" htmlFor="tempo-training-target-bpm">
          <span>Target BPM</span>
          <input
            id="tempo-training-target-bpm"
            type="number"
            inputMode="decimal"
            min={minimumTarget}
            max={maximumTarget}
            step="0.1"
            value={settings.targetBpm}
            disabled={fieldsDisabled}
            aria-invalid={targetInvalid || undefined}
            aria-describedby={validationMessage ? 'tempo-training-help tempo-training-message' : 'tempo-training-help'}
            onChange={(event) => {
              const value = event.currentTarget.value
              const targetBpm = Number(value)
              if (value !== '' && Number.isFinite(targetBpm) && targetBpm >= MIN_TEMPO_TRAINING_BPM && targetBpm <= MAX_TEMPO_TRAINING_BPM) {
                onTargetBpmChange(targetBpm)
              }
            }}
          />
        </label>
        <label className="session-controls__tempo-trainer-field" htmlFor="tempo-training-step-bpm">
          <span>Increase by (BPM)</span>
          <input
            id="tempo-training-step-bpm"
            type="number"
            inputMode="numeric"
            min={MIN_TEMPO_TRAINING_STEP_BPM}
            max={MAX_TEMPO_TRAINING_STEP_BPM}
            step="1"
            value={settings.stepBpm}
            disabled={fieldsDisabled}
            aria-invalid={stepInvalid || undefined}
            aria-describedby={validationMessage ? 'tempo-training-help tempo-training-message' : 'tempo-training-help'}
            onChange={(event) => {
              const value = event.currentTarget.value
              const stepBpm = Number(value)
              if (value !== '' && Number.isSafeInteger(stepBpm) && stepBpm >= MIN_TEMPO_TRAINING_STEP_BPM && stepBpm <= MAX_TEMPO_TRAINING_STEP_BPM) {
                onStepBpmChange(stepBpm)
              }
            }}
          />
        </label>
        <label className="session-controls__tempo-trainer-field" htmlFor="tempo-training-rounds-per-step">
          <span>Every full practice rounds</span>
          <input
            id="tempo-training-rounds-per-step"
            type="number"
            inputMode="numeric"
            min={MIN_TEMPO_TRAINING_ROUNDS}
            max={MAX_TEMPO_TRAINING_ROUNDS}
            step="1"
            value={settings.roundsPerStep}
            disabled={fieldsDisabled}
            aria-invalid={roundsInvalid || undefined}
            aria-describedby={validationMessage ? 'tempo-training-help tempo-training-message' : 'tempo-training-help'}
            onChange={(event) => {
              const value = event.currentTarget.value
              const roundsPerStep = Number(value)
              if (value !== '' && Number.isSafeInteger(roundsPerStep) && roundsPerStep >= MIN_TEMPO_TRAINING_ROUNDS && roundsPerStep <= MAX_TEMPO_TRAINING_ROUNDS) {
                onRoundsPerStepChange(roundsPerStep)
              }
            }}
          />
        </label>
        <p id="tempo-training-help" className="session-controls__tempo-trainer-help">
          Starts from the current BPM on each Play. A Loop round is one full pass; Q&amp;A includes its whole answer window, and Large pause includes all three silent cycles. The trainer holds at the target.
        </p>
        {validationMessage ? (
          <p id="tempo-training-message" className="session-controls__tempo-trainer-message" role="status" aria-live="polite">
            {validationMessage}
          </p>
        ) : settings.enabled ? (
          <p id="tempo-training-message" className="session-controls__tempo-trainer-message" role="status" aria-live="polite">
            Increase by {settings.stepBpm} BPM every {settings.roundsPerStep} full {settings.roundsPerStep === 1 ? 'round' : 'rounds'} until {settings.targetBpm} BPM.
          </p>
        ) : null}
      </div>
    </details>
  )
}
