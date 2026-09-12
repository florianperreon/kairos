@echo off
cd /d "%~dp0"
echo === Mise de cote des fichiers modifies ===
git stash push -- index.html template.html || goto err
echo === git pull ===
git pull --ff-only || goto err
echo === Reprise des fichiers fusionnes (nouveau template + donnees du jour) ===
git checkout stash@{0} -- index.html template.html || goto err
git stash drop
git add -A
git commit -m "Filleuls/manages : adherents mis en avant, autres en note membres invites" || goto err
git push || goto err
echo.
echo === OK : publie sur GitHub, le site sera a jour dans 1-2 minutes ===
goto end
:err
echo.
echo !!! Une commande a echoue, ne rien faire de plus, montre cette fenetre a Claude.
:end
pause
