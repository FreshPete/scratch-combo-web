# Architecture

Status: approved for the current browser practice slice.

## Application shape

The app is a static React, TypeScript, and Vite SPA. Presets and selected audio files are read in the browser and held in session memory. Selected files are never uploaded or copied into the repository. Web Audio is the only playback transport in this slice.

## Focused workspace

Practice, Session, Samples, and Files are mutually exclusive tab panels that stay mounted while inactive. Shared playback actions and status sit outside the panels, so navigation changes visibility without rebuilding the transport. Legacy section hashes activate the corresponding panel. The tablist supports keyboard navigation and the shortcut help dialog owns focus while open.

P, G, and R invoke the existing Play/Stop, Generate/Build, and Reset actions. They share readiness and playback guards with the buttons, ignore editable/native-control targets, repeats and modified key events, and are suppressed while the help dialog is open. A visible shortcut off switch is available in the help dialog.

## Import and domain boundary

The UI reads a selected INI and WAV files through the browser File API. Pure domain code parses the INI into `Preset` and `SampleDefinition` records, retaining all configured samples, including disabled and silent records. Boolean, count, and finite-number fields are validated strictly.

The first run selects the 85 BPM Beginner preset. The quick selector also lists five additional built-in presets, the explicit `Your files…` route, and the synthetic demo. Built-in resources load from a strict same-origin allowlist under `public/private-presets/`; catalog IDs, INI names, BPM values, audio folders, file types, and URL paths are checked before ready state. The Pages workflow downloads a checksummed archive from the public `presets-v1` release and places its catalog, six INIs, and WAV files in that ignored directory before building. A built-in selection becomes ready only after all referenced sample and beat files resolve and the default 8-beat combo is generated; loading never autoplays. Selecting `Your files…` aborts an outstanding built-in request and focuses the local INI picker.

The asset index contains only selected `File` objects and their relative paths. Matching is case-insensitive and resolves against selected spelling. A root-path tail is a matching hint; it is never opened as a local path. Qualified directory matches take priority, while missing, ambiguous, unsafe, and case-colliding paths produce diagnostics instead of arbitrary selection.

## Fixture and playback boundary

The built-in demo is a deterministic ordered fixture built from enabled samples with positive configured duration. It clips to its requested unit range and fills unused units with an explicit silent rest. Imported presets use the recovered selector to build a legacy-tick fixture. Selection uses bounded, quantized browser draws and does not claim to reproduce the original VB6 time-seeded random stream.

The demo and sample audition use finite Play/Stop. Imported sequence playback uses an explicit repeating cycle plan on the Web Audio context clock with 16 legacy ticks per beat. Loop contains one fixture slot, so sample audio plays every cycle. Q&A contains one fixture slot followed by one full-length silent slot; Large pause uses one fixture slot followed by three silent slots. Stop, new playback, or disposal cancels the plan. A selected beat bed remains continuous through silent slots, and the visible playhead follows each slot while the imported fixture stays on screen. Cycle phase comes from the audio transport snapshot rather than React render timing.

Auto-generate is optional and off by default. `cyclesPerPlan` counts complete practice rounds: a Loop round is one fixture pass; a Q&A round includes the question and its entire one- or three-silent-cycle answer window. The provider prepares the next fixture through a synchronous `nextPlan` callback while the current plan remains active. Only `onPlanBoundary` replaces the visible fixture, so event blocks in the grid do not accumulate or change early. The selected beat remains continuous across the boundary. `preloadSampleIds` contains enabled, non-silent, positive-weight candidates; the UI waits for those local WAVs when Auto-generate is enabled. An all-silent preset passes an empty preload list. This browser cadence is explicit and does not claim legacy native repeat-count parity.

