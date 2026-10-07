# Lancer Money Lab sur un serveur (VPS) — guide pas à pas

Guide opérateur (en français). Aucune étape ne doit être faite par le bot lui-même.
Les prix et menus des sites cités changent : vérifie-les au moment de t'inscrire.

**Ce qu'il te faut :** une carte bancaire, environ 20 €, ton téléphone avec Telegram, un ordinateur.

> Pour toutes les commandes : copie-colle une ligne, appuie sur **Entrée**, attends la fin avant la
> suivante. Si une ligne affiche une erreur en rouge, arrête-toi et envoie le message (sans clé ni mot de passe).

---

## Étape 1 — Le « cerveau » : compte Anthropic

1. Va sur https://console.anthropic.com et crée un compte.
2. **Billing / Facturation** : ajoute des crédits (par exemple 15 $).
3. **Limits / Limites** : fixe une limite de dépense mensuelle (par exemple 15 $). C'est ta protection
   ultime : même en cas de bug, Anthropic ne facturera pas au-delà.
4. **API Keys** : crée une clé. Elle commence par `sk-ant-`. Copie-la dans un endroit sûr
   (tu ne pourras plus la revoir). **Ne la donne à personne, ni dans un chat.**

## Étape 2 — Ton canal : Telegram

1. Dans Telegram, cherche **@BotFather**, envoie `/newbot`, choisis un nom (ex : `Money Lab de Malik`)
   et un identifiant finissant par `bot`. BotFather te donne un **token** : garde-le secret.
2. Cherche **@userinfobot**, envoie-lui un message : il te répond ton **Id** (un nombre). C'est ton
   « chat id ».
