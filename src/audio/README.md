# Audio processing

## Live tempo and pitch

Imported preset playback uses the preset BPM as its `referenceBpm`. A local beat file may supply its own `beatReferenceBpm`; each layer then uses the selected BPM divided by its own reference for source playback rate, while fixture event spacing follows the selected BPM. Equal ratios share one SoundTouch node. Different ratios use a dedicated node for the beat so each node's `playbackRate` matches its input source and SoundTouch can preserve neutral pitch on both layers. `pitchSemitones` is applied to both nodes. This behavior is the web playback contract, not a claim of parity with the original player.

`AudioTransport.setTempo()` changes the rate while preserving the current fixture-unit position. It updates the existing beat source in place and cancels only future combo sources inside the scheduler lookahead. `setPitchSemitones()` applies the same pitch shift to both layers, whether they share one processor or use separate processors. Sample and beat gain nodes remain separate and can be changed without restarting either source. Tempo must stay within 0.5–2× of both the imported preset reference and the selected beat reference; the usable range is their intersection. Pitch is an integer from −12 to +12 semitones.

## Local beat import and BPM estimate

`analyzeLocalAudioFile()` reads and decodes the selected file in the browser, then estimates BPM from at most the first 120 seconds of decoded PCM. The full validated `AudioBuffer` is returned for playback, so a longer beat track can loop gaplessly. The import boundary accepts MP3 and WAV files; WAV must use uncompressed PCM or 32-bit float. Files are limited to 64 MiB and 10 minutes, with one or two channels, an 8–192 kHz source rate, and a 60,000,000 decoded channel-sample budget. No audio is uploaded. `beatBuffer` lets playback reuse this already-decoded buffer instead of decoding the file twice.

The detector needs at least 8 seconds of usable audio and estimates 50–200 BPM. It uses periodic onset-strength autocorrelation; its `confidence` is a normalized score, not a probability. When near-equal half-time or double-time candidates remain, it reports `ambiguous` with BPM candidates. Silence, short clips, invalid PCM, and material without a clear periodic pulse report `insufficient`. Syncopation, sparse percussion, rubato, long intros, and strong subdivisions can still produce an incorrect or ambiguous estimate, so the estimate should remain user-correctable.

Live controls use the pinned `@soundtouchjs/audio-worklet` 2.1.1 package, licensed MPL-2.0. Its prebundled processor is emitted by Vite as an asset; the main-thread wrapper is dynamically loaded after an audio context is available. AudioWorklet requires a secure context such as HTTPS or localhost. If the worklet cannot load, playback reports the failure instead of falling back to audio whose pitch would no longer match the requested control.

SoundTouch uses 128-frame render blocks and WSOLA windows that default to 50–125 ms sequence, 15–25 ms seek, and 8 ms overlap. These are algorithm parameters, not a guaranteed latency. Time stretching can smear sharp transients or add artifacts, especially at larger adjustments. The app's narrower tempo and pitch limits reduce the supported range but do not guarantee identical sound for every imported WAV.

## Presentation clock and finite drain

`TransportSnapshot.progress` remains the scheduler/input-clock position. `presentation` is the separate estimated heard position: it maps `AudioContext.getOutputTimestamp()` to the current output-device frame, then subtracts the measured SoundTouch content lag. `presentation.started` stays false through startup lead and processor priming. Its `positionUnits` is local to the active slot, and its cycle/plan fields describe the phase expected at output. Browsers without a usable output timestamp fall back to `AudioContext.currentTime`.

At 48 kHz in Edge, actual bundled-worklet PCM probes measured repeated transient offsets of 102–137 ms at common tempo ratios 0.75, 1, and 100/85 with pitch 0 and +3 semitones. The 130 ms presentation estimate kept those repeated attacks within 28 ms in this probe. At the 0.5 and 2.0 extremes, WSOLA moved some individual attacks by more; this clock is an estimate, not exact per-transient alignment. Separate terminal-marker attacks measured 87–129 ms delay at pitch 0 and 93 ms at ±12 semitones at 1×. The fixed 130 ms estimate can lag those attacks by 37–43 ms; the repeated transient detector at tempo extremes varied by up to about 46 ms.

SoundTouch's worklet returns early when its input bus has no channels, so a finite sample that disconnects can leave processed frames buffered. A terminal-marker probe rendered only to the input end without a connected pad; a zero-valued `ConstantSourceNode` kept the processor running and exposed an additional 116–128 ms of output after input end across 0.5–2× at pitch 0. At 1×, pitch −12/+12 measured 115/124 ms. The transport now keeps a silent input connected during processed playback and for 150 ms after finite input end. This bound is 22–34 ms longer than the measured tails in this probe. Finite completion waits until the output timestamp passes that drain end. Manual Stop still clears the source immediately.

`getOutputTimestamp()` maps browser output-device frames; no physical speaker loopback or room/acoustic delay was measured. Content lag and device-output mapping are distinct estimates.

## Browser verification

`e2e/audio-processing.spec.ts` renders tones and repeated transients through the actual bundled AudioWorklet in Edge. It verifies tempo/pitch independence, separate sample/beat gains, output continuity, repeated transient alignment at common rates, finite terminal-marker delay, and tail drain with no pad, zero input, beat input, and pitch extremes. Run it with `npm run test:e2e -- --grep "browser worklet"`.

## Auto-generate cycle plans

`playCyclePlan()` stays on its initial ordered slot plan unless given both `cyclesPerPlan` and a synchronous `nextPlan({ completedRounds, nextPlanIndex })` provider. The provider may return a new `{ slots }` plan after each full plan has played for the selected 1, 2, 4, or 8 complete rounds. The scheduler prepares plans ahead of time, while presentation phase fields and `onPlanBoundary` advance only when the estimated output cursor reaches that boundary. A provider failure lets the current full rounds finish, then stops with an error. The beat source and tempo/pitch settings remain active across plan changes.

If an Auto-generate scheduler tick wakes too far behind to catch up safely, it stops after at most 64 cycle advances in that tick and reports an error. Press Play to restart from the current combo; it does not attempt an unbounded burst of generated plans or sample events.

Pass eligible future sample ids in `preloadSampleIds`; those files are decoded before playback with a four-file concurrency limit. A generated plan that references an id that was not already loaded or preloaded fails at its boundary. With no provider, existing cycle-plan playback keeps repeating the same plan until Stop.
