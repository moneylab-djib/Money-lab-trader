---
agent: local-win
date: 2026-10-10T02:00:00+02:00
repo: moneylab-djib/Money-lab-trader
branch: local-win/windows-tests
commit: fd5916d2a0fcef6ac2142cc44b0c9c380e036a21 + 1 commit local (patch 0001-windows-tests, 6 fichiers, +66/-14 ; non poussé)
env: "Windows 11 Famille 26200, PowerShell 5.1 (pas de pwsh) ; Node v22.23.3 portable, pnpm 10.28.1 ; contrôle croisé sur Linux (Node 22.22, pwsh 7.4) dans le conteneur de l'agent Cowork"
status: ok
files_touched: [sonni/e2e.mjs, src/__tests__/trader/curiosity.test.ts, src/__tests__/trader/readers.test.ts, src/__tests__/trader/soul.test.ts, src/__tests__/trader/sources.test.ts, src/__tests__/trader/pc-scripts.test.ts]
files_claimed: [sonni/e2e.mjs, src/__tests__/trader/curiosity.test.ts, src/__tests__/trader/readers.test.ts, src/__tests__/trader/soul.test.ts, src/__tests__/trader/sources.test.ts, src/__tests__/trader/pc-scripts.test.ts]
needs_owner_go: [GO-8-publish-branch-and-PR]
replies_to: [2026-10-09-local-win-devchecks-02.md, 2026-10-10-cloud-devchecks-reply-01.md]
---

# Rapport local-win n°03 — GO-7 : la suite Sonni et l'e2e passent sous Windows

Le propriétaire a accordé GO-7 (corriger les anomalies Windows des tests et du harnais). Le correctif a été écrit par
l'agent local, validé sur Linux puis sur le PC Windows ; **main n'est pas modifié**, le correctif est un commit sur la
branche locale `local-win/windows-tests`, non poussé, en attente de la décision du propriétaire (GO-8).

## 1. Commit et branche examinés

Base `main @ fd5916d`. Branche `local-win/windows-tests` = `main` + 1 commit (`tests: Windows portability …`), patch
`0001-windows-tests.patch` : `sonni/e2e.mjs` (+11), `curiosity/readers/soul/sources.test.ts` (+7 chacun),
`pc-scripts.test.ts` (+17). Aucun fichier de `claude/sonni-ci-gate`, aucun fichier de runtime.

## 2. Environnement

Comme le rapport n°02 (Node portable, pnpm via corepack, better-sqlite3 préconstruit). Contrôle croisé : mêmes
commandes sur une copie Linux de `main` + patch, Node 22.22, pnpm 10.28.1, pwsh 7.4 disponible.

## 3. Mesures et tests effectués

| Check | Windows avant patch (n°02) | **Windows après patch** | Linux après patch |
| --- | --- | --- | --- |
| types (`pnpm run typecheck`) | PASS | **PASS** (7 s) | PASS |
| sonni (`vitest run src/__tests__/trader`) | 143 OK / 33 KO (16 fichiers OK / 5 KO) | **178 OK / 0 KO / 3 ignorés, 21 fichiers sur 21** | 176 OK / 0 KO / 5 ignorés (sans pwsh) ; blocs pwsh OK avec pwsh |
| pc-scripts.test.ts seul | 1 KO | **PASS** (4 OK, 3 ignorés `pwsh` ; les 2 nouveaux tests PowerShell 5.1 passent) | PASS (pwsh : 5 OK, 2 ignorés 5.1) |
| build (`pnpm run build`) | PASS | **PASS** (10 s) | PASS |
| sonni-e2e (`node sonni/e2e.mjs`) | plantage immédiat (ENOENT) | **PASS : 81 contrôles sur 81, 0 échec, fin normale, code 0, 643 s** | PASS : 81/81, aucune anomalie, ~9 min |

Sous Windows, aucun processus `node` lié au projet ne subsiste après l'e2e. money-lab et deps : non lancés (voir §8).

## 4. Résultats mesurés — les anomalies, une par une

Le portage a révélé trois couches successives dans le harnais e2e, chacune masquée par la précédente :

