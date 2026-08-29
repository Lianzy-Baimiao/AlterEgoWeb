@echo off
rem ===========================================================================
rem  WowAltBoard launcher
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
  echo  SCAN FAILED - the SCAN_ERROR line above says which case it is:
  echo.
  echo    NO_WOW           set wowPaths in tools\config.json
  echo    NO_ADDON         the AlterEgo addon is not installed
  echo    ADDON_BROKEN     unpacked one folder too deep, no .toc
  echo    ADDON_DISABLED   tick AlterEgo in the in-game AddOns list
  echo    NO_CHARACTER     log a character in once, then exit
  echo    NO_SAVEDVARS     log in, then /reload or exit the game
  echo    SV_UNREADABLE    fully exit the game, then try again
  echo.
  echo  The .exe in this folder explains each of these in Chinese,
  echo  with the exact steps and a retry button. Use it instead.
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
