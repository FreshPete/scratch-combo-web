# Generator contract

`generateLegacyCombo` is a deterministic domain function. It accepts a normalized preset, an explicit random source, and a raw tick budget. It returns raw-tick events plus requested, completed, and remaining counts and a terminal reason. It does not call Web Audio or read hidden global randomness. The synthetic demo is built separately by `buildPreviewFixture`.

## Selection behavior

- Imported sample durations remain integer `Sample16ths` values. Combo budgets are 64, 128, 256, or 512 raw ticks for 4, 8, 16, or 32 beats.
- Enabled rows enter the weighted selection order by normalized sort order, repeated by `SamplePlayFq`.
- The previous-row shortcut is checked before weighted selection. Its repeat-count check differs from the weighted same-row path.
- Non-silent rows alternate direction. A silent previous or candidate row bypasses that direction alternation.
- Weighted candidates must fit the remaining tick budget. The generator stops when the remainder is below the minimum enabled sample duration, keeping that remainder as rest.
- A failed candidate selection restarts the combo with cleared events and selector state.

The browser random source quantizes draws to a 24-bit fraction and applies VB6 `Single` rounding at selection. This supports deterministic injected draw tapes, but it does not reproduce the original time-seeded VB6 random stream.

## Safety bounds

The web implementation rejects budgets above 512 raw ticks, allows at most 16 full-combo restarts, caps output at 8,192 events, and bounds candidate and zero-duration attempts. Exhausting a guard returns a typed failure without exposing a partial combo as complete.

Audio callers pass raw tick units with 16 ticks per beat. The returned partial fit retains the requested budget as trailing rest, and the playback timeline converts those raw ticks to seconds at the selected BPM.

The deterministic contract is covered by the domain tests in `src/domain/__tests__/`.
