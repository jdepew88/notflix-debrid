# Configuration and storage

Notflix separates three things:

| | Where | Contents |
|---|---|---|
| **Program** | the folder you cloned/extracted | source, builds, self-test samples. Replaceable on update. |
| **Data** | `%ProgramData%\NotflixDebrid` (Windows default) | accounts, profiles, settings, credentials, logs. Back this up. |
| **Cache** | `<data>\cache` by default, configurable | disposable media segments. Safe to delete while Notflix is stopped. |

Nothing that Notflix writes at runtime goes into the program folder (apart from the optional
`.notflix-data-dir` pointer described below), and no large media cache ever lives in the source tree.

## Choosing the data folder

Resolved in this order:

1. the `NOTFLIX_DATA_DIR` environment variable (the launcher's `-DataDir` sets it for one run);
2. the pointer file `.notflix-data-dir` in the program folder, written by
   `scripts\notflix.ps1 move-data -To <folder>`;
3. the OS default:
   - Windows: `%ProgramData%\NotflixDebrid`
   - Linux: `/var/lib/notflix-debrid` when writable (system service), else `$XDG_DATA_HOME/notflix-debrid`
     (`~/.local/share/notflix-debrid`)
   - macOS: `~/Library/Application Support/NotflixDebrid`
   - Docker (planned): a mounted volume passed as `NOTFLIX_DATA_DIR`

`move-data` requires Notflix to be stopped; it copies settings, credentials, accounts and logs to an
empty target folder, moves the default cache location with it, writes the pointer, and leaves the
old folder in place as a backup.

## Layout of the data folder

```
<data>\
  config\server.json      network, storage, setup progress, sign-up policy, provider status (no secrets)
  config\engine.json      media engine: port, hardware choice/device, transcode limits, library roots
  config\playback.json    server-wide playback defaults (resolution, quality, languages, buffering)
  config\instance-id      random ID of this installation (public: /api/health and the LAN announcement)
  secrets\secrets.json    session signing key, TMDB key, Real-Debrid token, custom addon URL
  secrets\engine-secret   shared key between the web server and the media engine
  db\users.json           accounts (scrypt password hashes, roles)
  db\users\<id>.json      profiles, My List, progress, watch history, preferences per account
  db\avatars\<id>\        uploaded profile pictures (re-encoded WebP)
  logs\                   web.log, media-engine.log (+ .err.log)
  run\                    PID files, listen-status.json, advertise-status.json, stop requests
  cache\engine\           HLS segments per playback session (default cache location)
  setup-code.txt          only until the owner account exists
```

On first start Notflix restricts the whole data folder to the account running it, `SYSTEM` and
`Administrators` (Windows ACL; `chmod 700` elsewhere). All JSON files are written atomically
(temporary file, flush, rename), so a crash or power cut cannot leave a half-written file; an
unreadable file is preserved as `*.corrupt-<time>` rather than overwritten.

## server.json

Edited through the setup wizard and **Settings → Server & storage**; safe defaults are applied for
anything missing or malformed.

| Key | Default | Meaning |
|---|---|---|
| `server.port` | `8420` | web port (1024–65535). Changing it while running moves the server to the new port. |
| `server.allowLan` | `false` | `false`: listen on `127.0.0.1` only and refuse non-local peers. `true`: listen on all interfaces. |
| `server.bindAddress` | `""` | with LAN access, a specific IPv4 address to listen on (default all interfaces) |
| `server.hostname` | `""` | name/address for displayed links |
| `server.reverseProxy` | `false` | trust `X-Forwarded-For`/`-Proto` (and `CF-Connecting-IP`) from a proxy in front |
| `server.publicUrl` | `""` | the proxy's public `https://` address |
| `server.name` | `""` | name shown on TVs and announced on the LAN ("" = this computer's name; up to 60 characters, no dots) |
| `server.advertise` | `true` | announce the server on the local network (mDNS/DNS-SD) while LAN access is on; see [LAN-DISCOVERY.md](LAN-DISCOVERY.md) |
| `storage.cacheDirectory` | `<data>\cache` | disposable cache root |
| `storage.cacheMaxGiB` | `10` | cache size limit (1–4096 GB) |
| `accounts.allowSignup` | `false` | let people create their own accounts |
| `debrid.sources` | Torrentio on | enabled release-search addons |
| `setup.*`, `metadata.*`, `debrid.validatedAt` | | progress and validation markers |

## engine.json

| Key | Default | Meaning |
|---|---|---|
| `port` | `8421` | engine port, always bound to `127.0.0.1` (change with `Start-Notflix.cmd -EnginePort <port>` or `notflix-cli set-engine-port`) |
| `hardwareAcceleration` | `auto` | `auto`, `nvenc`, `qsv`, `amf`, `vaapi`, `videotoolbox` or `off` |
| `hardwareDevice` | `null` | adapter index for the chosen backend, or a Linux render node (`/dev/dri/renderD128`) |
| `maxConcurrentVideoTranscodes` | `3` | simultaneous video conversions |
| `maxTranscodeHeight` | `2160` | upper bound for converted output |
| `cacheDirectory`, `cacheMaxBytes` | from server.json | kept in sync automatically |
| `ffmpegPath`, `ffprobePath` | `null` | explicit FFmpeg binaries (otherwise found automatically) |
| `libraryRoots` | `[<program>\test-media]` | folders the engine may read local files from (self-test samples) |
| `allowedPrivateHosts` | `[]` | extra hosts the engine may fetch from even on private addresses |

Changes made in Settings are applied to the running engine immediately (`POST /config`) and saved
here for the next start. A new cache folder takes effect after a restart.

## Cache behaviour

- The engine writes a marker file in the cache root and only ever deletes inside `<cache>\engine`.
- Every ~30 s it measures the cache. Above the limit it removes segments of sessions that have ended,
  then the oldest segments that viewers have already passed — never the segment being written, never
  anything outside the cache, never following links or junctions.
- On start it removes session folders left over from a previous run.
- Notflix refuses cache folders that are a drive root, the data folder or any of its settings,
  credential or account folders (or a folder containing them), your home folder, or the program
  folder.

## Ports

| Port | Bound to | Purpose |
|---|---|---|
| 8420 | `127.0.0.1` (or all interfaces with LAN access) | web app and API |
| 8421 | `127.0.0.1` only | media engine (never expose it) |
| UDP 5353 | multicast `224.0.0.251` (with LAN access) | mDNS: announces the web port as `_notflix._tcp` ([LAN-DISCOVERY.md](LAN-DISCOVERY.md)); the engine port is never announced |

## Environment overrides

None are needed for normal use; they exist for development, services and containers.

| Variable | Effect |
|---|---|
| `NOTFLIX_DATA_DIR` | data folder |
| `MEDIA_ENGINE_URL` | web → engine address (default from engine.json) |
| `MEDIA_ENGINE_SECRET` | override the engine key file (both processes must agree) |
| `MEDIA_ENGINE_PORT`, `MEDIA_ENGINE_BIND` (loopback addresses only; anything else is refused), `MEDIA_ENGINE_TEMP_DIR`, `MEDIA_ENGINE_HWACCEL`, `MEDIA_ENGINE_MAX_TRANSCODES`, `MEDIA_ENGINE_CACHE_MAX_BYTES`, `MEDIA_ENGINE_LIBRARY_ROOTS`, `MEDIA_ENGINE_ALLOWED_HOSTS` | engine settings (override engine.json) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | FFmpeg binaries for the engine |
| `COOKIE_SECURE` | `true`/`false` to force the cookie `Secure` flag (default: per request) |
| `NOTFLIX_ADVERTISE` | `0`/`false` turns the LAN announcement off for this process regardless of the setting |
| `SIGNUP_RATE_LIMIT` | new accounts per address per hour (default 5) |

## Offline maintenance

`node scripts/notflix-cli.mjs` (also via `scripts\notflix.ps1`):

```
paths [--json]                       where everything lives
set-port <port>                      change the web port
set-engine-port <port>               change the media engine port (127.0.0.1 only)
allow-lan on|off                     allow / forbid other devices
advertise on|off                     announce / don't announce on the LAN (mDNS)
set-name [<name>]                    name shown on TVs (empty: this computer's name)
discover [--json]                    list Notflix servers announced on the local network
move-data --to <folder>              move the data folder (Notflix stopped)
accounts list
accounts reset-password <username>   temporary password, signs the account out everywhere
accounts set-role <username> admin|user
```
