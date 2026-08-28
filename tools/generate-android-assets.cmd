@echo off
setlocal
cd /d "%~dp0.."
call npm run assets
if errorlevel 1 exit /b 1
echo Android assets generated. Next: npm run android:sync
