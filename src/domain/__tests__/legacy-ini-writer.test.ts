import { describe, expect, it } from 'vitest';
import { isLegacyGenerationEnabled } from '../legacy-generation-outer';
import {
  parseLegacyIni,
  patchLegacyIniText,
  type Preset,
} from '../index';

function makeIni(): string {
  return [
    '; leading comment stays',
    '[Samples]',
    'CONFIGNAME=Fixture',
    'VOL_B=100',
    'VOL_S=80',
    'RootSamplePathRelative=True',
    'RootSamplePath=085BPM',
    'Beat01=Beat01.wav',
    'Beat02=Beat02.wav',
    'BPM01=85',
    '',
    '[Sample01]',
    'SamplePlayFq=1',
    'SampleIsSilent=True',
    'SampleRepeatsPoss=True',
    'SampleRepeatMax=2',
    'SampleFileName=silent.wav',
    'SampleDisplayName=Silent row',
    'SampleStartsForward=True',
    'SampleEndsForward=False',
    'Sample16ths=8 ; duration comment',
    'UseSample=False',
    'FutureSampleValue=preserve me',
    '',
    '[Sample02]',
    'SamplePlayFq=3',
    'SampleIsSilent=False',
    'SampleRepeatsPoss=False',
    'SampleRepeatMax=4',
    'SampleFileName=kick.wav',
    'SampleDisplayName=Kick',
    'SampleStartsForward=False',
    'SampleEndsForward=True',
    'Sample16ths=16',
    'UseSample=True',
    '',
    '[FutureSection]',
    'UnknownSetting=stay exactly as written',
    '',
  ].join('\r\n');
}

function changedPreset(source: string, update: (preset: Preset) => Preset): Preset {
  return update(parseLegacyIni(source));
}

describe('patchLegacyIniText', () => {
  it('returns an unchanged source byte-for-byte, including BOM-free CRLF, comments, unknown data, and raw silent flags', () => {
    const source = makeIni();
    const { text, preset } = patchLegacyIniText(source, parseLegacyIni(source));

    expect(text).toBe(source);
    expect(preset.bpm).toBe(85);
    expect(preset.beatFiles).toEqual(['Beat01.wav', 'Beat02.wav']);
    expect(preset.samples[0]).toMatchObject({ id: 'Sample01', silent: true, enabled: false });
    expect(isLegacyGenerationEnabled(preset.samples[0]!)).toBe(true);
  });

  it('patches one sample field and an optional level while preserving tempo, beat choices, order, and untouched text', () => {
    const source = makeIni();
    const edited = changedPreset(source, (preset) => ({
      ...preset,
      bpm: 100,
      beatVolume: 96,
      samples: preset.samples.map((sample) => sample.id === 'Sample02'
        ? { ...sample, durationUnits: 24 }
        : sample),
    }));

    const result = patchLegacyIniText(source, edited);
    const expected = source
      .replace('VOL_B=100', 'VOL_B=96')
      .replace('Sample16ths=16', 'Sample16ths=24');
    expect(result.text).toBe(expected);
    expect(result.preset).toMatchObject({ bpm: 85, beatFiles: ['Beat01.wav', 'Beat02.wav'], beatVolume: 96 });
    expect(result.preset.samples[1]).toMatchObject({ id: 'Sample02', durationUnits: 24 });
  });

  it('preserves an unchanged legacy integer above the editor limit when another field changes', () => {
    const source = makeIni().replace('Sample16ths=16', 'Sample16ths=1000000');
    const edited = changedPreset(source, (preset) => ({
      ...preset,
      samples: preset.samples.map((sample) => sample.id === 'Sample02'
        ? { ...sample, canRepeat: true }
        : sample),
    }));

    const result = patchLegacyIniText(source, edited);
    expect(result.text).toContain('Sample16ths=1000000');
    expect(result.text).toContain('SampleRepeatsPoss=True');
    expect(result.preset.samples[1]?.durationUnits).toBe(1_000_000);
  });

  it('reparses a row edit and rejects unsafe numeric, volume, ordering, and read-only edits', () => {
    const source = makeIni();
    const base = parseLegacyIni(source);
    const negative = { ...base, samples: base.samples.map((sample, index) => index === 1 ? { ...sample, durationUnits: -1 } : sample) };
    const fractional = { ...base, samples: base.samples.map((sample, index) => index === 1 ? { ...sample, weight: 1.5 } : sample) };
    const largeWeight = { ...base, samples: base.samples.map((sample, index) => index === 1 ? { ...sample, weight: 10_001 } : sample) };
    const largeRepeat = { ...base, samples: base.samples.map((sample, index) => index === 1 ? { ...sample, maxRepeat: 8_193 } : sample) };

    expect(() => patchLegacyIniText(source, negative)).toThrow('durationUnits must be an integer from 0');
    expect(() => patchLegacyIniText(source, fractional)).toThrow('weight must be an integer from 0');
    expect(() => patchLegacyIniText(source, largeWeight)).toThrow('weight must be an integer from 0');
    expect(() => patchLegacyIniText(source, largeRepeat)).toThrow('maxRepeat must be an integer from 0');
    expect(() => patchLegacyIniText(source, { ...base, sampleVolume: 101 })).toThrow('Sample level must be an integer from 0 to 100');
    expect(() => patchLegacyIniText(source, { ...base, samples: [...base.samples].reverse() })).toThrow('cannot be changed');
    expect(() => patchLegacyIniText(source, { ...base, samples: base.samples.map((sample, index) => index === 1 ? { ...sample, fileName: 'other.wav' } : sample) })).toThrow('file reference');
  });

  it('keeps silent UseSample=False untouched but prevents disabling an effective silent row', () => {
    const source = makeIni();
    const base = parseLegacyIni(source);
    const changedOtherField = {
      ...base,
      samples: base.samples.map((sample) => sample.id === 'Sample01'
        ? { ...sample, durationUnits: 9 }
        : sample),
    };
    const result = patchLegacyIniText(source, changedOtherField);
    expect(result.text).toContain('UseSample=False');
    expect(isLegacyGenerationEnabled(result.preset.samples[0]!)).toBe(true);

    const sourceWithEnabledSilent = source.replace('UseSample=False', 'UseSample=True');
    const enabledPreset = parseLegacyIni(sourceWithEnabledSilent);
    const disabledSilent = {
      ...enabledPreset,
      samples: enabledPreset.samples.map((sample) => sample.id === 'Sample01'
        ? { ...sample, enabled: false }
        : sample),
    };
    expect(() => patchLegacyIniText(sourceWithEnabledSilent, disabledSilent)).toThrow('effective UseSample setting cannot be disabled');
  });
});
