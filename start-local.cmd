@echo off
setlocal
where pwsh >nul 2>nul
if errorlevel 1 (
  set "shellExe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
) else (
  set "shellExe=pwsh"
)
"%shellExe%" -NoProfile -File "%~dp0start-local.ps1" %*
set "launchResult=%errorlevel%"
pause
exit /b %launchResult%
