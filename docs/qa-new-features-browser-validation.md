# Browser validation: waveforms, local TTM guides, and Auto-generate

> Historical results retained for reference. These counts and the production TTM-disabled claim predate the November 2026 workspace and Pages update. See the [current TTM and workspace validation](qa-ttm-beats-browser-validation.md) for the final results.

## Results

- Final unit suite: **149/149 passed** across 13 files.
- Earlier full E2E baseline: **22/22 passed** in Edge and **22/22 passed** in Chrome (44 browser cases total), including the private 85 BPM Beginner smoke.
- Final focused local-browser delta: **2/2 passed** in Edge and **2/2 passed** in Chrome for the TTM alias/colour journey and private 85 BPM colour, geometry, and playback journey.
- Final GitHub Pages production preview: **1/1 passed** in Edge and **1/1 passed** in Chrome. The check confirms the TTM option is visible but disabled with “Local debug only”, its sample editor field is absent, Waveform remains selected, and Play/Stop works.
- The production Pages build and the App plus colour focused tests passed. No full E2E rerun was made after this narrow gate/colour delta.

The private smoke used read-only local copies of the 85 BPM Beginner INI and WAVs. It verified local loading, distinct stable waveform colours, event-to-lane colour matching, colour stability after regeneration, Q&A playback, Stop, and that Play/Stop/Generate all fit in the 1280×720 first viewport. It also checked page overflow at 844 and 1280 pixels. Browser automation used only same-origin GET/HEAD requests and did not write to the source INI or WAVs.

## Feature coverage

- Waveform envelopes come from the selected WAV PCM and sit within their event slots. Silent, missing, and decoder-failed files retain their event slots without fabricated peaks; an old pending decode is ignored after the preset/file changes. A brighter stable per-sample palette now fills waveform peaks and matches each event to its lane swatch; silent rows remain neutral. The primary and session-control accents are brighter while the disabled production TTM option stays muted.
- Shared BAR/BEAT/sample tracks remain aligned. The seven-width geometry sweep at 390, 640, 800, 1024, 1280, 1600, and 1920 pixels, including left, middle, and right timeline scroll positions, passed before the final colour-only styling change. The focused final delta checked no page overflow at 844 and 1280 pixels.
- TTM practice guides are available only in local development builds. On the hosted production build the option is disabled, marked “Local debug only”, the waveform view stays active, and TTM guide editors/rendering are omitted. In local development, the four guides are illustrative examples rather than audio transcriptions. Exact Baby, Baby(F), and Baby(R) sample labels suggest defaults; unknown names remain Unassigned and an explicit Untranscribed choice overrides a suggestion. Annotations stay in the browser session, saved INI text has no TTM fields, playback does not restart its beat source, and the playhead continues.
- Auto-generate defaults off with a count of two. The 1/2/4/8 options are selectable. Bounded real-clock journeys verify Loop ×2, Q&A ×1, and Large Pause Q&A ×1 switch from the Alpha fixture to Beta only at the complete-round boundary (reported at cycles 3, 3, and 5 respectively). Each plan keeps a single timeline/bar/ruler and one continuous beat source.
- During audio loading and playback, Auto-generate, its count, mode, pause, combo length, Generate, preset selection, and sample editing lock. Stop remains available; live tempo, pitch, levels, and Reset remain enabled; Stop unlocks the structural controls.

The real-clock cadence journeys use a local synthetic 600 BPM preset to keep the sample window short. The 4- and 8-round controls are verified as options, not played through every mode combination; the transport's boundary arithmetic has its own unit coverage. No duplicate DSP frequency probe was added.

## Proof images

Public proof captures are stored beside this document:

- [85 BPM waveform grid](images/waveform-grid.png)
- [Local-development TTM guide example](images/ttm-grid.png) — Baby’s label-based guide suggestion is shown; this view is disabled in production.
- [Production TTM gate](images/pages-production-ttm-gated.png) — the hosted build shows the disabled local-debug option with Waveform selected.
- [Production session controls](images/pages-production-session-controls.png) — brighter mixer sliders and Reset controls at 1280×720.
