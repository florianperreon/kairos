#!/usr/bin/env python3
"""Mise à jour quotidienne des données du portail.

Lit l'ancien payload chiffré dans donnees.js (ou, à défaut, dans le bloc ENC d'un ancien index.html),
récupère les données à jour, reconstruit le payload et le chiffre dans donnees.js (sel conservé d'un
jour à l'autre pour que « Rester déverrouillé » survive à la mise à jour). index.html est régénéré à
partir de template.html sans aucune donnée : la page charge donnees.js, contenu.js et meta.js par balises <script>.
Option --complet (ou COMPLET=1) : relit tout l'historique depuis l'origine au lieu du dernier mois + à venir.
Configuration via variables d'environnement (secrets du dépôt) :
  PORTAL_PW : mot de passe du portail (clé de chiffrement)
  API_BASE  : URL de base de l'API (ex. https://exemple.tld)
  LIGNEE    : (optionnel) noms de la lignée, séparés par des virgules
  LIGNEE_FILLEULS_DE : (optionnel) noms dont toute la descendance (filleuls,
              filleuls de filleuls…) est ajoutée dynamiquement à la lignée
              côté navigateur, à partir des données du jour
Aucune donnée sensible ne doit apparaître dans ce fichier ni dans les logs.
"""
import base64
import datetime
import gzip
import json
import os
import re
import secrets
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PARIS = ZoneInfo("Europe/Paris")
ITER = 300000

# ---------------- crypto ----------------
def derive(pw: bytes, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(pw)

def decrypt_enc(enc: dict, pw: bytes) -> dict:
    key = derive(pw, base64.b64decode(enc["salt"]), enc["iter"])
    pt = AESGCM(key).decrypt(base64.b64decode(enc["iv"]), base64.b64decode(enc["data"]), None)
    return json.loads(gzip.decompress(pt).decode("utf-8"))

def read_js(path: str) -> dict:
    """Lit un fichier `window.X = {...};` et renvoie l'objet JSON."""
    t = open(path, encoding="utf-8").read()
    return json.loads(t[t.index("{"):t.rindex("}") + 1])

def write_js(path: str, var: str, obj_json: str):
    open(path, "w", encoding="utf-8").write(f"window.{var}={obj_json};\n")

def encrypt_payload(obj: dict, pw: bytes, salt: bytes = None) -> str:
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw, 9)
    salt, iv = (salt or secrets.token_bytes(16)), secrets.token_bytes(12)
    ct = AESGCM(derive(pw, salt, ITER)).encrypt(iv, gz, None)
    return json.dumps({"salt": base64.b64encode(salt).decode(),
                       "iv": base64.b64encode(iv).decode(),
                       "iter": ITER,
                       "data": base64.b64encode(ct).decode()})

# ---------------- HTTP ----------------
S = requests.Session()
S.headers.update({"Accept": "application/json"})

def get(url, params=None, tries=4):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = type(e).__name__
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"requête en échec ({last})")

def list_all(api, endpoint, today_iso):
    items, page = [], 1
    while True:
        d = get(f"{api}/api/{endpoint}",
                params={"order[startDate]": "asc", "startDate[after]": today_iso, "page": page})
        batch = d if isinstance(d, list) else d.get("hydra:member", [])
        items.extend(batch)
        if len(batch) < 30:
            break
        page += 1
    return items

def fetch_details(api, endpoint, ids):
    out = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(get, f"{api}/api/{endpoint}/{i}"): i for i in ids}
        for f in as_completed(futs):
            d = f.result()
            if d:
                out[d["id"]] = d
    missing = [i for i in ids if i not in out]
    if missing:
        raise RuntimeError(f"{endpoint}: {len(missing)} détails manquants")
    return out

# ---------------- transformations ----------------
def pdate(s):
    return datetime.datetime.fromisoformat(s).astimezone(PARIS).date().isoformat()

def name(u):
    if not u or not isinstance(u, dict):
        return ""
    fn = (u.get("firstName") or "").replace("﻿", " ").strip()
    ln = (u.get("lastName") or "").replace("﻿", " ").strip()
    return f"{fn} {ln}".strip()

