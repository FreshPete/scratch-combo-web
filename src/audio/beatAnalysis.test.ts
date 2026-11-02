import { describe, expect, it, vi } from "vitest";
import {
  analyzeLocalAudioFile,
  detectBpmFromPcm,
  MAX_LOCAL_AUDIO_FILE_BYTES,
} from "./beatAnalysis";

function clickTrack(bpm: number, durationSeconds = 20): Float32Array {
  const sampleRate = 48_000;
  const samples = new Float32Array(sampleRate * durationSeconds);
  const pulseSeconds = 60 / bpm;
  for (let onsetAt = 0.25; onsetAt < durationSeconds; onsetAt += pulseSeconds) {
    const onsetSample = Math.round(onsetAt * sampleRate);
    const pulseSamples = Math.round(0.045 * sampleRate);
    for (let offset = 0; offset < pulseSamples && onsetSample + offset < samples.length; offset += 1) {
      const time = offset / sampleRate;
      samples[onsetSample + offset] = samples[onsetSample + offset]!
        + Math.sin(2 * Math.PI * 700 * time) * Math.exp(-75 * time) * 0.8;
    }
  }
  return samples;
}

function makeWavFile(name = "beat.wav", dataBytes = new Uint8Array([0, 0, 0, 0])): File {
  const bytes = new ArrayBuffer(44 + dataBytes.length);
  const view = new DataView(bytes);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes.length, true);
  new Uint8Array(bytes).set(dataBytes, 44);
  return {
    name,
    type: "audio/wav",
    size: bytes.byteLength,
    arrayBuffer: vi.fn(async () => bytes.slice(0)),
  } as unknown as File;
}

function makeMp3File(
  name: string,
  frameCount: number,
  options: { readonly id3?: boolean; readonly trailingBytes?: number } = {},
): File {
  const frameLength = 26; // MPEG-2 Layer III, 8 kbit/s, 22.05 kHz mono.
  const id3Header = options.id3 ? new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]) : new Uint8Array();
  const bytes = new Uint8Array(id3Header.length + frameCount * frameLength + (options.trailingBytes ?? 0));
  bytes.set(id3Header, 0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = id3Header.length + frame * frameLength;
    bytes.set([0xff, 0xf3, 0x10, 0xc0], offset);
  }
  return {
    name,
    type: "audio/mpeg",
    size: bytes.byteLength,
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(0)),
  } as unknown as File;
}

function makeDecodedBuffer(channelData: Float32Array, sampleRate = 48_000): AudioBuffer {
  return {
    duration: channelData.length / sampleRate,
    length: channelData.length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => channelData,
  } as unknown as AudioBuffer;
}

function fakeAudioContext(buffer: AudioBuffer, sampleRate = 48_000): BaseAudioContext {
  return {
    sampleRate,
    decodeAudioData: vi.fn(async () => buffer),
  } as unknown as BaseAudioContext;
}

