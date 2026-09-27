#!/usr/bin/env python3
"""Tests de la lecture des séances (update.list_all) face à la pagination instable de l'API.

Constaté le 28/09/2026 : pour les ateliers, l'API annonce 485 séances et en renvoie bien 485 lignes
au fil des pages, mais seulement 476 distinctes — 9 doublons, et 9 séances jamais servies, dont la
Découverte Métier du 26/09 à Vigneux (Loubna, Jordan, Ségolène, filleuls de Florian). Ces tests
simulent exactement cela, sans réseau : la pagination rend des doublons à la place de séances,
les fenêtres de 7 jours, elles, rendent tout.

    python tests/pagination.py
"""
import datetime
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


# 70 séances, 3 par jour à partir du 01/09/2026
DEBUT = datetime.date(2026, 9, 1)
SEANCES = [{"id": 1000 + i, "startDate": (DEBUT + datetime.timedelta(days=i // 3)).isoformat() + "T00:00:00+00:00"}
           for i in range(70)]
CACHEES = {1005, 1031, 1062}                      # jamais servies par la pagination


def faux_get(url, params=None, tries=4):
    p = params or {}
    page = int(p.get("page", 1))
    if "startDate[strictly_before]" in p:           # fenêtre de dates : réponse complète
        a, b = p["startDate[after]"][:10], p["startDate[strictly_before]"][:10]
        lot = [s for s in SEANCES if a <= s["startDate"][:10] < b]
        return lot[(page - 1) * 30: page * 30]
    # pagination « classique » : chaque séance cachée est remplacée par un doublon de la précédente
    vues = []
    for s in SEANCES:
        if s["startDate"][:10] < p.get("startDate[after]", "0000")[:10]:
            continue
        vues.append(vues[-1] if s["id"] in CACHEES and vues else s)
    return vues[(page - 1) * 30: page * 30]


update.get = faux_get
lu = update.list_all("https://api.invalid", "workshops", "2026-09-01")
ids = [x["id"] for x in lu]
verifie("aucune séance perdue", set(ids) == {s["id"] for s in SEANCES},
        f"manquent {sorted({s['id'] for s in SEANCES} - set(ids))}")
verifie("aucun doublon", len(ids) == len(set(ids)), f"{len(ids)} lignes pour {len(set(ids))} séances")
verifie("les séances cachées sont rattrapées", CACHEES <= set(ids))

# Point de départ dans le passé récent (fenêtre de 30 jours du passage rapide) : rien avant n'est demandé
lu = update.list_all("https://api.invalid", "workshops", "2026-09-10")
verifie("borne de départ respectée", all(x["startDate"][:10] >= "2026-09-10" for x in lu))
verifie("séances cachées après la borne rattrapées", {1031, 1062} <= {x["id"] for x in lu})

print(f"{essais - len(echecs)}/{essais} vérifications au vert")
if echecs:
    print("ÉCHECS :")
    for e in echecs:
        print(" -", e)
    sys.exit(1)
