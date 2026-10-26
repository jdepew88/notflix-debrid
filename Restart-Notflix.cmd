@echo off
rem Double-click to restart this Notflix installation (its own web server and media engine) with the
rem data folder it used last. Optional: -DataDir <folder>  -NoBrowser
setlocal
set "NOTFLIX_HOME=%~dp0"
cd /d "%NOTFLIX_HOME%"
title Restart Notflix Debrid
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NOTFLIX_HOME%scripts\notflix.ps1" restart %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto ok
echo Notflix did not restart. Read the messages above.
if not defined NOTFLIX_NO_PAUSE pause
exit /b %RC%
:ok
echo Notflix keeps running in the background. You can close this window.
if not defined NOTFLIX_NO_PAUSE timeout /t 20
exit /b 0
