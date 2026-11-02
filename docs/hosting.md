# Hosting and preset setup

The app is published as a static site at [https://freshpete.github.io/scratch-combo-web/](https://freshpete.github.io/scratch-combo-web/). GitHub Pages serves the site from the public `FreshPete/scratch-combo-web` repository through GitHub Actions.

## GitHub Pages workflow

The deployment workflow runs on pushes to `main` and manual dispatch. It uses Node.js 24, installs from the lockfile with `npm ci`, runs the unit suite, downloads and verifies the preset archive, builds for the `/scratch-combo-web/` project path, then uploads and deploys `dist` with GitHub Pages Actions. Its permissions are limited to repository content read, Pages write, and the deployment identity token. No repository secrets are needed.

The build uses `VITE_BASE_PATH=/scratch-combo-web/` so the HTML entry point, application chunks, AudioWorklet processor, and built-in preset requests resolve beneath the GitHub Pages project path. Local development and the ordinary `npm run build` use `/` by default.

The build reads the public `built-in-presets.zip` asset attached to release tag `presets-v1`. The workflow checks its SHA-256 before extraction:

```text
f4371ff1ce632f944576cc7e97aa906858d2c2d367534bf307adc9160087775e
```

The archive contains `catalog.json`, six supported INI files, and 122 WAV files under the two catalog audio folders. It is extracted only into the ignored `public/private-presets/` directory; the archive is not committed to the source tree.

## Prepare local built-in presets

After checking out the public repository, use GitHub CLI and PowerShell to download the same public release asset, verify its hash, and extract it into the ignored public directory:

```powershell
$presetPackDirectory = Join-Path $env:TEMP 'scratch-combo-presets'
New-Item -ItemType Directory -Force -Path $presetPackDirectory | Out-Null
gh release download presets-v1 --repo FreshPete/scratch-combo-web --pattern built-in-presets.zip --dir $presetPackDirectory

$archive = Join-Path $presetPackDirectory 'built-in-presets.zip'
$expectedSha256 = 'f4371ff1ce632f944576cc7e97aa906858d2c2d367534bf307adc9160087775e'
$actualSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) { throw 'Preset archive SHA-256 did not match.' }

$destination = Join-Path (Get-Location) 'public\private-presets'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
```

Then run `npm run dev`. The app loads the built-in catalog and selected preset from the local development server. To check production behavior under the project path, run `npm run build:pages` followed by `npm run test:e2e:pages`.

## References

- [GitHub Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html)
