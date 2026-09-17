#!/usr/bin/env python3
"""Tests du relevé des vacances scolaires (update.calendrier_scolaire).

L'API de data.education.gouv.fr donne les vacances comme des intervalles UTC dont la fin est le
jour de REPRISE ; le portail attend des bornes calendaires « du premier au dernier jour sans
classe ». Ce passage n'a aucun filet côté navigateur : une erreur d'un jour décalerait tous les
rubans « vacances ». Ces tests tournent sans réseau (la réponse de l'API est simulée).

    python tests/calendrier.py
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


# Réponse réelle de l'API (extrait du 17/09/2026), telle qu'elle arrive : UTC, fin = reprise
REPONSE = {"results": [
    {"description": "Vacances de la Toussaint", "start_date": "2026-10-16T22:00:00+00:00", "end_date": "2026-11-01T23:00:00+00:00", "zones": "Zone B", "annee_scolaire": "2026-2027"},
    {"description": "Vacances de Noël", "start_date": "2026-12-18T23:00:00+00:00", "end_date": "2027-01-03T23:00:00+00:00", "zones": "Zone B", "annee_scolaire": "2026-2027"},
    {"description": "Vacances d'Hiver", "start_date": "2027-02-19T23:00:00+00:00", "end_date": "2027-03-07T23:00:00+00:00", "zones": "Zone B", "annee_scolaire": "2026-2027"},
    {"description": "Vacances d'Hiver", "start_date": "2027-02-05T23:00:00+00:00", "end_date": "2027-02-21T23:00:00+00:00", "zones": "Zone C", "annee_scolaire": "2026-2027"},
    {"description": "Pont de l'Ascension", "start_date": "2027-05-06T22:00:00+00:00", "end_date": "2027-05-06T22:00:00+00:00", "zones": "Zone B", "annee_scolaire": "2026-2027"},
    {"description": "Début des Vacances d'Été", "start_date": "2027-07-02T22:00:00+00:00", "end_date": "2027-07-02T22:00:00+00:00", "zones": "Zone B", "annee_scolaire": "2026-2027"},
    {"description": "Vacances de Noël", "start_date": "2026-12-18T23:00:00+00:00", "end_date": "2027-01-03T23:00:00+00:00", "zones": "Corse", "annee_scolaire": "2026-2027"},
]}
appels = []


class Reponse:
    def __init__(self, data): self.data = data
    def raise_for_status(self): pass
    def json(self): return self.data


def faux_get(url, params=None, timeout=None):
    appels.append(params)
    return Reponse(REPONSE)


update.requests.get = faux_get
cal = update.calendrier_scolaire(datetime.date(2026, 9, 17))
B = {v["nom"]: (v["du"], v["au"]) for v in cal["zones"]["B"]}

# 1. Les bornes : UTC → Paris, et la fin devient la veille de la reprise
verifie("Toussaint : samedi 17 octobre → dimanche 1er novembre", B["Vacances de la Toussaint"] == ("2026-10-17", "2026-11-01"), str(B))
verifie("Noël : le passage d'année et le décalage horaire d'hiver", B["Vacances de Noël"] == ("2026-12-19", "2027-01-03"), str(B))
verifie("Hiver B : 20 février → 7 mars", B["Vacances d'Hiver"] == ("2027-02-20", "2027-03-07"), str(B))

# 2. Les cas particuliers
verifie("le pont de l'Ascension court jusqu'au dimanche", B["Pont de l'Ascension"] == ("2027-05-07", "2027-05-09"), str(B))
verifie("l'été va du 3 juillet au 31 août", B["Vacances d'été"] == ("2027-07-03", "2027-08-31"), str(B))

# 3. Les zones : C reçue, A vide, la Corse ignorée
verifie("zone C : ses propres dates d'hiver", [(v["du"], v["au"]) for v in cal["zones"]["C"]] == [("2027-02-06", "2027-02-21")], str(cal["zones"]["C"]))
verifie("zone A absente de la réponse → liste vide, pas d'erreur", cal["zones"]["A"] == [])
verifie("la Corse n'entre dans aucune zone", all("Corse" not in str(v) for z in cal["zones"].values() for v in z))
verifie("les listes sont triées par date", [v["du"] for v in cal["zones"]["B"]] == sorted(v["du"] for v in cal["zones"]["B"]))
verifie("les années relevées sont annoncées", cal["annees"] == ["2026-2027"] and cal["maj"] == "2026-09-17", str(cal["annees"]))

# 4. La requête : l'année scolaire en cours (bascule au 1er août), la précédente et les deux suivantes
verifie("années demandées depuis septembre 2026", all(a in appels[-1]["where"] for a in ("2025-2026", "2026-2027", "2027-2028", "2028-2029")), appels[-1]["where"])
update.calendrier_scolaire(datetime.date(2027, 6, 1))
verifie("en juin 2027 on est encore en 2026-2027", "'2025-2026'" in appels[-1]["where"] and "'2029-2030'" not in appels[-1]["where"], appels[-1]["where"])

# 5. Une réponse vide est une erreur (pour que run() garde la valeur précédente au lieu d'écrire du vide)
REPONSE["results"] = []
try:
    update.calendrier_scolaire(datetime.date(2026, 9, 17))
    verifie("réponse vide → exception", False)
except RuntimeError:
    verifie("réponse vide → exception", True)

print(f"{essais - len(echecs)}/{essais} vérifications au vert")
if echecs:
    print("ÉCHECS :")
    for e in echecs:
        print(" -", e)
    sys.exit(1)
