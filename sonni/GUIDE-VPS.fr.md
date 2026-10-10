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
  `2` ou `3`, arrête-toi et envoie-moi toute la sortie. Une seule exception : « Trop tôt : relance dans
  N min » veut dire d'attendre puis de relancer la même commande ;
- **ne répare rien toi-même**. Une réparation de l'historique demande une procédure séparée et ton accord.

Les valeurs à remplacer dans les commandes :
- `COMMIT` : le numéro de version que je te donne avec mon rapport, et que ton GO de déploiement approuvera.
  Il contient les étapes 0.1 à 0.3 et les outils de cette procédure ;
- `COPIE` : le chemin qu'affiche la sauvegarde ;
- `EMPREINTE_ENVOI` : l'empreinte de l'outil d'envoi Telegram, que je te donne avec `COMMIT`.

### Phase 0 — L'état actuel (lecture seule)

Connecte-toi (étape 4), puis :
```sh
cd /opt/sonni
sudo -u sonni -H git log -1 --format='%H %cd %s'
sudo -u sonni -H git status --short
systemctl is-active sonni
systemctl show -p ActiveEnterTimestamp sonni
ls -la /home/sonni/.automaton/ /home/sonni/.automaton/backups/
df -h /home /root /tmp
systemctl list-timers sonni-backup-export.timer --no-pager
```
Puis, toujours en lecture seule, ce dont les outils auront besoin :
```sh
id sonni
sudo -u sonni -H node -v
stat -c '%U %a %s %n' /home/sonni /home/sonni/.automaton /home/sonni/.automaton/state.db
ls -la /opt/sonni/node_modules/better-sqlite3
sudo -u sonni -H node -e "require('/opt/sonni/node_modules/better-sqlite3')(':memory:').close(); console.log('SQLite OK')"
command -v git tar sha256sum systemctl
```
Envoie-moi tout. La première ligne donne la version en service, qui servira de point de retour. Le reste
montre l'état des sauvegardes, la place libre, la version de Node, la bibliothèque SQLite que les outils
emprunteront à Sonni (sa version est dans le nom du lien) et les commandes présentes. Je compare avec ce que
les outils demandent avant de te donner `COMMIT` ; la Phase 2 le revérifie avec un outil (étape 3).

### Phase 1 — Pré-audit sur une copie, hors du serveur (aucun changement sur le VPS)

**La copie.** Prends la dernière sauvegarde quotidienne. Sonni l'écrit lui-même avec la fonction de
sauvegarde de SQLite et la vérifie chaque jour.

Elle peut avoir jusqu'à un jour. Le contrôle prévoit donc ce que Sonni aurait fait **au moment de la
copie**. Ce qui s'est passé depuis sera contrôlé à la phase 2, sur une copie fraîche.

**La ranger sur ton PC.** Dans PowerShell, crée d'abord le dossier :
```powershell
New-Item -ItemType Directory -Force C:\Sonni\pre-audit
```
Puis, au choix :
- **Ton PC la reçoit déjà chaque nuit** (partie 6 de `sonni/GUIDE-PC.fr.md`) :
  ```powershell
  Copy-Item C:\Sonni\sauvegardes\state.db.backup-AAAA-MM-JJ C:\Sonni\pre-audit\
  ```
- **Tu te connectes en `root`** :
  ```powershell
  scp root@ADRESSE_IP:/home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ C:\Sonni\pre-audit\
  ```
- **Tu te connectes en `ubuntu`.** Utilise `cmd`, car PowerShell abîmerait le fichier :
  ```powershell
  cmd /c "ssh ubuntu@ADRESSE_IP sudo cat /home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ > C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ"
  ```

**Vérifier l'empreinte.** Lance :
- sur le serveur : `sha256sum /home/sonni/.automaton/backups/state.db.backup-AAAA-MM-JJ` ;
- sur le PC : `Get-FileHash C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ`.

Les deux empreintes doivent être identiques. Le serveur l'écrit en minuscules et le PC en majuscules : cette
différence ne compte pas.

