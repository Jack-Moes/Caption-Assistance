@echo off
setlocal
set "APPDIR=%~dp0Caption assistance-1.0.2-local"
set "PENDING=%APPDIR%\resources\app.asar.pending"
if exist "%PENDING%" (
  copy /Y "%PENDING%" "%APPDIR%\resources\app.asar" >nul
  if errorlevel 1 (
    echo Caption assistance is still running. Close every Caption assistance window, then run this file again.
    pause
    exit /b 1
  )
  del /Q "%PENDING%" >nul 2>&1
)
set "ELECTRON_RUN_AS_NODE="
start "" "%APPDIR%\Caption assistance.exe"
endlocal
