# Architecture

```
 Browser / TV browser                         this computer
 ──────────────────────  HTTP(S)  ┌──────────────────────────────────────────────────────────┐
  Next.js UI (React)  ──────────▶ │ server.mjs  (Node 22)                                    │
                                  │   • listening address from config (127.0.0.1 by default) │
                                  │   • sets x-notflix-peer from the socket, local-only gate │
                                  │   • moves to a new port when the owner changes it        │
                                  │  Next.js 16 app: pages, API routes, proxy.ts             │
                                  │   auth · profiles · setup · config · catalog (TMDB)      │
                                  │   debrid provider (Real-Debrid) · release search addons  │
                                  │   playback orchestrator · authenticated media relay      │
                                  └───────────────┬──────────────────────────────────────────┘
                                   X-Engine-Key + single-use ticket, 127.0.0.1:8421
                                  ┌───────────────▼──────────────────────────────────────────┐
                                  │ Media engine (.NET 10, ASP.NET Core minimal API)         │
                                  │   ffprobe → decision → Direct Play | HLS fMP4 via FFmpeg │
                                  │   hardware detection (tests) · sessions · cache janitor  │
                                  └───────────────┬──────────────────────────────────────────┘
                                                  │ HTTPS range reads
                                                  ▼
                                   Real-Debrid CDN (*.download.real-debrid.com)
      <data> folder: config/ secrets/ db/ logs/ run/ cache/   (see CONFIGURATION.md)
```

## Web application (`src/`, `server.mjs`)

| Area | Where |
|---|---|
| Entry / listening | `server.mjs` (custom Next.js server) |
| Installation core (plain ESM, shared with the CLI) | `src/lib/install/{paths,store,config,secrets,init}.mjs`, `runtime.ts` (cached accessors), `status.ts` (requirements, summary, engine status) |
| Request gate | `src/proxy.ts` — first-run redirect to `/setup`, local-only check, session required for `/api/*` except `/api/auth/*`, `/api/health`, `/api/setup/*`, `/api/config/*` (those authorize themselves) and signed media links |
| Setup and configuration API | `/api/setup/{status,unlock,owner,complete}`, `/api/config/{server,metadata,debrid,hardware,summary}`, `src/lib/config-access.ts` |
| Accounts | `src/lib/users.ts` (JSON store under `<data>/db`, cross-process lock), `src/lib/auth.ts` (scrypt, viewer, roles), `src/lib/session.ts` (signed cookies), `/api/auth/*`, `/api/admin/users`, `/api/user/*` |
| Catalog | `src/lib/tmdb.ts`, `/api/catalog`, `/api/play/episodes`, maturity filtering in `src/lib/maturity-server.ts` |
| Debrid | `src/lib/debrid/{provider,real-debrid,index}.ts` (interface + Real-Debrid), low-level client `src/lib/real-debrid-api.ts`, link resolution `src/lib/torrentio.ts`, `src/lib/source-candidates.ts` |
| Release search | `src/lib/play-resolve.ts` (queries enabled Stremio-compatible addons), ranking `src/lib/source-ranking.ts` |
| Playback | `src/lib/playback-orchestrator.ts` (`POST /api/playback/start`), `/api/playback/sources`, relay `/api/playback/[id]/[...path]`, `src/lib/media-engine/{client,registry}.ts` |
| UI | `src/app/setup` (wizard), `src/components/setup` (panels shared with Settings), `src/app/settings`, `src/app/browse`, `src/app/watch/[id]`, `src/components/player` |

### First-run state machine

```
no owner, code unknown ──unlock(code)──▶ setup cookie ──PUT /api/config/server──▶ (server step)
          │                                    └──POST /api/setup/owner──▶ owner + session; code deleted
          ▼
owner session ──metadata (validated) ──debrid (validated) + sources ──hardware──▶ POST /api/setup/complete
          (refused until owner, TMDB, Real-Debrid, a source, engine, FFmpeg/FFprobe are all OK)
          ▼
setup.completed = true → /setup redirects away; /api/setup/* returns 409; Settings for changes
```

