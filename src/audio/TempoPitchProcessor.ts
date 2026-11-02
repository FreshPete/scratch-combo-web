import processorUrl from "@soundtouchjs/audio-worklet/processor?url";

export interface TempoPitchProcessorNode extends AudioNode {
  readonly playbackRate: AudioParam;
  readonly pitchSemitones: AudioParam;
  readonly metrics?: {
    readonly framesBuffered: number;
    readonly underrunCount: number;
    readonly blockCount: number;
  } | null;
}

export type TempoPitchProcessorFactory = (context: AudioContext) => Promise<TempoPitchProcessorNode>;

const registrations = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the optional DSP only after a browser AudioContext exists. */
export const createTempoPitchProcessor: TempoPitchProcessorFactory = async (context) => {
  if (!context.audioWorklet) {
    throw new Error("Live tempo and pitch controls require AudioWorklet in a secure browser context (HTTPS or localhost).");
  }

  try {
    const { SoundTouchNode } = await import("@soundtouchjs/audio-worklet");
    let registration = registrations.get(context);
    if (!registration) {
      registration = SoundTouchNode.register(context, processorUrl);
      registrations.set(context, registration);
      void registration.catch(() => {
        if (registrations.get(context) === registration) registrations.delete(context);
      });
    }
    await registration;
    return new SoundTouchNode({ context });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`The live tempo and pitch processor could not be loaded.${detail}`);
  }
};
