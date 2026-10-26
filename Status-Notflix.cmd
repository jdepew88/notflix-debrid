@echo off
rem Double-click to see whether this Notflix installation is running: its processes, addresses and
rem data folder, and any other Notflix servers started from this folder. Changes nothing.
setlocal
set "NOTFLIX_HOME=%~dp0"
cd /d "%NOTFLIX_HOME%"
title Notflix Debrid status
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NOTFLIX_HOME%scripts\notflix.ps1" status %*
set "RC=%ERRORLEVEL%"
echo.
if not defined NOTFLIX_NO_PAUSE pause
exit /b %RC%
