export const TTM_GUIDE_PROVENANCE = 'illustrative-technique-guide' as const

export const UNTRANSCRIBED = Object.freeze({ kind: 'untranscribed' as const })

export type TtmGuideId = 'baby-rub' | 'forward-movement' | 'backward-movement' | 'forward-cut'

export interface TtmMotionPoint {
  readonly time: number
  readonly samplePosition: number
}

export type TtmFaderState = 'open' | 'closed'

export interface TtmFaderInterval {
  readonly start: number
  readonly end: number
  readonly state: TtmFaderState
}

export interface TtmGuideProvenance {
  readonly kind: typeof TTM_GUIDE_PROVENANCE
  readonly sourceTitle: string
  readonly sourceUrl: string
  readonly note: string
}

export interface TtmGuide {
  readonly kind: 'guide'
  readonly schemaVersion: 1
  readonly id: TtmGuideId
  readonly label: string
  readonly explanation: string
  readonly motion: readonly TtmMotionPoint[]
  readonly faderIntervals: readonly TtmFaderInterval[]
  readonly provenance: TtmGuideProvenance
}

export type TtmSampleAnnotation = typeof UNTRANSCRIBED | TtmGuide
export type TtmSampleGuideSelection = typeof UNTRANSCRIBED | TtmGuideId

export type TtmValidationIssueCode =
  | 'not-object'
  | 'unknown-kind'
  | 'unsupported-schema'
  | 'invalid-guide-label'
  | 'invalid-guide-explanation'
  | 'unknown-guide'
  | 'invalid-provenance'
  | 'invalid-motion'
  | 'invalid-motion-point'
  | 'motion-out-of-range'
  | 'motion-time-order'
  | 'motion-endpoints'
  | 'invalid-fader-interval'
  | 'fader-gap-or-overlap'
  | 'fader-coverage'

export interface TtmValidationIssue {
  readonly code: TtmValidationIssueCode
  readonly path: string
  readonly message: string
}

export interface TtmValidationResult {
  readonly valid: boolean
  readonly issues: readonly TtmValidationIssue[]
}

const GUIDE_SOURCE_URL = 'https://www.ttm-dj.com/ttm-01-01-basics/'
const GUIDE_SOURCE_TITLE = 'TTM • Turntablist Transcription Method — Basics'
const GUIDE_PROVENANCE_NOTE =
  'Illustrative technique guide adapted from the source text; not transcribed from or verified against any sample audio.'

function freezeGuide(guide: TtmGuide): TtmGuide {
  const motion = Object.freeze(guide.motion.map((point) => Object.freeze({ ...point })))
  const faderIntervals = Object.freeze(guide.faderIntervals.map((interval) => Object.freeze({ ...interval })))
  const provenance = Object.freeze({ ...guide.provenance })

  return Object.freeze({ ...guide, motion, faderIntervals, provenance })
}

function createGuide(
  id: TtmGuideId,
  label: string,
  explanation: string,
  motion: readonly TtmMotionPoint[],
  faderIntervals: readonly TtmFaderInterval[],
): TtmGuide {
  return freezeGuide({
    kind: 'guide',
    schemaVersion: 1,
    id,
    label,
    explanation,
    motion,
    faderIntervals,
    provenance: {
      kind: TTM_GUIDE_PROVENANCE,
      sourceTitle: GUIDE_SOURCE_TITLE,
      sourceUrl: GUIDE_SOURCE_URL,
      note: GUIDE_PROVENANCE_NOTE,
    },
  })
}

const OPEN_FOR_FULL_PATTERN = [{ start: 0, end: 1, state: 'open' }] as const

