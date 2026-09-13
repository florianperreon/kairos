@echo off
cd /d "%~dp0"
rem Le dossier .github est protege : Claude depose le workflow dans "Claude outputs", on le met en place ici
if not exist ".github\workflows" mkdir ".github\workflows"
for %%f in ("Claude outputs\*.yml") do move /y "%%f" ".github\workflows\" >nul
git add .github/workflows 2>nul
echo === Mise de cote des fichiers modifies ===
rem Anciens fichiers de donnees (remplaces par donnees.js / contenu.js / meta.js)
if exist contenu.enc del /q contenu.enc
if exist donnees.enc del /q donnees.enc
git reset -q -- contenu.js donnees.js meta.js 2>nul
for %%f in (contenu.js donnees.js meta.js) do git ls-files --error-unmatch %%f >nul 2>nul || git add %%f
git update-index -q --refresh
for /f %%i in ('git stash list ^| find /c /v ""') do set N0=%%i
git stash push -- index.html template.html update.py contenu.js donnees.js meta.js .github/workflows || goto err
for /f %%i in ('git stash list ^| find /c /v ""') do set N1=%%i
echo === git pull ===
git pull --ff-only || goto err
if "%N1%"=="%N0%" (
  echo Aucun fichier prepare par Claude a reprendre.
) else (
  echo === Reprise des fichiers prepares par Claude ===
  git checkout stash@{0} -- index.html template.html update.py contenu.js donnees.js meta.js .github/workflows || goto err
  git stash drop
)
git rm -r -q --cached "Claude outputs" 2>nul
git add -A
git diff --cached --quiet && echo Rien de nouveau a valider. || git commit -m "Mise a jour du portail (Claude) %date% %time:~0,5%" || goto err
echo === git push ===
git push || goto err
echo.
echo === OK : publie sur GitHub, le site sera a jour dans 1-2 minutes ===
goto end
:err
echo.
echo !!! Une commande a echoue, ne rien faire de plus, montre cette fenetre a Claude.
:end
pause
