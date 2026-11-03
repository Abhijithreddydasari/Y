@echo off
REM Production web deploy from a copy outside git (the Hobby team blocks commit authors it does not know).
REM Run from the repo root after `vercel login`. Environment variables stay on the Vercel project.
setlocal
set "OUT=%TEMP%\y-web"
if exist "%OUT%" rmdir /s /q "%OUT%"
robocopy web "%OUT%" /E /XD node_modules .next /XF .env.local tsconfig.tsbuildinfo /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (echo Copy failed & exit /b 1)
pushd "%OUT%"
call vercel --prod
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
