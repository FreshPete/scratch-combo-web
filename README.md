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

Imported combos default to **Q&A**: sample audio plays for one full combo cycle, followed by one silent answer cycle. **Large pause** uses three silent answer cycles. **Loop** plays the combo on every cycle. Both modes repeat the current combo until Stop; the timeline and playhead remain visible during silent cycles, and a selected beat bed keeps playing. Tempo, pitch, sample level, and beat level can be changed live; Reset controls restores the selected preset’s BPM and levels and zero pitch without stopping playback. Sample parameters can be edited for the next generated combo and saved into a working INI copy using Save As (or the browser download fallback). The selected source INI and WAV files are never modified automatically.

**Auto-generate** is off by default. When enabled, it prepares a new combo after 1, 2, 4, or 8 complete practice rounds (default 2). A Q&A round includes the whole answer window; a Loop round is one full pass. The visible grid changes at the plan boundary, and any selected beat bed continues. This is a web practice cadence, not a claim of native repeat-count parity. An all-silent preset can run with no WAV preloads; unresolved files for eligible audible samples still block Auto-generate.

The larger timeline offers **Grid** sample lanes or an **Inline** sequence, with a shared beat scale. Both layouts highlight the active sample during playback and can be switched without restarting audio. The playhead and highlight follow an estimated output clock that accounts for measured processor delay; see [audio timing](src/audio/README.md#presentation-clock-and-finite-drain) for measurement limits.

The timeline defaults to **Waveform** and draws envelopes from decoded, locally selected WAV files inside each event block. They use the preset reference tempo for their time scale: longer audio is clipped at the slot edge, and shorter audio leaves blank space after its end. Each sample gets a stable color used in its waveform and lane label; silent rows stay neutral. Missing or undecodable WAVs keep their normal event block without invented peaks. **TTM practice guides** is a local-development debug view and is disabled in production builds. Its four illustrative record-motion and fader examples are not audio analysis or WAV transcriptions; exact `Baby`, `Baby(F)`, and `Baby(R)` sample labels suggest a guide only in local development, and other names are visibly unassigned. An explicit Untranscribed choice overrides a suggestion. Guide selections are session-only and are never saved into the INI; the examples are not a complete TTM score system.

While audio is loading or playing (including sample audition), controls that change the preset, sample eligibility, combo length, mode, or generation cadence are locked. Stop unlocks them. Live tempo, pitch, gains, Reset controls, and the visual timeline-view switch remain available. Pause and native timer behavior are not implemented.

## Your own beat

In Session controls, choose a WAV or MP3 beat without replacing the selected scratch-sample preset. The file stays in browser memory for the current session. Local BPM analysis offers an estimate; check it by listening and correct the recorded BPM when needed. Half-time and double-time readings are possible, and tracks with weak or changing rhythm may require a manual value.

The beat and scratch library retain separate recorded tempos and follow the same practice BPM. Tempo, pitch, and the separate beat/sample levels remain live controls. Beat replacement is locked during playback; Stop before choosing another file or returning to a built-in beat. Custom beats are not included in saved legacy INI files.

## Deployment

The project is configured for GitHub Pages at [freshpete.github.io/scratch-combo-web](https://freshpete.github.io/scratch-combo-web/). The Pages workflow builds and publishes the static app when changes are pushed to `main`. See [hosting and preset setup](docs/hosting.md) for deployment details and local preset setup.

## Checks

- `npm run test` runs application, domain, and audio unit tests with Vitest.
- `npm run test:e2e` runs Playwright browser checks. By default it uses the installed Microsoft Edge channel (`PLAYWRIGHT_CHANNEL=msedge`); set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. It does not require downloading a browser.
- `npm run build` performs strict TypeScript checks and creates the static build.
- `npm run build:pages` builds with the project-site path. Follow it with `npm run test:e2e:pages` to check the production preview, built-in media requests, and the AudioWorklet under `/scratch-combo-web/`.
