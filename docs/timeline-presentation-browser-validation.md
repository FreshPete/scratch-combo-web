# Timeline presentation browser validation

## Results

- Grid and Inline geometry: **1/1 passed in Edge**. The check covers a 32-event synthetic combo, shared BAR/BEAT/event positions, lane and inline dimensions, the first-viewport transport, and horizontal clipping/sticky labels at 390, 844, and 1920 pixels.
- Presentation/playback journeys: **2/2 passed in Edge and 2/2 in Chrome** on the latest audio and UI source. The journeys cover active events in both layouts, Loop auto-generation at a complete-plan boundary, Q&A answer silence, Stop cleanup, and the imported 85 BPM Beginner preset.
- Across these focused runs: **5/5 browser test executions passed**. This was a targeted follow-up, not a rerun of the earlier full browser suite.

- Final integrated unit suite: **161/161 passed across 13 files**.
- Pages production build and project-path playback smoke: **passed**, including the built-in media and AudioWorklet.

## What was checked

The timeline's active sample, active row or inline segment, and playhead use the same `presentation.positionUnits` snapshot. Grid and Inline keep the same event fractions and BAR/BEAT positions. Switching views during playback changes only the presentation, and the beat source is not restarted.

For the synthetic 32-event fixture, Loop auto-generation replaces the plan after one complete round, retains one beat source across the boundary, and reports the new plan index. In Q&A, the answer window has no active sample or row while the playhead continues through silence. Stop clears the active event and playhead. Static Q&A omits the dynamic plan index.

The real-preset journey uses the local 85 BPM Beginner catalog entry. It verifies the built-in loads without autoplay, Play and Stop remain visible at 1280×720, and the active sample and playhead remain aligned in Grid and Inline.

These checks validate the browser's displayed cursor against the transport's estimated presentation clock. They do not claim physical speaker-onset accuracy; the output timestamp and DSP-delay limits are documented in [Audio processing](../src/audio/README.md#presentation-clock-and-finite-drain).

## Proof images

- [85 BPM active sample in Grid](images/timeline-grid-active.png)
- [85 BPM active sample in Inline](images/timeline-inline-active.png)
