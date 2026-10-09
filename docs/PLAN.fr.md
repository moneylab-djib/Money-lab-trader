# Sonni — plan pour le propriétaire

Résumé en français de la spécification (les documents techniques sont en anglais : `PROJECT.md`,
`ARCHITECTURE.md`, `docs/MEMORY.md`). État au 8 octobre 2026 : **étapes 1 à 4 (C1, C2, C3)
construites et vérifiées avec de fausses API**, garde-fous G1 à G16 en place ; Sonni tourne sur son VPS
depuis le 6 octobre. Les quatre étapes du plan du 8 octobre (ci-dessous) sont construites, fusionnées et
en service depuis le 8 octobre (PR #21 à #23 ; corrections du second cerveau #25, #26 et #28) ; le second
cerveau tourne sur ton PC depuis le 8 octobre. Aucun compte créé par Sonni, aucun argent réel engagé.

## Le plan du 8 octobre (ton accord du jour ; décision 0005)

Constats du 7 octobre : Sonni n'a pas touché à ses 1 000 € virtuels (rien ne l'obligeait à choisir et
rester en cash ne lui coûtait rien), il a écrit « marge ~27 % » au lieu de 2,7 %, et BTC et ETH bougent
presque ensemble (il apprend deux fois la même chose). Quatre étapes, une PR chacune, avec observation
sur le VPS entre deux étapes :

