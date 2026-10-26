@echo off
rem Double-click to stop this Notflix installation (only its own web server and media engine), also
rem when the window that started it was closed. Optional: -DataDir <folder>   -All (also servers
rem started from this folder with other data folders)
setlocal
set "NOTFLIX_HOME=%~dp0"
cd /d "%NOTFLIX_HOME%"
title Stop Notflix Debrid
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NOTFLIX_HOME%scripts\notflix.ps1" stop %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto ok
echo Notflix could not be stopped completely. Read the messages above.
if not defined NOTFLIX_NO_PAUSE pause
exit /b %RC%
:ok
if not defined NOTFLIX_NO_PAUSE timeout /t 10
exit /b 0
