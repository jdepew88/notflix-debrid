@echo off
rem Double-click to start Notflix (media engine + web server) and open it in your browser.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\notflix.ps1" start %*
echo.
pause
