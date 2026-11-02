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

- INI and WAV files are read through the browser File API and remain in session memory; the application makes no upload request.
- Imported combos use recovered weighted, direction, and repeat selection rules; lengths use 16 legacy ticks per quarter-note beat, and each generated fixture retains the requested raw tick window.
- Browser random draws are quantized to 24 bits and do not recreate the original VB6 time-seeded stream. Web Audio follows an exact BPM clock rather than Windows timer intervals and jitter.
- The built-in demo uses a deterministic finite fixture. Imported combos default to Q&A practice: one combo cycle with sample audio, then one silent answer cycle. Large pause changes that to three silent answer cycles. Loop plays the same combo every cycle. Cycle playback continues until Stop, keeps any beat bed continuous, and advances the visible timeline through silent cycles.
- Automatic combo regeneration and repeat-count controls are not exposed; generated combos can be replayed in Q&A or Loop mode. Pause is not implemented. Zero-duration generated selections are omitted from the playable fixture and called out in the preview.
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
