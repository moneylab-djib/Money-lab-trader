# Plan d'amélioration de Money Lab

Chaque étape : je construis et teste sur la simulation, tu mets à jour le serveur, on observe quelques
jours. Les règles de sécurité restent : pas de copie de lui-même, pas de création de comptes, pas de
CAPTCHA, pas tes comptes personnels, pas de dépassement des plafonds.

| Étape | Contenu | Ce que tu fais | État |
|---|---|---|---|
| 1 | `delegate` (Haiku, 2× moins cher), `schedule_job` (tâches gratuites), `recall` (mémoire) | Mise à jour | Fait (2026-10-06) |
| 1 bis | Réfléchir avant de construire : entonnoir d'idées notées, critique par Opus, 6 h de réflexion, lancement bloqué sans idée validée | Mise à jour | Fait (2026-10-06) |
| 1 ter | Corrections après observation : date du jour dans ses consignes, sommeil limité à 3 h tant qu'il a moins de 5 idées notées, recherche comptée comme du progrès | Mise à jour | Fait (2026-10-06) |
| 2 | `audit_page` (Lighthouse), `ab_test` (tests A/B sans cookies) | Mise à jour | Fait (2026-10-06) |
| 3 | Nom de domaine choisi par le bot (`check_domain`, il te demande l'achat), images pour les réseaux (`render_image`), publication Bluesky validée par toi (`post_social`, `/publier`) | Acheter le domaine, créer le compte Bluesky | Code fait (2026-10-06), comptes à créer |
| 4 | Adresse e-mail dédiée (après le domaine) | Créer l'adresse | À faire |
| 5 | Revenus : Stripe, affiliation, publicité | Statut, comptes | Après le reste |

## Étape 3 : domaine, images, réseaux

- **Domaine.** `check_domain` interroge les registres (RDAP, gratuit) : libre ou pris, avec la date
  d'expiration. Le bot choisit lui-même entre un domaine unique (outils dans des dossiers,
  `marque.fr/devis/`, conseillé pour Google) et des sous-domaines. Il te demande l'achat avec son choix,
  deux alternatives, le prix et ses raisons. Il prépare ensuite GitHub Pages et te donne les
  enregistrements DNS à saisir chez OVH.
- **Images.** `render_image` : il dessine en HTML/CSS et Chrome produit un PNG aux formats des réseaux
  (aperçu de lien 1200×630, carré 1080×1080, portrait, story, bannière). Gratuit.
- **Bluesky.** `post_social` : il rédige, tu reçois chaque brouillon sur Telegram et tu réponds
  `/publier <id>` ou `/rejeter <id> [raison]`. Au plus 3 publications par jour, ni réponses ni messages
  privés. `/publications auto` supprime la validation, `/publications validation` la remet. Le mot de
  passe d'application est lu par le programme, jamais par le bot.

## Étape 1 bis : réfléchir avant de construire

Problème constaté : le bot a construit un générateur de factures, un outil très courant, sans étude
sérieuse. Désormais :

1. **Phase de découverte.** Il explore beaucoup de niches (métiers, loisirs, besoins locaux, données
   difficiles à obtenir, tâches répétitives), lit ce que les gens demandent et ce dont ils se plaignent,
   étudie la concurrence. Prendre 2 ou 3 jours pour ça est encouragé.
2. **Chaque idée est notée sur 9 critères**, de 0 à 10, chaque note justifiée par des faits :
   - demande prouvée (poids 2) ;
   - place laissée par la concurrence (1,5) ;
   - originalité (1) ;
   - facilité de marketing sans pub ni spam (1,5) ;
   - facilité de construction (1) ;
   - coût de fonctionnement (0,5) ;
   - potentiel de revenus (1,5) ;
   - avantage de son propre serveur (1) : données collectées, traitements, API, automatisation qu'un
     simple site copié ne peut pas offrir ;
   - rapidité pour savoir si ça marche (1).
   Le total est ramené sur 100.
3. **Critique.** Claude Opus joue l'investisseur sceptique : verdict GO, NO-GO ou « preuves
   insuffisantes », points faibles, preuves manquantes, meilleur angle. Le bot doit répondre à la
   critique. Environ 5 centimes par critique, 3 critiques maximum par idée.
4. **Validation**, appliquée par le programme. Il faut :
   - les 9 critères notés et au moins 3 sources ;
   - au moins 2 concurrents étudiés ;
   - au moins 5 idées comparées, et celle-ci dans le top 3 ;
   - un total d'au moins 60 ;
   - une critique qui n'est pas NO-GO, et la réponse du bot à cette critique ;
   - des critères d'arrêt chiffrés ;
   - **6 h de réflexion** depuis la première notation.
5. **Lancement.** Une expérience ne peut passer en construction qu'avec une idée validée, et au plus 3
   expériences actives à la fois. Les expériences existantes (dont le générateur de factures) continuent,
   mais seront notées comme des idées au prochain bilan hebdomadaire, qui peut décider de les arrêter.