**Faire le contrôle**, au choix :
- **A, le plus simple** : envoie-moi ce fichier dans notre conversation. Je lance les deux contrôles et je te
  présente le résultat. Le fichier contient toute la mémoire de Sonni : journal, ordres, prédictions et tes
  messages. Il ne contient aucune clé, car elles restent dans `/etc/sonni.env`.
- **B, sur ton PC.** Il faut Node 22, Git et pnpm. Si GitHub te le demande, connecte-toi avec ton compte.
  Dans PowerShell :
  ```powershell
  cd C:\Sonni
  git clone https://github.com/moneylab-djib/Money-lab-trader.git sonni-code
  cd C:\Sonni\sonni-code
  git checkout COMMIT
  pnpm install --frozen-lockfile
  node sonni/vps/restauration.mjs --essai C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ
  node sonni/vps/controle-predeploiement.mjs C:\Sonni\pre-audit\state.db.backup-AAAA-MM-JJ
  ```

**Ce que font les contrôles.**
- L'essai de restauration remet la copie en place dans un dossier temporaire. Il vérifie qu'elle est intacte
  et complète, mesure le temps que prend la restauration, puis efface ce dossier.
- Le contrôle avant déploiement comprend l'audit des prix de l'étape 0.3. Il rapproche aussi la caisse et
  chaque actif du registre. Il liste chaque ordre en attente et chaque stop, avec ce que le premier relevé en
  fera. Il signale enfin si le redémarrage lancera un cycle payé.

**Le résultat** classe chaque point en trois niveaux :
- **BLOQUANT** : une anomalie dans les données, par exemple une position invalide ou un registre qui ne tombe
  pas juste ;
- **À DÉCIDER** : ce que le redémarrage déclenchera, ou un écart historique. Par exemple un stop déjà
  franchi, un ordre refusé, expiré ou exécuté à un prix ancien, une position sans stop, ou un écart d'arrondi
  d'avant l'étape 0.3. Chaque point porte une **clé**, par exemple `stop-franchi:BTC` ;
- **INFO** : pour information seulement.

Avec `code=1`, le déploiement est bloqué : je te présente les points et tu décides.
- Pour un point « À DÉCIDER », ton GO de déploiement peut l'accepter **en nommant sa clé**. Le contrôle donne
  la ligne exacte à recopier : `--accepter-a-decider clé1,clé2`.
- Un point qui apparaîtrait ensuite, avec une autre clé, bloquera de nouveau : il faudra une nouvelle
  décision.
- Pour un point BLOQUANT, il faut d'abord une procédure de réparation séparée.

### Phase 2 — La fenêtre de déploiement (seulement après ton GO de déploiement)

**L'ordre est fait pour qu'aucune installation n'ait lieu avant une sauvegarde vérifiée.** Les outils de la
nouvelle version sont d'abord sortis dans un dossier à part, `/home/sonni/outils-deploiement`. Le dossier du
programme, `/opt/sonni`, ne change pas avant l'étape 8 : jusque-là, l'ancienne version reste intacte.

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
2. **Sors les outils dans un dossier à part.** Sonni tourne encore. `git fetch` télécharge la nouvelle
   version dans la réserve de Git sans toucher au programme en service :
   ```sh
   cd /opt/sonni
   sudo -u sonni -H git fetch origin
   sudo -u sonni -H git cat-file -e COMMIT^{commit} && echo "version trouvée"
   sudo -u sonni -H mkdir -m 700 /home/sonni/outils-deploiement
   sudo -u sonni -H sh -c 'git -C /opt/sonni archive COMMIT sonni/vps | tar -x -C /home/sonni/outils-deploiement'
   sudo -u sonni -H ln -s /opt/sonni/node_modules /home/sonni/outils-deploiement/node_modules
   ```
   La deuxième commande doit afficher `version trouvée`. Si `mkdir` dit que le dossier existe déjà (essai
   précédent), efface-le avec `rm -r /home/sonni/outils-deploiement` et refais ces trois dernières lignes.
   Les outils n'ont besoin que de la bibliothèque SQLite déjà installée pour Sonni : le lien `node_modules`
   la leur prête, sans rien installer.
