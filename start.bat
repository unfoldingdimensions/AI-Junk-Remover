@echo off
rem AI Tools Junk Remover — start the local WebUI (http://127.0.0.1:8765)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Install from https://nodejs.org & pause & exit /b 1)
node server.mjs
pause
