# Work list

## Delivered in this pass

- [x] Draw real sample waveforms inside the existing time grid.
- [x] Add consistent sample colours to waveforms, inspired by the [reference combo generator](https://sideshow-combo-gen.digitalvertigo.workers.dev/). Keep labels and shapes readable without relying on colour alone.
- [x] Auto-generate a new combo after a selected number of complete practice rounds, keeping the beat continuous.
- [x] Lock combo-structure controls during playback while keeping tempo, pitch, levels and Reset live.
- [x] Add TTM-style practice guides for local debugging, with record movement and crossfader states. The GitHub deployment shows TTM disabled until this feature is ready for public use.

- [x] Upload a local WAV or MP3 beat, review or correct the estimated BPM, and use it with the current scratch library. Separate beat and scratch tempo references keep both layers synchronized as practice tempo changes.

## Queued

- [ ] Review and finish TTM notation before enabling it in the hosted app.


BPM analysis is an estimate with half/double-time ambiguity; manual correction remains available. See [audio processing](../src/audio/README.md#local-beat-import-and-bpm-estimate) for limits.
