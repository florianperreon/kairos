const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { RACINE, PAGE, ATELIER_SEMAINE_PASSEE, poser } = require('./aide');

const lire = f => fs.readFileSync(path.join(RACINE, f), 'utf8');

// Ouvre la page et surveille la console : toute erreur fait échouer le test qui l'a provoquée.
async function ouvrir(page) {
  const erreurs = [];
  page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
  page.on('console', m => {
    // En file:// le manifeste, les icônes et le service worker ne se chargent pas : ces échecs de
    // ressource ne disent rien du code. On ne retient que les erreurs JavaScript.
    if (m.type() === 'error' && !/Failed to load resource|ServiceWorker|manifest/i.test(m.text()))
      erreurs.push('console: ' + m.text());
  });
  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return erreurs;
}
// Le samedi de la semaine passée et un jour de la semaine prochaine, calculés depuis aujourd'hui
// dans le fuseau du test : aucune date n'est figée dans les tests.
function jours() {
  const d = new Date();
  const lundi = new Date(d); lundi.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const samedi = new Date(lundi); samedi.setDate(lundi.getDate() - 2);      // samedi de la semaine passée
  const dm = new Date(lundi); dm.setDate(lundi.getDate() + 12);            // une DM à venir
  return { samedi: iso(samedi), dm: iso(dm) };
}

/* ------------------------------------------------------------------ */
test.describe('Le fichier publié', () => {
  test('index.html est engendré depuis template.html', () => {
    const tpl = lire('template.html'), idx = lire('index.html');
    expect(tpl).toContain('__CENC__');
    expect(idx).not.toContain('__CENC__');
    expect(idx.length).toBe(tpl.length - 4);           // « __CENC__ » (8) remplacé par « null » (4)
    expect(idx).toContain('<title>');
  });

  test('audit de confidentialité : rien de nominatif en clair', () => {
    const idx = lire('index.html');
    expect(idx).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(idx).not.toMatch(/(?<!\d)0[1-9](?:[ .-]?\d\d){4}(?!\d)/);
    expect(idx.toLowerCase()).not.toContain('forman_id');   // refusé par l'audit d'update.py
  });

  test('aucune date calendaire ne passe par toISOString (régression du 14/09/2026)', () => {
    // toISOString() rend la date en UTC : à Paris, minuit local vaut 22 h la veille, donc toute
    // date ainsi calculée reculait d'un jour. Le portail passe par isoJour(), sur l'heure locale.
    expect(lire('template.html')).not.toContain('toISOString().slice(0,10)');
  });

  test('aucune lecture filtrée sur SBUSER.id : une fiche peut avoir plusieurs adresses (24/09/2026)', () => {
    // Deux adresses = deux comptes Supabase pour une même personne. Les données par compte
    // (etat, membres_vues, surveillances, victoires_bravos) sont rangées sous le compte de
    // référence mon_uid() : la RLS les filtre, un .eq('user_id', SBUSER.id) les rendrait vides
    // à la deuxième adresse.
    expect(lire('template.html')).not.toMatch(/\.eq\(\s*'user_id'\s*,\s*SBUSER\.id\s*\)/);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Démarrage', () => {
  test('l’écran de connexion s’affiche sans erreur', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await expect(page.locator('#lock')).toBeVisible();
    await expect(page.locator('#lockGoogle')).toHaveCount(1);
    expect(erreurs).toEqual([]);
  });

  test('chaque onglet déclaré a sa section, son entrée de menu et un slug lisible', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => TABS.map(t => ({
      t,
      section: !!document.getElementById('v-' + t),
      bouton: !!document.querySelector('nav.tabs button[data-v="' + t + '"]'),
      slug: TAB_SLUG[t],
      // le nom complet de l'onglet est son title ; .l peut être abrégé (Parcours / Parcours Découverte)
      nom: (document.querySelector('nav.tabs button[data-v="' + t + '"]') || {}).title
        || (document.querySelector('nav.tabs button[data-v="' + t + '"] .l') || {}).textContent || '',
    })));
    for (const o of r) {
      expect(o.section, 'section manquante pour ' + o.t).toBe(true);
      expect(o.bouton, 'entrée de menu manquante pour ' + o.t).toBe(true);
      // le slug reprend le nom de l'onglet en minuscules avec des tirets (règle du 14/09/2026)
      const attendu = o.nom.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      expect(o.slug, 'slug inattendu pour ' + o.t).toBe(attendu);
    }
  });
});

/* ------------------------------------------------------------------ */
test.describe('Dates', () => {
  for (const tz of ['Europe/Paris', 'UTC', 'America/New_York', 'Pacific/Auckland']) {
    test('le lundi de la semaine est un lundi — ' + tz, async ({ browser }) => {
      const ctx = await browser.newContext({ timezoneId: tz });
      const page = await ctx.newPage();
      const erreurs = await ouvrir(page);
      const r = await page.evaluate(() => {
        const l = mmSemCour();
        return {
          lundi: l,
          jour: new Date(l + 'T00:00:00').getDay(),        // 1 = lundi
          today: todayIso,
          allerRetour: vAddDays(vAddDays(todayIso, -7), 7),
          veille: vAddDays(todayIso, -1),
        };
      });
      expect(r.jour, 'mmSemCour() ne tombe pas un lundi en ' + tz).toBe(1);
      expect(r.allerRetour).toBe(r.today);
      expect(r.veille).not.toBe(r.today);
      expect(erreurs).toEqual([]);
      await ctx.close();
    });
  }
});

/* ------------------------------------------------------------------ */
test.describe('Mail Manager', () => {
  test('le bloc automatique est calculé au rendu, même sans rien avoir enregistré (régression du 14/09/2026)', async ({ page }) => {
    const erreurs = await ouvrir(page);
    const j = jours();
    const atelier = ATELIER_SEMAINE_PASSEE.map(v => v === '@@SAMEDI@@' ? j.samedi : v);
    await poser(page, { atelier, dm: j.dm });
    const r = await page.evaluate(() => {
      showTab('mm'); showMMSub('moi'); buildMM();
      const t = document.getElementById('mmMoi').textContent;
      return {
        session: t.includes('Clefs de la communication'),
        statut: t.includes('BEMAN'),
        parrain: t.includes('Parrain Test'),
        objectifsForman: t.includes('8 / 13'),
        auto: MM.donnees.auto ? MM.donnees.auto.sp.length : -1,
      };
    });
    expect(r.session, 'la session de la semaine passée n’apparaît pas').toBe(true);
    expect(r.statut).toBe(true);
    expect(r.parrain).toBe(true);
    expect(r.objectifsForman).toBe(true);
    expect(r.auto).toBe(1);
    expect(erreurs).toEqual([]);
  });

  test('un filleul déjà adhérent n’est pas compté comme invité (règle du 14/09/2026)', async ({ page }) => {
    await ouvrir(page);
    const j = jours();
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE.map(v => v === '@@SAMEDI@@' ? j.samedi : v), dm: j.dm });
    const r = await page.evaluate(() => { const a = mmAuto(mmSemCour()); return { inv: a.inv, noms: a.invN, fil: a.fil, adh: a.filadh }; });
    expect(r.fil).toBe(2);
    expect(r.adh).toBe(1);
    expect(r.inv.dm, 'le filleul adhérent est compté à tort').toBe(1);
    expect(r.noms.dm).toEqual(['Filleul NonAdherent']);
  });

  test('le formulaire, le mur, les objectifs et l’export texte se rendent', async ({ page }) => {
    const erreurs = await ouvrir(page);
    const j = jours();
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE.map(v => v === '@@SAMEDI@@' ? j.samedi : v), dm: j.dm });
    const r = await page.evaluate(() => {
      MM.donnees.p = { r1: 3, r2: 1 };
      MM.donnees.sous = [{ t: 'Assurance Vie', vi: 12000, vp: 150 }, { t: 'PER', vi: 5000, vp: 0 }];
      MM.donnees.prod = { va: 42000, vaec: 12000, clients: 9 };
      MM_MUR = [{ membre_id: 20028, nom: 'Moi Test', participe: true, statut: 'publie',
                  publie_le: new Date().toISOString(), serie: 3 }];
      MM_LIGNES = [{ membre_id: 20028, donnees: JSON.parse(JSON.stringify(MM.donnees)), statut: 'publie' }];
      showMMSub('moi'); buildMM();
      const form = document.getElementById('mmMoi').textContent;
      showMMSub('mur'); buildMM();
      const mur = document.getElementById('mmMur').textContent;
      showMMSub('obj'); buildMM();
      const obj = document.getElementById('mmObj').textContent;
      MM_LU = { id: 20028, nom: 'Moi Test', ligne: MM_LIGNES[0], prive: 'un mot', obj: MM_OBJ };
      showMMSub('mur'); buildMM();
      const fiche = document.getElementById('mmMur').textContent;
      const plat = x => x.replace(/\s+/g, ' ');
      return {
        totalSouscriptions: plat(form).includes('2 souscriptions') && plat(form).includes('17 000 €'),
        mur: mur.includes('Moi Test') && mur.includes('3 sem.'),
        objectifs: obj.includes('31 décembre') && obj.includes('R0 par semaine'),
        ficheDepliee: fiche.includes('Assurance Vie') && !document.querySelector('#mmMur details.mm-sec'),
        texte: plat(mmTexte(MM.donnees, 'Moi Test', MM_SEM)),
      };
    });
    expect(r.totalSouscriptions).toBe(true);
    expect(r.mur).toBe(true);
    expect(r.objectifs).toBe(true);
    expect(r.ficheDepliee, 'la lecture d’un mail manager doit être dépliée, pas en accordéon').toBe(true);
    expect(r.texte).toContain('Souscriptions :');
    expect(r.texte).toContain('Total : 17 000 €');
    expect(r.texte).not.toContain('un mot');   // le mot à la lignée ne sort jamais dans le texte copié
    expect(erreurs).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Identité', () => {
  test('ma progression est demandée avec un filtre explicite, jamais par limit(1) (régression du 14/09/2026)', async ({ page }) => {
    // La règle de lecture de membres_parcours est « est_admin() OU ma ligne » : pour un
    // administrateur, un limit(1) sans filtre renvoie la progression de n'importe qui.
    await ouvrir(page);
    const r = await page.evaluate(async () => {
      const appels = [];
      const faux = {
        rpc: async (n) => { appels.push('rpc:' + n); return n === 'mon_membre_id' ? { data: 4242 } : { data: [] }; },
        from: (t) => {
          const q = { _t: t };
          q.select = () => q;
          q.eq = (col, val) => { appels.push('eq:' + t + '.' + col + '=' + val); return q; };
          q.in = () => q; q.order = () => q;
          q.limit = () => { appels.push('limit:' + t); return q; };
          q.maybeSingle = async () => ({ data: t === 'membres_parcours'
            ? { membre_id: 4242, donnees: { statut: 'ROLE_BEMAN', etapes: {} } } : null });
          return q;
        },
      };
      SB = faux; SBUSER = { id: 'u', email: 'x' }; MOI_ID = null;
      await chargerParcours();
      return { appels, moi: MOI_ID };
    });
    expect(r.appels).toContain('rpc:mon_membre_id');
    expect(r.appels).toContain('eq:membres_parcours.membre_id=4242');
    expect(r.appels.filter(a => a === 'limit:membres_parcours')).toEqual([]);
    expect(r.moi).toBe(4242);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Retours', () => {
  test('le formulaire joint le contexte et les erreurs techniques', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE.map(v => v === '@@SAMEDI@@' ? jours().samedi : v), dm: jours().dm });
    const r = await page.evaluate(() => {
      noterErr('TypeError: quelque chose a cassé');
      curTab = 'mm';
      const c = retContexte();
      retOuvrir('bug');
      const vu = document.getElementById('retCard').textContent;
      return { ctx: c, formulaire: vu.includes('Bug') && vu.includes('Ce qui sera joint') };
    });
    expect(r.ctx.onglet).toBe('Mail Manager');
    expect(r.ctx.nav).toBeTruthy();
    expect(r.ctx.ecran).toMatch(/^\d+×\d+$/);
    expect(r.ctx.erreurs.length).toBe(1);
    expect(r.formulaire).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('la liste se rend, avec ses filtres et le tri par voix', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE.map(v => v === '@@SAMEDI@@' ? jours().samedi : v), dm: jours().dm });
    const r = await page.evaluate(() => {
      EST_ADMIN = true;
      RET = [{ id: 1, membre_id: 20028, auteur: 'Moi Test', type: 'bug', titre: 'Un souci',
               texte: 'Détail', contexte: { onglet: 'Accueil', erreurs: [] }, statut: 'nouveau',
               reponse: '', cree_le: new Date().toISOString(), votes: 2, jai_vote: false, a_moi: true }];
      showTab('fb'); buildRetours();
      const t = document.getElementById('retListe').textContent;
      return { titre: t.includes('Un souci'), auteur: t.includes('Moi Test'),
               statut: t.includes('À traiter'),
               filtres: [...document.querySelectorAll('[data-retf]')].map(x => x.textContent),
               admin: !!document.querySelector('[data-retstatut="1"]') };
    });
    expect(r.titre && r.auteur && r.statut).toBe(true);
    expect(r.filtres[0]).toContain('Tout');
    expect(r.admin, 'un admin doit pouvoir changer le statut').toBe(true);
    expect(erreurs).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Audit de confidentialité', () => {
  // Non-régression du 14/09/2026 : l'Action de mise à jour a échoué parce que le Mail Manager
  // écrivait le nom du réseau dans la page. Le nom est désormais assumé (liste blanche partagée
  // entre update.py et garde.py) — mais « asso » et les noms de la lignée restent interdits.
  const { spawnSync } = require('child_process');
  const os = require('os');
  const GARDE = path.join(RACINE, 'tests', 'garde.py');
  const ENV = { API_BASE: 'https://api.asso-forman.fr', LIGNEE: 'Jean Dupont,Marie Martin' };

  const lancer = (fichier) => spawnSync('python3', [GARDE, fichier],
    { encoding: 'utf8', env: { ...process.env, ...ENV } });
  const fabriquer = (nom, transforme) => {
    const f = path.join(os.tmpdir(), nom);
    fs.writeFileSync(f, transforme(lire('index.html')), 'utf8');
    return f;
  };

  test('le nom du réseau est autorisé, « asso » et la lignée ne le sont pas', () => {
    const vrai = lancer(path.join(RACINE, 'index.html'));
    test.skip(vrai.error && vrai.error.code === 'ENOENT', 'python3 absent');
    expect(vrai.status, 'la page réelle doit passer le garde-fou :\n' + vrai.stdout).toBe(0);

    expect(lancer(fabriquer('kairos-lignee.html', s => s.replace('<title>', '<title>Dupont '))).status,
      'un nom de la lignée doit être refusé').toBe(1);
    expect(lancer(fabriquer('kairos-asso.html', s => s.replace('<title>', '<title>notre asso '))).status,
      '« asso » doit rester refusé').toBe(1);
    expect(lancer(fabriquer('kairos-mail.html', s => s.replace('<title>', '<title>contact@exemple.fr '))).status,
      'une adresse e-mail doit être refusée').toBe(1);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Parcours « Où en es-tu ? »', () => {
  // Règle du 14/09/2026 : la phase ouverte est la première non terminée, et dedans la plus
  // ancienne étape incomplète. Quand tout est validé, tout reste replié.
  const CONTENU_TEST = {
    pages: {},
    parcours: [
      { n: 1, t: 'Fondations', etapes: [
        { t: 'Étape A', check: ['a1', 'a2'] },
        { t: 'Étape B', check: ['b1'] },
        { t: 'Étape C', check: ['c1'] } ] },
      { n: 2, t: 'Lancement', etapes: [ { t: 'Étape D', check: ['d1'] } ] },
    ],
  };

  const rendre = (page, check) => page.evaluate(({ contenu, check }) => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    document.getElementById('homeParcoursPanel').hidden = false;
    CONTENU = contenu; CHECK = check; PARCOURS = null;
    curPhase = 0; phaseChoisie = false;
    buildPhases();
    const details = [...document.querySelectorAll('#homeEtapes details')];
    return {
      phase: (document.querySelector('#homePhases .phase.on') || {}).textContent || '',
      ouvertes: details.map((d, i) => d.open ? details[i].querySelector('summary').textContent : null).filter(Boolean),
      nbEtapes: details.length,
    };
  }, { contenu: CONTENU_TEST, check });

  test('rien de coché : la première étape de la première phase', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, {});
    expect(r.phase).toContain('Fondations');
    expect(r.ouvertes.length).toBe(1);
    expect(r.ouvertes[0]).toContain('Étape A');
  });

  test('une étape terminée : on ouvre la suivante, pas la première', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, { '0-0-0': true, '0-0-1': true });
    expect(r.ouvertes[0]).toContain('Étape B');
  });

  test('un trou au milieu : on ouvre la plus ancienne incomplète', async ({ page }) => {
    await ouvrir(page);
    // A et C finies, B non : c'est B qui s'ouvre
    const r = await rendre(page, { '0-0-0': true, '0-0-1': true, '0-2-0': true });
    expect(r.ouvertes[0]).toContain('Étape B');
  });

  test('phase 1 terminée : on passe à la phase 2', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, { '0-0-0': true, '0-0-1': true, '0-1-0': true, '0-2-0': true });
    expect(r.phase).toContain('Lancement');
    expect(r.ouvertes[0]).toContain('Étape D');
  });

  test('tout est validé : tout est replié', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, { '0-0-0': true, '0-0-1': true, '0-1-0': true, '0-2-0': true, '1-0-0': true });
    expect(r.nbEtapes).toBeGreaterThan(0);
    expect(r.ouvertes, 'plus rien ne doit être ouvert quand tout est fait').toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Liens partagés', () => {
  // Régression du 14/09/2026 : https://mykairos.fr/#mail-manager ouvrait l'accueil. L'onglet
  // n'apparaît qu'une fois les données chargées, et routeHash() abandonne quand le bouton est
  // encore masqué — sans que personne ne repasse ensuite.
  const arriverAvec = (page, hash) => page.evaluate((h) => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    location.hash = h;
    HASH_INITIAL = h; HASH_APPLIQUE = false;
    window.__booted = true;
    // état du tout début : l'onglet visé n'est pas encore révélé
    document.querySelectorAll('[data-v="mm"],[data-v="fb"]').forEach(x => x.hidden = true);
    routeHash();
    const avant = (document.querySelector('section.view.on') || {}).id;
    // …puis les données arrivent et l'onglet apparaît
    document.querySelectorAll('[data-v="mm"],[data-v="fb"]').forEach(x => x.hidden = false);
    routerQuandPret();
    return { avant, apres: (document.querySelector('section.view.on') || {}).id };
  }, hash);

  test('#mail-manager ouvre le Mail Manager, pas l’accueil', async ({ page }) => {
    await ouvrir(page);
    const r = await arriverAvec(page, '#mail-manager');
    expect(r.avant, 'au tout début l’onglet n’est pas encore là').toBe('v-home');
    expect(r.apres, 'une fois les données chargées, le lien doit aboutir').toBe('v-mm');
  });

  test('un lien avec des paramètres emmène jusqu’à la bonne sous-vue', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      MOI_ID = 20028; MM_SEM = mmSemCour();
      MM = { semaine: MM_SEM, donnees: {}, statut: 'brouillon', maj: null };
      MM_REG = { participe: true, reglages: {} }; MM_OBJ = {}; MM_MUR = []; MM_LIGNES = [];
      PARCOURS = { statut: 'ROLE_BEMAN', etapes: {} };
      byId.set(20028, { id: 20028, name: 'Moi', parrain: 'P', mgr: 'M', date: '2025-07-01' });
      location.hash = '#mail-manager?s=le-mur';
      HASH_INITIAL = location.hash; HASH_APPLIQUE = false;
      window.__booted = true;
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = true);
      routeHash();
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      routerQuandPret();
      return { vue: (document.querySelector('section.view.on') || {}).id, sousVue: MM_SUB };
    });
    expect(r.vue).toBe('v-mm');
    expect(r.sousVue).toBe('mur');
  });

  test('si la personne a navigué entre-temps, on ne la déplace pas', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      location.hash = '#mail-manager';
      HASH_INITIAL = '#mail-manager'; HASH_APPLIQUE = false;
      window.__booted = true;
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = true);
      // elle est partie sur l'annuaire pendant le chargement
      showTab('ann'); curTab = 'ann'; location.hash = '#annuaire';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      routerQuandPret();
      return (document.querySelector('section.view.on') || {}).id;
    });
    expect(r, 'le lien ne doit pas reprendre la main après une navigation').toBe('v-ann');
  });
});

