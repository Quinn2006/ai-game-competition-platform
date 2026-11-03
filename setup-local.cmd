@echo off
setlocal
where pwsh >nul 2>nul
if errorlevel 1 (
  set "shellExe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
) else (
  set "shellExe=pwsh"
)
"%shellExe%" -NoProfile -File "%~dp0scripts\setup-local.ps1" %*
set "setupResult=%errorlevel%"
pause
exit /b %setupResult%
