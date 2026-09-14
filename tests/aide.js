// Outils partagés des tests : chemin de la page, et un jeu de données minimal injecté
// directement dans les variables du portail. On ne rejoue pas tout le démarrage (il faudrait
// émuler Supabase) : on charge la page, puis on appelle les fonctions avec des données connues.
const path = require('path');
const RACINE = path.resolve(__dirname, '..');   // la racine du dépôt : tests/ vit à côté de index.html
const PAGE = 'file://' + path.join(RACINE, 'index.html');

// La vraie ligne d'un atelier du réseau, telle qu'elle est stockée dans le payload :
// 8 champs de base puis les extras [site, max, inscrits, guests, attente, lien, mdp, public, habilitation]
const ATELIER_SEMAINE_PASSEE = [
  6641, 'COMMUNICATION', 'Clefs de la communication - Niveau 1',
  '@@SAMEDI@@', '@@SAMEDI@@', 'Visio', 'Diane P.', '09:00 - 17:00',
  null, 16, 16, [2867, 20028, 30004], [], 'Zoom', '', 'BEMAN', ''
];

// Pose un contexte complet dans la page : moi, mes filleuls, mes ateliers, ma progression.
// `samedi` = le samedi de la semaine PASSÉE, calculé côté test pour ne dépendre d'aucune date figée.
async function poser(page, opts = {}) {
  return page.evaluate((o) => {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'grid';

    MOI_ID = 20028;
    byId.set(20028, { id: 20028, name: 'Moi Test', parrain: 'Parrain Test', mgr: 'Manager Test', date: '2025-07-01' });
    const filleuls = [
      { id: 30001, name: 'Filleul NonAdherent', parrain: 'Moi Test' },
      { id: 30004, name: 'Filleul Adherent',    parrain: 'Moi Test' },
    ];
    filleuls.forEach(f => byId.set(f.id, f));
    children.set(norm('Moi Test'), filleuls);
    ADH.add(30004);                       // celui-là est adhérent : il ne compte plus comme invité

    const a = o.atelier;
    A.push({ id:a[0], th:'', thRaw:a[1], title:a[2], start:a[3], end:a[4], lieu:a[5], pilotes:a[6], hor:a[7],
             siteId:a[8], max:a[9], total:a[10], guests:a[11], wait:a[12], link:a[13], pw:a[14], pub:a[15], hab:a[16] });
    // une Découverte Métier à venir, avec mes deux filleuls inscrits
    A.push({ id:9001, th:'', thRaw:'', title:'Découverte métier matinée', start:o.dm, end:o.dm, lieu:'Visio',
             pilotes:'', hor:'', siteId:null, max:40, total:20, guests:[30001,30004], wait:[], link:'', pw:'', pub:'', hab:'' });

    PARCOURS = { statut:'ROLE_BEMAN', etapes:{ objectifs_beman:{ n:8, tot:13 } } };
    MM_SEM = mmSemCour();
    MM = { semaine: MM_SEM, donnees: {}, statut: 'brouillon', publie_le: null, maj: null };  // jamais enregistré
    MM_REG = { participe: true, reglages: {} };
    MM_OBJ = { va_dec: 120000, va_pmr: 500000, clients_dec: 20 };
    MM_PRODUITS = ['Assurance Vie', 'PER', 'SCPI', 'Girardin'];
    MM_MUR = []; MM_LIGNES = []; RET = [];
    document.querySelectorAll('[data-v="mm"],[data-v="fb"],[data-v="surv"]').forEach(x => x.hidden = false);
    window.__booted = true;
    return true;
  }, opts);
}

module.exports = { RACINE, PAGE, ATELIER_SEMAINE_PASSEE, poser };