/* ------------------------------------------------------------------ */
test.describe('Admin → Journal', () => {
  // Règle du 14/09/2026 : une tâche qui n'a jamais tourné n'est pas une anomalie — elle vient
  // d'être déclarée, ou elle ne se lance qu'à la demande. Seule une tâche qui tournait et s'est
  // tue est « en retard ».
  const rendre = (page, taches) => page.evaluate(async (taches) => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    SB = { rpc: async () => ({ data: taches }),
           from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }) };
    SBUSER = { id: 'u', email: 'x' };
    await buildJournal();
    const badge = document.getElementById('jrnBadge');
    return {
      note: document.getElementById('jrnNote').textContent,
      badge: badge && !badge.hidden ? badge.textContent : '',
      retards: document.querySelectorAll('#jrnEtat .jrn-ret').length,
      lignes: document.querySelectorAll('#jrnEtat tr').length,
      pastilles: [...document.querySelectorAll('#jrnEtat .jrn-p')].map(x => x.textContent),
    };
  }, taches);

  // Jeu d'essai volontairement pessimiste : « en_retard: true » sur une tâche jamais vue, ce que
  // renvoyait le serveur avant le correctif. Le portail doit tenir même si la base le lui redit.
  const tache = (o) => Object.assign({
    cle: 't', libelle: 'Une tâche', source: 'github', cadence_h: 24, derniere_le: null,
    dernier_statut: null, dernier_resume: null, derniere_erreur: null, duree_s: null,
    heures_depuis: null, en_retard: true, echecs_7j: 0, passages_7j: 0 }, o);

  test('une tâche jamais exécutée n’est pas une alerte', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, [tache({ cle: 'tests', libelle: 'Tests du portail' })]);
    expect(r.pastilles[0]).toBe('Jamais exécutée');
    expect(r.retards, 'pas d’étiquette « en retard » sur une tâche jamais vue').toBe(0);
    expect(r.badge, 'pas de pastille rouge').toBe('');
    expect(r.note).toContain('n’ont pas encore tourné');
  });

  test('une tâche qui s’est tue reste une alerte', async ({ page }) => {
    await ouvrir(page);
    const vieux = new Date(Date.now() - 4 * 86400e3).toISOString();
    const r = await rendre(page, [tache({ cle: 'update', libelle: 'Mise à jour',
      derniere_le: vieux, dernier_statut: 'succes', en_retard: true })]);
    expect(r.retards).toBe(1);
    expect(r.note).toContain('demande ton attention');
  });

  test('un échec reste une alerte', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, [tache({ cle: 'update', libelle: 'Mise à jour',
      derniere_le: new Date().toISOString(), dernier_statut: 'echec',
      derniere_erreur: 'quelque chose a cassé', en_retard: false })]);
    expect(r.note).toContain('demande ton attention');
  });

  test('le mélange : une jamais vue et une en échec → une seule alerte', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, [
      tache({ cle: 'tests', libelle: 'Tests du portail' }),
      tache({ cle: 'update', libelle: 'Mise à jour', derniere_le: new Date().toISOString(),
              dernier_statut: 'echec', derniere_erreur: 'boum', en_retard: false }),
    ]);
    expect(r.note).toBe('1 tâche demande ton attention.');
    expect(r.badge).toBe('1');
  });
});

/* ------------------------------------------------------------------ */
/* Téléphone : la mise en page doit tenir dans 390 px de large.
   Régression du 14/09/2026 — sur « Parcours découverte », la règle #pdList .ev (un identifiant,
   donc plus spécifique que .ev) l'emportait sur la bascule mobile : la carte restait sur trois
   colonnes et le titre comme l'adresse tombaient à un mot par ligne. */
test.describe('Téléphone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // Le balisage exact produit par buildPd() : catégorie, horaire, puis le corps.
  const CARTE = `<div class="day"><div class="day-h"><span class="d">Mercredi 16 septembre 2026</span></div>
    <div class="ev"><div><span class="chip" style="background:#9B8CFF">Découverte Métier</span></div>
    <div><div class="hor num">09:00 - 12:00</div></div>
    <div class="body"><a class="t" href="#">Découverte métier matinée</a>
    <div class="meta">Paris 9e — 12 rue de la Chaussée d'Antin · <span class="pilotes">Aymeric d'Astorg</span></div>
    <div class="xtras"><span class="xtra pub">Ouvert à tous</span><span class="xtra places">41/60</span>
    <span class="xtra lig-in">Lignée inscrite : <b class="lig-open">Moi Test</b></span>
    <a class="xtra act" href="#">Rejoindre la visio ↗</a></div></div></div></div>`;

  test('la carte de session passe sur une colonne et rien ne déborde', async ({ page }) => {
    await ouvrir(page);
    const m = await page.evaluate((html) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
      document.getElementById('v-pd').classList.add('on');
      document.getElementById('pdList').innerHTML = html;
      const L = document.documentElement.clientWidth, r = el => el.getBoundingClientRect();
      return {
        ecran: L,
        corps: Math.round(r(document.querySelector('#pdList .ev .body')).width),
        titre: Math.round(r(document.querySelector('#pdList .ev .body a.t')).height),
        debordePage: document.documentElement.scrollWidth > L,
        debordeCarte: [...document.querySelectorAll('#pdList .ev *')]
          .some(e => r(e).right > L + 1 || r(e).left < -1),
      };
    }, CARTE);

    expect(m.ecran).toBe(390);
    // Avant le correctif le corps ne recevait qu'un reliquat de colonne : il tenait sur ~30 px.
    expect(m.corps, 'le corps de la carte doit occuper toute la largeur').toBeGreaterThan(260);
    // Le titre tenait sur trois lignes dans une colonne étroite ; il en fait une ici.
    expect(m.titre, 'le titre ne doit pas s’empiler sur plusieurs lignes').toBeLessThan(30);
    expect(m.debordePage, 'la page ne défile pas latéralement').toBe(false);
    expect(m.debordeCarte, 'aucun élément de la carte ne sort de l’écran').toBe(false);
  });

  test('les filtres occupent toute la largeur et les jours tiennent sur une ligne', async ({ page }) => {
    await ouvrir(page);
    const m = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
      document.getElementById('v-pd').classList.add('on');
      const r = el => el.getBoundingClientRect();
      setupDays('pdDays', () => {});                 // les sept boutons sont posés par le portail
      const j = [...document.querySelectorAll('#v-pd .daybtns button')];
      return {
        cat: Math.round(r(document.getElementById('pdCat')).width),
        lieu: Math.round(r(document.getElementById('pdLieu')).width),
        jours: j.length,
        lignesDeJours: new Set(j.map(b => Math.round(r(b).top))).size,
      };
    });
    expect(m.cat, 'les deux listes déroulantes ont la même largeur').toBe(m.lieu);
    expect(m.cat, 'elles prennent toute la largeur disponible').toBeGreaterThan(300);
    expect(m.jours).toBe(7);
    expect(m.lignesDeJours, 'les sept jours restent sur une seule ligne').toBe(1);
  });

  test('le tableau des souscriptions ne défile pas latéralement', async ({ page }) => {
    await ouvrir(page);
    const m = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
      const v = document.getElementById('v-mm'); v.classList.add('on'); v.hidden = false;
      MM_PRODUITS = ['Assurance Vie', 'PER', 'SCPI', 'Girardin'];
      const d = { sous: [{ t: 'Assurance Vie', vi: 15000, vp: 250 }, { t: 'PER', vi: 5000, vp: 100 }] };
      document.getElementById('mmMoi').innerHTML = '<div class="panel">' + mmSous(d, false) + '</div>';
      const w = document.querySelector('#mmMoi .mm-wrap');
      const lbl = [...document.querySelectorAll('#mmMoi .mm-tbl td[data-l]')].map(t => t.dataset.l);
      return { deborde: w.scrollWidth > w.clientWidth + 1, libelles: lbl.slice(0, 3),
               entete: getComputedStyle(document.querySelector('#mmMoi .mm-tbl thead')).position };
    });
    expect(m.deborde, 'chaque ligne est empilée : plus de défilement latéral').toBe(false);
    expect(m.libelles).toEqual(['Produit', 'Versement initial', 'Versement programmé']);
    expect(m.entete, 'l’entête du tableau est masqué au profit des libellés de ligne').toBe('absolute');
  });
});

/* ------------------------------------------------------------------ */
/* Nouveautés — ce qui vient d'être ajouté ou modifié.
   La date d'ajout n'existe pas dans l'API FORMAN : elle est déduite par update.py en comparant
   chaque passage au précédent (voir tests/nouveautes.py pour cette partie). Ici on vérifie ce que
   le portail en fait : la fenêtre de 14 jours, le repère personnel, le filtre et le bandeau. */
test.describe('Nouveautés', () => {
  const ilYA = j => new Date(Date.now() - j * 86400e3).toISOString().slice(0, 19) + 'Z';
  const dans = j => {
    const d = new Date(Date.now() + j * 86400e3);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  // Pose quatre ateliers aux états connus, puis renvoie ce que le portail en dit.
  async function poserNouv(page, vuLe) {
    return page.evaluate(({ recent, vieux, hier, passe, vu }) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      const at = (id, titre, start) => ({ id, th: 'PARCOURS DECOUVERTE', thRaw: 'PARCOURS DECOUVERTE',
        title: titre, start, end: start, lieu: 'Visio', pilotes: 'Diane P.', hor: '09:00 - 12:00',
        siteId: null, max: 20, total: 5, guests: [], wait: [], link: '', pw: '', pub: '', hab: '',
        k: 'a', url: '#', tkey: titre });
      A.length = 0;
      A.push(at(1, 'Ajouté hier', dans(10)), at(2, 'Ajouté il y a 30 jours', dans(12)),
             at(3, 'Déplacé hier', dans(14)), at(4, 'Ajouté hier mais déjà passé', passe));
      NOUV = { 'a:1': hier, 'a:2': vieux, 'a:4': hier };
      MODIF = { 'a:3': [hier, ['d', 'p']] };
      VU_LE = vu;
      const et = id => { const e = neufEtat(A.find(a => a.id === id)); return e && { q: e.q, lib: e.lib, nonVu: neufNonVu(e) }; };
      return { a1: et(1), a2: et(2), a3: et(3), a4: et(4), total: neufTout().length };
    }, { hier: ilYA(1), vieux: ilYA(30), passe: dans(-3), vu: vuLe });
  }
  // `dans` doit exister dans la page : on le réinjecte avec les valeurs déjà calculées côté test.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ d10, d12, d14, dm3 }) => {
      window.dans = j => ({ 10: d10, 12: d12, 14: d14, '-3': dm3 })[j];
    }, { d10: dans(10), d12: dans(12), d14: dans(14), dm3: dans(-3) });
  });

  test('la fenêtre de 14 jours, les modifications et les séances passées', async ({ page }) => {
    await ouvrir(page);
    const r = await poserNouv(page, '');
    expect(r.a1, 'ajouté hier → Nouveau').toMatchObject({ q: 'n', lib: 'Nouveau' });
    expect(r.a2, 'ajouté il y a 30 jours → plus rien').toBeNull();
    expect(r.a3, 'déplacé hier → la nature du changement est nommée').toMatchObject({ q: 'm' });
    expect(r.a4, 'une séance déjà passée n’est jamais une nouveauté').toBeNull();
    expect(r.total).toBe(2);
  });

  test('sans repère, tout ce qui est dans la fenêtre est « non vu »', async ({ page }) => {
    await ouvrir(page);
    const r = await poserNouv(page, '');
    expect(r.a1.nonVu).toBe(true);
    expect(r.a3.nonVu).toBe(true);
  });

  test('le repère « depuis ta dernière visite » éteint ce qui a déjà été vu', async ({ page }) => {
    await ouvrir(page);
    const r = await poserNouv(page, new Date().toISOString());   // visité à l’instant
    expect(r.a1, 'la pastille reste dans la liste…').toMatchObject({ lib: 'Nouveau' });
    expect(r.a1.nonVu, '…mais elle n’est plus « fraîche »').toBe(false);
    expect(r.a3.nonVu).toBe(false);
  });

  test('le bandeau d’accueil trie par date d’ajout et pose un point sur les onglets', async ({ page }) => {
    await ouvrir(page);
    await poserNouv(page, '');
    const r = await page.evaluate(() => {
      R.length = 0; F.length = 0; E.length = 0;
      buildNouv(); nvPoints();
      const el = document.getElementById('homeNouv');
      return {
        visible: !el.hidden,
        titre: el.querySelector('.nv-h h2').textContent,
        ordre: [...el.querySelectorAll('.nv-it b')].map(b => b.textContent),
        pastilles: [...el.querySelectorAll('.nv-it .xtra.neuf')].map(x => x.textContent),
        points: [...document.querySelectorAll('nav.tabs.side [data-v] .nv-pt')].map(d => d.closest('[data-v]').dataset.v),
      };
    });
    expect(r.visible).toBe(true);
    expect(r.titre).toContain('2 nouveautés');
    // les deux portent le même horodatage : l’ordre importe peu, mais les deux doivent être là
    expect(r.ordre.sort()).toEqual(['Ajouté hier', 'Déplacé hier']);
    expect(r.pastilles).toContain('Nouveau');
    expect(r.points, 'le point se pose sur l’onglet du parcours découverte').toContain('pd');
  });

  test('chaque nouveauté annonce le jour de la semaine et le ou les pilotes', async ({ page }) => {
    await ouvrir(page);
    await poserNouv(page, '');
    const r = await page.evaluate(() => {
      R.length = 0; F.length = 0; E.length = 0;
      buildNouv();
      const dates = [...document.querySelectorAll('#homeNouv .nv-d')].map(x => x.textContent);
      const it = neufTout()[0].a;
      it.pilotes = 'Diane P., Aymeric A.'; buildNouv();
      const deux = document.querySelector('#homeNouv .nv-d').textContent;
      it.pilotes = 'Diane P.'; buildNouv();
      const un = document.querySelector('#homeNouv .nv-d').textContent;
      it.pilotes = ''; buildNouv();
      const aucun = document.querySelector('#homeNouv .nv-d').textContent;
      return { dates, deux, un, aucun, jeudi: fmtDJour('2026-09-24'), dimanche: fmtDJour('2026-09-20') };
    });
    expect(r.jeudi).toBe('jeudi 24/09/2026');
    expect(r.dimanche).toBe('dimanche 20/09/2026');
    expect(r.dates.length).toBeGreaterThan(0);
    expect(r.deux).toContain('Pilotes : Diane P., Aymeric A.');
    expect(r.un).toContain('Pilote : Diane P.');
    expect(r.aucun).not.toContain('Pilote');
    r.dates.forEach(d => expect(d).toMatch(/^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) \d{2}\/\d{2}\/\d{4}/));
  });

  test('le filtre « Nouveautés » ne garde que ce qui est récent', async ({ page }) => {
    await ouvrir(page);
    await poserNouv(page, '');
    const r = await page.evaluate(() => {
      buildPd();
      const avant = document.getElementById('pdCount').textContent;
      const c = document.getElementById('pdNeuf');
      c.checked = true; c.dispatchEvent(new Event('change'));
      const apres = document.getElementById('pdCount').textContent;
      const titres = [...document.querySelectorAll('#pdList .ev .body a.t')].map(a => a.textContent);
      return { avant, apres, titres };
    });
    expect(r.avant, 'les trois sessions à venir sont listées').toContain('3');
    expect(r.apres, 'seules les deux nouveautés restent').toContain('2');
    expect(r.titres.sort()).toEqual(['Ajouté hier', 'Déplacé hier']);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Mail Manager — production et texte libre', () => {
  // Rend le formulaire, la fiche de lecture et l'export texte à partir des mêmes données.
  async function rendre(page, donnees, prive) {
    return page.evaluate(({ d, prive }) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      MM_PRODUITS = ['Assurance Vie', 'PER'];
      MM_OBJ = { va_dec: 120000, eva_pmr: 500000 };
      const sem = mmSemCour();
      const copie = () => JSON.parse(JSON.stringify(d));
      document.getElementById('mmMoi').innerHTML = mmCorps(copie(), '', false, sem);
      document.getElementById('mmMur').innerHTML = mmFiche(copie(), prive, sem, MM_OBJ);
      const lire = sel => [...document.querySelectorAll(sel)];
      // l'intitulé peut porter une précision à côté (« Production 2026-2027 »)
      const ligne = k => {
        const l = lire('#mmMur .mm-f .l').find(x => x.querySelector('.k').textContent.startsWith(k));
        return l ? l.querySelector('.v') : null;
      };
      return {
        groupes: lire('#mmMoi .mm-lab').map(l => l.textContent).filter(t => /^(Personnel|Équipe)/.test(t)),
        champs: lire('#mmMoi .mm-cpt .mm-c > label').map(l => l.textContent).slice(-6),
        production: (ligne('Production') || {}).innerText || '',
        rangs: ligne('Production')
          ? [...ligne('Production').querySelectorAll('.kpi')].map(k => k.textContent.replace(/[\s\u00a0\u202f]+/g, ' ').trim())
          : [],
        faits: (ligne('Faits marquants') || {}).innerText || '',
        blancFaits: ligne('Faits marquants')
          ? getComputedStyle(ligne('Faits marquants').querySelector('p')).whiteSpace : '',
        blancFocus: ligne('Focus') ? getComputedStyle(ligne('Focus').querySelector('p')).whiteSpace : '',
        blancMot: ligne('Mot à la lignée')
          ? getComputedStyle(ligne('Mot à la lignée').querySelector('p')).whiteSpace : '',
        migre: mmMigre(copie()).prod,
        texte: mmTexte(copie(), 'Moi Test', sem).split('\n').filter(l => /VA \+|VP annualisés|Nombre de clients/.test(l)),
        exportComplet: mmTexte(copie(), 'Moi Test', sem),
      };
    }, { d: donnees, prive });
  }

  const DONNEES = {
    pf: 'Julie : NC AV\nAlice : SCPI enfin validée',
    cf: 'Mardi : golf\nVendredi : signer',
    prod: { va: 30000, vaa: 5000, vaec: 12000, vp: 150, clients: 14, eva: 80000, evaec: 20000 },
    p: { r0: 3 }, c: { r0: 1 }, av: {}, sous: [], auto: {},
  };

  test('la section Production demande le personnel puis l’équipe sur 4 niveaux', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, '');
    expect(r.groupes[0]).toMatch(/^Personnel/);
    expect(r.groupes[1]).toMatch(/^Équipe/);
    expect(r.groupes[1], 'les quatre niveaux sont précisés').toContain('4 niveaux');
    expect(r.champs).toEqual([
      'VA + VAA VC', 'VA + VAA EC', 'VP annualisés', 'Nombre de clients',   // personnel
      'VA + VAA VC', 'VA + VAA EC',                                          // équipe
    ]);
  });

  test('personnel et équipe restent distincts sur le mur et dans l’export', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, '');
    // Les libellés courts sont identiques des deux côtés. Sur le mur c'est le rang qui les sépare
    // (une ligne « Personnel », une ligne « Équipe ») ; dans l'export, où tout est à plat, ce sont
    // les libellés longs qui portent la distinction.
    expect(r.rangs, 'deux rangs : personnel puis équipe').toHaveLength(2);
    expect(r.rangs[0]).toMatch(/^Personnel/);
    expect(r.rangs[0]).toContain('VA + VAA VC35 000 €');
    expect(r.rangs[0]).toContain('Nombre de clients14');
    expect(r.rangs[1]).toMatch(/^Équipe/);
    expect(r.rangs[1]).toContain('VA + VAA VC80 000 €');
    expect(r.rangs[1], 'les clients ne sont pas un chiffre d’équipe').not.toContain('Nombre de clients');
    for (const attendu of ['VA + VAA VC personnel', 'VA + VAA EC personnel',
                           'VA + VAA VC équipe', 'VA + VAA EC équipe']) {
      expect(r.texte.join('\n'), attendu + ' (export texte)').toContain(attendu);
    }
  });

  test('l’ancien compteur VAA est replié dans « VA + VAA VC » (reprise du 14/09/2026)', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, '');
    expect(r.migre.va, '30 000 de VA + 5 000 de VAA').toBe(35000);
    expect(r.migre.vaa, 'l’ancienne clé disparaît').toBeUndefined();
    // les montants portent des espaces insécables : on normalise avant de comparer
    expect(r.production.replace(/[\s\u00a0\u202f]+/g, ' ')).toContain('35 000 €');
  });

  test('l’export texte annonce les champs libres avant leur contenu', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, '');
    // Sans intitulé, le lecteur du mail tombait sur deux lignes de texte sorties de nulle part.
    expect(r.exportComplet).toContain('Faits marquants :\nJulie : NC AV\nAlice : SCPI enfin validée');
    expect(r.exportComplet).toContain('Mon focus de la semaine :\nMardi : golf\nVendredi : signer');
  });

  test('un champ libre vide n’ajoute pas d’intitulé orphelin', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, Object.assign({}, DONNEES, { pf: '', cf: '   \n ' }), '');
    expect(r.exportComplet).not.toContain('Faits marquants');
    expect(r.exportComplet).not.toContain('Mon focus de la semaine');
  });

  test('les jauges de production suivent la frappe, sans perdre le curseur', async ({ page }) => {
    await ouvrir(page);
    // Elles étaient dessinées une fois pour toutes à l'ouverture : on pouvait saisir 84 690 € et
    // lire « 0 € / 300 000 € · 0 % » juste en dessous.
    await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      document.getElementById('v-mm').classList.add('on');
      document.getElementById('sm-moi').classList.add('on');
      MM_PRODUITS = []; MM_SEM = mmSemCour();
      MM_OBJ = { va_dec: 300000, eva_dec: 50000, clients_dec: 20 };
      MM = { statut: 'brouillon', maj: null, donnees: { prod: {}, p: {}, c: {}, av: {}, sous: [], auto: {} } };
      document.getElementById('mmMoi').innerHTML = mmCorps(MM.donnees, '', false, MM_SEM);
      document.querySelectorAll('#mmMoi details').forEach(x => x.open = true);
    });
    const net = t => t.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
    const jauges = () => page.evaluate(() =>
      [...document.querySelectorAll('#mmProdJ .mm-j .t')].map(t => t.textContent))
      .then(l => l.map(net));

    expect((await jauges())[0]).toContain('0 € / 300 000 €');
    await page.fill('#v-mm input[data-mm="prod.va"]', '16800');
    await page.fill('#v-mm input[data-mm="prod.vaec"]', '67890');
    await page.fill('#v-mm input[data-mm="prod.clients"]', '11');
    const apres = await jauges();
    expect(apres[0], 'le validé compagnie et l’en cours se cumulent').toContain('84 690 € / 300 000 € · 28 %');
    expect(apres.join(' | ')).toContain('11 / 20 · 55 %');
    // Les jauges vivent dans leur propre conteneur : redessiner ne doit pas voler le curseur.
    expect(await page.evaluate(() => document.activeElement.dataset.mm)).toBe('prod.clients');
    // Le rythme requis suit lui aussi
    const notes = (await page.evaluate(() =>
      [...document.querySelectorAll('#mmProdJ .mm-note')].map(n => n.textContent))).map(net);
    expect(notes[0], 'le rythme requis est recalculé').toContain('rythme requis');
    expect(notes[0]).not.toContain('18 750');       // le rythme d'avant la saisie
  });

  test('la production nomme le PMR en cours et liste les PMR passés depuis 2022', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      MM_PRODUITS = []; MM_OBJ = {}; MM_SEM = mmSemCour();
      const d = { prod: { va: 16800, pmr: { 2025: { va: 180000, eva: 420000 }, 2024: { va: 95000 } } },
                  p: {}, c: {}, av: {}, sous: [], auto: {} };
      MM = { statut: 'brouillon', maj: null, donnees: JSON.parse(JSON.stringify(d)) };
      document.getElementById('mmMoi').innerHTML = mmCorps(MM.donnees, '', false, MM_SEM);
      const net = t => t.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
      // l'exercice se déduit de la date du jour : aucune année n'est figée dans le test
      const an = +new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1;
      return {
        an,
        titres: [...document.querySelectorAll('#mmMoi .mm-lab')].map(l => net(l.textContent))
                  .filter(t => /PMR/.test(t)).join(' | '),
        exercices: [...document.querySelectorAll('#mmMoi .mm-pmr tbody tr:not(.tot) td:first-child')].map(t => t.textContent),
        champs: [...document.querySelectorAll('#mmMoi .mm-pmr input')].map(i => i.dataset.mm),
        cumul: [document.getElementById('mmPmrTP').textContent, document.getElementById('mmPmrTE').textContent].map(net),
        resume: net(document.querySelector('#mmMoi .mm-pmr-d summary').textContent),
        note: net(document.querySelector('#mmMoi .mm-pmr-d .mm-note').textContent),
        fiche: net(mmFiche(JSON.parse(JSON.stringify(d)), '', MM_SEM, {})),
        texte: mmTexte(JSON.parse(JSON.stringify(d)), 'Moi', MM_SEM),
      };
    });
    const cour = r.an + '-' + (r.an + 1);
    expect(r.titres, 'le bloc personnel annonce le PMR en cours').toContain('Personnel — PMR en cours (' + cour + ')');
    expect(r.titres, 'l’équipe aussi').toContain('sur 4 niveaux, PMR en cours (' + cour + ')');
    // Le bloc des PMR passés est replié derrière son résumé (voir « saisie et vocabulaire ») :
    // c'est là qu'on lit son intitulé, et la valeur attendue est rappelée juste en dessous.
    expect(r.resume, 'le résumé nomme le bloc').toContain('PMR passés');
    expect(r.note, 'et dit quelle valeur on attend').toContain('VA + VAA VC');
    // du plus récent à 2022-2023, sans l'exercice en cours
    const attendus = [];
    for (let y = r.an - 1; y >= 2022; y--) attendus.push(y + '-' + (y + 1));
    expect(r.exercices).toEqual(attendus);
    expect(r.exercices).not.toContain(cour);
    expect(r.champs.slice(0, 2)).toEqual(['prod.pmr.' + (r.an - 1) + '.va', 'prod.pmr.' + (r.an - 1) + '.eva']);
    expect(r.cumul[0]).toBe('275 000 €');
    expect(r.cumul[1]).toBe('420 000 €');
    expect(r.fiche, 'le mur montre l’historique').toContain('2025-2026');
    expect(r.texte).toContain('PMR passés (VA + VAA VC) :');
    expect(r.texte).toContain('5 - Production — PMR en cours (' + cour + ')');
  });

  test('le cumul des PMR passés suit la frappe', async ({ page }) => {
    await ouvrir(page);
    await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      document.getElementById('v-mm').classList.add('on');
      document.getElementById('sm-moi').classList.add('on');
      MM_PRODUITS = []; MM_OBJ = {}; MM_SEM = mmSemCour();
      MM = { statut: 'brouillon', maj: null, donnees: { prod: {}, p: {}, c: {}, av: {}, sous: [], auto: {} } };
      document.getElementById('mmMoi').innerHTML = mmCorps(MM.donnees, '', false, MM_SEM);
      document.querySelectorAll('#mmMoi details').forEach(x => x.open = true);
    });
    const champs = await page.evaluate(() =>
      [...document.querySelectorAll('#mmMoi .mm-pmr input')].map(i => i.dataset.mm).filter(k => k.endsWith('.va')));
    await page.fill('#v-mm input[data-mm="' + champs[0] + '"]', '180000');
    await page.fill('#v-mm input[data-mm="' + champs[1] + '"]', '95000');
    const net = t => t.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
    expect(net(await page.textContent('#mmPmrTP'))).toBe('275 000 €');
    // le cumul est remplacé cellule par cellule : le tableau n'est pas redessiné sous le curseur
    expect(await page.evaluate(() => document.activeElement.dataset.mm)).toBe(champs[1]);
  });

  test('les retours à la ligne saisis sont conservés à la lecture', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, 'Une difficulté\nsur deux lignes');
    expect(r.faits.replace(/ /g, ' ')).toContain('Julie : NC AV\nAlice');
    expect(r.blancFaits, 'faits marquants').toBe('pre-wrap');
    expect(r.blancFocus, 'focus de la semaine').toBe('pre-wrap');
    expect(r.blancMot, 'mot à la lignée').toBe('pre-wrap');
  });
});

