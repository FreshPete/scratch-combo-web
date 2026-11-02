# Browser validation: TTM guides, beat sources, and workspace navigation

> **Production gate update (2026-11-02):** TTM guides are development-only. The current Pages preview disables the “TTM practice guides — Local debug only” radio, always renders waveforms, and omits guide assignment controls. Results, coverage notes, and production TTM screenshots below are historical pre-gate evidence. The current gate passed a focused production Pages check in Edge and Chrome (1/1 each); the existing development browser test still passes (1/1 Edge).

## Results

- Full unit suite: **182/182 passed** across 14 files.
- Focused local browser E2E: **6/6 passed in Edge** and **6/6 passed in Chrome** for WAV and MP3 custom beats, Custom-first review/apply, TTM guide behavior, workspace navigation/playback, and shortcuts/help.
- Final GitHub Pages production preview: **1/1 passed in Edge** and **1/1 passed in Chrome** on the build with the final workspace icons and responsive layout.
- Production layout checks cover 390, 844, and 1280 pixel widths, with “About this preview” both collapsed and expanded. Quick preset, help copy, and Practice controls remain in separate rows; timeline caption items do not overlap; the page has no horizontal overflow.

## Coverage

- The Pages preview loads the built-in **85 BPM Beginner** preset and its 64 sample references and 2 beat files. TTM is enabled and visible in production. Exact labels suggest guides, `Baby Fade` stays Unassigned, and session-only assignment plus explicit Untranscribed work without changing the source INI.
- Grid and Inline both display SVG motion strokes, fader intervals, the TTM key, active cue, and advancing playhead. Browser instrumentation confirms switching Waveform/TTM or Grid/Inline does not restart the beat source. The production check also verifies the motion path's visible stroke and bounding box, the open/closed gate geometry, and Pages-prefixed asset and AudioWorklet requests.
- Workspace checks cover direct hashes, browser Back/Forward including an empty hash, arrow-key tab activation and focus, shared Play/Stop while switching tabs, and preservation of the generated event set.
- Shortcut checks cover P/G/R, the enable/disable option, help dialog focus and close behavior, and guards for inputs, buttons, selects, modifiers, and repeated keys.
- Custom-beat checks cover WAV and MP3 uploads, candidate review without activation, explicit apply, playback locking, cached BPM retention, source switching without overlay or autoplay, and invalid-file preservation.

## Proof images

- Production Grid: [Edge](images/pages-production-ttm-grid-msedge.png), [Chrome](images/pages-production-ttm-grid-chrome.png)
- Production Inline: [Edge](images/pages-production-ttm-inline-msedge.png), [Chrome](images/pages-production-ttm-inline-chrome.png)
- Custom source selected before upload: [Edge](images/beat-source-custom-first-msedge.png), [Chrome](images/beat-source-custom-first-chrome.png)
- Custom beat live playback: [Edge](images/custom-beat-live-playback-msedge.png), [Chrome](images/custom-beat-live-playback-chrome.png)
- Production Session controls: [Edge](images/pages-production-session-controls-msedge.png), [Chrome](images/pages-production-session-controls-chrome.png)
