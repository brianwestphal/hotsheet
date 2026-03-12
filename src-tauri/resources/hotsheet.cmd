@echo off
REM CLI launcher for Hot Sheet desktop app (Windows).
REM Add the directory containing this file to your PATH.

set "SCRIPT_DIR=%~dp0"
set "DATA_DIR=%CD%\.hotsheet"
set "BROWSER_MODE=0"

:parse_args
if "%~1"=="" goto done_args
if "%~1"=="--data-dir" (
    set "DATA_DIR=%~2"
    shift
    shift
    goto parse_args
)
if "%~1"=="--browser" (
    set "BROWSER_MODE=1"
    shift
    goto parse_args
)
shift
goto parse_args

:done_args

if "%BROWSER_MODE%"=="1" (
    "%SCRIPT_DIR%..\bin\hotsheet-node.exe" "%SCRIPT_DIR%cli.js" --no-open --data-dir "%DATA_DIR%" %*
) else (
    start "" "%SCRIPT_DIR%..\bin\hotsheet.exe" --data-dir "%DATA_DIR%" %*
)
