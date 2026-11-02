export const SAMPLE_COLOR_PALETTE = [
  '#17d9ff', // electric cyan
  '#ff4fa3', // hot pink
  '#ff9f1c', // orange
  '#a8f000', // neon lime
  '#b176ff', // violet
  '#18e4b0', // teal
  '#4d91ff', // electric blue
] as const

/** Assigns a stable waveform color from the normalized display name. */
export function sampleColorForName(name: string): string {
  const normalized = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  let hash = 0x811c9dc5
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return SAMPLE_COLOR_PALETTE[hash % SAMPLE_COLOR_PALETTE.length]!
}

export const SAMPLE_COLOR_COUNT = SAMPLE_COLOR_PALETTE.length
