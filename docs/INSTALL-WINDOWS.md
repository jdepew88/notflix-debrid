# Installing Notflix Debrid on Windows

This guide assumes nothing beyond a Windows 10/11 PC and an administrator-free user account.
Notflix runs as two programs on your computer: a **web server** (what you open in the browser) and a
private **media engine** (converts video when needed). The launcher starts and stops both.

Notflix provides no media. You will need a free [TMDB](https://www.themoviedb.org/) API key and a
premium [Real-Debrid](https://real-debrid.com/) account during setup.

## 1. Install the prerequisites

Open **PowerShell** and run:

```powershell
winget install OpenJS.NodeJS.LTS          # Node.js 22 or newer
winget install Microsoft.DotNet.SDK.10    # .NET 10 (builds and runs the media engine)
winget install Gyan.FFmpeg                # FFmpeg + FFprobe (full build)
winget install Git.Git                    # optional, to download and update Notflix
```

Close PowerShell and open a new window so the new programs are on your `PATH`. Check:

```powershell
node --version; dotnet --list-sdks; ffmpeg -version
```

A graphics card is **not** required. If you have one, keep its driver up to date; Notflix tests it
during setup and uses it only if a real test encode succeeds.

## 2. Get Notflix

```powershell
cd $HOME
git clone <repository URL> notflix-debrid
cd notflix-debrid
```

(Or download the source as a ZIP and extract it.) Keep it in a folder you own, e.g. your user folder.

## 3. Build it

```powershell
powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 setup
```

This checks the prerequisites, installs the web packages, builds the media engine and the web app,
generates a set of synthetic self-test videos (`test-media\`, test patterns only) and prepares the
data folder. It takes a few minutes the first time.

## 4. Start it

Double-click **`Start-Notflix.cmd`**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 start
```

The launcher starts the media engine and the web server, waits until both answer, prints the
address and the **setup code**, and opens `http://localhost:8420/setup` in your browser. Follow
[ONBOARDING.md](ONBOARDING.md).

Useful options:

| Option | Meaning |
|---|---|
| `-Port 8500` | use another web port (saved for next time) |
| `-NoBrowser` | don't open the browser |
| `-DataDir D:\NotflixData` | use another data folder for this run (see `move-data` to move permanently) |
| `-Dev` | run the Next.js development server (for contributors) |

## 5. Everyday use

| Task | Command |
|---|---|
| Start | `Start-Notflix.cmd` or `scripts\notflix.ps1 start` |
| Stop | `Stop-Notflix.cmd` or `scripts\notflix.ps1 stop` |
| Restart | `scripts\notflix.ps1 restart` |
| Status, addresses, health | `scripts\notflix.ps1 status` |
| Recent log lines | `scripts\notflix.ps1 logs` |
| Run the test suites | `scripts\notflix.ps1 test` (add `-Integration`, `-Browser`) |

Logs are in `%ProgramData%\NotflixDebrid\logs` (`web.log`, `media-engine.log` and their `.err.log`).

### Using Notflix from other devices

By default only this computer can open Notflix. To watch on a phone, tablet or TV browser on the
same network, the owner enables **Settings → Server & storage → Allow other devices on my local
network**. Notflix then listens on all network interfaces and shows the address to use (e.g.
`http://192.168.1.20:8420`). Windows may ask whether Node.js may communicate on **private**
networks — allow private, not public. Notflix never opens ports on your router; exposing it to the
internet is a separate decision covered in [SECURITY.md](SECURITY.md).

### Starting automatically

Notflix does not install a Windows service in this version. To start it at sign-in, create a
shortcut to `Start-Notflix.cmd` in `shell:startup` (press Win+R, type `shell:startup`).

## 6. Updating

```powershell
scripts\notflix.ps1 stop
git pull
scripts\notflix.ps1 setup
scripts\notflix.ps1 start
```

Your accounts, settings and credentials live in the data folder, not in the program folder, so
updates and re-installs keep them.

## 7. Uninstalling

1. `scripts\notflix.ps1 stop`
2. Delete the program folder.
3. Delete the data folder `%ProgramData%\NotflixDebrid` (this removes accounts, settings and
   stored credentials) and, if you moved it, your custom cache folder.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `Port 8420 is in use by another program` | `scripts\notflix.ps1 start -Port 8500` |
| `The media engine is not built` / `web app is not built` | run `scripts\notflix.ps1 setup` |
| Engine exits right away | `scripts\notflix.ps1 logs`; check `media-engine.err.log` |
| Hardware step says FFmpeg not found | install FFmpeg (`winget install Gyan.FFmpeg`), open a new PowerShell, restart Notflix |
| A GPU shows "Test failed" | update its driver, then **Test again** in the Hardware step; the processor is used meanwhile |
| Forgot the owner password | `scripts\notflix.ps1 stop`, then `scripts\notflix.ps1 accounts reset-password <owner name>` — prints a temporary password |
| Lost the setup code | it's in `%ProgramData%\NotflixDebrid\setup-code.txt` (only until the owner account exists) |
| Locked yourself out of LAN access | on the server: `node scripts\notflix-cli.mjs allow-lan on` |
| Firewall prompt for Node.js | allow **private** networks only, and only if you enabled LAN access |
