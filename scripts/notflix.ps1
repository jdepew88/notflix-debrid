<#
.SYNOPSIS
  Notflix Debrid launcher for Windows: installs, starts, stops and checks the web server and the
  media engine.

.DESCRIPTION
  setup     Check prerequisites (Node.js, .NET, FFmpeg), install packages, build everything.
  start     Start the media engine and the web server, wait until both are healthy, open the browser.
  stop      Stop both (gracefully, then forcefully after a timeout).
  restart   stop + start.
  status    Health, addresses, data folder, hardware summary.
  logs      Show the end of each log file.
  test      Run the unit test suites (engine + web). -Integration adds a fresh-install run with real
            FFmpeg/hardware on throwaway data; -Browser adds the Playwright suite.
  move-data Move accounts/settings/credentials to another folder (-To <folder>; Notflix stopped).
  accounts  Offline account recovery: list | reset-password <name> | set-role <name> admin|user

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 setup
  powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 start
  powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 start -Port 8500 -DataDir D:\NotflixData
  powershell -ExecutionPolicy Bypass -File scripts\notflix.ps1 accounts reset-password alex
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("setup", "start", "stop", "restart", "status", "logs", "test", "move-data", "accounts")]
  [string]$Command = "status",
  # Use the Next.js development server (live reload) instead of the production build.
  [switch]$Dev,
  # Change the web port before starting (saved in the configuration).
  [int]$Port = 0,
  # Use this data folder for this run (sets NOTFLIX_DATA_DIR). To move data permanently use move-data.
  [string]$DataDir = "",
  # Target folder for move-data.
  [string]$To = "",
  [switch]$NoBrowser,
  # test: also run the fresh-install + real-FFmpeg integration suites on a throwaway instance.
  [switch]$Integration,
  # test: also run the Playwright browser suite on a throwaway, pre-configured instance.
  [switch]$Browser,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root "scripts\notflix-cli.mjs"
$EngineProject = Join-Path $Root "services\media-engine\src\Notflix.MediaEngine"
$EngineDll = Join-Path $EngineProject "bin\Release\net10.0\Notflix.MediaEngine.dll"
if ($DataDir) { $env:NOTFLIX_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir) }

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  [x]  $text" -ForegroundColor Red }

function Test-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Invoke-Cli([string[]]$CliArgs) {
  $out = & node $Cli @CliArgs
  if ($LASTEXITCODE -ne 0) { throw "notflix-cli $($CliArgs -join ' ') failed" }
  return $out
}

function Get-Install { return (Invoke-Cli @("init", "--json")) | ConvertFrom-Json }

function Get-PidFile($runDir, $name) { Join-Path $runDir "$name.pid" }

function Get-RunningProcess($runDir, $name) {
  $file = Get-PidFile $runDir $name
  if (-not (Test-Path $file)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content $file -Raw).Trim(), [ref]$id)) { return $null }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  # A recycled PID belonging to something else is not ours.
  if ($p -and ($p.ProcessName -match '^(node|dotnet|Notflix\.MediaEngine)$')) { return $p }
  return $null
}

function Test-Url($url, $timeoutSec = 2) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Test-PortFree([int]$port) {
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return -not $l
}

function Assert-Prerequisites([switch]$ForBuild) {
  $ok = $true
  if (Test-Command "node") {
    $v = (& node --version).TrimStart("v")
    if ([version]$v -lt [version]"22.0.0") { Write-Fail "Node.js $v is too old; install Node.js 22 LTS or newer (winget install OpenJS.NodeJS.LTS)"; $ok = $false }
    else { Write-Ok "Node.js $v" }
  } else { Write-Fail "Node.js not found. Install it: winget install OpenJS.NodeJS.LTS"; $ok = $false }

  if (Test-Command "dotnet") {
    $sdks = & dotnet --list-sdks 2>$null
    $runtimes = & dotnet --list-runtimes 2>$null
    if ($ForBuild -and -not ($sdks -match "^10\.")) { Write-Fail ".NET 10 SDK missing: winget install Microsoft.DotNet.SDK.10"; $ok = $false }
    elseif (-not ($runtimes -match "Microsoft\.AspNetCore\.App 10\.")) { Write-Fail "ASP.NET Core 10 runtime missing: winget install Microsoft.DotNet.SDK.10"; $ok = $false }
    else { Write-Ok ".NET 10" }
  } else { Write-Fail ".NET not found. Install it: winget install Microsoft.DotNet.SDK.10"; $ok = $false }

  if ((Test-Command "ffmpeg") -and (Test-Command "ffprobe")) { Write-Ok "FFmpeg $((& ffmpeg -hide_banner -version | Select-Object -First 1) -replace '^ffmpeg version (\S+).*','$1')" }
  else { Write-Warn2 "FFmpeg/FFprobe not found on PATH. Install a full build: winget install Gyan.FFmpeg (then open a new terminal). Only Direct Play works without it." }

  $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -like "PCI*" }
  if ($gpus) { foreach ($g in $gpus) { Write-Ok "Graphics adapter: $($g.Name) (tested for acceleration when the engine starts)" } }
  else { Write-Warn2 "No graphics adapter found; video conversion will use the processor" }
  return $ok
}

