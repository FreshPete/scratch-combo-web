# Scratch Combo

A browser-based practice workspace for local sample presets, synthetic previews, and generated combos. The app reads selected files in the browser and does not upload them.

## Run locally

Requirements: Node.js 24.15 or later in the 24.x line, or Node.js 26 or later.

```text
npm ci
npm run dev
```

The local development server is available at `http://127.0.0.1:5173/`. The source checkout omits built-in preset media. To load it locally, download the checksummed preset archive as described in [hosting and preset setup](docs/hosting.md), then restart the dev server. Custom INI and WAV imports work without that archive.

## Preview behavior

The built-in demo uses a deterministic fixed fixture and plays once. Imported presets use weighted, direction, and repeat selection rules to generate a combo. Length options of 4, 8, 16, or 32 beats map to 64, 128, 256, or 512 legacy ticks (16 ticks per quarter-note beat). Selection uses quantized 24-bit browser random draws; it does not reproduce the original VB6 time-seeded random stream. Browser playback follows the BPM clock in Web Audio, not the Windows timer interval or its jitter.

Generation is bounded to 16 outer restarts and 8,192 events; the selector also bounds candidate attempts. Errors are shown without presenting a partial combo as complete. Zero-duration selections are kept by the generator but omitted from the playable fixture, with an inline note when that happens. A generated combo can be built before WAV import; playback and sample audition require local audio for the selected non-silent samples.

Imported combos default to **Q&A**: sample audio plays for one full combo cycle, followed by one silent answer cycle. **Large pause** uses three silent answer cycles. **Loop** plays the combo on every cycle. Both modes repeat the current combo until Stop; the timeline and playhead remain visible during silent cycles, and a selected beat bed keeps playing. Tempo, pitch, sample level, and beat level can be changed live; Reset controls restores the selected preset’s BPM and levels and zero pitch without stopping playback. Sample parameters can be edited for the next generated combo and saved into a working INI copy using Save As (or the browser download fallback). The selected source INI and WAV files are never modified automatically. Automatic combo regeneration and repeat-count controls are not exposed yet. Pause and native timer behavior are not implemented.

## Deployment

The project is configured for GitHub Pages at [freshpete.github.io/scratch-combo-web](https://freshpete.github.io/scratch-combo-web/). The Pages workflow builds and publishes the static app when changes are pushed to `main`. See [hosting and preset setup](docs/hosting.md) for deployment details and local preset setup.

## Checks

- `npm run test` runs application, domain, and audio unit tests with Vitest.
- `npm run test:e2e` runs Playwright browser checks. By default it uses the installed Microsoft Edge channel (`PLAYWRIGHT_CHANNEL=msedge`); set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. It does not require downloading a browser.
- `npm run build` performs strict TypeScript checks and creates the static build.
- `npm run build:pages` builds with the project-site path. Follow it with `npm run test:e2e:pages` to check the production preview, built-in media requests, and the AudioWorklet under `/scratch-combo-web/`.
