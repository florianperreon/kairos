#!/usr/bin/env python3
"""Mise à jour quotidienne des données du portail.

Relit le payload précédent dans la base du portail (Supabase), récupère les données à jour
et le réécrit dans la base. Plus aucun fichier de données : index.html est régénéré à partir de
template.html, et le portail lit la base (ou la fonction « donnees » pour une entrée par mot de passe).
Option --complet (ou COMPLET=1) : relit tout l'historique depuis l'origine au lieu du dernier mois + à venir.
Option --verifier (ou VERIFIER=1) : ne fait QUE le contrôle des endpoints, sans rien écrire.
Configuration via variables d'environnement (secrets du dépôt) :
  KAIROS_TOKEN : jeton d'écriture des données dans la base du portail
  API_BASE  : URL de base de l'API (ex. https://exemple.tld)
  API_USER  : identifiant (e-mail) du compte de service sur l'API
  API_PASS  : mot de passe de ce compte — obligatoire depuis le 14/09/2026, toute la famille
              /api/users exigeant un JWT. Jamais en clair dans le dépôt ni dans les logs.
  LIGNEE    : (optionnel) noms de la lignée, séparés par des virgules
  LIGNEE_FILLEULS_DE : (optionnel) noms dont toute la descendance (filleuls,
              filleuls de filleuls…) est ajoutée dynamiquement à la lignée
              côté navigateur, à partir des données du jour
Aucune donnée sensible ne doit apparaître dans ce fichier ni dans les logs.
"""
import base64
import datetime
import gzip
import hashlib
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

# ---------------- base du portail (Supabase) ----------------
KAIROS_BASE = os.environ.get("KAIROS_BASE") or "https://xslusoecharxelwmbyal.supabase.co/functions/v1/donnees"
KAIROS_TOKEN = os.environ.get("KAIROS_TOKEN") or ""

def base_lire():
    """Payload précédent stocké dans la base, ou None."""
    if not KAIROS_TOKEN:
        return None
    try:
        r = requests.get(KAIROS_BASE, headers={"x-kairos-token": KAIROS_TOKEN}, timeout=120)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json().get("payload")
    except Exception as e:
        print(f"lecture base impossible ({e})")
        return None

def base_ecrire(payload: dict):
    """Écrit le payload dans la base (JSON gzippé puis encodé en base64 pour alléger la requête)."""
    if not KAIROS_TOKEN:
        print("KAIROS_TOKEN absent : écriture en base ignorée")
        return False
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz64 = base64.b64encode(gzip.compress(raw, 9)).decode()
    r = requests.post(KAIROS_BASE, json={"gz": gz64},
                      headers={"x-kairos-token": KAIROS_TOKEN, "Content-Type": "application/json"},
                      timeout=300)
    if r.status_code >= 300:
        raise RuntimeError(f"écriture en base refusée ({r.status_code}) : {r.text[:200]}")
    print("base du portail : " + r.text[:200])
    return True

# ---------------- empreinte de version (invalidation du cache) ----------------
def empreinte(page: str):
    """Inscrit dans sw.js l'empreinte de la page qui vient d'être générée.

    Page inchangée => même empreinte => sw.js n'est pas réécrit, donc aucun remous pour les
    personnes connectées. Page modifiée => nouveau service worker : les anciens caches sont
    supprimés et les onglets ouverts se rechargent tout seuls. C'est ce qui évite de devoir
    vider son cache à la main après une mise en ligne."""
    try:
        sw = open("sw.js", encoding="utf-8").read()
    except OSError:
        return None
    marque = "kairos-b" + hashlib.sha256(page.encode("utf-8")).hexdigest()[:13]
    neuf = re.sub(r"const VERSION = '[^']*'", f"const VERSION = '{marque}'", sw, count=1)
    if neuf == sw:
        print("service worker : page inchangée, empreinte conservée")
        return None
    open("sw.js", "w", encoding="utf-8").write(neuf)
    print(f"service worker : nouvelle empreinte {marque}")
    return marque

# ---------------- journal des exécutions ----------------
# Chaque passage ouvre une ligne « demarre » puis la clôt en « succes » ou « echec ».
# Un passage tué en cours de route (timeout, runner coupé) laisse sa ligne ouverte :
# le portail l'affiche alors comme « interrompue ». Tout est best-effort : une panne du
# journal ne doit jamais faire échouer une mise à jour.
JOURNAL_BASE = KAIROS_BASE.replace("/donnees", "/journal")
JOURNAL_ID = None

def _journal(corps):
    if not KAIROS_TOKEN:
        return None
    try:
        r = requests.post(JOURNAL_BASE, json=corps,
                          headers={"x-kairos-token": KAIROS_TOKEN, "Content-Type": "application/json"},
                          timeout=30)
        if r.status_code >= 300:
            print(f"journal : refus ({r.status_code}) {r.text[:120]}")
            return None
        return (r.json() or {}).get("id")
    except Exception as e:
        print(f"journal indisponible ({type(e).__name__})")
        return None

def journal_debut(tache):
    global JOURNAL_ID
    JOURNAL_ID = _journal({"action": "debut", "tache": tache, "source": "github",
                           "execution": os.environ.get("GITHUB_RUN_ID") or ""})
    return JOURNAL_ID

def journal_fin(statut, resume=None, erreur=None, tache=None):
    _journal({"action": "fin", "id": JOURNAL_ID, "statut": statut,
              "resume": resume, "erreur": erreur, "tache": tache, "source": "github",
              "execution": os.environ.get("GITHUB_RUN_ID") or ""})

def tache_courante():
    if "--verifier" in sys.argv or os.environ.get("VERIFIER") == "1":
        return "verifier"
    if "--complet" in sys.argv or os.environ.get("COMPLET") == "1":
        return "update_complet"
    return "update"

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

