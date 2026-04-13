@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-natively-dev.ps1" %*
exit /b %errorlevel%
