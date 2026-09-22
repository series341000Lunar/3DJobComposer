@echo off
setlocal
title Stop All Node.js Processes

echo Stopping all node.exe processes...
"%SystemRoot%\System32\taskkill.exe" /F /IM node.exe
set "KILL_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%KILL_EXIT_CODE%"=="0" echo Check the result above. If access is denied, run this BAT as administrator.
pause
exit /b %KILL_EXIT_CODE%