function Invoke-Setup {
  Write-Step "Checking prerequisites"
  if (-not (Assert-Prerequisites -ForBuild)) { throw "Install the missing prerequisites above, open a new PowerShell window, and run setup again." }
  Write-Step "Installing web packages (npm ci)"
  Push-Location $Root
  try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    Write-Step "Building the media engine"
    & dotnet build $EngineProject -c Release --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }
    Write-Ok "Media engine built"
    Write-Step "Building the web app"
    & npx next build
    if ($LASTEXITCODE -ne 0) { throw "next build failed" }
    Write-Ok "Web app built"
    if (Test-Command "ffmpeg") {
      Write-Step "Generating self-test videos (test-media\, synthetic test patterns, a few minutes the first time)"
      & node (Join-Path $Root "scripts\generate-test-media.mjs")
      if ($LASTEXITCODE -ne 0) { Write-Warn2 "Some self-test videos could not be generated; Settings -> Playback self-test lists what exists." }
    }
  } finally { Pop-Location }
  Write-Step "Preparing the data folder"
  $i = Get-Install
  Write-Ok "Data folder: $($i.dataDir)"
  foreach ($w in $i.warnings) { Write-Warn2 $w }
  Write-Ok "Setup complete. Next: scripts\notflix.ps1 start  (or double-click Start-Notflix.cmd)"
}

function Start-Engine($i) {
  if (Get-RunningProcess $i.runDir "engine") { Write-Ok "Media engine already running"; return }
  if (-not (Test-Path $EngineDll)) { throw "The media engine is not built. Run: scripts\notflix.ps1 setup" }
  if (-not (Test-PortFree $i.enginePort)) { throw "Port $($i.enginePort) (media engine) is in use by another program. Change 'port' in $($i.dataDir)\config\engine.json." }
  Write-Step "Starting media engine on 127.0.0.1:$($i.enginePort)"
  $env:NOTFLIX_DATA_DIR = $i.dataDir
  $p = Start-Process -FilePath "dotnet" -ArgumentList "`"$EngineDll`"" -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $i.logsDir "media-engine.log") -RedirectStandardError (Join-Path $i.logsDir "media-engine.err.log")
  Set-Content -Path (Get-PidFile $i.runDir "engine") -Value $p.Id
  for ($n = 0; $n -lt 40; $n++) {
    if (Test-Url "http://127.0.0.1:$($i.enginePort)/health") { Write-Ok "Media engine is up (PID $($p.Id))"; return }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Fail "The media engine did not start. Last log lines:"
  Get-Content (Join-Path $i.logsDir "media-engine.err.log") -Tail 10 -ErrorAction SilentlyContinue
  Get-Content (Join-Path $i.logsDir "media-engine.log") -Tail 10 -ErrorAction SilentlyContinue
  throw "Media engine failed to start"
}

function Start-Web($i) {
  if (Get-RunningProcess $i.runDir "web") { Write-Ok "Web server already running"; return }
  if (-not $Dev -and -not (Test-Path (Join-Path $Root ".next\BUILD_ID"))) { throw "The web app is not built. Run: scripts\notflix.ps1 setup" }
  if (-not (Test-PortFree $i.webPort)) { throw "Port $($i.webPort) is in use by another program. Choose another: scripts\notflix.ps1 start -Port <number>" }
  $mode = if ($Dev) { "development" } else { "production" }
  Write-Step "Starting web server ($mode) on $($i.bindAddress):$($i.webPort)"
  $env:NOTFLIX_DATA_DIR = $i.dataDir
  $nodeArgs = @("`"$(Join-Path $Root 'server.mjs')`"")
  if ($Dev) { $nodeArgs += "--dev" }
  $p = Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $i.logsDir "web.log") -RedirectStandardError (Join-Path $i.logsDir "web.err.log")
  Set-Content -Path (Get-PidFile $i.runDir "web") -Value $p.Id
  $limit = if ($Dev) { 180 } else { 60 }
  for ($n = 0; $n -lt $limit; $n++) {
    if (Test-Url "http://127.0.0.1:$($i.webPort)/api/health") { Write-Ok "Web server is up (PID $($p.Id))"; return }
    if ($p.HasExited) { break }
    Start-Sleep -Seconds 1
  }
  Write-Fail "The web server did not start. Last log lines:"
  Get-Content (Join-Path $i.logsDir "web.err.log") -Tail 15 -ErrorAction SilentlyContinue
  Get-Content (Join-Path $i.logsDir "web.log") -Tail 15 -ErrorAction SilentlyContinue
  throw "Web server failed to start"
}

