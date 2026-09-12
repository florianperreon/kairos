@echo off
cd /d "%~dp0"
echo === Mise de cote des fichiers modifies ===
git reset -q -- contenu.enc 2>nul
git ls-files --error-unmatch contenu.enc >nul 2>nul || git add contenu.enc
git update-index -q --refresh
for /f %%i in ('git stash list ^| find /c /v ""') do set N0=%%i
git stash push -- index.html template.html update.py contenu.enc || goto err
for /f %%i in ('git stash list ^| find /c /v ""') do set N1=%%i
echo === git pull ===
git pull --ff-only || goto err
if "%N1%"=="%N0%" (
  echo Aucun fichier prepare par Claude a reprendre.
) else (
  echo === Reprise des fichiers prepares par Claude ===
  git checkout stash@{0} -- index.html template.html update.py contenu.enc || goto err
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