def lieu(w):
    if w.get("isVisio"):
        return "Visio"
    s = w.get("site")
    if s:
        c = (s.get("city") or "").strip()
        if c:
            return c
        n = (s.get("name") or "").strip()
        return "Zoom" if "zoom" in n.lower() else n
    return ""

def horaires(w, key):
    for d in (w.get(key) or []):
        if isinstance(d, dict) and d.get("dateAt") and d.get("endAt"):
            return d["dateAt"][11:16] + " - " + d["endAt"][11:16]
    return ""

def pilotes(w):
    parts = [name(w.get("former"))]
    for c in (w.get("copilotApprouved") or []):
        n = name(c)
        if n:
            parts.append(n)
    seen, out = set(), []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return ", ".join(out)

def ref_id(v):
    """Identifiant d'une référence utilisateur (objet ou IRI /api/users/N)."""
    if isinstance(v, dict):
        return v.get("id")
    if isinstance(v, str) and v.startswith("/api/users/"):
        try:
            return int(v.rsplit("/", 1)[1])
        except ValueError:
            return None
    return None

def ids(lst):
    out = []
    for x in (lst or []):
        i = ref_id(x)
        if i is not None and i not in out:
            out.append(i)
    return out

def site_info(w, sites):
    """Enregistre le site dans le dictionnaire partagé et renvoie son id."""
    st = w.get("site")
    if not isinstance(st, dict) or st.get("id") is None:
        return None
    sid = st["id"]
    if sid not in sites:
        sites[sid] = [(st.get("name") or "").strip(), (st.get("city") or "").strip(),
                      (st.get("address") or "").strip(), (st.get("postalCode") or "").strip(),
                      (st.get("gmap") or "").strip()]
    return sid

# Statuts FORMAN du plus bas au plus haut (hors invités / anciens : GUEST, NOMAN, ONEMAN)
STATUTS = ["NEOMAN", "BEMAN", "ADMAN", "MAN", "DEVMAN", "DXMAN", "XMAN"]

def public(w):
    """Public visé d'après `destined` (liste de rôles ROLE_*) : "" = ouvert à tous
    (liste vide, ou qui contient les invités / NEOMAN), sinon le statut minimum requis
    (ex. "ADMAN" = réservé aux ADMAN et plus)."""
    d = {str(r).upper().replace("ROLE_", "") for r in (w.get("destined") or [])}
    if not d or {"GUEST", "NOMAN", "ONEMAN", "NEOMAN"} & d:
        return ""
    for s in STATUTS:
        if s in d:
            return s
    return "?"

def habilitation(w):
    """Habilitation(s) requise(s) (ex. « Agent lié ou CIF »), hors valeur « nothing »."""
    out = []
    for h in (w.get("habilitation") or []):
        h = str(h).strip()
        if h and h.lower() != "nothing" and h not in out:
            out.append(h)
    return ", ".join(out)

def extras(w, sites):
    """Champs communs ajoutés à chaque atelier/réunion/formation/événement :
    site, places max, inscrits, ids des inscrits, ids en liste d'attente, lien visio, mot de passe visio,
    public visé (statut minimum, "" = tous), habilitation requise."""
    guests = ids(w.get("guests"))
    total = w.get("totalGuests")
    if not isinstance(total, int):
        total = len(guests)
    return [site_info(w, sites), int(w.get("maxGuests") or 0), total, guests,
            ids(w.get("waitingZone")), (w.get("videoConferenceLink") or "").strip(),
            (w.get("visioPassword") or "").strip(), public(w), habilitation(w)]

def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")

def dedup(items):
    seen, out = set(), []
    for x in items:
        if x["id"] not in seen:
            seen.add(x["id"])
            out.append(x)
    return out

