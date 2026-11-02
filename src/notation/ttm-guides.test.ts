import { describe, expect, it } from 'vitest'
import {
  TTM_GUIDES,
  TTM_GUIDE_PROVENANCE,
  UNTRANSCRIBED,
  getTtmGuide,
  suggestedGuideForSampleName,
  ttmMotionSvgPath,
  validateTtmAnnotation,
} from './ttm-guides'

function guideInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TTM_GUIDES['baby-rub'], ...overrides }
}

describe('illustrative TTM guide catalogue', () => {
  it('provides a small immutable set of source-attributed guides', () => {
    expect(Object.keys(TTM_GUIDES)).toEqual([
      'baby-rub',
      'forward-movement',
      'backward-movement',
      'forward-cut',
    ])
    expect(Object.isFrozen(TTM_GUIDES)).toBe(true)
    expect(Object.isFrozen(TTM_GUIDES['baby-rub'])).toBe(true)
    expect(Object.isFrozen(TTM_GUIDES['baby-rub'].motion)).toBe(true)
    expect(Object.isFrozen(TTM_GUIDES['baby-rub'].motion[0])).toBe(true)
    expect(Object.isFrozen(TTM_GUIDES['forward-cut'].faderIntervals[1])).toBe(true)
    expect(TTM_GUIDES['forward-cut'].provenance.kind).toBe(TTM_GUIDE_PROVENANCE)
    expect(TTM_GUIDES['forward-cut'].provenance.sourceUrl).toBe('https://www.ttm-dj.com/ttm-01-01-basics/')
    expect(TTM_GUIDES['forward-cut'].provenance.note).toMatch(/not transcribed from or verified against any sample audio/i)
  })

  it('uses rising and falling movement paths and the fader gates in the teaching examples', () => {
    expect(ttmMotionSvgPath(TTM_GUIDES['baby-rub'].motion)).toBe('M0 100 L50 0 L100 100')
    expect(ttmMotionSvgPath(TTM_GUIDES['forward-movement'].motion)).toBe('M0 100 L100 0')
    expect(ttmMotionSvgPath(TTM_GUIDES['backward-movement'].motion)).toBe('M0 0 L100 100')
    expect(TTM_GUIDES['baby-rub'].faderIntervals).toEqual([
      { start: 0, end: 1, state: 'open' },
    ])
    expect(TTM_GUIDES['forward-cut'].faderIntervals).toEqual([
      { start: 0, end: 0.5, state: 'open' },
      { start: 0.5, end: 1, state: 'closed' },
    ])
  })

  it('returns only finite exact-name suggestions and does not assign them', () => {
    expect(suggestedGuideForSampleName('Baby')).toBe('baby-rub')
    expect(suggestedGuideForSampleName(' Baby(F) ')).toBe('forward-movement')
    expect(suggestedGuideForSampleName('baby(r)')).toBe('backward-movement')
    expect(suggestedGuideForSampleName('Baby forward')).toBeNull()
    expect(suggestedGuideForSampleName('Fresh')).toBeNull()
    expect(suggestedGuideForSampleName('toString')).toBeNull()
    expect(getTtmGuide('invented-pattern')).toBeNull()
    expect(UNTRANSCRIBED).toEqual({ kind: 'untranscribed' })
    expect(validateTtmAnnotation(UNTRANSCRIBED)).toEqual({ valid: true, issues: [] })
  })

  it('validates each guide as a complete normalized annotation', () => {
    for (const guide of Object.values(TTM_GUIDES)) {
      expect(validateTtmAnnotation(guide)).toEqual({ valid: true, issues: [] })
    }
  })
})

describe('TTM annotation validation', () => {
  it('rejects a repeated time coordinate instead of representing a vertical jump', () => {
    const result = validateTtmAnnotation(guideInput({
      motion: [
        { time: 0, samplePosition: 0 },
        { time: 0.5, samplePosition: 1 },
        { time: 0.5, samplePosition: 0 },
        { time: 1, samplePosition: 0 },
      ],
    }))

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'motion-time-order' }))
  })

  it('rejects coordinates outside the normalized sample and time ranges', () => {
    const result = validateTtmAnnotation(guideInput({
      motion: [
        { time: 0, samplePosition: -0.1 },
        { time: 1.1, samplePosition: 1 },
      ],
    }))

    expect(result.valid).toBe(false)
    expect(result.issues.filter(({ code }) => code === 'motion-out-of-range')).toHaveLength(2)
  })

  it('requires motion to span the complete normalized time range', () => {
    const result = validateTtmAnnotation(guideInput({
      motion: [
        { time: 0.1, samplePosition: 0 },
        { time: 0.9, samplePosition: 1 },
      ],
    }))

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'motion-endpoints' }))
  })

  it('requires fader intervals to partition the full pattern without gaps or overlaps', () => {
    const gap = validateTtmAnnotation(guideInput({
      faderIntervals: [
        { start: 0, end: 0.4, state: 'open' },
        { start: 0.5, end: 1, state: 'closed' },
      ],
    }))
    const overlap = validateTtmAnnotation(guideInput({
      faderIntervals: [
        { start: 0, end: 0.6, state: 'open' },
        { start: 0.5, end: 1, state: 'closed' },
      ],
    }))
    const incomplete = validateTtmAnnotation(guideInput({
      faderIntervals: [{ start: 0, end: 0.5, state: 'open' }],
    }))

    expect(gap.issues).toContainEqual(expect.objectContaining({ code: 'fader-gap-or-overlap' }))
    expect(overlap.issues).toContainEqual(expect.objectContaining({ code: 'fader-gap-or-overlap' }))
    expect(incomplete.issues).toContainEqual(expect.objectContaining({ code: 'fader-coverage' }))
  })

  it('requires the provenance label and refuses inferred data on the Untranscribed marker', () => {
    const badProvenance = validateTtmAnnotation(guideInput({
      provenance: { kind: 'audio-analysis', sourceTitle: 'WAV', sourceUrl: 'file:///sample.wav', note: 'inferred' },
    }))
    const falseRest = validateTtmAnnotation({ kind: 'untranscribed', motion: [] })

    expect(badProvenance.issues).toContainEqual(expect.objectContaining({ code: 'invalid-provenance' }))
    expect(falseRest.issues).toContainEqual(expect.objectContaining({ code: 'unknown-kind' }))
  })
})
