#!/usr/bin/env python3
"""Tests de la détection des nouveautés (update.nouveautes).

L'API FORMAN ne donne aucune date de création sur les séances : ce qui est « nouveau » est déduit
en comparant le passage courant au payload précédent. Cette logique n'a aucun filet côté navigateur
— si elle se trompe, le portail affiche des nouveautés fausses sans que rien ne casse. D'où ces
tests, qui tournent sans réseau et sans navigateur.

    python tests/nouveautes.py
"""
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RACINE))
import update                                          # noqa: E402

AUJ = "2026-09-14"
H = "2026-09-14T10:00:00Z"
LIMITE = "2026-07-16"                                   # AUJ - 60 jours

# Un atelier : [id, thématique, titre, début, fin, lieu, pilotes, horaires,
#               site, max, inscrits, invités, attente, lien, mdp, public, habilitation]
def atelier(i, titre="Atelier", debut="2026-10-01", lieu="Visio", pil="Diane P.",
            hor="09:00 - 12:00", site=None, mx=20, tot=5):
    return [i, "COMMUNICATION", titre, debut, debut, lieu, pil, hor,
            site, mx, tot, [], [], "", "", "", ""]

# Une réunion / formation / événement : même forme, sans la thématique
def autre(i, titre="Réunion", debut="2026-10-01", lieu="Visio", pil="", hor="20:00 - 21:30",
          site=None, mx=30, tot=4):
    return [i, titre, debut, debut, lieu, pil, hor, site, mx, tot, [], [], "", "", "", ""]

VIDE = {"reu": [], "for": [], "evt": []}
essais, echecs = 0, []


def verifie(nom, condition, detail=""):
    global essais
    essais += 1
    if not condition:
        echecs.append(f"{nom}{' — ' + detail if detail else ''}")


def calcul(old, ateliers, autres=None):
    return update.nouveautes(old, ateliers, autres or dict(VIDE), AUJ, H, LIMITE)


# 1. Un identifiant absent de la veille est un ajout
old = {"ateliers": [atelier(1)], "autres": VIDE}
nouv, modif, n_add, n_chg = calcul(old, [atelier(1), atelier(2)])
verifie("un nouvel identifiant est un ajout", nouv.get("a:2") == H and n_add == 1, str(nouv))
verifie("l'atelier déjà connu n'est pas marqué", "a:1" not in nouv)

# 2. Le premier passage ne marque pas tout le réseau comme neuf
#    (old contient déjà toutes les séances : aucun amorçage particulier n'est nécessaire)
old = {"ateliers": [atelier(i) for i in range(1, 60)], "autres": VIDE}
nouv, modif, n_add, _ = calcul(old, [atelier(i) for i in range(1, 60)])
verifie("pas d'amorçage : rien n'est neuf si rien n'a bougé", n_add == 0 and not nouv, str(n_add))

# 3. Les quatre familles sont suivies, avec un préfixe par famille
old = {"ateliers": [], "autres": {"reu": [], "for": [], "evt": []}}
nouv, _, _, _ = calcul(old, [atelier(7)],
                       {"reu": [autre(11)], "for": [autre(12)], "evt": [autre(13)]})
verifie("les quatre familles sont préfixées",
        set(nouv) == {"a:7", "r:11", "f:12", "e:13"}, str(sorted(nouv)))

# 4. Les natures de changement
cas = [
    ("déplacement", atelier(1, debut="2026-10-08"), "d"),
    ("horaires", atelier(1, hor="14:00 - 18:00"), "d"),
    ("lieu", atelier(1, lieu="Nantes"), "l"),
    ("site", atelier(1, site=3), "l"),
    ("pilote", atelier(1, pil="Leslie V."), "p"),
    ("titre", atelier(1, titre="Atelier renommé"), "t"),
]
for nom, apres, attendu in cas:
    _, modif, _, n = calcul({"ateliers": [atelier(1)], "autres": VIDE}, [apres])
    verifie(f"changement de {nom}", modif.get("a:1") and attendu in modif["a:1"][1], str(modif))

# 5. Les inscriptions ordinaires ne sont PAS un changement (sinon tout serait signalé en permanence)
_, modif, _, n_chg = calcul({"ateliers": [atelier(1, tot=5)], "autres": VIDE},
                            [atelier(1, tot=9)])
verifie("une inscription de plus n'est pas un changement", not modif and n_chg == 0, str(modif))

# 6. … mais une place qui se libère sur une séance complète en est un
_, modif, _, _ = calcul({"ateliers": [atelier(1, mx=20, tot=20)], "autres": VIDE},
                        [atelier(1, mx=20, tot=19)])
verifie("une place libérée sur une séance complète est signalée",
        modif.get("a:1") and "x" in modif["a:1"][1], str(modif))
_, modif, _, _ = calcul({"ateliers": [atelier(1, mx=20, tot=19)], "autres": VIDE},
                        [atelier(1, mx=20, tot=20)])
verifie("une séance qui se remplit n'est pas signalée", not modif, str(modif))

# 7. Une séance déjà passée qui bouge n'intéresse personne
_, modif, _, _ = calcul({"ateliers": [atelier(1, debut="2026-08-01")], "autres": VIDE},
                        [atelier(1, debut="2026-08-02")])
verifie("une séance passée qui bouge est ignorée", not modif, str(modif))

# 8. Oubli au-delà de la fenêtre, et oubli de ce qui a disparu du réseau
old = {"ateliers": [atelier(1), atelier(2)], "autres": VIDE,
       "nouv": {"a:1": "2026-05-01T10:00:00Z", "a:2": "2026-09-10T10:00:00Z",
                "a:99": "2026-09-10T10:00:00Z"},
       "modif": {"a:1": ["2026-05-01T10:00:00Z", ["d"]]}}
nouv, modif, _, _ = calcul(old, [atelier(1), atelier(2)])
verifie("au-delà de 60 jours, c'est oublié", "a:1" not in nouv and "a:1" not in modif, str(nouv))
verifie("dans la fenêtre, c'est conservé", nouv.get("a:2"), str(nouv))
verifie("une séance disparue du réseau est oubliée", "a:99" not in nouv, str(nouv))

# 9. Une séance ajoutée puis modifiée porte les deux dates : le portail montrera la plus récente
old = {"ateliers": [atelier(1)], "autres": VIDE, "nouv": {"a:1": "2026-09-12T10:00:00Z"}}
nouv, modif, _, _ = calcul(old, [atelier(1, lieu="Nantes")])
verifie("ajout et modification coexistent",
        nouv.get("a:1") == "2026-09-12T10:00:00Z" and modif.get("a:1", [None])[0] == H, str((nouv, modif)))

print(f"{essais - len(echecs)}/{essais} vérifications au vert")
if echecs:
    print("ÉCHECS :")
    for e in echecs:
        print(" -", e)
    sys.exit(1)