# Identifiants API (secrets du dépôt). Depuis le 14/09/2026 toute la famille /api/users
# exige un JWT : sans authentification, l'annuaire, la lignée et les adhérents sont perdus.
API_USER = os.environ.get("API_USER") or ""
API_PASS = os.environ.get("API_PASS") or ""

def login(api):
    """Obtient un JWT via POST /api/login_check et l'ajoute à toutes les requêtes suivantes."""
    if not (API_USER and API_PASS):
        print("authentification : API_USER/API_PASS absents — appels anonymes")
        return False
    try:
        r = S.post(f"{api}/api/login_check",
                   json={"email": API_USER, "password": API_PASS},
                   headers={"Content-Type": "application/json"}, timeout=60)
    except Exception as e:
        raise RuntimeError(f"authentification injoignable ({type(e).__name__})")
    if r.status_code != 200:
        raise RuntimeError(f"authentification refusée (HTTP {r.status_code})")
    tok = (r.json() or {}).get("token")
    if not tok:
        raise RuntimeError("authentification sans jeton")
    S.headers["Authorization"] = "Bearer " + tok
    print("authentification : OK")
    return True

def get(url, params=None, tries=4):
    last = None
    for i in range(tries):
        refus = None
        try:
            r = S.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403):
                refus = last          # refus d'accès : inutile de réessayer
        except Exception as e:
            last = type(e).__name__
        if refus:
            raise RuntimeError(f"acces refuse ({refus})")
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"requête en échec ({last})")

def get_ld(url, params=None, tries=3):
    """Même chose en JSON-LD (Hydra) : donne `totalItems` pour paginer sans tâtonner."""
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, headers={"Accept": "application/ld+json"}, timeout=60)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403):
                raise RuntimeError(f"acces refuse ({last})")
        except RuntimeError:
            raise
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

# ---------------- nouveautés (ajouts et modifications) ----------------
# L'API FORMAN ne porte aucune date de création sur les séances : aucun createdAt dans les groupes
# de lecture workshops / formations / events / team_meatings. On la déduit donc en comparant chaque
# passage au payload précédent — déjà lu en mémoire, aucune requête de plus. C'est la mécanique
# d'adhDates. Aucun amorçage n'est nécessaire : `old` contient déjà toutes les séances connues,
# donc dès le premier passage seuls les vrais ajouts ressortent.
NOUV_JOURS = 60
# Position des champs dans une ligne : les ateliers portent la thématique en plus, d'où deux jeux.
IDX_A = dict(titre=2, debut=3, fin=4, lieu=5, pilotes=6, hor=7, site=8, max=9, total=10)
IDX_X = dict(titre=1, debut=2, fin=3, lieu=4, pilotes=5, hor=6, site=7, max=8, total=9)


def _sig(r, ix):
    return {k: (r[i] if i < len(r) else None) for k, i in ix.items()}


def changements(avant, apres, ix):
    """Ce qui a bougé et mérite d'être signalé. Les compteurs d'inscrits varient en permanence :
    on ne retient que le passage de « complet » à « des places se sont libérées »."""
    a, b = _sig(avant, ix), _sig(apres, ix)
    q = []
    if (a["debut"], a["fin"], a["hor"]) != (b["debut"], b["fin"], b["hor"]):
        q.append("d")
    if (a["lieu"], a["site"]) != (b["lieu"], b["site"]):
        q.append("l")
    if a["pilotes"] != b["pilotes"]:
        q.append("p")
    if a["titre"] != b["titre"]:
        q.append("t")
    plein = lambda s: bool(s["max"]) and (s["total"] or 0) >= s["max"]
    if plein(a) and not plein(b):
        q.append("x")
    return q


def nouveautes(old, ateliers, autres, today_iso, horodate, limite):
    """Renvoie (nouv, modif, ajouts du jour, modifications du jour).

    nouv  : « type:id » -> horodatage UTC de la première apparition
    modif : « type:id » -> [horodatage UTC, [natures]]
    Les entrées disparues du réseau ou plus anciennes que `limite` sont oubliées.
    """
    nouv = dict(old.get("nouv") or {})
    modif = {k: list(v) for k, v in (old.get("modif") or {}).items()}
    anciens_autres = old.get("autres") or {}
    vivants, n_add, n_chg = set(), 0, 0
    for kind, rows, ix, anciens in (
            ("a", ateliers, IDX_A, old.get("ateliers") or []),
            ("r", autres.get("reu") or [], IDX_X, anciens_autres.get("reu") or []),
            ("f", autres.get("for") or [], IDX_X, anciens_autres.get("for") or []),
            ("e", autres.get("evt") or [], IDX_X, anciens_autres.get("evt") or [])):
        avant = {r[0]: r for r in anciens}
        for r in rows:
            cle = f"{kind}:{r[0]}"
            vivants.add(cle)
            anc = avant.get(r[0])
            if anc is None:
                nouv[cle] = horodate
                n_add += 1
                continue
            if (r[ix["debut"]] or "") < today_iso:
                continue          # une séance déjà passée qui bouge n'intéresse personne
            q = changements(anc, r, ix)
            if q:
                modif[cle] = [horodate, q]
                n_chg += 1
    nouv = {k: v for k, v in nouv.items() if k in vivants and v[:10] >= limite}
    modif = {k: v for k, v in modif.items() if k in vivants and v[0][:10] >= limite}
    return nouv, modif, n_add, n_chg


# ---------------- transformations ----------------
RANGS_STATUT = ["GUEST", "NEOMAN", "BEMAN", "ADMAN", "MAN", "DEVMAN", "DXMAN", "XMAN"]

def statut_de(roles):
    """Le plus haut statut du parcours parmi les rôles d'une fiche ('' si aucun)."""
    vus = [str(r).upper().replace("ROLE_", "") for r in (roles or [])]
    connus = [r for r in vus if r in RANGS_STATUT]
    return max(connus, key=RANGS_STATUT.index) if connus else ""

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