/* ------------------------------------------------------------------ */
/* Le relevé automatique des invités (DM / Atelier Démarrage / 3 Jours) et la lisibilité du mur.
   Depuis le 14/09/2026, « EDM / DM » ne se saisit plus : il est lu dans le réseau. */
test.describe('Mail Manager — invités relevés et lecture du mur', () => {
  const j = n => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  // Pose un réseau minimal : moi, deux filleuls (un adhérent, un non), et quatre séances datées.
  async function poserReseau(page, dates) {
    return page.evaluate((D) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      MOI_ID = 20028;
      byId.set(20028, { id: 20028, name: 'Moi Test', parrain: 'Parrain', mgr: 'Manager', date: '2025-07-01' });
      const fil = [{ id: 30001, name: 'Invitée Nonadherente', parrain: 'Moi Test' },
                   { id: 30004, name: 'Filleul Adherent', parrain: 'Moi Test' }];
      fil.forEach(f => byId.set(f.id, f));
      children.set(norm('Moi Test'), fil);
      ADH.clear(); ADH.add(30004);            // l'adhérent n'est plus un invité
      A.length = 0; R.length = 0; F.length = 0; E.length = 0;
      const s = (id, titre, start, guests) => ({ id, th: '', thRaw: '', title: titre, start, end: start,
        lieu: 'Visio', pilotes: '', hor: '', siteId: null, max: 40, total: 5, guests, wait: [],
        link: '', pw: '', pub: '', hab: '', k: 'a', url: '#' });
      A.push(s(1, 'Découverte métier matinée', D.semPassee, [30001, 30004]),   // l'adhérent ne compte pas
             s(2, 'Atelier Démarrage', D.semPassee, [30001]),
             s(3, 'Découverte métier visio', D.semCours, [30001]),
             s(4, 'Clefs de la communication - Niveau 1', D.vieux, [20028]),   // une session que j'ai suivie
             s(5, 'Formation à venir', D.futurLoin, [20028]));                 // au-delà de 30 jours
      return true;
    }, dates);
  }

  test('EDM / DM ne se saisit plus à la main', async ({ page }) => {
    await ouvrir(page);
    const champs = await page.evaluate(() => MM_CPT.map(c => c[1]));
    expect(champs).toEqual(['R0', 'R1', 'R2', 'R-signature', 'R3', 'RX']);   // « R2 bis » renommé le 17/09/2026
    expect(champs, 'le compteur manuel a disparu').not.toContain('EDM / DM');
  });

  test('les invités en DM / AD / 3 Jours sont relevés par semaine et depuis le début', async ({ page }) => {
    await ouvrir(page);
    const sem = await page.evaluate(() => mmSemCour());
    await poserReseau(page, { semPassee: j(-4), semCours: j(1), vieux: j(-200), futurLoin: j(120) });
    const a = await page.evaluate((sem) => mmAuto(sem), sem);
    // Sur la semaine et sur l'exercice, un filleul déjà adhérent n'est plus une invitée.
    expect(a.invP, 'semaine écoulée').toMatchObject({ dm: 1, ad: 1, jr: 0 });
    expect(a.invPN.dm).toEqual(['Invitée Nonadherente']);
    expect(a.invC, 'semaine en cours').toMatchObject({ dm: 1, ad: 0, jr: 0 });
    expect(a.inv, 'sur l’exercice').toMatchObject({ dm: 1, ad: 1, jr: 0 });
    // Depuis le début, on compte tout ce qu'on a fait venir : celle qui a signé depuis était bien
    // une invitée le jour de sa Découverte Métier (régression du 14/09/2026 au soir).
    expect(a.invT, 'le cumul inclut celles et ceux devenus adhérents').toMatchObject({ dm: 2, ad: 1, jr: 0 });
    expect(a.invTN.dm.sort()).toEqual(['Filleul Adherent', 'Invitée Nonadherente']);
  });

  test('l’historique des sessions suivies remonte au début, et l’à-venir n’a plus d’horizon', async ({ page }) => {
    await ouvrir(page);
    const sem = await page.evaluate(() => mmSemCour());
    await poserReseau(page, { semPassee: j(-4), semCours: j(1), vieux: j(-200), futurLoin: j(120) });
    const a = await page.evaluate((sem) => mmAuto(sem), sem);
    // Avant, sp ne couvrait que la semaine écoulée et ag s'arrêtait à 30 jours.
    expect(a.sh.map(x => x.t), 'tout ce que j’ai suivi').toContain('Clefs de la communication - Niveau 1');
    expect(a.sp.map(x => x.t), 'la semaine écoulée reste à part').not.toContain('Clefs de la communication - Niveau 1');
    expect(a.ag.map(x => x.t), 'une session à 120 jours est bien listée').toContain('Formation à venir');
  });

  test('l’export texte détaille toutes les sessions suivies depuis le début', async ({ page }) => {
    await ouvrir(page);
    const t = await page.evaluate(() => {
      MM_OBJ = {}; MM_PRODUITS = [];
      return mmTexte({ p: {}, c: {}, av: {}, sous: [], prod: {}, auto: {
        sp: [{ d: '2026-09-12', t: 'Clefs de la communication - Niveau 1' }], sc: [], ag: [],
        sh: [{ d: '2026-05-03', t: 'Découverte métier visio' },
             { d: '2026-05-16', t: 'Atelier Démarrage' },
             { d: '2026-09-12', t: 'Clefs de la communication - Niveau 1' }] } },
        'Moi', mmSemCour());
    });
    // Avant, l'export ne donnait que le nombre : « Sessions suivies depuis le début : 3 ».
    expect(t).toContain('Sessions suivies depuis le début (3) :');
    expect(t, 'la plus récente d’abord').toContain(
      'Sessions suivies depuis le début (3) :\n'
      + '- 12/09/2026 : Clefs de la communication - Niveau 1\n'
      + '- 16/05/2026 : Atelier Démarrage\n'
      + '- 03/05/2026 : Découverte métier visio');
  });

  test('le mur range les objectifs une nature par ligne', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      const obj = { va_dec: 300000, va_pmr: 600000, eva_dec: 50000, clients_dec: 20,
                    filleuls_pmr: 12, dm_pmr: 10, r0sem_dec: 3, r1sem_dec: 2,
                    statut_dec: 'DEVMAN', statut_pmr: 'XMAN' };
      const d = { prod: { va: 30000, eva: 10000, clients: 10 }, p: {}, c: {}, av: {}, sous: [],
                  auto: { fil: 4, inv: { dm: 1 } } };
      const el = document.createElement('div');
      el.innerHTML = mmFiche(d, '', mmSemCour(), obj);
      const ligne = k => [...el.querySelectorAll('.l')].find(x => x.querySelector('.k').textContent.startsWith(k));
      return [...ligne('Objectifs').querySelectorAll('.kpi')]
        // le premier nœud texte d'une puce, c'est son intitulé (la valeur vit dans le <b>)
        .map(k => [...k.querySelectorAll('i')].map(i => i.childNodes[0].textContent.trim()));
    });
    // sept rangs, dans l'ordre demandé — les deux échéances d'une même nature restent ensemble
    expect(r).toHaveLength(7);
    expect(r[0].every(t => t.startsWith('VA + VAA personnel'))).toBe(true);
    expect(r[1].every(t => t.startsWith('VA + VAA équipe'))).toBe(true);
    expect(r[2].every(t => t.startsWith('Clients'))).toBe(true);
    expect(r[3].every(t => t.startsWith('Filleuls'))).toBe(true);
    expect(r[4].every(t => t.startsWith('Invités DM'))).toBe(true);
    expect(r[5].join(' ')).toMatch(/R0\/semaine.*R1\/semaine/);
    expect(r[6].every(t => t.startsWith('Statut'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Mail Manager — saisie et vocabulaire', () => {
  async function rendreForm(page, donnees, auto) {
    return page.evaluate(({ d, a }) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      document.querySelectorAll('[data-v="mm"]').forEach(x => x.hidden = false);
      MM_PRODUITS = []; MM_OBJ = {}; MM_SEM = mmSemCour();
      const don = Object.assign({ p: {}, c: {}, av: {}, sous: [], prod: {}, auto: a }, d);
      MM = { statut: 'brouillon', maj: null, donnees: JSON.parse(JSON.stringify(don)) };
      const el = document.getElementById('mmMoi');
      el.innerHTML = mmCorps(MM.donnees, '', false, MM_SEM);
      const val = k => { const i = el.querySelector('input[data-mm="' + k + '"]'); return i ? i.value : null; };
      const pmr = el.querySelector('.mm-pmr-d');
      return {
        compteurs: ['p.r0', 'p.r1', 'c.r0', 'av.r0'].map(val),
        clients: val('prod.clients'),
        euros: [val('prod.va'), val('prod.vp')],
        pmrReplie: pmr ? !pmr.open : null,
        pmrResume: pmr ? pmr.querySelector('summary').textContent.replace(/[\s  ]+/g, ' ').trim() : '',
        pmrLignes: el.querySelectorAll('.mm-pmr tbody tr').length,
        fiche: mmFiche(JSON.parse(JSON.stringify(don)), '', MM_SEM, {}),
        texte: mmTexte(JSON.parse(JSON.stringify(don)), 'Moi', MM_SEM),
      };
    }, { d: donnees, a: auto });
  }

  test('les cases à compter s’ouvrent sur 0, les montants restent vides', async ({ page }) => {
    await ouvrir(page);
    const r = await rendreForm(page, {}, {});
    expect(r.compteurs, 'R0 / R1 de chaque semaine et les RDV d’avance').toEqual(['0', '0', '0', '0']);
    expect(r.clients, 'le nombre de clients est un entier').toBe('0');
    expect(r.euros, 'un montant vide reste vide — 0 € n’est pas une information').toEqual(['', '']);
  });

  test('les PMR passés tiennent sur une ligne repliée, cumul en résumé', async ({ page }) => {
    await ouvrir(page);
    const r = await rendreForm(page, { prod: { pmr: { 2025: { va: 180000, eva: 420000 }, 2024: { va: 95000 } } } }, {});
    expect(r.pmrReplie, 'replié par défaut : l’historique n’occupe pas l’écran').toBe(true);
    expect(r.pmrResume).toContain('PMR passés');
    expect(r.pmrResume).toContain('275 000 € personnel');
    expect(r.pmrResume).toContain('420 000 € équipe');
    // le détail reste accessible, une ligne par exercice, sans ligne « Cumul » en double
    expect(r.pmrLignes).toBeGreaterThanOrEqual(4);
    expect(r.pmrResume).not.toContain('Cumul');
  });

  test('un filleul est un adhérent ; les autres sont des invités', async ({ page }) => {
    await ouvrir(page);
    const auto = { fil: 5, filadh: 2, filN: ['Adhérente Une', 'Adhérent Deux'],
                   filIN: ['Invitée Trois', 'Invité Quatre', 'Invité Cinq'], inv: { dm: 1 } };
    const r = await rendreForm(page, {}, auto);
    const net = t => t.replace(/[\s  ]+/g, ' ');
    expect(net(r.fiche), 'le mur affiche le nombre réel de filleuls').toContain('Filleuls<b>2</b>');
    expect(net(r.fiche), 'plus de « dont adhérents »').not.toContain('dont adhérents');
    expect(net(r.fiche)).toContain('Invités pas encore adhérents<b>3</b>');
    expect(r.texte).toContain('- Filleuls : 2');
    expect(r.texte).toContain('- Invités pas encore adhérents : 3');
  });

  test('le Passage Manager ne compte pas deux fois la production personnelle', async ({ page }) => {
    await ouvrir(page);
    const jauge = (prod) => page.evaluate((prod) => {
      MM_OBJ = {}; MM_SEM = mmSemCour();
      MM = { statut: 'brouillon', maj: null,
             donnees: { prod, p: {}, c: {}, av: {}, sous: [], auto: { statut: 'BEMAN', fn: 8, ftot: 13 } } };
      const el = document.createElement('div');
      el.innerHTML = mmObjectifs();
      const j = [...el.querySelectorAll('.mm-j')].find(x => x.textContent.includes('Volume d’affaires'));
      return j.querySelector('.t').textContent.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
    }, prod);

    // Le volume d'équipe englobe déjà le personnel : l'additionner comptait la production propre
    // deux fois. 84 690 personnel + 153 380 équipe donnait 238 070 € au lieu de 153 380 €.
    const avecEquipe = await jauge({ va: 16800, vaec: 67890, eva: 120000, evaec: 33380 });
    expect(avecEquipe).toContain('153 380 € / 500 000 € · 31 %');
    expect(avecEquipe).not.toContain('238 070');
    expect(avecEquipe, 'l’intitulé dit que le personnel est compris dedans').toContain('personnel compris');

    // Tant qu'aucune ligne d'équipe n'est renseignée, c'est la production personnelle qui compte.
    expect(await jauge({ va: 16800, vaec: 67890 })).toContain('84 690 € / 500 000 €');
    // Une équipe renseignée fait foi, même à zéro : c'est une déclaration, pas une absence.
    expect(await jauge({ va: 16800, vaec: 67890, eva: 0 })).toContain('0 € / 500 000 €');
  });

  test('l’objectif « filleuls » se mesure sur les adhérents', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      const d = { p: {}, c: {}, av: {}, sous: [], prod: {}, auto: { fil: 10, filadh: 3 } };
      const el = document.createElement('div');
      el.innerHTML = mmFiche(d, '', mmSemCour(), { filleuls_pmr: 6 });
      const i = [...el.querySelectorAll('.l')]
        .find(x => x.querySelector('.k').textContent.startsWith('Objectifs')).querySelector('i');
      return i.textContent.replace(/[\s  ]+/g, ' ');
    });
    // 3 adhérents sur 6 visés = 50 %. Avec les 10 filleuls déclarés on aurait lu 167 %.
    expect(r).toContain('50 %');
  });
});

