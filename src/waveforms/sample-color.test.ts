import { describe, expect, it } from 'vitest'
import { SAMPLE_COLOR_COUNT, SAMPLE_COLOR_PALETTE, sampleColorForName } from './sample-color'

describe('sample waveform colors', () => {
  it('uses a finite palette and returns the same color for normalized labels', () => {
    expect(new Set(SAMPLE_COLOR_PALETTE).size).toBe(SAMPLE_COLOR_COUNT)
    expect(SAMPLE_COLOR_PALETTE).toContain(sampleColorForName('Kick'))
    expect(sampleColorForName('  BABY(F)  ')).toBe(sampleColorForName('Baby(F)'))
    expect(sampleColorForName('Tone   1')).toBe(sampleColorForName('tone 1'))
  })

  it('keeps a sample color stable when the lookup is repeated', () => {
    expect(sampleColorForName('Bundled kick')).toBe(sampleColorForName('Bundled kick'))
  })
})