# Mots que l'audit de confidentialité laisse passer, alors qu'ils viennent du nom de domaine
# de l'API ou de la lignée. Le nom du réseau est assumé dans le portail depuis le 14/09/2026 :
# les objectifs et les statuts y sont nommés comme le réseau les nomme.
# Tout le reste (« asso », les noms de la lignée, les animateurs moins conseillés) reste interdit.
AUDIT_AUTORISES = {"forman"}
AUDIT_AUTORISES |= {m.strip().lower() for m in (os.environ.get("AUDIT_AUTORISES") or "").split(",") if m.strip()}

# ---------------- progression individuelle (étapes validées par le réseau) ----------------
# Correspondance libellé d'atelier -> clé d'étape du parcours Kairos.
# L'ordre compte : la première règle qui correspond gagne.
ETAPES_ATELIERS = [
    ("com_n2", ("communication", "niveau 2")),
    ("com_n2", ("communication", "n2")),
    ("com_n1", ("communication", "niveau 1")),
    ("com_n1", ("communication", "n1")),
    ("r1_n1", ("prise de r1", "niveau 1")),
    ("r1_n1", ("prise de r1", "n1")),
    ("mise_en_relation", ("mise en relation",)),
    ("dm", ("decouverte metier",)),
    ("dm", ("decouverte du metier",)),
    ("ad", ("atelier demarrage",)),
    ("ad", ("demarrage",)),
    ("trois_jours", ("3 jours",)),
    ("trois_jours", ("trois jours",)),
]
ETAPES_FORMATIONS = [
    ("udp", ("udp",)),
    ("udp", ("universite",)),      # libellé réel : « Universités … »
]

def _norm(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.replace("'", " ").replace("-", " ").split())

def _cle_etape(titre, regles):
    n = _norm(titre)
    for cle, motifs in regles:
        if all(m in n for m in motifs):
            return cle
    return None

def _pages(api, endpoint, params):
    """Toutes les pages d'une collection (30 par page)."""
    items, page = [], 1
    while True:
        p = dict(params); p["page"] = page
        d = get(f"{api}/api/{endpoint}", params=p)
        batch = d if isinstance(d, list) else (d or {}).get("hydra:member", [])
        items.extend(batch)
        if len(batch) < 30 or page > 30:
            break
        page += 1
    return items

def _jour(x):
    """Jour calendaire à Paris. L'API renvoie des horodatages UTC : une séance du samedi 9 h
    part en « vendredi 23 h Z » si l'on se contente de couper la chaîne (décalage d'un jour
    constaté le 15/09/2026 sur les étapes du parcours)."""
    s = str(x or "")
    if not s:
        return None
    if len(s) > 10:
        try:
            return pdate(s.replace("Z", "+00:00"))
        except ValueError:
            pass
    return s[:10] or None

def _premiere(dates):
    d = sorted([x for x in dates if x])
    return d[0] if d else None

_GOALS_PAR_NIVEAU = {}

def goals_par_niveau(api):
    """Nombre d'objectifs de PROMOTION par statut (mis en cache pour tout le passage)."""
    if not _GOALS_PAR_NIVEAU:
        d = get(f"{api}/api/goals")
        items = d if isinstance(d, list) else (d or {}).get("hydra:member", [])
        for g in items:
            if str(g.get("type") or "").upper() == "PROMOTION":
                niveau = _niveau(g.get("level"))
                _GOALS_PAR_NIVEAU[niveau] = _GOALS_PAR_NIVEAU.get(niveau, 0) + 1
    return _GOALS_PAR_NIVEAU

def _niveau(level):
    return _norm(str(level).replace("_", " ")).replace("role ", "").strip()

