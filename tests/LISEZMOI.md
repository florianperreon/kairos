# Tests du portail Kairos

Ils tournent tout seuls à chaque publication (Action **Tests du portail**) et le résultat remonte
dans **Admin → Journal**. Ce dossier sert à les lancer à la main quand on veut.

## Deux niveaux

**`garde.py`** — quelques secondes, aucune dépendance, appelé par les Actions **avant** de publier
la page. Il refuse une page qui a une erreur de syntaxe JavaScript, une substitution `__CENC__`
ratée, un onglet déclaré sans sa section ou son entrée de menu, deux onglets qui se disputent la
même adresse, un e-mail ou un téléphone en clair, ou une date calendaire calculée en UTC.
Tant qu'il n'est pas vert, rien n'est poussé.

**`nouveautes.py`** — la détection des ajouts et des modifications de séances (`update.nouveautes`).
L'API FORMAN ne donne aucune date de création : elle est déduite en comparant chaque passage au
précédent, et cette logique n'a aucun filet côté navigateur — si elle se trompe, le portail affiche
des nouveautés fausses sans que rien ne casse. Pur Python, sans réseau ni navigateur.

**`portail.spec.js`** — les tests du navigateur (Playwright, ~15 s). La page est ouverte en
`file://`, donc le portail ne joint pas Supabase : les données sont injectées directement dans ses
variables, et on vérifie ce que le code en fait. Chaque bug corrigé en production y a laissé un
test, nommé « régression du … ».

## Lancer à la main

```bash
cd tests
npm install
npx playwright install chromium
npx playwright test          # tout
npx playwright test -g Dates # une famille
python garde.py              # le garde-fou seul
python nouveautes.py         # la détection des nouveautés (depuis la racine du dépôt)
```

## Ce qui est couvert

| Famille | Ce qu'on vérifie |
|---|---|
| Le fichier publié | index.html engendré depuis template.html · audit de confidentialité · aucune date en UTC |
| Démarrage | l'écran de connexion s'affiche sans erreur · chaque onglet a sa section, son menu et une adresse qui reprend son nom |
| Dates | dans quatre fuseaux, le lundi de la semaine tombe bien un lundi et les décalages sont réversibles |
| Mail Manager | le bloc automatique est recalculé au rendu · un filleul adhérent n'est pas compté comme invité · formulaire, mur, objectifs, fiche de lecture et export texte |
| Identité | la progression est demandée avec un filtre explicite, jamais par `limit(1)` |
| Retours | le contexte technique et les erreurs JavaScript sont bien joints · la liste et les droits admin |
| Mail Manager — saisie | les compteurs entiers s'ouvrent sur 0 et les montants restent vides · les PMR passés repliés derrière leur cumul · un filleul est un adhérent, les autres sont des invités (mur, export et objectif) |
| Mail Manager — invités relevés | EDM / DM n'est plus saisi à la main · les invités DM / AD / 3 Jours par semaine et depuis le début · l'historique des sessions et l'à-venir sans horizon · les objectifs du mur, une nature par ligne |
| Mail Manager — production | les champs personnel / équipe 4 niveaux · les deux listes restent distinguables une fois fusionnées · la reprise de l'ancien compteur VAA · les retours à la ligne conservés à la lecture |
| Nouveautés | la fenêtre de 14 jours · les séances passées ne sont jamais neuves · le repère « depuis ta dernière visite » · le filtre, le bandeau d'accueil et les points sur les onglets |
| Téléphone (390 px) | la carte de session passe sur une colonne · les filtres et les sept jours tiennent dans la largeur · le tableau des souscriptions ne défile pas latéralement |

## Ajouter un test

Un bug corrigé mérite son test. Le plus simple : reprendre un bloc existant, injecter le contexte
avec `poser(page, …)` de `aide.js`, appeler la fonction fautive et affirmer le résultat attendu.
Vérifier ensuite qu'il **échoue** si on remet le bug — un test qui ne tombe jamais ne prouve rien.
