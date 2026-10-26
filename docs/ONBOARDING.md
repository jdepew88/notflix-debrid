# First-run setup

A new Notflix installation opens a guided setup at `/setup`. Every other page redirects there until
setup is complete, and setup cannot be restarted afterwards — later changes happen in
**Settings** (owner only).

## Before you start: the setup code

Anyone who can reach the server could otherwise claim it, so the first screen asks for a one-time
**setup code**. It is printed by the launcher, saved as `setup-code.txt` in the data folder
(`%ProgramData%\NotflixDebrid` by default) and filled in automatically when the launcher opens your
browser. It is deleted as soon as the owner account exists; from then on only the owner's sign-in
can continue or change setup.

## Step 1 — Server

| Setting | Default | Notes |
|---|---|---|
| Server name or address | empty | How other devices should reach this PC (e.g. `media-pc.local`, `192.168.1.20`). Used for displayed links. |
| Web port | `8420` | Saving a new port moves the running server there; the wizard follows automatically. The media engine uses `8421` on `127.0.0.1` only. |
| Allow other devices on my local network | off | Off = listens on `127.0.0.1` only. On = listens on all interfaces; your router is never touched. |
| Behind a reverse proxy | off | Only if a proxy (Caddy, nginx, Traefik…) terminates HTTPS in front of Notflix. Enables trust in `X-Forwarded-*` headers. Asks for the public `https://` address. |
| Media cache folder | `<data>\cache` | Disposable HLS segments. Must not be a drive root, the data/settings folders, or the program folder. |
| Maximum cache size | 10 GB | Oldest data is evicted first. |
| Data folder | shown read-only | Accounts, settings and credentials. To move it: stop Notflix, `scripts\notflix.ps1 move-data -To <folder>`. |

## Step 2 — Owner account

Username (2–32 characters), optional display name, password (8+ characters) and confirmation. This
account becomes the **owner**: the only account that can change system settings and credentials.
Passwords are stored as salted scrypt hashes (N=2¹⁷, r=8, p=1), never in plain text. Only one owner
can ever be created; concurrent attempts are serialized and all but one are refused.

If the owner already exists (e.g. you continue setup in another browser), this step asks you to
sign in as the owner instead.

## Step 3 — Metadata (TMDB) — required

Notflix uses **TMDB only** for the catalog, artwork, details, episode lists and age ratings. Create
a free key at <https://www.themoviedb.org/settings/api> and paste either the **API Key** (v3) or the
**API Read Access Token** (v4). Notflix checks it against TMDB before storing it; a rejected key is
never saved. No other metadata service (such as TVDB) is used by this edition, so none is asked for.

## Step 4 — Real-Debrid — required

Paste the API token from <https://real-debrid.com/apitoken>. It is validated with Real-Debrid
first; the wizard shows the account name and premium status, never the token. Streaming needs an
active premium subscription.

**Release search.** To find a title, Notflix asks a Stremio-compatible release index which files
exist and which are cached on Real-Debrid. Choose at least one:

| Source | Default | What it receives |
|---|---|---|
| Torrentio (`torrentio.strem.fun`) | on | your Real-Debrid API token, embedded in each request URL (that is how Torrentio checks the cache) |
| Peerflix (`peerflix.mov`) | off | your Real-Debrid API token, likewise |
| Custom addon | off | everything in the URL you provide (must be `https://`) |

These requests come from the server; browsers and TVs never see the token or the addon URLs.

## Step 5 — Hardware acceleration

The media engine reports what it found **and what it actually tested** on this computer:

- operating system and architecture, FFmpeg and FFprobe versions and paths;
- graphics adapters (virtual adapters such as remote-desktop drivers are ignored);
- per acceleration method: **Working** (a real test encode succeeded), **Test failed** (detected,
  but the test did not work — the note says why), or **Not available**; per codec ✓/✗ for encode
  and decode.

Choose **Automatic** (best tested option: NVENC → Quick Sync → AMF → VA-API → VideoToolbox), a
specific tested option, or **Processor only**. With several GPUs of the same kind you can pick one.
If a chosen option stops working later (driver update, card removed) Notflix falls back
automatically and shows why. See [HARDWARE-ACCELERATION.md](HARDWARE-ACCELERATION.md).

## Step 6 — Finish

A summary lists the server address(es), network exposure, administrator, TMDB and Real-Debrid
status, release sources, hardware in use, cache and data folders. **Finish setup** is only enabled
when every requirement is met:

| Requirement | Why |
|---|---|
| Owner account | someone must own the server |
| TMDB connected | nothing can be browsed without it |
| Real-Debrid connected + a release source enabled | nothing can be played without it |
| Media engine running, FFmpeg and FFprobe found | needed for probing and any conversion |

After finishing you land on **Who's watching?**. Then:

- Try **Settings → Playback → Playback self-test** to watch the synthetic sample videos play in
  every mode on this hardware (no account needed).
- Add accounts for other people in **Settings → Accounts** (self sign-up is off by default).
- Enable LAN access when you want to watch on other devices.
