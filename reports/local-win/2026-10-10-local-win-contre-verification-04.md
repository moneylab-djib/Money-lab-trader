---
agent: local-win
date: 2026-10-10T11:30:00+02:00
repo: moneylab-djib/Money-lab-trader
branch: main
commit: 55ab45396ef62e1458fe877a47555f44aa42b24b
env: "Windows 11 Famille 26200, PowerShell 5.1 ; Node v22.23.3 portable, pnpm 10.28.1 (corepack) ; better-sqlite3 11.10.0 ; clone neuf dans C:\\Travail\\contre-verif\\sonni-cv (git de GitHub Desktop, core.autocrlf=true) ; WSL : aucune distribution installee"
status: issues
files_touched: []
files_claimed: []
needs_owner_go: []
replies_to: [2026-10-10-cloud-mission-contre-verification-02.md]
---

# Rapport local-win n°04 — contre-vérification des outils de déploiement sous Windows (GO-9)

Mission cloud n°02 exécutée sur le PC du propriétaire, sur des bases fictives uniquement : aucun outil lancé sur
`C:\Sonni`, sur une vraie sauvegarde ou sur le VPS ; aucun fichier du dépôt modifié. Résultat : **24 cas conformes
sur 28, 2 écarts, 2 non applicables**. Les deux écarts ont une seule cause (`EPERM` sur la quarantaine) ; l'analyse
révèle en plus un message d'échec trompeur valable sur toutes les plateformes, et une cause Windows (fins de ligne
CRLF) qui empêche `deploy-counter.test.ts` de se charger.

## 1. Commit et branche examinés

