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

The timeline defaults to **Waveform** and draws envelopes from decoded, locally selected WAV files inside each event block. They use the preset reference tempo for their time scale: longer audio is clipped at the slot edge, and shorter audio leaves blank space after its end. Each sample gets a stable color used in its waveform and lane label; silent rows stay neutral. Missing or undecodable WAVs keep their normal event block without invented peaks. **TTM practice guides** is currently available only in local development while technique coverage is completed. Production builds disable the TTM choice and keep Waveform active. Locally it shows illustrative record movement and crossfader gating in Grid or Inline. Supported Baby-family and exact Chirp labels suggest a teaching pattern; other samples remain visibly unassigned. An explicit Untranscribed choice overrides a suggestion. Guide selections are session-only and are never saved into the INI or used to alter playback. These source-attributed examples are not audio analysis, WAV transcriptions, or a complete TTM score editor. See [the guide catalogue and conventions](docs/ttm-guides.md).

While audio is loading or playing (including sample audition), controls that change the preset, sample eligibility, combo length, mode, or generation cadence are locked. Stop unlocks them. Live tempo, pitch, gains, Reset controls, and the visual timeline-view switch remain available. Pause and native timer behavior are not implemented.

## Workspace and shortcuts

Use **Practice**, **Session**, **Samples**, and **Files** to focus on one task at a time. Quick preset is available in the main Practice sequence panel; Files contains custom INI and sample-audio imports. Play/Stop and playback status stay available across tabs. Changing tabs or switching Waveform/TTM or Grid/Inline changes the display without restarting audio.

Open **Keyboard shortcuts** for the available keys and the option to disable them: **P** toggles Play/Stop, **G** generates or builds a combo, and **R** resets the session controls. Shortcuts obey the same readiness and playback locks as the buttons and are ignored while typing or interacting with native controls.

## Import your sample preset

Choose **Your files…** from Quick preset, or open **Files**, to use the import wizard:

1. Select the legacy INI preset.
2. Select the folder containing its WAV files. **Choose files instead** provides a multi-file fallback.
3. Review the matched samples and beats, fix any required missing or ambiguous references, then choose **Load preset**.

The wizard stages the new setup while your current preset remains loaded. Back retains your draft; Cancel discards it. Loading does not start playback. If the default combo cannot be generated from the preset settings, the preset stays loaded so you can choose a compatible length or edit its samples before generating. Matched audio is copied into session memory. Samples eligible for generation are checked with the browser decoder before the new preset is applied; available beat files are checked too, and unavailable beats can be omitted. Inactive sample references may remain as review warnings. Files stay on your device and are never uploaded or changed. Unsaved imports clear when the page reloads; explicitly saved sessions and favourites can keep their own local audio copies. See [referenced-WAV limits](src/audio/README.md#referenced-wav-snapshots) for supported formats and batch bounds.

## Your own beat

In Session controls, choose **Preset** or **Custom** as the beat source. The inactive source controls are disabled. Custom activates the WAV/MP3 upload without replacing the selected scratch-sample preset; until a file is applied, it uses no beat. Switching sources retains the previous choices. The applied file stays in browser memory for the current session unless you save a session in Practice. Local BPM analysis offers an estimate; check it by listening and correct the recorded BPM when needed. Half-time and double-time readings are possible, and tracks with weak or changing rhythm may require a manual value.

The beat and scratch library retain separate recorded tempos and follow the same practice BPM. Tempo, pitch, and the separate beat/sample levels remain live controls. Beat replacement is locked during playback; Stop before choosing another file or returning to a built-in beat. Custom beats are not included in saved legacy INI files.

Open **Manual beat trim** in Session controls to set the first downbeat / loop start and an optional exclusive loop end in source seconds. The decoded waveform shows both markers when available, and the active beat name and source BPM stay visible for context. Apply saves the values for the next Play; **Reset beat trim** returns that source to the full clip. Each preset beat and the currently cached custom beat keep separate values while switching sources. Trim edits are locked during playback.

## Saved sessions and favourite combos

Practice keeps the session and favourite selectors beside the sequence timeline. Choose a saved session and **Load session**, or use **Reload last saved** after refreshing the page. Choose a favourite and **Load favourite combo** to restore its exact generated event sequence. These actions stop playback; press Play when ready.

Open **Save and manage sessions** to name a save, update the session you loaded, or choose **Save as new session** to keep the existing save and create another. A favourite stores the current preset and settings, exact combo, referenced WAV copies, any applied custom beat with its confirmed BPM, and the cue/loop regions for the preset and cached custom beat. Audio is decoded again when a saved item is loaded, saved trims are checked against decoded clip lengths, and no file handles are stored. Older version 1 saves without trim fields load with full-clip playback.

Saved data stays in IndexedDB for this browser origin and device; `localhost` and the hosted site have separate libraries. The library supports up to 12 sessions and 30 favourites, with 320 MiB per item and 512 MiB total. Browser storage may have a lower quota and may be cleared or evicted by the browser. Delete saved items from **Save and manage sessions**; unsaved imports still clear when the page reloads.

## Deployment

The project is configured for GitHub Pages at [freshpete.github.io/scratch-combo-web](https://freshpete.github.io/scratch-combo-web/). The Pages workflow builds and publishes the static app when changes are pushed to `main`. See [hosting and preset setup](docs/hosting.md) for deployment details and local preset setup.

## Checks

- `npm run test` runs application, domain, and audio unit tests with Vitest.
- `npm run test:e2e` runs Playwright browser checks. By default it uses the installed Microsoft Edge channel (`PLAYWRIGHT_CHANNEL=msedge`); set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. It does not require downloading a browser.
- `npm run build` performs strict TypeScript checks and creates the static build.
- `npm run build:pages` builds with the project-site path. Follow it with `npm run test:e2e:pages` to check the production preview, built-in media requests, and the AudioWorklet under `/scratch-combo-web/`.
