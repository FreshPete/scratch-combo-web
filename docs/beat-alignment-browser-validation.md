# Browser validation: manual beat cue and loop trim

## Results

- The integrated journey passed **1/1 in Edge (16.3s)** and **1/1 in Chrome (16.1s)** on 2026-11-02, using Node 24.22.2 and the final UI.
- The E2E uploads a generated 10-second mono WAV with a 1-second intro, a 120 BPM pulsed loop section, and a distinct tail. It sets a 1.000-second cue and a 3.000-second exclusive loop end.
- Native `AudioBufferSourceNode` instrumentation checks that `start` receives the rounded cue frame, `loopStart` matches that frame, and `loopEnd` matches the rounded end frame, using each browser's decoded sample rate. The decoded PCM is compared with snapshots from both decode and source start; no sample changed.
- An analyser on the live beat worklet output reports RMS above **0.001**. The same source remains active through Q&A auto-generation into the next combo, with no restart. Trim and source-selection controls are disabled during playback.
- The journey rejects a negative cue and an end before the cue, verifies independent values for two preset beats and the custom beat, saves and reloads the custom trim without autoplay, and checks Reset's full-clip behavior. It then removes `presetBeatTrimId`, `customBeatTrimId`, and `beatTrims` from the local saved payload to emulate an older v1 session; restore defaults to the full clip and stays stopped.
- The flow generated no cross-origin or mutating requests. The 390-pixel viewport had no horizontal overflow. These are browser viewport and Web Audio graph checks; no physical-device or external-speaker output was measured.

## Screenshots

The final UI evidence shows the open trim panel, waveform markers, cue/end fields, and actions at desktop and narrow viewport widths.

- [Edge, desktop 1280 × 900](images/beat-alignment/manual-cue-loop-trim-msedge-desktop.png)
- [Edge, mobile-width 390 × 844](images/beat-alignment/manual-cue-loop-trim-msedge-mobile.png)
- [Chrome, desktop 1280 × 900](images/beat-alignment/manual-cue-loop-trim-chrome-desktop.png)
- [Chrome, mobile-width 390 × 844](images/beat-alignment/manual-cue-loop-trim-chrome-mobile.png)

## Run

Final commands from PowerShell:

```powershell
$env:PATH = 'C:\Users\peter\source\repos\ScratchComboRecovery\tooling\node-24.22.2\node-v24.22.2-win-x64;' + $env:PATH
node --version
# Edge; PLAYWRIGHT_CHANNEL is unset and the local config defaults to msedge.
node_modules/.bin/playwright.cmd test --config .forge/playwright-beat-alignment.config.ts --workers=1
# Chrome.
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node_modules/.bin/playwright.cmd test --config .forge/playwright-beat-alignment.config.ts --workers=1
```

`node --version` returned `v24.22.2`. The ignored, workspace-local config serves the branch on `127.0.0.1:4181`; it leaves the existing ports in use and does not contact the hosted app. The test creates its WAV in memory and stores/reloads data only in the isolated browser context.
