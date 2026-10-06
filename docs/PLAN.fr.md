# Sonni — plan pour le propriétaire

Résumé en français de la spécification (les documents techniques sont en anglais : `PROJECT.md`,
`ARCHITECTURE.md`, `docs/MEMORY.md`). État au 6 octobre 2026 : **étape 1 construite et vérifiée
avec de fausses API**, pas encore lancée. Aucun compte, aucun argent engagé.

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
| Toutes les heures | Lit l'actualité et note ce qui compte | Haiku 4.5 |
| Toutes les 5 minutes | Relève les prix, mesure les réactions | aucun (code) |
| ~3 fois par jour + mouvements forts | Prend ses décisions virtuelles | Sonnet 5.5 |
| Chaque soir | Autopsie de la journée | Sonnet 5.5 |
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

**Données** (ta réponse du 6 octobre) : il utilise d'abord les sources gratuites. S'il juge qu'une
source payante vaut le coup, il te la propose avec son coût et son usage prévu ; c'est toi qui
t'abonnes (il ne crée jamais de compte), et l'abonnement est pris sur ses 50 €. Il doit donc choisir
entre lire plus et payer des données : ça fait partie de son apprentissage.

## Étapes

1. **Première prédiction** ✅ construite le 6 octobre : prix BTC/ETH, une décision, une prédiction
   résolue par le code (détail dans `docs/FIRST-SLICE.md`). Reste à la lancer en vrai, avec ton accord.
2. **Portefeuille virtuel** : 1 000 € virtuels au départ, ordres fictifs, frais et glissement
   simulés, versement virtuel de 50 €/mois.
3. **Actualité et calendrier** : lecture des news, événements datés, mesure des réactions de prix.
4. **Mémoire complète** : intuitions, pièges, cycles, autopsies quotidiennes.
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

## Seuils de passage au réel

On les fixera ensemble après ses premiers mois de résultats (ta décision du 6 octobre).

## Ce que tu peux déjà faire avec Sonni (une fois lancé)

- `/idee <texte>` : lui donner une intuition à tester (il ne peut pas prédire sans intuition).
- `/intuitions` : voir ses intuitions, leurs preuves pour et contre, et sa confiance calculée.
- `/statut` : prix, prédictions ouvertes et résolues avec leur score, puis le budget.
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
