"""veille_notion.py — reconstruit veille.js à partir de la base Notion « Veille CGP ».

Notion est la source de vérité de l'onglet « Veille » du portail Kairos : ce script lit la base,
reconstruit intégralement veille.js (chiffré comme contenu.js / donnees.js) et ne réécrit le
fichier que si le contenu a réellement changé. Lancé par .github/workflows/veille.yml.

Variables d'environnement :
    NOTION_TOKEN   jeton d'intégration Notion (workspace FP Consulting)
    NOTION_DB      identifiant de la base « Veille CGP »
    PORTAL_PW      mot de passe du portail (clé de chiffrement)

Usage :
    python3 veille_notion.py            lit Notion et réécrit veille.js si besoin
    python3 veille_notion.py --check    essai à blanc : affiche le résumé, n'écrit rien

Garde-fous :
  * si la base ne renvoie aucun item alors que veille.js en contient, on sort en erreur sans
    toucher au fichier (jeton en panne → le portail ne doit pas être vidé) ;
  * si le contenu reconstruit est identique à l'actuel, aucune réécriture (pas de commit inutile
    toutes les 3 h). Les horodatages sont dérivés de last_edited_time pour rester stables.
"""
import os, sys, json, datetime, urllib.request, urllib.error

import veille  # réutilise le chiffrement et les constantes d'axes (même dépôt)

API = "https://api.notion.com/v1"
VERSION_NOTION = "2022-06-28"

# libellés Notion (select « Axe ») → identifiants internes
AXE_PAR_LIBELLE = {a["t"]: a["id"] for a in veille.AXES}
# tolérance : accents/espaces insécables/casse
def axe_id(libelle):
    if not libelle:
        return None
    n = " ".join(str(libelle).replace(" ", " ").split()).lower()
    for t, i in AXE_PAR_LIBELLE.items():
        if " ".join(t.replace(" ", " ").split()).lower() == n:
            return i
    return None


# ------------------------------------------------------------------ Notion
def notion_post(path, body, token):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Notion-Version": VERSION_NOTION,
                 "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def lire_base(db, token):
    """Toutes les pages de la base, pagination comprise."""
    pages, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        d = notion_post("/databases/%s/query" % db, body, token)
        pages.extend(d.get("results", []))
        if not d.get("has_more"):
            return pages
        cursor = d["next_cursor"]


# ------------------------------------------------------------ lecture des champs
def p_titre(p, nom="Titre"):
    return "".join(x.get("plain_text", "") for x in (p.get(nom, {}).get("title") or []))


def p_texte(p, nom):
    return "".join(x.get("plain_text", "") for x in (p.get(nom, {}).get("rich_text") or []))


def p_select(p, nom):
    s = (p.get(nom) or {}).get("select")
    return s.get("name") if s else None


def p_date(p, nom="Date"):
    d = (p.get(nom) or {}).get("date")
    return (d.get("start"), d.get("end")) if d else (None, None)


def p_nombre(p, nom):
    return (p.get(nom) or {}).get("number")


def p_case(p, nom):
    return bool((p.get(nom) or {}).get("checkbox"))


def sources(txt, maxi):
    """« Nom | URL » par ligne → [{"t":…, "u":…}]"""
    out = []
    for ligne in (txt or "").splitlines():
        ligne = ligne.strip()
        if not ligne:
            continue
        nom, sep, url = ligne.partition("|")
        if not sep:                       # pas de « | » : on récupère l'URL dans la ligne
            i = ligne.find("http")
            if i < 0:
                continue
            nom, url = ligne[:i], ligne[i:]
        nom, url = nom.strip(" \t-–—:"), url.split()[0].strip() if url.split() else ""
        if not url.startswith("http"):
            continue
        out.append({"t": veille.txt(nom or url.split("/")[2], 60), "u": url})
    return out[:maxi]


def premiere_url(txt):
    s = sources(txt, 1)
    return (s[0]["u"], s[0]["t"]) if s else ("", "")


def lundi_dimanche(debut, fin):
    """Normalise la plage de dates en lundi → dimanche."""
    d = datetime.date.fromisoformat(debut[:10])
    lundi = d - datetime.timedelta(days=d.weekday())
    if fin:
        f = datetime.date.fromisoformat(fin[:10])
        if f < lundi:
            lundi = f - datetime.timedelta(days=f.weekday())
    return lundi.isoformat(), (lundi + datetime.timedelta(days=6)).isoformat()