1. **EBUSY au nettoyage (32 tests)** — `afterEach` supprimait `state.db` sans fermer la base. Correctif : chaque base
   ouverte par `openDb()` est mémorisée et fermée (`db.close()`) avant `rmSync`, la discipline déjà suivie par
   `portfolio.test.ts`. 4 fichiers, 7 lignes chacun.
2. **Mode POSIX `0o640` (1 test)** — assertion conditionnée à `process.platform !== "win32"` ; le mode reste vérifié
   sur Linux (cible réelle d'`export-backup.mjs` : le VPS). Le reste de ce test (rotation, copie endommagée refusée)
   tourne maintenant sous Windows et passe.
3. **PowerShell 5.1 jamais testé** — nouveau bloc `describe.skipIf(!HAS_PS51)` : les deux `.ps1` doivent être ASCII pur
   et passer l'analyseur de `powershell.exe` (l'interpréteur des tâches planifiées du propriétaire). Les tests `pwsh`
   existants sont inchangés.
4. **e2e sous Windows, trois causes en cascade** dans `sonni/e2e.mjs` :
   - `new URL(import.meta.url).pathname` donne `/C:/…` → `REPO` invalide → `spawnSync ENOENT` ; remplacé par
     `fileURLToPath` (comme `sonni/vps/configure.mjs`) ;
   - `execFileSync("node")` / `spawn("node")` avec un environnement minimal sans `SystemRoot`/`PATHEXT` ; remplacé par
     `process.execPath`, et sous Windows l'environnement reçoit `USERPROFILE=HOME` (lu par `os.homedir()`),
     `SystemRoot`, `PATHEXT`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA` — aucune variable secrète ;
   - `NODE_OPTIONS=--import C:\…\e2e-preload.mjs` refusé par Node (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) → Sonni
     mourait au démarrage ; remplacé par `pathToFileURL(...).href`.

Après ces correctifs, le scénario complet a tourné sur le PC du propriétaire : collecte Kraken, session de décision et
ordre virtuel, commandes Telegram en français, panne de 40 s (Anthropic, Telegram, Kraken) avec reprise et message
remis une seule fois, redémarrage sans appel payant, second cerveau contacté avec sa clé et sans appel à Claude.

## 5. Anomalies constatées

Aucune nouvelle. Les trois défauts corrigés sont des défauts de portabilité des tests/harnais, pas du runtime.
Point de vigilance hérité du rapport cloud-reply-01 et confirmé : sans `USERPROFILE` redirigé, `workspace.ts:45`
(`os.homedir()`) pourrait écrire dans le vrai profil ; le patch redirige `USERPROFILE` vers le bac à sable de l'e2e.

## 6. Recommandations pour l'agent cloud

- Relire le patch (branche `local-win/windows-tests` une fois poussée, ou `0001-windows-tests.patch`) et le reprendre
  dans une PR vers `main` : la CI Linux (Node 20 et 22) doit confirmer les chiffres du contrôle croisé ci-dessus.
- Mettre à jour `docs/STATUS.md` / `docs/CODEMAP.md` selon la routine Likma après fusion (hors périmètre local-win).
- `pc-scripts.test.ts` : un jour, faire tourner les scripts eux-mêmes avec `powershell.exe` 5.1 (les faux `sftp` et
  `llama-server` sont des scripts `sh`, il faudrait des équivalents `.cmd`) ; le parse 5.1 est un premier filet.
- Checks restants à faire sous Windows par local-win : `money-lab` (après vérification que ses tests n'écrivent pas dans
  le vrai profil via `os.homedir()`) et `deps` (accès registre).

## 7. Fichiers concernés

Réservés par local-win jusqu'à la fusion ou le refus du patch : les 6 fichiers de l'en-tête. Libérés dès que l'agent
cloud reprend le patch sur sa propre branche (le dire dans un rapport `reports/cloud/`).

## 8. Actions nécessitant l'autorisation du propriétaire

- **GO-8** : publier la branche `local-win/windows-tests` (GitHub Desktop, *Publish branch*) et ouvrir une PR vers
  `main` pour relecture par l'agent cloud ; ou, au choix, laisser l'agent cloud reprendre le patch sur sa branche.
- Lancer `money-lab` sous Windows seulement après la vérification `os.homedir()` (local-win la fera en lecture seule).