export const TTM_GUIDES: Readonly<Record<TtmGuideId, TtmGuide>> = Object.freeze({
  'baby-rub': createGuide(
    'baby-rub',
    'Baby / rub',
    'A simplified forward-and-back record motion with the fader open throughout.',
    [
      { time: 0, samplePosition: 0 },
      { time: 0.5, samplePosition: 1 },
      { time: 1, samplePosition: 0 },
    ],
    OPEN_FOR_FULL_PATTERN,
  ),
  'forward-movement': createGuide(
    'forward-movement',
    'Forward movement',
    'One forward record movement, represented by an upward path with the fader open.',
    [
      { time: 0, samplePosition: 0 },
      { time: 1, samplePosition: 1 },
    ],
    OPEN_FOR_FULL_PATTERN,
  ),
  'backward-movement': createGuide(
    'backward-movement',
    'Backward movement',
    'One backward record movement, represented by a downward path with the fader open.',
    [
      { time: 0, samplePosition: 1 },
      { time: 1, samplePosition: 0 },
    ],
    OPEN_FOR_FULL_PATTERN,
  ),
  'forward-cut': createGuide(
    'forward-cut',
    'Forward cut',
    'A simplified forward-and-back path with the fader open on the forward stroke and closed on the return.',
    [
      { time: 0, samplePosition: 0 },
      { time: 0.5, samplePosition: 1 },
      { time: 1, samplePosition: 0 },
    ],
    [
      { start: 0, end: 0.5, state: 'open' },
      { start: 0.5, end: 1, state: 'closed' },
    ],
  ),
})

const GUIDE_IDS = new Set<string>(Object.keys(TTM_GUIDES))

/** Returns a fixed illustrative guide by ID. It never derives a guide from audio. */
export function getTtmGuide(id: string): TtmGuide | null {
  return GUIDE_IDS.has(id) ? TTM_GUIDES[id as TtmGuideId] : null
}

const SAMPLE_NAME_SUGGESTIONS: Readonly<Record<string, TtmGuideId>> = Object.freeze({
  baby: 'baby-rub',
  'baby(f)': 'forward-movement',
  'baby(r)': 'backward-movement',
})

/**
 * Returns a suggestion for a small, explicit set of legacy display names.
 * The caller must ask the user to select it; this function does not annotate a sample.
 */
export function suggestedGuideForSampleName(name: string): TtmGuideId | null {
  const exactAlias = name.trim().toLocaleLowerCase('en-GB')
  return Object.hasOwn(SAMPLE_NAME_SUGGESTIONS, exactAlias)
    ? SAMPLE_NAME_SUGGESTIONS[exactAlias]!
    : null
}

