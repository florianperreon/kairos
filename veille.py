"""veille.py — écriture du bloc chiffré veille.js du portail (onglet « Veille »).

Même principe de chiffrement que donnees.js / contenu.js : gzip + AES-GCM, clé PBKDF2-SHA256
(300 000 itérations) dérivée du mot de passe du portail. Le sel est repris de contenu.js pour que
« Rester déverrouillé » continue de fonctionner sans ressaisie.

Usage (depuis la racine du dépôt) :
    python3 veille.py <mdp> init                 crée veille.js vide s'il n'existe pas
    python3 veille.py <mdp> dump                 affiche le contenu déchiffré (JSON)
    python3 veille.py <mdp> resume               résumé court : éditions, axes remplis, alertes
    python3 veille.py <mdp> axe <fichier.json>   ajoute/remplace un axe dans l'édition d'une semaine
    python3 veille.py <mdp> breaking <f.json>    ajoute une alerte « breaking news » datée

fichier.json de « axe »      : {"axe":"fisca","du":"2026-09-08","au":"2026-09-14",
                                "sujet":{"t":"…","r":"…","i":"…","src":[{"t":"Les Échos","u":"https://…"}]},
                                "breves":[{"t":"…","r":"…","i":"…","u":"https://…","s":"BOFiP"}]}
fichier.json de « breaking » : {"axe":"marches","d":"2026-09-16","t":"…","r":"…","i":"…",
                                "u":"https://…","s":"Banque de France"}
"""
import json, gzip, base64, secrets, sys, os, datetime

ITER = 300000
AXES = [
    {"id": "fisca",    "t": "Fiscalité & réglementation", "ic": "⚖️"},
    {"id": "marches",  "t": "Marchés & économie",         "ic": "\U0001F4C8"},
    {"id": "produits", "t": "Produits & solutions",       "ic": "\U0001F9F0"},
    {"id": "metier",   "t": "Profession & concurrence",   "ic": "\U0001F3DB️"},
    {"id": "clients",  "t": "Clients & prospection",      "ic": "\U0001F3AF"},
]
AXE_IDS = [a["id"] for a in AXES]

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


def derive(pw, salt):
    return PBKDF2HMAC(hashes.SHA256(), 32, salt, ITER).derive(pw.encode())


def read_js(path):
    t = open(path, encoding="utf-8").read()
    return json.loads(t[t.index("{"):t.rindex("}") + 1])


def dec(blk, pw):
    key = derive(pw, base64.b64decode(blk["salt"]))
    raw = AESGCM(key).decrypt(base64.b64decode(blk["iv"]), base64.b64decode(blk["data"]), None)
    return json.loads(gzip.decompress(raw))


def enc(obj, pw, salt_b64):
    key = derive(pw, base64.b64decode(salt_b64))
    iv = secrets.token_bytes(12)
    gz = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), 9)
    return {"salt": salt_b64, "iv": base64.b64encode(iv).decode(), "iter": ITER,
            "data": base64.b64encode(AESGCM(key).encrypt(iv, gz, None)).decode()}


def salt_courant():
    """Sel de veille.js s'il existe, sinon celui de contenu.js (clé partagée), sinon nouveau."""
    for f in ("veille.js", "contenu.js"):
        if os.path.exists(f):
            try:
                return read_js(f)["salt"]
            except Exception:
                pass
    return base64.b64encode(secrets.token_bytes(16)).decode()


def charger(pw):
    if os.path.exists("veille.js"):
        try:
            return dec(read_js("veille.js"), pw)
        except Exception as e:
            raise SystemExit("veille.js illisible (mot de passe ?) : %s" % e)
    return {"version": datetime.date.today().isoformat(), "maj": "", "axes": AXES, "editions": [], "breaking": []}


def ecrire(V, pw):
    V["axes"] = AXES
    V["version"] = datetime.date.today().isoformat()
    V["maj"] = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
    V["editions"].sort(key=lambda e: e.get("du", ""))
    V["breaking"].sort(key=lambda b: b.get("d", ""))
    blk = enc(V, pw, salt_courant())
    open("veille.js", "w", encoding="utf-8").write("window.KAIROS_VEILLE=" + json.dumps(blk) + ";\n")
    return V


