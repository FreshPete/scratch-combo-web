import { decodeLocalAudioFile, MAX_LOCAL_AUDIO_FILE_BYTES } from "./beatAnalysis";

export const MAX_SNAPSHOT_WAV_FILE_COUNT = 512;
export const MAX_SNAPSHOT_WAV_BATCH_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_WAV_DECODED_CHANNEL_SAMPLES = 120_000_000;

export interface SnapshotReferencedWavOptions {
  /** Files to decode before the caller enables them. Omit to validate every referenced file. */
  readonly decodeFiles?: readonly File[];
  /** Cancels between file operations; an in-progress native decode must finish before it can be discarded. */
  readonly signal?: AbortSignal;
  /** Test seam. Production creates and closes a temporary browser AudioContext when decoding is requested. */
  readonly audioContextFactory?: () => AudioContext;
}

export type SnapshotFileValidation =
  | {
      readonly status: "valid";
      readonly durationSeconds: number;
      readonly sampleRate: number;
      readonly channelCount: number;
      readonly decodedChannelSamples: number;
    }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "not-requested" };

export interface ReferencedWavSnapshot {
  /** Import-time identity map. Convert references, then discard this result before storing session state. */
  readonly filesBySource: ReadonlyMap<File, File>;
  readonly validationBySource: ReadonlyMap<File, SnapshotFileValidation>;
  readonly copiedFileCount: number;
  readonly copiedBytes: number;
  readonly decodeAttemptCount: number;
  readonly decodedFileCount: number;
  readonly decodedChannelSamples: number;
  readonly decodedDurationSeconds: number;
}

/** A snapshot/read/decode error that can be mapped back to the importer's retained path metadata. */
export class LocalWavSnapshotError extends Error {
  readonly file?: File;

  constructor(message: string, file?: File) {
    super(message);
    this.name = "LocalWavSnapshotError";
    if (file !== undefined) this.file = file;
  }
}

