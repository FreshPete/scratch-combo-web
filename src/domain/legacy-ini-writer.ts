import type { Preset, SampleDefinition } from './types';
import { MAX_LEGACY_SAMPLE_INTEGER, parseLegacyIni } from './legacy-ini';

export const MAX_WEB_SAMPLE_WEIGHT = 10_000;
export const MAX_WEB_SAMPLE_DURATION = 512;
export const MAX_WEB_SAMPLE_REPEAT = 8_192;

export interface LegacyIniPatchResult {
  text: string;
  preset: Preset;
}

type EditableSample = Pick<
  SampleDefinition,
  'durationUnits' | 'weight' | 'startForward' | 'endForward' | 'canRepeat' | 'maxRepeat' | 'enabled'
>;

type IniValuePatch = {
  section: string;
  key: string;
  value: string;
};

const EDITABLE_KEYS: ReadonlyArray<{
  property: keyof EditableSample;
  iniKey: string;
  kind: 'integer' | 'boolean';
}> = [
  { property: 'weight', iniKey: 'SamplePlayFq', kind: 'integer' },
  { property: 'canRepeat', iniKey: 'SampleRepeatsPoss', kind: 'boolean' },
  { property: 'maxRepeat', iniKey: 'SampleRepeatMax', kind: 'integer' },
  { property: 'startForward', iniKey: 'SampleStartsForward', kind: 'boolean' },
  { property: 'endForward', iniKey: 'SampleEndsForward', kind: 'boolean' },
  { property: 'durationUnits', iniKey: 'Sample16ths', kind: 'integer' },
  { property: 'enabled', iniKey: 'UseSample', kind: 'boolean' },
];

function sectionId(value: string): string {
  return value.toLowerCase();
}

function keyId(value: string): string {
  return value.toLowerCase();
}

function canonicalValue(value: boolean | number): string {
  return typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
}

function validateInteger(
  value: number,
  sampleId: string,
  field: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum || value > MAX_LEGACY_SAMPLE_INTEGER) {
    throw new RangeError(`${sampleId} ${field} must be an integer from 0 to ${maximum}.`);
  }
}

function validateBoolean(value: boolean, sampleId: string, field: string): void {
  if (typeof value !== 'boolean') throw new TypeError(`${sampleId} ${field} must be a boolean.`);
}

function validateSample(sample: SampleDefinition, original: SampleDefinition): void {
  if (sample.id !== original.id) throw new Error(`Sample identity ${original.id} cannot be changed.`);
  if (sample.name !== original.name || sample.fileName !== original.fileName || sample.silent !== original.silent) {
    throw new Error(`${sample.id} name, file reference, and silent classification are read-only.`);
  }

  if (typeof sample.durationUnits !== 'number' || !Number.isFinite(sample.durationUnits)) throw new TypeError(`${sample.id} duration must be a number.`);
  if (typeof sample.weight !== 'number' || !Number.isFinite(sample.weight)) throw new TypeError(`${sample.id} play weight must be a number.`);
  if (typeof sample.maxRepeat !== 'number' || !Number.isFinite(sample.maxRepeat)) throw new TypeError(`${sample.id} repeat maximum must be a number.`);
  validateBoolean(sample.startForward, sample.id, 'start direction');
  validateBoolean(sample.endForward, sample.id, 'end direction');
  validateBoolean(sample.canRepeat, sample.id, 'repeat eligibility');
  validateBoolean(sample.enabled, sample.id, 'UseSample');

  if (sample.silent && original.enabled && !sample.enabled) {
    throw new Error(`${sample.id} is silent; its effective UseSample setting cannot be disabled.`);
  }
}

function validateVolume(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new RangeError(`${label} must be an integer from 0 to 100.`);
  }
}