def semaine_passee(ref=None):
    """Lundi/dimanche de la semaine écoulée (celle qui précède le jour de référence)."""
    d = ref or datetime.date.today()
    lundi = d - datetime.timedelta(days=d.weekday() + 7)
    return lundi.isoformat(), (lundi + datetime.timedelta(days=6)).isoformat()


def edition(V, du, au):
    for e in V["editions"]:
        if e.get("du") == du:
            return e
    e = {"du": du, "au": au, "items": {}}
    V["editions"].append(e)
    return e


def txt(x, n):
    return " ".join(str(x or "").split())[:n]


def cmd_axe(V, p):
    axe = p.get("axe")
    if axe not in AXE_IDS:
        raise SystemExit("axe inconnu : %r (attendu : %s)" % (axe, ", ".join(AXE_IDS)))
    du, au = p.get("du"), p.get("au")
    if not (du and au):
        du, au = semaine_passee()
    s = p.get("sujet") or {}
    item = {
        "sujet": {"t": txt(s.get("t"), 160), "r": txt(s.get("r"), 700), "i": txt(s.get("i"), 400),
                  "src": [{"t": txt(x.get("t"), 60), "u": x.get("u", "")} for x in (s.get("src") or []) if x.get("u")][:4]},
        "breves": [{"t": txt(b.get("t"), 140), "r": txt(b.get("r"), 320), "i": txt(b.get("i"), 220),
                    "u": b.get("u", ""), "s": txt(b.get("s"), 40)} for b in (p.get("breves") or [])][:6],
        "maj": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M"),
    }
    edition(V, du, au)["items"][axe] = item
    print("axe %s · semaine %s → %s · sujet : %s · %d brève(s)" % (axe, du, au, item["sujet"]["t"][:60], len(item["breves"])))


def cmd_breaking(V, p):
    axe = p.get("axe")
    if axe not in AXE_IDS:
        raise SystemExit("axe inconnu : %r" % axe)
    it = {"d": p.get("d") or datetime.date.today().isoformat(), "axe": axe,
          "t": txt(p.get("t"), 160), "r": txt(p.get("r"), 500), "i": txt(p.get("i"), 400),
          "u": p.get("u", ""), "s": txt(p.get("s"), 40)}
    if not it["t"]:
        raise SystemExit("titre manquant")
    for b in V["breaking"]:
        if b.get("t", "").lower() == it["t"].lower():
            print("déjà présent, rien à faire :", it["t"][:70]); return
    V["breaking"].append(it)
    print("alerte ajoutée (%s · %s) : %s" % (it["d"], axe, it["t"][:70]))


def cmd_resume(V):
    print("éditions :", len(V["editions"]), "· alertes :", len(V["breaking"]), "· maj :", V.get("maj"))
    for e in V["editions"][-6:]:
        print("  %s → %s : %s" % (e["du"], e["au"], ", ".join(sorted(e.get("items", {}))) or "—"))
    for b in V["breaking"][-8:]:
        print("  ! %s [%s] %s" % (b["d"], b["axe"], b["t"][:70]))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    pw, cmd = sys.argv[1], sys.argv[2]
    V = charger(pw)
    if cmd == "dump":
        print(json.dumps(V, ensure_ascii=False, indent=1)); return
    if cmd == "resume":
        cmd_resume(V); return
    if cmd == "init":
        if not os.path.exists("veille.js"):
            ecrire(V, pw); print("veille.js créé (vide)")
        else:
            print("veille.js déjà présent"); cmd_resume(V)
        return
    if cmd in ("axe", "breaking"):
        p = json.load(open(sys.argv[3], encoding="utf-8"))
        (cmd_axe if cmd == "axe" else cmd_breaking)(V, p)
        V = ecrire(V, pw)
        cmd_resume(V)
        return
    raise SystemExit("commande inconnue : " + cmd)


if __name__ == "__main__":
    main()