/** Snapshot only resolved, referenced WAVs; no folder scan, path read, upload, or source File mutation occurs. */
export async function snapshotReferencedWavFiles(
  files: readonly File[],
  options: SnapshotReferencedWavOptions = {},
): Promise<ReferencedWavSnapshot> {
  throwIfAborted(options.signal);

  const sources = uniqueFiles(files);
  if (sources.length > MAX_SNAPSHOT_WAV_FILE_COUNT) {
    throw new LocalWavSnapshotError(`This import references more than ${MAX_SNAPSHOT_WAV_FILE_COUNT} unique WAV files.`);
  }

  const sourcesByIdentity = new Set(sources);
  const decodeSources = options.decodeFiles === undefined
    ? sources
    : uniqueFiles(options.decodeFiles);
  for (const file of decodeSources) {
    if (!sourcesByIdentity.has(file)) {
      throw new LocalWavSnapshotError("A WAV selected for validation is not part of the referenced import.", file);
    }
  }
  const decodeSet = new Set(decodeSources);

  let copiedBytes = 0;
  for (const file of sources) {
    validateSnapshotSource(file);
    copiedBytes += file.size;
    if (!Number.isSafeInteger(copiedBytes) || copiedBytes > MAX_SNAPSHOT_WAV_BATCH_BYTES) {
      throw new LocalWavSnapshotError(
        `Referenced WAV files must total no more than ${formatMiB(MAX_SNAPSHOT_WAV_BATCH_BYTES)} in one import.`,
      );
    }
  }

  let context: AudioContext | undefined;
  const filesBySource = new Map<File, File>();
  const validationBySource = new Map<File, SnapshotFileValidation>();
  let decodeAttemptCount = 0;
  let decodedFileCount = 0;
  let decodedChannelSamples = 0;
  let decodedDurationSeconds = 0;

  try {
    if (decodeSources.length > 0) context = createAudioContext(options.audioContextFactory);

    for (const source of sources) {
      throwIfAborted(options.signal);
      let bytes: ArrayBuffer | undefined;
      let snapshot: File;
      try {
        bytes = await source.arrayBuffer();
        throwIfAborted(options.signal);
        if (bytes.byteLength !== source.size || bytes.byteLength === 0) {
          throw new Error("The selected file changed or could not be read completely.");
        }
        snapshot = new File([bytes], source.name, {
          type: source.type,
          lastModified: source.lastModified,
        });
        bytes = undefined;
        if (snapshot.size !== source.size) {
          throw new Error("The selected file could not be copied into session memory.");
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new LocalWavSnapshotError(
          `Could not keep “${source.name || "the selected WAV"}” in session memory: ${errorMessage(error)}`,
          source,
        );
      } finally {
        // Drop the source byte-array reference before decodeAudioData allocates PCM.
        bytes = undefined;
      }

      filesBySource.set(source, snapshot);
      if (!decodeSet.has(source)) {
        validationBySource.set(source, { status: "not-requested" });
        continue;
      }

      throwIfAborted(options.signal);
      const remainingChannelSamples = MAX_SNAPSHOT_WAV_DECODED_CHANNEL_SAMPLES - decodedChannelSamples;
      decodeAttemptCount += 1;
      let buffer: AudioBuffer | undefined;
      try {
        buffer = await decodeLocalAudioFile(context!, snapshot, {
          maxDecodedChannelSamples: remainingChannelSamples,
        });
        throwIfAborted(options.signal);

        const channelSamples = buffer.length * buffer.numberOfChannels;
        if (!Number.isSafeInteger(channelSamples)
          || channelSamples <= 0
          || decodedChannelSamples + channelSamples > MAX_SNAPSHOT_WAV_DECODED_CHANNEL_SAMPLES) {
          throw new Error("This WAV exceeds the remaining decoded-audio budget for this import.");
        }

        decodedChannelSamples += channelSamples;
        decodedDurationSeconds += buffer.duration;
        decodedFileCount += 1;
        validationBySource.set(source, {
          status: "valid",
          durationSeconds: buffer.duration,
          sampleRate: buffer.sampleRate,
          channelCount: buffer.numberOfChannels,
          decodedChannelSamples: channelSamples,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        validationBySource.set(source, {
          status: "invalid",
          message: errorMessage(error),
        });
      } finally {
        // Decoded PCM is validation-only and is never retained in the snapshot result.
        buffer = undefined;
      }
    }

    throwIfAborted(options.signal);
    return {
      filesBySource,
      validationBySource,
      copiedFileCount: filesBySource.size,
      copiedBytes,
      decodeAttemptCount,
      decodedFileCount,
      decodedChannelSamples,
      decodedDurationSeconds,
    };
  } finally {
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Preserve the import or validation error if browser context cleanup itself fails.
      }
    }
  }
}

function uniqueFiles(files: readonly File[]): File[] {
  return [...new Set(files)];
}

function validateSnapshotSource(file: File): void {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isFinite(file.size) || file.size <= 0) {
    throw new LocalWavSnapshotError("Choose non-empty local WAV files.", file);
  }
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const type = typeof file.type === "string" ? file.type.toLowerCase().split(";")[0]?.trim() ?? "" : "";
  if (!name.endsWith(".wav") && !["audio/wav", "audio/x-wav", "audio/wave"].includes(type)) {
    throw new LocalWavSnapshotError(`“${file.name || "The selected file"}” is not a WAV file.`, file);
  }
  if (file.size > MAX_LOCAL_AUDIO_FILE_BYTES) {
    throw new LocalWavSnapshotError(
      `“${file.name || "The selected WAV"}” is larger than ${formatMiB(MAX_LOCAL_AUDIO_FILE_BYTES)}.`,
      file,
    );
  }
}

function createAudioContext(factory?: () => AudioContext): AudioContext {
  if (factory) return factory();
  const legacyWindow = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = globalThis.AudioContext ?? legacyWindow.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new LocalWavSnapshotError("This browser does not support local WAV validation.");
  }
  try {
    return new AudioContextConstructor();
  } catch (error) {
    throw new LocalWavSnapshotError(`Could not start browser audio validation: ${errorMessage(error)}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("WAV import was canceled.");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The browser could not read or decode this WAV file.";
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
