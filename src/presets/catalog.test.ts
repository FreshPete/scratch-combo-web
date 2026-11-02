import { describe, expect, it, vi } from 'vitest'
import {
  fetchBuiltInPresetCatalog,
  loadBuiltInPreset,
  type BuiltInPresetEntry,
  type PresetFetch,
} from './catalog'

const supportedEntries: BuiltInPresetEntry[] = [
  { id: 'SSC-085BPM-01', label: '85 BPM - Beginner', bpm: 85, iniFile: 'SSC-085BPM-01.ini', audioDirectory: '085BPM' },
  { id: 'SSC-085BPM-02', label: '85 BPM - Average', bpm: 85, iniFile: 'SSC-085BPM-02.ini', audioDirectory: '085BPM' },
  { id: 'SSC-085BPM-03', label: '85 BPM - Good', bpm: 85, iniFile: 'SSC-085BPM-03.ini', audioDirectory: '085BPM' },
  { id: 'SSC-085BPM-04', label: '85 BPM - Very Good', bpm: 85, iniFile: 'SSC-085BPM-04.ini', audioDirectory: '085BPM' },
  { id: 'SSC-085BPM-05', label: '85 BPM - Expert', bpm: 85, iniFile: 'SSC-085BPM-05.ini', audioDirectory: '085BPM' },
  { id: 'SSC-096BPM2-01', label: '96 BPM Set 2', bpm: 96, iniFile: 'SSC-096BPM2-01.ini', audioDirectory: '096BPM2' },
]

function privatePresetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}private-presets/${path}`, window.location.origin).toString()
}

const iniText = [
  '[Samples]',
  'ConfigName=85 BPM - Beginner',
  'BPM01=85',
  'Beat01=_Beat 01+.wav',
  'Beat02=beat-two.wav',
  'VOL_B=60',
  'VOL_S=80',
  'RootSamplePathRelative=True',
  'RootSamplePath=085BPM',
  '',
  '[Sample01]',
  'SamplePlayFq=1',
  'SampleIsSilent=False',
  'SampleRepeatsPoss=True',
  'SampleRepeatMax=512',
  'SampleFileName=Baby Fade+64.wav',
  'SampleDisplayName=Baby Fade',
  'SampleStartsForward=True',
  'SampleEndsForward=False',
  'Sample16ths=8',
  'UseSample=True',
].join('\n')

function response(options: {
  url?: string
  status?: number
  json?: unknown
  text?: string
} = {}): Response {
  const status = options.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? '',
    json: async () => options.json,
    text: async () => options.text ?? '',
    blob: async () => new Blob(['wav bytes'], { type: 'audio/wav' }),
  } as Response
}

describe('built-in preset catalog boundary', () => {
  it('loads the six-entry catalog from the same-origin private preset route', async () => {
    const fetcher: PresetFetch = vi.fn(async () => response({
      json: { version: 1, defaultPresetId: 'SSC-085BPM-01', presets: supportedEntries },
    }))

    const catalog = await fetchBuiltInPresetCatalog(fetcher)

    expect(catalog.presets).toHaveLength(6)
    expect(fetcher).toHaveBeenCalledWith(
      privatePresetUrl('catalog.json'),
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('encodes filename segments, loads every referenced WAV, and attaches safe relative paths', async () => {
    const requested: string[] = []
    const fetcher: PresetFetch = vi.fn(async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/SSC-085BPM-01.ini')) return response({ text: iniText })
      return response()
    })

    const loaded = await loadBuiltInPreset(supportedEntries[0]!, { fetcher })

    expect(requested).toContain(privatePresetUrl('085BPM/Baby%20Fade%2B64.wav'))
    expect(requested).toContain(privatePresetUrl('085BPM/_Beat%2001%2B.wav'))
    expect(loaded.audioFiles).toHaveLength(3)
    expect(loaded.audioFiles.map((file) => (file as File & { webkitRelativePath: string }).webkitRelativePath)).toEqual([
      '085BPM/Baby Fade+64.wav',
      '085BPM/_Beat 01+.wav',
      '085BPM/beat-two.wav',
    ])
  })

  it('rejects unsupported catalog entries and traversal in referenced file names', async () => {
    const unsupportedFetcher: PresetFetch = vi.fn()
    await expect(loadBuiltInPreset({
      ...supportedEntries[0]!,
      iniFile: '../outside.ini',
    }, { fetcher: unsupportedFetcher })).rejects.toThrow('not supported')
    expect(unsupportedFetcher).not.toHaveBeenCalled()

    const unsafeIni = iniText.replace('SampleFileName=Baby Fade+64.wav', 'SampleFileName=../outside.wav')
    const requested: string[] = []
    const fetcher: PresetFetch = vi.fn(async (input) => {
      requested.push(String(input))
      return response({ text: unsafeIni })
    })
    await expect(loadBuiltInPreset(supportedEntries[0]!, { fetcher })).rejects.toThrow('unsafe file path')
    const privatePresetPath = new URL(privatePresetUrl(''), window.location.origin).pathname
    expect(requested.every((url) => new URL(url).pathname.startsWith(privatePresetPath))).toBe(true)
    expect(requested.some((url) => url.includes('outside.wav'))).toBe(false)
  })

  it('rejects a response redirected outside the private preset directory', async () => {
    const fetcher: PresetFetch = vi.fn(async (input) => response({
      url: String(input).endsWith('catalog.json') ? 'https://example.invalid/private-presets/catalog.json' : '',
      json: { version: 1, defaultPresetId: 'SSC-085BPM-01', presets: supportedEntries },
    }))

    await expect(fetchBuiltInPresetCatalog(fetcher)).rejects.toThrow('left the private preset directory')
  })
})