def parcours_membre(api, uid, membres, adh_ids):
    """Étapes validées par le réseau pour un membre.
    Chaque étape porte la date de la première séance DÉJÀ PASSÉE (d)
    et, le cas échéant, la date de la prochaine séance à venir (f)."""
    aujourdhui = datetime.datetime.now(PARIS).date().isoformat()
    u = get(f"{api}/api/users/{uid}") or {}
    ateliers = _pages(api, "workshops", {"guests.id": uid})
    formations = _pages(api, "formations", {"guests.id": uid})
    evenements = _pages(api, "events", {"guests.id": uid})
    objectifs = _pages(api, "goal_finisheds", {"user": uid})

    faits = {}
    def noter(cle, date, source):
        if not cle:
            return
        d = _jour(date)
        f = faits.setdefault(cle, {"d": None, "f": None, "src": source})
        if not d:
            return
        if d <= aujourdhui:
            if not f["d"] or d < f["d"]:
                f["d"] = d
        elif not f["f"] or d < f["f"]:
            f["f"] = d

    for a in ateliers:
        noter(_cle_etape(a.get("title"), ETAPES_ATELIERS), a.get("startDate"), "atelier")
    for f in formations:
        noter(_cle_etape(f.get("title"), ETAPES_FORMATIONS), f.get("startDate"), "formation")
    for e in evenements:
        noter(_cle_etape(e.get("title"), ETAPES_ATELIERS + ETAPES_FORMATIONS), e.get("startDate"), "evenement")

    # Onboarding : le drapeau du réseau vaut validation même sans séance retrouvée
    for cle, champ in (("dm", "isJdEnded"), ("ad", "isDemarrageEnded"), ("trois_jours", "is3JREnded")):
        if u.get(champ):
            f = faits.setdefault(cle, {"d": None, "f": None, "src": "statut"})
            f["ok"] = True

    # Adhésion à l'association
    if u.get("adhesionPaidAt"):
        faits["adhesion"] = {"d": _jour(u["adhesionPaidAt"]), "f": None, "src": "adhesion"}

    # Objectifs officiels : validés quand tous ceux du statut le sont
    total = goals_par_niveau(api)
    par_niveau = {}
    for o in objectifs:
        g = o.get("goal") or {}
        niveau = _niveau(g.get("level"))
        if not niveau or not _norm(o.get("status")).startswith("valid"):
            continue
        par_niveau.setdefault(niveau, []).append(_jour(o.get("validatedAt")))
    for niveau, dates in par_niveau.items():
        tot = total.get(niveau, 0)
        complet = bool(tot) and len(dates) >= tot
        faits["objectifs_" + niveau] = {
            "d": (sorted([d for d in dates if d])[-1] if complet and any(dates) else None),
            "f": None, "src": "objectifs", "n": len(dates), "tot": tot, "ok": complet,
        }

    # Première formation réservée (même à venir) : on garde les deux dates
    for f in formations:
        noter("formation_reservee", f.get("startDate"), "formation")

    # Premier invité en DM : une séance où la personne est présente et où figure aussi l'un de ses filleuls
    for a in ateliers:
        if not _cle_etape(a.get("title"), [("dm", ("decouverte metier",)), ("dm", ("decouverte du metier",))]):
            continue
        for g in (a.get("guests") or []):
            if not isinstance(g, dict) or g.get("id") == uid:
                continue
            parrain = g.get("godFather") or {}
            if isinstance(parrain, dict) and parrain.get("id") == uid:
                noter("invite_dm", a.get("startDate"), "invite")
                break

    # Premier filleul devenu adhérent
    moi = _norm((u.get("firstName") or "") + " " + (u.get("lastName") or ""))
    filleuls = [m for m in membres if _norm(m[5]) == moi and m[0] in adh_ids and m[0] != uid]
    if filleuls:
        dates = []
        for fl in filleuls[:12]:
            d = get(f"{api}/api/users/{fl[0]}") or {}
            dates.append(_jour(d.get("adhesionPaidAt")) or _jour(fl[4]))
        premiere = _premiere(dates)
        faits["filleul_adherent"] = {"d": premiere, "f": None, "src": "parrainage"}

    mois = sorted({str(f.get("startDate"))[:7] for f in formations
                   if f.get("startDate") and _jour(f.get("startDate")) <= aujourdhui})
    return {"etapes": faits, "formations_mois": mois[-12:],
            "statut": (u.get("roles") or [None])[0],
            "maj": datetime.datetime.now(PARIS).strftime("%Y-%m-%dT%H:%M")}

# ---------------- calendrier scolaire (data.education.gouv.fr) ----------------
# Vacances des zones A / B / C, posées dans cfg["calendrier"] pour que le portail les affiche
# (en-têtes de semaine, calendrier mensuel, Parcours Découverte). Les jours fériés ne viennent
# pas d'ici : le portail les calcule (dates fixes + Pâques). Bornes : du = premier jour sans
# classe (samedi), au = dernier jour sans classe (dimanche, veille de la reprise), comme sur
# education.gouv.fr. Le fetch est NON bloquant : en cas de panne, cfg garde la dernière valeur
# lue en base et, à défaut, le portail a sa propre table de repli.
CALENDRIER_URL = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records"

def _jour_paris(iso):
    d = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(PARIS)
    return d.date()

def calendrier_scolaire(aujourdhui=None):
    """{'zones': {'A': [{'nom','du','au'}], 'B': …, 'C': …}, 'annees': [...], 'maj': 'AAAA-MM-JJ'}"""
    aujourdhui = aujourdhui or datetime.datetime.now(PARIS).date()
    # année scolaire en cours (bascule au 1er août) : la précédente (sessions passées) et les deux suivantes
    y0 = aujourdhui.year if aujourdhui.month >= 8 else aujourdhui.year - 1
    annees = [f"{y}-{y+1}" for y in range(y0 - 1, y0 + 3)]
    where = ("annee_scolaire in (%s) and zones in ('Zone A','Zone B','Zone C') and population='-'"
             % ",".join("'%s'" % a for a in annees))
    r = requests.get(CALENDRIER_URL, params={
        "where": where, "select": "description,start_date,end_date,zones,annee_scolaire",
        "group_by": "description,start_date,end_date,zones,annee_scolaire",
        "order_by": "start_date", "limit": 100}, timeout=60)
    r.raise_for_status()
    zones = {"A": [], "B": [], "C": []}
    trouvees = set()
    for x in r.json().get("results") or []:
        z = (x.get("zones") or "").replace("Zone ", "").strip()
        if z not in zones or not x.get("start_date"):
            continue
        du = _jour_paris(x["start_date"])
        fin = _jour_paris(x.get("end_date") or x["start_date"])
        nom = (x.get("description") or "").strip()
        if nom.lower().startswith("début des vacances d'été") or nom.lower().startswith("debut des vacances d'ete"):
            nom, au = "Vacances d'été", datetime.date(du.year, 8, 31)
        else:
            au = max(du, fin - datetime.timedelta(days=1))   # la date de fin de l'API = jour de reprise
        if nom.lower().startswith("pont"):
            au = max(au, du + datetime.timedelta(days=6 - du.weekday()))   # le pont court jusqu'au dimanche
        zones[z].append({"nom": nom, "du": du.isoformat(), "au": au.isoformat()})
        trouvees.add(x.get("annee_scolaire"))
    for z in zones:
        zones[z].sort(key=lambda v: v["du"])
    if not any(zones.values()):
        raise RuntimeError("calendrier scolaire vide")
    return {"zones": zones, "annees": sorted(a for a in trouvees if a),
            "maj": aujourdhui.isoformat()}