## Web ↔ engine contract (preserved from the original, extended)

- **Auth**: every engine request except `/health` carries `X-Engine-Key: <data>/secrets/engine-secret`.
- **Ticket** (`mintTicket`): `base64url(JSON{v,owner,exp(60s),nonce,src})` `.` `base64url(HMAC-SHA256)`; single use; `src` = `{kind:"url"|"file", url|path, provider:"real-debrid"|"sample", fileName, title}`.
- `POST /sessions {ticket, client, preferences, audioIndex, subtitleIndex, startSeconds}` → session view incl. a per-session `token` (kept server-side in the registry). Later calls send `X-Session-Token` and `X-Owner`.
- `GET /sessions/{id}`, `/status?position=`, `/metrics`, `/manifest?generation=`, `/segments/{gen}/{file}`, `/stream` (Direct Play, ranges), `/subtitles/{index}?from=`, `POST /seek`, `POST /tracks`, `DELETE /sessions/{id}`.
- `POST /probe {ticket}` → verified container/codecs/languages without starting a stream (source picker).
- `GET /capabilities[?refresh=true]` → original fields plus `platform`, `ffmpeg`, `ffprobe`, `adapters[]`, `backends[]` (`verified|detected|unsupported`, per-codec encode/decode results, notes), `selection {requested, effective, device, fallbackReason}`, `software`, `cache`.
- `POST /config {maxConcurrentVideoTranscodes, maxTranscodeHeight, hardwareAcceleration, hardwareDevice, cacheMaxBytes, maxAheadSeconds}` — runtime changes; the web app also persists them to `engine.json`.
- The engine reads `NOTFLIX_DATA_DIR` → `config/engine.json` + `secrets/engine-secret`; env vars override (see CONFIGURATION.md). It refuses to start without a secret and with an unsafe cache folder.

The browser only ever sees `/api/playback/<sessionId>/…` URLs; the relay checks that the signed-in
account owns the session (or a short-lived signed capability link for Chromecast).

## Media engine (`services/media-engine`)

| Area | Files |
|---|---|
| Startup, routes, auth middleware | `Program.cs`, `Api/Views.cs` |
| Configuration | `EngineConfig.cs`, `EngineOptions.cs` |
| Probing | `Media/MediaProber.cs`, `Media/MediaProbe.cs`, `Media/Languages.cs` |
| Hardware | `Media/HardwareCapabilities.cs` (parallel detection with real test encodes/decodes), `Media/HardwareBackends.cs` (catalog, auto-selection), `Media/GpuAdapters.cs`, `Media/HostPlatform.cs`, `Media/FfmpegLocator.cs` |
| Decisions | `Playback/PlaybackDecider.cs` (pure, unit-tested), `Playback/Models.cs` |
| FFmpeg | `Playback/FfmpegArgsBuilder.cs` (argument lists per backend), `Playback/TranscodeJob.cs` (process, progress, throttling, error classification), `Processes/*` (`IProcessRunner`, Job Objects on Windows) |
| Sessions | `Playback/SessionManager.cs`, `Playback/PlaybackSession.cs`, `Api/DirectStreamer.cs`, `Playback/CacheJanitor.cs` |
| Security | `Security/PlaybackTicket.cs`, `Security/SourceGuard.cs` |

## Audit of the original installation (what was found)

The private installation this edition was derived from was a single-user deployment:

- **Configuration** came from a repository `.env` (also walked up to and read by the engine) merged
  with `.data/settings.json`; credentials lived in both. The session-signing key fell back to the
  Plex token and then to a hard-coded development string; the engine and web defaulted to fixed
  ports 4119/4120; development origins listed a personal LAN address and domain.
- **Accounts**: open sign-up where the first sign-up became owner (racy under concurrency), with a
  claim-code flow for pre-role accounts; scrypt with default cost (N=2¹⁴) run synchronously.