test.describe('Mail Manager — encart « ma lignée » sur l’accueil', () => {
  // Ma descendance telle que la renvoie la RPC mm_ma_lignee : 7 personnes, 2 publiées.
  const LIG = [
    { membre_id: 40001, nom: 'Aline Publiee',  niveau: 1, parrain_id: 20028, statut: 'publie',    publie_le: '2026-01-05T08:10:00Z', serie: 3 },
    { membre_id: 40002, nom: 'Bruno Rien',     niveau: 1, parrain_id: 20028, statut: 'rien',      publie_le: null, serie: 0 },
    { membre_id: 40003, nom: 'Chloe Brouillon',niveau: 1, parrain_id: 20028, statut: 'brouillon', publie_le: null, serie: 0 },
    { membre_id: 40004, nom: 'Denis Niveau2',  niveau: 2, parrain_id: 40002, statut: 'rien',      publie_le: null, serie: 0 },
    { membre_id: 40005, nom: 'Emma Niveau2',   niveau: 2, parrain_id: 40002, statut: 'publie',    publie_le: '2026-01-05T09:00:00Z', serie: 1 },
    { membre_id: 40006, nom: 'Fanny Niveau3',  niveau: 3, parrain_id: 40004, statut: 'rien',      publie_le: null, serie: 0 },
    { membre_id: 40007, nom: 'Gael Niveau3',   niveau: 3, parrain_id: 40004, statut: 'rien',      publie_le: null, serie: 0 },
  ];

  test('l’encart liste la descendance, non-publiés de niveau 1 en tête, 5 lignes au plus', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate((L) => {
      MM_LIG = L; buildMMLignee();
      const el = document.getElementById('homeMMLig');
      const lignes = [...el.querySelectorAll('.mml-r')];
      return {
        cache: el.hidden,
        compteur: el.querySelector('.mml-n').textContent,
        noms: lignes.map(x => x.querySelector('.nm').firstChild.textContent),
        liens: lignes.map(x => x.getAttribute('href')),
        tout: el.querySelector('.mml-tout').textContent,
        toutHref: el.querySelector('.mml-tout').getAttribute('href'),
      };
    }, LIG);
    expect(r.cache).toBe(false);
    expect(r.compteur).toBe('2/7 publiés');
    // niveau 1 non publiés (brouillon avant rien), puis niveaux suivants, puis les publiés
    expect(r.noms).toEqual(['Chloe Brouillon', 'Bruno Rien', 'Denis Niveau2', 'Fanny Niveau3', 'Gael Niveau3']);
    expect(r.liens.every(h => h === null)).toBe(true);   // rien de publié parmi eux : pas de lien
    expect(r.tout).toContain('2 autres');
    expect(r.toutHref).toBe('#mail-manager?s=le-mur&f=ma-lignee');
    expect(erreurs).toEqual([]);
  });

  test('un mail manager publié ouvre sa fiche en lecture, sur la semaine en cours', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate(async (L) => {
      MM_LIG = [L[0], L[1]]; buildMMLignee();
      MM_SEM = vAddDays(mmSemCour(), -14);          // l'onglet était resté sur une semaine passée
      const a = document.querySelector('#homeMMLig a.mml-r');
      a.click();
      await new Promise(res => setTimeout(res, 150));
      return { href: a.getAttribute('href'), hash: location.hash, sem: MM_SEM === mmSemCour() };
    }, LIG);
    expect(r.href).toBe('#mail-manager?s=le-mur&v=40001');
    expect(r.hash).toContain('v=40001');
    expect(r.sem).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('sans descendance connectée, l’encart ne s’affiche pas', async ({ page }) => {
    await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const cache = await page.evaluate(() => { MM_LIG = []; buildMMLignee(); const a = document.getElementById('homeMMLig').hidden;
                                              MM_LIG = null; buildMMLignee(); return a && document.getElementById('homeMMLig').hidden; });
    expect(cache).toBe(true);
  });

  test('le mur se filtre sur ma lignée et le filtre passe dans l’adresse', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate((L) => {
      MM_LIG = [L[0]];
      MM_MUR = [
        { membre_id: 40001, nom: 'Aline Publiee', participe: true, statut: 'publie', publie_le: '2026-01-05T08:10:00Z', serie: 3 },
        { membre_id: 50001, nom: 'Hors Lignee',  participe: true, statut: 'publie', publie_le: '2026-01-05T08:00:00Z', serie: 1 },
      ];
      MM_LIGNES = MM_MUR.map(p => ({ membre_id: p.membre_id, statut: 'publie', donnees: {} }));
      MM_FILTRE = ''; const tous = mmMur();
      MM_FILTRE = 'lignee'; const lig = mmMur();
      return { tous: tous.includes('Hors Lignee'), lig: lig.includes('Hors Lignee'), aline: lig.includes('Aline Publiee'),
               url: tabState('mm').get('f') };
    }, LIG);
    expect(r.tous).toBe(true);
    expect(r.lig).toBe(false);      // ni dans les pastilles, ni dans le tableau
    expect(r.aline).toBe(true);
    expect(r.url).toBe('ma-lignee');
    expect(erreurs).toEqual([]);
  });

  test('le tableau du mur affiche les dix colonnes demandées, et le nom ouvre le mail manager', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate(() => {
      MM_LIG = []; MM_FILTRE = '';
      MM_MUR = [
        { membre_id: 40001, nom: 'Aline Publiee', participe: true, statut: 'publie', publie_le: '2026-01-05T08:10:00Z', serie: 1 },
        { membre_id: 40002, nom: 'Bruno Publie',  participe: true, statut: 'publie', publie_le: '2026-01-05T08:20:00Z', serie: 1 },
        { membre_id: 40003, nom: 'Carla Brouillon', participe: true, statut: 'brouillon', serie: 1 },
      ];
      // « p.* » = la semaine écoulée, « prod.* » = l'exercice, « auto.inv » = les invités relevés
      const ligne = (id, p, prod, inv) => ({ membre_id: id, statut: 'publie',
        donnees: { p, prod, auto: { inv, statut: 'BEMAN', filadh: 7 } } });
      MM_LIGNES = [
        ligne(40001, { r0: 4, r1: 3, r2: 2, r2b: 1, r3: 9, rx: 5 }, { va: 12000, vaec: 3000 }, { dm: 2, ad: 1, jr: 0 }),
        ligne(40002, { r0: 1, r1: 1, r2: 0, r2b: 2, r3: 4, rx: 0 }, { va: 500, vaec: 0 }, { dm: 0, ad: 3, jr: 4 }),
        { membre_id: 40003, statut: 'brouillon', donnees: { p: { r0: 99 } } },   // pas publié : hors tableau
      ];
      document.getElementById('mmMur').innerHTML = mmMur();
      const t = document.querySelector('#mmMur .mm-mw');
      // les montants français portent une espace insécable fine : on la ramène à une espace simple
      const lire = tr => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/[\u202f\u00a0]/g, ' ').trim());
      return {
        entetes: [...t.querySelectorAll('thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim()),
        aline: lire(t.querySelectorAll('tbody tr')[0]),
        bruno: lire(t.querySelectorAll('tbody tr')[1]),
        total: lire(t.querySelector('tbody tr.tot')),
        nLignes: t.querySelectorAll('tbody tr').length,
        lien: !!t.querySelector('tbody tr td .mm-lien[data-mmv="40001"]'),
        brouillon: t.textContent.includes('Carla'),
      };
    });
    expect(r.entetes).toEqual(['Personne', 'R0', 'R1', 'R2', 'RX', 'R-signature',
      'VA + VAA VC perso', 'VA + VAA EC perso', 'DM', 'AD', '3 Jours']);
    // RX avant R-signature, comme demandé ; R3 n'est pas au mur
    expect(r.aline).toEqual(['Aline Publiee', '4', '3', '2', '5', '1', '12 000 €', '3 000 €', '2', '1', '0']);
    expect(r.bruno).toEqual(['Bruno Publie', '1', '1', '0', '0', '2', '500 €', '0 €', '0', '3', '4']);
    expect(r.total).toEqual(['Total (2)', '5', '4', '2', '5', '3', '12 500 €', '3 000 €', '2', '4', '4']);
    expect(r.nLignes, 'deux publiés plus la ligne de total').toBe(3);
    expect(r.brouillon, 'un brouillon n’entre pas dans le tableau').toBe(false);
    expect(r.lien).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('un clic sur le nom dans le tableau ouvre le mail manager de la personne', async ({ page }) => {
    await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate(async () => {
      MM_LIG = []; MM_FILTRE = ''; MM_SUB = 'mur'; MM_LU = null;
      MM_MUR = [{ membre_id: 40001, nom: 'Aline Publiee', participe: true, statut: 'publie', publie_le: '2026-01-05T08:10:00Z', serie: 1 }];
      MM_LIGNES = [{ membre_id: 40001, statut: 'publie', donnees: { p: { r1: 3 }, auto: { statut: 'BEMAN' } } }];
      SB = { from: () => ({ select() { return this; }, eq() { return this; },
                            maybeSingle: async () => ({ data: null, error: null }) }) };
      document.getElementById('mmMur').innerHTML = mmMur();
      document.querySelector('#mmMur .mm-mw .mm-lien').click();
      await new Promise(r => setTimeout(r, 60));
      return { lu: MM_LU && MM_LU.id, nom: MM_LU && MM_LU.nom,
               fiche: document.getElementById('mmMur').textContent.includes('Retour au mur') };
    });
    expect(r.lu, 'le clic ouvre bien sa fiche').toBe(40001);
    expect(r.nom).toBe('Aline Publiee');
    expect(r.fiche).toBe(true);
  });

  test('la pastille de retard suit la descendance du serveur, pas l’arbre local', async ({ page }) => {
    await ouvrir(page);
    await poser(page, { atelier: ATELIER_SEMAINE_PASSEE, dm: '2099-01-01' });
    const r = await page.evaluate(() => {
      if (todayIso <= mmSemCour()) return 'lundi';
      // Jeu d'essai pessimiste : l'arbre local connaît 30004 comme filleul, mais le serveur ne le
      // renvoie pas (compte non rattaché, ou hors de ma descendance) — il ne doit pas compter.
      MM_LIG = [{ membre_id: 40002, nom: 'Bruno Rien', niveau: 1, statut: 'rien', serie: 0 }];
      MM_MUR = [
        { membre_id: 40002, nom: 'Bruno Rien', participe: true, statut: 'rien', serie: 0 },
        { membre_id: 30004, nom: 'Filleul Adherent', participe: true, statut: 'rien', serie: 0 },
      ];
      return mmEnRetard().map(p => p.membre_id);
    });
    if (r === 'lundi') test.skip(true, 'la pastille ne s’allume qu’à partir du mardi');
    expect(r).toEqual([40002]);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Ressources — simulateurs et courriers', () => {
  // Onglet ajouté le 15/09/2026. Les calculs reprennent les classeurs de Florian : les valeurs
  // attendues ci-dessous sont celles que calcule Excel sur les mêmes hypothèses.
  const entrer = (page, hash) => page.evaluate((h) => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    window.__booted = true;
    if (h) { location.hash = h; routeHash(); } else { showTab('res'); curTab = 'res'; }
    return (document.querySelector('section.view.on') || {}).id;
  }, hash);

  test('assurance vie : même épargne acquise que le classeur « Épargne acquise »', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const d = RS_SIMS.find(t => t.id === 'av');
      const v = Object.assign({}, rsVals(d), { age: 0, init: 700, mens: 150, rdt: 5.5, frais: 1, fv: 4.8, fg: 1, cmp: 0 });
      const an = n => { const o = d.calc(Object.assign({}, v, { duree: n })); return o.table.rows[n - 1]; };
      return { un: an(1), huit: an(8) };
    });
    const sp = s => s.replace(/\s/g, ' ');       // séparateur de milliers : espace fine insécable
    expect(sp(r.un[r.un.length - 1])).toBe('2 443 €');       // Excel : 2 443,03
    expect(sp(r.huit[r.huit.length - 1])).toBe('17 298 €');  // Excel : 17 298,49
    expect(erreurs).toEqual([]);
  });

  test('assurance vie simple (par défaut) : les chiffres du « Simulateur Ass. Vie V1 »', async ({ page }) => {
    // Classeur de Florian : 41 ans, 3 000 € de capital, 100 €/mois, 4,5 % net, sans frais.
    const erreurs = await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const d = RS_SIMS.find(t => t.id === 'av');
      const v0 = rsVals(d);
      const defauts = { frais: v0.frais, rachat: v0.rachat, cmp: v0.cmp };
      const v = Object.assign({}, v0, { age: 41, init: 3000, mens: 100, rdt: 4.5, duree: 48 });
      const o = d.calc(v);
      const ligne = n => o.table.rows[n - 1];
      return { defauts, h: o.table.h, l1: ligne(1), l10: ligne(10), l20: ligne(20), l48: ligne(48),
               kpis: o.kpis.map(k => k.k), tables: (o.tables || []).length };
    });
    const sp = a => a.map(x => String(x).replace(/\s/g, ' '));
    expect(r.defauts).toEqual({ frais: 0, rachat: 0, cmp: 0 });
    expect(r.h).toEqual(['Année', 'Âge', 'Capital début d’année', 'Versements de l’année', 'Versements cumulés', 'Intérêts de l’année', 'Intérêts cumulés', 'Capital constitué']);
    // Excel : 1 | 41 | 3 000 | 4 200 | 4 200 | 164,25 | 164,25 | 4 364,25
    expect(sp(r.l1)).toEqual(['1', '41', '3 000 €', '4 200 €', '4 200 €', '164 €', '164 €', '4 364 €']);
    expect(sp(r.l10).slice(-1)).toEqual(['19 764 €']);    // Excel : 19 764,19
    expect(sp(r.l20).slice(-3)).toEqual(['1 948 €', '18 798 €', '45 798 €']);   // Excel : 1 948,50 · 18 798,46 · 45 798,46
    expect(sp(r.l48).slice(-1)).toEqual(['223 446 €']);   // Excel : 223 446,29
    expect(r.kpis).toEqual(['Capital constitué', 'Versements cumulés', 'Intérêts cumulés']);
    expect(r.tables).toBe(0);
    expect(erreurs).toEqual([]);
  });

  test('assurance vie : les options frais, rachat au terme et comparaison s’activent à la demande', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page, '#ressources');
    const r = await page.evaluate(() => {
      const vis = k => { const e = document.querySelector('#rsForm [data-f="' + k + '"]'); return !!e && !e.hidden; };
      const cocher = k => { const e = document.querySelector('#rsForm [data-k="' + k + '"]'); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('input', { bubbles: true })); };
      const avant = { fv: vis('fv'), couple: vis('couple'), rdt2: vis('rdt2'), rachat: !!document.querySelector('#rsOut .rs-rachat') };
      cocher('frais'); cocher('rachat');
      const apres = { fv: vis('fv'), fg: vis('fg'), couple: vis('couple'), fv2: vis('fv2'),
        rachat: [...document.querySelectorAll('#rsOut .rs-rachat td:first-child')].map(td => td.textContent),
        kpis: [...document.querySelectorAll('#rsOut .rs-kpi .k')].map(x => x.textContent),
        th: [...document.querySelectorAll('#rsOut details .rs-tbl th')].map(x => x.textContent) };
      cocher('cmp');
      const cmp = { rdt2: vis('rdt2'), fv2: vis('fv2'), kpis: [...document.querySelectorAll('#rsOut .rs-kpi .k')].map(x => x.textContent) };
      return { avant, apres, cmp, hash: hashFor('res') };
    });
    expect(r.avant).toEqual({ fv: false, couple: false, rdt2: false, rachat: false });
    expect(r.apres.fv && r.apres.fg && r.apres.couple).toBe(true);
    expect(r.apres.fv2).toBe(false);
    expect(r.apres.th).toContain('Frais cumulés');
    expect(r.apres.kpis).toEqual(['Capital constitué', 'Versements cumulés', 'Gains nets de frais', 'Frais payés', 'Net perçu au rachat', 'Rendement net annualisé']);
    // durée par défaut 15 ans : plus de 8 ans, donc abattement puis 7,5 %
    expect(r.apres.rachat).toEqual(['Capital racheté', 'dont versements (non imposés)', 'dont gains', 'Abattement annuel (personne seule)', 'Gains imposables', 'Impôt sur le revenu (7,5 %)', 'Prélèvements sociaux (17,2 % des gains)', 'Net perçu']);
    expect(r.cmp.rdt2 && r.cmp.fv2).toBe(true);
    expect(r.cmp.kpis[1]).toBe('Contrat 2 au terme');
    expect(r.hash).toContain('frais=1');
    expect(r.hash).toContain('rachat=1');
    expect(erreurs).toEqual([]);
  });

  test('assurance vie : fiscalité du rachat au terme, avant et après 8 ans', async ({ page }) => {
    await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const d = RS_SIMS.find(t => t.id === 'av');
      const base = Object.assign({}, rsVals(d), { age: 0, init: 10000, mens: 0, rdt: 5, rachat: 1 });
      const net = o => o.tables[0].tot[1];
      const lig = o => Object.fromEntries(o.tables[0].rows);
      const cinq = d.calc(Object.assign({}, base, { duree: 5 }));
      const dix = d.calc(Object.assign({}, base, { duree: 10 }));
      const dixC = d.calc(Object.assign({}, base, { duree: 10, couple: '2' }));
      return { cinq: lig(cinq), netCinq: net(cinq), dix: lig(dix), netDix: net(dix), netDixC: net(dixC) };
    });
    const sp = s => String(s).replace(/\s/g, ' ');
    // 10 000 € à 5 % sans versement : 12 762,82 € à 5 ans → gains 2 762,82 ; 12,8 % = 353,64 ; 17,2 % = 475,21
    expect(sp(r.cinq['dont gains'])).toBe('2 763 €');
    expect(sp(r.cinq['Impôt sur le revenu (prélèvement forfaitaire 12,8 %)'])).toBe('− 354 €');
    expect(sp(r.netCinq)).toBe('11 934 €');
    // 10 ans : 16 288,95 € → gains 6 288,95 ; abattement 4 600 → 1 688,95 × 7,5 % = 126,67 ; PS 1 081,70
    expect(sp(r.dix['Abattement annuel (personne seule)'])).toBe('− 4 600 €');
    expect(sp(r.dix['Impôt sur le revenu (7,5 %)'])).toBe('− 127 €');
    expect(sp(r.netDix)).toBe('15 081 €');
    expect(sp(r.netDixC)).toBe('15 207 €');   // couple : gains entièrement couverts par 9 200 €
  });

  test('assurance vie : un ancien lien avec des frais dans l’adresse réactive l’option', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      window.__booted = true;
      location.hash = '#ressources?fv=2&rdt=4'; routeHash();
      const v1 = Object.assign({}, rsVals(RS_SIMS.find(t => t.id === 'av')));
      location.hash = '#ressources?rdt=4'; routeHash();
      const v2 = Object.assign({}, rsVals(RS_SIMS.find(t => t.id === 'av')));
      return { f1: v1.frais, fv1: v1.fv, f2: v2.frais };
    });
    expect(r).toEqual({ f1: 1, fv1: 2, f2: 0 });
  });

  test('valeurs par défaut : assurance vie 4,5 % net, SCPI 5 % distribués et 100 % des dividendes réinvestis', async ({ page }) => {
    await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const av = rsVals(RS_SIMS.find(t => t.id === 'av')), sc = rsVals(RS_SIMS.find(t => t.id === 'scpi'));
      return { av: av.rdt, scpi: sc.rdt, reinv: sc.reinv, pr: sc.pr };
    });
    expect(r).toEqual({ av: 4.5, scpi: 5, reinv: 1, pr: 100 });
  });

  test('SCPI : une part seulement des dividendes réinvestie, le reste perçu', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page, '#ressources?outil=scpi');
    const r = await page.evaluate(() => {
      const d = RS_SIMS.find(t => t.id === 'scpi');
      const base = Object.assign({}, rsVals(d), { prix: 250, parts: 20, mens: 200, rdt: 5.5, dj: 6, duree: 5, dr: 35, reinv: 1 });
      const cent = d.calc(Object.assign({}, base, { pr: 100 })), moitie = d.calc(Object.assign({}, base, { pr: 50 }));
      const zero = d.calc(Object.assign({}, base, { pr: 0 })), sans = d.calc(Object.assign({}, base, { reinv: 0 }));
      const kpi = (o, k) => o.kpis.find(x => x.k === k).v;
      const cocher = document.querySelector('#rsForm [data-f="pr"]');
      return { cap2: [cent.table.rows[1][1], moitie.table.rows[1][1]], reinv1: moitie.table.rows[0][3],
               netM: kpi(moitie, 'Rendement global si revente'), zero: JSON.stringify(zero.table.rows) === JSON.stringify(sans.table.rows),
               champ: !!cocher && !cocher.hidden };
    });
    const sp = s => String(s).replace(/\s/g, ' ');
    expect(sp(r.cap2[0])).toBe('8 757 €');     // 100 % : 6 200 + 2 400 + 156,75
    expect(sp(r.cap2[1])).toBe('8 678 €');     // 50 % : 6 200 + 2 400 + 78,38
    expect(sp(r.reinv1)).toBe('78 €');
    expect(r.zero).toBe(true);                 // 0 % réinvesti = pas de réinvestissement
    expect(r.champ).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('Girardin : la réduction et l’apport se calculent l’un l’autre (2 750 € à 10 % → 3 025 €)', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page, '#ressources?outil=girardin');
    const val = k => page.inputValue('#rsForm [data-k="' + k + '"]');
    const kpi = () => page.$$eval('#rsOut .rs-kpi .v', l => l.map(x => x.textContent.replace(/\s/g, ' ')));
    // valeurs par défaut : l'exemple de Florian
    expect(await val('rdt')).toBe('10');
    expect(await val('app')).toBe('2750');
    expect(await val('red')).toBe('3025');
    // saisir l'apport → réduction
    await page.fill('#rsForm [data-k="app"]', '5000');
    expect(await val('red')).toBe('5500');
    expect((await kpi()).slice(0, 3)).toEqual(['5 500 €', '5 000 €', '500 €']);
    // saisir la réduction → apport
    await page.fill('#rsForm [data-k="red"]', '3025');
    expect(await val('app')).toBe('2750');
    // changer la rentabilité recalcule l'apport (la réduction reste celle saisie)
    await page.fill('#rsForm [data-k="rdt"]', '12');
    expect(await val('red')).toBe('3025');
    expect(await val('app')).toBe('2700.89');
    // puis revenir à l'apport : c'est la réduction qui suit
    await page.fill('#rsForm [data-k="app"]', '2750');
    await page.fill('#rsForm [data-k="rdt"]', '10');
    expect(await val('red')).toBe('3025');
    // les notes disent le report de l'excédent sur 5 ans et la fraction retenue dans le plafond des niches
    const notes = await page.$eval('#rsOut .rs-notes', n => n.textContent.replace(/\s/g, ' '));
    expect(notes).toContain('5 années suivantes');
    expect(notes).toContain('44 %');
    expect(notes).toContain('34 %');
    expect(notes).toContain('52 941 €');
    expect(erreurs).toEqual([]);
  });

  test('SCPI : dividendes et réinvestissement conformes au classeur « SCPI »', async ({ page }) => {
    await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const d = RS_SIMS.find(t => t.id === 'scpi');
      const base = Object.assign({}, rsVals(d), { prix: 250, parts: 20, mens: 200, rdt: 5.5, dj: 6, duree: 5, dr: 35 });
      const sans = d.calc(Object.assign({}, base, { reinv: 0 })).table.rows;
      const avec = d.calc(Object.assign({}, base, { reinv: 1 })).table.rows;
      return { div1: sans[0][2], cap2: avec[1][1], div2: sans[1][2] };
    });
    const sp = s => s.replace(/\s/g, ' ');
    expect(sp(r.div1)).toBe('157 €');        // 156,75
    expect(sp(r.div2)).toBe('360 €');        // 360,25
    expect(sp(r.cap2)).toBe('8 757 €');      // 8 756,75 : le dividende de l'an 1 est réinvesti
  });

  test('objectif d’activité : 4,2 R1 par semaine comme dans « Projection »', async ({ page }) => {
    await ouvrir(page);
    await entrer(page);
    const k = await page.evaluate(() => RS_SIMS.find(t => t.id === 'activite').calc({ va: 500000, vpm: 1800, panier: 5000, conv: 48.5, sem: 47 }).kpis);
    expect(k[3].v).toBe('4,2');
    expect(k[1].v).toBe('96');
  });

  test('chaque simulateur et chaque courrier se rend sans erreur, y compris sur téléphone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const erreurs = await ouvrir(page);
    await entrer(page);
    const r = await page.evaluate(() => {
      const res = [];
      RS_SIMS.forEach(t => { rsOuvrirSim(t.id); res.push([t.id, document.querySelectorAll('#rsOut .rs-kpi').length, document.documentElement.scrollWidth]); });
      showResSub('doc');
      RS_DOCS.forEach(t => { rsOuvrirDoc(t.id); res.push([t.id, document.querySelectorAll('#rsPaper p').length, document.documentElement.scrollWidth]); });
      return res;
    });
    for (const [id, n, w] of r) {
      expect(n, id + ' ne rend rien').toBeGreaterThan(0);
      expect(w, id + ' déborde en largeur sur téléphone').toBeLessThanOrEqual(390);
    }
    expect(erreurs).toEqual([]);
  });

  test('les hypothèses d’un simulateur passent dans l’adresse, jamais les champs d’un courrier', async ({ page }) => {
    await ouvrir(page);
    const vue = await entrer(page, '#ressources?outil=per&rdt=4');
    expect(vue).toBe('v-res');
    const r = await page.evaluate(async () => {
      const avant = { outil: RS_SIM, rdt: RS_VAL.per.rdt, champ: document.getElementById('rs_per_rdt').value };
      const i = document.getElementById('rs_per_vp');
      i.value = '3000'; i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(ok => setTimeout(ok, 20));
      const hSim = location.hash;
      showResSub('doc'); rsOuvrirDoc('avt'); curTab = 'res';
      const n = document.getElementById('rs_avt_nom');
      n.value = 'Durand'; n.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(ok => setTimeout(ok, 20));
      return { avant, hSim, hDoc: location.hash, apercu: document.getElementById('rsPaper').textContent };
    });
    expect(r.avant).toEqual({ outil: 'per', rdt: 4, champ: '4' });
    expect(r.hSim).toContain('outil=per');
    expect(r.hSim).toContain('vp=3000');
    expect(r.hDoc).toContain('modele=rachat-total-assurance-vie');
    expect(r.hDoc).not.toContain('Durand');
    expect(r.apercu).toContain('DURAND');
  });

  test('le courrier Word est un .docx valide qui contient le texte saisi', async ({ page }) => {
    await ouvrir(page);
    await entrer(page, '#ressources?s=courriers&modele=cloture-livret');
    await page.fill('#rs_livret_prenom', 'Léa');
    await page.fill('#rs_livret_nom', 'Durand');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rsDocx')]);
    // en file:// Chromium ignore le nom proposé pour un blob ; en ligne, le fichier porte ce nom
    if (!page.url().startsWith('file:')) expect(dl.suggestedFilename()).toBe('Clôture de livret - Durand.docx');
    expect(await page.evaluate(() => rsNomFichier(rsDef('livret')))).toBe('Clôture de livret - Durand');
    const f = path.join(require('os').tmpdir(), 'kairos-test.docx');
    await dl.saveAs(f);
    const py = require('child_process').spawnSync('python3', ['-c', [
      'import sys, zipfile, xml.dom.minidom as m',
      'z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',
      'for n in z.namelist():',
      '    if n.endswith(".xml") or n.endswith(".rels"): m.parseString(z.read(n))',
      'print(z.read("word/document.xml").decode())'].join('\n'), f], { encoding: 'utf8' });
    test.skip(py.error && py.error.code === 'ENOENT', 'python3 absent');
    expect(py.status, py.stderr).toBe(0);
    expect(py.stdout).toContain('Léa DURAND');
    expect(py.stdout).toContain('Livret A');
    expect(py.stdout).toContain('w:highlight');          // le numéro manquant reste surligné
  });

  // Crédit immobilier revu le 24/09/2026 : chiffres relevés sur le simulateur du confrère (captures).
  const credit = (page, o) => page.evaluate((o) => {
    const d = RS_SIMS.find(t => t.id === 'credit');
    const r = d.calc(Object.assign({}, rsVals(d), { rev: 0, chg: 0, apport: 0, fdos: 0, fgar: 0, fcou: 0, hor: 5 }, o));
    const k = {}; r.kpis.forEach(x => k[x.k] = x.v.replace(/\s/g, ' '));
    return { k, an1: r.table.rows[0].map(x => String(x).replace(/\s/g, ' ')), cmp: r.tables[0].rows, mois: r.tableM.rows.length, series: r.chart.series.map(x => x.n) };
  }, o);

  test('crédit : je saisis la mensualité (assurance incluse) → capital empruntable, intérêts, CRD à 5 ans', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page);
    const a = await credit(page, { mode: 'mens', mensu: 1000, minc: 'inc', duree: 25, taux: 3.5, ass: 0.34, assmode: 'ini' });
    expect(a.k['Capital empruntable']).toBe('189 051 €');
    expect(a.k['Mensualité hors assurance']).toBe('946,43 €');
    expect(a.k['Coût des intérêts']).toBe('94 879 €');
    expect(a.k['Coût de l’assurance']).toBe('16 069 €');
    expect(a.k['Coût total du crédit']).toBe('110 948 €');
    expect(a.k['Capital restant dû à 5 ans']).toBe('163 190 €');
    expect(a.k['Capital amorti à 5 ans']).toBe('25 861 €');
    const b = await credit(page, { mode: 'mens', mensu: 1000, minc: 'inc', duree: 25, taux: 3.7, ass: 0.30, assmode: 'ini' });
    expect([b.k['Capital empruntable'], b.k['Mensualité hors assurance'], b.k['Coût des intérêts'], b.k['Coût de l’assurance'],
            b.k['Capital restant dû à 5 ans'], b.k['Capital amorti à 5 ans']])
      .toEqual(['186 423 €', '953,39 €', '99 595 €', '13 982 €', '161 513 €', '24 910 €']);
    // capital amorti / intérêts / assurance séparés, année par année et mois par mois
    expect(a.series).toEqual(['Capital amorti', 'Intérêts', 'Assurance']);
    expect(a.mois).toBe(300);
    expect(a.an1[1]).toBe('1 000,00 €');                // échéance constante, assurance comprise
    expect(a.cmp.map(r => r[0])).toEqual(['10 ans', '15 ans', '20 ans', '25 ans (votre durée)']);
    expect(a.cmp.map(r => r[1])).toEqual(['3,20 %', '3,30 %', '3,40 %', '3,50 %']);
    expect(erreurs).toEqual([]);
  });

  test('crédit : je saisis le capital, hors assurance, assurance dégressive, ancien lien', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page);
    const c = await credit(page, { mode: 'cap', montant: 200000, duree: 20, taux: 3, ass: 0, assmode: 'ini' });
    expect(c.k['Mensualité']).toBe('1 109,20 €');       // 200 000 € à 3 % sur 20 ans
    const h = await credit(page, { mode: 'mens', mensu: 1109.2, minc: 'hors', duree: 20, taux: 3, ass: 0.3 });
    expect(h.k['Capital empruntable']).toBe('200 000 €'); // hors assurance : 1 109,20 € ne couvre que la part crédit → on retrouve les 200 000 €
    const i = await credit(page, { mode: 'cap', montant: 200000, duree: 20, taux: 3, ass: 0.3, assmode: 'ini' });
    const d = await credit(page, { mode: 'cap', montant: 200000, duree: 20, taux: 3, ass: 0.3, assmode: 'crd' });
    const n = s => +s.replace(/[^\d,]/g, '').replace(',', '.');
    expect(n(i.k['Coût de l’assurance'])).toBe(12000);    // 200 000 × 0,3 % × 20 ans
    expect(n(d.k['Coût de l’assurance'])).toBeLessThan(7000); // dégressive : sur le capital restant dû
    // lien d'avant la refonte : un montant sans mode = « je saisis le capital »
    await page.evaluate(() => { location.hash = '#ressources?outil=credit-immobilier&montant=250000'; routeHash(); });
    expect(await page.evaluate(() => rsVals(rsDef('credit')).mode)).toBe('cap');
    expect(await page.locator('#rs_credit_montant').isVisible()).toBe(true);
    expect(await page.locator('#rs_credit_mensu').isVisible()).toBe(false);
    expect(erreurs).toEqual([]);
  });

  test('crédit : comparateur de prêts — ajouter, retirer, rien dans l’adresse ni le stockage', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await entrer(page, '#ressources?outil=credit-immobilier&mode=cap&montant=200000&duree=20&taux=3&ass=0');
    await page.click('#rsCmpAdd');
    await page.fill('#rs_credit_duree', '25');
    await page.click('#rsCmpAdd');
    const lignes = page.locator('.rs-cmpt tbody tr');
    await expect(lignes).toHaveCount(2);
    await expect(lignes.nth(0)).toContainText('1 109,20');
    await expect(lignes.nth(0).locator('td.rs-best')).toHaveCount(1);    // coût total le plus bas : 20 ans
    await expect(lignes.nth(1).locator('td.rs-best')).toHaveCount(1);    // mensualité la plus basse : 25 ans
    await page.click('[data-cmpdel="0"]');
    await expect(lignes).toHaveCount(1);
    expect(await page.evaluate(() => hashFor('res'))).not.toContain('cmp');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('200');
    // les autres simulateurs n'ont pas de comparateur
    await entrer(page, '#ressources?outil=girardin');
    await expect(page.locator('#rsCmpAdd')).toHaveCount(0);
    expect(erreurs).toEqual([]);
  });
});