3. **Vérifie que le serveur a ce que les outils demandent** (lecture seule) :
   ```sh
   cd /home/sonni/outils-deploiement
   sudo -u sonni -H node sonni/vps/verification-environnement.mjs
   ```
   Il contrôle la version de Node, la bibliothèque SQLite (la même que celle de Sonni), l'utilisateur, les
   droits de `~/.automaton` et la place libre. Il faut `code=0`. Sinon arrête-toi ici : Sonni tourne
   toujours, rien n'a changé.
4. **Arrête Sonni :**
   ```sh
   systemctl stop sonni
   systemctl is-active sonni
   ls -la /home/sonni/.automaton/state.db*
   ```
   La deuxième ligne doit afficher `inactive`. La troisième ne doit montrer que `state.db`. S'il reste un
   `state.db-wal` ou un `state.db-shm`, l'arrêt n'a pas été propre : arrête-toi et envoie-moi la sortie.
5. **Fais la sauvegarde**, avec les outils du dossier à part. Sonni est arrêté, donc c'est une copie exacte
   du fichier :
   ```sh
   cd /home/sonni/outils-deploiement
   sudo -u sonni -H node sonni/vps/sauvegarde.mjs
   ```
   Elle écrit dans `/home/sonni/.automaton/predeploiement/`, à côté de son empreinte `.sha256`. Ce dossier
   n'est jamais vidé par la rotation des sauvegardes quotidiennes. La dernière ligne donne `COPIE`.
6. **Fais l'essai de restauration** (dans un dossier temporaire), puis **le contrôle avant démarrage**,
   d'abord sans rien accepter :
   ```sh
   cd /home/sonni/outils-deploiement
   sudo -u sonni -H node sonni/vps/restauration.mjs --essai COPIE
   sudo -u sonni -H node sonni/vps/controle-predeploiement.mjs COPIE
   ```
   Si ton GO a accepté des points « À DÉCIDER », relance le contrôle en ajoutant `--accepter-a-decider`
   suivi des clés que ton GO nomme, et seulement celles-là. Un point dont la clé n'est pas dans ton GO bloque
   toujours, comme un point BLOQUANT : aucune option ne lève un point BLOQUANT.
7. **Si la sauvegarde, l'essai ou le contrôle ne finit pas par `code=0`, n'installe rien.** Pour le
   contrôle, c'est le dernier lancement qui compte, avec seulement les clés que ton GO accepte. Le programme n'a pas
   changé. Laisse Sonni arrêté et envoie-moi la sortie : la décision est la tienne. Redémarrer l'ancienne
   version ne se fait que par « Retour arrière » plus bas, pause vérifiée comprise (l'étape R5 est alors
   inutile).
8. **Seulement maintenant, installe exactement la version approuvée :**
   ```sh
   cd /opt/sonni
   sudo -u sonni -H git checkout main
   sudo -u sonni -H git merge --ff-only COMMIT
   sudo -u sonni -H git rev-parse HEAD
   sudo -u sonni -H pnpm install --frozen-lockfile
   sudo -u sonni -H pnpm run build
   ```
   `git rev-parse HEAD` doit afficher `COMMIT`.
   - Si `merge --ff-only` refuse, arrête-toi : le programme n'a pas changé. Laisse Sonni arrêté et
     envoie-moi la sortie.
   - Si `pnpm install` ou `pnpm run build` échoue, **ne démarre pas** : le programme compilé peut être à
     moitié neuf. Laisse Sonni arrêté et envoie-moi la sortie ; le retour à l'ancienne version passe par
     « Retour arrière ».

   Ne lance **pas** `configure.mjs` cette fois : aucun réglage ne change.
9. **Démarre :**
   ```sh
   date -u +%Y-%m-%dT%H:%M:%SZ | tee /root/sonni-demarrage.txt
   systemctl start sonni
   systemctl is-active sonni
   ```

