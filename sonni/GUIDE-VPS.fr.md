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
| `/memoire <sujet>` | ce qu'il sait sur un sujet (dossiers, intuitions, journal, leçons, pièges, tes notes, ses ordres) |
| `/cycles` | réactions mesurées par le code autour des événements (Fed, inflation, emploi) et cycles nommés par Sonni, avec leur verdict |
| `/carnets` | écrire ses carnets Markdown dans `/home/sonni/carnet/` (aussi chaque dimanche) ; lis-les avec `sudo -u sonni cat /home/sonni/carnet/btc.md` |
| `/technique` | état technique du programme (budget détaillé, pauses, cycles) et les incidents des 7 derniers jours (ce que le programme a fait seul : pause, plafond, erreurs, sauvegarde) |
| `/idee <texte>` | lui donner une intuition à tester |
| `/intuitions` | ses intuitions, avec les preuves pour et contre, sa confiance calculée et le verdict de l'historique |
| `/agenda` | les événements des 30 prochains jours (Fed, et inflation et emploi avec la clé FRED) |
| `/bilan` | sa calibration et ses scores, calculés par le code |
| `/identite [texte]` | l'identité qu'il s'est écrite, et ses versions précédentes ; avec un texte, ta version (il doit y garder « Je suis Sonni ») |
| `/journal [n]` | ses n dernières réflexions (post-mortems, notes de séance, revue) |
| `/lecons` / `/veto <id> [raison]` | ses leçons ; en retirer une |
| `/reveils` | ses réveils spontanés et les déclencheurs notés |
| `/lecteurs` | l'état des IA lectrices gratuites (voir plus bas) |
| `/sources` / `/source ok\|non <id>` | ses sources de données ; accepter ou refuser une source qu'il propose |
| `/actifs` | les actifs qu'il suit et ses changements motivés |
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

## Mettre Sonni à jour

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
Toutes les étapes sont fusionnées dans `main` depuis le 7 octobre : la ligne `git checkout main`
ramène un serveur installé sur une branche d'étape (`claude/sonni-alive`) sur `main`, sans effet si tu y
es déjà. `git status` doit ensuite afficher `On branch main`.
La ligne `configure.mjs` réécrit la configuration avec les nouveaux réglages (sources, lecteurs,
réveils) en gardant tes valeurs ; elle ne touche pas aux clés ni à sa mémoire. Lance-la bien avec
`sudo -u sonni -H` (en root seul, elle écrit un fichier que Sonni ne lit pas, et le dit). Elle doit
afficher la ligne « IA lectrices (gratuites, facultatives) : gemini …, groq … » et « Mise à jour » ;
**ne rajoute pas de budget** à ce moment-là, celui du mois est déjà enregistré. Sans elle, `/lecteurs`
répond « Aucune IA lectrice configurée ». Ses prix, prédictions,
intuitions, journal et identité sont conservés. La pause (`/pause`) aussi : relance avec
`/reprendre`.

## Arrêter Sonni

1. Telegram : `/pause fin` (plus aucune dépense d'inférence).
2. Serveur : `systemctl stop sonni` puis `systemctl disable sonni`.
3. Sauvegarde (sa mémoire) : `cp /home/sonni/.automaton/state.db /root/sonni-state.db`, puis
   télécharge-la chez toi.
4. **La pause n'arrête pas les factures** : supprime le VPS chez l'hébergeur quand tu n'en as plus besoin.

## Limites à connaître

- Phase virtuelle : aucun argent réel, aucune clé de plateforme sur ce serveur. Ne mets **jamais** une
  clé de trading sur ce serveur sans qu'on ait préparé ensemble la phase réelle.
- Les plafonds de dépense sont appliqués dans le programme ; une commande shell détournée pourrait les
  contourner. Ta vraie protection est la limite de l'espace `Sonni` chez Anthropic.
- Le budget est lissé par un plafond quotidien (1/30 du mois) ; le lissage exact sur le mois viendra
  dans une prochaine étape.
- Sonni s'arrête quand son solde passe sous zéro, jusqu'à ce que tu ajoutes le budget suivant.