test.describe('Ma lignée — tableau de bord, progression, victoires, arbre', () => {
  // Pose une lignée : 101 filleule directe connectée, 102 filleule directe hors Kairos,
  // 103 niveau 2 sous 101, 104 invité non adhérent, 105 adhérent sous l'invité 104.
  async function poserLig(page) {
    return page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      MOI_ID = 20028; byId.set(20028, { id: 20028, name: 'Moi Test', parrain: 'Aucun' });
      DATA = { adhDates: { '101': vAddDays(todayIso, -350), '102': vAddDays(todayIso, -100), '103': vAddDays(todayIso, -20), '105': vAddDays(todayIso, -5) } };
      ADH.clear(); [101, 102, 103, 105].forEach(i => ADH.add(i));
      A.length = 0; R.length = 0; F.length = 0; E.length = 0;
      A.push({ id: 1, title: 'DM', start: vAddDays(todayIso, -10), guests: [101] },
             { id: 2, title: 'AD', start: vAddDays(todayIso, -90), guests: [102] },
             { id: 3, title: '3JR', start: vAddDays(todayIso, 9), guests: [102] });
      const cour = mmSemCour(), w = n => vAddDays(cour, -7 * n);
      const ligne = (id, n, r1, va) => ({ membre_id: id, semaine: w(n), donnees: { p: { r1 }, av: { r1: 2, r2: 1 }, prod: { va } } });
      LIG = {
        liste: [
          { membre_id: 101, nom: 'Aline', niveau: 1, parrain_id: 20028, connecte: true, participe: true, parcours: { statut: 'ROLE_NEOMAN', etapes: { objectifs_neoman: { n: 3, tot: 12 } } } },
          { membre_id: 102, nom: 'Bea', niveau: 1, parrain_id: 20028, connecte: false, participe: true, parcours: null },
          { membre_id: 103, nom: 'Chloe', niveau: 2, parrain_id: 101, connecte: true, participe: true, parcours: { statut: 'ROLE_NEOMAN', etapes: {} } },
          { membre_id: 104, nom: 'Invite', niveau: 1, parrain_id: 20028, connecte: false, participe: true, parcours: null },
          { membre_id: 105, nom: 'Sous Invite', niveau: 2, parrain_id: 104, connecte: false, participe: true, parcours: null },
        ],
        mm: { 101: [ligne(101, 6, 1, 1000), ligne(101, 1, 2, 5000), ligne(101, 0, 3, 8000)],
              103: [ligne(103, 0, 4, 2000)] },
        moi: [{ semaine: w(1), statut: 'publie', donnees: { p: { r1: 5 } } }, { semaine: w(0), statut: 'brouillon', donnees: { p: { r1: 7 } } }],
        vict: [
          { membre_id: 101, nom: 'Aline', cle: 'trois_jours', jour: vAddDays(todayIso, -2) },
          { membre_id: 20028, nom: 'Moi Test', cle: 'client1', jour: vAddDays(todayIso, -5) },
          { membre_id: 999, nom: 'Hors Lignee', cle: 'hab_mia', jour: vAddDays(todayIso, -8) },
        ],
        bravos: {},
      };
      LIG_SUB = 'tab'; LIG_PORTEE = ''; LIG_TRI = { col: 'relance', dir: 'desc' }; LIG_QUI = 'moi'; LIG_N = 12; LIG_VF = ''; LIG_INV = false;
      document.querySelectorAll('[data-v="lig"]').forEach(x => x.hidden = false);
      window.__booted = true;
      return true;
    });
  }

  test('le tableau ne garde que les adhérents et nomme ce qu’il faut relancer', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserLig(page);
    const r = await page.evaluate(() => {
      const l = ligTrier(ligLignes());
      const par = Object.fromEntries(l.map(x => [x.nom, x]));
      LIG_PORTEE = 'directs';
      const directs = ligLignes().map(x => x.nom).sort();
      LIG_PORTEE = '';
      showTab('lig'); buildLig();
      return {
        noms: l.map(x => x.nom),
        aline: { sig: par.Aline.sig.map(s => s[0]), r1: par.Aline.r1, obj: par.Aline.obj, mmCour: par.Aline.mmCour },
        bea: par.Bea.sig.map(s => s[0]),
        chloe: par.Chloe.sig.map(s => s[0]),
        directs,
        lignes: document.querySelectorAll('#ligCorps .lg-tbl tbody tr').length,
        note: document.querySelector('#ligCorps .mm-note').textContent,
      };
    });
    expect(r.noms).not.toContain('Invite');                   // non adhérent : hors tableau
    expect(r.noms[r.noms.length - 1]).toBe('Aline');          // la plus à jour en dernier
    expect(r.aline.sig).toEqual(['adh']);                     // adhésion à renouveler sous 30 jours
    expect(r.aline.r1).toBe(5);                               // 2 + 3 sur les 4 dernières semaines
    expect(r.aline.obj).toEqual({ n: 3, tot: 12 });
    expect(r.aline.mmCour).toBe(true);
    expect(r.bea).toEqual(['seance', 'kairos']);              // vue il y a 90 jours, pas sur Kairos
    expect(r.chloe).toEqual(['seance']);                      // son mail manager de la semaine est publié
    expect(r.directs).toEqual(['Aline', 'Bea']);
    expect(r.lignes).toBe(4);
    expect(r.note).toContain('1 membre invité');
    expect(erreurs).toEqual([]);
  });

  test('la progression range les R1 sur la semaine où ils ont eu lieu et somme la lignée', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserLig(page);
    const r = await page.evaluate(() => {
      const cour = mmSemCour(), w = n => vAddDays(cour, -7 * n);
      const r1 = LIG_METRIQUES.find(m => m.k === 'r1'), va = LIG_METRIQUES.find(m => m.k === 'va');
      const moi = ligSerie(r1, 'moi', 12), lig = ligSerie(r1, 'lignee', 12), vaL = ligSerie(va, 'lignee', 12);
      const at = (s, x) => (s.find(p => p.s === x) || {}).v;
      LIG_SUB = 'prog'; LIG_QUI = 'lignee'; buildLig();
      return {
        finMoi: moi[moi.length - 1].s === w(1),
        moiW1: at(moi, w(1)), moiW2: at(moi, w(2)),
        ligW1: at(lig, w(1)), ligW2: at(lig, w(2)),
        vaCour: at(vaL, w(0)),
        cartes: document.querySelectorAll('#ligCorps .lg-carte').length,
        courbes: document.querySelectorAll('#ligCorps .lg-svg').length,
      };
    });
    expect(r.finMoi).toBe(true);        // la série des flux s'arrête à la semaine dernière
    expect(r.moiW1).toBe(7);            // mon brouillon de la semaine en cours compte pour la semaine écoulée
    expect(r.moiW2).toBe(5);
    expect(r.ligW1).toBe(3 + 4);        // Aline + Chloé, publiés cette semaine
    expect(r.ligW2).toBe(2);
    expect(r.vaCour).toBe(8000 + 2000);
    expect(r.cartes).toBe(5);
    expect(r.courbes).toBe(5);
    expect(erreurs).toEqual([]);
  });

  test('le mur des victoires se filtre sur ma lignée et on ne s’applaudit pas soi-même', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserLig(page);
    const r = await page.evaluate(() => {
      LIG_SUB = 'vic'; buildLig();
      const tous = [...document.querySelectorAll('#ligCorps .lg-v')].map(x => x.textContent);
      const boutons = document.querySelectorAll('#ligCorps button[data-ligb]').length;
      LIG_VF = 'lignee'; buildLig();
      const miens = [...document.querySelectorAll('#ligCorps .lg-v')].map(x => x.textContent);
      return { tous, boutons, miens, url: tabState('lig').toString() };
    });
    expect(r.tous.length).toBe(3);
    expect(r.tous[0]).toContain('3 Jours de la Réussite');
    expect(r.tous.join(' ')).toContain('premier client');
    expect(r.tous.join(' ')).toContain('habilitation MIA');
    expect(r.boutons).toBe(2);                 // pas de bouton sur ma propre victoire
    expect(r.miens.join(' ')).not.toContain('Hors Lignee');
    expect(r.miens.length).toBe(2);
    expect(r.url).toBe('s=victoires&f=ma-lignee');
    expect(erreurs).toEqual([]);
  });

  test('l’arbre cache les invités, sauf ceux qui ont un adhérent en dessous', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserLig(page);
    const r = await page.evaluate(() => {
      LIG_SUB = 'arb'; buildLig();
      const noms = () => [...document.querySelectorAll('#ligCorps .lg-an')].map(x => x.textContent);
      const sans = noms();
      const cb = document.getElementById('ligInv'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { sans, avec: noms(), tete: document.querySelector('#ligCorps .mm-sub').textContent };
    });
    expect(r.sans).toEqual(['Moi Test', 'Aline', 'Chloe', 'Bea', 'Invite', 'Sous Invite']);
    expect(r.tete).toContain('4 adhérents sous toi');
    expect(r.avec.length).toBe(6);
    expect(erreurs).toEqual([]);
  });

  test('l’adresse garde le sous-onglet et les réglages, dans les deux sens', async ({ page }) => {
    await ouvrir(page);
    await poserLig(page);
    const r = await page.evaluate(() => {
      ligApplyState(new URLSearchParams('s=progression&qui=lignee&n=26'));
      const a = { sub: LIG_SUB, qui: LIG_QUI, n: LIG_N, url: tabState('lig').toString() };
      ligApplyState(new URLSearchParams('portee=directs&tri=nom.asc'));
      const b = { sub: LIG_SUB, portee: LIG_PORTEE, tri: LIG_TRI, url: tabState('lig').toString() };
      return { a, b, slug: hashFor('lig') };
    });
    expect(r.a).toEqual({ sub: 'prog', qui: 'lignee', n: 26, url: 's=progression&qui=lignee&n=26' });
    expect(r.b.sub).toBe('tab');
    expect(r.b.tri).toEqual({ col: 'nom', dir: 'asc' });
    expect(r.b.url).toBe('portee=directs&tri=nom.asc');
    expect(r.slug.startsWith('#ma-lignee')).toBe(true);
  });
});

