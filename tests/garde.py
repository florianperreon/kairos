#!/usr/bin/env python3
"""Garde-fou de la page publiée — quelques secondes, aucune dépendance.

Lancé par la GitHub Action AVANT de valider index.html : une page qui ne passe pas ici
n'est jamais poussée. Les tests Playwright (tests/portail.spec.js) vont beaucoup plus loin,
mais demandent un navigateur ; ce garde-fou attrape ce qui casse tout : une erreur de syntaxe
JavaScript, une substitution ratée, un onglet déclaré sans sa section.

    python tests/garde.py [chemin/index.html]
"""
import json, re, subprocess, sys, tempfile
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
page = Path(sys.argv[1]) if len(sys.argv) > 1 else RACINE / "index.html"
src = page.read_text(encoding="utf-8")
soucis = []

# 1. La substitution a bien eu lieu
if "__CENC__" in src:
    soucis.append("__CENC__ est encore dans la page : la génération depuis template.html a échoué")

# 2. Le JavaScript parse — c'est la panne qui rend le portail totalement muet
blocs = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", src, re.S)
if not blocs:
    soucis.append("aucun bloc <script> trouvé dans la page")
else:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write("\n;\n".join(blocs))
        tmp = f.name
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    if r.returncode != 0:
        soucis.append("erreur de syntaxe JavaScript :\n" + (r.stderr or r.stdout).strip()[:1200])

# 3. Chaque onglet déclaré a sa section, son entrée de menu et un slug
m = re.search(r"const TABS=\[(.*?)\];", src, re.S)
if not m:
    soucis.append("la liste des onglets (TABS) est introuvable")
else:
    onglets = re.findall(r"'([a-z]+)'", m.group(1))
    slugs = dict(re.findall(r"(\w+):'([a-z0-9-]+)'", re.search(r"const TAB_SLUG=\{(.*?)\};", src, re.S).group(1)))
    for t in onglets:
        if f'id="v-{t}"' not in src:
            soucis.append(f"onglet « {t} » : la section id=\"v-{t}\" est absente")
        if f'data-v="{t}"' not in src:
            soucis.append(f"onglet « {t} » : aucune entrée de menu")
        if t not in slugs:
            soucis.append(f"onglet « {t} » : aucune adresse (TAB_SLUG)")
    vus = {}
    for t, s in slugs.items():
        if s in vus:
            soucis.append(f"adresse « #{s} » utilisée par {vus[s]} et {t}")
        vus[s] = t

# 4. Audit de confidentialité (le même que celui d'update.py, en plus court)
if re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", src, re.I):
    soucis.append("une adresse e-mail apparaît en clair dans la page")
if re.search(r"(?<!\d)0[1-9](?:[ .-]?\d\d){4}(?!\d)", src):
    soucis.append("un numéro de téléphone apparaît en clair dans la page")
if "forman_id" in src.lower():
    soucis.append("« forman_id » apparaît dans la page (colonne à nommer membre_id)")

# 5. Pas de date calendaire calculée en UTC (le décalage d'un jour du 14/09/2026)
if "toISOString().slice(0,10)" in src:
    soucis.append("toISOString().slice(0,10) : une date calendaire est calculée en UTC, "
                  "elle recule d'un jour dans les fuseaux en avance (utiliser isoJour)")

if soucis:
    print("Garde-fou : %d problème(s) — la page n'est PAS publiable\n" % len(soucis))
    for s in soucis:
        print("  ✘ " + s)
    sys.exit(1)

print("Garde-fou : page saine (%d onglets, %d Ko)" % (len(onglets), len(src) // 1024))
