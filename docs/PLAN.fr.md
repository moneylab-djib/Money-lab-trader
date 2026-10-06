# Money Lab Trader — plan pour le propriétaire

Résumé en français de la spécification (les documents techniques sont en anglais : `PROJECT.md`,
`ARCHITECTURE.md`, `docs/MEMORY.md`). État au 6 octobre 2026 : **spécification seulement**, aucun
code, aucun compte, aucun argent engagé.

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

## Budget : 50 €/mois de Claude

| Usage | Part | Environ |
| --- | --- | --- |
| Lecture de l'actualité | 30 % | 15 € |
| Décisions | 40 % | 20 € |
| Autopsies et revue hebdo | 20 % | 10 € |
| Réserve pour les jours agités | 10 % | 5 € |

Ce sont des estimations, à corriger après deux semaines de mesures. Il peut tout dépenser, mais à un
rythme lissé sur le mois. Garde-fou : une clé API Anthropic dédiée, avec une limite de dépense
mensuelle que tu fixes dans la console Anthropic.

## Étapes

1. **Première prédiction** : prix BTC/ETH, une décision, une prédiction résolue par le code (détail
   dans `docs/FIRST-SLICE.md`).
2. **Portefeuille virtuel** : ordres fictifs, frais et glissement simulés, versement virtuel de 50 €/mois.
3. **Actualité et calendrier** : lecture des news, événements datés, mesure des réactions de prix.
4. **Mémoire complète** : intuitions, pièges, cycles, autopsies quotidiennes.
5. **Ce que Claude sait déjà** : séance d'intuitions initiales + statistiques sur l'historique.
6. **Revue hebdo** : rapport du dimanche sur Telegram, carnets lisibles dans `~/carnet/`.
7. **Actions et ETF** en plus de la crypto.

Puis plusieurs mois d'entraînement en conditions réelles, sans argent réel.

## Quand passer au vrai argent ? (proposition, c'est toi qui décides)

- Au moins 6 mois d'entraînement et au moins 300 prédictions résolues.
- Des prédictions bien calibrées : quand il dit 70 %, il a raison environ 7 fois sur 10.
- Un résultat virtuel positif après frais simulés.
- Une perte maximale du portefeuille virtuel restée sous 25 %.
- Aucune falsification détectée dans ses registres.

## Questions ouvertes pour toi

1. **Capital virtuel de départ** : 1 000 € + 50 €/mois virtuels, ou autre montant ?
2. **Données actions** : offre gratuite de Massive (5 appels par minute, assez pour quelques
   actions) ou offre Starter à 29 $/mois (appels illimités) ? Ce coût s'ajouterait aux 50 € de
   Claude. À trancher à l'étape 7, en vérifiant le délai des données de chaque offre.
3. **Actifs suivis au départ** : proposition BTC, ETH, puis 10 à 20 grandes actions et ETF.
4. **Critères de passage au réel** : les seuils ci-dessus te conviennent-ils ?
5. **Base technique** : partir du code de Money Lab (recommandé, décision 0002) ?
6. **Nom** du bot.
