import type {
  AssetDiagnostic,
  AssetIndex,
  AssetResolution,
  IndexedAsset,
  Preset,
  PresetAssetResolution,
} from './types';

type NormalizedPath = { path: string; key: string; basename: string; basenameKey: string };

function selectedPath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative?.trim() || file.name;
}

function normalizePath(value: string): NormalizedPath | undefined {
  const slashed = value.trim().replace(/\\/g, '/').replace(/^[a-z]:/i, '');
  const segments = slashed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return undefined;
  const path = segments.join('/');
  const basename = segments[segments.length - 1];
  if (!basename) return undefined;
  return { path, key: path.toLowerCase(), basename, basenameKey: basename.toLowerCase() };
}

function candidatePaths(files: readonly IndexedAsset[]): string[] {
  return [...new Set(files.map(({ relativePath }) => relativePath))].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  );
}

/** Build an in-memory index over files the user selected in this browser session. */
export function buildAssetIndex(files: readonly File[]): AssetIndex {
  const indexed: IndexedAsset[] = files.map((file) => ({ file, relativePath: selectedPath(file) }));
  const groups = new Map<string, IndexedAsset[]>();
  const invalid: IndexedAsset[] = [];

  for (const item of indexed) {
    const normalized = normalizePath(item.relativePath);
    if (!normalized) {
      invalid.push(item);
      continue;
    }
    const group = groups.get(normalized.key) ?? [];
    group.push(item);
    groups.set(normalized.key, group);
  }

  const diagnostics: AssetDiagnostic[] = invalid.map((item) => ({
    code: 'invalid-reference',
    severity: 'error',
    subject: 'asset',
    requested: item.relativePath,
    message: `Selected path ${JSON.stringify(item.relativePath)} is not a safe relative path.`,
    candidates: [item.relativePath],
  }));

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const paths = candidatePaths(group);
    diagnostics.push({
      code: 'case-collision',
      severity: 'error',
      subject: 'asset',
      requested: paths[0] ?? '',
      message: `Selected files collide when paths are compared without case.`,
      candidates: paths,
    });
  }

  return { files: indexed, diagnostics };
}

function rootTail(rootPath?: string): string | undefined {
  if (!rootPath?.trim()) return undefined;
  const segments = rootPath.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = segments.at(-1)?.replace(/^[a-z]:$/i, '');
  return tail || undefined;
}

function resolveReference(
  requested: string,
  rootPath: string | undefined,
  index: AssetIndex,
  subject: 'sample' | 'beat',
  id: string,
): { resolution: AssetResolution; diagnostic?: AssetDiagnostic } {
  const normalizedRequest = normalizePath(requested);
  if (!normalizedRequest) {
    const resolution: AssetResolution = { status: 'missing', requested, candidates: [] };
    return {
      resolution,
      diagnostic: {
        code: 'invalid-reference',
        severity: 'error',
        subject,
        id,
        requested,
        message: `${subject === 'sample' ? 'Sample' : 'Beat'} ${id} has an unsafe or empty file reference.`,
        candidates: [],
      },
    };
  }

  const candidates = index.files.flatMap((item) => {
    const path = normalizePath(item.relativePath);
    return path ? [{ item, path }] : [];
  });
  const findBySuffix = (suffix: string): IndexedAsset[] => {
    const key = suffix.toLowerCase();
    return candidates
      .filter(({ path }) => path.key === key || path.key.endsWith(`/${key}`))
      .map(({ item }) => item);
  };
  const basenameMatches = (): IndexedAsset[] =>
    candidates.filter(({ path }) => path.basenameKey === normalizedRequest.basenameKey).map(({ item }) => item);

  const root = rootTail(rootPath);
  let matches: IndexedAsset[] = [];
  if (root) matches = findBySuffix(`${root}/${normalizedRequest.path}`);
  if (matches.length === 0 && normalizedRequest.path.includes('/')) {
    matches = findBySuffix(normalizedRequest.path);
  }
  if (matches.length === 0) matches = basenameMatches();

  if (matches.length === 1) {
    const match = matches[0];
    if (!match) throw new Error('Asset resolution lost its only candidate.');
    return {
      resolution: {
        status: 'resolved',
        requested,
        file: match.file,
        selectedPath: match.relativePath,
        candidates: [match.relativePath],
      },
    };
  }

  const paths = candidatePaths(matches);
  if (matches.length === 0) {
    return {
      resolution: { status: 'missing', requested, candidates: [] },
      diagnostic: {
        code: 'missing',
        severity: 'error',
        subject,
        id,
        requested,
        message: `${subject === 'sample' ? 'Sample' : 'Beat'} ${id} references ${JSON.stringify(requested)}, which was not selected.`,
        candidates: [],
      },
    };
  }

  return {
    resolution: { status: 'ambiguous', requested, candidates: paths },
    diagnostic: {
      code: 'ambiguous',
      severity: 'error',
      subject,
      id,
      requested,
      message: `${subject === 'sample' ? 'Sample' : 'Beat'} ${id} reference ${JSON.stringify(requested)} matches more than one selected file.`,
      candidates: paths,
    },
  };
}

/** Resolve only against selected browser File objects; this never reads a local path. */
export function resolvePresetAssets(preset: Preset, index: AssetIndex): PresetAssetResolution {
  const diagnostics: AssetDiagnostic[] = [...index.diagnostics];
  const samplesById = new Map<string, AssetResolution>();

  for (const sample of preset.samples) {
    const { resolution, diagnostic } = resolveReference(
      sample.fileName,
      preset.legacyRootPath,
      index,
      'sample',
      sample.id,
    );
    samplesById.set(sample.id, resolution);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  const beats = preset.beatFiles.map((fileName, beatIndex) => {
    const id = `Beat${String(beatIndex + 1).padStart(2, '0')}`;
    const { resolution, diagnostic } = resolveReference(
      fileName,
      preset.legacyRootPath,
      index,
      'beat',
      id,
    );
    if (diagnostic) diagnostics.push(diagnostic);
    return resolution;
  });

  return { samplesById, beats, diagnostics };
}
