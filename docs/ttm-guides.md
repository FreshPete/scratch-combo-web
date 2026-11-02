# TTM movement and fader guides

TTM is local-development only while the missing techniques and variants are reviewed. Production keeps the TTM choice disabled and omits guide assignment controls; users see Waveform. The existing local catalogue is intentionally preserved for further work.

The TTM view uses a small set of **illustrative practice guides**. They show record direction and whether the fader is open or closed; they are not transcriptions of the bundled WAVs and are not a complete TTM score editor.

The official [TTM basics](https://www.ttm-dj.com/ttm-01-01-basics/) describes a staff with time on the horizontal axis and record rotation on the vertical axis. Forward movement slopes upward, backward movement slopes downward, and a horizontal line means the record is stopped. A vertical line would represent movement in zero time, so this guide format rejects repeated time coordinates. The source defines a baby/rub as forward and backward record movement with no mixer cut, a forward scratch as similar movement with the return muted by a mixer control, and a chirp as forward/backward strokes cut at the direction change. The charts below are simplified examples based on those descriptions, with arbitrary normalized proportions rather than TTM beat subdivisions.

## Guide catalogue

`src/notation/ttm-guides.ts` exports the immutable `TTM_GUIDES` catalogue, `getTtmGuide(id)`, and `UNTRANSCRIBED`. Every guide carries illustrative provenance. Motion points use normalized `time` and `samplePosition` values in `[0, 1]`: time increases from `0` to `1`, and a higher sample position is drawn higher on the staff. Each path needs at least two finite points, strictly increasing time, in-range coordinates, and full endpoints. The SVG helper rejects invalid paths before creating a path string.

Fader intervals partition the same normalized time range in order, with no gaps or overlaps. `open` means the fader passes the sound; `closed` means the sound is muted. Adjacent intervals share the instant where the fader changes state.

| Guide | Record motion | Fader | Meaning |
|---|---|---|---|
| Baby scratch / rub | Forward, then backward | Open throughout | Both record strokes remain audible. |
| Forward movement | One forward stroke | Open throughout | Direction only; this is not a forward scratch/cut. |
| Backward movement | One backward stroke | Open throughout | Reverse direction, drawn downward from the segment end. |
| Forward scratch / cut | Forward, then backward | Open forward; closed on return | The return stroke is muted. |
| Chirp | Forward, then backward | Open on each stroke; a narrow closed notch at the turnaround | Shows a cut separating the two audible strokes. The notch width is illustrative, not a timing transcription. |

The forward-movement and forward-scratch guides are separate on purpose: an open forward stroke does not describe the muted return that defines the basic forward scratch. The official [simple scratches descriptions](https://www.ttm-dj.com/ttm-01-02-scratches/) cover other techniques too. This compact guide model does not encode exact click timing or the faster repeated fader events used by techniques such as transformers, so their names do not receive invented patterns.

## Sample-name suggestions

`suggestedGuideForSampleName` matches only a finite alias list after trimming edges, collapsing repeated whitespace, and ignoring case:

| Display-name spellings | Suggested guide |
|---|---|
| `Baby` | Baby scratch / rub |
| `Baby (F)`, `Baby F` | Forward movement |
| `Baby (R)`, `Baby Rev` | Backward movement |
| `Baby(F)`, `Baby(R)` | Compatibility spellings for the same forward/backward guides |
| `Chirp` | Chirp |

The six display-name spellings `Baby`, `Baby (F)`, `Baby F`, `Baby (R)`, `Baby Rev`, and `Chirp` appear in the built-in preset definitions. The compact parenthesis spellings are retained for compatibility with existing sample labels. A suggestion only comes from the display name and never assigns a guide by itself. Other names, including `Baby Fade`, `Chirp (Triplets 1)`, `Chirp (Transform Chirp)`, `Drag`, `Stab`, and `Flare`, stay unassigned because their name alone does not establish a specific record path and fader sequence. The app does not analyze PCM, waveform shape, or silence to infer a TTM notation.

The sample editor can store a guide ID or the explicit `UNTRANSCRIBED` marker for the current session. `UNTRANSCRIBED` carries no movement or fader data. Unknown names remain unassigned until the user chooses a guide. These selections are not saved to the legacy INI and do not affect audio playback.

## Provenance and limits

The guide provenance points to the official TTM basics page and states that each pattern is an illustrative teaching shape, not an official chart and not a transcription verified against sample audio. The examples do not encode measures, counts, note subdivisions, sample-bank changes, exact click timing, or the full fader notation. A sample name can suggest a useful basic movement example, but it is not evidence of how that sample was performed.
