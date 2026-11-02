import { describe, expect, it } from 'vitest';
import {
  buildAssetIndex,
  buildPreviewFixture,
  DEMO_PRESET,
  parseLegacyIni,
  resolvePresetAssets,
  REST_SAMPLE_ID,
  type Preset,
  type SampleDefinition,
} from '../index';

function makeIni(sampleCount: number): string {
  const header = [
    '// Synthetic parser fixture',
    '[Samples]',
    'CONFIGNAME=Synthetic preset',
    'VOL_B=95',
    'VOL_S=80',
    'RootSamplePathRelative=True',
    'RootSamplePath=085BPM',
    'Beat01=beat.wav',
    'Beat02=beat-2.wav',
    'BPM01=85',
  ];
  const sampleSections = Array.from({ length: sampleCount }, (_, offset) => {
    const index = offset + 1;
    const section = `Sample${String(index).padStart(2, '0')}`;
    return [
      '',
      `[${section}]`,
      `SamplePlayFq=${(index % 4) + 1}`,
      `SampleIsSilent=${index === 1 ? 'True' : 'False'}`,
      `SampleRepeatsPoss=${index % 2 === 0 ? 'True' : 'False'}`,
      `SampleRepeatMax=${index % 5}`,
      `SampleFileName=sample-${index}.wav`,
      `SampleDisplayName=Sample ${index}`,
      `SampleStartsForward=${index % 2 === 1 ? 'True' : 'False'}`,
      `SampleEndsForward=${index % 3 === 0 ? 'True' : 'False'}`,
      `Sample16ths=${index % 7 === 0 ? 0 : index + 1}`,
      `UseSample=${index % 3 === 0 ? 'False' : 'True'}`,
    ].join('\n');
  });
  return [...header, ...sampleSections].join('\n');
}

function file(name: string, relativePath?: string): File {
  const selected = new File(['synthetic wav bytes'], name, { type: 'audio/wav' });
  if (relativePath) Object.defineProperty(selected, 'webkitRelativePath', { value: relativePath });
  return selected;
}

function oneSamplePreset(fileName: string, legacyRootPath?: string): Preset {
  const sample: SampleDefinition = {
    id: 'sample-1',
    name: 'Sample',
    fileName,
    durationUnits: 4,
    weight: 1,
    startForward: true,
    endForward: false,
    canRepeat: true,
    maxRepeat: 2,
    enabled: true,
    silent: false,
  };
  return {
    name: 'Synthetic',
    bpm: 85,
    beatFiles: ['beat.wav'],
    beatVolume: 100,
    sampleVolume: 80,
    samples: [sample],
    ...(legacyRootPath ? { legacyRootPath } : {}),
  };
}

describe('parseLegacyIni', () => {
  it.each([64, 54])('preserves every sample record in a %i-sample preset', (count) => {
    const preset = parseLegacyIni(makeIni(count));

    expect(preset.samples).toHaveLength(count);
    expect(preset.samples[0]).toMatchObject({ id: 'Sample01', silent: true, enabled: true, durationUnits: 2 });
    expect(preset.samples.some((sample) => !sample.enabled)).toBe(true);
    expect(preset.samples.some((sample) => sample.durationUnits === 0)).toBe(true);
    expect(preset.samples.some((sample) => sample.canRepeat)).toBe(true);
    expect(preset.samples.at(-1)?.id).toBe(`Sample${String(count).padStart(2, '0')}`);
    expect(preset).toMatchObject({ name: 'Synthetic preset', bpm: 85, beatVolume: 95, sampleVolume: 80 });
  });

  it('rejects missing, duplicate, and non-contiguous sample sections', () => {
    expect(() => parseLegacyIni('[Samples]\nCONFIGNAME=x')).toThrow('no sample sections');
    expect(() => parseLegacyIni(makeIni(1).replace('[Sample01]', '[Sample01]\n[Sample01]'))).toThrow('repeats section');
    expect(() => parseLegacyIni(makeIni(2).replace('[Sample02]', '[Sample03]'))).toThrow('contiguous');
  });

  it('rejects malformed, noncanonical, and out-of-range Sample sections while allowing opaque sections', () => {
    const input = makeIni(1);
    expect(() => parseLegacyIni(`${input}\n\n[SampleNotes]\nValue=opaque`)).toThrow('not a valid numbered sample section');
    expect(() => parseLegacyIni(input.replace('[Sample01]', '[Sample1]'))).toThrow('canonical section name');
    expect(() => parseLegacyIni(input.replace('[Sample01]', '[Sample501]'))).toThrow('native Sample500 limit');
    expect(parseLegacyIni(`${input}\n\n[VendorMetadata]\nValue=preserve me`).samples).toHaveLength(1);
  });

  it('strictly validates booleans, counts, and finite numeric fields', () => {
    const input = makeIni(1);
    expect(() => parseLegacyIni(input.replace('UseSample=True', 'UseSample=yes'))).toThrow('True or False');
    expect(() => parseLegacyIni(input.replace('Sample16ths=2', 'Sample16ths=1.5'))).toThrow('safe integer');
    expect(() => parseLegacyIni(input.replace('SampleRepeatMax=1', 'SampleRepeatMax=-1'))).toThrow('at least 0');
    expect(() => parseLegacyIni(input.replace('BPM01=85', 'BPM01=Infinity'))).toThrow('finite number');
    expect(() => parseLegacyIni(input.replace('VOL_B=95', 'VOL_B=101'))).toThrow('at most 100');
  });
});