function lineValueIndex(rawValue: string): number {
  let quoted = false;
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (character === '"') {
      if (quoted && rawValue[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted || index === 0 || !/\s/.test(rawValue[index - 1] ?? '')) continue;
    if (character === ';' || character === '#') return index;
    if (rawValue.startsWith('//', index)) return index;
  }
  return -1;
}

function replaceIniValues(text: string, patches: readonly IniValuePatch[]): string {
  const remaining = new Map<string, IniValuePatch>();
  for (const patch of patches) remaining.set(`${sectionId(patch.section)}\u0000${keyId(patch.key)}`, patch);

  const parts = text.split(/(\r\n|\r|\n)/);
  let currentSection = '';
  for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
    const line = parts[partIndex] ?? '';
    const visibleLine = partIndex === 0 ? line.replace(/^\uFEFF/, '') : line;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(visibleLine);
    if (header) {
      currentSection = sectionId(header[1]!.trim());
      continue;
    }

    const assignment = /^(\s*)([^=]+?)(\s*=\s*)(.*)$/.exec(visibleLine);
    if (!assignment) continue;
    const key = assignment[2]!.trim();
    const id = `${currentSection}\u0000${keyId(key)}`;
    const patch = remaining.get(id);
    if (!patch) continue;

    const rawValue = assignment[4]!;
    const commentOffset = lineValueIndex(rawValue);
    let commentStart = commentOffset;
    while (commentStart > 0 && /\s/.test(rawValue[commentStart - 1] ?? '')) commentStart -= 1;
    const valueAndComment = commentOffset >= 0 ? rawValue.slice(commentStart) : '';
    const valueEnd = commentOffset >= 0 ? commentStart : rawValue.length;
    const trailingWhitespace = /\s*$/.exec(rawValue.slice(0, valueEnd))?.[0] ?? '';
    const suffix = commentOffset >= 0 ? valueAndComment : trailingWhitespace;
    const updatedValue = `${patch.value}${suffix}`;
    const prefix = `${assignment[1]}${assignment[2]}${assignment[3]}`;
    const bom = partIndex === 0 && line.startsWith('\uFEFF') ? '\uFEFF' : '';
    parts[partIndex] = `${bom}${prefix}${updatedValue}`;
    remaining.delete(id);
  }

  if (remaining.size > 0) {
    const missing = [...remaining.values()].map(({ section, key }) => `[${section}] ${key}`).join(', ');
    throw new Error(`Could not locate source INI value(s): ${missing}.`);
  }
  return parts.join('');
}

/**
 * Patch a parsed preset's editable values back into its original INI text.
 * The caller retains sourceText; this function never mutates or renumbers it.
 * Live practice BPM is deliberately ignored so BPM01 remains recorded metadata.
 */
export function patchLegacyIniText(sourceText: string, editedPreset: Preset): LegacyIniPatchResult {
  const sourcePreset = parseLegacyIni(sourceText);
  if (
    editedPreset.name !== sourcePreset.name ||
    editedPreset.legacyRootPath !== sourcePreset.legacyRootPath ||
    editedPreset.beatFiles.length !== sourcePreset.beatFiles.length ||
    editedPreset.beatFiles.some((file, index) => file !== sourcePreset.beatFiles[index])
  ) {
    throw new Error('Preset name, beat references, and source root path are read-only.');
  }
  if (editedPreset.samples.length !== sourcePreset.samples.length) {
    throw new Error('Sample rows cannot be added, removed, or reordered while editing a legacy preset.');
  }

  const patches: IniValuePatch[] = [];
  for (let index = 0; index < sourcePreset.samples.length; index += 1) {
    const original = sourcePreset.samples[index]!;
    const edited = editedPreset.samples[index]!;
    validateSample(edited, original);
    if (edited.id !== original.id) throw new Error(`Expected ${original.id} at sample row ${index + 1}.`);

    for (const field of EDITABLE_KEYS) {
      const value = edited[field.property];
      const originalValue = original[field.property];
      if (Object.is(value, originalValue)) continue;

      if (field.kind === 'integer') {
        const max = field.property === 'durationUnits'
          ? MAX_WEB_SAMPLE_DURATION
          : field.property === 'weight'
            ? MAX_WEB_SAMPLE_WEIGHT
            : MAX_WEB_SAMPLE_REPEAT;
        validateInteger(value as number, edited.id, field.property, max);
      } else {
        validateBoolean(value as boolean, edited.id, field.property);
      }

      patches.push({ section: edited.id, key: field.iniKey, value: canonicalValue(value as boolean | number) });
    }

    // Native loading promotes silent rows to effective UseSample=True. The web
    // keeps an unchanged raw false flag byte-for-byte; effective eligibility is
    // still forced by the generator and the editor does not expose that toggle.
  }

  if (!Object.is(editedPreset.beatVolume, sourcePreset.beatVolume)) {
    validateVolume(editedPreset.beatVolume, 'Beat level');
    patches.push({ section: 'Samples', key: 'VOL_B', value: String(editedPreset.beatVolume) });
  }
  if (!Object.is(editedPreset.sampleVolume, sourcePreset.sampleVolume)) {
    validateVolume(editedPreset.sampleVolume, 'Sample level');
    patches.push({ section: 'Samples', key: 'VOL_S', value: String(editedPreset.sampleVolume) });
  }

  const text = replaceIniValues(sourceText, patches);
  const preset = parseLegacyIni(text);
  return { text, preset };
}