# ---------------- pipeline ----------------
def run():
    pw = os.environ["PORTAL_PW"].encode()
    api = os.environ["API_BASE"].rstrip("/")
    now = datetime.datetime.now(PARIS)
    today = now.date()
    today_iso = today.isoformat()
    maj_iso = now.strftime("%Y-%m-%dT%H:%M")  # date + heure (Paris) de la mise à jour

    # Ancien payload (cfg + dates d'inscription connues) : donnees.js, sinon bloc ENC d'un ancien index.html
    if os.path.exists("donnees.js"):
        old_enc = read_js("donnees.js")
    else:
        html = open("index.html", encoding="utf-8").read()
        m = re.search(r"const ENC = (\{.*?\});", html, re.S)
        if not m or m.group(1).strip() == "null":
            raise RuntimeError("ni donnees.enc ni bloc ENC dans index.html")
        old_enc = json.loads(m.group(1))
    old = decrypt_enc(old_enc, pw)

    # Configuration de la lignée (secrets du dépôt) : écrase l'ancienne si fournie
    cfg = dict(old["cfg"])
    split = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]
    if split(os.environ.get("LIGNEE")):
        cfg["lignee"] = split(os.environ.get("LIGNEE"))
    if split(os.environ.get("LIGNEE_FILLEULS_DE")):
        cfg["ligneeRoots"] = split(os.environ.get("LIGNEE_FILLEULS_DE"))

    # Historique : on conserve TOUT (depuis 2022) — onglet « passés », statistiques, fiches membres
    since_iso = "2000-01-01"
    complet = "--complet" in sys.argv or os.environ.get("COMPLET") == "1"
    sites = dict(old.get("sites") or {})
    sites = {int(k): v for k, v in sites.items()}

    # Optimisation (13/09/2026) : l'API n'est interrogée que pour les événements à venir ET ceux du dernier mois
    # (liste + détail, pour suivre inscrits/absences après coup) ; les plus anciens ne changent plus, on reprend
    # leurs lignes de la veille (dans la fenêtre de 12 mois).
    # Mode complet (--complet, 1er du mois) : tout est relu depuis l'origine.
    refresh_iso = since_iso if complet else (today - datetime.timedelta(days=30)).isoformat()
    def keep_past(rows, idx_start):
        return [r for r in rows if since_iso <= r[idx_start] < refresh_iso]

    def merge(new_rows, old_rows, idx_start):
        seen = {r[0] for r in new_rows}
        out = list(new_rows) + [r for r in keep_past(old_rows, idx_start) if r[0] not in seen]
        out.sort(key=lambda a: (a[idx_start], a[0]))
        return out

    # Ateliers (publiés uniquement)
    ws_list = dedup(list_all(api, "workshops", refresh_iso))
    ws_det = fetch_details(api, "workshops", [w["id"] for w in ws_list])
    ws = [w for w in (ws_det[i["id"]] for i in ws_list) if w.get("isPublish")]
    ateliers = [[w["id"], (w["thematic"] or "").strip(), (w["title"] or "").strip(),
                 pdate(w["startDate"]), pdate(w["endDate"]), lieu(w), pilotes(w),
                 horaires(w, "workshopDates")] + extras(w, sites) for w in ws]
    ateliers = merge(ateliers, old.get("ateliers") or [], 3)

    # Réunions, formations, événements (pas de filtre isPublish)
    autres = {}
    for key, ep, dkey in [("reu", "team_meatings", "TeamMeatingDates"),
                          ("for", "formations", "formationDates"),
                          ("evt", "events", "eventDates")]:
        lst = dedup(list_all(api, ep, refresh_iso))
        det = fetch_details(api, ep, [x["id"] for x in lst])
        tup = [[w["id"], (w["title"] or "").strip(), pdate(w["startDate"]), pdate(w["endDate"]),
                lieu(w), pilotes(w), horaires(w, dkey)] + extras(w, sites)
               for w in (det[x["id"]] for x in lst)]
        autres[key] = merge(tup, (old.get("autres") or {}).get(key) or [], 2)

    # Membres : la 1re page donne le nombre de pages, les suivantes sont chargées en parallèle
    first = get(f"{api}/api/users/collection", params={"page": 1, "pageSize": 500})
    users = list(first["items"])
    total_pages = int(first["pagination"]["totalPages"])
    with ThreadPoolExecutor(max_workers=6) as ex:
        for d in ex.map(lambda p: get(f"{api}/api/users/collection", params={"page": p, "pageSize": 500}),
                        range(2, total_pages + 1)):
            users.extend(d["items"])
    users = dedup(users)
    users.sort(key=lambda u: u["id"])
    id2name = {u["id"]: name(u) for u in users}

    def ref_name(v):
        if isinstance(v, dict):
            return name(v) or "Aucun"
        if isinstance(v, str) and v.startswith("/api/users/"):
            try:
                return id2name.get(int(v.rsplit("/", 1)[1]), "Aucun")
            except ValueError:
                return "Aucun"
        return "Aucun"

    old_dates = {mm[0]: mm[4] for mm in old["adherents"]}
    new_ids = [u["id"] for u in users if u["id"] not in old_dates]
    new_dates = {}
    for i in new_ids:
        d = get(f"{api}/api/users/{i}")
        ca = (d or {}).get("createdAt")
        new_dates[i] = pdate(ca) if ca else ""

    membres = [[u["id"], name(u), u.get("phoneNumber") or "", u.get("email") or "",
                old_dates.get(u["id"]) or new_dates.get(u["id"]) or "",
                ref_name(u.get("godFather")), ref_name(u.get("manager")),
                (u.get("city") or "").strip(), (u.get("postalCode") or "").strip()] for u in users]

    # Lignée (mêmes règles que le navigateur : noms fixes + descendance des racines par parrainage)
    lig_norm = [norm(x) for x in (cfg.get("lignee") or [])]
    lig_ids = {u["id"] for u in users if any(l in norm(name(u)) for l in lig_norm)}
    kids = {}
    for u in users:
        g = ref_name(u.get("godFather"))
        if g and g != "Aucun":
            kids.setdefault(norm(g), []).append(u)
    for root in (cfg.get("ligneeRoots") or []):
        queue, seen = [norm(root)], set()
        while queue:
            k = queue.pop()
            if k in seen:
                continue
            seen.add(k)
            for u in kids.get(k, []):
                lig_ids.add(u["id"])
                queue.append(norm(name(u)))

    # Données complémentaires (fiche détaillée) pour les membres de la lignée : date d'anniversaire (jour-mois)
    # birthDay est un horodatage UTC (ex. 1994-05-23T22:00:00+00:00 = 24/05 à Paris) :
    # convertir en Europe/Paris avant de garder MM-JJ. "v": 2 marque les entrées calculées ainsi
    # (les anciennes, sans "v", sont recalculées une fois).
    extra = {int(k): v for k, v in (old.get("extra") or {}).items() if isinstance(v, dict) and v.get("v") == 2}
    need = [i for i in sorted(lig_ids) if i not in extra]
    if need:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(get, f"{api}/api/users/{i}"): i for i in need}
            for f in as_completed(futs):
                d = f.result() or {}
                bd = d.get("birthDay") or ""
                try:
                    mmdd = pdate(bd)[5:10] if bd else ""
                except ValueError:
                    mmdd = bd[5:10] if len(bd) >= 10 else ""
                extra[futs[f]] = {"bd": mmdd, "v": 2}
    extra = {k: v for k, v in extra.items() if k in lig_ids}

    # Adhérents : cotisation réglée depuis moins de 12 mois glissants
    limit = (today - datetime.timedelta(days=365)).isoformat()
    adh_ids = sorted(u["id"] for u in users
                     if u.get("adhesionPaidAt") and pdate(u["adhesionPaidAt"]) >= limit)
    adh_set = set(adh_ids)

    # Jalons d'équipe (membres de la lignée) : taille de l'équipe = adhérents dans toute la descendance
    # par parrainage (même règle que la fiche membre du portail). On mémorise la taille du jour dans
    # extra[id]["team"] et, quand un palier est franchi à la hausse, on ajoute [date, taille] dans
    # extra[id]["jalons"] (30 derniers jours conservés côté données, affichés sur l'accueil).
    # Premier passage (pas d'ancienne valeur) : on enregistre la taille sans créer de jalon.
    PALIERS = [3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500]
    keep_from = (today - datetime.timedelta(days=30)).isoformat()
    def team_size(u):
        seen, queue, n = {u["id"]}, [norm(name(u))], 0
        while queue:
            k = queue.pop()
            for c in kids.get(k, []):
                if c["id"] in seen:
                    continue
                seen.add(c["id"])
                if c["id"] in adh_set:
                    n += 1
                queue.append(norm(name(c)))
        return n
    by_id = {u["id"]: u for u in users}
    for i in lig_ids:
        u = by_id.get(i)
        if not u:
            continue
        x = extra.setdefault(i, {"bd": "", "v": 2})
        n = team_size(u)
        prev = x.get("team")
        jal = [j for j in (x.get("jalons") or []) if j and j[0] >= keep_from]
        if isinstance(prev, int) and n > prev:
            crossed = [p for p in PALIERS if prev < p <= n]
            if crossed:
                jal.append([today_iso, n])
        x["team"] = n
        if jal:
            x["jalons"] = jal
        else:
            x.pop("jalons", None)

    # Garde-fous : en cas d'échec, on sort en erreur SANS toucher à index.html
    errs = []
    if len(ateliers) < 100: errs.append(f"ateliers {len(ateliers)} < 100")
    if len(membres) < 15000: errs.append(f"membres {len(membres)} < 15000")
    if len(adh_ids) < 1000: errs.append(f"liste filtrée {len(adh_ids)} < 1000")
    if len(membres) < 0.95 * len(old["adherents"]): errs.append("baisse membres > 5%")
    if errs:
        raise RuntimeError("garde-fous: " + "; ".join(errs))

    payload = {"meta": {"majAteliers": today_iso, "majAdherents": today_iso, "maj": maj_iso},
               "cfg": cfg, "ateliers": ateliers, "adherents": membres,
               "autres": autres, "adherentIds": adh_ids, "sites": sites,
               "extra": {str(k): v for k, v in extra.items()}}
    enc_json = encrypt_payload(payload, pw, base64.b64decode(old_enc["salt"]))

    # Vérification aller-retour du chiffrement
    if decrypt_enc(json.loads(enc_json), pw)["meta"]["majAteliers"] != today_iso:
        raise RuntimeError("échec de la vérification de déchiffrement")
    # Le contenu éditorial (contenu.js, sel propre) est servi tel quel : on vérifie juste qu'il s'ouvre
    contenu_version = ""
    if os.path.exists("contenu.js"):
        contenu_version = str(decrypt_enc(read_js("contenu.js"), pw).get("version") or "")

    tpl = open("template.html", encoding="utf-8").read()
    if tpl.count("__ENC__") != 1 or tpl.count("__CENC__") != 1:
        raise RuntimeError("template.html invalide")
    out = tpl.replace("__ENC__", "null").replace("__CENC__", "null")

    # Audit : rien de sensible en clair dans la page (les données ne sont plus dans index.html)
    outside = out
    needles = set()
    host = urlparse(api).hostname or ""
    for part in [host] + host.split(".") + host.split("."):
        for tok in re.split(r"[.-]", part):
            if len(tok) > 3:
                needles.add(tok.lower())
    for full in (cfg.get("lignee") or []) + (cfg.get("ligneeRoots") or []) + (cfg.get("moins") or []):
        for tok in str(full).split():
            if len(tok) > 3:
                needles.add(tok.lower())
    low = outside.lower()
    bad = [n for n in needles if n in low]
    if re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", low):
        bad.append("email en clair")
    if re.search(r"(?<!\d)0[1-9](?:[ .-]?\d\d){4}(?!\d)", outside):
        bad.append("téléphone en clair")
    if bad:
        raise RuntimeError(f"audit de confidentialité en échec ({len(bad)} motif(s))")

    write_js("donnees.js", "KAIROS_DONNEES", enc_json)
    # meta.js (en clair) : date de mise à jour, variable du projet lisible sans mot de passe
    write_js("meta.js", "KAIROS_META", json.dumps({"maj": maj_iso, "majDonnees": today_iso, "versionContenu": contenu_version}))
    open("index.html", "w", encoding="utf-8").write(out)
    print(f"OK {today_iso} {'(complet) ' if complet else ''}— ateliers {len(ateliers)} | réunions {len(autres['reu'])} | "
          f"formations {len(autres['for'])} | événements {len(autres['evt'])} | "
          f"membres {len(membres)} (+{len(new_ids)}) | liste filtrée {len(adh_ids)} | "
          f"lignée {len(lig_ids)} | sites {len(sites)}")

if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        # logs publics : ne divulguer ni URL, ni noms, ni identifiants
        msg = str(e)
        for v in (os.environ.get("API_BASE", ""), os.environ.get("PORTAL_PW", "")):
            if v:
                msg = msg.replace(v, "***")
                h = urlparse(v).hostname or ""
                if h:
                    msg = msg.replace(h, "***")
        print("ECHEC:", type(e).__name__, "-", msg[:300])
        sys.exit(1)
