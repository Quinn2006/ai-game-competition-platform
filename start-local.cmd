@echo off
setlocal
where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required. Please install it and retry.
  pause
  exit /b 1
)
pwsh -NoProfile -File "%~dp0start-local.ps1" %*
set "launchResult=%errorlevel%"
pause
exit /b %launchResult%
