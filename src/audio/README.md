# Audio processing

## Live tempo and pitch

Imported preset playback uses the preset BPM as its web `referenceBpm`. The selected BPM sets event spacing and uniformly changes the playback rate of both combo samples and the beat WAV; the selected beat's own BPM metadata is retained, but its original playback-rate behavior was not established from the recovered source. This is a web playback assumption, not a claim of parity with the original beat player.

`AudioTransport.setTempo()` changes the rate while preserving the current fixture-unit position. It updates the existing beat source in place and cancels only future combo sources inside the scheduler lookahead. `setPitchSemitones()` independently changes both layers through the shared processor. Sample and beat gain nodes remain separate and can be changed without restarting either source. Tempo is bounded to 0.5–2× the imported reference BPM, and pitch is an integer from −12 to +12 semitones.

Live controls use the pinned `@soundtouchjs/audio-worklet` 2.1.1 package, licensed MPL-2.0. Its prebundled processor is emitted by Vite as an asset; the main-thread wrapper is dynamically loaded after an audio context is available. AudioWorklet requires a secure context such as HTTPS or localhost. If the worklet cannot load, playback reports the failure instead of falling back to audio whose pitch would no longer match the requested control.

SoundTouch uses 128-frame render blocks and WSOLA windows that default to 50–125 ms sequence, 15–25 ms seek, and 8 ms overlap. These are algorithm parameters, not a measured or guaranteed end-to-end latency. Time stretching can smear sharp transients or add artifacts, especially at larger adjustments. The app's narrower tempo and pitch limits reduce the supported range but do not guarantee identical sound for every imported WAV. No end-to-end latency measurement is currently claimed.

## Browser verification

`e2e/audio-processing.spec.ts` renders tones through the real bundled AudioWorklet in Edge. It verifies an 85→100 BPM rate change while pitch stays at 440 Hz, a later +3 semitone change to approximately 523 Hz, separate sample/beat gain levels, continuous output around both parameter transitions, and the expected 1.7/(100/85) second processed duration. A short finite source also ends at its expected rate-scaled duration in that browser render; this supports the transport's current finite completion point without claiming a universal worklet latency. Run it with `npm run test:e2e -- --grep "browser worklet"`.
