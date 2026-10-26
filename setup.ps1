<#
.SYNOPSIS
  Notflix Debrid installer for Windows (started by Setup-Notflix.cmd).

.DESCRIPTION
  1. Checks that this version of Windows is supported.
  2. Checks Node.js, the .NET 10 SDK, FFmpeg and FFprobe by running them (copies installed without
     WinGet count too, so nothing is installed twice).
  3. Offers to install what is missing or too old with WinGet, using the package ids in
     requirements.winget, and asks before installing anything.
  4. Builds Notflix with the existing launcher command (scripts\notflix.ps1 setup).
  Safe to run again: installed tools are left alone and unchanged packages are not reinstalled.

  Nothing is downloaded except through WinGet from its official "winget" source. The execution
  policy is only bypassed for this process (by Setup-Notflix.cmd); the system policy is unchanged.

.PARAMETER Yes
  Install missing software without asking (for unattended installs).

.PARAMETER DryRun
  Only report what is installed and what would be installed; change nothing.

.PARAMETER SkipBuild
  Check and install prerequisites only.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root
$Manifest = Join-Path $Root "requirements.winget"

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  [x]  $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "       $text" }

# Test seams (used by scripts\test-windows-install.mjs; never set them for a real install):
#   NOTFLIX_SETUP_SIMULATE_MISSING=node,ffmpeg   treat these commands as not installed
#   NOTFLIX_SETUP_SIMULATE_VERSION_node=20.1.0   pretend this version is installed
#   NOTFLIX_SETUP_SIMULATE_NO_WINGET=1           pretend WinGet is not available
$SimMissing = @(($env:NOTFLIX_SETUP_SIMULATE_MISSING + "").Split(",") | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })

function Find-Tool([string]$name) {
  if ($SimMissing -contains $name.ToLower()) { return $null }
  return Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-SimVersion([string]$name) {
  return [Environment]::GetEnvironmentVariable("NOTFLIX_SETUP_SIMULATE_VERSION_$name")
}

# "8.1.1-full_build-www.gyan.dev" -> 8.1.1; "N-118000-g..." (nightly) -> $null (cannot compare)
function ConvertTo-Version([string]$text) {
  $m = [regex]::Match("$text", '(\d+)\.(\d+)(?:\.(\d+))?')
  if (-not $m.Success) { return $null }
  $patch = if ($m.Groups[3].Success) { $m.Groups[3].Value } else { "0" }
  return [version]"$($m.Groups[1].Value).$($m.Groups[2].Value).$patch"
}

# --- Requirements, from requirements.winget ------------------------------------------------------
# Each package carries a "# notflix: command=... minVersion=..." comment before its resource.
function Read-Requirements {
  if (-not (Test-Path -LiteralPath $Manifest)) { throw "requirements.winget is missing from $Root. Download Notflix Debrid again." }
  $list = @()
  $meta = $null
  foreach ($line in Get-Content -LiteralPath $Manifest) {
    $c = [regex]::Match($line, '^\s*#\s*notflix:\s*(.+)$')
    if ($c.Success) {
      $meta = @{}
      foreach ($pair in $c.Groups[1].Value.Split(" ", [StringSplitOptions]::RemoveEmptyEntries)) {
        $kv = $pair.Split("=", 2)
        if ($kv.Count -eq 2) { $meta[$kv[0]] = $kv[1] }
      }
      continue
    }
    $d = [regex]::Match($line, '^\s+description:\s*(.+)$')
    if ($d.Success -and $meta) { $meta.description = $d.Groups[1].Value.Trim() }
    $i = [regex]::Match($line, '^\s{8,}id:\s*(\S+)\s*$')
    if ($i.Success -and $meta) {
      $list += [pscustomobject]@{
        Id          = $i.Groups[1].Value
        Commands    = @($meta.command.Split(","))
        MinVersion  = [version]$meta.minVersion
        Check       = $meta.check
        Description = $meta.description
      }
      $meta = $null
    }
  }
  if ($list.Count -lt 3) { throw "requirements.winget could not be read (found $($list.Count) packages)." }
  return $list
}

# Returns @{ Ok; Found; Version; Detail; Path }
function Test-Requirement($req) {
  $first = $req.Commands[0]
  foreach ($cmd in $req.Commands) {
    if (-not (Find-Tool $cmd)) { return @{ Ok = $false; Found = $false; Detail = "$cmd was not found" } }
  }
  $tool = Find-Tool $first
  $sim = Get-SimVersion $first
  try {
    if ($req.Check -eq "dotnet-sdk") {
      # The SDK (not only a runtime) is needed to build the media engine.
      $sdks = if ($sim) { @("$sim [simulated]") } else { @(& $tool.Source --list-sdks 2>$null) }
      $best = $sdks | ForEach-Object { ConvertTo-Version $_ } | Where-Object { $_ } | Sort-Object -Descending | Select-Object -First 1
      $ok = [bool]($sdks | Where-Object { (ConvertTo-Version $_) -and (ConvertTo-Version $_).Major -eq $req.MinVersion.Major })
      $detail = if ($ok) { ".NET SDK $(($sdks | Where-Object { (ConvertTo-Version $_).Major -eq $req.MinVersion.Major } | Select-Object -First 1).Split(' ')[0])" } elseif ($best) { "the .NET 10 SDK is missing (found SDK $best)" } else { "dotnet is installed but has no SDKs" }
      return @{ Ok = $ok; Found = $true; Version = $best; Detail = $detail; Path = $tool.Source }
    }
    $raw = if ($sim) { $sim } elseif ($first -eq "node") { (& $tool.Source --version) } else { (& $tool.Source -hide_banner -version 2>$null | Select-Object -First 1) }
    $v = ConvertTo-Version $raw
    if ($first -ne "node") {
      # FFmpeg nightlies have no version number; accept them, but say so.
      if (-not $v) { return @{ Ok = $true; Found = $true; Detail = "$first ($("$raw".Split(' ')[2]), development build)"; Path = $tool.Source } }
    }
    if (-not $v) { return @{ Ok = $false; Found = $true; Detail = "could not read the $first version"; Path = $tool.Source } }
    $ok = $v -ge $req.MinVersion
    $label = if ($first -eq "node") { "Node.js" } else { "FFmpeg" }
    $detail = if ($ok) { "$label $v" } else { "$label $v is too old (needs $($req.MinVersion) or newer)" }
    return @{ Ok = $ok; Found = $true; Version = $v; Detail = $detail; Path = $tool.Source }
  } catch {
    return @{ Ok = $false; Found = $true; Detail = "$first did not run: $($_.Exception.Message)"; Path = $tool.Source }
  }
}

# --- WinGet -----------------------------------------------------------------------------------------
function Get-WinGet {
  if ($env:NOTFLIX_SETUP_SIMULATE_NO_WINGET -eq "1") { return $null }
  $w = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $w) { return $null }
  try {
    $v = ConvertTo-Version (& $w.Source --version)
    # 1.6 is the first release with `configure` and the agreements flags used below.
    if (-not $v -or $v -lt [version]"1.6.0") { return $null }
    return @{ Path = $w.Source; Version = $v }
  } catch { return $null }
}