1. **Décider vraiment** (fusionné avec l'étape 2, PR #21 ; en service) : une décision par actif suivi au moins toutes les 8 heures
   (acheter, renforcer, garder, alléger, vendre ou rester en dehors, avec sa raison) que le code note à
   24 h et à 7 jours, rester en dehors compris, sans achat forcé ; avant chaque pari, la « fiche » du
   code (écart au seuil en % et en volatilité, probabilité de référence) gardée avec le pari ; un achat
   de 20 % du portefeuille ou plus est réexaminé par Opus avant d'être passé (tant qu'Opus n'a pas
   déjà dépensé la moitié du plafond du jour ; sinon l'ordre passe avec une mention) ; dans `/bilan`, le tableau « Est-ce qu'il apprend ? » (justesse face à
   la référence, tendance, décisions, leçons) et ton rituel de 5 minutes par semaine.
2. **Univers vivant** (fusionné, PR #21 ; en service) : ton socle passe à six actifs, BTC, ETH, l'or
   (PAXG), le dollar face à l'euro (USDC), les actions américaines (SPY, via l'action tokenisée SPYx de
   Kraken) et Nvidia (NVDA, via NVDAx) ; ces deux dernières sont cotées en dollars et le code convertit
   tout en euros avec le taux EUR/USD de Kraken. Sonni ajoute au plus 3 « places tournantes » (une paire
   Kraken en euros ou une autre action tokenisée, au moins 250 000 € échangés par jour, gardée 3 jours au
   moins, pas reprise dans les 7 jours après l'avoir lâchée). Chaque semaine, le code passe au crible
   les paires Kraken liquides qu'il ne suit pas (tendance, élan, volatilité, corrélation avec ce qu'il
   suit) et lui montre d'abord les plus différentes. Toi : `/actifs` (socle, places tournantes, crible)
   et `/actifs non <symbole>` pour retirer une place tournante (il ne pourra pas la reprendre pendant
   30 jours). Le socle ne se retire que par la configuration.
3. **Second cerveau sur ton PC** (RX 9070 XT ; fusionné, PR #22 ; corrections du premier vrai jour PR #25 et
   #26, `/cerveau recompter` PR #28 ; en service sur ton PC depuis le 8 octobre ; guide pas à pas
   `sonni/GUIDE-PC.fr.md`, scripts du PC testés) : un modèle local (Qwen3.6-35B-A3B, confirmé sur 50 vraies
   tâches avant d'être figé ; gpt-oss-20b en secours) joint par le VPS via Tailscale, sans port ouvert.
   Modes commandés par toi (`/cerveau`) : arrêt, **assistant (par défaut)**, parallèle, délégué (seulement
   sur preuves et sur ta décision). En assistant (en service) : lecture des titres et des pages en premier
   (avant Gemini et Groq), tri de l'actualité, note de situation avant les réveils de Claude, avocat du
   diable sur chaque position ouverte une fois par jour, faits préparés pour ses autopsies, `/question`
   sans réveiller Claude, et une copie vérifiée de la mémoire sur ton PC chaque nuit. Ajoutés ensuite
   (PR suivante, en attente de ta fusion) : le **contrôle des chiffres** (ton PC relit chaque texte de
   Sonni qui cite un chiffre et montre où il cite un chiffre du code ; le code compare lui-même et ne
   garde que les grosses erreurs, comme « marge ~27 % » au lieu de 2,7 % ; Sonni les voit 48 h dans sa
   mémoire et donne le bon chiffre dans sa note du soir ; la nuit, ton PC relit aussi les anciens textes)
   et l'**entretien de la mémoire la nuit** (dès 1 h, ou dès que ton PC répond avant 19 h : leçons en
   double, leçons qui se contredisent, leçons appuyées sur une intuition que le code réfute ; de simples
   propositions que le code vérifie, rien n'est changé automatiquement ; Sonni en suit une au plus, à
   l'autopsie du soir ou à la revue du dimanche) ; tous deux mesurés dans `/cerveau`, sans réveil payé. Il ne passe jamais d'ordre et ses textes restent des
   données non fiables. Coupé en plein travail : rien n'est perdu (file d'attente sur le VPS, tâches
   reprises, réponses incomplètes jetées, Claude n'attend jamais) et Sonni continue sans lui. Son coût
   (électricité) n'est pas compté dans les 50 € (ton choix). `/cerveau` montre le modèle que ton PC fait
   vraiment tourner et le déclare « confirmé » après 50 tâches réussies avec moins d'un échec sur 10
   (seules ses mauvaises réponses comptent ; une coupure du PC ne compte pas ; `/cerveau recompter` fait
   repartir ce compteur de zéro, de façon visible, sans rien effacer) ;
   si tu changes de modèle, ses scores repartent de zéro (jamais de mélange). La copie de chaque nuit
   passe par un compte en lecture seule sur le serveur, joignable seulement par Tailscale, et ton PC
   vérifie son empreinte avant de la garder (30 jours).
4. **Mémoire v2** (fusionnée, PR #23 ; en service) : trois niveaux. Le vital toujours
   présent (son identité, ses leçons avec le régime de marché où il les a apprises, ses règles) ; le
   « à portée » choisi par le code à chaque réveil (son dossier du moment, et maintenant, pour chaque
   actif, le régime du marché et les 5 journées passées qui ressemblent le plus à aujourd'hui avec ce qui
   a suivi, en ne regardant que des journées dont la semaine suivante est connue) ; les archives, qu'il
   fouille avec un nouvel outil gratuit (`search_memory`) : recherche plein texte dans tout ce qu'il a
   écrit et lu, sans accents ni majuscules, pluriels compris, classée par pertinence, fraîcheur et
   importance, filtrable par actif, période et type, avec la provenance de chaque résultat. Tes
   `/memoire` et `/question` utilisent la même recherche. Ses leçons deviennent des fiches suivies par le
   code : quand une prédiction ou une décision s'appuie sur une leçon, il la cite, et le code compte
   ensuite si elle a aidé ou nui ; une leçon que les faits contredisent souvent est signalée
   (« ⚠ les faits la contredisent » dans `/lecons`) et il doit la retirer ou se justifier. Le code écrit
   aussi un résumé de chaque journée, semaine et mois terminés (faits et chiffres, reliés à leurs
   sources), cherchable ensuite. Mesuré sur un jeu de 16 questions : la bonne réponse est dans les 3
   premiers résultats 16 fois sur 16, contre 11 avec l'ancienne recherche ; les reformulations (autres
   mots, autre langue) restent hors de portée (0 sur 3) : la recherche « par le sens » n'est construite
   que si l'usage montre qu'elle manque.

## Ce qu'on construit

Un apprenti courtier : un agent Claude qui s'entraîne sur un portefeuille **virtuel** (crypto,
actions, ETF), lit l'actualité, fait des paris fictifs et apprend de ses résultats. Sa mémoire est le
cœur du projet. Plus tard, s'il a fait ses preuves et si tu le décides, il investira ton épargne
mensuelle (environ 50 €/mois).

Ce qu'il ne fait pas : pas d'argent réel, pas de clé de plateforme, pas d'effet de levier, pas de
mécanisme de survie, pas de comparaison avec un investisseur passif (tes décisions du 6 octobre).

## Sa mémoire, en une phrase par carnet

- **Journal** : chaque prédiction et chaque trade virtuel, écrits avant le résultat, impossibles à
  modifier ensuite.
- **Événements et réactions** : ce qui s'est passé (décision de la Fed, inflation, résultats…) et
  comment les prix ont réagi, mesuré par le code.
- **Cycles** : les réactions qui se répètent, avec leurs statistiques.
- **Pièges** : les erreurs qu'il a commises, nommées, avec leur coût.
- **Intuitions** : ses hypothèses, avec une confiance calculée par le code à partir des preuves.
- **Leçons** : les règles qu'il relit avant chaque décision ; tu peux en retirer une avec `/veto`.

**Utiliser ce que Claude sait déjà** : dès que sa mémoire est en place (étape 5), il écrit ce qu'il croit savoir des
marchés sous forme d'intuitions à tester. Le code les vérifie sur l'historique des prix quand c'est
possible, puis sur les vrais marchés à partir d'aujourd'hui. Ses connaissances deviennent ainsi un
savoir vérifié, sans tricher avec sa mémoire du passé.

## Son rythme

| Quand | Quoi | Modèle |
| --- | --- | --- |
| Toutes les heures | Lit l'actualité et note ce qui compte | IA lectrices gratuites (Gemini, Groq) ; sans clé, il lit les titres lui-même |
| Toutes les 5 minutes | Relève les prix, mesure les réactions | aucun (code) |
| ~3 fois par jour + mouvements forts | Prend ses décisions virtuelles | Sonnet 5.5 |
| Après chaque texte de Sonni | Contrôle des chiffres (le code juge) | second cerveau (ton PC) + code, gratuit |
| La nuit, dès 1 h | Entretien des leçons (propositions), relecture des anciens textes | second cerveau (ton PC), gratuit |
| Chaque soir à 19 h 30 | Autopsie de la journée (post-mortems, pièges, dossiers, note du jour) | Sonnet 5.5 |
| Chaque dimanche | Grande revue, mise à jour de la mémoire, **rapport hebdo sur Telegram** | Opus 5.5 |

## Budget : 50 €/mois (Claude + données payantes)

| Usage | Part | Environ |
| --- | --- | --- |
| Lecture de l'actualité | 30 % | 15 € |
| Décisions | 40 % | 20 € |
| Autopsies et revue hebdo | 20 % | 10 € |
| Réserve pour les jours agités | 10 % | 5 € |

Ce sont des estimations, à corriger après deux semaines de mesures. Il peut tout dépenser, mais à un
rythme lissé sur le mois. Garde-fou : une clé API Anthropic dédiée, avec une limite de dépense
mensuelle que tu fixes dans la console Anthropic.

**Mesuré le 7 octobre, corrigé le 8** : treize redémarrages ont coûté environ 0,96 $ (chacun
réveillait Sonni), et le plafond du jour, atteint l'après-midi, a empêché l'autopsie du soir. Depuis :
un redémarrage pendant son sommeil ne le réveille plus (sauf si tu lui as écrit) ; 0,40 $ du plafond
sont gardés pour l'autopsie du soir (tes messages passent quand même) ; tout réveil après 19 h 30
devient l'autopsie si elle n'est pas faite ; il ne reçoit plus les outils inutiles hérités de Money
Lab et n'emporte plus que ses 8 à 11 derniers tours (l'historique faisait 70 % de chaque appel).

