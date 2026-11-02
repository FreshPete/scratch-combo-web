import type { Preset, SampleDefinition } from './types';

type IniSection = {
  name: string;
  line: number;
  values: Map<string, { key: string; value: string; line: number }>;
};

const SAMPLE_FIELDS = [
  'SamplePlayFq',
  'SampleIsSilent',
  'SampleRepeatsPoss',
  'SampleRepeatMax',
  'SampleFileName',
  'SampleDisplayName',
  'SampleStartsForward',
  'SampleEndsForward',
  'Sample16ths',
  'UseSample',
] as const;

/** The recovered sample properties are VB6 Long values. */
export const MAX_LEGACY_SAMPLE_INTEGER = 2_147_483_647;
/** The native loader's numbered sample collection ends at Sample500. */
export const MAX_LEGACY_SAMPLE_ROWS = 500;

function parseBoolean(value: string, section: string, key: string, line: number): boolean {
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Line ${line} [${section}] ${key} must be True or False, got ${JSON.stringify(value)}.`);
}

function parseNumber(
  value: string,
  section: string,
  key: string,
  line: number,
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    throw new Error(`Line ${line} [${section}] ${key} must be a finite number, got ${JSON.stringify(value)}.`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Line ${line} [${section}] ${key} must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (options.integer && !Number.isSafeInteger(number)) {
    throw new Error(`Line ${line} [${section}] ${key} must be a safe integer, got ${JSON.stringify(value)}.`);
  }
  if (options.minimum !== undefined && number < options.minimum) {
    throw new Error(`Line ${line} [${section}] ${key} must be at least ${options.minimum}.`);
  }
  if (options.maximum !== undefined && number > options.maximum) {
    throw new Error(`Line ${line} [${section}] ${key} must be at most ${options.maximum}.`);
  }
  return number;
}

function requiredValue(section: IniSection, key: string): { key: string; value: string; line: number } {
  const entry = section.values.get(key.toLowerCase());
  if (!entry || entry.value.length === 0) {
    throw new Error(`[${section.name}] is missing required value ${key}.`);
  }
  return entry;
}

function requiredString(section: IniSection, key: string): string {
  return requiredValue(section, key).value;
}

function requiredNumber(
  section: IniSection,
  key: string,
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number {
  const entry = requiredValue(section, key);
  return parseNumber(entry.value, section.name, entry.key, entry.line, options);
}

function requiredBoolean(section: IniSection, key: string): boolean {
  const entry = requiredValue(section, key);
  return parseBoolean(entry.value, section.name, entry.key, entry.line);
}

function stripInlineComment(value: string): string {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') {
      if (quoted && value[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted || index === 0 || !/\s/.test(value[index - 1] ?? '')) continue;
    if (value[index] === ';' || value[index] === '#') return value.slice(0, index).trimEnd();
    if (value.startsWith('//', index)) return value.slice(0, index).trimEnd();
  }
  return value;
}

function readIniSections(text: string): Map<string, IniSection> {
  if (text.trim().length === 0) throw new Error('The INI file is empty.');

  const sections = new Map<string, IniSection>();
  let current: IniSection | undefined;

  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith(';') || line.startsWith('#')) return;

    if (line.startsWith('[') || line.endsWith(']')) {
      const match = /^\[([^\]]+)\]$/.exec(line);
      if (!match) throw new Error(`Line ${lineNumber} has an invalid section header.`);
      const name = match[1]?.trim() ?? '';
      if (!name) throw new Error(`Line ${lineNumber} has an empty section name.`);
      const sectionKey = name.toLowerCase();
      if (sections.has(sectionKey)) throw new Error(`Line ${lineNumber} repeats section [${name}].`);
      current = { name, line: lineNumber, values: new Map() };
      sections.set(sectionKey, current);
      return;
    }

    if (!current) throw new Error(`Line ${lineNumber} has a value outside a section.`);
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Line ${lineNumber} must contain a key=value pair.`);
    const key = line.slice(0, separator).trim();
    let value = stripInlineComment(line.slice(separator + 1).trim()).trimEnd();
    if (!key) throw new Error(`Line ${lineNumber} has an empty key.`);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const keyId = key.toLowerCase();
    if (current.values.has(keyId)) {
      throw new Error(`Line ${lineNumber} [${current.name}] repeats key ${key}.`);
    }
    current.values.set(keyId, { key, value, line: lineNumber });
  });

  return sections;
}