Garde le dossier `/home/sonni/outils-deploiement` : un retour arrière en a besoin, car l'ancienne version n'a
pas ces outils. S'il a disparu, la Phase 2, étape 2, le recrée à l'identique.

### Phase 3 — Contrôles après démarrage et rapport Telegram

**Attends 10 à 15 minutes**, le temps d'une collecte de prix et d'un passage du courtier virtuel. Si ta
connexion s'est coupée, reconnecte-toi (étape 4), puis :
```sh
cd /opt/sonni
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

**Le rapport sur Telegram.** L'outil d'envoi lit le jeton du bot dans `/etc/sonni.env`, que seul `root`
peut lire. Il se lance donc en `root`, mais jamais depuis le dossier du programme, que l'utilisateur
`sonni` peut modifier. On en fait d'abord une copie à `root`, dont on vérifie l'empreinte :
```sh
cd /opt/sonni
install -o root -g root -m 0500 sonni/vps/envoi-telegram.mjs /root/envoi-telegram.mjs
sha256sum /root/envoi-telegram.mjs
```
L'empreinte affichée doit être exactement `EMPREINTE_ENVOI`. Sinon, n'envoie rien et préviens-moi. Puis :
```sh
cd /opt/sonni
sudo -u sonni -H node sonni/vps/controle-apres-demarrage.mjs --depuis "$(cat /root/sonni-demarrage.txt)" --commit-attendu COMMIT --resume | node /root/envoi-telegram.mjs
```
Si tu as utilisé `--ordres-acceptes` plus haut, ajoute-le aussi à cette ligne. La dernière ligne rappelle le
code du rapport (`rapport=code …`) : c'est lui qui compte, pas celui de l'envoi. S'il vaut `inconnu`, le
rapport est incomplet : relance le contrôle. Le jeton n'est jamais affiché.

**Sur ton téléphone**, envoie :
- `/statut` ;
- `/portefeuille`, où les résultats portent la mention « (après tous les frais) » ;
- `/technique`, où aucun incident « courtier virtuel » ne doit apparaître, sauf pour les ordres acceptés avec
  `--ordres-acceptes`.

**Déclencheurs de retour arrière.** Décide dans les 15 minutes, et le retour arrière se fait sur ton accord.
Les déclencheurs sont :
- le contrôle finit par `code=1` ;
- `systemctl is-active sonni` n'affiche pas `active`, ou Sonni redémarre en boucle (`systemctl status sonni`
  montre des redémarrages) ;
- un incident « courtier virtuel » dans `/technique`, hors ordres acceptés ;
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
nouvelle a écrit. C'est vérifié sur les deux bouts de la plage possible (4c015b0 et fd5916d), et la forme
de la base ne change pas entre les deux.

Ce que tu verras de nouveau avec l'ancienne version :
- les résultats sans les frais d'achat ;
- les prix sous 1 € arrondis au centime (« 0,00 € ») ;
- les refus du courtier virtuel en anglais.

**Attention.** L'ancienne version ramène aussi le défaut que l'étape 0.3 corrige : elle arrondit au centime
chaque exécution. Un achat à moins de 0,005 € redeviendrait une quantité infinie, et une vente sous 1 € serait
enregistrée à un prix faux. L'historique serait abîmé pour de bon. Elle ne démarre donc **qu'en pause, et une
pause vérifiée par un outil**, pas seulement demandée :
- la pause est gardée dans la mémoire de Sonni. L'ancienne version la respecte dès son démarrage : aucun
  cycle payé, donc aucun nouvel ordre ;
- mais son courtier virtuel continue de tourner pendant la pause : il exécute les ordres déjà en attente et
  déclenche les stops. L'outil `verifier-pause.mjs` refuse donc :
  - tout ordre d'achat en attente ;
  - toute vente qu'il ferait seul sous 1 € (vente en attente ou stop), sauf si ton GO nomme l'actif ;
  - tout actif sous 1 centime, sans exception ;
  - toute position sans prix ;
  - toute anomalie BLOQUANT du contrôle avant déploiement ;
- `/reprendre` lève la pause et relance un cycle payé : ne l'envoie pas tant que l'ancienne version tourne.

Les outils se lancent depuis `/home/sonni/outils-deploiement` (Phase 2, étape 2), car l'ancienne version ne
les a pas. Si ce dossier n'existe plus, refais d'abord la Phase 2, étape 2 : `COMMIT` reste dans la réserve
de Git, même après R5. Toutes les commandes ci-dessous attendent `code=0`. Pour tout autre code, laisse Sonni
arrêté et envoie-moi la sortie.

R1. **Si Sonni répond sur Telegram, envoie `/pause`**, pour qu'il ne place plus d'ordre pendant que tu
prépares le retour. Puis arrête-le :
```sh
systemctl stop sonni
systemctl is-active sonni
```
La deuxième ligne doit afficher `inactive`.

R2. **Restaurer la base, seulement en cas de corruption et seulement sur ta décision.** La restauration
efface tout ce que Sonni a écrit après `COPIE` : journal, prédictions, ordres et dépenses d'IA déjà
comptées. Elle se fait avant tout le reste :
```sh
cd /home/sonni/outils-deploiement
sudo -u sonni -H node sonni/vps/restauration.mjs --restaurer COPIE --confirmer
```
L'outil vérifie l'empreinte et refuse tant que Sonni tourne. Il ne supprime rien : l'ancienne base et ses
fichiers `-wal`/`-shm` partent dans un dossier `quarantaine-…` à côté. La base restaurée a la pause de
`COPIE`, pas celle de R1 : l'étape R3 la remet.

R3. **Enregistre la pause dans la base**, avec la version encore installée. La commande existe dans toutes les
versions possibles. Sonni est arrêté, cela ne lance aucun cycle :
```sh
cd /opt/sonni
sudo -u sonni -H node dist/index.js --money-lab pause "retour arrière"
```
Si la pause existait déjà (`/pause` de R1), la commande la garde telle quelle. Si cette commande échoue
parce que la compilation de la Phase 2 a échoué, fais d'abord R5, puis reviens à R3 et R4.

R4. **Vérifie la pause sur une copie fraîche** (avant R5, tant que la version installée n'a pas changé) :
```sh
cd /home/sonni/outils-deploiement
sudo -u sonni -H node sonni/vps/sauvegarde.mjs
sudo -u sonni -H node sonni/vps/verifier-pause.mjs --copie COPIE_RETOUR
```
`COPIE_RETOUR` est le chemin qu'affiche cette nouvelle sauvegarde. Une copie plus ancienne que la base,
comme la sauvegarde du jour ou `COPIE`, est refusée. Il faut `code=0`. Sinon **ne reviens pas en arrière** :
- « aucune pause enregistrée » : refais R3, puis R4 ;
- « vente-arrondie:ACTIF » : une vente sous 1 € que l'ancienne version arrondirait au centime. L'outil donne
  la part de la valeur en jeu. Si ton GO de retour arrière l'accepte en nommant l'actif, relance avec
  `--accepter-arrondi ACTIF1,ACTIF2` (les actifs que ton GO nomme, et seulement ceux-là) ;
- « ordre(s) d'achat en attente » : l'ancienne version les exécuterait. Chaque ordre est listé avec son
  échéance. Regarde d'abord quelle version est installée :
  ```sh
  sudo -u sonni -H git -C /opt/sonni rev-parse HEAD
  ```
  - si la ligne affiche exactement `COMMIT`, la nouvelle version est installée. Au choix : redémarre-la,
    toujours en pause (`systemctl start sonni`), jusqu'à l'exécution ou l'échéance de ces ordres, puis
    reprends à R1 ; ou laisse Sonni arrêté et envoie-moi la sortie ;
  - sinon (l'ancienne version est installée : Phase 2 arrêtée avant l'étape 8, ou R5 déjà fait), **ne
    démarre pas** : laisse Sonni arrêté et envoie-moi la sortie.

  Aucune version n'a de commande pour annuler un ordre à ta place : en ajouter une serait un changement
  séparé, à ta demande ;
- « sous 1 centime », « sans aucun prix » ou « BLOQUANT » : laisse Sonni arrêté et envoie-moi la sortie. Aucune
  version ne redémarre sur ces données avant une réparation séparée, que tu décides.

R5. **Reviens à l'ancienne version du programme.** C'est inutile si l'installation de la Phase 2, étape 8,
n'a pas eu lieu. La base ne change pas pendant cette étape, donc la vérification R4 reste valable :
```sh
cd /opt/sonni
sudo -u sonni -H git checkout --detach "$(cat /root/sonni-commit-avant.txt)"
sudo -u sonni -H git rev-parse HEAD
cat /root/sonni-commit-avant.txt
sudo -u sonni -H pnpm install --frozen-lockfile
sudo -u sonni -H pnpm run build
```
Les deux lignes affichées par `git rev-parse HEAD` et `cat` doivent être identiques. Sinon, ou si
l'installation ou la compilation échoue, ne démarre pas et envoie-moi la sortie.

R6. **Démarre l'ancienne version et vérifie-la en marche :**
```sh
date -u +%Y-%m-%dT%H:%M:%SZ | tee /root/sonni-retour.txt
systemctl start sonni
systemctl is-active sonni
journalctl -u sonni -n 80 --no-pager
```
Attends 10 à 15 minutes, le temps d'un relevé de prix et d'un passage du courtier virtuel, puis :
```sh
cd /home/sonni/outils-deploiement
sudo -u sonni -H node sonni/vps/verifier-pause.mjs --en-marche --depuis "$(cat /root/sonni-retour.txt)"
```
Ajoute le même `--accepter-arrondi` qu'en R4 s'il y en avait un. L'outil lit la base en marche sans rien
écrire. S'il ne finit pas par `code=0`, **arrête Sonni tout de suite** (`systemctl stop sonni`) et envoie-moi
la sortie. Ce peut être une pause levée, un achat ou une vente sous 1 € non acceptée depuis le démarrage.
Relance la même vérification le lendemain. Envoie aussi `/statut`, `/portefeuille` et `/technique` sur
Telegram, puis envoie-moi le résultat.

## Arrêter Sonni

1. Telegram : `/pause fin` (plus aucune dépense d'inférence).
2. Serveur : `systemctl stop sonni` puis `systemctl disable sonni`.
3. Sauvegarde (sa mémoire) : `cd /opt/sonni && sudo -u sonni -H node sonni/vps/sauvegarde.mjs`. Elle
   écrit une copie vérifiée, avec son empreinte, dans `/home/sonni/.automaton/predeploiement/`.
   Si l'outil n'existe pas (une version d'avant le déploiement contrôlé), Sonni étant arrêté : vérifie
   avec `ls -la /home/sonni/.automaton/state.db*` qu'il n'y a ni `-wal` ni `-shm`, puis lance
   `cp -p /home/sonni/.automaton/state.db /root/sonni-state.db` et `sha256sum /root/sonni-state.db`.
   Télécharge ensuite la copie chez toi. Si ton PC suit la partie 6 de `sonni/GUIDE-PC.fr.md`, il en
   garde déjà une par nuit dans `C:\Sonni\sauvegardes`.
4. **La pause n'arrête pas les factures** : supprime le VPS chez l'hébergeur quand tu n'en as plus besoin.

## Limites à connaître

- Phase virtuelle : aucun argent réel, aucune clé de plateforme sur ce serveur. Ne mets **jamais** une
  clé de trading sur ce serveur sans qu'on ait préparé ensemble la phase réelle.
- Les plafonds de dépense sont appliqués dans le programme ; une commande shell détournée pourrait les
  contourner. Ta vraie protection est la limite de l'espace `Sonni` chez Anthropic.
- Le budget est lissé par un plafond quotidien (1/30 du mois) ; le lissage exact sur le mois viendra
  dans une prochaine étape.
- Sonni s'arrête quand son solde passe sous zéro, jusqu'à ce que tu ajoutes le budget suivant.