`main` @ `55ab453` (fusion de la PR #33), vérifié par `git log -1` dans le clone neuf. Le rapport produit par le script
affiche « Commit : inconnu » parce que `git` n'est pas sur le PATH de ce PC (git de GitHub Desktop) : voir §5.6.

## 2. Environnement

- Windows 11 Famille 10.0.26200, PowerShell 5.1, Node v22.23.3 (zip officiel portable), pnpm 10.28.1 via corepack.
- Clone neuf `C:\Travail\contre-verif\sonni-cv` (hors `C:\Sonni`) ; git de GitHub Desktop, donc `core.autocrlf=true` :
  les fichiers du clone sont en CRLF (`git ls-files --eol` : `i/lf w/crlf`).
- `pnpm install --frozen-lockfile` : code 0, 17 s (binaire préconstruit de better-sqlite3 ; `bufferutil` et
  `utf-8-validate` ignorés comme au n°02). `pnpm run build` : code 0, 28 s.
- WSL : `wsl.exe` présent mais **aucune distribution installée** (`wsl --list` code 1). Pas d'exécution sous WSL :
  elle demanderait une installation, hors périmètre.

## 3. Mesures et tests effectués

| Commande (dans le clone) | Durée | Code | Résultat |
| --- | --- | --- | --- |
| `node sonni/pc/contre-verification.mjs --rapport ..\contre-verification-windows.md` | 4 s | **1** | `RÉSULTAT : code=1 cas=28 ok=24 ecarts=2 non_applicables=2` |
| même commande avec `--garder` (une fois, pour analyser l'écart ; dossier effacé ensuite) | 4 s | 1 | identique |
| `pnpm exec vitest run src/__tests__/trader/deploy-counter.test.ts` | 5 s | **1** | fichier non chargé : `SyntaxError`, 0 test exécuté |
| `pnpm exec vitest run …/deploy-pause.test.ts …/deploy-environment.test.ts …/deploy-backup.test.ts` | 9 s | 1 | 59 tests : **36 OK, 23 KO** |

Après chaque exécution : aucun dossier `sonni-contre-verif-*` ni autre `sonni*` ne reste dans `%TEMP%`.

## 4. Résultats mesurés

### Tableau produit par le script

| # | Cas | Outil | Code attendu | Code obtenu | Statut |
|---|-----|-------|--------------|-------------|--------|
| 1 | audit des prix, base propre | audit-prix.mjs | 0 | 0 | OK |
| 2 | audit des prix, position corrompue listée | audit-prix.mjs | 0 | 0 | OK |
| 3 | audit des prix, fichier non SQLite | audit-prix.mjs | 1 | 1 | OK |
| 4 | sauvegarde à froid | sauvegarde.mjs | 0 | 0 | OK |
| 5 | empreinte .sha256 de la sauvegarde | - | 0 | 0 | OK |
| 6 | sauvegarde à chaud (base ouverte en WAL) | sauvegarde.mjs | 0 | 0 | OK |
| 7 | sauvegarde d'un fichier non SQLite | sauvegarde.mjs | 3 | 3 | OK |
| 8 | essai de restauration | restauration.mjs | 0 | 0 | OK |
| 9 | restauration refusée sans --confirmer | restauration.mjs | 2 | 2 | OK |
| 10 | restauration refusée sans systemd ni --sans-systemd | restauration.mjs | 2 | 2 | OK |
| 11 | restauration réelle (--sans-systemd) | restauration.mjs | 0 | 3 | ÉCART |
| 12 | base restaurée identique à la copie, ancienne base en quarantaine | - | 0 | 0 | ÉCART |
| 13 | restauration refusée pendant que Sonni tourne (faux systemctl) | restauration.mjs | 2 | - | NON APPLICABLE |
| 14 | essai de restauration d'un fichier non SQLite | restauration.mjs | 3 | 3 | OK |
| 15 | contrôle avant déploiement, base propre | controle-predeploiement.mjs | 0 | 0 | OK |
| 16 | contrôle avant déploiement, position corrompue (BLOQUANT) | controle-predeploiement.mjs | 1 | 1 | OK |
| 17 | BLOQUANT non levé par --accepter-a-decider | controle-predeploiement.mjs | 1 | 1 | OK |
| 18 | contrôle avant déploiement, stop franchi (À DÉCIDER) | controle-predeploiement.mjs | 1 | 1 | OK |
| 19 | stop franchi accepté par sa clé | controle-predeploiement.mjs | 0 | 0 | OK |
| 20 | contrôle avant déploiement, fichier non SQLite | controle-predeploiement.mjs | 3 | 3 | OK |
| 21 | retour arrière : stop sous 1 € refusé sans GO nommant l'actif | verifier-pause.mjs | 1 | 1 | OK |
| 22 | retour arrière permis : pause, arrondi USDC accepté | verifier-pause.mjs | 0 | 0 | OK |
| 23 | retour arrière : copie plus ancienne que la base refusée | verifier-pause.mjs | 1 | 1 | OK |
| 24 | retour arrière : pause absente | verifier-pause.mjs | 1 | 1 | OK |
| 25 | retour arrière : achat en attente pendant la pause | verifier-pause.mjs | 1 | 1 | OK |
| 26 | retour arrière : position corrompue (BLOQUANT) | verifier-pause.mjs | 1 | 1 | OK |
| 27 | retour arrière vérifié sur la base en marche (lecture seule) | verifier-pause.mjs | 0 | 0 | OK |
| 28 | vérification de l'environnement du serveur | verification-environnement.mjs | 0 | - | NON APPLICABLE |

Non applicables (attendus par la mission) : n°13 (faux `systemctl` en script shell) et n°28 (outil du VPS).

### Écart n°11 — restauration réelle (--sans-systemd)

Commande : `node sonni/vps/restauration.mjs --restaurer <tmp>\home-sauvegarde-froid\.automaton\predeploiement\state.db.predeploiement-20261010T092329Z --confirmer --cible <tmp>\home-restauration\.automaton\state.db --sans-systemd`
Code obtenu : **3** (attendu 0). Fin de la sortie :

```
Empreinte SHA-256 : conforme au fichier .sha256 (1e865f890037…).
Intégrité de la copie : ok (12 tables comptées)
Pas de systemd : tu as indiqué que Sonni est arrêté (--sans-systemd).
RÉSULTAT : code=3 cible=inchangée quarantaine=<tmp>\home-restauration\.automaton\quarantaine-20261010T092329Z
Erreur technique : opération non permise (EPERM).
ÉCHEC après la mise de côté de l'ancienne base. Où sont les fichiers :
  - <tmp>\home-restauration\.automaton\state.db : base restaurée NON conforme, à déplacer
Le dossier <tmp>\home-restauration\.automaton\quarantaine-20261010T092329Z n'a pas été supprimé.
```

**Cause (vérifiée)** : `restauration.mjs:374-376` crée la quarantaine puis appelle `secureEntry(quarantine, 0o700, owner, true)`.
Sous Windows, `fs.constants.O_DIRECTORY` et `O_NOFOLLOW` valent `undefined` : les drapeaux se réduisent à 0 et
`openSync` du dossier **réussit** ; c'est `fs.fchmodSync(fd, 0o700)` sur le descripteur d'un dossier (ligne 76) qui
lève **EPERM** (reproduit seul avec Node 22.23.3 sur un dossier vide : `openSync` OK, `fchmodSync` EPERM, `fsyncSync`
EPERM). L'erreur survient **avant** tout `renameSync` (lignes 377-381).

**État constaté avec `--garder`** (puis dossier effacé) : `home-restauration\.automaton\` contient la quarantaine
**vide** et `state.db` (1 073 152 octets, SHA-256 `680f908f7c90…`), différent de la copie (`71f43c1438fe…`) : c'est
l'**ancienne base, intacte, à sa place**. Aucune donnée perdue ; « cible=inchangée » est exact.

### Écart n°12 — vérification après restauration

Conséquence directe du n°11 : rien n'a été restauré, donc « la base restaurée diffère de la copie » et « ancienne base
absente de la quarantaine ». La ligne « Commande : `node sonni/vps/- ` » du rapport est un artefact d'affichage (ce cas
n'appelle aucun outil) : voir §5.6.

### Tests vitest

| Fichier | Tests | OK | KO | Cause des KO |
| --- | --- | --- | --- | --- |
| deploy-counter.test.ts | 0 exécuté | – | fichier non chargé | `SyntaxError: Invalid or unexpected token` à l'import de `sonni/pc/contre-verification.mjs` (CRLF, §5.3) |
| deploy-pause.test.ts | 21 | **21** | 0 | – |
| deploy-environment.test.ts | 6 | 5 | 1 | préflight du serveur Linux (`verification-environnement.mjs`), attendu non applicable sous Windows |
| deploy-backup.test.ts | 32 | 10 | 22 | voir ci-dessous |

Répartition des 22 KO de `deploy-backup` (première ligne d'erreur de chaque test) :
- **12** `SyntaxError: Invalid or unexpected token` : tests qui importent `sauvegarde.mjs` / `restauration.mjs` dans le processus de vitest (CRLF, §5.3) ;
- **4** « Restauration de la mémoire de Sonni… » (sortie inattendue) : restaurations réelles, même `EPERM` que l'écart n°11 ;
- **2** `expected 438 to be 448` : droits POSIX (0o666 au lieu de 0o700), attendus Linux ;
- **2** `expected null to be +0` : `spawnSync("sh", …)` (umask 022 via `sh -c`) — pas de `sh` sous Windows ;
- **1** `expected 'SIGTERM' to be null` : signal SIGTERM pendant l'essai, sémantique propre à POSIX ;
- **1** « Refusé : la commande C:\…\systemctl … » : faux `systemctl` en script shell, non exécutable sous Windows.

## 5. Anomalies constatées

1. **`sonni/vps/restauration.mjs:76` (`secureEntry` sur un dossier)** — sous Windows, `fchmodSync` sur le descripteur
   d'un dossier lève `EPERM` : la restauration réelle échoue (code 3) avant tout déplacement. Sans effet sur le VPS
   (Linux), mais la mission prévoyait « ça marche » ou « code 3 » : c'est code 3, par `EPERM`.
2. **Message d'échec trompeur, toutes plateformes** — `restauration.mjs:434-445` : dès que `quarantine` est défini
   (dossier créé) mais que rien n'a été déplacé (`moved` vide), la sortie annonce « ÉCHEC après la mise de côté de
   l'ancienne base » et désigne le `state.db` en place comme « base restaurée NON conforme, **à déplacer** ». Or c'est
   l'ancienne base intacte. Sur le VPS, la même branche est atteinte si `secureEntry` échoue sur la quarantaine (par
   exemple `fchownSync` en root) : un opérateur qui suivrait le message déplacerait la bonne mémoire. Le message
   devrait distinguer « quarantaine créée, rien déplacé : l'ancienne base est intacte à sa place » (et la quarantaine
   vide pourrait être retirée).
3. **CRLF : `.mjs` de `sonni/` non importables par vitest sous Windows** — dans un clone `core.autocrlf=true` (réglage
   par défaut de git sous Windows / GitHub Desktop), `deploy-counter.test.ts` ne se charge pas et 12 tests de
   `deploy-backup` échouent. Reproduit hors du dépôt : la même copie de `contre-verification.mjs` s'importe dans
   vitest en LF et échoue en CRLF (`SyntaxError`) ; `node --check` passe dans les deux cas, et une ligne `#!` seule
   en CRLF passe aussi (ce n'est donc pas le shebang seul). Le construit précis n'a pas été isolé.
4. **Pas de protection `O_NOFOLLOW` sous Windows** (drapeaux à 0) : sans conséquence pour la production (VPS Linux),
   à connaître si ces outils servaient un jour sur le PC.
5. Attendus Linux de `deploy-backup` (droits 600/700, `sh`, SIGTERM, faux `systemctl`) : décrits, non corrigés.
6. Mineurs dans `sonni/pc/contre-verification.mjs` : « Commit : inconnu » quand `git` n'est pas sur le PATH (ligne 302,
   `spawnSync("git", …)`) ; ligne « Commande : `node sonni/vps/- ` » pour les cas sans outil (n°5, n°12).

## 6. Recommandations pour l'agent cloud

- Anomalie 2 (prioritaire, toutes plateformes) : dans le `catch` de `restaurer`, si `moved` est vide et `placed` faux,
  dire que l'ancienne base est intacte à sa place et ne pas la qualifier de « base restaurée … à déplacer » ; ajouter
  un test qui fait échouer `secureEntry` sur la quarantaine et vérifie ce message.
- Anomalie 1 : sous `win32`, ne pas appeler `fchmodSync`/`fsyncSync` sur le descripteur d'un dossier (ou ignorer
  `EPERM` pour les dossiers), si la restauration doit un jour être possible sous Windows ; sinon marquer le cas n°11
  « non applicable » sous Windows comme le n°13, pour que la contre-vérification Windows sorte à 0.
- Anomalie 3 : ajouter un `.gitattributes` (`*.mjs text eol=lf`, et de préférence `*.ts`, `*.ps1` selon le besoin
  d'ASCII/fin de ligne de chaque fichier) pour que les clones Windows aient des fins de ligne LF ; ou isoler le
  construit sensible au CRLF. À revérifier ensuite par local-win.
- Anomalie 6 : `git` absent du PATH → chercher `GIT` ou afficher le commit passé en option.

## 7. Fichiers concernés

- Réservés par local-win : aucun. Modifiés : aucun.
- `files_claimed` de la mission (agent cloud) respectés ; à relire : `sonni/vps/restauration.mjs` (lignes 70-82,
  369-382, 425-461), `sonni/pc/contre-verification.mjs`, `src/__tests__/trader/deploy-counter.test.ts`,
  `src/__tests__/trader/deploy-backup.test.ts`.

## 8. Actions nécessitant l'autorisation du propriétaire

- Aucune pour ce rapport. Le dossier de travail `C:\Travail\contre-verif` (clone, `node_modules`, journaux, deux
  petits dossiers d'essai) reste sur le PC : le propriétaire décide s'il est effacé.
- La fusion de correctifs et tout déploiement restent soumis à son GO.
