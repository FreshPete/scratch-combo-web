# Work list

## Delivered

- [x] Draw real sample waveforms inside the existing time grid.
- [x] Add consistent sample colours to waveforms, inspired by the [reference combo generator](https://sideshow-combo-gen.digitalvertigo.workers.dev/). Keep labels and shapes readable without relying on colour alone.
- [x] Auto-generate a new combo after a selected number of complete practice rounds, keeping the beat continuous.
- [x] Lock combo-structure controls during playback while keeping tempo, pitch, levels and Reset live.
- [x] Render source-attributed TTM movement and fader guides in Grid and Inline, with supported suggestions, explicit assignments and Untranscribed. This remains local-only while coverage is expanded; the hosted option is disabled.

- [x] Upload a local WAV or MP3 beat, review or correct the estimated BPM, and use it with the current scratch library. Separate beat and scratch tempo references keep both layers synchronized as practice tempo changes.

- [x] Make Preset and Custom beat sources mutually exclusive with disabled inactive controls.
- [x] Focus the workspace with Practice, Session, Samples and Files tabs; keep shared playback controls and add guarded P/G/R shortcuts with help and an off switch.

- [x] Replace the three file pickers with a staged INI → audio folder/files → review wizard. Retain copied audio in session memory, verify required playback files, preserve the active preset until Load, and support cancellation and repair.

- [x] Save and reload named practice sessions and favourite the exact generated combo from Practice. IndexedDB stores preset/settings/fixture data and referenced local audio bytes; restore validates audio, stays stopped, and never autoplays.
- [x] Add manual, source-specific beat downbeat and loop-end trim controls to Session. Cue and exclusive end are bounded by decoded duration, Apply affects the next Play, source mode switches retain per-beat settings, and older saved sessions default to full-clip playback.

The beat trim feature is local-ready on `codex/beat-alignment`; Edge and Chrome browser journeys and the Pages build pass. The hosted app still serves merged revision `4a15973` until a reviewed release is published.

## Queued — ordered follow-ups

- [ ] Count-in and metronome.
- [ ] Tempo-ramp trainer.
- [ ] Real pause and resume.
- [ ] Physical output synchronization checks and real mobile-device evidence.
- [ ] Pull-request CI before merge.
- [ ] Audio export is deferred for discussion before implementation is scoped.

Notation coverage can expand only where reliable technique definitions and clear teaching patterns are available; full WAV transcription is not implemented.


BPM analysis is an estimate with half/double-time ambiguity; manual correction remains available. See [audio processing](../src/audio/README.md#local-beat-import-and-bpm-estimate) for limits.
