# Scratch Combo

Scratch practice in your browser, based on the combo generator from the original Windows app. [Open the app](https://freshpete.github.io/scratch-combo-web/).

Choose a **Quick preset** in Practice, generate a combo, and press Play. **Loop** repeats the combo. **Q&A** plays it once, then leaves an answer window for you to play it back. Pause and Resume keep your place. Practice also has count-in, metronome, and automatic combo generation.

- **Session** has tempo, pitch, levels, tempo training, and custom WAV or MP3 beats. Check the estimated BPM by ear and use Manual beat trim to set the loop.
- **Samples** lets you edit sample settings and export a working INI.
- **Files** lets you import a legacy INI and its WAV folder.
- **Save and manage sessions** in Practice saves settings, the combo, and referenced audio in IndexedDB. Saves belong to this browser profile and site. No account or upload is required. Clearing site data removes the saves.

## Develop locally

Use Node.js 24.15+ on the 24.x line, or Node.js 26+.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`. To use the original built-in presets locally, install the checksummed media archive. [Preset setup and deployment](docs/hosting.md)

```sh
npm test
npm run test:e2e
npm run build:pages
npm run test:e2e:pages
```

Browser tests use installed Edge by default. Set `PLAYWRIGHT_CHANNEL=chrome` for Chrome. Browser artifacts belong in ignored test output directories.

## Project reference

App code is in [src](src/), browser tests and their configuration are in [e2e](e2e/), and the TypeScript build settings are in [config](config/).

- App structure, local storage, and playback contracts. [Architecture](docs/architecture.md)
- Recovered rules and differences from the Windows generator. [Generator contract](docs/generator-contract.md)
- Web Audio, beat analysis, and timing limits. [Audio engine](src/audio/README.md)
- Development-only scratch notation and sources. [TTM guides](docs/ttm-guides.md)
- Current follow-ups and historical test evidence. [Roadmap](docs/roadmap.md)