# ------------------------------------------------------------------ construction
def construire(pages):
    editions, breaking, horodatages, ignores = {}, [], [], 0
    for page in pages:
        p = page.get("properties", {})
        if p_case(p, "Masquer"):
            continue
        titre = veille.txt(p_titre(p), 200)
        if not titre:
            continue
        typ = (p_select(p, "Type") or "").strip().lower()
        aid = axe_id(p_select(p, "Axe"))
        debut, fin = p_date(p)
        if not aid or not debut:
            ignores += 1
            continue
        horodatages.append(page.get("last_edited_time", ""))
        resume = p_texte(p, "Résumé")
        change = p_texte(p, "Ce que ça change")
        src_txt = p_texte(p, "Sources")

        if typ.startswith("alerte"):
            u, s = premiere_url(src_txt)
            breaking.append({"d": debut[:10], "axe": aid, "t": veille.txt(titre, 160),
                             "r": veille.txt(resume, 500), "i": veille.txt(change, 400),
                             "u": u, "s": veille.txt(s, 40)})
            continue

        du, au = lundi_dimanche(debut, fin)
        ed = editions.setdefault(du, {"du": du, "au": au, "items": {}})
        it = ed["items"].setdefault(aid, {"sujet": None, "breves": [], "maj": ""})
        it["maj"] = max(it["maj"], page.get("last_edited_time", "")[:16])

        if typ.startswith("sujet"):
            it["sujet"] = {"t": veille.txt(titre, 160), "r": veille.txt(resume, 700),
                           "i": veille.txt(change, 400), "src": sources(src_txt, 4)}
        else:                                                    # brève
            u, s = premiere_url(src_txt)
            it["breves"].append({"_o": p_nombre(p, "Ordre") or 99,
                                 "t": veille.txt(titre, 140), "r": veille.txt(resume, 320),
                                 "i": veille.txt(change, 220), "u": u, "s": veille.txt(s, 40)})

    # tri, troncature, nettoyage
    for ed in editions.values():
        for aid, it in list(ed["items"].items()):
            it["breves"].sort(key=lambda b: (b["_o"], b["t"]))
            it["breves"] = [{k: v for k, v in b.items() if k != "_o"} for b in it["breves"]][:6]
            if it["sujet"] is None:
                if not it["breves"]:
                    del ed["items"][aid]
                    continue
                it["sujet"] = {"t": "", "r": "", "i": "", "src": []}

    editions = [e for e in editions.values() if e["items"]]
    editions.sort(key=lambda e: e["du"])

    vus, uniques = set(), []
    for b in sorted(breaking, key=lambda b: b["d"]):
        cle = b["t"].lower()
        if cle in vus:
            continue
        vus.add(cle)
        uniques.append(b)

    dernier = max(horodatages) if horodatages else ""
    V = {"version": (dernier or datetime.date.today().isoformat())[:10],
         "maj": dernier[:16].replace("Z", "") or "",
         "axes": veille.AXES, "editions": editions, "breaking": uniques}
    return V, ignores


def resume(V):
    n = sum(len(e["items"]) for e in V["editions"])
    print("éditions : %d (%d axes remplis) · alertes : %d · maj : %s"
          % (len(V["editions"]), n, len(V["breaking"]), V["maj"]))
    for e in V["editions"][-6:]:
        print("  %s → %s : %s" % (e["du"], e["au"], ", ".join(sorted(e["items"])) or "—"))
    for b in V["breaking"][-8:]:
        print("  ! %s [%s] %s" % (b["d"], b["axe"], b["t"][:70]))


# ------------------------------------------------------------------ principal
def main():
    check = "--check" in sys.argv
    token, db, pw = os.environ.get("NOTION_TOKEN"), os.environ.get("NOTION_DB"), os.environ.get("PORTAL_PW")
    manquants = [n for n, v in (("NOTION_TOKEN", token), ("NOTION_DB", db), ("PORTAL_PW", pw)) if not v]
    if manquants:
        raise SystemExit("variables d'environnement manquantes : " + ", ".join(manquants))

    try:
        pages = lire_base(db, token)
    except urllib.error.HTTPError as e:
        raise SystemExit("Notion a répondu %s : %s" % (e.code, e.read().decode()[:300]))
    print("Notion : %d ligne(s) lue(s)" % len(pages))

    neuf, ignores = construire(pages)
    if ignores:
        print("%d ligne(s) ignorée(s) (axe ou date manquants)" % ignores)

    actuel = None
    if os.path.exists("veille.js"):
        try:
            actuel = veille.dec(veille.read_js("veille.js"), pw)
        except Exception as e:
            print("veille.js illisible (%s) — il sera reconstruit" % e)

    # garde-fou : ne jamais vider un portail qui contenait des données
    vide = not neuf["editions"] and not neuf["breaking"]
    if vide and actuel and (actuel.get("editions") or actuel.get("breaking")):
        raise SystemExit("ABANDON : la base Notion ne renvoie rien alors que veille.js contient des "
                         "données. Jeton ou partage de la base à vérifier ; veille.js est laissé intact.")

    resume(neuf)

    if actuel is not None:
        comparable = lambda V: json.dumps({k: V.get(k) for k in ("axes", "editions", "breaking")},
                                          ensure_ascii=False, sort_keys=True)
        if comparable(actuel) == comparable(neuf):
            print("Contenu inchangé — veille.js n'est pas réécrit.")
            return

    if check:
        print("[--check] essai à blanc : rien n'a été écrit.")
        return

    blk = veille.enc(neuf, pw, veille.salt_courant())
    open("veille.js", "w", encoding="utf-8").write("window.KAIROS_VEILLE=" + json.dumps(blk) + ";\n")
    print("veille.js réécrit.")


if __name__ == "__main__":
    main()
