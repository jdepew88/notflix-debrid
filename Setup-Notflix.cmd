@echo off
rem Double-click to install Notflix Debrid: checks Node.js, .NET 10 SDK and FFmpeg, offers to
rem install what is missing with WinGet (asks first), then builds Notflix.
rem The PowerShell execution policy is bypassed for this one process only; the system setting is not changed.
setlocal
set "NOTFLIX_HOME=%~dp0"
cd /d "%NOTFLIX_HOME%"
title Notflix Debrid setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NOTFLIX_HOME%setup.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto ok
echo Setup did not finish. Read the messages above, fix the problem, and double-click Setup-Notflix.cmd again.
if not defined NOTFLIX_NO_PAUSE pause
exit /b %RC%
:ok
echo Setup finished. Next: double-click Start-Notflix.cmd
if not defined NOTFLIX_NO_PAUSE pause
exit /b 0
