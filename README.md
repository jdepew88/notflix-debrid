# Notflix Debrid

A self-hosted, Netflix-style streaming app for your own computer. It shows a catalog from
[TMDB](https://www.themoviedb.org/), finds releases that are cached on **your own Real-Debrid
account**, and plays them in the browser through a local media engine that only converts what a
device can't play directly — using whatever graphics hardware you have, or none at all.

> **Notflix provides no media.** It ships with no movies, shows, libraries or accounts. You need your
> own TMDB API key and your own Real-Debrid subscription, and you are responsible for having lawful
> access to anything you watch.

## What you get

- **Guided first-run setup** in the browser: server address and network access, the owner account,
  TMDB, Real-Debrid, and a hardware check that *tests* each acceleration option on your machine.
- **Browse** trending, popular and genre rows, search, title details with seasons and episodes,
  My List, Continue Watching and "Because you watched".
- **Profiles** per account (avatars, kids profiles with maturity limits, optional PINs), per-profile
  audio and subtitle language preferences, resume and watch history.
- **Smart playback**: Direct Play when the browser can decode the file, otherwise the cheapest
  conversion — repackaging without re-encoding, audio-only conversion, and only as a last resort a
  video conversion on NVIDIA (NVENC), Intel (Quick Sync), AMD (AMF), Linux VA-API, Apple
  VideoToolbox or the processor. Change release, audio and subtitles mid-play; seeking; stream
  diagnostics.
- **Private by default**: listens on `127.0.0.1` until you allow your local network; credentials stay
  on the server and are never sent to browsers, phones or TVs.

## Requirements (Windows, the supported platform for now)

| | |
|---|---|
| OS | Windows 10 or 11, 64-bit |
| [Node.js](https://nodejs.org/) | 22 LTS or newer — `winget install OpenJS.NodeJS.LTS` |
| [.NET](https://dotnet.microsoft.com/) | .NET 10 SDK — `winget install Microsoft.DotNet.SDK.10` |
| [FFmpeg](https://ffmpeg.org/) | a full build with FFprobe — `winget install Gyan.FFmpeg` |
| Graphics card | optional (NVIDIA, Intel or AMD are used when they pass a test encode) |
| Accounts | a free TMDB API key and a premium Real-Debrid account |

Linux, macOS and Docker are on the [roadmap](docs/ROADMAP.md); the engine already understands
VA-API and VideoToolbox, but the launcher and packaging are Windows-only today.

## Quick start

```powershell
git clone <this repository> notflix-debrid
cd notflix-debrid
powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 setup   # checks tools, installs, builds
.\Start-Notflix.cmd                                                   # or: scripts\notflix.ps1 start
```

Your browser opens the setup wizard at `http://localhost:8420/setup` with the one-time setup code
filled in (it is also printed in the window and saved as `setup-code.txt` in the data folder).
Stop Notflix with `Stop-Notflix.cmd`.

Full instructions: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) · first-run walkthrough:
[docs/ONBOARDING.md](docs/ONBOARDING.md).

## Documentation

| | |
|---|---|
| [INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) | Installing, starting, stopping, updating, troubleshooting |
| [ONBOARDING.md](docs/ONBOARDING.md) | Every setup step explained |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Data folder layout, settings files, ports, cache, environment overrides |
| [HARDWARE-ACCELERATION.md](docs/HARDWARE-ACCELERATION.md) | GPU support, how it is tested, fallbacks |
| [SECURITY.md](docs/SECURITY.md) | Credentials, accounts, network exposure, threat model |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Web app, API, media engine and their contracts; tests |
| [ROADMAP.md](docs/ROADMAP.md) | Linux, macOS, Docker, more debrid providers |

## Project layout

```
server.mjs                 web server entry (wraps Next.js; listening address, local-only gate)
src/app                    Next.js pages and API routes (setup wizard, browse, player, settings)
src/lib/install            data folder, configuration, credentials, first-start initialization
src/lib/debrid             debrid provider interface + Real-Debrid implementation
services/media-engine      .NET 10 media engine (probing, decisions, FFmpeg, HLS, hardware detection)
scripts/notflix.ps1        Windows launcher (setup/start/stop/status/test)
scripts/notflix-cli.mjs    offline maintenance (paths, port, move data, account recovery)
```

## License and trademarks

Notflix is an independent project and is not affiliated with Netflix, TMDB or Real-Debrid. This
product uses the TMDB API but is not endorsed or certified by TMDB.
