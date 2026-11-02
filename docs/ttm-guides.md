# TTM guide annotations (local debug only)

This is a local-development debug feature. Production builds keep the TTM practice-guides choice visible but disabled with the label “Local debug only”; they always show the Waveform view and omit TTM assignment controls. Vite gates the feature with `import.meta.env.DEV` and exposes no production configuration switch.

The optional TTM view provides four small, source-attributed teaching guides for record movement and fader gating. The official [TTM basics](https://www.ttm-dj.com/ttm-01-01-basics/) describes time on the horizontal axis and record rotation on the vertical axis; forward movement rises, backward movement falls, and the baby/rub scratch moves in both directions without mixer cuts. Its forward-scratch description uses the fader to mute the return movement. The examples here are simplified shapes based on those textual descriptions.

These are **illustrative technique guides**, not transcriptions of the preset WAVs. The app does not infer record movement or crossfader position from PCM, waveform shape, file names beyond a few advisory aliases, or silence. It does not copy the original TTM charts. A per-sample `TtmSampleGuideSelection` is only a guide ID or the `UNTRANSCRIBED` sentinel. The UI keeps selections in the current browser session and resets them when the preset changes; they are not saved to the legacy INI or used by audio playback.

## Guide data

`src/notation/ttm-guides.ts` exports the immutable `TTM_GUIDES` catalogue and `getTtmGuide(id)`. Motion uses normalized `time` and `samplePosition` values in `[0, 1]`. The first and last points span time `0` through `1`, and each later point has strictly greater time, so a vertical instantaneous jump cannot be represented. In the SVG path helper, a greater sample position is drawn higher on the staff.

Fader intervals use normalized `start`, `end`, and `state` (`open` or `closed`). They partition the whole time range, in order, with no gaps or overlaps. Intervals use a shared boundary for an instantaneous fader change. The examples are:

| Guide | Record path | Fader gate |
|---|---|---|
| Baby / rub | Forward then backward triangle | Open throughout |
| Forward movement | One upward stroke | Open throughout |
| Backward movement | One downward stroke | Open throughout |
| Forward cut | Forward then backward triangle | Open on the forward half, closed on the return |

`validateTtmAnnotation` checks normalized ranges, increasing motion time, complete endpoints, fader interval coverage, and illustrative provenance. The explicit `UNTRANSCRIBED` marker means the user chose to show no guide for this sample in the current session. A silent sample is not a stationary-record or closed-fader rest; silence alone cannot distinguish those actions.

## Advisory name suggestions

`suggestedGuideForSampleName` returns a guide ID only for the finite display-name aliases `Baby`, `Baby(F)`, and `Baby(R)`. In TTM view, those aliases immediately display clearly labeled illustrative patterns: Baby/rub, forward movement, and backward movement. This is a suggestion based only on the exact sample label, not an audio transcription or recognition result. Other sample names display an explicit Unassigned marker and an Untranscribed label.

The sample editor shows an alias-derived suggestion without storing it as a session assignment. Choosing another guide stores that guide ID in the current session; choosing Untranscribed stores the explicit `UNTRANSCRIBED` marker and takes precedence over the alias. Assignments clear when the preset source changes and are never added to the INI or playback data.

## Source and limits

The movement directions, baby/rub definition, and forward-scratch fader behavior are based on the official [TTM basics and scratch descriptions](https://www.ttm-dj.com/ttm-01-01-basics/). These examples do not encode the full TTM score system, timing subdivisions, clicks, sample-bank changes, or every scratch technique. They are compact display aids only, with no claim about the sound or performance represented by any particular WAV.