def sync_parcours(api, membres, adh_ids):
    if not KAIROS_TOKEN:
        print("KAIROS_TOKEN absent : progression individuelle ignorée")
        return
    url_p = KAIROS_BASE.replace("/donnees", "/parcours")
    try:
        r = requests.get(url_p, headers={"x-kairos-token": KAIROS_TOKEN}, timeout=120)
        cibles = r.json().get("membres", []) if r.ok else []
    except Exception as e:
        print(f"liste des membres à synchroniser indisponible ({e})")
        return
    ids = [c["membre_id"] for c in cibles if c.get("membre_id")]
    if not ids:
        print("aucun compte rapproché : rien à synchroniser")
        return
    lignes = []
    for uid in ids:
        try:
            lignes.append({"membre_id": uid, "donnees": parcours_membre(api, uid, membres, adh_ids)})
        except Exception as e:
            print(f"progression {uid} en échec ({type(e).__name__})")
    if not lignes:
        return
    rp = requests.post(url_p, json={"parcours": lignes},
                       headers={"x-kairos-token": KAIROS_TOKEN, "Content-Type": "application/json"},
                       timeout=300)
    print("progressions : " + rp.text[:200])

# ---------------- contrôle préalable des endpoints ----------------
def _echantillon(d):
    """Premier élément d'une réponse de collection, ou l'objet lui-même."""
    if isinstance(d, list):
        return d[0] if d else None
    if isinstance(d, dict):
        for k in ("hydra:member", "member", "items"):
            m = d.get(k)
            if isinstance(m, list):
                return m[0] if m else None
        return d
    return None

def preflight(api):
    """Vérifie, AVANT tout traitement, que chaque endpoint répond ET renvoie une réponse
    exploitable (champs attendus présents). Tant que ce contrôle n'est pas vert, le script
    s'arrête sans rien écrire : la base conserve les dernières données publiées.
    Renvoie la liste des anomalies (vide = tout va bien)."""
    print("--- contrôle des endpoints ---")
    pb, vus = [], {}

    def essai(nom, chemin, params, champs, tries=2):
        try:
            d = get(f"{api}{chemin}", params=params, tries=tries)
        except Exception as e:
            pb.append(f"{nom} : {type(e).__name__} {str(e)[:70]}")
            print(f"  ECHEC   {nom} — {type(e).__name__}")
            return None
        ech = _echantillon(d)
        if ech is None:
            pb.append(f"{nom} : réponse vide")
            print(f"  VIDE    {nom}")
            return None
        manque = [c for c in champs if c not in ech]
        if manque:
            pb.append(f"{nom} : champs absents ({', '.join(manque)})")
            print(f"  CHAMPS  {nom} — absents : {', '.join(manque)}")
            return None
        print(f"  OK      {nom}")
        return ech

    jour = datetime.datetime.now(PARIS).date().isoformat()

    # 1) Collections d'événements (liste) — on retient un id pour tester le détail
    for cle, ep, champs in (("ws", "workshops", ("id", "title", "startDate", "endDate")),
                            ("reu", "team_meatings", ("id", "title", "startDate", "endDate")),
                            ("for", "formations", ("id", "title", "startDate", "endDate")),
                            ("evt", "events", ("id", "title", "startDate", "endDate"))):
        ech = essai(f"/api/{ep}", f"/api/{ep}",
                    {"order[startDate]": "asc", "startDate[after]": jour, "page": 1}, champs)
        if ech:
            vus[cle] = ech["id"]

    # 2) Détail d'un événement — c'est lui qui porte inscrits, places, horaires, public visé
    for cle, ep, champs in (
            ("ws", "workshops", ("id", "guests", "maxGuests", "isPublish", "destined",
                                 "habilitation", "workshopDates", "totalGuests", "waitingZone")),
            ("reu", "team_meatings", ("id", "guests", "maxGuests", "TeamMeatingDates")),
            ("for", "formations", ("id", "guests", "maxGuests", "formationDates")),
            ("evt", "events", ("id", "guests", "maxGuests", "eventDates"))):
        if cle in vus:
            essai(f"/api/{ep}/{{id}}", f"/api/{ep}/{vus[cle]}", None, champs)

    # 3) Annuaire : page complète, pas seulement le premier enregistrement
    #    (godFather est omis quand il est nul — on le cherche sur toute la page)
    uid = None
    try:
        d = get_ld(f"{api}/api/users", params={"page": 1})
        lignes = d.get("member") or d.get("hydra:member") or []
        total = int(d.get("totalItems") or d.get("hydra:totalItems") or 0)
        if len(lignes) < 25 or total < 15000:
            pb.append(f"/api/users : page de {len(lignes)} ligne(s), total annoncé {total}")
            print(f"  ECHEC   /api/users — {len(lignes)} ligne(s), total {total}")
        else:
            manque = [c for c in ("id", "email", "firstName", "lastName", "phoneNumber",
                                  "adhesionPaidAt", "roles") if c not in lignes[0]]
            if not any(l.get("godFather") for l in lignes):
                manque.append("godFather (aucun sur la page)")
            if manque:
                pb.append(f"/api/users : champs absents ({', '.join(manque)})")
                print(f"  CHAMPS  /api/users — absents : {', '.join(manque)}")
            else:
                uid = lignes[0]["id"]
                print(f"  OK      /api/users ({total} membres, {len(lignes)}/page)")
    except Exception as e:
        pb.append(f"/api/users : {type(e).__name__} {str(e)[:70]}")
        print(f"  ECHEC   /api/users — {type(e).__name__}")

    # 4) Fiche membre : createdAt (ancienneté) et birthDay (anniversaires de la lignée)
    if uid:
        # godFather / manager sont omis quand ils sont nuls (haut de la lignée) : non exigés ici,
        # leur présence est déjà vérifiée sur la page d'annuaire ci-dessus.
        essai("/api/users/{id}", f"/api/users/{uid}", None,
              ("id", "email", "firstName", "lastName", "createdAt", "birthDay",
               "adhesionPaidAt", "roles", "isJdEnded", "isDemarrageEnded", "is3JREnded"))
        essai("/api/goal_finisheds?user", "/api/goal_finisheds", {"user": uid, "page": 1},
              ("id", "goal", "status"))
        for ep in ("workshops", "formations", "events"):
            essai(f"/api/{ep}?guests.id", f"/api/{ep}", {"guests.id": uid, "page": 1},
                  ("id", "title", "startDate"))

    # 5) Objectifs du réseau (paliers de promotion)
    essai("/api/goals", "/api/goals", None, ("id", "level", "type"))

    # 6) Base du portail : elle doit être LISIBLE avant d'envisager de la réécrire
    old = base_lire()
    if not old or not (old.get("adherents") and old.get("cfg")):
        pb.append("base du portail illisible ou incomplète (lecture préalable)")
        print("  ECHEC   base du portail (lecture)")
    else:
        print(f"  OK      base du portail ({len(old['adherents'])} membres mémorisés)")

    print("--- contrôle terminé : " + ("tout est vert" if not pb else f"{len(pb)} anomalie(s)") + " ---")
    return pb, old

