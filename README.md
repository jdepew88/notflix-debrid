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

## Quick start (Windows)

1. **Download** — on GitHub click **Code → Download ZIP**, then extract it (any folder; spaces are fine).
2. **Double-click `Setup-Notflix.cmd`** — it checks for Node.js, the .NET 10 SDK and FFmpeg, offers to
   install anything missing with WinGet (it asks first), and builds Notflix.
3. **Double-click `Start-Notflix.cmd`** — Notflix starts and your browser opens the setup wizard.
4. In the wizard, create your username and password, then paste your two keys. The wizard has a
   button for each official page:
   - TMDB API key: <https://www.themoviedb.org/settings/api>
   - Real-Debrid API token: <https://real-debrid.com/apitoken>
5. The wizard tests your graphics card automatically. Press **Finish setup** and start browsing.

`Stop-Notflix.cmd` stops it; `Start-Notflix.cmd` starts it again (straight to the sign-in page
once setup is done). No `.env` files to edit and no commands to type.

**With Git instead of the ZIP:** `git clone https://github.com/jdepew88/notflix-debrid.git`, then the
same double-clicks. Git is optional and only makes updating easier.

### What you need

| | |
|---|---|
| OS | Windows 10 (1809+) or 11, 64-bit |
| Software | Node.js 22+, .NET 10 SDK, FFmpeg + FFprobe. Setup installs them for you ([`requirements.winget`](requirements.winget)). |
| Graphics card | optional (NVIDIA, Intel or AMD are used when they pass a real test conversion; otherwise the processor) |
| Accounts | your own free TMDB account and your own premium Real-Debrid subscription |

Linux, macOS and Docker are on the [roadmap](docs/ROADMAP.md); the engine already understands
VA-API and VideoToolbox, but the launchers and packaging are Windows-only today.

Full instructions and troubleshooting: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) ·
the wizard step by step: [docs/ONBOARDING.md](docs/ONBOARDING.md).

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
Setup-Notflix.cmd          install prerequisites (WinGet) and build: setup.ps1 + requirements.winget
Start-Notflix.cmd          start web server + engine, open the browser (wizard until setup is done)
Stop-Notflix.cmd           stop this installation's web server and engine
scripts/notflix.ps1        launcher behind the .cmd files (setup/start/stop/status/logs/test)
scripts/notflix-cli.mjs    offline maintenance (paths, port, move data, account recovery)
```

## License and trademarks

Notflix is an independent project and is not affiliated with Netflix, TMDB or Real-Debrid. This
product uses the TMDB API but is not endorsed or certified by TMDB.
