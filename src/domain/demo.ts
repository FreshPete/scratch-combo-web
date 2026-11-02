import type { Preset, SampleDefinition } from './types';

const demoSamples: SampleDefinition[] = [
  {
    id: 'synthPulse',
    name: 'Tone',
    fileName: '',
    durationUnits: 8,
    weight: 1,
    startForward: true,
    endForward: true,
    canRepeat: false,
    maxRepeat: 0,
    enabled: true,
    silent: false,
  },
  {
    id: 'synthBrush',
    name: 'Click',
    fileName: '',
    durationUnits: 4,
    weight: 1,
    startForward: true,
    endForward: true,
    canRepeat: false,
    maxRepeat: 0,
    enabled: true,
    silent: false,
  },
  {
    id: 'synthSilence',
    name: 'Silence',
    fileName: '',
    durationUnits: 4,
    weight: 1,
    startForward: true,
    endForward: false,
    canRepeat: false,
    maxRepeat: 0,
    enabled: true,
    silent: true,
  },
];

export const DEMO_PRESET: Preset = {
  name: 'Synthetic demo',
  bpm: 100,
  beatFiles: [],
  beatVolume: 60,
  sampleVolume: 80,
  samples: demoSamples,
};