test.describe('Navigation — le logo mène à l’accueil', () => {
  test('plus d’entrée « Accueil » dans le menu, le logo et KAIROS ramènent à l’accueil', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      window.__booted = true;
      showTab('cat'); curTab = 'cat';
    });
    const r = await page.evaluate(() => ({
      entrees: [...document.querySelectorAll('#side .side-nav button[data-v]')].map(b => b.dataset.v),
      groupes: [...document.querySelectorAll('#side .grp')].map(g => g.textContent),
    }));
    expect(r.entrees).not.toContain('home');
    expect(r.groupes).toEqual(['Mon espace', 'Le réseau', 'S\'informer & outils']);
    await page.click('#side .go-home');
    expect(await page.evaluate(() => document.getElementById('v-home').classList.contains('on'))).toBe(true);
    expect(page.url()).toContain('#accueil');
    await page.evaluate(() => { showTab('cat'); curTab = 'cat'; });
    await page.setViewportSize({ width: 420, height: 800 });
    await page.click('header.top .go-home');
    expect(await page.evaluate(() => document.getElementById('v-home').classList.contains('on'))).toBe(true);
    expect(erreurs).toEqual([]);
  });
});

test.describe('Parcours — compte tout juste rattaché', () => {
  test('la progression provisoire coche DM, AD et 3 Jours (régression du 15/09/2026)', async ({ page }) => {
    const erreurs = await ouvrir(page);
    const r = await page.evaluate(() => {
      // Ce que la base pose au rattachement (parcours_provisoire) : des dates, aucun drapeau ok,
      // aucun statut, aucun objectif. Avant le correctif, il n'y avait tout simplement pas de ligne.
      PARCOURS = { provisoire: true, statut: null, formations_mois: [], etapes: {
        dm: { d: '2026-05-03', f: '2026-09-26', src: 'reseau' },
        ad: { d: '2026-05-16', f: null, src: 'reseau' },
        trois_jours: { d: '2026-05-28', f: null, src: 'reseau' },
        adhesion: { d: '2026-05-31', f: null, src: 'adhesion' },
      } };
      return {
        dm: caseCochee('x', 'Participer à une Découverte Métier'),
        ad: caseCochee('x', 'Suivre l’Atelier Démarrage'),
        tj: caseCochee('x', 'Participer aux 3 Jours de la Réussite'),
        adh: caseCochee('x', 'Régler son adhésion'),
        obj: caseCochee('x', 'Valider ses objectifs NEOMAN'),
        mention: autoMention('objectifs_neoman'),
      };
    });
    expect(r).toMatchObject({ dm: true, ad: true, tj: true, adh: true, obj: false });
    expect(r.mention).toContain('prochain passage');
    expect(erreurs).toEqual([]);
  });
});

test.describe('Accès selon le statut — toutes les listes', () => {
  test('un compte sans progression complète applique le statut de l’annuaire (régression du 15/09/2026)', async ({ page }) => {
    const erreurs = await ouvrir(page);
    const r = await page.evaluate(() => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      window.__booted = true;
      MOI_ID = 20521;
      // jeu d'essai pessimiste : la progression provisoire n'a PAS de statut
      PARCOURS = { provisoire: true, statut: null, etapes: {} };
      const avant = monStatut();
      DATA = Object.assign({}, DATA || {}, { statuts: { '20521': 'NEOMAN' } });
      const futur = vAddDays(todayIso, 5);
      const s = (id, pub) => ({ id, title: 'Séance ' + id, start: futur, end: futur, lieu: 'Visio', pilotes: '', hor: '',
                               guests: [], wait: [], pub, max: 20, total: 1, k: 'r', url: '#' });
      const liste = [s(1, ''), s(2, 'NEOMAN'), s(3, 'ADMAN')];
      buildSimple('reu', liste, id => '#' + id, 'réunion');
      const sans = document.querySelectorAll('#reuList .ev').length;
      const lbl = !document.getElementById('reuHorsLbl').hidden;
      const cb = document.getElementById('reuHors'); cb.checked = true; cb.dispatchEvent(new Event('change'));
      const avec = document.querySelectorAll('#reuList .ev').length;
      const grise = document.querySelectorAll('#reuList .ev.hors').length;
      return { avant, apres: monStatut(), sans, lbl, avec, grise,
               adman: accessible(s(9, 'ADMAN')), neo: accessible(s(9, 'NEOMAN')) };
    });
    expect(r.avant).toBe('');            // sans le repli, statut inconnu = tout visible
    expect(r.apres).toBe('NEOMAN');
    expect(r.sans).toBe(2);              // la séance ADMAN est masquée par défaut
    expect(r.lbl).toBe(true);            // la case « non accessibles » apparaît
    expect(r.avec).toBe(3);
    expect(r.grise).toBe(1);             // et la séance réservée s'affiche grisée
    expect(r.adman).toBe(false);
    expect(r.neo).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('chaque liste de séances a sa case « non accessibles »', async ({ page }) => {
    await ouvrir(page);
    const ids = await page.evaluate(() => ['cat', 'pd', 'reu', 'for', 'evt'].map(p => !!document.getElementById(p + 'Hors')));
    expect(ids).toEqual([true, true, true, true, true]);
  });
});

test.describe('Menu Admin', () => {
  // Jeu d'essai pessimiste : le serveur répond à membres_connectes() SANS erreur pour un membre
  // simple (liste vide) — c'est ce qui affichait le menu Admin à tout le monde (régression du 15/09/2026).
  async function avecRole(page, admin) {
    return page.evaluate(async (admin) => {
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      window.__booted = true;
      SBUSER = { id: 'u1', email: 'membre@test.invalid' };
      SB = { rpc: async (nom) => nom === 'est_admin' ? { data: admin, error: null }
                                                     : { data: [], error: null },
             from: () => ({ select() { return this; }, order() { return this; }, eq() { return this; },
                            in() { return this; }, gte() { return this; }, limit() { return this; },
                            then(r) { return Promise.resolve({ data: [], error: null }).then(r); } }) };
      try { await buildMembres(); } catch (e) {}
      return !document.querySelector('nav.tabs button[data-v="admin"]').hidden;
    }, admin);
  }
  test('un membre simple ne voit pas le menu Admin', async ({ page }) => {
    await ouvrir(page);
    expect(await avecRole(page, false)).toBe(false);
  });
  test('un administrateur le voit', async ({ page }) => {
    await ouvrir(page);
    expect(await avecRole(page, true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Semaines ISO, jours fériés, vacances scolaires', () => {
  // Les helpers sont purs : on les vérifie sur des dates connues (jamais sur « aujourd'hui »),
  // puis on rend les vraies listes avec des séances posées sur une semaine de vacances / un férié.
  const preparer = page => page.evaluate(() => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    window.__booted = true;
    MOI_ID = 20028; PARCOURS = { statut: 'ROLE_XMAN', etapes: {} };
  });

  test('le numéro de semaine ISO : S53 fin 2026, S1 le 4 janvier 2027, S1 le 1er janvier 2024', async ({ page }) => {
    const erreurs = await ouvrir(page);
    const r = await page.evaluate(() => ({
      s31dec26: noSemaine('2026-12-31'), s1jan27: noSemaine('2027-01-01'), s4jan27: noSemaine('2027-01-04'),
      s1jan24: noSemaine('2024-01-01'), s17sep26: noSemaine('2026-09-17'), s28dec26: noSemaine('2026-12-28'),
      lundi: lundiDe('2026-09-20'), dimancheLundi: lundiDe('2026-09-21'), mm: mmNo('2026-09-17'),
      bornes: semaineBornes('2026-09-21'), bornesMois: semaineBornes('2026-09-28'), bornesAn: semaineBornes('2026-12-28'),
    }));
    expect(r.s31dec26).toBe(53);           // 2026 compte 53 semaines (le 1er janvier 2026 est un jeudi)
    expect(r.s1jan27).toBe(53);            // le 1er janvier 2027 (vendredi) appartient encore à S53 de 2026
    expect(r.s4jan27).toBe(1);
    expect(r.s1jan24).toBe(1);
    expect(r.s17sep26).toBe(38);
    expect(r.s28dec26).toBe(53);
    expect(r.lundi).toBe('2026-09-14');    // dimanche 20 → lundi 14
    expect(r.dimancheLundi).toBe('2026-09-21');
    expect(r.mm, 'le Mail Manager utilise le même helper').toBe(38);
    expect(r.bornes).toBe('21 → 27 sept.');
    expect(r.bornesMois).toBe('28 sept. → 4 oct.');
    expect(r.bornesAn).toBe('28 déc. → 3 janv. 2027');
    expect(erreurs).toEqual([]);
  });

  test('les fériés se calculent, Pâques compris, et le 15 août ne heurte pas l’audit', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => ({
      paques27: estFerie('2027-03-29'), asc27: estFerie('2027-05-06'), pent27: estFerie('2027-05-17'),
      paques26: estFerie('2026-04-06'), asc26: estFerie('2026-05-14'), pent26: estFerie('2026-05-25'),
      paques28: estFerie('2028-04-17'),
      fixes: ['2026-01-01', '2026-05-01', '2026-05-08', '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-25'].map(estFerie),
      ordinaire: estFerie('2026-09-17'), vide: estFerie(''), nul: estFerie(null),
      nb2026: Object.keys(feriesAnnee(2026)).length,
      multi: ferieDans({ start: '2026-10-30', end: '2026-11-02' }),
      hors: ferieDans({ start: '2026-11-02', end: '2026-11-04' }),
    }));
    expect(r.paques27).toBe('Lundi de Pâques');     // Pâques 2027 = 28 mars
    expect(r.asc27).toBe('Ascension');
    expect(r.pent27).toBe('Lundi de Pentecôte');
    expect(r.paques26).toBe('Lundi de Pâques');     // Pâques 2026 = 5 avril
    expect(r.asc26).toBe('Ascension');
    expect(r.pent26).toBe('Lundi de Pentecôte');
    expect(r.paques28).toBe('Lundi de Pâques');     // Pâques 2028 = 16 avril
    expect(r.fixes.every(Boolean)).toBe(true);
    expect(r.fixes[4].toLowerCase()).not.toContain('asso');   // l'audit refuse cette sous-chaîne
    expect(r.ordinaire).toBeNull(); expect(r.vide).toBeNull(); expect(r.nul).toBeNull();
    expect(r.nb2026).toBe(11);
    expect(r.multi).toEqual({ iso: '2026-11-01', nom: 'Toussaint' });   // séance à cheval sur le 1er novembre
    expect(r.hors).toBeNull();
  });

  test('les vacances viennent du payload quand il en a, sinon de la table de repli, selon la zone', async ({ page }) => {
    await ouvrir(page);
    const r = await page.evaluate(() => {
      const out = {};
      CAL_CFG = null; ZONE_CHOISIE = null;
      out.defaut = zoneScolaire();
      out.repliB = vacancesDe('2026-10-20');                       // Toussaint, toutes zones
      out.hiverB = vacancesDe('2027-02-22');                       // hiver zone B : 20 févr. → 7 mars
      out.hiverA = vacancesDe('2027-02-22', 'A');                  // zone A : 13 → 28 févr.
      out.hiverC = vacancesDe('2027-02-22', 'C');                  // zone C : 6 → 21 févr. → rien le 22
      out.entre = vacancesEntre('2026-10-12', '2026-10-18').map(v => v.nom);   // la semaine qui contient le 17
      out.aucune = vacancesEntre('2026-09-14', '2026-09-20');
      // le payload prend le pas sur la table de repli, y compris avec des dates inventées
      CAL_CFG = { zones: { A: [], B: [{ nom: 'Vacances de test', du: '2026-09-14', au: '2026-09-20' }], C: [] } };
      out.payload = vacancesDe('2026-09-16');
      out.payloadA = vacancesDe('2026-09-16', 'A');                // zone A vide dans le payload → repli
      // zone choisie
      ZONE_CHOISIE = 'C'; out.choisie = zoneScolaire(); out.choisieVac = vacancesDe('2026-09-16');
      CAL_CFG = null; ZONE_CHOISIE = null;
      return out;
    });
    expect(r.defaut).toBe('B');
    expect(r.repliB).toMatchObject({ nom: 'Vacances de la Toussaint', du: '2026-10-17', au: '2026-11-01', zone: 'B' });
    expect(r.hiverB).toMatchObject({ nom: "Vacances d'Hiver", du: '2027-02-20', au: '2027-03-07' });
    expect(r.hiverA).toMatchObject({ du: '2027-02-13', au: '2027-02-28', zone: 'A' });
    expect(r.hiverC).toBeNull();
    expect(r.entre).toEqual(['Vacances de la Toussaint']);
    expect(r.aucune).toEqual([]);
    expect(r.payload).toMatchObject({ nom: 'Vacances de test', zone: 'B' });
    expect(r.payloadA).toBeNull();
    expect(r.choisie).toBe('C');
    expect(r.choisieVac).toBeNull();
  });

  test('les listes annoncent la semaine, les vacances et le férié ; le Parcours aussi', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      ZONE_CHOISIE = null; CAL_CFG = null;
      const s = (id, start, end) => ({ id, title: 'Séance ' + id, start, end: end || start, lieu: 'Visio', pilotes: '', hor: '09:00',
                                       guests: [], wait: [], pub: '', max: 20, total: 1, k: 'r', url: '#', th: '' });
      // réunions : une en semaine ordinaire (S38), deux pendant la Toussaint (S43), une un férié (11 novembre, S46)
      const liste = [s(1, '2026-09-16'), s(2, '2026-10-20'), s(3, '2026-10-22'), s(4, '2026-11-11')];
      document.getElementById('reuPast').checked = true;
      buildSimple('reu', liste, id => '#' + id, 'réunion');
      const heads = [...document.querySelectorAll('#reuList .wk-h')];
      const out = {
        nbCartes: document.querySelectorAll('#reuList .ev').length,
        nbSemaines: heads.length,
        semaines: heads.map(h => h.querySelector('.wk-n').textContent),
        vac: heads.map(h => h.classList.contains('vac')),
        tagsVac: heads.map(h => [...h.querySelectorAll('.wk-tag.vac')].map(t => t.textContent.trim())),
        tagsFer: heads.map(h => [...h.querySelectorAll('.wk-tag.fer')].map(t => t.textContent.trim())),
        badgesFerie: [...document.querySelectorAll('#reuList .ev .xtra.ferie')].map(b => b.textContent),
        ordre: [...document.querySelectorAll('#reuList .month-h, #reuList .wk-h, #reuList .ev')].map(e => e.className.split(' ')[0]),
      };
      // Parcours Découverte : mêmes dates, groupé par jour
      A.length = 0;
      [s(11, '2026-10-20'), s(12, '2026-10-22'), s(13, '2026-11-11')].forEach(x => A.push(Object.assign(x, { th: 'PARCOURS DECOUVERTE', thRaw: 'PARCOURS DECOUVERTE', k: 'a' })));
      document.getElementById('pdPast').checked = true;
      buildPd();
      out.pdSemaines = [...document.querySelectorAll('#pdList .wk-h.wk-sep .wk-n')].map(e => e.textContent);
      out.pdJours = document.querySelectorAll('#pdList .day').length;
      out.pdFerie = [...document.querySelectorAll('#pdList .day-h.ferie .wk-tag.fer')].map(e => e.textContent);
      out.pdVac = document.querySelectorAll('#pdList .wk-h.vac').length;
      return out;
    });
    expect(r.nbCartes).toBe(4);
    expect(r.nbSemaines).toBe(3);
    expect(r.semaines).toEqual(['S38', 'S43', 'S46']);
    expect(r.vac).toEqual([false, true, false]);
    expect(r.tagsVac[1]).toEqual(['Vacances de la Toussaint zone B']);
    expect(r.tagsFer[2]).toEqual(['mer. 11 · Armistice 1918']);
    expect(r.badgesFerie).toEqual(['Férié · Armistice 1918']);
    // mois → semaine → cartes, la semaine n'est écrite qu'une fois pour ses deux séances
    expect(r.ordre).toEqual(['month-h', 'wk-h', 'ev', 'month-h', 'wk-h', 'ev', 'ev', 'month-h', 'wk-h', 'ev']);
    expect(r.pdSemaines).toEqual(['S43', 'S46']);
    expect(r.pdJours).toBe(3);
    expect(r.pdFerie).toEqual(['Férié · Armistice 1918']);
    expect(r.pdVac).toBe(1);
    expect(erreurs).toEqual([]);
  });

  test('le calendrier mensuel a sa gouttière de semaines et marque fériés et vacances', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      ZONE_CHOISIE = null; CAL_CFG = null;
      window.__reuRows = [];
      document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
      document.getElementById('v-reu').classList.add('on');
      const wrap = document.getElementById('reuCalWrap');
      document.getElementById('reuList').hidden = true; wrap.hidden = false;
      CALST.reu = { mode: 'cal', month: '2026-11' };
      drawCal('reu');
      const gout = [...wrap.querySelectorAll('.cal-wk')].map(e => e.textContent);
      const cols = getComputedStyle(wrap.querySelector('.cal-grid')).gridTemplateColumns.split(' ').length;
      const ferie = [...wrap.querySelectorAll('.cal-day.ferie')].map(e => e.querySelector('.cal-date').textContent + e.querySelector('.cal-fer').textContent);
      const vac = [...wrap.querySelectorAll('.cal-day.vac')].map(e => +e.querySelector('.cal-date').textContent);
      const leg = wrap.querySelector('.cal-leg').textContent;
      CALST.reu.month = '2027-05'; drawCal('reu');
      const mai = [...wrap.querySelectorAll('.cal-day.ferie .cal-fer')].map(e => e.textContent);
      CALST.reu = { mode: 'list', month: null };
      document.getElementById('reuList').hidden = false; wrap.hidden = true;
      return { gout, cols, ferie, vac, leg, mai };
    });
    // novembre 2026 commence un dimanche : six lignes, de la S44 (lundi 26 octobre) à la S49 (lundi 30)
    expect(r.gout).toEqual(['S44', 'S45', 'S46', 'S47', 'S48', 'S49']);
    expect(r.cols).toBe(8);
    expect(r.ferie).toEqual(['1Toussaint', '11Armistice 1918']);
    expect(r.vac).toEqual([1]);                          // seul le 1er novembre est encore en vacances (zone B)
    expect(r.leg).toContain('Vacances scolaires');
    expect(r.leg).toContain('zone B');
    expect(r.leg).toContain('Jour férié');
    expect(r.mai).toEqual(['Fête du Travail', 'Ascension', 'Victoire 1945', 'Lundi de Pentecôte']);   // 2027 : Ascension le 6 mai, avant le 8
    expect(erreurs).toEqual([]);
  });

  test('changer de zone dans Mon compte redessine les listes et part dans la synchronisation', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      ZONE_CHOISIE = null; CAL_CFG = null;
      const s = (id, start) => ({ id, title: 'Séance ' + id, start, end: start, lieu: 'Visio', pilotes: '', hor: '',
                                  guests: [], wait: [], pub: '', max: 0, total: 0, k: 'r', url: '#' });
      document.getElementById('reuPast').checked = true;
      buildSimple('reu', [s(1, '2027-02-24')], id => '#' + id, 'réunion');   // hiver : B en vacances, C non
      const avant = document.querySelectorAll('#reuList .wk-h.vac').length;
      accOuvrir();
      const boutons = [...document.querySelectorAll('#accZone [data-z]')].map(b => b.dataset.z + (b.classList.contains('on') ? '*' : ''));
      document.querySelector('#accZone [data-z="C"]').click();
      const apres = document.querySelectorAll('#reuList .wk-h.vac').length;
      const memo = localStorage.getItem('kairos_zone');
      const etat = etatLocal().zone;
      const surBouton = [...document.querySelectorAll('#accZone [data-z]')].filter(b => b.classList.contains('on')).map(b => b.dataset.z);
      accFermer();
      // la zone d'un autre appareil n'écrase pas un choix local ; elle est reprise quand il n'y en a pas
      ZONE_CHOISIE = null; localStorage.removeItem('kairos_zone');
      return { avant, boutons, apres, memo, etat, surBouton };
    });
    expect(r.avant).toBe(1);
    expect(r.boutons).toEqual(['A', 'B*', 'C']);
    expect(r.apres).toBe(0);
    expect(r.memo).toBe('C');
    expect(r.etat).toBe('C');
    expect(r.surBouton).toEqual(['C']);
    expect(erreurs).toEqual([]);
  });

  test('l’accueil : la semaine dans la date, un férié et le début des vacances dans les 7 jours', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      ZONE_CHOISIE = null;
      // payload de test : des vacances qui commencent demain, dans la zone par défaut
      const demain = ajouterJours(todayIso, 1);
      CAL_CFG = { zones: { A: [], B: [{ nom: 'Vacances de test', du: demain, au: ajouterJours(demain, 15) }], C: [] } };
      buildWeek();
      const el = document.getElementById('homeWeek');
      const out = {
        s: document.getElementById('homeWeekS').textContent,
        vac: [...el.querySelectorAll('.wit.vac .wt')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
        fer: el.querySelectorAll('.wit.fer').length,
        feriesAttendus: (() => { let n = 0; for (let i = 0; i <= 7; i++) if (estFerie(ajouterJours(todayIso, i))) n++; return n; })(),
      };
      CAL_CFG = null;
      return out;
    });
    expect(r.s).toMatch(/^S\d{1,2}( → S\d{1,2})?$/);
    expect(r.vac).toEqual(['Début des vacances scolaires Vacances de test · zone B']);
    expect(r.fer).toBe(r.feriesAttendus);
    expect(erreurs).toEqual([]);
  });

  test('téléphone (390 px) : l’en-tête de semaine et la gouttière tiennent dans l’écran', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await ouvrir(page);
    await preparer(page);
    const m = await page.evaluate(() => {
      ZONE_CHOISIE = null; CAL_CFG = null;
      document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
      document.getElementById('v-reu').classList.add('on');
      const s = (id, start) => ({ id, title: 'Séance ' + id, start, end: start, lieu: 'Visio', pilotes: '', hor: '09:00',
                                  guests: [], wait: [], pub: '', max: 0, total: 0, k: 'r', url: '#' });
      document.getElementById('reuPast').checked = true;
      buildSimple('reu', [s(1, '2026-10-20'), s(2, '2026-11-11')], id => '#' + id, 'réunion');
      const L = document.documentElement.clientWidth, r = el => el.getBoundingClientRect();
      const deborde = sel => [...document.querySelectorAll(sel)].some(e => r(e).right > L + 1 || r(e).left < -1);
      const listeOk = !deborde('#reuList .wk-h, #reuList .wk-h *');
      CALST.reu = { mode: 'cal', month: '2026-11' };
      document.getElementById('reuList').hidden = true; document.getElementById('reuCalWrap').hidden = false;
      drawCal('reu');
      const g = document.querySelector('#reuCalWrap .cal-wk');
      const out = { ecran: L, listeOk, calOk: !deborde('#reuCalWrap .cal-grid *'), gout: Math.round(r(g).width),
                    ferMasque: getComputedStyle(document.querySelector('#reuCalWrap .cal-fer')).display,
                    page: document.documentElement.scrollWidth <= L };
      CALST.reu = { mode: 'list', month: null };
      return out;
    });
    expect(m.ecran).toBe(390);
    expect(m.listeOk).toBe(true);
    expect(m.calOk).toBe(true);
    expect(m.gout).toBeLessThanOrEqual(24);
    expect(m.ferMasque).toBe('none');
    expect(m.page).toBe(true);
    await ctx.close();
  });
});

