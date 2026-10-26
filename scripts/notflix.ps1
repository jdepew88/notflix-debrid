<#
.SYNOPSIS
  Notflix Debrid launcher for Windows: installs, starts, stops and checks the web server and the
  media engine.

.DESCRIPTION
  setup     Check prerequisites (Node.js, .NET, FFmpeg), install packages, build everything.
  start     Start the media engine and the web server, wait until both are healthy, open the browser.
            The data folder used is remembered: later starts, stops and restarts reopen it.
  stop      Stop both (gracefully, then forcefully after a timeout). -All also stops servers started
            from this folder with other data folders.
  restart   stop + start.
  status    Processes, health, addresses, data folder.

  Running servers are recognised by their command line (this folder's server.mjs / engine DLL and
  --data-dir), so this works after the window that started them was closed; a PID file alone is
  never trusted.
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
  # Change the media engine's port before starting (saved; the engine stays on 127.0.0.1).
  [int]$EnginePort = 0,
  # Use this data folder. start/restart remember it for later runs (copying data: use move-data).
  [string]$DataDir = "",
  # stop: also stop servers started from this folder with other data folders.
  [switch]$All,
  # Target folder for move-data.
  [string]$To = "",
  [switch]$NoBrowser,
  # test: also run the fresh-install + real-FFmpeg integration suites on a throwaway instance.
  [switch]$Integration,
  # test: also run the Playwright browser suite on a throwaway, pre-configured instance.
  [switch]$Browser,
  # test -Browser: reuse the TMDB/Real-Debrid credentials of this (onboarded) data folder.
  [string]$CredentialsFrom = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"

