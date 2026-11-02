export interface SampleDefinition {
  id: string;
  name: string;
  fileName: string;
  durationUnits: number;
  weight: number;
  startForward: boolean;
  endForward: boolean;
  canRepeat: boolean;
  maxRepeat: number;
  enabled: boolean;
  silent: boolean;
}

export interface Preset {
  name: string;
  bpm: number;
  beatFiles: string[];
  beatVolume: number;
  sampleVolume: number;
  samples: SampleDefinition[];
  legacyRootPath?: string;
}

export interface FixtureEvent {
  id: string;
  sampleId: string;
  startUnits: number;
  durationUnits: number;
  silent: boolean;
}

export interface Fixture {
  events: FixtureEvent[];
  totalUnits: number;
}

export interface IndexedAsset {
  file: File;
  relativePath: string;
}

export type AssetStatus = 'resolved' | 'missing' | 'ambiguous';

export interface AssetResolution {
  status: AssetStatus;
  requested: string;
  file?: File;
  selectedPath?: string;
  candidates: string[];
}

export type AssetDiagnosticCode =
  | 'case-collision'
  | 'missing'
  | 'ambiguous'
  | 'invalid-reference';

export interface AssetDiagnostic {
  code: AssetDiagnosticCode;
  severity: 'error' | 'warning';
  subject: 'asset' | 'sample' | 'beat';
  id?: string;
  requested: string;
  message: string;
  candidates: string[];
}

export interface AssetIndex {
  files: readonly IndexedAsset[];
  diagnostics: readonly AssetDiagnostic[];
}

export interface PresetAssetResolution {
  samplesById: ReadonlyMap<string, AssetResolution>;
  beats: AssetResolution[];
  diagnostics: AssetDiagnostic[];
}
