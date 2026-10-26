# Roadmap

This edition (phase 1) makes Notflix installable by anyone on **Windows** with any (or no) GPU. The
architecture was prepared for the following, which are not implemented yet.

## Linux (Debian, Arch)

Already in place: OS-aware data folder (`/var/lib/notflix-debrid` or `~/.local/share/notflix-debrid`),
POSIX permissions (`chmod 700`), engine adapter discovery via `/sys/class/drm` + `/dev/dri`, VA-API
probing and pipelines, NVENC/QSV/AMF paths, `/proc/stat` CPU monitoring, `IProcessRunner` mocks.

To do:
- a `notflix.sh` launcher (or a `notflix` CLI wrapper) mirroring `notflix.ps1`;
- systemd units: `notflix-engine.service` and `notflix-web.service` with a dedicated `notflix` user,
  `StateDirectory=notflix-debrid`, and `SupplementaryGroups=render video` for `/dev/dri` access;
- packaging: a Debian package and an AUR `PKGBUILD` (dependencies: nodejs ≥ 22, aspnet-runtime-10,
  ffmpeg);
- crash safety for FFmpeg children (Linux has no Job Objects: use `prctl(PR_SET_PDEATHSIG)` or a
  process group per session);
- real-hardware validation of VA-API (Intel iHD, AMD radeonsi) and NVENC on Linux.

## macOS

Already in place: data folder under Application Support, VideoToolbox detection and pipelines
(simulated tests only), `system_profiler` adapter discovery.

To do: a `launchd` agent, Apple Silicon validation, Homebrew FFmpeg discovery checks, code signing /
notarization questions for a packaged build.

## Docker

The previous single-container image only covered the web app and assumed a Plex/NFS setup, so it was
removed from this edition. Planned:

- one image with the web server and the engine (or two services in Compose), `NOTFLIX_DATA_DIR=/data`
  on a volume, cache on a separate optional volume;
- GPU variants: NVIDIA (`--gpus all`, NVIDIA Container Toolkit), Intel/AMD VA-API (`--device /dev/dri`);
- the setup code printed to the container log; health checks on `/api/health` and the engine `/health`;
- documented reverse-proxy examples.

## More debrid providers

Playback, source search and the engine only use the `DebridProvider` interface
(`src/lib/debrid/provider.ts`): account validation, release-addon URLs, resolving a release link to a
CDN URL, resolving a torrent from the account, and the CDN host allow-list the engine enforces.
Adding AllDebrid, Premiumize, TorBox, Debrid-Link… means implementing that interface, a settings
panel, and the provider's CDN suffixes in the engine allow-list — no player changes. Also planned:
Real-Debrid's OAuth device-code sign-in as an alternative to pasting an API token.

## Architecture phase 2

Planned separately (not part of this phase): reconsidering the web stack and merging the web API into
an ASP.NET Core host next to the engine; an Android TV client that talks only to the Notflix server
(never to Real-Debrid); a Windows service install for unattended start.

## Features removed in this edition

- **Plex** integration (library sync, Plex sign-in, Plex playback, Plex rows) and the local
  folder/NFS library scan that depended on it.
- **Downloads** (the Plex/Real-Debrid download dialog).
- **Library hero videos** (marquee clips generated from library files); TMDB trailers remain.
- The legacy in-process FFmpeg routes of the web app (all conversion goes through the engine).
- TVDB (it was only used to enrich Plex library shows).
