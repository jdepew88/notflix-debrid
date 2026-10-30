@echo off
rem Double-click to start Notflix (media engine + web server) and open it in your browser. This
rem window closes by itself once Notflix is running; it stays open if something went wrong.
rem When Notflix is already running it just opens the website again.
rem Opens first-run setup until it is finished; afterwards the normal sign-in page.
rem Optional: Start-Notflix.cmd -Port 8430   (use another port)   -NoBrowser   -DataDir <folder>
rem The data folder is remembered: later starts, stops and restarts use it without -DataDir.
setlocal
set "NOTFLIX_HOME=%~dp0"
cd /d "%NOTFLIX_HOME%"
title Notflix Debrid
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NOTFLIX_HOME%scripts\notflix.ps1" start %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto ok
echo Notflix did not start. Read the messages above. They are also saved in %LOCALAPPDATA%\NotflixDebrid\launcher.log
if not defined NOTFLIX_NO_PAUSE pause
exit /b %RC%
:ok
exit /b 0
