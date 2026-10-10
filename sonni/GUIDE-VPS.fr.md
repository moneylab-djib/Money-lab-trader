# Installer Sonni sur son propre serveur (VPS) — guide pas à pas

Guide pour le propriétaire, en français. Aucune étape ne doit être faite par Sonni lui-même.
Les prix et menus des sites cités changent : vérifie-les au moment de t'inscrire.

Sonni tourne sur **son propre VPS**, séparé de Money Lab : une panne ou une installation de Money Lab ne
peut pas l'arrêter, et le jour où il aura du vrai argent, ses clés ne seront jamais à côté d'un autre
agent. Phase actuelle : **portefeuille virtuel uniquement**, aucune plateforme de trading, aucun compte
à ouvrir hormis Anthropic et Telegram.

**Ce qu'il te faut :** une carte bancaire, ton téléphone avec Telegram, un ordinateur, environ 1 heure.

> Pour toutes les commandes : copie-colle une ligne, appuie sur **Entrée**, attends la fin avant la
> suivante. Si une ligne affiche une erreur en rouge, arrête-toi et envoie-moi le message (sans clé ni
> mot de passe).

---

## Étape 1 — Le cerveau : un espace Anthropic rien que pour Sonni

Sonni ne doit jamais utiliser la clé de Money Lab : chaque bot a son budget et sa limite.

1. Va sur https://console.anthropic.com (le même compte que Money Lab convient).
2. **Workspaces / Espaces de travail** : crée un espace nommé `Sonni`.
3. Dans cet espace, **Limits / Limites** : fixe une limite de dépense mensuelle, par exemple **58 $**
   (environ 50 €). C'est ta protection ultime : même en cas de bug, Anthropic ne facturera pas au-delà.
4. **Billing / Facturation** : vérifie qu'il reste assez de crédits pour le mois.
5. **API Keys**, dans l'espace `Sonni` : crée une clé. Elle commence par `sk-ant-`. Copie-la dans un
   endroit sûr (tu ne pourras plus la revoir). **Ne la donne à personne, ni dans un chat.**

## Étape 2 — Son canal : un nouveau bot Telegram

1. Dans Telegram, ouvre **@BotFather**, envoie `/newbot`, choisis un nom (ex : `Sonni`) et un
   identifiant finissant par `bot` (ex : `sonni_courtier_bot`). BotFather te donne un **token** :
   garde-le secret. Ce n'est pas le même bot que Money Lab.
2. Ton **chat id** ne change pas : c'est le même nombre que pour Money Lab (sinon, demande-le à
   **@userinfobot**).