**Données** (ta réponse du 6 octobre) : il utilise d'abord les sources gratuites. S'il juge qu'une
source payante vaut le coup, il te la propose avec son coût et son usage prévu ; c'est toi qui
t'abonnes (il ne crée jamais de compte), et l'abonnement est pris sur ses 50 €. Il doit donc choisir
entre lire plus et payer des données : ça fait partie de son apprentissage.

## Étapes

1. **Première prédiction** ✅ construite et lancée le 6 octobre sur son VPS : prix BTC/ETH, décisions,
   prédictions résolues par le code (détail dans `docs/FIRST-SLICE.md`).
1 bis. **Il sait déjà des choses** ✅ construite le 6 octobre (avancée à ta demande) : Sonni charge
   environ deux ans d'historique journalier Kraken, puis fait une séance avec Opus où il écrit 40 à 80
   intuitions tirées de ce qu'il sait déjà. Le code teste aussitôt sur l'historique celles qui
   s'écrivent sous forme de règle, et donne un verdict : confirmée, contredite, peu concluante ou pas
   assez de cas. Exemple réel : « le BTC remonte le lendemain d'une baisse de 3 % » n'est arrivé que
   dans 40 % des 47 cas, contre 51 % des jours en général : contredite.
1 ter. **Il voit le monde** ✅ construite le 6 octobre : chaque heure, les titres de l'actualité crypto
   et Fed (GDELT et cinq flux RSS gratuits : Cointelegraph, The Block, Decrypt, la Fed, Google Actualités) ; chaque jour, le calendrier des décisions de la Fed (et, avec une clé FRED
   gratuite à ton nom, l'inflation et l'emploi américains) ; le code mesure comment le BTC et l'ETH ont
   bougé ces jours-là, et Sonni peut tester des intuitions du type « le BTC bouge de plus de 3 % les
   jours de Fed ou d'inflation ». Nouvelle commande : `/agenda`. La lecture des articles par Haiku est
   remise à plus tard : Sonni lit les titres directement, ce qui ne coûte rien de plus.
