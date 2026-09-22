@echo off
setlocal
title 3DJobComposer Launcher

cd /d "%~dp0"

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo.
  echo [ERROR] A standalone Node.js installation was not found.
  echo Install the Windows Node.js LTS release, then run this file again.
  echo Codex's internal Node.js runtime is intentionally not used because
  echo it may not have permission to create Jobs outside the workspace.
  echo.
  pause
  exit /b 1
)

echo Starting 3DJobComposer...
echo Node runtime: %NODE_EXE%
start "3DJobComposer Server" "%NODE_EXE%" src\server\server.js

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"

endlocal
exit /b 0
