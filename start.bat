@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required. Install Node.js 20.17 or newer and try again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm is required but was not found on PATH.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Dependencies are not installed. Run npm ci first.
    pause
    exit /b 1
)

start "ORION server" cmd /k "cd /d ""%~dp0"" && npm start"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

endlocal