/** Maps normalized sample position to an SVG staff coordinate (forward goes upward). */
export function ttmMotionSvgPath(motion: readonly TtmMotionPoint[]): string {
  return motion.map((point, index) => {
    const x = point.time * 100
    const y = (1 - point.samplePosition) * 100
    return `${index === 0 ? 'M' : 'L'}${x} ${y}`
  }).join(' ')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(
  code: TtmValidationIssueCode,
  path: string,
  message: string,
): TtmValidationIssue {
  return { code, path, message }
}

/** Validates imported/constructed annotation data without reading browser or audio state. */
export function validateTtmAnnotation(value: unknown): TtmValidationResult {
  const issues: TtmValidationIssue[] = []
  if (!isObject(value)) {
    return { valid: false, issues: [issue('not-object', '$', 'Annotation must be an object.')] }
  }

  if (value.kind === 'untranscribed') {
    const onlyKind = Object.keys(value).length === 1 && value.kind === 'untranscribed'
    return onlyKind
      ? { valid: true, issues: [] }
      : {
          valid: false,
          issues: [issue('unknown-kind', '$', 'Untranscribed is a marker only and must not carry inferred movement or fader data.')],
        }
  }

  if (value.kind !== 'guide') {
    return { valid: false, issues: [issue('unknown-kind', '$.kind', 'Expected an illustrative guide or the Untranscribed marker.')] }
  }

  if (typeof value.id !== 'string' || !GUIDE_IDS.has(value.id)) {
    issues.push(issue('unknown-guide', '$.id', 'Guide ID is not in the finite guide catalogue.'))
  }
  if (value.schemaVersion !== 1) {
    issues.push(issue('unsupported-schema', '$.schemaVersion', 'Guide annotation schema version must be 1.'))
  }
  if (typeof value.label !== 'string' || value.label.length === 0) {
    issues.push(issue('invalid-guide-label', '$.label', 'Guide annotations need a display label.'))
  }
  if (typeof value.explanation !== 'string' || value.explanation.length === 0) {
    issues.push(issue('invalid-guide-explanation', '$.explanation', 'Guide annotations need a short explanation.'))
  }
  if (!isObject(value.provenance) || value.provenance.kind !== TTM_GUIDE_PROVENANCE
    || typeof value.provenance.sourceTitle !== 'string'
    || typeof value.provenance.sourceUrl !== 'string'
    || value.provenance.sourceUrl !== GUIDE_SOURCE_URL
    || typeof value.provenance.note !== 'string'
    || value.provenance.note.length === 0) {
    issues.push(issue('invalid-provenance', '$.provenance.kind', 'Guide annotations must be labeled as illustrative technique guides.'))
  }

  if (!Array.isArray(value.motion) || value.motion.length < 2) {
    issues.push(issue('invalid-motion', '$.motion', 'Motion must contain at least two points.'))
  } else {
    let previousTime: number | null = null
    value.motion.forEach((point, index) => {
      const path = `$.motion[${index}]`
      if (!isObject(point) || typeof point.time !== 'number' || typeof point.samplePosition !== 'number'
        || !Number.isFinite(point.time) || !Number.isFinite(point.samplePosition)) {
        issues.push(issue('invalid-motion-point', path, 'Motion points require finite numeric time and samplePosition values.'))
        return
      }
      if (point.time < 0 || point.time > 1 || point.samplePosition < 0 || point.samplePosition > 1) {
        issues.push(issue('motion-out-of-range', path, 'Time and sample position must stay within [0, 1].'))
      }
      if (previousTime !== null && point.time <= previousTime) {
        issues.push(issue('motion-time-order', `${path}.time`, 'Time must strictly increase; vertical jumps are not represented.'))
      }
      previousTime = point.time
    })

    const first = value.motion[0]
    const last = value.motion[value.motion.length - 1]
    if (isObject(first) && isObject(last) && (first.time !== 0 || last.time !== 1)) {
      issues.push(issue('motion-endpoints', '$.motion', 'Motion must cover the full normalized time range from 0 to 1.'))
    }
  }

  if (!Array.isArray(value.faderIntervals) || value.faderIntervals.length === 0) {
    issues.push(issue('invalid-fader-interval', '$.faderIntervals', 'Fader intervals must describe the full pattern.'))
  } else {
    let expectedStart = 0
    value.faderIntervals.forEach((interval, index) => {
      const path = `$.faderIntervals[${index}]`
      if (!isObject(interval) || typeof interval.start !== 'number' || typeof interval.end !== 'number'
        || !Number.isFinite(interval.start) || !Number.isFinite(interval.end)
        || (interval.state !== 'open' && interval.state !== 'closed')
        || interval.start < 0 || interval.end > 1 || interval.end <= interval.start) {
        issues.push(issue(
          'invalid-fader-interval',
          path,
          'Fader intervals need a valid open/closed state and positive duration within [0, 1].',
        ))
        return
      }
      if (interval.start !== expectedStart) {
        issues.push(issue('fader-gap-or-overlap', `${path}.start`, 'Fader intervals must be ordered, contiguous, and non-overlapping.'))
      }
      expectedStart = interval.end
    })
    if (expectedStart !== 1) {
      issues.push(issue('fader-coverage', '$.faderIntervals', 'Fader intervals must cover the full normalized time range from 0 to 1.'))
    }
  }

  return { valid: issues.length === 0, issues }
}