- **Plex** was woven through ~40 files: library sync and database, Plex sign-in, Plex HLS/stream
  proxies, library-generated hero videos, Plex-first playback ordering, download bridging.
- **Hardware**: the engine detected only NVIDIA (`nvidia-smi`, `*_nvenc`, `*_cuvid`) and its decision
  ladder was NVDEC+NVENC → CPU+NVENC → x264; the web app also had legacy in-process FFmpeg routes
  hard-coding NVENC.
- **TVDB** was only used to fill episode gaps for Plex library shows.
- **Release search** used Torrentio by default (token embedded) and optionally Peerflix.

All of the above was generalized or removed as described in this repository's docs; the engine's
proven playback behaviour (decisions, HLS generations, seeking, throttling, subtitles, source
switching, diagnostics) was kept and extended.

## Tests

| Suite | Command | Covers |
|---|---|---|
| Engine unit (126) | `npm run engine:test` | decisions incl. every backend, FFmpeg arguments, tickets, SSRF guard, fMP4/playlist parsing, config loading, cache janitor safety, hardware detection for NVIDIA/Intel/AMD/VA-API/VideoToolbox/no GPU/no FFmpeg (**simulated**, labelled `Category=Simulated`) |
| Web unit (63) | `npm test` | install paths/config/secrets/setup code/locks, cache-folder safety, full setup flow through the real route handlers (simulated TMDB/RD responses), concurrent owner creation, sign-up policy, roles, scrypt + legacy hash upgrade, sessions, signed URLs, settings validation, source ranking, languages, genres |
| Fresh install E2E (40 + 6) | `scripts\notflix.ps1 test -Integration` or `node scripts/test-install-e2e.mjs` | a real server on throwaway data: setup code, owner race, real TMDB/RD rejection of bad credentials, real hardware report, owner-only config, sign-up closed, Direct Play / remux / audio-only / video transcode with every verified backend and software through the authenticated relay (ffprobe-checked), session termination, cross-account and anonymous refusal; restart persistence |
| Engine matrix (35) | part of `-Integration`, or `npm run test:engine` | real FFmpeg: codec matrix, 10-bit, HDR tone mapping, seeks, throttling, cancellation, network drop, expired links, AMF forced run |
| Browser (Playwright) | `scripts\notflix.ps1 test -Browser` | UI flows in real Chrome on a pre-configured throwaway instance; catalog/detail tests need a real TMDB key (`NOTFLIX_TEST_TMDB_KEY`), live Real-Debrid tests need `NOTFLIX_TEST_RD_TOKEN` + `E2E_LIVE_DEBRID=1` |
| Windows launcher processes & persistence | `node scripts/test-windows-launcher.mjs` | two installations built in throwaway folders, driven only through the `.cmd` launchers: onboarding once, stop/start/restart without `-DataDir` (remembered folder), status, lost PID records, stale PID records naming unrelated processes, servers from older launchers, two data folders from one app folder and two installations at once, unavailable/damaged data folder (recovery error, nothing created), explicit new data folder, LAN discovery (announced on the actual web port while running, withdrawn on stop, re-announced on restart and after a port change; never the engine port or an unfinished setup); the OS default data folder is never opened |
| Windows install & onboarding | `node scripts/test-windows-install.mjs` | a fresh copy in a path with spaces/parentheses: `Setup-Notflix.cmd` twice (no reinstall), simulated missing tools / missing WinGet, `Start-Notflix.cmd` port conflicts, browser address, no duplicates, launcher lock, restart, interrupted setup resumed in real Chrome, official credential links, invalid credentials, owner-only reconfiguration, key replacement, hardware changes, owner credential warning, leak checks, `Stop-Notflix.cmd` with an active conversion, unrelated processes untouched |
| Live Real-Debrid | `node scripts/test-live-debrid.mjs <url> <account> <password>` | your configured server: search, link resolution, engine session, bytes flowing (public-domain film by default) |