3. Ouvre la conversation avec **ton nouveau bot** et appuie sur **Démarrer** (sinon il ne pourra pas
   t'écrire).

## Étape 3 — Louer le serveur

1. Chez ton hébergeur (le même que Money Lab, c'est plus simple), loue le plus petit VPS avec
   **Ubuntu 24.04** et **2 Go de mémoire** (la compilation du programme en a besoin ; Sonni lui-même est
   léger). Note son **adresse IP** et son **mot de passe root** (ou ta clé SSH).
2. Son prix mensuel est à ta charge, **en dehors** des 50 €/mois de Sonni.

## Étape 4 — Se connecter au serveur

Sur ton ordinateur, ouvre **Terminal** (Mac) ou **PowerShell** (Windows), puis :
```sh
ssh root@ADRESSE_IP
```
Tape `yes` si on te le demande, puis le mot de passe (il ne s'affiche pas quand tu tapes, c'est
normal ; pour coller dans PowerShell, fais un clic droit). Tu es « dans » le serveur de Sonni.

**Mot de passe refusé ?** Chez plusieurs hébergeurs (OVH notamment), on ne se connecte pas en `root`
sur Ubuntu mais avec l'utilisateur `ubuntu` :
```sh
ssh ubuntu@ADRESSE_IP
sudo -i
```
La première connexion peut demander de changer le mot de passe (l'ancien, puis deux fois le nouveau).
Après `sudo -i`, la ligne finit par `root@…:~#` : continue le guide normalement. Si c'est encore refusé,
vérifie l'adresse IP (celle du **nouveau** VPS) ou réinitialise le mot de passe depuis l'espace client
de l'hébergeur.

## Étape 5 — Préparer et installer

Colle ces blocs l'un après l'autre :
```sh
apt update && apt -y upgrade
apt -y install git curl ufw sudo
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node --version
```
La dernière ligne doit afficher `v22…`.

```sh
ufw allow OpenSSH && ufw --force enable
useradd --create-home --shell /bin/bash sonni
git clone https://github.com/moneylab-djib/Money-lab-trader /opt/sonni
chown -R sonni:sonni /opt/sonni
corepack enable pnpm
cd /opt/sonni
sudo -u sonni -H pnpm install --frozen-lockfile
sudo -u sonni -H pnpm run build
```
Aucun port n'est ouvert à part SSH : Sonni n'a besoin de rien recevoir d'internet.

## Étape 6 — Configurer

Remplace `123456789` par ton chat id (étape 2) et `1.16` par le taux euro→dollar du jour (cherche
« EUR USD » sur internet) :
```sh
cd /opt/sonni
sudo -u sonni -H node sonni/vps/configure.mjs --chat-id 123456789 --monthly-budget-eur 50 --eur-usd 1.16
```
Tu dois voir `Configuration Sonni écrite`, le budget en dollars et la commande de l'étape 7 : garde-la.

Ensuite, le fichier des secrets (lisible uniquement par l'administrateur, **pas par Sonni**) :
```sh
cp sonni/vps/sonni.env.example /etc/sonni.env
chown root:root /etc/sonni.env && chmod 600 /etc/sonni.env
nano /etc/sonni.env
```
Remplace les deux `REPLACE_ME` par la clé Anthropic de l'étape 1 et le token Telegram de l'étape 2.
Enregistre avec **Ctrl+O**, **Entrée**, puis quitte avec **Ctrl+X**.

## Étape 7 — Donner son budget du mois

Colle la commande affichée à l'étape 6 (pour 50 € à 1,16 : `5800` centimes de dollar), puis vérifie :
```sh
sudo -u sonni -H node dist/index.js --money-lab ledger-add owner_funding 5800 budget-mois-1
sudo -u sonni -H node dist/index.js --money-lab status
```
Le statut doit montrer **Solde : 58.00 USD**. Chaque mois, ajoute le budget suivant depuis Telegram avec
`/fonds 58` (et vérifie les crédits chez Anthropic).

## Étape 8 — Ses premières intuitions

Sonni ne peut pas faire de prédiction sans intuition à tester. Donne-lui-en deux ou trois, à ta façon.
Exemples (à adapter) :
```sh
sudo -u sonni -H node dist/index.js --sonni idee "Après une baisse de plus de 3 % en une journée, le BTC remonte souvent dans les 24 heures"
sudo -u sonni -H node dist/index.js --sonni idee "ETH suit le BTC dans le même sens sur 24 heures, mais en plus fort"
sudo -u sonni -H node dist/index.js --sonni intuitions
```
Tu pourras en ajouter à tout moment depuis Telegram avec `/idee <texte>`, et il t'en proposera chaque
dimanche.

## Étape 9 — Démarrer Sonni (24 h/24)

```sh
cp sonni/vps/sonni.service /etc/systemd/system/sonni.service
systemctl daemon-reload
systemctl enable --now sonni
ps -o user= -p $(systemctl show -p MainPID --value sonni)
journalctl -u sonni -f
```
L'avant-dernière commande doit afficher `sonni` (le programme ne tourne jamais en root). La dernière
affiche ce que fait Sonni en direct ; tu dois voir `[SONNI] Actif : BTC, ETH, prix toutes les 5 min`.
**Ctrl+C** pour arrêter de regarder ; Sonni continue. Il redémarre tout seul en cas de plantage ou de
redémarrage du serveur.

## Étape 10 — Lui parler sur Telegram

Envoie `/aide` à ton nouveau bot. Commandes :

| Commande | Effet |
| --- | --- |
| `/statut` | l'essentiel en quatre blocs (portefeuille, marché et prédictions, apprentissage, budget), heure de Paris |
| `/portefeuille` | son portefeuille virtuel : valeur, positions avec leur raison, ordres, résultats calculés par le code, pièges |
| `/journee` | le résumé du jour (ordres et raisons, valeur, prédictions, journal, dépense) ; tu le reçois aussi chaque soir à 20 h |
| `/dossier [actif]` | son dossier sur un actif (thèse, catalyseurs, niveaux, versions) |
| `/note <texte>` | lui laisser une note : une information fiable de ta part, lue à sa prochaine séance (pas un ordre) |
| `/memoire <sujet>` | ce qu'il sait sur un sujet : recherche dans toute sa mémoire (dossiers, intuitions, journal, leçons, pièges, tes notes, ses ordres et décisions, l'actualité, le second cerveau, les résumés de chaque jour, semaine et mois), sans accents ni majuscules, les plus importants et récents d'abord |
| `/cycles` | réactions mesurées par le code autour des événements (Fed, inflation, emploi) et cycles nommés par Sonni, avec leur verdict |
| `/carnets` | écrire ses carnets Markdown dans `/home/sonni/carnet/` (aussi chaque dimanche) ; lis-les avec `sudo -u sonni cat /home/sonni/carnet/btc.md` |
| `/technique` | état technique du programme (budget détaillé, pauses, cycles) et les incidents des 7 derniers jours (ce que le programme a fait seul : pause, plafond, erreurs, sauvegarde) |
| `/idee <texte>` | lui donner une intuition à tester |
| `/intuitions` | ses intuitions, avec les preuves pour et contre, sa confiance calculée et le verdict de l'historique |
| `/agenda` | les événements des 30 prochains jours (Fed, et inflation et emploi avec la clé FRED) |
| `/bilan` | sa calibration et ses scores, calculés par le code |
| `/identite [texte]` | l'identité qu'il s'est écrite, et ses versions précédentes ; avec un texte, ta version (il doit y garder « Je suis Sonni ») |
| `/journal [n]` | ses n dernières réflexions (post-mortems, notes de séance, revue) |
| `/lecons` / `/veto <id> [raison]` | ses leçons, avec combien de fois chacune a aidé ou nui quand il l'a appliquée ; en retirer une |
| `/reveils` | ses réveils spontanés et les déclencheurs notés |
| `/lecteurs` | l'état des IA lectrices gratuites (voir plus bas) |
| `/cerveau [mode]` | le second cerveau sur ton PC (état, modèle, tâches, scores) ; modes `arret`, `assistant` (par défaut), `parallele`, `delegue` (voir `sonni/GUIDE-PC.fr.md`) |
| `/question <texte>` | demander au second cerveau ce que Sonni sait ; réponse ici en quelques minutes, sans réveiller Claude |
| `/sources` / `/source ok\|non <id>` | ses sources de données ; accepter ou refuser une source qu'il propose |
| `/actifs` | le socle que tu as choisi, ses places tournantes (3 au plus) et le crible de la semaine ; `/actifs non <symbole>` retire une place tournante |
| `/sante` | rapport de santé du serveur ; chaque matin tu reçois plutôt le rapport de Sonni (veille, journée, vraies alertes) |
| `/fonds 58` | ajouter le budget du mois suivant, en dollars |
| `/pause [raison]` / `/reprendre` | arrêter / relancer ses dépenses |
| tout autre message | transmis à Sonni comme une conversation |

Ce qu'il fait seul : il relève les prix toutes les 5 minutes (gratuit), interroge ses sources de
données, fait quelques séances de décision par jour, note ses prédictions, et le code les juge à
l'échéance. Son portefeuille virtuel (1 000 € au premier relevé de prix, puis 50 € par mois, réglable
dans `trader.portfolio`) : il passe des ordres fictifs avec une raison, un niveau d'invalidation et un
horizon ; le code vérifie (au plus 30 % par actif, 10 € minimum, prix frais) et exécute au prix suivant
avec les frais Kraken ; il vend tout seul si le niveau d'invalidation est atteint. Le code le réveille
quand un actif bouge de 3 % en une heure, les jours d'événement, quand des prédictions sont résolues,
quand un stop se déclenche, qu'un ordre expire ou qu'une position arrive à son horizon, ou quand une de ses veilles se
déclenche (6 réveils par jour au plus). Après chaque résultat et chaque opération close, il écrit un
post-mortem dans son journal. Chaque soir à 19 h 30, le code le réveille pour une courte séance
d'autopsie (post-mortems dus, pièges, dossiers, une note du jour : un tour payé) ; à 20 h, tu reçois
son résumé du jour avec cette note. Chaque dimanche, il fait sa revue et t'envoie un rapport en
français.

## Facultatif — Des IA gratuites pour lire l'actualité

Sonni peut confier la lecture (jamais les décisions) à un modèle gratuit : chaque heure, il
transforme les titres en observations datées, et résume les pages que Sonni demande à lire. Deux
services ont une offre gratuite sans carte bancaire ; une clé suffit, deux donnent une roue de
secours. **N'active aucune facturation** sur ces comptes : Sonni est plafonné en appels par jour, mais
ta vraie protection est l'absence de moyen de paiement.

1. Google AI Studio (Gemini) : https://aistudio.google.com/apikey avec ton compte Google, accepte
   les conditions, puis *Create API key* (les clés créées depuis mai 2026 sont des « auth keys »,
   limitées à l'API Gemini : c'est ce qu'il faut). Copie la clé. Google ne publie plus les limites
   gratuites : regarde-les sur https://aistudio.google.com/rate-limit pour le modèle
   `gemini-3.5-flash-lite` (Sonni s'arrête à 200 appels par jour ; baisse ce nombre dans
   `sonni/automaton.sonni.example.json` si ta page affiche moins). **Ne relie jamais de compte de
   facturation** à ce projet. Pour un compte en Europe, Google n'utilise pas tes requêtes pour
   entraîner ses modèles, même en gratuit (conditions Gemini, lues le 7 octobre 2026).
2. Groq : https://console.groq.com → *API Keys* → *Create API Key* (nom : `sonni-reader`). Copie la
   clé tout de suite (elle ne se réaffiche pas). Dans *Settings → Data Controls*, active *Zero Data
   Retention*. Reste sur le plan *Free* (modèle `openai/gpt-oss-20b` : 1 000 requêtes et
   200 000 jetons par jour publiés ; Sonni s'arrête à 80 appels par jour pour tenir dans les jetons).
3. Sur le serveur : `nano /etc/sonni.env`, mets les clés après `GEMINI_API_KEY=` et `GROQ_API_KEY=`
   (laisse vide celle que tu n'as pas), enregistre (Ctrl+O, Entrée, Ctrl+X), puis
   `systemctl restart sonni`.
4. Vérifie sur Telegram avec `/lecteurs` : chaque lecteur doit être « disponible ». Une heure plus
   tard, `/statut` compte les observations extraites. Sonni ne peut pas lire ces clés.

Les limites gratuites changent souvent (vérifiées le 7 octobre 2026). Si un lecteur répond « quota »
ou « clé refusée », Sonni le met au repos et passe au suivant ; `/lecteurs` le dit. D'autres offres
gratuites existent (Cloudflare Workers AI, Mistral « Free », OpenRouter) : on les ajoutera si les
deux premières ne suffisent pas.

## Facultatif — Les dates d'inflation et d'emploi américains

Sonni connaît déjà les dates des décisions de la Fed (page publique, sans compte). Pour qu'il connaisse
aussi les dates des chiffres de l'inflation (CPI) et de l'emploi américains, il faut une clé gratuite de
la Réserve fédérale de Saint-Louis (FRED) :

1. Crée un compte sur https://fred.stlouisfed.org (bouton *My Account*), à ton nom.
2. Va dans *My Account → API Keys → Request API Key*, décris l'usage (« calendrier personnel ») :
   tu obtiens une clé de 32 caractères.
3. Sur le serveur : `nano /etc/sonni.env`, mets la clé après `FRED_API_KEY=`, enregistre (Ctrl+O,
   Entrée, Ctrl+X), puis `systemctl restart sonni`.
4. Vérifie sur Telegram avec `/agenda` : les lignes « inflation américaine (CPI) » et « emploi
   américain » apparaissent. Sonni ne peut pas lire cette clé.

## Facultatif — Le second cerveau sur ton PC

Ton PC peut faire tourner un modèle d'IA local qui travaille pour Sonni 24 h/24 (tri de l'actualité,
notes de situation, avocat du diable, réponses à `/question`) et garder chaque nuit une copie de sa
mémoire. Tout est dans **`sonni/GUIDE-PC.fr.md`** (environ 2 heures). Sans lui, Sonni fonctionne
exactement comme avant.

## Mettre Sonni à jour

**La mise à jour qui apporte les étapes 0.1 à 0.3 (frais comptés partout, précision des prix) ne suit
pas ce bloc** : elle suit la procédure « Déploiement contrôlé des étapes 0.1 à 0.3 » plus bas, avec
sauvegarde, essai de restauration et contrôle avant de redémarrer. Le bloc ci-dessous reste la mise à jour
ordinaire, pour plus tard.

```sh
cd /opt/sonni
sudo -u sonni -H git fetch origin
sudo -u sonni -H git checkout main
sudo -u sonni -H git pull
sudo -u sonni -H pnpm install --frozen-lockfile
sudo -u sonni -H pnpm run build
sudo -u sonni -H node sonni/vps/configure.mjs --monthly-budget-eur 50 --eur-usd 1.17
systemctl restart sonni
```
Ton identifiant Telegram est repris de la configuration précédente : `--chat-id` ne sert qu'à la
première installation. Tape ou colle ces lignes une par une plutôt qu'en bloc. Le taux `--eur-usd`
sert aussi à convertir ce que coûte l'IA pour la mesure d'autofinancement du portefeuille.
Depuis le 8 octobre, `systemctl restart sonni` pendant que Sonni dort ne le réveille plus : il reprend
son sommeil sans appel payé (le journal affiche « Redémarrage pendant le sommeil : pas de réveil
payé »). S'il ne dormait pas, ou si un de tes messages attend, il se réveille normalement.
Avec la mise à jour de l'étape 2 (univers vivant), la ligne `configure.mjs` ajoute à ton socle l'or
(PAXG), le dollar (USDC), les actions américaines (SPY) et Nvidia (NVDA) : au redémarrage, le journal
affiche « suivi (ajouté dans la configuration) » pour chacun, puis leurs prix arrivent à la collecte
suivante et leur historique dans les 6 heures. `/actifs` les montre dans le socle.
Avec la mise à jour de l'étape 3 (second cerveau), elle ajoute aussi le bloc `secondBrain` (ton PC,
`http://sonni-pc:8080/v1`) : rien ne change tant que `SECOND_BRAIN_API_KEY` est vide dans
`/etc/sonni.env` (voir `sonni/GUIDE-PC.fr.md`). La même mise à jour corrige les sauvegardes
quotidiennes : le serveur garde maintenant vraiment les 7 dernières (avant, environ 3 jours), et les
fichiers en trop sont nettoyés à la sauvegarde suivante.
Avec la mise à jour de l'étape 4 (mémoire v2), rien à configurer : au premier démarrage, le code construit
l'index de recherche de toute sa mémoire (quelques secondes) et calcule les résumés des jours, semaines et
mois déjà terminés (le journal affiche « Résumés calculés : … »).
Toutes les étapes sont fusionnées dans `main` depuis le 7 octobre : la ligne `git checkout main`
ramène un serveur installé sur une branche d'étape (`claude/sonni-alive`) sur `main`, sans effet si tu y
es déjà. `git status` doit ensuite afficher `On branch main`.
Pour l'étape 0.3 (précision des prix), l'audit des prix fait partie du déploiement contrôlé ci-dessous :
il ne se lance que sur une copie, jamais sur la base active.
La ligne `configure.mjs` réécrit la configuration avec les nouveaux réglages (sources, lecteurs,
réveils) en gardant tes valeurs ; elle ne touche pas aux clés ni à sa mémoire. Lance-la bien avec
`sudo -u sonni -H` (en root seul, elle écrit un fichier que Sonni ne lit pas, et le dit). Elle doit
afficher la ligne « IA lectrices (gratuites, facultatives) : gemini …, groq … » et « Mise à jour » ;
**ne rajoute pas de budget** à ce moment-là, celui du mois est déjà enregistré. Sans elle, `/lecteurs`
répond « Aucune IA lectrice configurée ». Ses prix, prédictions,
intuitions, journal et identité sont conservés. La pause (`/pause`) aussi : relance avec
`/reprendre`.

## Déploiement contrôlé des étapes 0.1 à 0.3

Ce déploiement apporte trois corrections :
- 0.1 : la vérification automatique du code ;
- 0.2 : les résultats des opérations comptent tous les frais ;
- 0.3 : les prix gardent leur précision et le courtier virtuel refuse tout chiffre invalide.

Il ne change ni la stratégie, ni les frais, ni les réglages, ni la forme de la base.

**Rien ne change sur le serveur avant ton GO de déploiement** : les phases 0 et 1 ne font que lire.

Règles pour tout ce qui suit :
- tape les commandes une par une ;
- chaque outil finit par une ligne `RÉSULTAT : code=…`. Seul `code=0` permet de continuer. Pour `code=1`,
  `2` ou `3`, arrête-toi et envoie-moi toute la sortie ;
- **ne répare rien toi-même**. Une réparation de l'historique demande une procédure séparée et ton accord.

Dans les commandes :
- `COMMIT` est le numéro de version que ton GO de déploiement approuve. Il contient les étapes 0.1 à 0.3
  et les outils de cette procédure ;
- `COPIE` est le chemin qu'affiche la sauvegarde.

### Phase 0 — L'état actuel (lecture seule)

Connecte-toi (étape 4), puis :
```sh
cd /opt/sonni
sudo -u sonni -H git log -1 --format='%H %cd %s'
sudo -u sonni -H git status --short
systemctl is-active sonni
systemctl show -p ActiveEnterTimestamp sonni
ls -la /home/sonni/.automaton/ /home/sonni/.automaton/backups/
df -h /home /root
systemctl list-timers sonni-backup-export.timer --no-pager
```
Envoie-moi tout. La première ligne donne la version en service, qui servira de point de retour. Le reste
montre l'état des sauvegardes et la place libre sur le disque.

### Phase 1 — Pré-audit sur une copie, hors du serveur (aucun changement sur le VPS)

**La copie.** Prends la dernière sauvegarde quotidienne. Sonni l'écrit lui-même avec la fonction de
sauvegarde de SQLite et la vérifie chaque jour. Elle peut avoir jusqu'à un jour : ce qui s'est passé depuis
sera contrôlé à la phase 2.

**La récupérer sur ton PC**, au choix :
- **Ton PC la reçoit déjà chaque nuit** (partie 6 de `sonni/GUIDE-PC.fr.md`) : prends le fichier le plus
  récent de `C:\Sonni\sauvegardes`.
- **Tu te connectes en `root`**, dans PowerShell :
  ```powershell
  scp root@ADRESSE_IP:/home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ C:\Sonni\pre-audit\
  ```
- **Tu te connectes en `ubuntu`.** Utilise `cmd`, car PowerShell abîmerait le fichier :
  ```powershell
  cmd /c "ssh ubuntu@ADRESSE_IP sudo cat /home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ > C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ"
  ```

**Vérifier l'empreinte.** Sur le serveur, lance
`sha256sum /home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ`. Sur le PC, lance
`Get-FileHash C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ`. Les deux empreintes doivent être identiques.

**Faire le contrôle**, au choix :
- **A, le plus simple** : envoie-moi ce fichier dans notre conversation. Je lance les deux contrôles et je te
  présente le résultat. Le fichier contient toute la mémoire de Sonni : journal, ordres, prédictions et tes
  messages. Il ne contient aucune clé, car elles restent dans `/etc/sonni.env`.
- **B, sur ton PC** : il faut Node 22 et une copie de `main`, puis `pnpm install`. Lance :
  ```sh
  node sonni/vps/restauration.mjs --essai C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ
  node sonni/vps/controle-predeploiement.mjs C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ
  ```

**Ce que font les contrôles.**
- L'essai de restauration remet la copie en place dans un dossier temporaire. Il vérifie qu'elle est intacte
  et complète, mesure le temps que prend la restauration, puis efface ce dossier.
- Le contrôle avant déploiement comprend l'audit des prix de l'étape 0.3. Il rapproche aussi la caisse et
  chaque position du registre. Il liste chaque ordre en attente et chaque stop, avec ce que le premier relevé
  en fera. Il signale enfin si le redémarrage lancera un cycle payé.

**Le résultat** classe chaque point en trois niveaux :
- **BLOQUANT** : une anomalie dans les données, par exemple une position invalide ou un registre qui ne tombe
  pas juste ;
- **À DÉCIDER** : ce que le redémarrage déclenchera, ou un écart historique. Par exemple un stop déjà
  franchi, un ordre ancien qui sera refusé ou un écart d'arrondi d'avant l'étape 0.3 ;
- **INFO** : pour information seulement.

Avec `code=1`, le déploiement est bloqué : je te présente les points et tu décides. Tu peux accepter les
points « À DÉCIDER » dans ton GO de déploiement. Pour un point BLOQUANT, il faut d'abord une procédure de
réparation séparée.

### Phase 2 — La fenêtre de déploiement (seulement après ton GO de déploiement)

**Choisis le moment.** Évite :
- 19 h 00 à 20 h 00, heure de Paris (bilan du soir et résumé) ;
- 02 h 15 à 02 h 45 UTC (copie pour le PC).

L'idéal est que Sonni dorme : `/statut` le dit. Ne fais pas en même temps le redémarrage du serveur que
propose Ubuntu.

1. **Note le point de retour :**
   ```sh
   cd /opt/sonni
   sudo -u sonni -H git rev-parse HEAD | tee /root/sonni-commit-avant.txt
   cp -p /home/sonni/.automaton/automaton.json /root/automaton.json.avant-deploiement
   ```
2. **Arrête Sonni :**
   ```sh
   systemctl stop sonni
   systemctl is-active sonni
   ls -la /home/sonni/.automaton/state.db*
   ```
   La deuxième ligne doit afficher `inactive`. La troisième ne doit montrer que `state.db`. S'il reste un
   `state.db-wal` ou un `state.db-shm`, l'arrêt n'a pas été propre : arrête-toi et envoie-moi la sortie.
3. **Installe exactement la version approuvée :**
   ```sh
   sudo -u sonni -H git fetch origin
   sudo -u sonni -H git checkout main
   sudo -u sonni -H git merge --ff-only COMMIT
   sudo -u sonni -H git rev-parse HEAD
   sudo -u sonni -H pnpm install --frozen-lockfile
   sudo -u sonni -H pnpm run build
   ```
   `git rev-parse HEAD` doit afficher `COMMIT`. Si `merge --ff-only` refuse, arrête-toi et redémarre
   l'ancienne version avec `systemctl start sonni` : rien n'a changé.

   Ne lance **pas** `configure.mjs` cette fois : aucun réglage ne change.
4. **Fais la sauvegarde.** Sonni est arrêté, donc c'est une copie exacte du fichier :
   ```sh
   sudo -u sonni -H node sonni/vps/sauvegarde.mjs
   ```
   Elle écrit dans `/home/sonni/.automaton/predeploiement/`, à côté de son empreinte `.sha256`. Ce dossier
   n'est jamais vidé par la rotation des sauvegardes quotidiennes. La dernière ligne donne `COPIE`.
5. **Fais l'essai de restauration** (dans un dossier temporaire) :
   ```sh
   sudo -u sonni -H node sonni/vps/restauration.mjs --essai COPIE
   ```
6. **Fais le contrôle avant démarrage :**
   ```sh
   sudo -u sonni -H node sonni/vps/controle-predeploiement.mjs COPIE
   ```
   Ajoute `--accepter-a-decider` seulement si ton GO a accepté les points « À DÉCIDER » de la phase 1, et
   s'ils sont les mêmes. Un point BLOQUANT bloque toujours.
7. **Si une de ces trois commandes ne finit pas par `code=0`**, ne démarre pas la nouvelle version. Au
   choix :
   - redémarre l'ancienne : suis « Retour arrière » plus bas, étapes R3 et R4 ;
   - ou laisse Sonni arrêté.

   Envoie-moi la sortie : la décision est la tienne.
8. **Démarre :**
   ```sh
   date -u +%Y-%m-%dT%H:%M:%SZ | tee /root/sonni-demarrage.txt
   systemctl start sonni
   systemctl is-active sonni
   ```

### Phase 3 — Contrôles après démarrage et rapport Telegram

**Attends 10 à 15 minutes**, le temps d'une collecte de prix et d'un passage du courtier virtuel, puis :
```sh
journalctl -u sonni -n 80 --no-pager
sudo -u sonni -H node sonni/vps/controle-apres-demarrage.mjs --depuis "$(cat /root/sonni-demarrage.txt)" --commit-attendu COMMIT
```

**Dans le journal**, tu dois voir :
- `[MONEY LAB] Canal Telegram actif.` ;
- `[SONNI] Actif : …` ;
- s'il dormait : `[SONNI] Redémarrage pendant le sommeil : pas de réveil payé`.

Tu ne dois voir ni `Fatal`, ni `Les clés du programme sont lisibles`.

**Le contrôle lit la base sans rien écrire.** Il vérifie :
- la version en marche ;
- les prix arrivés depuis le démarrage ;
- les appels payés ;
- les incidents ;
- les ordres refusés ;
- que chaque position est utilisable ;
- les messages Telegram en attente ;
- les pannes répétées.

Un échec passager, par exemple une seule coupure de Telegram, reste une information. Une panne n'est une
alerte que si elle se répète, aux mêmes seuils que `/santé`.

**Si ton GO a accepté le refus de certains ordres** annoncés à la phase 2, ajoute
`--ordres-acceptes ID1,ID2` (les numéros que le contrôle avant démarrage a donnés). Leur refus devient
alors une information. Tout autre refus reste une alerte.

**Le rapport sur Telegram.** Cette ligne se lance en `root`, car elle lit le jeton du bot dans
`/etc/sonni.env`. Le jeton n'est jamais affiché :
```sh
sudo -u sonni -H node sonni/vps/controle-apres-demarrage.mjs --depuis "$(cat /root/sonni-demarrage.txt)" --commit-attendu COMMIT --resume | node sonni/vps/envoi-telegram.mjs
```

**Sur ton téléphone**, envoie :
- `/statut` ;
- `/portefeuille`, où les résultats portent la mention « (après tous les frais) » ;
- `/technique`, où aucun incident « courtier virtuel » ne doit apparaître.

**Déclencheurs de retour arrière.** Décide dans les 15 minutes, et le retour arrière se fait sur ton accord.
Les déclencheurs sont :
- le contrôle finit par `code=1` ;
- `systemctl is-active sonni` n'affiche pas `active`, ou Sonni redémarre en boucle (`systemctl status sonni`
  montre des redémarrages) ;
- un incident « courtier virtuel » dans `/technique` ;
- « Valeur non fiable » dans `/portefeuille` ;
- plusieurs cycles payés que tu n'as pas demandés ;
- aucune réponse sur Telegram.

**Observation de 24 heures.** Surveille :
- la sauvegarde quotidienne suivante ;
- le bilan du soir et le résumé de 20 h ;
- la copie de nuit pour le PC ;
- le rapport du matin.

Le lendemain, envoie-moi `/technique` et `/bilan`. L'étape est dite « en service » une fois démarrée avec
des contrôles verts. Elle n'est « observée » qu'après ces 24 heures et ton accord.

### Retour arrière

**Par défaut, on revient sur le code et on garde la base.** L'ancienne version relit sans erreur ce que la
nouvelle a écrit : c'est vérifié sur les deux versions possibles du serveur, et la forme de la base ne change
pas.

Ce que tu verras de nouveau avec l'ancienne version :
- les résultats sans les frais d'achat ;
- les prix sous 1 € arrondis au centime (« 0,00 € ») ;
- les refus du courtier virtuel en anglais.

**Attention.** L'ancienne version ramène aussi le défaut que l'étape 0.3 corrige. Pendant qu'elle tourne, un
achat à moins de 0,005 € redeviendrait une quantité infinie, et l'historique serait abîmé pour de bon.
Donc :
- **avant** le retour arrière, regarde `/portefeuille`. S'il y a un ordre d'achat en attente sur un actif à
  moins de 1 €, dis-le-moi d'abord ;
- **après**, mets Sonni en pause avec `/pause`, le temps qu'on corrige. En pause, il ne place plus d'ordre ;
  le courtier exécute seulement ceux déjà en attente.

R1. **Restaurer la base seulement en cas de corruption, et seulement sur ta décision.** La restauration
efface tout ce que Sonni a écrit après `COPIE` : journal, prédictions, ordres et dépenses d'IA déjà
comptées. S'il faut restaurer la base **et** revenir sur le code, restaure la base d'abord, car l'outil
n'existe que dans la nouvelle version :
```sh
systemctl stop sonni
sudo -u sonni -H node sonni/vps/restauration.mjs --restaurer COPIE --confirmer
```
L'outil vérifie l'empreinte et refuse tant que Sonni tourne. Il ne supprime rien : l'ancienne base et ses
fichiers `-wal`/`-shm` partent dans un dossier `quarantaine-…` à côté.

R2. **Arrête Sonni :** `systemctl stop sonni`

R3. **Reviens à l'ancienne version :**
```sh
cd /opt/sonni
sudo -u sonni -H git checkout --detach "$(cat /root/sonni-commit-avant.txt)"
sudo -u sonni -H pnpm install --frozen-lockfile
sudo -u sonni -H pnpm run build
```

R4. **Démarre et vérifie :**
```sh
systemctl start sonni
journalctl -u sonni -n 80 --no-pager
```
Puis envoie `/statut`, `/portefeuille` et `/technique` sur Telegram. Les outils de contrôle n'existent pas
dans l'ancienne version : on vérifie avec le journal et Telegram. Envoie-moi le résultat.

## Arrêter Sonni

1. Telegram : `/pause fin` (plus aucune dépense d'inférence).
2. Serveur : `systemctl stop sonni` puis `systemctl disable sonni`.
3. Sauvegarde (sa mémoire) : `cd /opt/sonni && sudo -u sonni -H node sonni/vps/sauvegarde.mjs`. Elle
   écrit une copie vérifiée, avec son empreinte, dans `/home/sonni/.automaton/predeploiement/`.
   Télécharge-la ensuite chez toi. Si ton PC suit la partie 6 de `sonni/GUIDE-PC.fr.md`, il en garde
   déjà une par nuit dans `C:\Sonni\sauvegardes`.
4. **La pause n'arrête pas les factures** : supprime le VPS chez l'hébergeur quand tu n'en as plus besoin.

## Limites à connaître

- Phase virtuelle : aucun argent réel, aucune clé de plateforme sur ce serveur. Ne mets **jamais** une
  clé de trading sur ce serveur sans qu'on ait préparé ensemble la phase réelle.
- Les plafonds de dépense sont appliqués dans le programme ; une commande shell détournée pourrait les
  contourner. Ta vraie protection est la limite de l'espace `Sonni` chez Anthropic.
- Le budget est lissé par un plafond quotidien (1/30 du mois) ; le lissage exact sur le mois viendra
  dans une prochaine étape.
- Sonni s'arrête quand son solde passe sous zéro, jusqu'à ce que tu ajoutes le budget suivant.