describe("local beat BPM analysis", () => {
  it("detects a periodic 80 BPM click track from PCM", () => {
    const result = detectBpmFromPcm([clickTrack(80)], 48_000);
    expect(result.status).toBe("detected");
    if (result.status !== "detected") return;
    expect(result.bpm).toBeCloseTo(80, 0);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.alternatives).toEqual(expect.any(Array));
  });

  it("reports 60/120 half-time ambiguity for an evenly spaced 120 BPM pulse", () => {
    const result = detectBpmFromPcm([clickTrack(120)], 48_000);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates).toEqual(expect.arrayContaining([60, 120]));
  });

  it("distinguishes silence, short material, and invalid channel data", () => {
    expect(detectBpmFromPcm([new Float32Array(48_000 * 10)], 48_000)).toEqual({
      status: "insufficient",
      reason: "silence",
    });
    expect(detectBpmFromPcm([new Float32Array(48_000 * 4)], 48_000)).toEqual({
      status: "insufficient",
      reason: "too-short",
    });
    expect(detectBpmFromPcm([new Float32Array(1_000)], Number.NaN)).toEqual({
      status: "insufficient",
      reason: "invalid-audio",
    });
  });

  it("validates a WAV at the local decode boundary and returns its AudioBuffer and analysis", async () => {
    const file = makeWavFile();
    const buffer = makeDecodedBuffer(new Float32Array(48_000 * 10));
    const context = fakeAudioContext(buffer);

    const analysis = await analyzeLocalAudioFile(context, file);

    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(analysis).toMatchObject({
      buffer,
      durationSeconds: 10,
      sampleRate: 48_000,
      channelCount: 1,
      detection: { status: "insufficient", reason: "silence" },
    });
  });

  it("preflights MP3 frames while skipping ID3 tags and a partial trailing fragment", async () => {
    const file = makeMp3File("with-id3.mp3", 420, { id3: true, trailingBytes: 3 });
    const buffer = makeDecodedBuffer(clickTrack(128, 12));
    const context = fakeAudioContext(buffer);

    const analysis = await analyzeLocalAudioFile(context, file);

    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(analysis.channelCount).toBe(1);
    expect(analysis.sampleRate).toBe(48_000);
    expect(analysis.durationSeconds).toBe(12);
  });

  it("rejects malformed and truncated MP3 frames before browser decoding", async () => {
    const context = fakeAudioContext(makeDecodedBuffer(new Float32Array(48_000 * 10)));
    const malformedBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const truncatedBytes = new Uint8Array([0xff, 0xf3, 0x10, 0xc0]);
    const fileFor = (name: string, bytes: Uint8Array) => ({
      name,
      type: "audio/mpeg",
      size: bytes.byteLength,
      arrayBuffer: vi.fn(async () => bytes.buffer.slice(0)),
    } as unknown as File);

    await expect(analyzeLocalAudioFile(context, fileFor("invalid.mp3", malformedBytes)))
      .rejects.toThrow(/no readable MPEG audio frames/);
    await expect(analyzeLocalAudioFile(context, fileFor("truncated.mp3", truncatedBytes)))
      .rejects.toThrow(/no readable MPEG audio frames/);
    expect(context.decodeAudioData).not.toHaveBeenCalled();
  });

  it("rejects MP3 duration and projected decoded PCM over budget before decoding", async () => {
    const context = fakeAudioContext(makeDecodedBuffer(new Float32Array(48_000 * 10)));
    const tooLong = makeMp3File("too-long.mp3", 23_000);
    await expect(analyzeLocalAudioFile(context, tooLong)).rejects.toThrow(/10 minutes/);
    expect(context.decodeAudioData).not.toHaveBeenCalled();

    const framesFor400Seconds = Math.ceil(400 * 22_050 / 576);
    const tooManyPcmSamples = makeMp3File("too-many-samples.mp3", framesFor400Seconds);
    const highRateContext = fakeAudioContext(makeDecodedBuffer(new Float32Array(48_000 * 10)), 192_000);
    await expect(analyzeLocalAudioFile(highRateContext, tooManyPcmSamples)).rejects.toThrow(/too large to decode safely/);
    expect(highRateContext.decodeAudioData).not.toHaveBeenCalled();
  });

  it("rejects oversized postdecode AudioBuffers even when file preflight passed", async () => {
    const file = makeMp3File("decoder-overrun.mp3", 420);
    const oversizedBuffer = {
      duration: 60_000_001 / 192_000,
      length: 60_000_001,
      sampleRate: 192_000,
      numberOfChannels: 1,
      getChannelData: vi.fn(() => new Float32Array(0)),
    } as unknown as AudioBuffer;
    const context = fakeAudioContext(oversizedBuffer);

    await expect(analyzeLocalAudioFile(context, file)).rejects.toThrow(/too large to keep in browser memory/);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed WAV headers and oversize files before decoding", async () => {
    const malformed = makeWavFile("broken.wav");
    const malformedBytes = await malformed.arrayBuffer();
    new DataView(malformedBytes).setUint32(4, 0xffff_ffff, true);
    const malformedFile = {
      ...malformed,
      arrayBuffer: vi.fn(async () => malformedBytes),
    } as unknown as File;
    const context = fakeAudioContext(makeDecodedBuffer(new Float32Array(48_000 * 10)));
    await expect(analyzeLocalAudioFile(context, malformedFile)).rejects.toThrow(/RIFF length/);
    expect(context.decodeAudioData).not.toHaveBeenCalled();

    const originalBytes = new Uint8Array(await makeWavFile().arrayBuffer());
    const duplicateFmtBytes = new ArrayBuffer(originalBytes.byteLength + 24);
    const duplicateView = new Uint8Array(duplicateFmtBytes);
    duplicateView.set(originalBytes.subarray(0, 36), 0);
    duplicateView.set(originalBytes.subarray(12, 36), 36);
    duplicateView.set(originalBytes.subarray(36), 60);
    new DataView(duplicateFmtBytes).setUint32(4, duplicateView.length - 8, true);
    const duplicateFormatFile = {
      name: "duplicate-format.wav",
      type: "audio/wav",
      size: duplicateView.length,
      arrayBuffer: vi.fn(async () => duplicateFmtBytes.slice(0)),
    } as unknown as File;
    await expect(analyzeLocalAudioFile(context, duplicateFormatFile)).rejects.toThrow(/duplicate format/);
    expect(context.decodeAudioData).not.toHaveBeenCalled();

    const duplicateDataBytes = new ArrayBuffer(originalBytes.byteLength + 12);
    const duplicateDataView = new Uint8Array(duplicateDataBytes);
    duplicateDataView.set(originalBytes, 0);
    const duplicateDataHeader = new DataView(duplicateDataBytes);
    for (let index = 0; index < 4; index += 1) duplicateDataHeader.setUint8(48 + index, "data".charCodeAt(index));
    duplicateDataHeader.setUint32(52, 4, true);
    duplicateDataHeader.setUint32(4, duplicateDataView.length - 8, true);
    const duplicateDataFile = {
      name: "duplicate-data.wav",
      type: "audio/wav",
      size: duplicateDataView.length,
      arrayBuffer: vi.fn(async () => duplicateDataBytes.slice(0)),
    } as unknown as File;
    await expect(analyzeLocalAudioFile(context, duplicateDataFile)).rejects.toThrow(/duplicate audio data/);
    expect(context.decodeAudioData).not.toHaveBeenCalled();

    const tooLarge = {
      name: "too-large.wav",
      type: "audio/wav",
      size: MAX_LOCAL_AUDIO_FILE_BYTES + 1,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    } as unknown as File;
    await expect(analyzeLocalAudioFile(context, tooLarge)).rejects.toThrow(/64 MiB/);
    expect(tooLarge.arrayBuffer).not.toHaveBeenCalled();
  });
});