function Update-ProcessPath {
  # Installers change the machine/user PATH; this process still has the old copy.
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($p in (($machine + ";" + $user + ";" + $env:Path).Split(";"))) {
    if ($p -and -not $parts.Contains($p)) { $parts.Add($p) }
  }
  # Portable WinGet packages (FFmpeg) are linked here.
  $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
  if ((Test-Path -LiteralPath $links) -and -not $parts.Contains($links)) { $parts.Add($links) }
  $env:Path = ($parts -join ";")
}

function Show-ManualHelp($missing) {
  Write-Host ""
  Write-Host "  Install these yourself, then run Setup-Notflix.cmd again:" -ForegroundColor White
  foreach ($r in $missing) {
    switch ($r.Id) {
      "OpenJS.NodeJS.LTS" { Write-Info "- Node.js LTS (22 or newer): https://nodejs.org/en/download" }
      "Microsoft.DotNet.SDK.10" { Write-Info "- .NET 10 SDK: https://dotnet.microsoft.com/download/dotnet/10.0" }
      "Gyan.FFmpeg" { Write-Info "- FFmpeg full build: https://www.gyan.dev/ffmpeg/builds/ (add its bin folder to PATH)" }
      default { Write-Info "- $($r.Id)" }
    }
  }
  Write-Info "Or install WinGet (App Installer) from the Microsoft Store: https://aka.ms/getwinget"
}

# Known WinGet results that mean "nothing to do".
$WinGetAlreadyInstalled = @(-1978335189, -1978335135) # 0x8A15002B no applicable upgrade, 0x8A150061 already installed

