# Work list

## Delivered in this pass

- [x] Draw real sample waveforms inside the existing time grid.
- [x] Add consistent sample colours to waveforms, inspired by the [reference combo generator](https://sideshow-combo-gen.digitalvertigo.workers.dev/). Keep labels and shapes readable without relying on colour alone.
- [x] Auto-generate a new combo after a selected number of complete practice rounds, keeping the beat continuous.
- [x] Lock combo-structure controls during playback while keeping tempo, pitch, levels and Reset live.
- [x] Add TTM-style practice guides for local debugging, with record movement and crossfader states. The GitHub deployment shows TTM disabled until this feature is ready for public use.

## Queued

- [ ] Review and finish TTM notation before enabling it in the hosted app.
- [ ] Let users choose their own WAV or MP3 beat, detect its BPM locally, offer manual correction, and continue using the selected scratch-sample library. Keep beat selection separate from sample-preset replacement.

Custom-beat work must account for the beat and scratch library having different recorded BPM values, so both stay synchronized as practice tempo changes.