# Absolute path without a trailing separator (except a drive root).
function Get-FullDir([string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
  return $full
}

$Root = Split-Path -Parent $PSScriptRoot
# Long, real form of this folder (a launch through an 8.3 short path or a junction must recognise
# the same servers as a launch through the normal path).
if (Get-Command node -ErrorAction SilentlyContinue) {
  try {
    $long = & node -e "process.stdout.write(require('fs').realpathSync.native(process.argv[1]))" $Root 2>$null
    if ($LASTEXITCODE -eq 0 -and $long) { $Root = $long }
  } catch { }
}
$Cli = Join-Path $Root "scripts\notflix-cli.mjs"
$WebScript = Join-Path $Root "server.mjs"
$EngineProject = Join-Path $Root "services\media-engine\src\Notflix.MediaEngine"
$EngineDll = Join-Path $EngineProject "bin\Release\net10.0\Notflix.MediaEngine.dll"
if ($DataDir) { $env:NOTFLIX_DATA_DIR = Get-FullDir $DataDir }

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

# Where this installation's data folder is, without creating or changing anything. "problem" is set
# when the remembered folder is missing or incomplete (see src/lib/install/paths.mjs).
function Get-DataLocation { return (Invoke-Cli @("paths", "--json")) | ConvertFrom-Json }

function Get-PidFile($runDir, $name) { Join-Path $runDir "$name.pid" }

function Test-SamePath([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  try { return [string]::Equals((Get-FullDir $a), (Get-FullDir $b), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}

# A command-line argument in double quotes (a trailing backslash would escape the closing quote).
function Format-Arg([string]$s) { if ($s.EndsWith("\")) { $s += "\" }; return "`"$s`"" }

function Split-CommandLine([string]$line) {
  return @([regex]::Matches($line, '"([^"]*)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
}

<#
  Every Notflix web server and media engine on this computer, recognised by its command line:
  node.exe running a server.mjs, dotnet.exe running Notflix.MediaEngine.dll. Each has
    Kind     web | engine
    Mine     $true when it runs THIS folder's server.mjs / engine DLL
    DataDir  its --data-dir (servers started by older launchers have none)
    Started  creation time (a PID can be reused; PID + creation time cannot)
  This does not depend on PID files or on the window that started the servers still being open.
#>
function Get-NotflixProcesses {
  $filter = "Name='node.exe' OR Name='dotnet.exe'"
  try { $list = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop) }
  catch {
    try { $list = @(Get-WmiObject Win32_Process -Filter $filter -ErrorAction Stop) }
    catch { throw "Windows could not list the running programs ($($_.Exception.Message)), so Notflix cannot tell which processes are its own. Nothing was changed; try again in a moment." }
  }
  $found = @()
  foreach ($p in $list) {
    if (-not $p.CommandLine) { continue }
    $tokens = Split-CommandLine $p.CommandLine
    $kind = $null; $script = $null; $argDataDir = $null
    for ($t = 0; $t -lt $tokens.Count; $t++) {
      $leaf = try { [System.IO.Path]::GetFileName($tokens[$t]) } catch { "" }
      if (-not $kind -and $leaf -ieq "server.mjs") { $kind = "web"; $script = $tokens[$t] }
      elseif (-not $kind -and $leaf -ieq "Notflix.MediaEngine.dll") { $kind = "engine"; $script = $tokens[$t] }
      elseif ($tokens[$t] -eq "--data-dir" -and $t + 1 -lt $tokens.Count) { $argDataDir = $tokens[$t + 1] }
      elseif ($tokens[$t] -like "--data-dir=*") { $argDataDir = $tokens[$t].Substring(11) }
    }
    if (-not $kind -or -not [System.IO.Path]::IsPathRooted($script)) { continue }
    $started = if ($p.CreationDate -is [datetime]) { $p.CreationDate } else { [System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate) }
    $found += [pscustomobject]@{
      Id = [int]$p.ProcessId; Kind = $kind; Script = $script; DataDir = $argDataDir; Started = $started
      Mine = (Test-SamePath $script $(if ($kind -eq "web") { $WebScript } else { $EngineDll }))
    }
  }
  # Same files reached through another spelling (8.3 short name, junction): compare real paths.
  $unsure = @($found | Where-Object { -not $_.Mine })
  if ($unsure.Count -gt 0) {
    $real = @((Invoke-Cli (@("canonical-paths") + @($unsure | ForEach-Object { $_.Script }))) | ConvertFrom-Json)
    for ($n = 0; $n -lt $unsure.Count; $n++) {
      $unsure[$n].Mine = Test-SamePath $real[$n] $(if ($unsure[$n].Kind -eq "web") { $WebScript } else { $EngineDll })
    }
  }
  # The application folder of each, and whether it really is a Notflix installation (any program
  # can be called server.mjs).
  foreach ($f in $found) {
    $appRoot = $f.Script -replace '\\(server\.mjs|services\\media-engine\\.*)$', ''
    $isNotflix = $f.Mine -or (Test-Path -LiteralPath (Join-Path $appRoot "scripts\notflix.ps1"))
    $f | Add-Member -NotePropertyName AppRoot -NotePropertyValue $appRoot
    $f | Add-Member -NotePropertyName IsNotflix -NotePropertyValue $isNotflix
  }
  return $found
}

function Read-PidRecord($runDir, $kind) {
  $file = Get-PidFile $runDir $kind
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $raw = "$(Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue)".Trim()
  $id = 0
  # Older launchers wrote only the PID.
  if ([int]::TryParse($raw, [ref]$id)) { return [pscustomobject]@{ pid = $id; started = $null } }
  try {
    $r = $raw | ConvertFrom-Json
    $started = if ($r.started) { [datetime]::Parse($r.started, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } else { $null }
    return [pscustomobject]@{ pid = [int]$r.pid; started = $started }
  } catch { return [pscustomobject]@{ pid = 0; started = $null } }
}

function Write-PidRecord($i, $kind, $proc) {
  $record = [ordered]@{ pid = $proc.Id; started = $proc.Started.ToUniversalTime().ToString("o"); dataDir = $i.dataDir; appRoot = $Root }
  # UTF-8 without a byte order mark (Node-based tools read it too).
  try { [System.IO.File]::WriteAllText((Get-PidFile $i.runDir $kind), ($record | ConvertTo-Json -Compress)) } catch { }
}

function Test-SameStart($a, $b) { return [math]::Abs(($a.ToUniversalTime() - $b.ToUniversalTime()).TotalSeconds) -lt 2 }

<#
  This installation's running web server / engine: this folder's server.mjs / engine DLL working on
  this data folder. Repairs the PID records on the way:
  - a record whose PID now belongs to another program (or another Notflix) is removed;
  - a server whose record was lost (the launcher window was closed early, run\ was cleaned up, an
    older launcher) is tracked again.
  Servers from older launchers carry no --data-dir; they count only when this data folder's record
  names them (PID and, when recorded, creation time).
#>
function Get-InstanceState($i, $nfx) {
  $state = @{}
  foreach ($kind in "web", "engine") {
    $rec = Read-PidRecord $i.runDir $kind
    $mine = @($nfx | Where-Object { $_.Mine -and $_.Kind -eq $kind -and $_.DataDir -and (Test-SamePath $_.DataDir $i.dataDir) })
    $p = if ($rec) { $nfx | Where-Object { $_.Id -eq $rec.pid } | Select-Object -First 1 } else { $null }
    # Another Notflix folder using the same data folder (for example the shared default): that
    # record is its business, not this installation's; leave it alone.
    if ($p -and -not $p.Mine -and $p.IsNotflix -and (-not $p.DataDir -or (Test-SamePath $p.DataDir $i.dataDir))) { $rec = $null }
    if ($rec) {
      if ($p -and $p.Kind -ne $kind) { $p = $null }
      $vouched = $p -and $p.Mine -and -not $p.DataDir -and (-not $rec.started -or (Test-SameStart $p.Started $rec.started))
      if ($vouched) { $mine += $p }
      elseif (-not ($mine | Where-Object { $_.Id -eq $rec.pid -and (-not $rec.started -or (Test-SameStart $_.Started $rec.started)) })) {
        Remove-Item -LiteralPath (Get-PidFile $i.runDir $kind) -ErrorAction SilentlyContinue
        if ($rec.pid -gt 0) { Write-Warn2 "Removed an outdated $kind record (PID $($rec.pid) is no longer this Notflix's $kind)" }
        $rec = $null
      }
    }
    if ($mine.Count -gt 0 -and (-not $rec -or -not $rec.started)) {
      if (-not $rec) { Write-Ok "Found the running $kind (PID $($mine[0].Id)) without a record; tracking it again" }
      Write-PidRecord $i $kind $mine[0]
    }
    $state[$kind] = $mine
  }
  return $state
}

# Running servers from this folder that work on other data folders (or, from older launchers, an
# unknown one).
function Get-OtherInstances($state, $nfx) {
  $ids = @($state.web + $state.engine | ForEach-Object { $_.Id })
  return @($nfx | Where-Object { $_.Mine -and $ids -notcontains $_.Id })
}

function Get-KindLabel($kind) { if ($kind -eq "web") { "web server" } else { "media engine" } }

function Show-OtherInstances($others) {
  foreach ($o in $others) {
    if ($o.DataDir) { Write-Warn2 "Also running from this folder: $(Get-KindLabel $o.Kind) (PID $($o.Id)) with data folder $($o.DataDir). Stop it with: Stop-Notflix.cmd -DataDir `"$($o.DataDir)`"" }
    else { Write-Warn2 "Also running from this folder: $(Get-KindLabel $o.Kind) (PID $($o.Id)) started by an older launcher; its data folder is unknown. Stop it with: Stop-Notflix.cmd -All" }
  }
}

function Test-Url($url, $timeoutSec = 2) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# Listening sockets on a port as @{ Address; Pid }. netstat is used because Get-NetTCPConnection
# sometimes returns an incomplete list (WMI provider trouble).
function Get-Listeners([int]$port) {
  $out = @()
  foreach ($line in (& netstat.exe -ano 2>$null)) {
    $m = [regex]::Match($line, '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$')
    if ($m.Success -and [int]$m.Groups[2].Value -eq $port) {
      $out += [pscustomobject]@{ Address = $m.Groups[1].Value.Trim('[', ']'); Pid = [int]$m.Groups[3].Value }
    }
  }
  return $out
}

# $null when the port is free, else a description of the program holding it (naming the Notflix
# installation and data folder when it is one, with how to stop it).
function Get-PortUser([int]$port, $nfx = @()) {
  foreach ($l in (Get-Listeners $port)) {
    # PID 0 / a vanished process: a socket that is still closing after its program exited.
    $p = if ($l.Pid -gt 0) { Get-Process -Id $l.Pid -ErrorAction SilentlyContinue } else { $null }
    if (-not $p) { continue }
    $n = $nfx | Where-Object { $_.Id -eq $l.Pid } | Select-Object -First 1
    if ($n -and $n.Mine -and $n.DataDir) { return "this Notflix running with the data folder $($n.DataDir) (PID $($l.Pid)). Stop it first with: Stop-Notflix.cmd -DataDir `"$($n.DataDir)`"" }
    if ($n -and $n.Mine) { return "this Notflix, started by an older launcher (PID $($l.Pid)). Stop it first with: Stop-Notflix.cmd -All" }
    if ($n -and $n.IsNotflix) { return "another Notflix installation in $($n.AppRoot) (PID $($l.Pid))" }
    return "$($p.ProcessName) (PID $($l.Pid))"
  }
  # Last resort (netstat unavailable): try binding the port.
  foreach ($address in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::Any)) {
    $t = New-Object System.Net.Sockets.TcpListener($address, $port)
    try { $t.ExclusiveAddressUse = $true; $t.Start() } catch { return "another program" } finally { try { $t.Stop() } catch { } }
  }
  return $null
}

function Assert-Installed {
  $missing = @()
  if (-not (Test-Path (Join-Path $Root "node_modules\next\package.json"))) { $missing += "web packages" }
  if (-not $Dev -and -not (Test-Path (Join-Path $Root ".next\BUILD_ID"))) { $missing += "web app build" }
  if (-not (Test-Path $EngineDll)) { $missing += "media engine build" }
  if ($missing.Count -gt 0) {
    throw "Notflix is not installed yet in $Root (missing: $($missing -join ', ')). Double-click Setup-Notflix.cmd first."
  }
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
  if (-not (Assert-Prerequisites -ForBuild)) { throw "Install the missing software above (Setup-Notflix.cmd offers to do it), then run setup again." }
  Push-Location $Root
  try {
    # Running setup again must not reinstall unchanged packages.
    $stamp = Join-Path $Root "node_modules\.notflix-lock-hash"
    $lockHash = (Get-FileHash (Join-Path $Root "package-lock.json") -Algorithm SHA256).Hash
    if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lockHash) -and (Test-Path (Join-Path $Root "node_modules\next\package.json"))) {
      Write-Ok "Web packages are up to date"
    } else {
      Write-Step "Installing web packages (npm ci)"
      & npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
      Set-Content -Path $stamp -Value $lockHash
    }
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
  Write-Ok "Build complete. Next: double-click Start-Notflix.cmd"
}

# Records a just-started process (PID + creation time + data folder) for later stop/status.
function Register-Started($i, $kind, $p) {
  Write-PidRecord $i $kind ([pscustomobject]@{ Id = $p.Id; Started = $p.StartTime })
}

function Start-Engine($i) {
  $nfx = Get-NotflixProcesses
  $running = (Get-InstanceState $i $nfx).engine
  if ($running.Count -gt 0) { Write-Ok "Media engine already running (PID $($running[0].Id))"; return }
  if (-not (Test-Path $EngineDll)) { throw "The media engine is not built. Double-click Setup-Notflix.cmd first." }
  $holder = Get-PortUser $i.enginePort $nfx
  if ($holder) { throw "Port $($i.enginePort), which the media engine uses, is taken by $holder. Close that program, or start Notflix with another engine port from a command prompt in this folder: Start-Notflix.cmd -EnginePort 8431" }
  Write-Step "Starting media engine on 127.0.0.1:$($i.enginePort)"
  $env:NOTFLIX_DATA_DIR = $i.dataDir
  # --data-dir is also how a later stop/status recognises this engine as this installation's.
  $p = Start-Process -FilePath "dotnet" -ArgumentList "$(Format-Arg $EngineDll) --data-dir $(Format-Arg $i.dataDir)" -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $i.logsDir "media-engine.log") -RedirectStandardError (Join-Path $i.logsDir "media-engine.err.log")
  Register-Started $i "engine" $p
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
  $nfx = Get-NotflixProcesses
  $running = (Get-InstanceState $i $nfx).web
  if ($running.Count -gt 0) { Write-Ok "Web server already running (PID $($running[0].Id))"; return }
  if (-not $Dev -and -not (Test-Path (Join-Path $Root ".next\BUILD_ID"))) { throw "The web app is not built. Double-click Setup-Notflix.cmd first." }
  $holder = Get-PortUser $i.webPort $nfx
  if ($holder) { throw "Port $($i.webPort), which Notflix uses, is taken by $holder. Close that program, or start Notflix on another port from a command prompt in this folder: Start-Notflix.cmd -Port 8430" }
  $mode = if ($Dev) { "development" } else { "production" }
  Write-Step "Starting web server ($mode) on $($i.bindAddress):$($i.webPort)"
  $env:NOTFLIX_DATA_DIR = $i.dataDir
  $nodeArgs = "$(Format-Arg $WebScript) --data-dir $(Format-Arg $i.dataDir)"
  if ($Dev) { $nodeArgs += " --dev" }
  $p = Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $i.logsDir "web.log") -RedirectStandardError (Join-Path $i.logsDir "web.err.log")
  Register-Started $i "web" $p
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

<#
  Stops the given Notflix processes. Graceful first: server.mjs and the engine watch
  <data>\run\<kind>.stop and shut down cleanly (the engine ends its FFmpeg jobs and removes their
  temporary files). Whatever is still running after 15 s is ended with taskkill, but only after
  checking again that the PID still is the same Notflix process (same command line, same creation
  time). Returns the processes that could not be stopped.
#>
function Stop-NotflixProcesses([object[]]$procs, [switch]$Graceful) {
  if (-not $procs -or $procs.Count -eq 0) { return @() }
  $stopFiles = @()
  if ($Graceful) {
    foreach ($p in $procs) {
      if (-not $p.DataDir) { continue }
      $f = Join-Path (Join-Path $p.DataDir "run") "$($p.Kind).stop"
      if ($stopFiles -contains $f) { continue }
      try { Set-Content -LiteralPath $f -Value "stop"; $stopFiles += $f } catch { }
    }
    if ($stopFiles.Count -gt 0) {
      for ($n = 0; $n -lt 30; $n++) {
        if (-not ($procs | Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })) { break }
        Start-Sleep -Milliseconds 500
      }
    }
  }
  $now = Get-NotflixProcesses
  foreach ($p in $procs) {
    $same = $now | Where-Object { $_.Id -eq $p.Id -and $_.Kind -eq $p.Kind -and (Test-SameStart $_.Started $p.Started) }
    # /T also ends child processes (FFmpeg runs inside the engine's job object and exits with it).
    if ($same) { & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null }
  }
  foreach ($f in $stopFiles) { Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  $left = @()
  $now = Get-NotflixProcesses
  foreach ($p in $procs) {
    if ($now | Where-Object { $_.Id -eq $p.Id -and (Test-SameStart $_.Started $p.Started) }) { $left += $p }
  }
  return $left
}

# Stops this installation's web server or engine ($i: dataDir, runDir). Returns $true when it had
# been running.
function Stop-Component($i, $name, [switch]$Graceful) {
  $nfx = Get-NotflixProcesses
  $procs = @((Get-InstanceState $i $nfx)[$name])
  # Older launchers did not pass --data-dir, so they could not be stopped by the stop file
  # alone; give them this data folder for the graceful attempt.
  $procs = @($procs | ForEach-Object { if (-not $_.DataDir) { $_ | Add-Member -NotePropertyName DataDir -NotePropertyValue $i.dataDir -Force }; $_ })
  if ($procs.Count -eq 0) { Write-Ok "$(Get-KindLabel $name) not running"; Remove-Item -LiteralPath (Get-PidFile $i.runDir $name) -ErrorAction SilentlyContinue; return $false }
  $left = Stop-NotflixProcesses $procs -Graceful:$Graceful
  if ($left.Count -gt 0) { throw "Could not stop the $(Get-KindLabel $name) (PID $(($left | ForEach-Object { $_.Id }) -join ', ')). End it in Task Manager, then try again." }
  Remove-Item -LiteralPath (Get-PidFile $i.runDir $name) -ErrorAction SilentlyContinue
  Write-Ok "Stopped $(Get-KindLabel $name) (PID $(($procs | ForEach-Object { $_.Id }) -join ', '))"
  return $true
}

function Open-Browser([string]$url) {
  # Test seam: record the address instead of opening a browser (scripts\test-windows-install.mjs).
  if ($env:NOTFLIX_BROWSER_LOG) { Add-Content -Path $env:NOTFLIX_BROWSER_LOG -Value $url; return }
  try { Start-Process $url | Out-Null; Write-Ok "Opened $url in your browser" }
  catch { Write-Warn2 "Could not open a browser automatically. Open this address yourself: $url" }
}

# One launcher at a time per data folder: two quick double-clicks must not start two servers.
function Enter-LauncherLock($i) {
  $lock = Join-Path $i.runDir "launcher.lock"
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      $fs = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      $bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID")
      $fs.Write($bytes, 0, $bytes.Length)
      $fs.Close()
      return $lock
    } catch [System.IO.IOException] {
      $item = Get-Item $lock -ErrorAction SilentlyContinue
      if ($item -and ((Get-Date) - $item.LastWriteTime).TotalMinutes -lt 3) { throw "Notflix is already starting in another window. Wait for it to finish." }
      Remove-Item $lock -ErrorAction SilentlyContinue
    }
  }
  throw "Could not start: $lock is in use."
}

function Get-SourceLabel($source) {
  switch ($source) {
    "pointer" { "remembered from the last start" }
    "env" { if ($DataDir) { "chosen with -DataDir" } else { "from NOTFLIX_DATA_DIR" } }
    "argument" { "chosen with -DataDir" }
    default { "the default" }
  }
}

# The remembered data folder must still be there; never start over somewhere else silently.
function Assert-DataLocation {
  $loc = Get-DataLocation
  if ($loc.problem) {
    foreach ($o in (Get-OtherInstances @{ web = @(); engine = @() } (Get-NotflixProcesses))) { Write-Host "  (running from this folder: $(Get-KindLabel $o.Kind), PID $($o.Id), data folder $(if ($o.DataDir) { $o.DataDir } else { 'unknown' }))" }
    throw $loc.recovery
  }
  return $loc
}

function Invoke-Start {
  Assert-Installed
  Write-Step "Checking prerequisites"
  if (-not (Assert-Prerequisites)) { throw "Install the missing software above (double-click Setup-Notflix.cmd), then start Notflix again." }
  $loc = Assert-DataLocation
  # Before -Port/-EnginePort write their settings: is this folder a new installation?
  $isNew = -not (Test-Path -LiteralPath $loc.serverConfigFile)
  if ($Port -gt 0) { Invoke-Cli @("set-port", "$Port") | Out-Null }
  if ($EnginePort -gt 0) { Invoke-Cli @("set-engine-port", "$EnginePort") | Out-Null }
  $i = Get-Install
  foreach ($w in $i.warnings) { Write-Warn2 $w }
  Write-Ok "Data folder: $($i.dataDir) ($(Get-SourceLabel $i.source))"
  if ($isNew) { Write-Warn2 "This data folder is new: Notflix starts as a new installation with first-run setup." }
  $lock = Enter-LauncherLock $i
  try {
    $state = Get-InstanceState $i (Get-NotflixProcesses)
    $engineRunning = $state.engine.Count -gt 0
    if ($engineRunning -and $state.web.Count -gt 0) { Write-Ok "Notflix is already running" }
    Start-Engine $i
    try { Start-Web $i } catch { if (-not $engineRunning) { Stop-Component $i "engine" -Graceful | Out-Null }; throw }
  } finally { Remove-Item $lock -ErrorAction SilentlyContinue }
  # Remember the folder so the next start, stop or restart (from any window, with or without
  # -DataDir) opens this installation again. NOTFLIX_DATA_DIR set by hand is not remembered.
  if ($DataDir -or $i.source -eq "default") {
    $r = (Invoke-Cli @("remember-data-dir", $i.dataDir)) | ConvertFrom-Json
    if ($r.changed -and $r.previous) { Write-Ok "Later starts use this data folder. (Before: $($r.previous) - left unchanged; switch back with Start-Notflix.cmd -DataDir `"$($r.previous)`")" }
    elseif ($r.changed) { Write-Ok "Later starts use this data folder" }
  }
  Show-Status
  $s = (Invoke-Cli @("status")) | ConvertFrom-Json
  $webPort = if ($s.listening -and $s.listening.port) { $s.listening.port } else { $s.webPort }
  $base = "http://localhost:$webPort"
  Write-Host ""
  # The persistent setup.completed flag decides; an owner account alone does not mean setup is done.
  if (-not $s.setupComplete) {
    Write-Host "  Notflix is running at $base - first-run setup is not finished yet." -ForegroundColor White
    if ($s.setupCode) { Write-Host "  Setup code: $($s.setupCode)" -ForegroundColor White; $url = "$base/setup#code=$($s.setupCode)" }
    else { $url = "$base/setup" }
  } else {
    Write-Host "  Notflix is running at $base" -ForegroundColor White
    $url = "$base/"
  }
  Write-Host ""
  if (-not $NoBrowser) { Open-Browser $url }
}

function Invoke-Stop {
  # paths, not init: stopping must work even when the data folder has become unavailable.
  $loc = Get-DataLocation
  Write-Step "Stopping Notflix (data folder: $($loc.dataDir))"
  $nfx = Get-NotflixProcesses
  $state = Get-InstanceState $loc $nfx
  $others = Get-OtherInstances $state $nfx
  $was = $false
  # Web server first (it uses the engine), then the engine.
  if (Stop-Component $loc "web" -Graceful) { $was = $true }
  if (Stop-Component $loc "engine" -Graceful) { $was = $true }
  if ($All -and $others.Count -gt 0) {
    $ordered = @($others | Where-Object Kind -eq "web") + @($others | Where-Object Kind -eq "engine")
    $left = Stop-NotflixProcesses $ordered -Graceful
    foreach ($o in $ordered) {
      if ($left | Where-Object Id -eq $o.Id) { Write-Fail "Could not stop the $(Get-KindLabel $o.Kind) (PID $($o.Id))" }
      else { Write-Ok "Stopped the $(Get-KindLabel $o.Kind) (PID $($o.Id)) of $(if ($o.DataDir) { "data folder $($o.DataDir)" } else { 'an older launcher' })"; $was = $true }
    }
    if ($left.Count -gt 0) { throw "Some Notflix processes could not be stopped. End them in Task Manager, then try again." }
  } elseif ($others.Count -gt 0) { Show-OtherInstances $others }
  if ($was) { Write-Ok "Notflix stopped" } else { Write-Ok "Notflix was not running" }
}

function Show-Status {
  $s = (Invoke-Cli @("status")) | ConvertFrom-Json
  Write-Step "Status"
  Write-Host "  Application:  $Root"
  Write-Host "  Data folder:  $($s.dataDir) ($(Get-SourceLabel $s.dataDirSource))"
  if ($s.problem) { Write-Warn2 "The data folder cannot be opened: $($s.problem). Start-Notflix.cmd explains how to recover." }
  $nfx = Get-NotflixProcesses
  $state = Get-InstanceState $s $nfx
  $webUp = Test-Url "http://127.0.0.1:$($s.webPort)/api/health"
  $engineUp = Test-Url "http://127.0.0.1:$($s.enginePort)/health"
  $webPids = ($state.web | ForEach-Object { $_.Id }) -join ", "
  $enginePids = ($state.engine | ForEach-Object { $_.Id }) -join ", "
  # A port can answer for another program or another Notflix; report what this installation runs.
  if ($state.web.Count -gt 0 -and $webUp) { Write-Ok "Web server    http://localhost:$($s.webPort)  (PID $webPids, listening on $($s.bindAddress))" }
  elseif ($state.web.Count -gt 0) { Write-Warn2 "Web server    running (PID $webPids) but not responding on port $($s.webPort) yet" }
  elseif ($webUp) { Write-Warn2 "Web server    not running for this data folder; port $($s.webPort) is answered by $(Get-PortUser $s.webPort $nfx)" }
  else { Write-Warn2 "Web server    not running" }
  if ($state.engine.Count -gt 0 -and $engineUp) { Write-Ok "Media engine  127.0.0.1:$($s.enginePort) (PID $enginePids, private to this computer)" }
  elseif ($state.engine.Count -gt 0) { Write-Warn2 "Media engine  running (PID $enginePids) but not responding on port $($s.enginePort) yet" }
  elseif ($engineUp) { Write-Warn2 "Media engine  not running for this data folder; port $($s.enginePort) is answered by $(Get-PortUser $s.enginePort $nfx)" }
  else { Write-Warn2 "Media engine  not running" }
  Show-OtherInstances (Get-OtherInstances $state $nfx)
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
      $i = Start-Throwaway $dir { Invoke-Cli @("set-port", "8519") | Out-Null; Invoke-Cli @("set-engine-port", "8518") | Out-Null }
      try {
        & node (Join-Path $Root "scripts\test-install-e2e.mjs") --base "http://localhost:$($i.webPort)" --data $dir
        if ($LASTEXITCODE -ne 0) { $failed += "fresh-install e2e" }
        Write-Step "Restart, then check persistence"
        Stop-Component $i "web" -Graceful | Out-Null
        Stop-Component $i "engine" | Out-Null
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
        Stop-Component $i "web" -Graceful | Out-Null
        Stop-Component $i "engine" | Out-Null
      }
    }

    if ($Browser) {
      $dir = Join-Path $env:TEMP ("notflix-e2e-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
      Write-Step "Browser suite (Playwright, throwaway pre-configured instance: $dir)"
      $env:SIGNUP_RATE_LIMIT = "100000"
      $prep = @((Join-Path $Root "scripts\prepare-test-instance.mjs"), "--data", $dir, "--web-port", "8529", "--engine-port", "8528")
      if ($CredentialsFrom) { $prep += @("--credentials-from", $CredentialsFrom) }
      $i = Start-Throwaway $dir { & node @prep | Out-Null; if ($LASTEXITCODE -ne 0) { throw "could not prepare the test instance" } }
      try {
        $env:E2E_BASE_URL = "http://127.0.0.1:$($i.webPort)"
        $env:E2E_DATA_PATH = $dir
        if ($CredentialsFrom) { $env:E2E_LIVE_DEBRID = "1" }
        & npx playwright test
        if ($LASTEXITCODE -ne 0) { $failed += "playwright" }
      } finally {
        Stop-Component $i "web" -Graceful | Out-Null
        Stop-Component $i "engine" | Out-Null
        Remove-Item Env:E2E_BASE_URL, Env:E2E_DATA_PATH, Env:SIGNUP_RATE_LIMIT, Env:E2E_LIVE_DEBRID -ErrorAction SilentlyContinue
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