# ---------------- annuaire ----------------
MARGE_PAGES = 3   # pages lues au-delà du strict nécessaire, par sécurité

def list_users(api, complet=True, connus=0):
    """Annuaire des membres.

    L'API renvoie les fiches par id croissant, 30 par page, et **ignore** aussi bien `order[...]`
    que tout filtre de date ou d'id (vérifié le 14/09/2026 : `createdAt[after]` et `id[gt]`
    renvoient les 15 975 fiches). Les inscrits récents sont donc toujours sur les DERNIÈRES pages.
    Une page pèse ~570 Ko (les invités, parrains et managers y sont dépliés en entier) : relire
    l'annuaire entier coûte ~300 Mo et 2 à 3 minutes, pour des fiches qui ne bougent presque pas.

    complet=True  : tout l'annuaire (passage mensuel).
    complet=False : seulement la fin de l'annuaire, à fusionner avec le payload précédent.
    Renvoie (fiches, total annoncé par l'API)."""
    if complet:
        try:
            first = get(f"{api}/api/users/collection", params={"page": 1, "pageSize": 500}, tries=1)
            if isinstance(first, dict) and first.get("items"):
                users = list(first["items"])
                total_pages = int(first["pagination"]["totalPages"])
                with ThreadPoolExecutor(max_workers=6) as ex:
                    for d in ex.map(lambda p: get(f"{api}/api/users/collection",
                                                  params={"page": p, "pageSize": 500}),
                                    range(2, total_pages + 1)):
                        users.extend(d["items"])
                print(f"annuaire : {len(users)} fiches via users/collection")
                return users, len(users)
        except Exception as e:
            print(f"users/collection indisponible ({type(e).__name__}) — bascule sur /api/users")

    tete = get_ld(f"{api}/api/users", params={"page": 1})
    lignes = tete.get("member") or tete.get("hydra:member") or []
    total = int(tete.get("totalItems") or tete.get("hydra:totalItems") or 0)
    if not lignes or not total:
        raise RuntimeError("annuaire vide via /api/users")
    par_page = len(lignes)
    pages = (total + par_page - 1) // par_page

    if complet:
        depart = 2
    else:
        nouveaux = max(0, total - connus)
        n = min(pages, (nouveaux + par_page - 1) // par_page + MARGE_PAGES)
        depart = max(2, pages - n + 1)
    users = list(lignes) if depart <= 2 else []
    a_lire = list(range(depart, pages + 1))
    with ThreadPoolExecutor(max_workers=8) as ex:
        for d in ex.map(lambda p: get(f"{api}/api/users", params={"page": p}), a_lire):
            users.extend(d if isinstance(d, list) else (d or {}).get("hydra:member", []))
    if complet and len(users) < 0.95 * total:
        raise RuntimeError(f"annuaire incomplet ({len(users)}/{total})")
    print(f"annuaire : {len(users)} fiches lues sur {total} annoncées — "
          f"{'complet' if complet else 'incrémental'}, {len(a_lire) + (1 if depart <= 2 else 0)}/{pages} pages")
    return users, total

# ---------------- pipeline ----------------
def run():
    api = os.environ["API_BASE"].rstrip("/")
    journal_debut(tache_courante())

    # 1) Authentification, 2) contrôle des endpoints. Aucune écriture tant que ce n'est pas vert.
    login(api)
    anomalies, old = preflight(api)
    if anomalies:
        raise RuntimeError("contrôle des endpoints en échec — rien n'a été modifié : "
                           + " ; ".join(anomalies)[:400])
    if "--verifier" in sys.argv or os.environ.get("VERIFIER") == "1":
        print("mode vérification : contrôle vert, arrêt avant tout traitement")
        return "tous les endpoints répondent et la base est lisible"

    now = datetime.datetime.now(PARIS)
    today = now.date()
    today_iso = today.isoformat()
    maj_iso = now.strftime("%Y-%m-%dT%H:%M")  # date + heure (Paris) de la mise à jour

    # Payload précédent (cfg + dates d'inscription connues) : lu par le contrôle préalable,
    # la base du portail est la seule source. Il sert aussi de filet : tout ce qui n'a pas pu être
    # rafraîchi est repris tel quel, et en cas d'anomalie la base n'est pas réécrite du tout.
    if not old:
        raise RuntimeError("payload précédent introuvable en base (KAIROS_TOKEN manquant ou base vide)")
    print(f"payload précédent lu en base ({len(old.get('adherents', []))} membres)")

    # Configuration de la lignée (secrets du dépôt) : écrase l'ancienne si fournie
    cfg = dict(old["cfg"])
    split = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]
    if split(os.environ.get("LIGNEE")):
        cfg["lignee"] = split(os.environ.get("LIGNEE"))
    if split(os.environ.get("LIGNEE_FILLEULS_DE")):
        cfg["ligneeRoots"] = split(os.environ.get("LIGNEE_FILLEULS_DE"))
    # Vacances scolaires (zones A/B/C) : non bloquant — en panne, cfg garde la valeur précédente
    try:
        cfg["calendrier"] = calendrier_scolaire()
        print("calendrier scolaire : années %s" % ", ".join(cfg["calendrier"]["annees"]))
    except Exception as e:
        print(f"calendrier scolaire indisponible ({type(e).__name__}) — valeur précédente conservée")

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

    # Membres. Par défaut on ne relit que la fin de l'annuaire (les inscrits récents) et on fusionne
    # avec le payload précédent. Le passage mensuel (--complet), ou ANNUAIRE_COMPLET=1, relit tout
    # et remet d'aplomb les fiches modifiées entre-temps (téléphone, ville, cotisation, parrain…).
    anciennes = {m[0]: list(m) for m in (old.get("adherents") or [])}
    # adhDates ou statuts absents = ancien payload : on repart d'un annuaire complet pour les amorcer.
    annuaire_complet = (complet or os.environ.get("ANNUAIRE_COMPLET") == "1"
                        or not anciennes or not old.get("adhDates") or not old.get("statuts"))
    users, total_api = list_users(api, annuaire_complet, len(anciennes))
    users = dedup(users)
    users.sort(key=lambda u: u["id"])
    id2name = {u["id"]: name(u) for u in users}
    for i, m in anciennes.items():
        id2name.setdefault(i, m[1])

    def ref_name(v):
        if isinstance(v, dict):
            return name(v) or "Aucun"
        if isinstance(v, str) and v.startswith("/api/users/"):
            try:
                return id2name.get(int(v.rsplit("/", 1)[1]), "Aucun")
            except ValueError:
                return "Aucun"
        return "Aucun"

    # Date d'inscription : jamais renvoyée par la collection, seulement par la fiche détaillée.
    # Une fois connue elle ne change plus : on ne la demande que pour les membres inconnus.
    new_ids = [u["id"] for u in users if u["id"] not in anciennes]
    new_dates = {}
    for i in new_ids:
        d = get(f"{api}/api/users/{i}")
        ca = (d or {}).get("createdAt")
        new_dates[i] = pdate(ca) if ca else ""

    # Dates de cotisation mémorisées d'un passage à l'autre : sans elles, un annuaire lu
    # partiellement ne saurait plus dire qui est à jour (l'échéance glissante, elle, reste juste).
    adh_dates = {int(k): v for k, v in (old.get("adhDates") or {}).items() if v}
    # Statut de chacun (NEOMAN, BEMAN…), mémorisé de la même façon : il permet au portail de
    # savoir quels ateliers une personne peut réserver dès son rattachement, sans attendre le
    # calcul de sa progression individuelle. Les invités (GUEST) ne sont pas stockés.
    statuts = {int(k): v for k, v in (old.get("statuts") or {}).items() if v}

    lues = {}
    for u in users:
        i = u["id"]
        lues[i] = [i, name(u), u.get("phoneNumber") or "", u.get("email") or "",
                   (anciennes.get(i) or ["", "", "", "", ""])[4] or new_dates.get(i) or "",
                   ref_name(u.get("godFather")), ref_name(u.get("manager")),
                   (u.get("city") or "").strip(), (u.get("postalCode") or "").strip()]
        ap = u.get("adhesionPaidAt")
        if ap:
            adh_dates[i] = pdate(ap)
        else:
            adh_dates.pop(i, None)
        st = statut_de(u.get("roles"))
        if st and st != "GUEST":
            statuts[i] = st
        else:
            statuts.pop(i, None)

    if annuaire_complet:
        membres = [lues[i] for i in sorted(lues)]
        adh_dates = {i: d for i, d in adh_dates.items() if i in lues}
        statuts = {i: v for i, v in statuts.items() if i in lues}
    else:
        fusion = dict(anciennes)
        fusion.update(lues)
        membres = [fusion[i] for i in sorted(fusion)]
    print(f"membres : {len(membres)} au total — {len(lues)} fiches relues, {len(new_ids)} nouvelles")

    # Lignée (mêmes règles que le navigateur : noms fixes + descendance des racines par parrainage).
    # Tout ce qui suit travaille sur les lignes fusionnées, pas sur les fiches lues : c'est ce qui
    # permet de ne relire qu'une partie de l'annuaire sans perdre la lignée ni les équipes.
    lig_norm = [norm(x) for x in (cfg.get("lignee") or [])]
    lig_ids = {m[0] for m in membres if any(l in norm(m[1]) for l in lig_norm)}
    kids = {}
    for m in membres:
        g = m[5]
        if g and g != "Aucun":
            kids.setdefault(norm(g), []).append(m)
    for root in (cfg.get("ligneeRoots") or []):
        queue, seen = [norm(root)], set()
        while queue:
            k = queue.pop()
            if k in seen:
                continue
            seen.add(k)
            for m in kids.get(k, []):
                lig_ids.add(m[0])
                queue.append(norm(m[1]))

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

    # Adhérents : cotisation réglée depuis moins de 12 mois glissants. Calculé sur les dates
    # mémorisées, donc l'expiration reste exacte chaque jour ; un NOUVEAU règlement n'apparaît
    # qu'au passage suivant qui relit la fiche (mensuel, ou immédiat pour un membre récent).
    limit = (today - datetime.timedelta(days=365)).isoformat()
    adh_ids = sorted(i for i, d in adh_dates.items() if d and d >= limit)
    adh_set = set(adh_ids)

    # Jalons d'équipe (membres de la lignée) : taille de l'équipe = adhérents dans toute la descendance
    # par parrainage (même règle que la fiche membre du portail). On mémorise la taille du jour dans
    # extra[id]["team"] et, quand un palier est franchi à la hausse, on ajoute [date, taille] dans
    # extra[id]["jalons"] (30 derniers jours conservés côté données, affichés sur l'accueil).
    # Premier passage (pas d'ancienne valeur) : on enregistre la taille sans créer de jalon.
    PALIERS = [3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500]
    keep_from = (today - datetime.timedelta(days=30)).isoformat()
    def team_size(m):
        seen, queue, n = {m[0]}, [norm(m[1])], 0
        while queue:
            k = queue.pop()
            for c in kids.get(k, []):
                if c[0] in seen:
                    continue
                seen.add(c[0])
                if c[0] in adh_set:
                    n += 1
                queue.append(norm(c[1]))
        return n
    by_id = {m[0]: m for m in membres}
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

    # ---------- Nouveautés : ce qui a été ajouté ou modifié depuis le passage précédent ----------
    nouv, modif, n_add, n_chg = nouveautes(
        old, ateliers, autres, today_iso,
        now.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        (today - datetime.timedelta(days=NOUV_JOURS)).isoformat())
    print(f"nouveautés : {n_add} ajout(s), {n_chg} modification(s) — "
          f"{len(nouv)} ajouts et {len(modif)} modifications retenus sur {NOUV_JOURS} jours")

    # Garde-fous : en cas d'échec, on sort en erreur SANS toucher à index.html
    errs = []
    if len(ateliers) < 100: errs.append(f"ateliers {len(ateliers)} < 100")
    if len(membres) < 15000: errs.append(f"membres {len(membres)} < 15000")
    if len(adh_ids) < 1000: errs.append(f"liste filtrée {len(adh_ids)} < 1000")
    if len(membres) < 0.95 * len(old["adherents"]): errs.append("baisse membres > 5%")
    if len(ateliers) < 0.90 * len(old.get("ateliers") or []): errs.append("baisse ateliers > 10%")
    for k, lib in (("reu", "réunions"), ("for", "formations"), ("evt", "événements")):
        anc = len((old.get("autres") or {}).get(k) or [])
        if anc and len(autres[k]) < 0.90 * anc: errs.append(f"baisse {lib} > 10%")
    if errs:
        raise RuntimeError("garde-fous: " + "; ".join(errs))

    payload = {"meta": {"majAteliers": today_iso, "majAdherents": today_iso, "maj": maj_iso},
               "cfg": cfg, "ateliers": ateliers, "adherents": membres,
               "autres": autres, "adherentIds": adh_ids, "sites": sites,
               "extra": {str(k): v for k, v in extra.items()},
               "adhDates": {str(k): v for k, v in adh_dates.items() if v},
               "statuts": {str(k): v for k, v in statuts.items() if v},
               "nouv": nouv, "modif": modif}
    # Version du contenu éditorial (lue en base, le contenu n'a plus de fichier)
    contenu_version = ""
    if KAIROS_TOKEN:
        try:
            r = requests.get(KAIROS_BASE.replace("/donnees", "/contenu") + "?version",
                             headers={"x-kairos-token": KAIROS_TOKEN}, timeout=120)
            if r.ok:
                contenu_version = str(r.json().get("version") or "")
        except Exception as e:
            print(f"version du contenu indisponible ({e})")

    tpl = open("template.html", encoding="utf-8").read()
    if tpl.count("__CENC__") != 1:
        raise RuntimeError("template.html invalide")
    out = tpl.replace("__CENC__", "null")

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
    needles -= AUDIT_AUTORISES
    low = outside.lower()
    bad = [n for n in needles if n in low]
    if re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", low):
        bad.append("email en clair")
    if re.search(r"(?<!\d)0[1-9](?:[ .-]?\d\d){4}(?!\d)", outside):
        bad.append("téléphone en clair")
    if bad:
        raise RuntimeError("audit de confidentialité en échec (%d motif(s) : %s)"
                           % (len(bad), ", ".join(m if not m.isalpha() or m in ("email en clair", "téléphone en clair")
                                                  else m[:2] + "…" for m in bad)))

    if not base_ecrire(payload):
        raise RuntimeError("écriture en base impossible (KAIROS_TOKEN manquant)")
    try:
        sync_parcours(api, membres, adh_ids)
    except Exception as e:
        print(f"progressions individuelles en échec ({type(e).__name__})")
    # meta.js (en clair) : date de mise à jour, variable du projet lisible sans mot de passe
    write_js("meta.js", "KAIROS_META", json.dumps({"maj": maj_iso, "majDonnees": today_iso, "versionContenu": contenu_version}))
    open("index.html", "w", encoding="utf-8").write(out)
    empreinte(out)
    resume = (f"annuaire {'complet' if annuaire_complet else 'incrémental'} | "
              f"ateliers {len(ateliers)} | réunions {len(autres['reu'])} | "
              f"formations {len(autres['for'])} | événements {len(autres['evt'])} | "
              f"membres {len(membres)} (+{len(new_ids)}) | liste filtrée {len(adh_ids)} | "
              f"lignée {len(lig_ids)} | sites {len(sites)}")
    print(f"OK {today_iso} {'(complet) ' if complet else ''}— " + resume)
    return resume

if __name__ == "__main__":
    try:
        journal_fin("succes", resume=run(), tache=tache_courante())
    except Exception as e:
        # logs publics : ne divulguer ni URL, ni noms, ni identifiants
        msg = str(e)
        for v in (os.environ.get("API_BASE", ""), os.environ.get("KAIROS_TOKEN", ""),
                  os.environ.get("API_PASS", ""), os.environ.get("API_USER", "")):
            if v:
                msg = msg.replace(v, "***")
                h = urlparse(v).hostname or ""
                if h:
                    msg = msg.replace(h, "***")
        print("ECHEC:", type(e).__name__, "-", msg[:300])
        journal_fin("echec", erreur=f"{type(e).__name__} : {msg[:1500]}", tache=tache_courante())
        sys.exit(1)
