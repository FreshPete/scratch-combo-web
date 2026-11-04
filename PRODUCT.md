# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, TypeScript, and Vite.

## Users

Scratch DJs practicing and shaping sample combinations in a local browser workspace.

## Product Purpose

Scratch Combo lets a user inspect a legacy-format sample preset, resolve its references to local WAV files, and generate and hear a combo using recovered legacy selection rules. The built-in demo remains a deterministic preview. Success means the imported setup is understandable, issues are visible, and a user can audition a sequence without sending local material anywhere.

## Positioning

A browser-only practice workspace that reads a built-in preset or the user's local preset and audio files, keeps imported files in the current session, and makes preview events visible as an ordered timeline.

## Operating Context

The current workspace targets Chrome and Edge on Windows 11. A user selects an INI file and either an audio folder or multiple WAV files, chooses a 4, 8, 16, or 32 beat combo length, adjusts session controls, inspects sample metadata, generates a combo, then plays or stops it.

## Capabilities and Constraints

- INI and WAV files are read through the browser File API and remain in session memory; the application makes no upload request. The Files tab stages an INI, then one audio folder (with a multi-file WAV picker as the alternative), then a review before Load. Drafts, invalid references, Back, and Cancel leave the active preset in place. Load commits the memory-backed WAV snapshots without starting playback.
- Review lists exact resolved paths and candidate matches. Missing or ambiguous references and failed decode checks for enabled audible samples block Load; inactive, silent, or otherwise ineligible sample references and optional beat beds remain visible without blocking it. Only WAVs referenced by the selected INI are copied into session memory. If a valid preset cannot produce the default 8-beat combo, it still loads without a fixture so the user can choose a compatible length or adjust sample settings before generating.
- The beat source is explicitly Preset or Custom, and playback uses only the selected source. A custom WAV or MP3 beat can be selected independently of the active sample preset. The browser estimates its BPM locally and asks the user to review or enter the recorded BPM before applying it; a new candidate does not replace the current beat until the user applies it. Ambiguous estimates are not presented as certain. The beat and scratch source BPM values remain separate, and the session tempo keeps both layers synchronized within their supported playback ranges. Switching source modes keeps the previous preset choice and accepted custom file in the open session; custom beat files and decoded audio are never uploaded.
- Session controls include a collapsed Manual beat trim disclosure for the selected beat. Users can set a first-downbeat / loop-start cue and optional exclusive loop end in source seconds, bounded by the decoded clip length, with a compact waveform and source BPM context when available. Apply takes effect on the next Play; Reset beat trim restores the full clip. Trim settings are kept per beat and custom upload, survive switching the active source, and are locked during playback. No beat is detected automatically and trim values do not alter the source media.
- Imported combos use recovered weighted, direction, and repeat selection rules; lengths use 16 legacy ticks per quarter-note beat, and each generated fixture retains the requested raw tick window.
- Browser random draws are quantized to 24 bits and do not recreate the original VB6 time-seeded stream. Web Audio follows an exact BPM clock rather than Windows timer intervals and jitter.
- The built-in demo uses a deterministic finite fixture. Imported combos default to Q&A practice: one combo cycle with sample audio, then one silent answer cycle. Large pause changes that to three silent answer cycles. Loop plays the same combo every cycle. Cycle playback continues until Stop, keeps any beat bed continuous, and advances the visible timeline through silent cycles.
- Practice playback offers an optional count-in of one or two four-beat bars, off by default, before a sequence starts. Count-in clicks happen before any sample or selected beat audio; the first sequence event and trimmed beat start together at its end. An optional metronome, also off by default, can continue through fixture and silent cycles with an independent 0–100 click level and a four-beat accent. Stop and P stop during the countdown. The timeline remains at its starting position until the sequence begins; count-in and metronome settings are locked during countdown and playback, while click level stays live.
- Optional Auto-generate is off by default and prepares a fresh combo after 1, 2, 4, or 8 complete practice rounds (default 2). A Q&A round includes the full answer window; a Loop round is one pass. The visible fixture changes at a plan boundary. This is a browser practice cadence and does not claim native repeat-count parity. All-silent presets may use an empty WAV preload list; missing files for eligible audible samples block Auto-generate.
- Optional Tempo training is off by default and raises the current BPM by a whole-number step after each chosen group of complete practice rounds, clamps at the target, and holds there. Each Play starts from the current BPM. A Loop round is one pass; Q&A includes its full answer window; Large pause includes all three silent cycles. Count-in is outside the round. Training settings are separate from live progress; a manual BPM change cancels training for that run, and the next Play can arm the saved settings from the selected BPM if the target remains valid for both sources.
- The shared timeline defaults to Waveform and uses decoded PCM from selected local WAV assets. Envelope width follows source duration against the event slot at the preset reference tempo; long audio clips at the slot and short audio leaves blank time. Non-silent samples receive a stable display-name color shared by their waveform, event border/tint, and lane swatch; silent events remain neutral. Missing or failed audio decoding leaves the ordinary event block intact without invented peaks. TTM practice guides and their session-only assignment editor are local-development only while technique coverage is completed. Production keeps the TTM option visibly disabled and stays on Waveform. They show finite illustrative movement/fader patterns in the same grid; exact Baby, Baby (F), Baby F, Baby(F), Baby (R), Baby Rev, Baby(R), and Chirp labels may suggest an example by name only, and unknown labels are visibly unassigned. Explicit Untranscribed overrides suggestions. Nothing is inferred from audio, and guide selections are never native INI fields.
- The workspace has Practice, Session, Samples, and Files tabs. Play/Stop and playback status stay available while switching panels. Single-character P (play/stop), G (generate), and R (reset) shortcuts are enabled by default and can be turned off in Keyboard shortcuts.
- A user can explicitly save named sessions and favourite the exact current combo from Practice. IndexedDB keeps saved preset/settings/fixture state, playback-prep and tempo-training settings, per-beat trim regions, and copies of referenced WAVs or an applied custom beat on this browser origin; loading rechecks and decodes the local bytes, validates saved trim bounds against decoded lengths, stays stopped, and never autoplays. Older version 1 payloads without trim fields default to full-clip playback; missing count-in and metronome fields default off with click level 60; missing tempo-training settings default Off. Browser storage keeps configured target, step, and round cadence; transient trainer progress never replaces them. Saved browser data can be deleted from Practice and is separate between localhost and the hosted site.
- Structural controls that replace or alter the combo, beat source, sample settings, playback prep, tempo-training configuration, or manual beat trim are locked during loading, countdown, and playback, including sample audition. Stop unlocks them; BPM is fixed during count-in and live once the sequence starts. A manual BPM change during training stops the trainer for that run without stopping playback. Pitch, sample and beat gains, click level, Reset controls, and the timeline view remain live during playback. Zero-duration generated selections are omitted from the playable fixture and called out in the preview. Pause freezes playback or count-in. Resume continues from that position.
- Sample enabled states and session playback settings can be adjusted for the current session; the source INI and WAV files are not rewritten.
- The source checkout excludes built-in preset media; the Pages workflow downloads the checksummed preset archive during the build. No external fonts or runtime services are required.

## Evidence on Hand

Architecture, generator contract, hosting, and local setup are documented under `docs/`. The interface is a new implementation; it does not reproduce or claim equivalence with the inactive legacy UI.

## Product Principles

- Keep the user's files on their device.
- Make each sequence event and its sample identity easy to inspect.
- Surface missing or ambiguous asset references where the user can resolve them.
- Label recovered generator behavior and remaining playback differences honestly.

## Accessibility & Inclusion

Use semantic, labelled controls; keyboard-accessible file pickers; visible focus; concise live status announcements; and responsive layouts that preserve the sequence and table information.
