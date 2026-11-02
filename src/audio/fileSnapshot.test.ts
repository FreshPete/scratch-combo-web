import { describe, expect, it, vi } from "vitest";
import {
  LocalWavSnapshotError,
  MAX_SNAPSHOT_WAV_BATCH_BYTES,
  MAX_SNAPSHOT_WAV_DECODED_CHANNEL_SAMPLES,
  MAX_SNAPSHOT_WAV_FILE_COUNT,
  snapshotReferencedWavFiles,
} from "./fileSnapshot";

const SAMPLE_RATE = 48_000;

function makeWavFile(name: string, durationSeconds = 1): File {
  const dataLength = SAMPLE_RATE * durationSeconds * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);
  return new File([bytes], name, { type: "audio/wav", lastModified: 1_700_000_000_000 });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function makeBuffer(durationSeconds = 1, numberOfChannels = 1): AudioBuffer {
  const length = Math.round(SAMPLE_RATE * durationSeconds);
  return {
    duration: durationSeconds,
    sampleRate: SAMPLE_RATE,
    numberOfChannels,
    length,
    getChannelData: () => new Float32Array(0),
  } as unknown as AudioBuffer;
}

function makeContext(decode: (bytes: ArrayBuffer) => Promise<AudioBuffer> = async () => makeBuffer()) {
  const context = {
    sampleRate: SAMPLE_RATE,
    state: "suspended" as AudioContextState,
    decodeAudioData: vi.fn(decode),
    close: vi.fn(async () => { context.state = "closed"; }),
  };
  return context as unknown as AudioContext;
}

function spyOnArrayBuffer(file: File) {
  const read = file.arrayBuffer.bind(file);
  const arrayBuffer = vi.fn(read);
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: arrayBuffer });
  return arrayBuffer;
}