/* ------------------------------------------------------------------ */
test.describe('Mes sessions — inscriptions et enregistrements', () => {
  // L'onglet ne montrait que les sessions mises de côté au signet. Il a désormais deux sous-onglets,
  // comme le Mail Manager : « Mes inscriptions » (relevées sur la liste des invités du réseau,
  // passées comprises) et « Mes enregistrements » (le signet).
  const preparer = page => page.evaluate(() => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    window.__booted = true;
    SBUSER = { id: 'u1', email: 'moi@test.invalid' };
    MOI_ID = 20028;
    A.length = 0; R.length = 0; F.length = 0; E.length = 0;
    SURV = new Set();
    document.querySelectorAll('[data-v="surv"]').forEach(x => x.hidden = false);
    const futur = ajouterJours(todayIso, 10), passe = ajouterJours(todayIso, -20);
    window.__d = { futur, passe };
    // s(liste, type, id, date, invités) — « guests » est la liste des inscrits venue du réseau
    window.__s = (liste, k, id, start, guests) => {
      const a = { id, title: 'Séance ' + id, start, end: start, lieu: 'Visio', pilotes: 'Diane P.',
                  hor: '09:00', guests: guests || [], wait: [], pub: '', max: 20, total: 5,
                  k, url: '#', th: '', thRaw: '' };
      liste.push(a); return a;
    };
  });
  const rendu = (page, sub) => page.evaluate((sub) => {
    if (sub) showSurvSub(sub);
    buildSurv();
    const pastille = id => { const b = document.getElementById(id); return b.hidden ? '' : b.textContent; };
    return {
      sub: SURV_SUB,
      onglets: [...document.querySelectorAll('#survSub button')].map(b => b.dataset.s + (b.classList.contains('on') ? '*' : '')),
      pastilles: [pastille('survNIns'), pastille('survNGar')],
      cartes: [...document.querySelectorAll('#survList .ev .body a.t')].map(a => a.textContent),
      passees: !!document.querySelector('#survList .passe-h'),
      vide: (document.querySelector('#survList > .surv-vide') || {}).textContent || '',
      casePassees: !document.getElementById('survPastLbl').hidden,
      nPassees: document.getElementById('survPastN').textContent,
      note: document.getElementById('survNote').textContent,
    };
  }, sub);

  test('les inscriptions des quatre listes remontent, sans rien de ce qui ne me concerne pas', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      const { futur, passe } = window.__d, s = window.__s;
      s(A, 'a', 1, futur, [20028]);            // atelier à venir, je suis inscrit
      s(A, 'a', 2, futur, [30001]);            // atelier où quelqu'un d'autre est inscrit
      s(A, 'a', 3, passe, [20028, 30001]);     // atelier passé : mon historique
      s(R, 'r', 4, futur, [20028]);
      s(F, 'f', 5, futur, ['20028']);          // le réseau renvoie parfois l'identifiant en texte
      s(E, 'e', 6, futur, []);
      const ids = inscritObjets().map(o => o.cle);
      MOI_ID = null;
      const sansMoi = inscritObjets().length;   // tant que l'identité n'est pas résolue : rien
      MOI_ID = 20028;
      return { ids, sansMoi };
    });
    expect(r.ids).toEqual(['a:3', 'a:1', 'r:4', 'f:5']);   // triés par date : le passé d'abord
    expect(r.sansMoi).toBe(0);
    expect(erreurs).toEqual([]);
  });

  test('deux sous-onglets : les inscriptions par défaut, les enregistrements à côté', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    await page.evaluate(() => {
      const { futur } = window.__d, s = window.__s;
      s(A, 'a', 1, futur, [20028]);            // inscrit
      s(A, 'a', 2, futur, []);                 // enregistré seulement
      s(R, 'r', 3, futur, []);                 // enregistré seulement
      SURV = new Set(['a:2', 'r:3']);
    });
    const ins = await rendu(page);
    expect(ins.sub, 'on arrive sur les inscriptions').toBe('ins');
    expect(ins.onglets).toEqual(['ins*', 'gardes']);
    expect(ins.pastilles, 'chaque sous-onglet annonce ce qui lui reste à venir').toEqual(['1', '2']);
    expect(ins.cartes).toEqual(['Séance 1']);
    expect(ins.note).toContain('Inscriptions relevées');
    const gardes = await rendu(page, 'gardes');
    expect(gardes.onglets).toEqual(['ins', 'gardes*']);
    expect(gardes.cartes).toEqual(['Séance 2', 'Séance 3']);
    expect(gardes.note).toContain('Places relevées');
    expect(erreurs).toEqual([]);
  });

  test('une session à la fois inscrite et enregistrée ne compte que côté inscriptions', async ({ page }) => {
    await ouvrir(page);
    await preparer(page);
    await page.evaluate(() => {
      const { futur } = window.__d, s = window.__s;
      s(A, 'a', 1, futur, [20028]);
      SURV = new Set(['a:1']);                 // je l'avais mise de côté avant de m'inscrire
    });
    const ins = await rendu(page);
    expect(ins.pastilles).toEqual(['1', '']);
    expect(ins.cartes).toEqual(['Séance 1']);
    const signet = await page.evaluate(() => document.querySelectorAll('#survList .surv-btn.on').length);
    expect(signet, 'le signet reste allumé sur la carte').toBe(1);
    const gardes = await rendu(page, 'gardes');
    expect(gardes.cartes, 'elle n’est pas comptée une deuxième fois').toEqual([]);
    expect(gardes.vide).toContain('Rien d’enregistré');
  });

  test('les passées sont repliées, et la case porte sur le sous-onglet affiché', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    await page.evaluate(() => {
      const { futur, passe } = window.__d, s = window.__s;
      s(A, 'a', 1, futur, [20028]);
      s(A, 'a', 2, passe, [20028]);            // historique de participation
      s(A, 'a', 3, passe, [20028]);
      s(R, 'r', 4, futur, []);
      s(R, 'r', 5, passe, []);                 // enregistrée passée
      SURV = new Set(['r:4', 'r:5']);
    });
    const ins = await rendu(page);
    expect(ins.cartes).toEqual(['Séance 1']);
    expect(ins.passees).toBe(false);
    expect(ins.casePassees, 'la case apparaît dès qu’il y a du passé').toBe(true);
    expect(ins.nPassees, 'le compte est celui du sous-onglet affiché').toBe('(2)');
    const insOuvert = await page.evaluate(() => {
      document.getElementById('survPast').checked = true;
      buildSurv();
      return { cartes: [...document.querySelectorAll('#survList .ev .body a.t')].map(a => a.textContent),
               passees: !!document.querySelector('#survList .passe-h') };
    });
    expect(insOuvert.cartes).toEqual(['Séance 1', 'Séance 3', 'Séance 2']);   // les plus récentes d'abord
    expect(insOuvert.passees).toBe(true);
    const gardes = await rendu(page, 'gardes');
    expect(gardes.nPassees, 'l’autre sous-onglet a son propre compte').toBe('(1)');
    expect(gardes.cartes).toEqual(['Séance 4', 'Séance 5']);   // la case reste cochée
    expect(erreurs).toEqual([]);
  });

  test('chaque sous-onglet dit ce qu’il faut quand il est vide', async ({ page }) => {
    await ouvrir(page);
    await preparer(page);
    const insVide = await rendu(page);
    expect(insVide.vide).toContain('Aucune inscription pour l’instant');
    expect(insVide.casePassees).toBe(false);
    expect(insVide.pastilles).toEqual(['', '']);
    const gardesVide = await rendu(page, 'gardes');
    expect(gardesVide.vide).toContain('Rien d’enregistré');
    // seulement du passé : le sous-onglet le dit, et la case permet de l'ouvrir
    const passeSeul = await page.evaluate(() => {
      window.__s(A, 'a', 1, window.__d.passe, [20028]);
      showSurvSub('ins'); buildSurv();
      return { vide: (document.querySelector('#survList > .surv-vide') || {}).textContent || '',
               casePassees: !document.getElementById('survPastLbl').hidden,
               note: document.getElementById('survNote').textContent };
    });
    expect(passeSeul.vide).toBe('Aucune inscription à venir.');
    expect(passeSeul.casePassees).toBe(true);
    expect(passeSeul.note, 'rien à venir : pas de relevé à annoncer').toBe('');
  });

  test('inscrit : un badge sur la carte, et les alertes de places restent affichées', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      const { futur } = window.__d;
      const base = { title: 'Tendu', start: futur, end: futur, lieu: 'Visio', pilotes: '', hor: '',
                     wait: [], pub: '', max: 20, k: 'a', url: '#', tkey: 'x' };
      const tendu = Object.assign({}, base, { id: 1, total: 19, guests: [20028] });
      const tenduSansMoi = Object.assign({}, base, { id: 2, total: 19, guests: [] });
      const complet = Object.assign({}, base, { id: 3, total: 20, guests: [20028] });
      SAME = new Map([['x', [tendu, tenduSansMoi, complet,
                             { id: 9, title: 'Autre date', start: ajouterJours(futur, 7), end: ajouterJours(futur, 7),
                               lieu: 'Visio', max: 20, total: 1, guests: [], url: '#', tkey: 'x', hor: '' }]]]);
      const lire = x => { const d = document.createElement('div'); d.innerHTML = evExtras(x); return {
        badge: !!d.querySelector('.xtra.insc'),
        tendu: !!d.querySelector('.xtra.places.tendu'),
        full: !!d.querySelector('.xtra.places.full'),
        places: (d.querySelector('.xtra.places') || {}).textContent || '',
        alt: !!d.querySelector('.xtra.alt'),
      }; };
      return { moi: lire(tendu), autre: lire(tenduSansMoi), moiComplet: lire(complet) };
    });
    expect(r.moi.badge, 'ma séance porte le badge Inscrit').toBe(true);
    expect(r.autre.badge).toBe(false);
    // Inscrit ou non, savoir qu'une séance se remplit sert à orienter un invité vers une autre date
    expect(r.moi.tendu, 'l’alerte reste même inscrit').toBe(true);
    expect(r.moi.places).toBe('19/20 · plus que 1 place');
    expect(r.autre.tendu).toBe(true);
    expect(r.moiComplet.badge).toBe(true);
    expect(r.moiComplet.full, 'complet reste signalé').toBe(true);
    expect(r.moiComplet.alt, 'et les autres dates restent proposées').toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('l’onglet s’appelle « Mes sessions », le sous-onglet passe dans l’adresse, #enregistre marche encore', async ({ page }) => {
    await ouvrir(page);
    await preparer(page);
    const r = await page.evaluate(() => {
      majOngletSurv();
      const b = document.querySelector('nav.tabs button[data-v="surv"]');
      showSurvSub('ins');
      const hashIns = hashFor('surv');
      showSurvSub('gardes');
      const hashGardes = hashFor('surv');
      applyState('surv', new URLSearchParams('s=mes-inscriptions'));
      const revenu = SURV_SUB;
      applyState('surv', new URLSearchParams('s=signets'));   // raccourci accepté
      const raccourci = SURV_SUB;
      showSurvSub('ins');
      location.hash = '#enregistre';
      HASH_INITIAL = location.hash; HASH_APPLIQUE = false;
      routeHash();
      return { titre: b.title, libelle: b.querySelector('.l').textContent,
               bas: document.querySelector('nav.botbar button[data-v="surv"] .l').textContent,
               slug: TAB_SLUG.surv, alias: SLUG_TAB.enregistre,
               hashIns, hashGardes, revenu, raccourci,
               vue: (document.querySelector('section.view.on') || {}).id };
    });
    expect(r.titre).toBe('Mes sessions');
    expect(r.libelle).toBe('Mes sessions');
    expect(r.bas, 'la barre du bas est étroite : libellé court').toBe('Sessions');
    expect(r.slug).toBe('mes-sessions');
    expect(r.alias).toBe('surv');
    expect(r.hashIns, 'le sous-onglet par défaut n’encombre pas l’adresse').toBe('#mes-sessions');
    expect(r.hashGardes).toBe('#mes-sessions?s=mes-enregistrements');
    expect(r.revenu).toBe('ins');
    expect(r.raccourci).toBe('gardes');
    expect(r.vue, 'un lien #enregistre déjà partagé doit continuer d’ouvrir l’onglet').toBe('v-surv');
  });
});

