@echo off
setlocal
rem Le script s'execute depuis une COPIE dans %TEMP% : cmd lit un .cmd par position dans le fichier, et
rem l'etape 2 (git reset --hard) reecrit publier.cmd lui-meme, ce qui ferait derailler la lecture.
if /i not "%~dp0"=="%TEMP%\" (
  copy /y "%~f0" "%TEMP%\kairos_publier.cmd" >nul
  call "%TEMP%\kairos_publier.cmd" "%~dp0"
  exit /b
)
cd /d "%~1"
echo [script execute depuis %~f0]
echo [dossier : %CD%]
rem ============================================================================
rem  Publication du portail Kairos (fichiers prepares par Claude dans ce dossier)
rem  Sans "git stash" (fragile sous Windows a cause des fins de ligne) :
rem   1. copie des fichiers prepares dans un dossier temporaire
rem   2. remise du depot a l'etat exact de GitHub (git reset --hard origin/main)
rem   3. recopie des fichiers prepares par-dessus
rem   4. commit + push
rem ============================================================================
git config core.autocrlf false
git config core.safecrlf false

rem Le dossier .github est protege : Claude depose les workflows dans "Claude outputs"
if not exist ".github\workflows" mkdir ".github\workflows"
for %%f in ("Claude outputs\*.yml") do move /y "%%f" ".github\workflows\" >nul

set PREP=%TEMP%\kairos_prep
if exist "%PREP%" rmdir /s /q "%PREP%"
mkdir "%PREP%\workflows"
echo === 1/4 Copie des fichiers prepares ===
for %%f in (index.html template.html update.py veille.py veille_notion.py contenu.js sw.js manifest.webmanifest publier.cmd icon-192.png icon-512.png icon-512-maskable.png favicon.svg .gitignore) do (
  if exist "%%f" copy /y "%%f" "%PREP%\" >nul
)
copy /y ".github\workflows\*.yml" "%PREP%\workflows\" >nul
rem donnees.js, meta.js et veille.js sont produits par les Actions / taches planifiees : on ne les reprend que s'ils manquent sur GitHub
mkdir "%PREP%\donnees"
for %%f in (donnees.js meta.js veille.js) do if exist "%%f" copy /y "%%f" "%PREP%\donnees\" >nul

echo === 2/4 Synchronisation avec GitHub ===
git stash clear 2>nul
git fetch origin || goto err
git reset -q --hard origin/main || goto err

echo === 3/4 Reprise des fichiers prepares ===
copy /y "%PREP%\*" "." >nul
copy /y "%PREP%\workflows\*.yml" ".github\workflows\" >nul
for %%f in (donnees.js meta.js veille.js) do if not exist "%%f" if exist "%PREP%\donnees\%%f" copy /y "%PREP%\donnees\%%f" "." >nul
rem Anciens fichiers de donnees (remplaces par donnees.js / contenu.js / meta.js)
if exist contenu.enc del /q contenu.enc
if exist donnees.enc del /q donnees.enc
git rm -r -q --cached "Claude outputs" 2>nul

echo === 4/4 Commit et push ===
git add -A
git diff --cached --quiet && echo Rien de nouveau a valider. && goto end
git commit -q -m "Mise a jour du portail (Claude) %date% %time:~0,5%" || goto err
git push || goto err
echo.
echo === OK : publie sur GitHub, le site sera a jour dans 1-2 minutes ===
goto end
:err
echo.
echo !!! Une commande a echoue, ne rien faire de plus, montre cette fenetre a Claude.
:end
rmdir /s /q "%PREP%" 2>nul
pause
