@echo off
rem ============================================================================
rem  Pivot Engine - one-click launcher (hardened)
rem  Double-click: finds a Node runtime, starts the kernel, opens the browser.
rem  All status lines are ASCII on purpose to avoid mojibake in the console.
rem  If anything fails, the window STAYS OPEN with a red message - read it,
rem  or screenshot it and send it to me.
rem ============================================================================
title Pivot Engine launcher
cd /d "%~dp0"

setlocal EnableExtensions
if "%PORT%"=="" set PORT=8787

echo.
echo ============================================================
echo    Pivot Engine  -  RPG kernel launcher
echo ============================================================
echo    Folder : %CD%
echo    Port   : %PORT%
echo.

rem ---------- 1. locate a Node runtime (dynamic, version-agnostic) ----------
set "NODEBIN="
where node >nul 2>nul
if not errorlevel 1 set "NODEBIN=node"

if not defined NODEBIN (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODEBIN if exist "%%D\node.exe" set "NODEBIN=%%D\node.exe"
  )
)
if not defined NODEBIN (
  for %%P in (
    "C:\Program Files\nodejs\node.exe"
    "%ProgramFiles%\nodejs\node.exe"
    "%LocalAppData%\Programs\nodejs\node.exe"
    "%USERPROFILE%\AppData\Roaming\nvm\v22.11.0\node.exe"
  ) do (
    if not defined NODEBIN if exist %%P set "NODEBIN=%%P"
  )
)
if not defined NODEBIN (
  echo [ERROR] No Node.js found on this PC.
  echo   Option A: install Node 22 LTS from https://nodejs.org , then re-run.
  echo   Option B: tell me, and I will bundle a portable Node next to the game.
  echo.
  pause
  exit /b 1
)
echo [ OK ] Node: %NODEBIN%
"%NODEBIN%" -v

"%NODEBIN%" -e "process.exit((parseInt(process.versions.node,10)>=18)?0:1)"
if errorlevel 1 (
  echo [ERROR] Node 18 or newer is required. Please upgrade Node.
  pause
  exit /b 1
)

rem ---------- 2. server.js present? ----------
if not exist "%CD%\server.js" (
  echo [ERROR] server.js is missing from this folder.
  echo   Keep this .bat in the same folder as server.js.
  pause
  exit /b 1
)

rem ---------- 3. port already in use? ----------
netstat -ano 2>nul | findstr /R /C:":%PORT% " | findstr /I "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [WARN] Port %PORT% is already in use - a server may already be running.
  echo   Opening the browser now. If the page is blank, close the other
  echo   instance first (or set PORT=8899 and re-run), then try again.
  echo.
  start "" "http://127.0.0.1:%PORT%"
  pause
  exit /b 0
)

rem ---------- 4. start server + open browser ----------
echo.
echo   Starting server... (this black window IS the server - keep it open)
echo   Your browser will open to: http://127.0.0.1:%PORT%
echo   If the browser does not open, just visit that address by hand.
echo   If the page is blank for a moment, press F5 to refresh.
echo.
start "" "http://127.0.0.1:%PORT%"
"%NODEBIN%" server.js
set RC=%errorlevel%

echo.
if not "%RC%"=="0" (
  echo [ERROR] Server stopped with code %RC%.
  echo   Common causes: the port is blocked, or a file under data\ is broken.
  echo   Fix: delete the folder  data\cache  , then re-run this launcher.
  echo   Still stuck? Screenshot this red text and send it to me.
  echo.
  pause
  exit /b %RC%
)
echo [INFO] Server stopped.
pause
