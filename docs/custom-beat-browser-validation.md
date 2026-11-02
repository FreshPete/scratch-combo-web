# Browser validation: local custom beat

## Results

- The focused E2E journey passed **2/2 in Edge** and **2/2 in Chrome** on 2026-11-02. The run covered the WAV workflow and a real MP3 fixture in both browsers.
- The coordinated root run also passed **177 unit tests** and the GitHub Pages production playback smoke. No broad baseline E2E suite was repeated.
- The browser decoded and analyzed both local files through the real Web Audio path. The BPM assertion allows a result within **5 BPM** of the generated 128 BPM tempo, or a plausible ambiguous candidate within that range. The journey then manually enters 128 BPM and applies it, so half-time ambiguity does not block use.
- The default 85 BPM Beginner scratch preset stayed selected with its 64 sample rows and built-in Beat 01 option after applying the custom beat. The test selects the built-in beat as a fallback and returns to the custom beat. An invalid WAV reports an error while the previously selected custom beat and Play action remain available.
- During playback, preset, combo, file, and beat-selection controls lock. Tempo, pitch, both levels, and Reset stay enabled. The test changes practice tempo to 126 BPM, pitch to +2 semitones, and both levels to zero, then resets to 128 BPM, neutral pitch, and the preset levels while playback continues.
- Audio graph checks show the scratch path at `128/85` (about `1.506`) and the custom beat path at `128/128` (`1.0`), with both pitch parameters at zero. Analyser taps on the live beat worklet output measured **220.7 Hz** for the 220 Hz source and **247.6 Hz** after +2 semitones (the target is about 246.9 Hz) in both browsers. This verifies the Web Audio graph output; it does not claim playback was measured from external speakers.
- The page had no horizontal overflow at 390, 844, or 1280 pixels. The WAV journey also confirmed it made no cross-origin or mutating requests during the local upload and playback flow.

The custom upload input is disabled while one analysis is running, so a concurrent-upload stale-result race cannot be triggered through the current UI. The invalid-file and prior-selection-retention path is covered.

## Proof images

- [Edge session controls with the WAV custom beat selected](images/custom-beat-live-playback-msedge.png)
- [Chrome session controls with the WAV custom beat selected](images/custom-beat-live-playback-chrome.png)

## Synthetic MP3 fixture

The fixture is a locally generated, 24-beat, 128 BPM click track with a 220 Hz tone. It is stored under `e2e/fixtures` only and is not part of the public preset catalog. Regenerate it with the pinned pure JavaScript encoder:

```powershell
npm install --prefix "$env:TEMP/custom-beat-mp3-generator" --no-save --no-package-lock lamejs@1.2.1
$env:CUSTOM_BEAT_LAMEJS_PACKAGE_DIR = Join-Path $env:TEMP 'custom-beat-mp3-generator/node_modules/lamejs'
node e2e/fixtures/generate-custom-beat.mjs
```

The test creates its WAV pulse directly in memory. Run the focused journey in each browser with Node 24 on `PATH`:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node_modules/.bin/playwright.cmd test e2e/custom-beat.spec.ts --output=test-results/custom-beat-qa --workers=1
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node_modules/.bin/playwright.cmd test e2e/custom-beat.spec.ts --output=test-results/custom-beat-qa --workers=1
```
