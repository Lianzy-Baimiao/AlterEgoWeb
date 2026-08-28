@echo off
rem ===========================================================================
rem  AlterEgoWeb launcher
rem
rem  Contents are deliberately pure ASCII. The console codepage on this machine
rem  is 936 (GB2312); Chinese text inside a .bat is decoded with that codepage
rem  and mangles, and forcing chcp 65001 hits cmd's well-known UTF-8 batch bugs.
rem  All Chinese user-facing text lives in index.html instead. The FILENAME may
rem  be Chinese -- NTFS stores it as UTF-16, so that is safe.
rem
rem  %~dp0 is used instead of a relative path: double-clicking from Explorer
rem  usually sets CWD to this folder, but "Run as administrator" gives
rem  C:\Windows\System32 and a shortcut gives whatever its "Start in" says.
rem ===========================================================================

setlocal
set "HERE=%~dp0"

echo.
echo Scanning World of Warcraft for AlterEgo data...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%tools\scan.ps1"

rem scan.ps1 sets $ErrorActionPreference='Stop' and exits 1 on failure. Without
rem that, powershell -File returns 0 even on non-terminating errors and we would
rem cheerfully open a stale dashboard.
if errorlevel 1 (
  echo.
  echo ---------------------------------------------------------------
  echo  SCAN FAILED - see the message above.
  echo.
  echo  Most likely fix: edit tools\config.json and set wowPaths, e.g.
  echo    { "wowPaths": ["E:\\World of Warcraft"] }
  echo ---------------------------------------------------------------
  echo.
  pause
  exit /b 1
)

rem Pass the plain filesystem path, not a file:/// URL. This routes through the
rem .html file association (correct) rather than the http one, and lets the
rem browser do the path-to-URL conversion so a '#' in the path is encoded right.
start "" "%HERE%index.html"

endlocal
