# Work list

## Delivered in this pass

- [x] Draw real sample waveforms inside the existing time grid.
- [x] Add consistent sample colours to waveforms, inspired by the [reference combo generator](https://sideshow-combo-gen.digitalvertigo.workers.dev/). Keep labels and shapes readable without relying on colour alone.
- [x] Auto-generate a new combo after a selected number of complete practice rounds, keeping the beat continuous.
- [x] Lock combo-structure controls during playback while keeping tempo, pitch, levels and Reset live.
- [x] Render source-attributed TTM movement and fader guides in Grid and Inline, with supported suggestions, explicit assignments and Untranscribed, available in the hosted app.

- [x] Upload a local WAV or MP3 beat, review or correct the estimated BPM, and use it with the current scratch library. Separate beat and scratch tempo references keep both layers synchronized as practice tempo changes.

- [x] Make Preset and Custom beat sources mutually exclusive with disabled inactive controls.
- [x] Focus the workspace with Practice, Session, Samples and Files tabs; keep shared playback controls and add guarded P/G/R shortcuts with help and an off switch.

## Queued

- [ ] Expand notation coverage only where reliable technique definitions and clear teaching patterns are available; full WAV transcription is not implemented.


BPM analysis is an estimate with half/double-time ambiguity; manual correction remains available. See [audio processing](../src/audio/README.md#local-beat-import-and-bpm-estimate) for limits.