1 quater. **Sonni vivant** ✅ construite le 7 octobre (ta demande : « le plus vivant possible »).
   - *Il se connaît* : une identité qu'il écrit lui-même en français (chaque version est gardée, une
     révision par jour au plus, `/identite`), un journal (post-mortem de chaque prédiction notée,
     notes de séance, `/journal`), des leçons appuyées sur des preuves que tu peux retirer
     (`/lecons`, `/veto <id>`), et un **bilan calculé par le code** (calibration, score par actif et
     par horizon, dépense du jour, `/bilan`) qu'il lit avant de réfléchir : il se juge sur des mesures,
     pas sur des impressions.
   - *Il est curieux* : le code le réveille (au plus 6 fois par jour, espacées de 30 min, jamais en
     pause ni sous plafond) quand un actif bouge de 3 % en une heure, le matin d'un événement et le
     lendemain, quand des prédictions sont résolues, ou quand une « veille » qu'il a posée se
     déclenche (un niveau de prix, un mouvement, une date pour revoir une question). `/reveils`.
   - *Il cherche ses outils* : un catalogue de sources de données gratuites qu'il active ou
     désactive avec une raison (peur et avidité, capitalisation du marché, carnet d'ordres Kraken,
     frais Bitcoin, et avec ta clé FRED les taux et l'inflation) ; il peut te proposer une nouvelle
     source publique que tu acceptes ou refuses (`/sources`, `/source ok|non <id>`) ; il lit une page
     publique quand il en a besoin (20 par jour au plus, hôtes privés interdits) ; il choisit ses
     actifs parmi les paires Kraken en euros, chaque changement motivé (`/actifs`).
   - *Il utilise des IA gratuites pour lire* : avec une clé gratuite Google AI Studio (Gemini) ou
     Groq que tu ajoutes dans `/etc/sonni.env`, un modèle « lecteur » transforme chaque heure les
     titres en observations datées (actif, type, sentiment) et résume les pages lues. Ces modèles
     lisent, ils ne décident jamais ; tout ce qu'ils produisent est de la donnée non fiable, vérifiée
     champ par champ par le code. Sans clé, Sonni lit les titres bruts comme avant. `/lecteurs`.
   - Au passage : les couches « survie » et d'orchestration du runtime Automaton ne sont plus dans
     son prompt, et le bloc qui change à chaque tour est placé en dernier, pour que le cache couvre
     presque tout (moins cher à chaque tour).
2. **Portefeuille virtuel** ✅ construit le 7 octobre (étape 4 B, après la lisibilité de l'étape 4 A) :
   1 000 € virtuels arrivent au premier relevé de prix, puis 50 € virtuels le premier de chaque mois.
   Sonni passe des ordres fictifs (au marché ou à cours limité, en euros) avec une raison écrite, un
   niveau d'invalidation (« si le prix passe sous X, je me trompe ») et un horizon ; le code vérifie
   tout avant d'enregistrer l'ordre (actif suivi, prix frais, argent disponible, **au plus 30 % du
   portefeuille par actif** comme tu l'as choisi, 10 € minimum) et l'exécute au prix suivant avec les
   frais Kraken (0,8 % au marché, 0,4 % à cours limité) et un glissement tiré du carnet d'ordres. Si
   le prix atteint le niveau d'invalidation, le code vend tout seul ; à l'horizon, Sonni est réveillé
   pour garder ou vendre. Chaque vente ferme une opération dont le résultat après frais est calculé
   par le code ; Sonni en écrit l'autopsie dans son journal et peut nommer un piège (une erreur
   répétable, comptée opération par opération). Son bilan `/bilan` donne désormais les trois mesures
   du passage au réel. Pour toi : `/portefeuille`, `/journee`, et un résumé chaque soir à 20 h (ton
   choix : un résumé par jour plutôt qu'un message par ordre). Aucun compte, aucun argent réel : le
   portefeuille n'existe que dans sa base de données.
   Étape 0.2 (fusionnée le 9 octobre, PR #31 ; pas encore en service : le VPS n'est pas mis à jour).
   Une fois déployée, le résultat de chaque opération, le taux d'opérations gagnantes et le gain moyen
   compteront vraiment tous les frais : jusqu'ici les frais d'achat étaient oubliés (un aller-retour de
   100 € à +1 % affichait +0,09 €, un gain, pour une perte réelle de 0,71 €). Le résultat d'une position
   ouverte déduira ses frais d'achat ; la valeur du portefeuille ne change pas. Un aller-retour au marché
   demande une hausse de plus de 1,72 % pour rapporter : en dessous, un achat est « du bon côté » mais
   pas rentable, et rester en dehors n'a rien fait manquer. Dans `/bilan`, les notes à 7 jours des
   décisions porteront sur celles d'il y a 7 à 14 jours (avant, elles affichaient toujours 0 sur 0).
   Limites : rien de ce qui est enregistré n'est réécrit ; les anciennes opérations seront relues après
   frais, mais les résumés et autopsies déjà écrits gardent leurs chiffres d'origine (avant frais
   d'achat). Les prix d'exécution et le coût moyen sont arrondis au centime : pour un actif à moins de
   1 € le résultat peut s'écarter de plusieurs dixièmes de %, et sous 0,005 € le prix arrondi tomberait
   à 0 (défaut ancien, corrigé par l'étape 0.3 ci-dessous).
   Étape 0.3, précision des prix (construite, PR séparée ; pas encore fusionnée ni en service). Une fois
   déployée : le prix d'exécution et le coût moyen gardent 12 chiffres significatifs (les montants restent
   au centime) ; le glissement de 0,05 % s'applique à tous les prix, donc un aller-retour de 100 € coûte
   1,69 € partout (USDC : 1,69 € au lieu de 1,59 €, le chiffre juste) ; les actifs à moins de 0,01 € sont
   permis, sans prix plancher. BTC et ETH : mêmes résultats, sauf environ 1 aller-retour sur 1 000 (BTC) et
   1 sur 100 (ETH) qui bouge d'un centime (l'or PAXG aussi 1 sur 100, les actions 1 sur 10), jamais
   plus, la nouvelle valeur étant l'exacte. Aucun prix nul, quantité
   infinie ou NaN n'est plus écrit : le code refuse l'ordre (« refusé par le code : … » dans
   `/portefeuille`, incident « courtier virtuel » dans `/technique`). Un ordre en panne ne bloque plus les
   autres, ni les stops, ni l'instantané du jour ; un stop qui ne peut pas être placé garde son niveau
   pour le relevé suivant sans bloquer les autres stops ; un stop refusé retrouve son niveau une fois par
   jour (sinon un incident te dit que la position est sans stop). Une position déjà
   enregistrée avec des chiffres invalides est signalée, jamais évaluée : la valeur du portefeuille
   s'affiche « non fiable », achats et décisions sont suspendus jusqu'à une réparation que tu approuves.
   Les prix sous 1 € s'affichent avec au moins 5 chiffres (« 0,0048874 € ») ; à partir de 1 €, rien ne
   change. Avant le déploiement : un audit en lecture seule d'une copie de sa mémoire
   (`sonni/GUIDE-VPS.fr.md`, « Mettre Sonni à jour »). Rien de l'historique n'est réparé ni réécrit.
3. **Actualité et calendrier** ✅ (voir 1 ter).
4. **Mémoire complète** — en cours, par tranches (ta décision du 7 octobre) :
   - *C1 — Dossiers et carnets* ✅ construit le 7 octobre : un dossier par actif suivi, écrit par Sonni
     (thèse de fond, catalyseurs, niveaux, ce qu'il a appris ; une révision par jour et par actif au
     plus, chaque version gardée, `/dossier <actif>`) ; `/note <texte>` pour lui laisser une information
     fiable qu'il lit à sa prochaine séance (une information, pas un ordre) ; `/memoire <sujet>` pour
     chercher dans tout ce qu'il sait ; et ses carnets Markdown dans `~/carnet/` sur le VPS, réécrits
     chaque dimanche et sur `/carnets` (journal, intuitions, pièges, leçons, identité, portefeuille, un
     fichier par actif). Au passage, le scénario « chaos » du test bout-en-bout (garde-fou G8) : API,
     Telegram et Kraken en panne pendant 40 s, ton message pendant la panne traité une seule fois après.
   - *C2 — Cycles* ✅ construit le 7 octobre : pour chaque décision de la Fed, chiffre d'inflation ou
     d'emploi passé, le code mesure une fois comment chaque actif a bougé la veille, le jour, la
     semaine d'après et la première heure. Sonni peut nommer un cycle (« la Fed rassure, le BTC monte
     le jour même ») : le code compte les cas pour et contre, les compare aux jours ordinaires et donne
     un verdict comme pour les intuitions (il faut au moins 10 cas ; les événements sont rares). Tu les
     lis avec `/cycles` et dans `cycles.md` ; il les voit dans son pack avant chaque événement.
   - *C3 — Autopsie du soir* ✅ construit le 7 octobre : chaque soir à 19 h 30 (heure de Paris,
     réglable dans `trader.consolidation`), le code réveille Sonni pour une courte séance : les
     post-mortems encore dus, les pièges touchés, le premier dossier de chaque actif qui n'en a pas
     encore puis les dossiers qui ont changé, et une note du jour en
     trois à six phrases que tu lis dans ton résumé de 20 h. Un tour payé par jour, compté dans ses
     plafonds ; sautée s'il est en pause ou sous plafond (ton résumé le dit).
5. **Ce que Claude sait déjà** : séance d'intuitions initiales + statistiques sur l'historique.
6. **Revue hebdo** : rapport du dimanche sur Telegram, carnets lisibles dans `~/carnet/`.
7. **Actions et ETF** en plus de la crypto, avec la liste d'actifs qu'il choisit lui-même.

Puis plusieurs mois d'entraînement en conditions réelles, sans argent réel.

## Tes réponses du 6 octobre

| Question | Ta réponse | Ce que ça devient |
| --- | --- | --- |
| Capital virtuel | 1 000 € | 1 000 € + 50 € virtuels chaque mois |
| Sources de données | Gratuites et payantes selon le budget | Gratuit d'abord ; payant proposé par lui, souscrit par toi, pris sur les 50 € |
| Actifs suivis | Il choisit lui-même | Liste limitée (proposition : 30 actifs), chaque ajout ou retrait noté avec sa raison |
| Passage au vrai argent | Rendement conséquent, peu d'erreurs, capable de se payer lui-même | Trois mesures suivies chaque semaine (ci-dessous) ; c'est toi qui fixes les seuils |
| Base technique | Code de Money Lab | Décision 0002 acceptée |
| Nom du bot | Sonni | Utilisé dans toute la documentation |

Règles de réalisme pour ses choix d'actifs, pour que l'entraînement serve plus tard avec du vrai
argent : crypto disponible sur une plateforme agréée MiCA, ETF européens (UCITS) car les ETF
américains ne sont en général pas vendus aux particuliers européens.

## Passage au vrai argent : les trois mesures

Sur les 3 derniers mois, après au moins 6 mois d'entraînement :

- **Rendement** : résultat du portefeuille virtuel après frais simulés, sans compter tes versements.
- **Erreurs** : justesse de ses niveaux de confiance, et part de ses paris « très sûrs » qui ont raté.
- **Autofinancement** : ses gains virtuels divisés par ce qu'il coûte (Claude + données). À 1, il
  s'est payé lui-même.

Point d'attention honnête : avec environ 1 300 € de capital virtuel moyen la première année et
~50 €/mois de coûts, se payer lui-même demande ~4 % par mois, soit environ 45 à 60 % par an. Très
peu de professionnels tiennent ce rythme. La mesure reste utile pour suivre ses progrès. Deux choses
la rendront plus accessible : des coûts plus bas une fois l'entraînement rodé, et un capital plus
gros au moment du passage au réel.

## Ce que les recherches ont apporté (détail dans `docs/RESEARCH.md`)

- **FinMem** (bot de trading avec mémoire en couches) : ses souvenirs s'effacent à des vitesses
  différentes. Les leçons durent, les actualités s'oublient vite.
- **TradingAgents** : après chaque pari, il calcule le résultat réel et écrit une courte réflexion.
  On reprend aussi l'idée d'un débat « pour / contre » avant un gros pari.
- **Graphiti** : chaque croyance garde ses dates (quand elle était vraie, quand il l'a notée). Une
  croyance dépassée est fermée, jamais effacée : on voit comment ses idées évoluent.
- **Concours Alpha Arena** : les modèles lisent mal les séries de chiffres bruts. C'est donc le code
  qui calcule les indicateurs (tendance, volatilité, chute maximale…) et Claude qui les interprète.
- **Recherche sur la prévision par IA** : faire plusieurs prévisions indépendantes et garder la
  médiane améliore la justesse. On le fera pour ses paris importants, si le budget le permet.
- **Sources gratuites retenues** : Kraken (crypto), Twelve Data et Massive (actions), Finnhub
  (actualités et calendriers), FRED (macroéconomie), SEC EDGAR (rapports des entreprises), GDELT
  (actualité mondiale).
- **Écartés** : bases vectorielles et frameworks de mémoire en Python (un deuxième langage, des
  coûts en plus, sans besoin prouvé).

## Garde-fous (ta décision du 7 octobre)

Ce que le code fait tout seul pour que Sonni reste dans son cadre (détail : `docs/GUARDS.md`) :
- **Pas de shell** : Sonni n'a plus aucun outil pour exécuter une commande, lire ou écrire un fichier,
  installer quoi que ce soit ou toucher au code. Une page piégée n'a donc aucun chemin vers le serveur.
- **Coût inconnu = pause** : si l'API ne dit pas ce qu'un appel a coûté, il est compté à l'estimation
  et Sonni attend que tu vérifies (`/reprendre`).
- **Sans progrès = long sommeil** : cinq cycles payés qui ne changent rien à sa mémoire, et il dort
  deux heures en te prévenant.
- **Dix ordres par jour au plus** (annulations comprises) : pas d'agitation en boucle.
- **Réponse coupée = rien d'exécuté** : si sa réponse dépasse la limite de sortie, ses appels d'outils
  ne sont pas lancés et on lui demande de faire plus court ; une raison d'arrêt inconnue de l'API le
  met en pause.
- **Le web reste de la donnée** : une page qui prétend que tu as autorisé une dépense ne produit
  qu'une observation marquée « non fiable », testé.
- **Sauvegarde vérifiée** : chaque copie quotidienne est rouverte et contrôlée (intégrité, nombre de
  lignes) avant de compter ; sinon tu le vois dans `/technique` et le rapport du matin. Corrigé le
  8 octobre : le serveur ne gardait en réalité qu'environ 3 jours de copies au lieu de 7 (des fichiers
  annexes laissés par la vérification étaient comptés) ; il en garde maintenant vraiment 7.
- **Journal des incidents** : tout ce que le programme fait seul pour se protéger (pause, plafond,
  erreurs en série, réponse coupée, source désactivée, IA lectrice refusée, sauvegarde invalide) est
  daté dans `/technique` et compté dans ton rapport du matin.
- À venir avec l'étape C : un scénario « chaos » dans le test bout-en-bout (API en panne, Telegram
  et Kraken injoignables).
Seule la limite de dépense que tu fixes dans la console Anthropic est hors de portée du programme.

## Seuils de passage au réel

On les fixera ensemble après ses premiers mois de résultats (ta décision du 6 octobre).

## Ce que tu peux déjà faire avec Sonni (une fois lancé)

- `/idee <texte>` : lui donner une intuition à tester (il ne peut pas prédire sans intuition).
- `/intuitions` : voir ses intuitions, leurs preuves pour et contre, et sa confiance calculée.
- `/dossier <actif>`, `/note <texte>`, `/memoire <sujet>`, `/carnets` : ses dossiers par actif, tes
  notes, sa mémoire en recherche, ses carnets Markdown (étape C1). `/cycles` : les réactions mesurées
  autour des événements et les cycles qu'il a nommés, avec le verdict du code (étape C2).
- `/portefeuille` : son portefeuille virtuel (valeur, positions avec leur raison, ordres en attente
  et récents, résultats calculés par le code, opérations closes, pièges nommés). `/journee` : le
  résumé du jour, que tu reçois aussi chaque soir à 20 h.
- `/statut` : l'essentiel en quatre blocs, en français et à l'heure de Paris, sans identifiants :
  portefeuille virtuel, marché et prédictions (ouvertes, résolues avec leur score), apprentissage
  (intuitions, lectures, journal), budget du jour. `/technique` donne l'état technique du programme.
- Chaque matin vers 9 h, Sonni t'envoie son rapport : ce qu'il a fait la veille, ce qui arrive
  aujourd'hui, et seulement les vraies alertes. `/sante` reste le rapport technique du serveur.
- Ses intuitions sont affichées en français : il écrit les nouvelles en français, et une IA lectrice
  gratuite traduit les anciennes (le texte d'origine est gardé pour lui).
- `/bilan`, `/identite`, `/journal`, `/lecons`, `/veto <id>` : ce qu'il mesure sur lui-même et ce
  qu'il écrit sur lui-même. `/identite <texte>` enregistre ta propre version de son identité (il la
  garde, et peut la réviser ensuite avec une raison).
- `/reveils`, `/lecteurs`, `/sources`, `/source ok|non <id>`, `/actifs` : sa curiosité et ses outils.
- `/pause`, `/reprendre`, `/sante` : comme pour Money Lab.

Chaque dimanche, il fait sa revue : il compare ses probabilités à ce qui s'est passé, réécrit ses
leçons et t'envoie un rapport en français avec jusqu'à trois nouvelles intuitions à tester.

## Avant le premier lancement réel (ton accord nécessaire)

Sonni aura **son propre VPS** (ta décision du 6 octobre). Tout est expliqué pas à pas dans
`sonni/GUIDE-VPS.fr.md` :

- un petit VPS Ubuntu 24.04 (2 Go), payé à part, en dehors des 50 € de Sonni (proposition) ;
- un espace Anthropic `Sonni` avec sa propre clé et une limite de dépense mensuelle (58 $ environ) ;
- un nouveau bot Telegram ;
- budget de départ : 58 $ (environ 50 €), plafond de 1,93 $ par jour ; tu ajoutes le mois suivant avec
  `/fonds 58`. Le lissage exact sur le mois viendra plus tard.
