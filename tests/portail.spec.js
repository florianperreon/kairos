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
