@echo off
rem Start de server. Dit roept scripts\start.ps1 aan met een uitzondering op het scriptbeleid van Windows
rem die alleen voor deze ene start geldt; je systeeminstellingen blijven ongewijzigd.
rem Dubbelklikken werkt, of in een terminal:  .\start.cmd   (opties zoals -Port 8788 worden doorgegeven)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
echo.
pause