describe('selected WAV resolution', () => {
  it('prefers a qualified root-tail match and resolves case-insensitively to the selected file', () => {
    const preset = oneSamplePreset('baby_8.wav', 'C:\\Legacy\\Install\\085BPM');
    const expected = file('Baby_8.wav', 'picked/085BPM/Baby_8.wav');
    const other = file('Baby_8.wav', 'picked/096BPM2/Baby_8.wav');
    const beat = file('Beat.wav', 'picked/085BPM/Beat.wav');
    const index = buildAssetIndex([other, expected, beat]);

    const result = resolvePresetAssets(preset, index);
    expect(result.samplesById.get('sample-1')).toMatchObject({ status: 'resolved', file: expected });
    expect(result.samplesById.get('sample-1')?.selectedPath).toBe('picked/085BPM/Baby_8.wav');
    expect(result.beats[0]).toMatchObject({ status: 'resolved', file: beat });
  });

  it('reports ambiguous basenames, case-only path collisions, and missing references', () => {
    const ambiguous = resolvePresetAssets(oneSamplePreset('baby.wav'), buildAssetIndex([
      file('baby.wav', '085BPM/baby.wav'),
      file('Baby.wav', '096BPM2/Baby.wav'),
    ]));
    expect(ambiguous.samplesById.get('sample-1')?.status).toBe('ambiguous');
    expect(ambiguous.diagnostics.some((diagnostic) => diagnostic.code === 'ambiguous')).toBe(true);

    const collisionIndex = buildAssetIndex([
      file('Baby.wav', '085BPM/Baby.wav'),
      file('baby.WAV', '085bpm/baby.wav'),
    ]);
    const collision = resolvePresetAssets(oneSamplePreset('Baby.wav', '085BPM'), collisionIndex);
    expect(collisionIndex.diagnostics.some((diagnostic) => diagnostic.code === 'case-collision')).toBe(true);
    expect(collision.samplesById.get('sample-1')?.status).toBe('ambiguous');

    const missing = resolvePresetAssets(oneSamplePreset('missing.wav'), buildAssetIndex([]));
    expect(missing.samplesById.get('sample-1')?.status).toBe('missing');
    expect(missing.diagnostics.some((diagnostic) => diagnostic.code === 'missing')).toBe(true);
  });

  it('does not normalize a parent-directory reference into a selected basename', () => {
    const result = resolvePresetAssets(
      oneSamplePreset('../secret.wav'),
      buildAssetIndex([file('secret.wav')]),
    );
    expect(result.samplesById.get('sample-1')?.status).toBe('missing');
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-reference')).toBe(true);
  });
});

describe('buildPreviewFixture', () => {
  it('is deterministic, keeps order, skips disabled and zero-length samples, and pads the requested length', () => {
    const preset: Preset = {
      ...DEMO_PRESET,
      samples: [
        { ...DEMO_PRESET.samples[0]!, durationUnits: 8 },
        { ...DEMO_PRESET.samples[1]!, id: 'disabled', durationUnits: 3, enabled: false },
        { ...DEMO_PRESET.samples[1]!, id: 'zero', durationUnits: 0 },
        { ...DEMO_PRESET.samples[2]!, durationUnits: 4 },
      ],
    };

    const first = buildPreviewFixture(preset, 20);
    expect(buildPreviewFixture(preset, 20)).toEqual(first);
    expect(first).toEqual({
      totalUnits: 20,
      events: [
        { id: 'fixture-event-001', sampleId: 'synthPulse', startUnits: 0, durationUnits: 8, silent: false },
        { id: 'fixture-event-002', sampleId: 'synthSilence', startUnits: 8, durationUnits: 4, silent: true },
        { id: 'fixture-event-003', sampleId: REST_SAMPLE_ID, startUnits: 12, durationUnits: 8, silent: true },
      ],
    });
  });

  it('clips at the requested boundary, represents an empty plan as rest, and bounds target length', () => {
    const short = buildPreviewFixture(DEMO_PRESET, 2);
    expect(short.events[0]).toMatchObject({ sampleId: 'synthPulse', startUnits: 0, durationUnits: 2 });
    expect(short.events).toHaveLength(1);

    const empty = buildPreviewFixture({ ...DEMO_PRESET, samples: [] }, 8);
    expect(empty).toEqual({
      totalUnits: 8,
      events: [{ id: 'fixture-event-001', sampleId: REST_SAMPLE_ID, startUnits: 0, durationUnits: 8, silent: true }],
    });
    expect(() => buildPreviewFixture(DEMO_PRESET, 4097)).toThrow('between 0 and 4096');
    expect(() => buildPreviewFixture(DEMO_PRESET, Number.NaN)).toThrow('between 0 and 4096');
  });
});
