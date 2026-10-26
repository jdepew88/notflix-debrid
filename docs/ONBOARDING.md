# First-run setup

`Start-Notflix.cmd` opens the setup wizard in your browser the first time. Every Notflix page leads
there until setup is finished. Whether setup is finished is a single saved flag
(`setup.completed` in `config\server.json`): an owner account alone does not count, and once the
flag is set, restarting Notflix never shows the wizard again. Changes later happen in **Settings**
(owner only), which can run the same wizard again.

What you need: about ten minutes, a free [TMDB](https://www.themoviedb.org/) account and a paid
[Real-Debrid](https://real-debrid.com/) subscription. Notflix itself contains no movies or shows.

## If setup is interrupted

Close the browser or stop Notflix at any point; nothing is lost. Each completed step is saved on
the server. The next `Start-Notflix.cmd` opens the wizard again, and it continues with the first
unfinished step (after you sign in as the owner, if the owner account already exists).

## Welcome — the setup code

The first screen asks for a one-time **setup code** so that nobody else on your network can claim
your server. The launcher fills it in for you (it is also shown in the launcher window and saved as
`setup-code.txt` in the data folder, `%ProgramData%\NotflixDebrid`). It is deleted when the owner
account exists.

## Step 1 — Server

The defaults are right for most people: **Next**.

| Setting | Default | Notes |
|---|---|---|
| Server name or address | empty | How other devices should reach this PC (e.g. `media-pc.local`, `192.168.1.20`). Only used for displayed links. |
| Web port | `8420` | Saving a new port moves the running server there; the wizard follows. The media engine uses `8421` on this computer only. |
| Allow other devices on my local network | off | Off: only this computer. On: phones and TVs on your home network too. Your router is never changed. |
| Behind a reverse proxy | off | Only for advanced setups where Caddy/nginx/Traefik provides HTTPS in front of Notflix. |
| Media cache folder | `<data>\cache` | Temporary video pieces; safe to delete. Must not be a drive root or the data/program folder. |
| Maximum cache size | 10 GB | Oldest data is removed first. |

## Step 2 — Owner account

Choose a username and a password (8+ characters; a passphrase is best). This account **owns** the
server: only it can change settings and keys. You can add accounts for family members later.
Passwords are stored as salted scrypt hashes, never in plain text. Only one owner can ever exist.

## Step 3 — TMDB (movie and TV information)

TMDB provides titles, posters, descriptions, episodes and age ratings.

1. Press **Get your TMDB API key** — it opens <https://www.themoviedb.org/settings/api> in a new tab.
2. Sign in to TMDB, or create a free account. If TMDB asks, request a free developer key for personal use.
3. Copy your **API Key**, or the longer **API Read Access Token** — either works.
4. Come back to Notflix, paste it, and press **Save and continue**.

Notflix checks the key with TMDB first. If TMDB rejects it you see a short explanation and nothing is
saved. The key is never shown again (only its last four characters) and never sent to browsers.

## Step 4 — Real-Debrid

1. Press **Get your Real-Debrid API token** — it opens <https://real-debrid.com/apitoken> in a new tab.
2. Sign in to your Real-Debrid account.
3. Copy your private token. Treat it like a password.
4. Come back to Notflix, paste it, and press **Save and continue**.

Notflix checks the token with Real-Debrid on the server and shows whether it worked (with your
account name and premium status). Streaming needs an active premium subscription.

**Release search** (below the token). To find a title, Notflix asks a release index which files exist
and which are already cached on Real-Debrid. Keep at least one on:

| Source | Default | What it receives |
|---|---|---|
| Torrentio (`torrentio.strem.fun`) | on | your Real-Debrid token, in each request (that is how Torrentio checks your cache) |
| Peerflix (`peerflix.mov`) | off | your Real-Debrid token, likewise |
| Custom addon | off | everything in the `https://` address you provide |

These requests come from the Notflix server; browsers and TVs never see the token.

## Step 5 — Graphics card (hardware acceleration)

Most files play exactly as they are. Only when a TV or browser can't play a file does Notflix convert
it. This step shows, in one sentence, what will do that on your computer, for example *"Notflix will
use NVIDIA GeForce RTX 3060 (NVIDIA NVENC). It was tested on this computer and works."* — or that the
processor will be used.

Leave **Automatic** selected: it uses the best option that passed a **real test conversion** on this
computer (NVIDIA → Intel → AMD) and falls back to the processor if it ever stops working. **Processor
only** is always available. **Show test details** lists every option with ✓/✗ per format, the
graphics adapters found and the FFmpeg version. Nothing is claimed to work unless the test passed.
See [HARDWARE-ACCELERATION.md](HARDWARE-ACCELERATION.md).

## Step 6 — Finish

A summary shows the address, network access, owner, TMDB, Real-Debrid, release search, graphics card,
cache and data folder. **Finish setup** is enabled when everything required works:

| Requirement | Why |
|---|---|
| Owner account | someone must own the server |
| TMDB key accepted | nothing can be browsed without it |
| Real-Debrid token accepted + a release source on | nothing can be played without it |
| Media engine running, FFmpeg and FFprobe found | needed to read and convert video |

Anything missing has a **Fix** link to its step. After finishing you land on **Who's watching?**.

## Changing things later

As the owner: **Settings → System → Run the setup wizard again**. It is the same wizard without the
owner step. Your accounts, profiles, watch history and settings are kept:

- **Replacing a key or token:** paste the new one. It is checked first; if it is rejected, the
  current one stays. A working Real-Debrid token is not replaced by one without premium access.
  To keep the current value, press **Keep current key** (or just go on).
- **Graphics card:** **Test again** re-runs the hardware tests without changing other settings;
  choose a different option and save.

If a stored key stops working (for example a revoked token or an expired subscription), the owner —
and only the owner — sees a **"Notflix needs attention"** banner with a **Fix it** link to the right
step. Nothing is reset.