/* ------------------------------------------------------------------ */
test.describe('Mail Manager — alléger la saisie', () => {
  // Le formulaire faisait 1 578 px sur ordinateur et 2 022 px sur téléphone quel que soit son
  // remplissage. Ce qui est relevé par le réseau en est sorti, chaque section repliée dit ce
  // qu'elle contient, les deux semaines partagent un seul tableau et les habilitations ont leur
  // propre page.
  const poserMM = page => page.evaluate(() => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    window.__booted = true; MOI_ID = 20028; MM_SEM = mmSemCour(); MM_OBJ = {}; MM_PREC = null;
    MM_PRODUITS = ['Assurance Vie']; MM_TOUT = false;
    document.querySelectorAll('section.view').forEach(v => v.classList.remove('on'));
    document.getElementById('v-mm').classList.add('on');
    document.querySelectorAll('#v-mm .subview').forEach(v => v.classList.toggle('on', v.id === 'sm-moi'));
    window.__auto = { statut: 'BEMAN', parrain: 'Diane P.', mgr: 'Marc L.', entree: '2024-03-01',
                      fn: 8, ftot: 13, filadh: 6, fil: 9, inv: { dm: 3, ad: 2, jr: 1 },
                      ag: [{ d: ajouterJours(todayIso, 12), t: 'Formation conformité' }] };
    window.__plein = { auto: window.__auto, p: { r0: 4, r1: 3, r2: 2, r2b: 1, rx: 1 },
                       c: { r0: 2 }, av: { r1: 3, r2: 3 },
                       prod: { va: 24500, vaec: 8200 }, hab: { mia: { s: 'ok' } },
                       pf: 'Deux signatures.', cf: 'Relancer les R1.',
                       sous: [{ t: 'Assurance Vie', vi: 24500, vp: 0 }] };
    window.__rendre = d => { document.getElementById('mmMoi').innerHTML = mmCorps(d, '', false, MM_SEM); };
  });
  const lireSections = () => [...document.querySelectorAll('#mmMoi details.mm-sec')].map(d => ({
    n: d.querySelector('.n').textContent, titre: d.querySelector('.mmti').textContent, ouvert: d.open,
    res: (d.querySelector('.mmres') || {}).textContent ? d.querySelector('.mmres').textContent.replace(/[  ]/g, ' ').trim() : '' }));

  test('ce que le réseau relève sort du formulaire et tient dans un bandeau', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate(() => {
      window.__rendre({ auto: window.__auto });
      const el = document.getElementById('mmMoi');
      const syn = el.querySelector('details.mm-syn');
      return {
        bandeau: !!syn,
        replie: syn && !syn.open,
        puces: [...syn.querySelectorAll('summary .mmpu i')].map(i => i.textContent.replace(/\s+/g, ' ').trim()),
        dansBandeau: ['Statut FORMAN', 'Développement d’équipe', 'Objectifs FORMAN', 'Formations et événements à venir']
          .every(t => syn.textContent.includes(t)),
        sansChamp: [...el.querySelectorAll('details.mm-sec')].filter(d => !d.querySelectorAll('input,select,textarea').length).length,
        activite: !!syn.querySelector('select[data-mm="act"]'),
      };
    });
    expect(r.bandeau).toBe(true);
    expect(r.replie, 'le bandeau est replié par défaut').toBe(true);
    // 9 filleuls déclarés dont 6 adhérents : 3 invités pas encore adhérents
    expect(r.puces).toEqual(['BEMAN', 'Objectifs 8/13', 'Filleuls 6', 'DM 3', 'AD 2', '3 Jours 1',
      'Pas encore adhérents 3', 'À venir 1']);
    expect(r.dansBandeau).toBe(true);
    expect(r.sansChamp, 'toutes les sections restantes ont des champs').toBe(0);
    expect(r.activite).toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('deux encadrés seulement : « Mes rendez-vous » et « Production »', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate((src) => {
      window.__rendre({ auto: window.__auto });
      const lire = new Function('return (' + src + ')()')();
      const s1 = document.querySelectorAll('#mmMoi details.mm-sec')[0];
      return { sections: lire.map(x => x.n + ' ' + x.titre),
               // tout ce qui touche aux deux semaines est dans le premier encadré
               dansRdv: ['Signatures / souscriptions', 'Faits marquants', 'Mon focus',
                         'Mes invités en séance', 'Mes séances'].every(t => s1.textContent.includes(t)),
               // plus de section « Habilitations » : elle a sa page
               hab: !!document.querySelector('#mmMoi [data-mm^="hab."]'),
               renvoi: !!document.querySelector('#mmMoi .mm-habl [data-mms="hab"]') };
    }, lireSections.toString());
    expect(r.sections).toEqual(['1 Mes rendez-vous', '2 Production']);
    expect(r.dansRdv, 'les trois anciens encadrés sont réunis dans le premier').toBe(true);
    expect(r.hab, 'aucun champ d’habilitation dans le formulaire').toBe(false);
    expect(r.renvoi, 'un renvoi vers la page des habilitations').toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('un seul tableau : les rendez-vous en colonnes, les trois périodes en lignes', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate(() => {
      MM = { semaine: MM_SEM, statut: 'brouillon', donnees: JSON.parse(JSON.stringify(window.__plein)) };
      MM_PREC = { donnees: { p: { r0: 3, r1: 4, r2: 2, r2b: 0, rx: 0 }, av: { r1: 1 } } };
      window.__rendre(MM.donnees);
      const t = document.querySelector('#mmMoi .mm-rdv');
      const lignes = [...t.querySelectorAll('tbody tr')].map(tr => ({
        lib: tr.querySelector('td.lb').textContent.replace(/\s+/g, ' ').trim(),
        champs: [...tr.querySelectorAll('td.num')].map(td => {
          const i = td.querySelector('input');
          return i ? i.dataset.mm : td.textContent.trim();
        }),
        dlt: [...tr.querySelectorAll('td.num .dlt')].map(x => x.textContent),
      }));
      const tot = () => ['mmRdvTotP', 'mmRdvTotC', 'mmRdvTotA'].map(i => document.getElementById(i).textContent);
      const avant = tot();
      // une frappe met le total de SA ligne à jour, sans redessiner le tableau
      const champ = t.querySelector('input[data-mm="c.r1"]');
      champ.value = '5'; champ.dispatchEvent(new Event('input', { bubbles: true }));
      return { entetes: [...t.querySelectorAll('thead th')].map(th => th.textContent.trim()),
               lignes, avant, apres: tot(),
               memeChamp: document.querySelector('#mmMoi .mm-rdv input[data-mm="c.r1"]') === champ };
    });
    const [nP, nC] = await page.evaluate(() => [mmNo(vAddDays(MM_SEM, -7)), mmNo(MM_SEM)]);
    expect(r.entetes).toEqual(['Période', 'R0', 'R1', 'R2', 'R-signature', 'R3', 'RX', 'Total']);
    expect(r.lignes.map(l => l.lib)).toEqual([`ÉcouléeS${nP}`, `En coursS${nC}`, 'D’avanceà date']);
    expect(r.lignes[0].champs).toEqual(['p.r0', 'p.r1', 'p.r2', 'p.r2b', 'p.r3', 'p.rx', '11']);
    expect(r.lignes[1].champs).toEqual(['c.r0', 'c.r1', 'c.r2', 'c.r2b', 'c.r3', 'c.rx', '2']);
    // « R-signature » n'existe pas en RDV d'avance : la case reste vide plutôt que fausse
    expect(r.lignes[2].champs).toEqual(['av.r0', 'av.r1', 'av.r2', '—', 'av.r3', 'av.rx', '6']);
    // l'écart n'a de sens que là où il y a un précédent : l'écoulée et l'avance
    expect(r.lignes[0].dlt).toEqual(['+1', '-1', '+1', '+1']);
    expect(r.lignes[1].dlt, 'la semaine en cours n’a pas de précédent').toEqual([]);
    expect(r.lignes[2].dlt, 'av.r1 : 3 contre 1 · av.r2 : 3 contre 0').toEqual(['+2', '+3']);
    expect(r.avant).toEqual(['11', '2', '6']);
    expect(r.apres, 'seul le total de la ligne saisie bouge').toEqual(['11', '7', '6']);
    expect(r.memeChamp, 'le tableau n’est pas redessiné : le curseur reste dans le champ').toBe(true);
    expect(erreurs).toEqual([]);
  });

  test('une section repliée dit ce qu’elle contient, et une section vide reste ouverte', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const vide = await page.evaluate((src) => {
      window.__rendre({ auto: window.__auto });
      return new Function('return (' + src + ')()')();
    }, lireSections.toString());
    // formulaire neuf : seul le tableau des rendez-vous s'ouvre — c'est ce qu'on vient remplir.
    // La production annonce son contenu dans son intitulé et s'ouvre à la demande.
    expect(vide.map(x => x.ouvert)).toEqual([true, false]);
    expect(vide.every(x => x.res === '')).toBe(true);

    const plein = await page.evaluate((src) => {
      window.__rendre(window.__plein);
      return new Function('return (' + src + ')()')();
    }, lireSections.toString());
    expect(plein.map(x => x.ouvert), 'une section remplie se replie').toEqual([false, false]);
    expect(plein[0].res).toBe('Écoulée : R0 4 · R1 3 · R2 2 · R-signature 1 · RX 1'
      + ' — En cours : R0 2 — D’avance : 6 — 24 500 € signé');
    expect(plein[1].res).toBe('VA VC 24 500 € · VA EC 8 200 €');
    expect(erreurs).toEqual([]);
  });

  test('« Tout déplier » ouvre tout et le choix reste sur l’appareil', async ({ page }) => {
    await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate(() => {
      window.__rendre(window.__plein);
      // l'historique des sessions (details.mm-hist, imbriqué) garde son propre pliage
      const plis = () => [...document.querySelectorAll('#mmMoi details.mm-sec, #mmMoi details.mm-syn')];
      const avant = plis().filter(d => d.open).length;
      MM_TOUT = true;
      window.__rendre(window.__plein);
      const apres = plis().filter(d => d.open).length;
      const total = plis().length;
      const hist = document.querySelector('#mmMoi details.mm-hist');
      const libelle = document.getElementById('mmPlier').textContent;
      MM_TOUT = false;
      return { avant, apres, total, libelle, hist: !hist || !hist.open };
    });
    expect(r.avant, 'rempli, tout est replié').toBe(0);
    expect(r.apres, 'tout déplié : bandeau compris').toBe(r.total);
    expect(r.total, 'le bandeau et les deux encadrés').toBe(3);
    expect(r.hist, 'l’historique imbriqué garde son pliage').toBe(true);
    expect(r.libelle).toBe('Tout replier');
  });

  test('le formulaire rempli tient sur un écran, et Entrée suit les périodes', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const h = await page.evaluate(() => {
      window.__rendre(window.__plein);
      return Math.round(document.getElementById('mmMoi').getBoundingClientRect().height);
    });
    // avant : 1 578 px quel que soit le remplissage
    expect(h, 'formulaire rempli, état par défaut').toBeLessThan(700);

    const nav = await page.evaluate(() => {
      MM_TOUT = true; window.__rendre(window.__plein); MM_TOUT = false;
      const suivant = (sel) => {
        const el = document.querySelector('#mmMoi input[data-mm="' + sel + '"]');
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return document.activeElement.dataset.mm;
      };
      return { depuisR0: suivant('p.r0'), finLigne: suivant('p.rx'), ligne2: suivant('c.rx') };
    });
    // une ligne = une période : on remplit toute la semaine écoulée, puis la suivante
    expect(nav.depuisR0).toBe('p.r1');
    expect(nav.finLigne, 'en fin de ligne on passe à la période suivante').toBe('c.r0');
    expect(nav.ligne2).toBe('av.r0');
    expect(erreurs).toEqual([]);
  });

  test('téléphone : le tableau reste un tableau et défile, la colonne des périodes suit', async ({ browser }) => {
    // Régression du 17/09/2026 : la règle mobile « .mm-tbl td[data-l] » (plus spécifique que
    // « .mm-rdv td ») transformait chaque case en grille — les compteurs tombaient à 6 px de large.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: 'Europe/Paris', locale: 'fr-FR' });
    const page = await ctx.newPage();
    await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate(() => {
      window.__rendre(window.__plein);
      document.querySelector('#mmMoi details.mm-sec').open = true;
      const t = document.querySelector('#mmMoi .mm-rdv'), wrap = t.parentElement;
      const cs = e => getComputedStyle(e), L = document.documentElement.clientWidth;
      const td = t.querySelectorAll('tbody tr td')[1];
      return { ecran: L,
               cellule: cs(td).display,
               champ: Math.round(td.querySelector('input').getBoundingClientRect().width),
               table: Math.round(t.getBoundingClientRect().width),
               dispo: Math.round(wrap.getBoundingClientRect().width),
               defile: cs(wrap).overflowX,
               periodeCollante: cs(t.querySelector('td.lb')).position,
               // les boutons ± sortent sur téléphone : on saisit au clavier numérique
               boutons: cs(td.querySelector('button')).display,
               pageDeborde: document.documentElement.scrollWidth > L };
    });
    expect(r.cellule, 'une vraie cellule de tableau, pas une grille').toBe('table-cell');
    expect(r.champ, 'le compteur reste saisissable').toBeGreaterThan(35);
    expect(r.table, 'le tableau garde sa largeur naturelle').toBeGreaterThan(r.dispo);
    expect(r.defile, 'et c’est le conteneur qui défile').toBe('auto');
    expect(r.periodeCollante).toBe('sticky');
    expect(r.boutons).toBe('none');
    expect(r.pageDeborde, 'la page elle-même ne défile pas latéralement').toBe(false);
    await ctx.close();
  });

  test('les habilitations ont leur page, après « Mes objectifs »', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserMM(page);
    const r = await page.evaluate(() => {
      const onglets = [...document.querySelectorAll('#mmSub button')].map(b => b.dataset.s);
      MM = { semaine: MM_SEM, statut: 'brouillon', donnees: JSON.parse(JSON.stringify(window.__plein)) };
      document.getElementById('mmHab').innerHTML = mmHabPage();
      const page1 = document.getElementById('mmHab');
      // une semaine passée : la page passe en lecture
      const cour = MM_SEM;
      MM_SEM = vAddDays(MM_SEM, -7);
      const lecture = mmHabPage();
      MM_SEM = cour;
      showMMSub('hab');
      const url = tabState('mm').get('s');
      showMMSub('moi');
      return { onglets, url,
               champs: page1.querySelectorAll('[data-mm^="hab."]').length,
               compte: page1.querySelector('.mm-sem').textContent,
               vue: document.querySelector('#sm-hab') !== null,
               lectureSansChamp: !/data-mm="hab\./.test(lecture),
               lectureNote: lecture.includes('reviens à la semaine en cours') };
    });
    expect(r.onglets, '« Mes habilitations » vient après « Mes objectifs »').toEqual(['moi', 'mur', 'obj', 'hab']);
    expect(r.vue).toBe(true);
    expect(r.champs, '3 habilitations × 3 champs + 4 formations × 2 champs').toBe(17);
    expect(r.compte).toBe('1 / 7 validées');
    expect(r.url).toBe('mes-habilitations');
    expect(r.lectureSansChamp, 'une semaine passée s’affiche en lecture').toBe(true);
    expect(r.lectureNote).toBe(true);
    expect(erreurs).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
test.describe('Ajouter à Google Agenda', () => {
  // Chaque séance à venir (atelier, Parcours Découverte, réunion, formation, événement) porte un
  // lien qui ouvre le formulaire de Google Agenda déjà rempli. Sur plusieurs jours : un événement
  // par jour (décision du 22/09/2026), jamais une plage continue du premier au dernier jour.
  const lire = liens => liens.map(h => {
    const u = new URL(h); const p = u.searchParams;
    return { hote: u.host + u.pathname, action: p.get('action'), text: p.get('text'), dates: p.get('dates'),
             ctz: p.get('ctz'), location: p.get('location'), details: p.get('details') };
  });
  const poserSeances = page => page.evaluate(() => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    window.__booted = true;
    A.length = 0; R.length = 0; F.length = 0; E.length = 0;
    SITES = { 7: ['Salle Kairos', 'Nantes', '3 rue de la Paix', '44000', ''] };
    const j = n => ajouterJours(todayIso, n);
    const base = { pilotes: 'Diane P.', guests: [], wait: [], pub: '', max: 0, total: 0, th: '', thRaw: '', pw: '', link: '', siteId: null };
    const s = (liste, k, o) => { const a = Object.assign({}, base, { k, url: 'https://exemple.invalid/' + k + '/' + o.id }, o); liste.push(a); return a; };
    window.__g = {
      un:     s(A, 'a', { id: 1, title: 'Atelier un jour', start: j(5), end: j(5), lieu: 'Nantes', hor: '09:30 - 12:00', siteId: 7 }),
      trois:  s(F, 'f', { id: 2, title: '3 Jours', start: j(8), end: j(10), lieu: 'Nantes', hor: '09:00 - 18:00' }),
      encours:s(E, 'e', { id: 3, title: 'Séminaire', start: j(-1), end: j(1), lieu: 'Visio', hor: '' }),
      visio:  s(R, 'r', { id: 4, title: 'Réunion', start: j(3), end: j(3), lieu: 'Visio', hor: '20:00 - 21:30', link: 'https://zoom.invalid/j/1', pw: 'abc' }),
      passe:  s(A, 'a', { id: 5, title: 'Passé', start: j(-4), end: j(-4), lieu: 'Nantes', hor: '09:00 - 12:00' }),
      j: { 5: j(5), 8: j(8), 9: j(9), 10: j(10), m1: j(-1), 0: j(0), 1: j(1), 2: j(2), 3: j(3) },
    };
  });
  const liensDe = (page, cle) => page.evaluate(cle => {
    const d = document.createElement('div'); d.innerHTML = evExtras(window.__g[cle]);
    return [...d.querySelectorAll('a.gcal, a.gcal-j')].map(a => a.href);
  }, cle);
  const c = iso => iso.replace(/-/g, '');

  test('une séance d’un jour : un seul lien, horaires en heure de Paris, lieu et fiche', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const j = await page.evaluate(() => window.__g.j);
    const [e] = lire(await liensDe(page, 'un'));
    expect(e.hote).toBe('calendar.google.com/calendar/render');
    expect(e.action).toBe('TEMPLATE');
    expect(e.text).toBe('Atelier un jour');
    expect(e.dates).toBe(c(j[5]) + 'T093000/' + c(j[5]) + 'T120000');
    expect(e.ctz).toBe('Europe/Paris');
    expect(e.location).toBe('Salle Kairos, 3 rue de la Paix, 44000 Nantes');
    expect(e.details).toContain('Animé par : Diane P.');
    expect(e.details).toContain('https://exemple.invalid/a/1');
    expect((await liensDe(page, 'un')).length).toBe(1);
    expect(erreurs).toEqual([]);
  });

  test('sur plusieurs jours : un événement par jour, mêmes horaires chaque jour', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const j = await page.evaluate(() => window.__g.j);
    const ev = lire(await liensDe(page, 'trois'));
    expect(ev.map(e => e.dates)).toEqual([
      c(j[8]) + 'T090000/' + c(j[8]) + 'T180000',
      c(j[9]) + 'T090000/' + c(j[9]) + 'T180000',
      c(j[10]) + 'T090000/' + c(j[10]) + 'T180000',
    ]);
    expect(ev.map(e => e.text)).toEqual(['Formation · 3 Jours (jour 1/3)', 'Formation · 3 Jours (jour 2/3)', 'Formation · 3 Jours (jour 3/3)']);
    expect(ev[1].details).toContain('Jour 2 sur 3');
    expect(erreurs).toEqual([]);
  });

  test('une séance en cours : seuls les jours restants, en journée entière sans horaire', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const j = await page.evaluate(() => window.__g.j);
    const ev = lire(await liensDe(page, 'encours'));
    expect(ev.map(e => e.dates)).toEqual([c(j[0]) + '/' + c(j[1]), c(j[1]) + '/' + c(j[2])]);
    expect(ev.map(e => e.text)).toEqual(['Événement · Séminaire (jour 2/3)', 'Événement · Séminaire (jour 3/3)']);
    expect(erreurs).toEqual([]);
  });

  test('une visio : le lien et le mot de passe dans l’événement ; une séance passée : rien', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const [e] = lire(await liensDe(page, 'visio'));
    expect(e.text).toBe('Réunion d’équipe · Réunion');
    expect(e.location).toBe('https://zoom.invalid/j/1');
    expect(e.details).toContain('Visio : https://zoom.invalid/j/1 (mot de passe : abc)');
    expect(await liensDe(page, 'passe')).toEqual([]);
    expect(erreurs).toEqual([]);
  });

  test('le bouton apparaît dans les listes (ateliers, réunions, formations, événements)', async ({ page }) => {
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const n = await page.evaluate(() => {
      rafraichirListes();
      const compte = id => document.querySelectorAll('#' + id + ' a.gcal, #' + id + ' a.gcal-j').length;
      return { cat: compte('catList'), reu: compte('reuList'), for: compte('forList'), evt: compte('evtList') };
    });
    expect(n.cat).toBeGreaterThanOrEqual(1);
    expect(n.reu).toBe(1);
    expect(n.for).toBe(3);
    expect(n.evt).toBe(2);
    expect(erreurs).toEqual([]);
  });

  test('sur téléphone, les liens par jour tiennent dans la largeur', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const erreurs = await ouvrir(page);
    await poserSeances(page);
    const r = await page.evaluate(() => {
      rafraichirListes(); showTab && showTab('for');
      const el = document.querySelector('#forList .gcal-multi');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { droite: b.right, largeur: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(r).not.toBeNull();
    expect(r.droite).toBeLessThanOrEqual(r.largeur);
    expect(r.scroll).toBeLessThanOrEqual(r.largeur);
    expect(erreurs).toEqual([]);
  });
});
