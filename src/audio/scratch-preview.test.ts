import { describe, expect, it } from "vitest";
import { makeScratchPreviewSource, renderScratchPreview } from "./scratch-preview";

describe("renderScratchPreview", () => {
  it("plays a forward record movement through the source window", () => {
    const source = Float32Array.from({ length: 400 }, (_, frame) => frame / 400);
    const [rendered] = renderScratchPreview({
      channels: [source],
      sourceSampleRate: 1000,
      outputSampleRate: 100,
      durationSeconds: 1,
      positions: [0, 1],
      fader: [],
    });

    expect(rendered).toBeDefined();
    expect(rendered![20]).toBeGreaterThan(0.05);
    expect(rendered![70]).toBeGreaterThan(rendered![20]!);
    expect(rendered![99]).toBeGreaterThan(rendered![70]!);
  });

  it("reverses the sample read direction when the record path moves backward", () => {
    const source = Float32Array.from({ length: 400 }, (_, frame) => frame / 400);
    const [rendered] = renderScratchPreview({
      channels: [source],
      sourceSampleRate: 1000,
      outputSampleRate: 100,
      durationSeconds: 1,
      positions: [1, 0],
      fader: [],
    });

    expect(rendered).toBeDefined();
    expect(rendered![20]).toBeGreaterThan(rendered![70]!);
    expect(rendered![70]).toBeGreaterThan(rendered![99]!);
  });

  it("cuts closed fader steps and fades the opening edge to avoid a click", () => {
    const [rendered] = renderScratchPreview({
      channels: [new Float32Array(400).fill(0.5)],
      sourceSampleRate: 1000,
      outputSampleRate: 1000,
      durationSeconds: 1,
      positions: [0, 0.5, 1],
      fader: [true, false, true, false],
    });

    expect(rendered).toBeDefined();
    expect(rendered![0]).toBe(0);
    expect(rendered![2]).toBeGreaterThan(0.1);
    expect(rendered![2]).toBeLessThan(0.2);
    expect(rendered![20]).toBeGreaterThan(0.49);
    expect(rendered![248]).toBeGreaterThan(0.2);
    expect(rendered![248]).toBeLessThan(0.3);
    expect(rendered![100]).toBeGreaterThan(0.49);
    expect(rendered![600]).toBeGreaterThan(0.49);
    expect(rendered![200]).toBeGreaterThan(0.49);
    expect(rendered![300]).toBe(0);
    expect(rendered![500]).toBe(0);
    expect(rendered![502]).toBeGreaterThan(0.2);
    expect(rendered![502]).toBeLessThan(0.3);
    expect(rendered![504]).toBeGreaterThan(0.49);
    expect(rendered![800]).toBe(0);
  });

  it("smooths movement starts and stops to avoid clicks at held-record boundaries", () => {
    const [startsMoving] = renderScratchPreview({
      channels: [new Float32Array(400).fill(0.5)],
      sourceSampleRate: 1000,
      outputSampleRate: 1000,
      durationSeconds: 1,
      positions: [0.5, 0.5, 1],
      fader: [],
    });
    const [stopsMoving] = renderScratchPreview({
      channels: [new Float32Array(400).fill(0.5)],
      sourceSampleRate: 1000,
      outputSampleRate: 1000,
      durationSeconds: 1,
      positions: [0, 1, 1],
      fader: [],
    });

    expect(startsMoving).toBeDefined();
    expect(stopsMoving).toBeDefined();
    expect(startsMoving![499]).toBe(0);
    expect(startsMoving![500]).toBe(0);
    expect(startsMoving![502]).toBeGreaterThan(0.2);
    expect(startsMoving![504]).toBeGreaterThan(0.49);
    expect(stopsMoving![496]).toBeGreaterThan(0.49);
    expect(stopsMoving![498]).toBeGreaterThan(0.2);
    expect(stopsMoving![499]).toBeGreaterThan(0);
    expect(stopsMoving![500]).toBe(0);
  });

  it("keeps the record silent while held still and sanitizes non-finite source values", () => {
    const [stationary] = renderScratchPreview({
      channels: [new Float32Array(400).fill(1)],
      sourceSampleRate: 1000,
      outputSampleRate: 100,
      durationSeconds: 1,
      positions: [0.5, 0.5],
      fader: [],
    });
    const [moving] = renderScratchPreview({
      channels: [Float32Array.from([0, Number.NaN, 0.5, Number.POSITIVE_INFINITY, 1])],
      sourceSampleRate: 1000,
      outputSampleRate: 100,
      durationSeconds: 1,
      positions: [0, 1],
      fader: [],
    });

    expect(stationary?.every((sample) => sample === 0)).toBe(true);
    expect(moving?.every(Number.isFinite)).toBe(true);
  });

  it("uses the same scratch speed threshold across source sample rates", () => {
    const renderAtRate = (sampleRate: number) => {
      const source = new Float32Array(Math.floor(sampleRate * 0.4)).fill(0.5);
      return renderScratchPreview({
        channels: [source],
        sourceSampleRate: sampleRate,
        outputSampleRate: 100,
        durationSeconds: 1,
      positions: [0, 0.06],
        fader: [],
      })[0];
    };

    expect(renderAtRate(1000)?.[50]).toBeGreaterThan(0.4);
    expect(renderAtRate(48000)?.[50]).toBeGreaterThan(0.4);
  });
});

describe("makeScratchPreviewSource", () => {
  it("creates a short finite source that is quiet at its edges", () => {
    const source = makeScratchPreviewSource(1000);

    expect(source).toHaveLength(400);
    expect(source.every(Number.isFinite)).toBe(true);
    expect(source[0]).toBe(0);
    expect(source[source.length - 1]).toBe(0);
    expect(Math.max(...source.map(Math.abs))).toBeGreaterThan(0.2);
  });
});
