@echo off
rem Double-click to stop Notflix.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\notflix.ps1" stop
echo.
pause
