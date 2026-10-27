#!/usr/bin/env python3
"""Objectifs des filleuls en attente de validation (update.objectifs_en_attente), sans réseau.

Le parrain voit dans les actions de la semaine « Valider les objectifs de mes filleuls » quand un
filleul direct a déclaré des objectifs que personne n'a encore validés (27/10/2026). Les statuts sont
ceux du réseau : VALIDÉ, EN ATTENTE, REFUSÉ. Un membre dont la lecture échoue ne doit pas être compté
« zéro » : il est absent du résultat et garde la valeur du passage précédent.

    python tests/objectifs_attente.py
"""
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RACINE))
import update                                          # noqa: E402

essais, echecs = 0, []


def verifie(nom, condition, detail=""):
    global essais
    essais += 1
    if not condition:
        echecs.append(f"{nom}{' — ' + detail if detail else ''}")


DECLARES = {
    1: [{"status": "VALIDÉ"}, {"status": "EN ATTENTE"}, {"status": "En attente de validation"}, {"status": "REFUSÉ"}],
    2: [{"status": "VALIDÉ"}],
    3: [],
}


def faux_pages(api, endpoint, params):
    assert endpoint == "goal_finisheds"
    uid = params["user"]
    if uid == 4:
        raise RuntimeError("API en panne pour ce membre")
    return DECLARES[uid]


update._pages = faux_pages
r = update.objectifs_en_attente("https://api.test", [1, 2, 3, 4])
verifie("deux objectifs en attente pour le membre 1", r.get(1) == 2, str(r))
verifie("validés et refusés ne comptent pas", r.get(2) == 0, str(r))
verifie("aucun objectif déclaré", r.get(3) == 0, str(r))
verifie("lecture en échec : absent, pas zéro", 4 not in r, str(r))

if echecs:
    print(f"objectifs en attente : {len(echecs)} échec(s) sur {essais}")
    for e in echecs:
        print("  ✘ " + e)
    sys.exit(1)
print(f"objectifs en attente : {essais} vérifications vertes")