The shared timeline defaults to Waveform. Its optional TTM practice-guides view and session guide-assignment editor are available in development and production. Waveforms are built from PCM decoded from selected local `File` objects using `OfflineAudioContext`; the transport and source audio are untouched. A bounded File-identity LRU retains compact peak envelopes, not decoded buffers, and import generations discard stale decode results. Event slot seconds use `durationUnits * 60 / (presetBpm * unitsPerBeat)`: the SVG keeps source time scale, clips longer sources to the event slot, and leaves blank time after shorter sources. Non-silent event and lane colors come from a deterministic normalized sample-name palette. Silent, unresolved, and undecodable events keep their existing block/fallback rendering without fabricated peaks.

TTM guides are a separate illustrative catalogue of five fixed record-motion and fader patterns. Finite supported Baby-family and exact Chirp aliases suggest teaching patterns; other names stay unassigned. Suggestions come from labels only and do not claim to describe the WAVs. The sample editor allows a different guide or explicit UNTRANSCRIBED; explicit choices win until the preset changes and resets session annotations. Motion and fader coordinates share an inset staff in each event. The same event timing, Grid/Inline layouts, and estimated output-clock playhead are reused. No guide is inferred from audio, saved to legacy INIs, or connected to audio generation. These are not WAV transcriptions or a full TTM score editor.

While transport status is loading or playing, including sample audition, the UI disables and handlers guard controls that can replace or structurally alter a combo: preset/file selection, sample eligibility and editing, beat-bed selection, combo length, mode, answer window, and Auto-generate settings. Stop unlocks these controls. BPM, pitch, sample and beat gains, Reset controls, navigation, and the visual timeline-view switch remain available during playback.

Session controls keep BPM, semitone pitch, sample gain, and beat gain independent. BPM is a live tempo multiplier anchored to the selected source preset BPM, bounded to 0.5×–2× with a minimum of 1 BPM; pitch is −12 to +12 semitones. Active transport setters update playback without restarting the beat bed. Reset controls restores the selected source preset BPM and levels plus zero pitch while leaving the current mode, beat choice, combo length, and playback state intact.

For imported INIs, the UI exposes the native seven editable sample fields and a separate session-only TTM guide selector in the selected sample editor. A row save validates through the domain writer and updates only in-memory sample data, clearing the generated combo so it must be regenerated. Save Sample Data patches the original INI text, preserving unchanged comments, order, unknown keys, stable row IDs, recorded BPM01, beat references, and source paths while including current sample and beat levels; guide selections remain outside that patch. The output is a user-selected Save As target or a `*-edited.ini` download fallback. The source file is never implicitly opened for writing.

## Custom beat boundary

Custom WAV and MP3 beats are independent of the scratch-sample preset and its asset-resolution index. Preset and Custom source modes are mutually exclusive: inactive controls are disabled and each mode retains its previous selection. Custom without an applied file uses no beat rather than playing a hidden preset source. A file is analyzed locally as a candidate; the user reviews or corrects its recorded BPM and explicitly applies it. The current beat remains selected until application succeeds. Files and decoded buffers are session-only, are not uploaded, and are excluded from legacy INI exports. Replacement and recorded-BPM editing are locked during playback; target tempo, pitch, gains, and Reset remain live.

Analysis uses at most the first 120 seconds and can report an estimate, an ambiguous rhythm, or insufficient rhythmic evidence. Manual BPM is available for all outcomes. Input is bounded to 64 MiB, ten minutes, and 60 million decoded channel samples, with container preflight and decoded-buffer checks. These limits bound supported input and do not guarantee a browser's internal decoder allocation.

The transport accepts a separate beat reference BPM. Scratch events use the preset's recorded BPM; a custom beat uses its confirmed recorded BPM. When those references differ, separate SoundTouch paths apply matching source/processor rates to keep each layer's tempo and pitch controls independent. The target practice tempo stays within the intersection of each source's supported 0.5–2× range. Presentation timing retains the measured processor-delay estimate rather than claiming exact physical onset alignment.

Pause and physical onset accuracy remain unverified. The source preset and audio assets are not modified.