function Stop-Component($runDir, $name, [switch]$Graceful) {
  $p = Get-RunningProcess $runDir $name
  if (-not $p) { Write-Ok "$name not running"; Remove-Item (Get-PidFile $runDir $name) -ErrorAction SilentlyContinue; return }
  if ($Graceful) {
    # server.mjs watches for this file and shuts down cleanly.
    Set-Content -Path (Join-Path $runDir "web.stop") -Value "stop"
    for ($n = 0; $n -lt 20 -and -not $p.HasExited; $n++) { Start-Sleep -Milliseconds 500; $p.Refresh() }
  }
  if (-not $p.HasExited) {
    # /T also ends child processes (FFmpeg runs inside the engine's job object and exits with it).
    & taskkill.exe /PID $p.Id /T /F | Out-Null
  }
  Remove-Item (Get-PidFile $runDir $name) -ErrorAction SilentlyContinue
  Write-Ok "Stopped $name (PID $($p.Id))"
}

function Invoke-Start {
  Write-Step "Checking prerequisites"
  if (-not (Assert-Prerequisites)) { throw "Install the missing prerequisites above, then run start again." }
  if ($Port -gt 0) { Invoke-Cli @("set-port", "$Port") | Out-Null }
  $i = Get-Install
  foreach ($w in $i.warnings) { Write-Warn2 $w }
  Write-Ok "Data folder: $($i.dataDir)"
  Start-Engine $i
  try { Start-Web $i } catch { Stop-Component $i.runDir "engine"; throw }
  Show-Status
  $s = (Invoke-Cli @("status")) | ConvertFrom-Json
  $url = "http://localhost:$($s.webPort)"
  if (-not $s.setupComplete -and $s.setupCode) {
    Write-Host ""
    Write-Host "  First-run setup: open $url/setup" -ForegroundColor White
    Write-Host "  Setup code:      $($s.setupCode)" -ForegroundColor White
    Write-Host ""
    $url = "$url/setup#code=$($s.setupCode)"
  }
  if (-not $NoBrowser) { Start-Process $url | Out-Null }
}

function Invoke-Stop {
  $i = Get-Install
  Stop-Component $i.runDir "web" -Graceful
  Stop-Component $i.runDir "engine"
}