3. Ouvre la conversation avec **ton** nouveau bot et appuie sur **Démarrer** (sinon il ne pourra pas t'écrire).

## Étape 3 — Les revenus : Stripe (tu peux le faire plus tard)

1. Crée un compte sur https://stripe.com (vérification d'identité demandée par Stripe).
2. **Développeurs → Clés API → Créer une clé restreinte** : donne uniquement l'accès en **lecture** au
   **solde / transactions du solde (Balance)**. La clé commence par `rk_`.
3. Pas encore prêt ? Saute cette étape et ajoute `--no-stripe` à l'étape 7.

## Étape 4 — Louer le serveur (VPS)

1. Chez un hébergeur (Hetzner, OVH, Scaleway…), loue le plus petit VPS avec **Ubuntu 24.04**
   et **au moins 2 Go de mémoire**. Note son **adresse IP** et son **mot de passe root** (ou ta clé SSH).
2. Note aussi son **prix mensuel** : il compte dans les dépenses du bot (étape 7).

## Étape 5 — Se connecter au serveur

Sur ton ordinateur, ouvre **Terminal** (Mac) ou **PowerShell** (Windows), puis :
```sh
ssh root@ADRESSE_IP
```
Tape `yes` si on te le demande, puis le mot de passe. Tu es « dans » le serveur.

## Étape 6 — Préparer et installer

Colle ces blocs l'un après l'autre :
```sh
apt update && apt -y upgrade
apt -y install git curl ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node --version
```
La dernière ligne doit afficher `v22…`.

```sh
ufw allow OpenSSH && ufw --force enable
useradd --create-home --shell /bin/bash moneylab
git clone https://github.com/Cloied/Money-lab /opt/money-lab
chown -R moneylab:moneylab /opt/money-lab
corepack enable pnpm
cd /opt/money-lab
sudo -u moneylab -H pnpm install --frozen-lockfile
sudo -u moneylab -H pnpm run build
```

## Étape 7 — Configurer

Remplace `123456789` par ton chat id (étape 2), `6` par le prix mensuel du VPS en dollars,
`1.08` par le taux euro→dollar du jour (cherche « EUR USD » sur internet) et `2` par le budget
d'inférence maximum par jour en dollars :
```sh
cd /opt/money-lab
sudo -u moneylab -H node money-lab/vps/configure.mjs --chat-id 123456789 --vps-cost-per-month 6 --eur-usd 1.08 --daily-budget 2
```
Tu dois voir `Configuration Money Lab écrite`.

Ensuite, le fichier des secrets (lisible uniquement par l'administrateur, **pas par le bot**) :
```sh
cp money-lab/vps/money-lab.env.example /etc/money-lab.env
chown root:root /etc/money-lab.env && chmod 600 /etc/money-lab.env
nano /etc/money-lab.env
```
Dans l'éditeur, remplace les `REPLACE_ME` par ta clé Anthropic, ton token Telegram et ta clé Stripe
(ou laisse `STRIPE_API_KEY=` vide). Enregistre avec **Ctrl+O**, **Entrée**, puis quitte avec **Ctrl+X**.

## Étape 8 — Donner son budget au bot

Le solde du bot = ce que tu lui donnes. Mets le même montant que tes crédits Anthropic, en **centimes
de dollar** (15 $ → `1500`) :
```sh
sudo -u moneylab -H node dist/index.js --money-lab ledger-add owner_funding 1500 depot-initial
sudo -u moneylab -H node dist/index.js --money-lab status
```
Le statut doit montrer **Solde : 15.00 USD**. Plus tard, tu pourras ajouter des fonds depuis Telegram
avec `/fonds 10`.

## Étape 9 — Démarrer le bot (24 h/24)

```sh
cp money-lab/vps/money-lab.service /etc/systemd/system/money-lab.service
systemctl daemon-reload
systemctl enable --now money-lab
journalctl -u money-lab -f
```
La dernière commande affiche ce que fait le bot en direct (**Ctrl+C** pour arrêter de regarder ; le bot
continue). Il redémarre tout seul en cas de plantage ou de redémarrage du serveur.

## Étape 10 — Lui parler sur Telegram

Envoie `/aide` à ton bot. Commandes principales :

| Commande | Effet |
| --- | --- |
| `/statut` | solde, jours restants, expériences, demandes, finances |
| `/sante` | rapport de santé : verdict (✅ tout va bien, ⚠️ à surveiller, 🚨 problème), activité et erreurs des dernières 24 h, dépense, idées, disque, sauvegarde. Envoyé aussi automatiquement chaque matin (vers 9 h l'été, 8 h l'hiver) |
| `/resume` | résumé détaillé (budget, expériences, finances) |
| `/aides` | ce que le bot te demande |
| `/ok <id> [note]` / `/non <id> [raison]` | répondre à une demande |
| `/fonds 10` | ajouter 10 $ à son solde (ajoute aussi les crédits sur Anthropic !) |
| `/revenu 12 vente-1` | confirmer un revenu hors Stripe |
| `/pause [raison]` / `/reprendre` | arrêter / relancer ses dépenses |
| tout autre message | transmis au bot comme une conversation |

## Mettre à jour le bot

Quand une correction est publiée sur GitHub :
```sh
cd /opt/money-lab
sudo -u moneylab -H git pull
sudo -u moneylab -H pnpm install --frozen-lockfile
sudo -u moneylab -H pnpm run build
systemctl restart money-lab
```
La pause (`/pause`) est conservée après le redémarrage : relance avec `/reprendre` quand tu es prêt.

**Une seule fois** (mise à jour d'octobre 2026, protection des clés) : installe le nouveau fichier de
service, qui démarre le programme puis le fait passer aussitôt sous l'utilisateur `moneylab`. Ainsi
les commandes du bot ne peuvent plus lire la clé Anthropic ni le jeton Telegram dans la mémoire du
programme :
```sh
cp /opt/money-lab/money-lab/vps/money-lab.service /etc/systemd/system/money-lab.service
systemctl daemon-reload
systemctl restart money-lab
ps -o user= -p $(systemctl show -p MainPID --value money-lab)
```
La dernière commande doit afficher `moneylab`. Tant que ce n'est pas fait, le bot t'envoie chaque
jour « 🔐 Protection des clés inactive » sur Telegram.

## Lui écrire

Tout message Telegram qui n'est pas une commande lui est transmis comme venant de toi et le réveille
(compte jusqu'à environ 40 secondes). Quand il n'a rien à faire, il dort 15 minutes entre deux réveils.
Ses serveurs s'arrêtent à chaque redémarrage du service : il les relance via `~/autostart.sh`.

## Quand le bot veut publier un site

Rien de ce que le bot lance n'est visible sur internet tant que tu ne l'ouvres pas. S'il te le demande
(par exemple pour le port 8080) et que tu es d'accord :
```sh
ufw allow 8080/tcp
```
Le site sera alors visible à `http://ADRESSE_IP:8080`. Pour le refermer : `ufw delete allow 8080/tcp`.

## Donner des mains et des yeux au bot

Ces accès le rendent autonome : il publie, lit ses statistiques, regarde ses pages et cherche sur le web.

1. **Outils sur le serveur** (en root) :
   ```sh
   apt -y install gh poppler-utils
   wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
   apt -y install ./google-chrome-stable_current_amd64.deb && rm google-chrome-stable_current_amd64.deb
   ```
2. **Son organisation GitHub** : sur github.com, « + » → *New organization* → plan *Free*, à ton nom.
   Transfère-y ses dépôts (*Settings → Transfer*). Puis *Settings → Developer settings → Fine-grained
   tokens → Generate* : *Resource owner* = l'organisation, *All repositories*, permissions
   *Administration*, *Contents*, *Pages* en *Read and write*, expiration 90 jours.
3. **GoatCounter** : *Settings → API* → nouveau jeton avec *Read statistics* uniquement.
4. Ajoute dans `/etc/money-lab.env` (`nano /etc/money-lab.env`) : `GH_TOKEN=…`, `GITHUB_ORG=…`,
   `GOATCOUNTER_SITE=…`, `GOATCOUNTER_TOKEN=…`, puis `systemctl restart money-lab`.

Ces deux jetons sont **lisibles par le bot** (c'est voulu) : limite-les comme indiqué. Le pire qu'il
puisse faire avec, c'est modifier ses propres dépôts ou lire ses propres statistiques.

5. **Google Search Console** (facultatif, lecture seule) : sur https://console.cloud.google.com, crée un
   projet, active l'API *Google Search Console API*, puis *IAM → Comptes de service → Créer* (aucun
   rôle) → onglet *Clés* → *Ajouter une clé → JSON* (un fichier se télécharge). Dans Search Console,
   *Paramètres → Utilisateurs et autorisations → Ajouter* : l'adresse du compte de service
   (`...@...iam.gserviceaccount.com`), autorisation *Restreint*. Copie le fichier sur le serveur sans
   l'afficher : `scp fichier.json root@IP:/home/moneylab/.automaton/gsc-key.json`, puis en root
   `chown moneylab: /home/moneylab/.automaton/gsc-key.json && chmod 600 /home/moneylab/.automaton/gsc-key.json`.
   Ajoute `GSC_SITE=https://ton-site/` (l'adresse exacte de la propriété) dans `/etc/money-lab.env` et
   redémarre. Ce fichier est protégé : le bot ne peut pas le lire avec ses outils, seul le programme s'en sert.

6. **Bluesky** (quand le bot aura quelque chose à montrer) : crée un compte sur https://bsky.app avec une
   adresse e-mail à toi, puis *Paramètres → Confidentialité et sécurité → Mots de passe d'application →
   Ajouter*. Mets dans `/etc/money-lab.env` : `BLUESKY_HANDLE=ton-compte.bsky.social` et
   `BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx`, puis redémarre. Le bot ne voit pas ce mot de passe. Chaque
   publication t'arrive sur Telegram : `/publier <id>` ou `/rejeter <id> [raison]`.
7. **Nom de domaine** (quand le bot le demande) : achète le nom qu'il propose chez OVH (*Noms de domaine →
   Commander*), puis dans *Zone DNS* ajoute les enregistrements qu'il t'indique (4 lignes A vers
   185.199.108.153 à 185.199.111.153, et `www` en CNAME vers son organisation GitHub). Réponds `/ok <id>`
   à sa demande : il termine la configuration lui-même.

La recherche web (outils Anthropic) est active d'office : environ 1 centime par recherche, compté dans
son budget.

## Tes interventions

Pour gagner de l'argent, le bot te demandera (via `request_help`) : un nom de domaine (domaine
personnalisé GitHub Pages), l'inscription à un programme d'affiliation, une régie publicitaire ou un
lien de paiement Stripe. Pour que les ventes Stripe soient comptées automatiquement, refais l'étape 3
puis relance la configuration (étape 7) sans `--no-stripe`.

Outils gratuits ou économiques à sa disposition : `delegate` (confie lectures et résumés à Claude
Haiku, deux fois moins cher), `schedule_job` (tâches automatiques sans frais, qui ne le réveillent
qu'en cas de problème ou de changement, au plus une fois par heure), `recall` (recherche dans ses
notes), `audit_page` (notes Lighthouse de ses pages) et `ab_test` (tests A/B sans cookies).

Le bilan hebdomadaire utilise Claude Opus 5.5 (plus fort, environ deux fois plus cher) pour ses
4 premiers tours, puis revient à Sonnet ; il reste soumis aux mêmes plafonds.

Le bot travaille seul. Il te sollicite seulement pour : créer des comptes à ton nom (hébergement,
Stripe, domaine, réseaux publicitaires), payer, confirmer les revenus hors Stripe et tout ce qui est
juridique (CGU, fiscalité). Il ne peut pas se répliquer, modifier son propre code ni lire tes clés.

## Arrêter le bot

1. Telegram : `/pause fin` (plus aucune dépense d'inférence).
2. Serveur : `systemctl stop money-lab` puis `systemctl disable money-lab`.
3. Sauvegarde (avant de supprimer quoi que ce soit) :
   `cp /home/moneylab/.automaton/state.db /root/sauvegarde-state.db`, puis télécharge-la chez toi.
4. **La pause n'arrête pas les factures** : supprime le VPS chez l'hébergeur, et tout service que tu as
   créé pour le bot, quand tu n'en as plus besoin.

## Limites à connaître

- Les plafonds sont appliqués dans le programme ; une commande shell détournée pourrait les contourner
  (le bot possède ses propres fichiers de configuration et de comptabilité). Les clés, elles, sont
  hors de portée de ses commandes avec le fichier de service actuel. Ta vraie protection reste la
  limite de dépense chez Anthropic et ce que tu mets sur le compte.
- Le bot meurt quand son solde passe sous zéro ; il revit si tu ajoutes des fonds ou si un revenu
  confirmé arrive.