function Install-Package($winget, $req, [bool]$upgrade) {
  Write-Step "Installing $($req.Description) [$($req.Id)]"
  $common = @("--id", $req.Id, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent")
  & $winget.Path install @common
  $code = $LASTEXITCODE
  if ($upgrade -and $WinGetAlreadyInstalled -contains $code) {
    # An older copy installed through WinGet: upgrade it in place instead of adding another.
    & $winget.Path upgrade @common
    $code = $LASTEXITCODE
  }
  if ($code -eq 0 -or $WinGetAlreadyInstalled -contains $code) { Write-Ok "$($req.Id) installed"; return $true }
  Write-Fail "WinGet could not install $($req.Id) (exit code $code)."
  if ($code -eq 1602 -or $code -eq 1223) { Write-Info "The installation was cancelled (administrator permission was not given)." }
  return $false
}

# --- Main ---------------------------------------------------------------------------------------------
try {
  Write-Host "Notflix Debrid setup" -ForegroundColor White
  Write-Info "Folder: $Root"
  if ($DryRun) { Write-Warn2 "Dry run: nothing will be installed or built." }

  Write-Step "Checking Windows"
  $os = [Environment]::OSVersion.Version
  if ([Environment]::OSVersion.Platform -ne "Win32NT") { throw "This installer is for Windows." }
  if ($os -lt [version]"10.0.17763") { throw "Windows $os is not supported. Notflix needs Windows 10 version 1809 or newer, or Windows 11." }
  if (-not [Environment]::Is64BitOperatingSystem) { throw "Notflix needs 64-bit Windows." }
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  Write-Ok "Windows $os ($arch)"
  if ($arch -eq "ARM64") { Write-Warn2 "ARM64: FFmpeg runs under x64 emulation; video conversion is slower." }
  if ($PSVersionTable.PSVersion -lt [version]"5.1") { throw "PowerShell 5.1 or newer is required." }

  # Building while Notflix runs would replace files the running server uses.
  if (-not $DryRun -and -not $SkipBuild -and (Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $Root "node_modules"))) {
    $running = $false
    try {
      $st = (& node (Join-Path $Root "scripts
otflix-cli.mjs") status 2>$null) | ConvertFrom-Json
      $running = [bool]($st.listening -and $st.listening.pid -and (Get-Process -Id $st.listening.pid -ErrorAction SilentlyContinue))
    } catch { $running = $false }
    if ($running) { throw "Notflix is running. Stop it first (double-click Stop-Notflix.cmd), then run setup again." }
  }

  Write-Step "Checking required software"
  $reqs = Read-Requirements
  $missing = @()
  foreach ($r in $reqs) {
    $s = Test-Requirement $r
    if ($s.Ok) { Write-Ok "$($s.Detail)$(if ($s.Path) { "  ($($s.Path))" })" }
    else { Write-Fail "$($r.Description): $($s.Detail)"; $missing += [pscustomobject]@{ Req = $r; State = $s } }
  }
  $git = Find-Tool "git"
  if ($git) { Write-Ok "Git (optional, for updates): $((& $git.Source --version) -replace '^git version ', '')" }
  else { Write-Info "Git is optional: only needed to download and update Notflix with git (https://git-scm.com)." }

  if ($missing.Count -gt 0) {
    # Too-old copies managed by a version manager must be updated there, or two would fight on PATH.
    foreach ($m in $missing) {
      if ($m.State.Found -and $m.State.Path -match '\\(nvm|nvm4w|fnm|volta|nodist)\\') {
        Write-Warn2 "Your Node.js is managed by a version manager ($($m.State.Path)). Install Node.js 22 or newer there (for nvm: nvm install lts, then nvm use lts) and run setup again."
        exit 1
      }
    }
    $winget = Get-WinGet
    if (-not $winget) {
      Write-Fail "WinGet (the Windows Package Manager) is not available on this computer, so the missing software cannot be installed automatically."
      Show-ManualHelp ($missing | ForEach-Object { $_.Req })
      exit 1
    }
    Write-Ok "WinGet $($winget.Version)"
    Write-Host ""
    Write-Host "  Setup will install with WinGet (official source):" -ForegroundColor White
    foreach ($m in $missing) { Write-Info "- $($m.Req.Description)  [$($m.Req.Id)]" }
    Write-Info "Windows may ask for administrator permission for some of them."
    if ($DryRun) {
      foreach ($m in $missing) { Write-Info "would run: winget install --id $($m.Req.Id) --exact --source winget" }
      Write-Ok "Dry run finished."
      exit 0
    }
    if (-not $Yes) {
      $answer = Read-Host "  Install now? [Y/N]"
      if ($answer -notmatch '^(y|yes)$') {
        Write-Warn2 "Nothing was installed."
        Show-ManualHelp ($missing | ForEach-Object { $_.Req })
        exit 1
      }
    }
    $allInstalled = $true
    foreach ($m in $missing) { if (-not (Install-Package $winget $m.Req ([bool]$m.State.Found))) { $allInstalled = $false } }
    Update-ProcessPath
    Write-Step "Checking again"
    $still = @()
    foreach ($r in $reqs) {
      $s = Test-Requirement $r
      if ($s.Ok) { Write-Ok $s.Detail } else { Write-Fail "$($r.Description): $($s.Detail)"; $still += $r }
    }
    if ($still.Count -gt 0) {
      if ($allInstalled) {
        Write-Warn2 "The software was installed, but this window cannot see it yet. Close this window and double-click Setup-Notflix.cmd again (or sign out of Windows and back in)."
      } else {
        Show-ManualHelp $still
      }
      exit 1
    }
  } elseif ($DryRun) {
    Write-Ok "Everything needed is installed. Dry run finished."
    exit 0
  }

  if ($SkipBuild) { Write-Ok "Prerequisites are ready."; exit 0 }

  # The existing build command: packages, media engine, web app, self-test videos, data folder.
  & (Join-Path $Root "scripts\notflix.ps1") setup
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
  Write-Ok "Notflix Debrid is installed. Double-click Start-Notflix.cmd to start it."
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  exit 1
}
