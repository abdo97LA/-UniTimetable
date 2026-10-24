@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Telechargez la version LTS sur https://nodejs.org puis relancez ce fichier.
  pause
  exit /b
)
if "%ADMIN_PASSWORD%"=="" set /p ADMIN_PASSWORD=Choisissez le mot de passe administrateur - 8 caracteres minimum, lettres et chiffres seulement : 
echo.
echo Demarrage du serveur... Laissez cette fenetre ouverte. Adresse : http://localhost:8787
echo.
node server.js
pause