describe("snapshotReferencedWavFiles", () => {
  it("creates byte-identical File snapshots once per unique source identity", async () => {
    const source = makeWavFile("kick.wav");
    const sourceArrayBuffer = spyOnArrayBuffer(source);
    const context = makeContext();

    const result = await snapshotReferencedWavFiles([source, source], {
      audioContextFactory: () => context,
    });
    const snapshot = result.filesBySource.get(source)!;

    expect(result.copiedFileCount).toBe(1);
    expect(result.copiedBytes).toBe(source.size);
    expect(result.decodeAttemptCount).toBe(1);
    expect(result.decodedFileCount).toBe(1);
    expect(result.decodedChannelSamples).toBe(SAMPLE_RATE);
    expect(result.validationBySource.get(source)).toMatchObject({ status: "valid", durationSeconds: 1 });
    expect(snapshot).not.toBe(source);
    expect(snapshot).toMatchObject({ name: source.name, type: source.type, lastModified: source.lastModified });
    const originalBytes = await (sourceArrayBuffer.mock.results[0]!.value as Promise<ArrayBuffer>);
    const snapshotBytes = new Uint8Array(await snapshot.arrayBuffer());
    expect([...snapshotBytes]).toEqual([...new Uint8Array(originalBytes)]);
    new Uint8Array(originalBytes)[44] = 77;
    expect(new Uint8Array(await snapshot.arrayBuffer())[44]).toBe(snapshotBytes[44]);
    expect(sourceArrayBuffer).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("snapshots every reference while decoding only the requested identity subset", async () => {
    const enabled = makeWavFile("enabled.wav");
    const inactive = makeWavFile("inactive.wav");
    const context = makeContext();

    const result = await snapshotReferencedWavFiles([enabled, inactive], {
      decodeFiles: [enabled],
      audioContextFactory: () => context,
    });

    expect(result.filesBySource.size).toBe(2);
    expect(result.validationBySource.get(enabled)?.status).toBe("valid");
    expect(result.validationBySource.get(inactive)).toEqual({ status: "not-requested" });
    expect(result.copiedFileCount).toBe(2);
    expect(result.decodedFileCount).toBe(1);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("returns a per-file native decode error and continues with other references", async () => {
    const broken = makeWavFile("broken.wav");
    const valid = makeWavFile("valid.wav");
    let decodeCount = 0;
    const context = makeContext(async () => {
      decodeCount += 1;
      if (decodeCount === 1) throw new Error("decoder rejected the WAV");
      return makeBuffer();
    });

    const result = await snapshotReferencedWavFiles([broken, valid], {
      audioContextFactory: () => context,
    });

    expect(result.filesBySource.has(broken)).toBe(true);
    expect(result.validationBySource.get(broken)).toMatchObject({ status: "invalid", message: expect.stringContaining("could not be decoded") });
    expect(result.validationBySource.get(valid)?.status).toBe("valid");
    expect(result.decodeAttemptCount).toBe(2);
    expect(result.decodedFileCount).toBe(1);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a source read failure with the source File attached", async () => {
    const source = makeWavFile("unreadable.wav");
    Object.defineProperty(source, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async () => { throw new Error("permission lost"); }),
    });

    await expect(snapshotReferencedWavFiles([source], { decodeFiles: [] }))
      .rejects.toMatchObject({ name: "LocalWavSnapshotError", file: source, message: expect.stringContaining("permission lost") });
  });

  it("does not decode non-WAV references", async () => {
    const source = new File([new Uint8Array([1])], "music.mp3", { type: "audio/mpeg" });
    const contextFactory = vi.fn(() => makeContext());

    await expect(snapshotReferencedWavFiles([source], { audioContextFactory: contextFactory }))
      .rejects.toBeInstanceOf(LocalWavSnapshotError);
    expect(contextFactory).not.toHaveBeenCalled();
  });

  it("rejects the file-count and copied-byte budgets before reading source bytes", async () => {
    const tooMany = Array.from({ length: MAX_SNAPSHOT_WAV_FILE_COUNT + 1 }, (_, index) =>
      ({ name: `sample-${index}.wav`, type: "audio/wav", size: 1, lastModified: 0, arrayBuffer: vi.fn() } as unknown as File));
    await expect(snapshotReferencedWavFiles(tooMany, { decodeFiles: [] })).rejects.toThrow(/512 unique WAV/);
    expect(tooMany[0]!.arrayBuffer).not.toHaveBeenCalled();

    const tooManyBytes = Array.from({ length: 5 }, (_, index) => ({
      name: `large-${index}.wav`,
      type: "audio/wav",
      size: 64 * 1024 * 1024,
      lastModified: 0,
      arrayBuffer: vi.fn(),
    } as unknown as File));
    await expect(snapshotReferencedWavFiles(tooManyBytes, { decodeFiles: [] }))
      .rejects.toThrow(new RegExp(`${Math.round(MAX_SNAPSHOT_WAV_BATCH_BYTES / (1024 * 1024))} MiB`));
    expect(tooManyBytes[0]!.arrayBuffer).not.toHaveBeenCalled();
  });

  it("limits cumulative native decode PCM and reports the file that exceeded the remainder", async () => {
    const files = Array.from({ length: 5 }, (_, index) => makeWavFile(`sample-${index}.wav`));
    // The fake native decoder models a browser decoder returning a much larger buffer than the small fixtures.
    const context = makeContext(async () => makeBuffer(600));

    const result = await snapshotReferencedWavFiles(files, {
      audioContextFactory: () => context,
    });

    expect(result.decodedChannelSamples).toBe(4 * 600 * SAMPLE_RATE);
    expect(result.decodedChannelSamples).toBeLessThanOrEqual(MAX_SNAPSHOT_WAV_DECODED_CHANNEL_SAMPLES);
    expect(result.decodedFileCount).toBe(4);
    expect(result.validationBySource.get(files[4]!)).toMatchObject({ status: "invalid", message: /remaining decoded-audio budget/ });
    expect(result.decodeAttemptCount).toBe(5);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("discards a decode completed after cancellation and closes its temporary context", async () => {
    const file = makeWavFile("cancel.wav");
    let finishDecode!: (buffer: AudioBuffer) => void;
    const context = makeContext(() => new Promise<AudioBuffer>((resolve) => { finishDecode = resolve; }));
    const controller = new AbortController();
    const pending = snapshotReferencedWavFiles([file], {
      signal: controller.signal,
      audioContextFactory: () => context,
    });

    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledTimes(1));
    controller.abort();
    finishDecode(makeBuffer());

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("cancels after a pending source read without creating an AudioContext", async () => {
    const source = makeWavFile("pending.wav");
    let finishRead!: (bytes: ArrayBuffer) => void;
    Object.defineProperty(source, "arrayBuffer", {
      configurable: true,
      value: vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; })),
    });
    const controller = new AbortController();
    const contextFactory = vi.fn(() => makeContext());
    const pending = snapshotReferencedWavFiles([source], {
      signal: controller.signal,
      decodeFiles: [],
      audioContextFactory: contextFactory,
    });

    await vi.waitFor(() => expect(source.arrayBuffer).toHaveBeenCalledTimes(1));
    controller.abort();
    finishRead(new ArrayBuffer(source.size));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(contextFactory).not.toHaveBeenCalled();
  });
});