function Show-Status {
  $s = (Invoke-Cli @("status")) | ConvertFrom-Json
  Write-Step "Status"
  Write-Host "  Data folder:  $($s.dataDir)"
  $webUp = Test-Url "http://127.0.0.1:$($s.webPort)/api/health"
  $engineUp = Test-Url "http://127.0.0.1:$($s.enginePort)/health"
  if ($webUp) { Write-Ok "Web server    http://localhost:$($s.webPort)  (listening on $($s.bindAddress))" } else { Write-Warn2 "Web server not responding on port $($s.webPort)" }
  if ($engineUp) { Write-Ok "Media engine  127.0.0.1:$($s.enginePort) (private to this computer)" } else { Write-Warn2 "Media engine not responding on port $($s.enginePort)" }
  if ($s.allowLan) {
    $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress
    if ($lan) { Write-Host "  Other devices: $(($lan | ForEach-Object { "http://$($_):$($s.webPort)" }) -join '  ')" }
  } else { Write-Host "  Network:      this computer only (enable LAN access in Settings)" }
  Write-Host "  Setup:        $(if ($s.setupComplete) { 'complete' } else { 'not finished - open /setup' })"
}

function Invoke-Tests {
  $failed = @()
  Push-Location $Root
  try {
    Write-Step "Media engine unit tests (.NET)"
    & dotnet test (Join-Path $Root "services\media-engine\tests\Notflix.MediaEngine.Tests") --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { $failed += "engine unit tests" }
    Write-Step "Web unit tests (Vitest)"
    & npx vitest run
    if ($LASTEXITCODE -ne 0) { $failed += "web unit tests" }
    Write-Step "TypeScript"
    & npx tsc --noEmit -p .
    if ($LASTEXITCODE -ne 0) { $failed += "typecheck" }

    if ($Integration) {
      $dir = Join-Path $env:TEMP ("notflix-it-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
      Write-Step "Fresh installation end to end (throwaway data: $dir)"
      $i = Start-Throwaway $dir { Invoke-Cli @("set-port", "8519") | Out-Null }
      try {
        & node (Join-Path $Root "scripts\test-install-e2e.mjs") --base "http://localhost:$($i.webPort)" --data $dir
        if ($LASTEXITCODE -ne 0) { $failed += "fresh-install e2e" }
        Write-Step "Restart, then check persistence"
        Stop-Component $i.runDir "web" -Graceful
        Stop-Component $i.runDir "engine"
        Start-Engine $i
        Start-Web $i
        & node (Join-Path $Root "scripts\test-install-e2e.mjs") --base "http://localhost:$($i.webPort)" --data $dir --phase restart
        if ($LASTEXITCODE -ne 0) { $failed += "restart persistence" }
        Write-Step "Media engine codec / seek / hardware matrix (real FFmpeg)"
        $env:ENGINE_URL = "http://127.0.0.1:$($i.enginePort)"
        & node (Join-Path $Root "scripts\test-media-engine.mjs")
        if ($LASTEXITCODE -ne 0) { $failed += "engine matrix" }
        Remove-Item Env:ENGINE_URL -ErrorAction SilentlyContinue
      } finally {
        Stop-Component $i.runDir "web" -Graceful
        Stop-Component $i.runDir "engine"
      }
    }

    if ($Browser) {
      $dir = Join-Path $env:TEMP ("notflix-e2e-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
      Write-Step "Browser suite (Playwright, throwaway pre-configured instance: $dir)"
      $env:SIGNUP_RATE_LIMIT = "100000"
      $i = Start-Throwaway $dir { & node (Join-Path $Root "scripts\prepare-test-instance.mjs") --data $dir --web-port 8529 --engine-port 8528 | Out-Null }
      try {
        $env:E2E_BASE_URL = "http://127.0.0.1:$($i.webPort)"
        $env:E2E_DATA_PATH = $dir
        & npx playwright test
        if ($LASTEXITCODE -ne 0) { $failed += "playwright" }
      } finally {
        Stop-Component $i.runDir "web" -Graceful
        Stop-Component $i.runDir "engine"
        Remove-Item Env:E2E_BASE_URL, Env:E2E_DATA_PATH, Env:SIGNUP_RATE_LIMIT -ErrorAction SilentlyContinue
      }
    }
  } finally { Pop-Location }
  if ($failed.Count -eq 0) { Write-Ok "All test suites passed" } else { Write-Fail "Failed: $($failed -join ', ')"; exit 1 }
}

function Start-Throwaway([string]$dir, [scriptblock]$prepare) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $env:NOTFLIX_DATA_DIR = $dir
  & $prepare
  $i = Get-Install
  Start-Engine $i
  Start-Web $i
  return $i
}

try {
  switch ($Command) {
    "setup" { Invoke-Setup }
    "start" { Invoke-Start }
    "stop" { Invoke-Stop }
    "restart" { Invoke-Stop; Invoke-Start }
    "status" { Show-Status }
    "logs" {
      $i = Get-Install
      Get-ChildItem $i.logsDir -Filter *.log | ForEach-Object { Write-Host "--- $($_.Name)" -ForegroundColor Cyan; Get-Content $_.FullName -Tail 25 }
    }
    "test" { Invoke-Tests }
    "move-data" {
      $target = if ($To) { $To } elseif ($Rest) { $Rest[0] } else { throw "Usage: scripts\notflix.ps1 move-data -To <folder>" }
      Invoke-Cli @("move-data", "--to", $target)
    }
    "accounts" { & node $Cli accounts @Rest; exit $LASTEXITCODE }
  }
} catch {
  Write-Fail $_.Exception.Message
  exit 1
}
