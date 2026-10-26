# Installing Notflix Debrid on Windows

Notflix runs as two programs on your computer: a **web server** (what you open in the browser) and a
private **media engine** (converts video when a device can't play it). You never start them
separately: three double-click files do everything.

| File | What it does |
|---|---|
| `Setup-Notflix.cmd` | Checks for Node.js, the .NET 10 SDK and FFmpeg, offers to install what's missing, then builds Notflix. Run it once, and again after updating. |
| `Start-Notflix.cmd` | Starts Notflix and opens it in your browser: the setup wizard the first time, the normal sign-in page afterwards. |
| `Stop-Notflix.cmd` | Stops this Notflix installation (and only it). |
| `Restart-Notflix.cmd` | Stop + start. |
| `Status-Notflix.cmd` | Shows whether it runs: processes, address, data folder. Changes nothing. |

**Notflix provides no media** — no movies, shows or libraries. You bring two accounts of your own:
a free [TMDB](https://www.themoviedb.org/) account (for the catalog) and a paid
[Real-Debrid](https://real-debrid.com/) subscription (for playback).

## Requirements

- Windows 10 version 1809 or newer, or Windows 11, 64-bit.
- About 2 GB of free disk space for the program, plus the media cache (10 GB by default, adjustable).
- An internet connection during setup.
- A graphics card is **optional**. NVIDIA, Intel and AMD cards are used when they pass a real test on
  your computer; otherwise the processor converts video.

The installer takes care of the software below. You only need to know about it if something goes
wrong (see [Troubleshooting](#troubleshooting)).

| Software | Version | WinGet package |
|---|---|---|
| Node.js | 22 or newer (LTS) | `OpenJS.NodeJS.LTS` |
| .NET SDK | 10 | `Microsoft.DotNet.SDK.10` |
| FFmpeg + FFprobe | 6 or newer, full build | `Gyan.FFmpeg` |
| Git | optional, only to download/update with git | `Git.Git` |

The list lives in [`requirements.winget`](../requirements.winget) (a WinGet configuration file).

## 1. Download

**Easiest:** on <https://github.com/jdepew88/notflix-debrid> click **Code → Download ZIP**. Before
extracting, right-click the ZIP → **Properties** → tick **Unblock** (if shown) → OK. Extract it to a
folder you own, for example `C:\Users\<you>\Notflix` or `D:\Notflix`. Spaces in the path are fine.

**With Git** (makes updating easier):

```powershell
git clone https://github.com/jdepew88/notflix-debrid.git
```

## 2. Install: double-click `Setup-Notflix.cmd`

A window opens and:

1. checks your Windows version;
2. checks Node.js, the .NET 10 SDK, FFmpeg and FFprobe by running them — copies you already have
   (installed with WinGet, an installer, nvm, a ZIP on your PATH…) are used, never installed twice;
3. lists anything missing or too old and asks **Install now? [Y/N]**. Answer **Y** to install it
   with WinGet from its official source. Windows may ask for administrator permission (a UAC prompt)
   for Node.js and .NET; FFmpeg installs for your account only;
4. builds Notflix (installs the web packages, builds the media engine and the web app) and creates a
   few short synthetic test videos for the playback self-test. The first run takes several minutes.

The window stays open at the end so you can read the result. Running setup again is safe: tools that
are already there are left alone and unchanged packages are not reinstalled.

Setup only changes the execution policy for its own window (`-ExecutionPolicy Bypass` on that one
PowerShell process); your system's policy stays as it is. It does not change firewall or other
Windows settings.

## 3. Start: double-click `Start-Notflix.cmd`

The launcher:

- checks that setup was done (if not, it tells you to run `Setup-Notflix.cmd`);
- starts the media engine and the web server and waits until both answer;
- shows the address, e.g. `Notflix is running at http://localhost:8420`;
- opens your default browser — on **first-run setup** (with the one-time setup code filled in) until
  setup is finished, and on the **sign-in page** from then on;
- does nothing new if Notflix is already running (it just opens the browser again).

You can close the window afterwards; Notflix keeps running in the background until you stop it.

Then follow the setup wizard: [ONBOARDING.md](ONBOARDING.md). You'll need your TMDB key from
<https://www.themoviedb.org/settings/api> and your Real-Debrid token from
<https://real-debrid.com/apitoken> (the wizard has buttons for both).

## 4. Stop: double-click `Stop-Notflix.cmd`

It asks this installation's web server and media engine to shut down (active video conversions are
ended and their temporary files removed), and only forces them after a timeout. It never touches other
Node.js, .NET or FFmpeg programs.

Notflix keeps running after you close the window that started it. Stop, restart and status find its
processes from their command line (this folder's `server.mjs` / media engine and the data folder
they use), not only from the PID files in `run\`, so they work from any window later. A PID file
that names some other program is ignored and removed, never acted on.

## Everyday use

| Task | How |
|---|---|
| Start | `Start-Notflix.cmd` |
| Stop | `Stop-Notflix.cmd` |
| Restart | `Restart-Notflix.cmd` |
| Change settings, keys or the graphics card | in Notflix: **Settings** (owner) → **Run the setup wizard again** |
| Status, addresses, health | `Status-Notflix.cmd` |
| Recent log lines | `... scripts\notflix.ps1 logs` |

Logs are in `%ProgramData%\NotflixDebrid\logs` (`web.log`, `media-engine.log` and their `.err.log`).
They never contain your TMDB key or Real-Debrid token.

Options for `Start-Notflix.cmd` (from a command prompt in the Notflix folder):

| Option | Meaning |
|---|---|
| `-Port 8430` | use another web port (saved for next time) |
| `-EnginePort 8431` | use another port for the media engine (saved; always `127.0.0.1` only) |
| `-NoBrowser` | don't open the browser |
| `-DataDir D:\NotflixData` | use this data folder; it is remembered, so later starts, stops and restarts use it without `-DataDir` (to copy your data to a new folder: `scripts\notflix.ps1 move-data -To <folder>`) |

`Stop-Notflix.cmd`, `Restart-Notflix.cmd` and `Status-Notflix.cmd` also accept `-DataDir <folder>`
(for that run only). `Stop-Notflix.cmd -All` also stops servers started from this folder with
other data folders, or by an older launcher.

### Using Notflix from other devices

By default only this computer can open Notflix. To watch on a phone, tablet or TV browser on the
same network, the owner enables **Settings → Server & storage → Allow other devices on my local
network**. Notflix then shows the address to use (e.g. `http://192.168.1.20:8420`). Windows may ask
whether Node.js may communicate on **private** networks — allow private, not public. Notflix never
opens ports on your router. The media engine always stays private to this computer.

### Starting automatically

To start Notflix when you sign in, put a shortcut to `Start-Notflix.cmd` in `shell:startup`
(press Win+R, type `shell:startup`).

## Updating

1. `Stop-Notflix.cmd`
2. Download the new ZIP and extract it over the old folder, or run `git pull` in it.
3. `Setup-Notflix.cmd`
4. `Start-Notflix.cmd`

Accounts, settings and credentials live in the data folder (`%ProgramData%\NotflixDebrid`, or the
folder you chose with `-DataDir`), not in the program folder, so updates keep them. The program
folder only remembers which data folder it uses (`.notflix-data-dir`); keep that file when you
extract an update over the old folder.

## Uninstalling

1. `Stop-Notflix.cmd`
2. Delete the program folder.
3. Delete `%ProgramData%\NotflixDebrid` (accounts, settings, stored credentials, cache).
4. Optionally uninstall Node.js, .NET and FFmpeg (Windows Settings → Apps), if nothing else uses them.

## Troubleshooting

| Problem | What to do |
|---|---|
| **"Windows protected your PC"** or a security warning when double-clicking | The files came from the internet. Click **More info → Run anyway** (or **Run**), or unblock the ZIP before extracting (see step 1). |
| **WinGet is not available** | Setup lists download links instead. Install **App Installer** from the Microsoft Store (<https://aka.ms/getwinget>) and run setup again, or install the listed programs yourself: [Node.js LTS](https://nodejs.org/en/download), [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0), [FFmpeg full build](https://www.gyan.dev/ffmpeg/builds/). |
| **Installation cancelled / permission denied** | Node.js and .NET need administrator permission. Run setup again and accept the Windows prompt, or ask an administrator to install them. You don't need to run Notflix itself as administrator. |
| **"…installed, but this window cannot see it yet"** | Close the window and run `Setup-Notflix.cmd` again. If it persists, sign out of Windows and back in (the new PATH applies to new sessions). |
| **FFmpeg missing from PATH** | Run `Setup-Notflix.cmd` (it offers to install `Gyan.FFmpeg`). If you installed FFmpeg from a ZIP, add its `bin` folder to your PATH, then open a new window. The hardware step and Settings → Hardware show whether FFmpeg and FFprobe were found. |
| **.NET SDK missing** (only a runtime is installed) | Setup installs `Microsoft.DotNet.SDK.10`; the SDK, not only the runtime, is needed to build the media engine. |
| **Node.js too old** | Setup offers Node.js LTS. If your Node.js comes from **nvm** (or fnm/Volta), setup asks you to update it there instead (`nvm install lts`, then `nvm use lts`) so two copies don't conflict. |
| **"Port 8420, which Notflix uses, is taken by …"** | Another program (or a second Notflix) uses the port. Close it, or from a command prompt in the Notflix folder run `Start-Notflix.cmd -Port 8430`. For the engine: `-EnginePort 8431`. |
| **After a restart the browser shows the setup wizard again** | Notflix opened a different (empty) data folder than the one you set up. Run `Status-Notflix.cmd`: it shows the data folder in use and any other Notflix servers running from this folder. Stop them (`Stop-Notflix.cmd -All`), then start once with your folder: `Start-Notflix.cmd -DataDir "<your data folder>"`. It is remembered from then on. |
| **`Stop-Notflix.cmd` says "Notflix was not running" but Notflix still answers** | The server belongs to another data folder or was started by an older launcher; the stop window lists it (*Also running from this folder…*). Use the command it shows, or `Stop-Notflix.cmd -All`. |
| **"Notflix cannot open its data folder …"** | The remembered data folder is missing or damaged. Nothing was changed. Connect the drive or restore the folder and start again; or start with `-DataDir "<folder>"` to use another one. |
| **"Notflix is not installed yet"** | Run `Setup-Notflix.cmd` first (also after moving or updating the folder). |
| **"Notflix is running. Stop it first"** during setup | Run `Stop-Notflix.cmd`, then setup again. |
| **"Notflix is already starting in another window"** | Wait for the other window to finish. If none is open, wait three minutes or delete `run\launcher.lock` in the data folder. |
| **The browser didn't open** | Open the address shown in the window yourself (e.g. `http://localhost:8420`). The setup code is shown in the window and saved in `%ProgramData%\NotflixDebrid\setup-code.txt`. |
| **Graphics card shows "Test failed" / not detected** | Update the graphics driver, restart Notflix, then **Test again** in Settings → Hardware (or the setup wizard). Notflix uses the processor meanwhile; everything still plays. Remote-desktop and virtual adapters are ignored on purpose. |
| **"TMDB rejected the credential"** | Copy the whole key again from <https://www.themoviedb.org/settings/api> — either the API Key or the API Read Access Token. Nothing is saved until TMDB accepts it. |
| **Real-Debrid token rejected** / "not premium" | Copy the token again from <https://real-debrid.com/apitoken>. Streaming needs an active premium subscription. A working token is never replaced by one that doesn't work. |
| **Engine exits right away** | `scripts\notflix.ps1 logs`; look at `media-engine.err.log`. |
| **Forgot the owner password** | `Stop-Notflix.cmd`, then `powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 accounts reset-password <owner name>` prints a temporary password. |
| **Locked yourself out of LAN access** | On the server computer: `node scripts\notflix-cli.mjs allow-lan on`. |
