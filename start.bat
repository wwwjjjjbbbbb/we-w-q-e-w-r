@echo off
chcp 65001 >nul
cd /d "%~dp0"
title EYEWALL
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS build from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo Starting EYEWALL ...
echo Your browser will open http://localhost:3000   (closing this window stops the server)
start "" http://localhost:3000
node server.js
pause
