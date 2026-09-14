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

  test('personnel et équipe restent distincts une fois les deux listes fusionnées', async ({ page }) => {
    await ouvrir(page);
    const r = await rendre(page, DONNEES, '');
    // Les libellés courts sont identiques des deux côtés : sur la fiche et dans l'export, sans
    // le suffixe, on ne saurait plus lequel est lequel.
    for (const attendu of ['VA + VAA VC personnel', 'VA + VAA EC personnel',
                           'VA + VAA VC équipe', 'VA + VAA EC équipe']) {
      expect(r.production, attendu).toContain(attendu);
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
        fiche: net(mmFiche(JSON.parse(JSON.stringify(d)), '', MM_SEM, {})),
        texte: mmTexte(JSON.parse(JSON.stringify(d)), 'Moi', MM_SEM),
      };
    });
    const cour = r.an + '-' + (r.an + 1);
    expect(r.titres, 'le bloc personnel annonce le PMR en cours').toContain('Personnel — PMR en cours (' + cour + ')');
    expect(r.titres, 'l’équipe aussi').toContain('sur 4 niveaux, PMR en cours (' + cour + ')');
    expect(r.titres, 'les PMR passés disent quelle valeur on attend').toContain('PMR passés — VA + VAA VC');
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
