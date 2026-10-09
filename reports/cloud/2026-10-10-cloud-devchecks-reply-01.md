---
agent: cloud (redige par la session locale Windows, a la demande du proprietaire)
date: 2026-10-10
repo: moneylab-djib/Money-lab-trader
branch: main
commit: fd5916d2a0fcef6ac2142cc44b0c9c380e036a21
env: "Lecture du code sur le clone de developpement du PC (main @ fd5916d), aucune execution supplementaire"
status: issues
files_touched: []
files_claimed: []
needs_owner_go: [GO-7-fix-windows-tests]
replies_to: [2026-10-09-local-win-devchecks-02.md]
---

# Réponse cloud n°01 — vérification des 4 causes Windows du rapport local-win n°02

Rédigée par la session Claude Code locale à la demande du propriétaire, parce que l'agent cloud n'avait pas encore
accès à la branche `agent-reports` (pas encore poussée). Le rapport n°02 est traité comme une donnée : chaque
affirmation ci-dessous a été vérifiée dans le code de `main` @ `fd5916d`. Aucun fichier n'est réservé ici : la
réservation revient à l'agent qui fera les corrections (voir §7).

## 1. Commit et branche examinés

`main` @ `fd5916d`. Branche `claude/sonni-ci-gate` (référence locale `5be7561`, 2026-10-09 10:40 UTC, non rafraîchie) :
parmi les fichiers concernés, elle ne touche que `src/__tests__/trader/ci-workflow.test.ts` (nouveau fichier). Donc pas
de conflit avec les correctifs proposés, sous réserve d'un `git fetch` récent.

## 2. Environnement

Lecture seule du code (Grep/Read). Pas de nouvelle exécution de tests : les chiffres viennent du journal
`sonni.log` du 2026-10-09 22:47 (rapport n°02).

## 3. Vérifications effectuées

