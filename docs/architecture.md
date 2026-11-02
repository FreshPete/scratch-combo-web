# Architecture

Status: approved for the current browser practice slice.

## Application shape

The app is a static React, TypeScript, and Vite SPA. Presets and selected audio files are read in the browser and held in session memory. Selected files are never uploaded or copied into the repository. Web Audio is the only playback transport in this slice.

## Import and domain boundary

The UI reads a selected INI and WAV files through the browser File API. Pure domain code parses the INI into `Preset` and `SampleDefinition` records, retaining all configured samples, including disabled and silent records. Boolean, count, and finite-number fields are validated strictly.

The first run selects the 85 BPM Beginner preset. The quick selector also lists five additional built-in presets, the explicit `Your files…` route, and the synthetic demo. Built-in resources load from a strict same-origin allowlist under `public/private-presets/`; catalog IDs, INI names, BPM values, audio folders, file types, and URL paths are checked before ready state. The Pages workflow downloads a checksummed archive from the public `presets-v1` release and places its catalog, six INIs, and WAV files in that ignored directory before building. A built-in selection becomes ready only after all referenced sample and beat files resolve and the default 8-beat combo is generated; loading never autoplays. Selecting `Your files…` aborts an outstanding built-in request and focuses the local INI picker.

The asset index contains only selected `File` objects and their relative paths. Matching is case-insensitive and resolves against selected spelling. A root-path tail is a matching hint; it is never opened as a local path. Qualified directory matches take priority, while missing, ambiguous, unsafe, and case-colliding paths produce diagnostics instead of arbitrary selection.

## Fixture and playback boundary

The built-in demo is a deterministic ordered fixture built from enabled samples with positive configured duration. It clips to its requested unit range and fills unused units with an explicit silent rest. Imported presets use the recovered selector to build a legacy-tick fixture. Selection uses bounded, quantized browser draws and does not claim to reproduce the original VB6 time-seeded random stream.

The demo and sample audition use finite Play/Stop. Imported sequence playback uses an explicit repeating cycle plan on the Web Audio context clock with 16 legacy ticks per beat. Loop contains one fixture slot, so sample audio plays every cycle. Q&A contains one fixture slot followed by one full-length silent slot; Large pause uses one fixture slot followed by three silent slots. Stop, new playback, or disposal cancels the plan. A selected beat bed remains continuous through silent slots, and the visible playhead follows each slot while the imported fixture stays on screen. Cycle phase comes from the audio transport snapshot rather than React render timing.

Session controls keep BPM, semitone pitch, sample gain, and beat gain independent. BPM is a live tempo multiplier anchored to the selected source preset BPM, bounded to 0.5×–2× with a minimum of 1 BPM; pitch is −12 to +12 semitones. Active transport setters update playback without restarting the beat bed. Reset controls restores the selected source preset BPM and levels plus zero pitch while leaving the current mode, beat choice, combo length, and playback state intact.

For imported INIs, the UI exposes the native seven editable sample fields. A row save validates through the domain writer and updates only in-memory sample data, clearing the generated combo so it must be regenerated. Save Sample Data patches the original INI text, preserving unchanged comments, order, unknown keys, stable row IDs, recorded BPM01, beat references, and source paths while including current sample and beat levels. The output is a user-selected Save As target or a `*-edited.ini` download fallback. The source file is never implicitly opened for writing.

Automatic regeneration and repeat-count controls are not exposed in this slice. Pause and physical onset accuracy remain unverified. The source preset and audio assets are not modified.