function parseSample(section: IniSection, index: number): SampleDefinition {
  for (const field of SAMPLE_FIELDS) requiredValue(section, field);

  return {
    id: `Sample${String(index).padStart(2, '0')}`,
    name: requiredString(section, 'SampleDisplayName'),
    fileName: requiredString(section, 'SampleFileName'),
    durationUnits: requiredNumber(section, 'Sample16ths', { integer: true, minimum: 0, maximum: MAX_LEGACY_SAMPLE_INTEGER }),
    weight: requiredNumber(section, 'SamplePlayFq', { integer: true, minimum: 0, maximum: MAX_LEGACY_SAMPLE_INTEGER }),
    startForward: requiredBoolean(section, 'SampleStartsForward'),
    endForward: requiredBoolean(section, 'SampleEndsForward'),
    canRepeat: requiredBoolean(section, 'SampleRepeatsPoss'),
    maxRepeat: requiredNumber(section, 'SampleRepeatMax', { integer: true, minimum: 0, maximum: MAX_LEGACY_SAMPLE_INTEGER }),
    enabled: requiredBoolean(section, 'UseSample'),
    silent: requiredBoolean(section, 'SampleIsSilent'),
  };
}

/** Parse a legacy Combo Generator INI into normalized, complete preset records. */
export function parseLegacyIni(text: string): Preset {
  if (typeof text !== 'string') throw new TypeError('The INI contents must be text.');

  const sections = readIniSections(text);
  const settings = sections.get('samples');
  if (!settings) throw new Error('The INI file is missing the [Samples] section.');

  const sampleSections: Array<{ index: number; section: IniSection }> = [];
  const seenIndexes = new Set<number>();
  for (const section of sections.values()) {
    if (section.name.toLowerCase() !== 'samples' && /^sample/i.test(section.name) && !/^sample\d+$/i.test(section.name)) {
      throw new Error(`[${section.name}] is not a valid numbered sample section.`);
    }
    const match = /^sample(\d+)$/i.exec(section.name);
    if (!match) continue;

    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new Error(`[${section.name}] must use a positive sample number.`);
    }
    if (index > MAX_LEGACY_SAMPLE_ROWS) {
      throw new Error(`[${section.name}] exceeds the native Sample${MAX_LEGACY_SAMPLE_ROWS} limit.`);
    }
    const expectedSectionName = `Sample${String(index).padStart(2, '0')}`;
    if (section.name.toLowerCase() !== expectedSectionName.toLowerCase()) {
      throw new Error(`[${section.name}] must use the canonical section name [${expectedSectionName}].`);
    }
    if (seenIndexes.has(index)) throw new Error(`Sample section number ${index} is defined more than once.`);
    seenIndexes.add(index);
    sampleSections.push({ index, section });
  }

  sampleSections.sort((left, right) => left.index - right.index);
  if (sampleSections.length === 0) throw new Error('The INI file has no sample sections.');
  sampleSections.forEach(({ index }, position) => {
    if (index !== position + 1) {
      throw new Error(`Sample sections must be contiguous from Sample01; expected ${position + 1}, found ${index}.`);
    }
  });

  const beatEntries: Array<{ index: number; value: string; line: number }> = [];
  for (const entry of settings.values.values()) {
    const match = /^beat(\d+)$/i.exec(entry.key);
    if (match) {
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || index < 1) {
        throw new Error(`Line ${entry.line} [${settings.name}] has an invalid beat key ${entry.key}.`);
      }
      beatEntries.push({ index, value: entry.value, line: entry.line });
    }
  }
  beatEntries.sort((left, right) => left.index - right.index);
  if (beatEntries.length === 0) throw new Error('[Samples] must define at least Beat01.');
  beatEntries.forEach((entry, position) => {
    if (entry.index !== position + 1 || !entry.value) {
      throw new Error(`Line ${entry.line} [${settings.name}] has a missing or invalid Beat${String(position + 1).padStart(2, '0')}.`);
    }
  });

  const relativeRootEntry = settings.values.get('rootsamplepathrelative');
  if (relativeRootEntry) {
    parseBoolean(relativeRootEntry.value, settings.name, relativeRootEntry.key, relativeRootEntry.line);
  }
  const rootPath = settings.values.get('rootsamplepath')?.value;

  return {
    name: requiredString(settings, 'CONFIGNAME'),
    bpm: requiredNumber(settings, 'BPM01', { minimum: Number.MIN_VALUE }),
    beatFiles: beatEntries.map(({ value }) => value),
    beatVolume: requiredNumber(settings, 'VOL_B', { minimum: 0, maximum: 100 }),
    sampleVolume: requiredNumber(settings, 'VOL_S', { minimum: 0, maximum: 100 }),
    samples: sampleSections.map(({ index, section }) => parseSample(section, index)),
    ...(rootPath ? { legacyRootPath: rootPath } : {}),
  };
}