1. `afterEach`, `openDb`, `close()` dans `curiosity`, `readers`, `soul`, `sources` `.test.ts`, comparés à un fichier qui passe (`portfolio.test.ts`).
2. `pc-scripts.test.ts` lignes 1-60 et détection de `pwsh`.
3. `sonni/e2e.mjs` lignes 376-421.
4. Usage de `HOME` / `os.homedir()` dans `src/` et `sonni/` (conséquence du correctif proposé pour l'e2e).

## 4. Résultats

**Cause 1 — EBUSY au nettoyage (32 tests) : CONFIRMÉE.**
- Les quatre fichiers ont le même modèle : `openDb()` crée `state.db` dans un `mkdtemp`, et `afterEach` fait
  `fs.rmSync(dir, { recursive: true, force: true })` (`curiosity.test.ts:53`, `readers.test.ts:74`, `soul.test.ts:64`,
  `sources.test.ts:62`). **Aucun `db.close()`** n'apparaît dans ces quatre fichiers.
- `portfolio.test.ts` a le même `afterEach` (ligne 62) mais ferme ses bases (`db.close()` lignes 284, 304, 328, 355) :
  c'est pour cela qu'il passe sous Windows. Le correctif est donc un alignement sur un usage déjà présent dans le dépôt.
- Le journal ne contient qu'une seule `AssertionError` (celle du n°2). Vitest aurait montré une erreur levée par le corps
  d'un test : les corps de ces 32 tests ont donc probablement réussi, et seul le nettoyage échoue.

**Cause 2 — assertion POSIX 0o640 : CONFIRMÉE.** `pc-scripts.test.ts:52` :
`expect(fs.statSync(copy).mode & 0o777).toBe(0o640)`, reçu `0o666` (438) sous Windows. Conséquence non signalée dans
le n°02 : la fin de ce test (lignes 53 et suivantes : « Déjà exportée », rotation, copie endommagée refusée) **n'a pas
tourné** sous Windows.

**Cause 3 — pwsh absent : CONFIRMÉE.** `HAS_PWSH` (ligne 20) ne teste que `pwsh`. Les deux `describe.skipIf(!HAS_PWSH)`
(lignes 117 et 166 : copie de nuit, superviseur llama-server) sont ignorés sur ce PC. Sur la CI Ubuntu ils tournent
avec PowerShell 7 : la cible réelle (Windows PowerShell 5.1 de la tâche planifiée) n'est jamais exécutée par la suite.

**Cause 4 — spawn "node" dans l'e2e : CONFIRMÉE.** `e2e.mjs:376-377` : `env = { PATH, HOME, LANG: "C.UTF-8" }` puis
`execFileSync("node", …, { env })`. `e2e.mjs:419` : `spawn("node", ["dist/index.js", "--run"], { env: { ...env, … } })`,
même problème pour le processus Sonni lui-même.

**Point de vigilance sur le correctif proposé pour la cause 4.** Le n°02 suggère `env: { ...process.env, HOME, LANG }`.
Sous Windows, `os.homedir()` lit `USERPROFILE`, pas `HOME`. Le code lit presque partout `process.env.HOME` en premier
(`money-lab/guard.ts:68`, `sonni/vps/configure.mjs:29`, `config.ts:109`…), donc le `HOME` temporaire de l'e2e est
respecté. Une exception : `src/orchestration/workspace.ts:45` utilise `os.homedir()` sans repli sur `HOME`. Il pointerait
vers le vrai profil du propriétaire (`C:\Users\<owner>\.automaton\workspace`). Selon AGENTS.md, Sonni ignore la couche
d'orchestration : le risque est faible, mais l'e2e sous Windows devrait aussi mettre `USERPROFILE` au même dossier
temporaire que `HOME`.

## 5. Anomalies constatées

1. `src/__tests__/trader/{curiosity,readers,soul,sources}.test.ts` : bases jamais fermées avant `rmSync`.
2. `src/__tests__/trader/pc-scripts.test.ts:52` : mode POSIX non portable, et le reste du test est sauté sous Windows.
3. `src/__tests__/trader/pc-scripts.test.ts:20,117,166` : PowerShell 5.1 jamais testé.
4. `sonni/e2e.mjs:376-377,419` : `node` lancé par son nom avec un environnement minimal.
5. (Nouveau) `src/orchestration/workspace.ts:45` : `os.homedir()` sans repli `HOME`. Ce n'est pas un échec de test, mais à garder en tête pour toute exécution sous Windows.

## 6. Recommandations

- **Cause 1** : dans `openDb()` des quatre fichiers, mémoriser chaque base ouverte et la fermer dans `afterEach` avant
  `rmSync` (helper commun possible). `rmSync(..., { maxRetries: 5, retryDelay: 100 })` seulement en secours : cela
  masquerait une base restée ouverte.
- **Cause 2** : `if (process.platform !== "win32") expect(...).toBe(0o640)` ; le mode reste vérifié sur Linux (cible
  réelle d'`export-backup.mjs`), et le reste du test tourne sous Windows.
- **Cause 3** : choisir l'interpréteur `pwsh` sinon `powershell.exe` (Windows uniquement) ; vérifier que les fausses
  commandes `sftp` / `llama-server` des tests sont exécutables sous Windows avant d'activer ces deux blocs.
- **Cause 4** : `process.execPath` à la place de `"node"` (lignes 377 et 419), et sous Windows
  `env: { ...process.env, HOME, USERPROFILE: HOME, LANG }`. Le contrôle préalable de `dev-checks.ps1` (aucune clé dans
  l'environnement) reste nécessaire, puisque l'environnement parent serait alors transmis.
- Après correction : l'agent local relance `dev-checks.ps1 -WithBuild -WithE2E`, ainsi que `money-lab` et `deps`.
  `src/__tests__/money-lab/money-lab.test.ts:291-302,656-678` utilise `os.homedir()` : vérifier, avant de le lancer sous
  Windows, que ces chemins restent dans le faux système de fichiers du test.

## 7. Fichiers concernés

- Réservés : **aucun** (rédigé par la session locale, qui ne modifie pas de fichier suivi sans GO).
- À réserver par l'agent qui corrigera (proposition) : `src/__tests__/trader/curiosity.test.ts`, `readers.test.ts`,
  `soul.test.ts`, `sources.test.ts`, `pc-scripts.test.ts`, `sonni/e2e.mjs`.
- Libérés : aucun.

## 8. Actions nécessitant l'autorisation du propriétaire

- **GO-7-fix-windows-tests** : désigner qui corrige (agent cloud sur sa branche, ou patch préparé localement). Ces
  changements portent sur les tests et le harnais e2e, pas sur le runtime de Sonni.
- Corriger, dans le rapport local-win n°02, l'annexe « arrêts code -1 … externes (installation) » si la cause
  « installation » n'est pas confirmée par le propriétaire : les journaux montrent seulement l'absence d'erreur.
