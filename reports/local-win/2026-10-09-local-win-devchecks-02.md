---
agent: local-win
date: 2026-10-09T23:05:00+02:00
repo: moneylab-djib/Money-lab-trader
branch: main
commit: fd5916d2a0fcef6ac2142cc44b0c9c380e036a21
env: "Windows 11 Famille 26200, PowerShell 5.1 ; Node v22.23.3 LTS portable (zip officiel, SHA-256 vérifié) + pnpm 10.28.1 via corepack ; better-sqlite3 binaire préconstruit ; llama.cpp b11500 Vulkan (Qwen3.6-35B-A3B) en service pendant les tests"
status: issues
files_touched: []
files_claimed: []
needs_owner_go: [GO-7-fix-windows-tests]
replies_to: [2026-10-09-local-win-audit-01.md]
---

# Rapport local-win n°02 — premiers checks de développement exécutés sous Windows

Première exécution réelle des checks Likma de `likma.project.json` sur le PC du propriétaire (clone de développement,
Node portable, aucune installation système). Résultat : **le code compile et se construit sous Windows ; 3 suites de
tests et l'e2e échouent pour des raisons spécifiques à Windows, aucune n'indiquant un défaut de logique de Sonni.**

## 1. Commit et branche examinés

`main` @ `fd5916d` (merge PR #29). Arbre propre avant et après (`node_modules` et `dist` ignorés par git).
Branche `claude/sonni-ci-gate` (agent cloud) non touchée ; ses fichiers `ci.yml`, `release.yml`, `ci-workflow.test.ts`,
`context-manager.*`, `selfhosted.ts` n'ont pas été testés ici.

## 2. Environnement

Node v22.23.3 LTS (`nodejs.org/dist`, SHA-256 `2b0ff57b…ed71` vérifié contre `SHASUMS256.txt`), npm 10.9.9,
pnpm 10.28.1 (corepack, `packageManager` du `package.json`). PATH système inchangé (`tools\node-env.ps1` par session).
`better-sqlite3` a pris son **binaire préconstruit** : pas de compilation, pas de Build Tools. Deux scripts de build
ignorés par pnpm (`bufferutil`, `utf-8-validate`, optionnels) et deux avertissements sur les raccourcis `automaton`.
Garde-fou ressources : 5,4 Go de RAM libre, llama-server à 0 % CPU → étapes lourdes autorisées.

## 3. Mesures et tests effectués

| Check Likma | Commande | Durée | Résultat |
| --- | --- | --- | --- |
| setup | `pnpm install --frozen-lockfile` | 59 s | PASS |
| types | `pnpm run typecheck` | 8 s | **PASS** — aucune erreur `tsc --noEmit` |
| sonni | `pnpm exec vitest run src/__tests__/trader` | 15 s | **FAIL** — 21 fichiers : 16 OK, 5 KO ; 179 tests : 143 OK, 33 KO, 3 ignorés |
| (hors Likma) | `vitest run src/__tests__/trader/pc-scripts.test.ts` | 2 s | FAIL — 1 KO, 1 OK, 3 ignorés (pas de `pwsh`) |
| (hors Likma) | parse PowerShell 5.1 de `llm-main.ps1` et `backup-pull.ps1` | <1 s | **PASS** |
| build | `pnpm run build` (tsc + packages/cli) | 11 s | **PASS** |
| sonni-e2e | `node sonni/e2e.mjs` | 0 s | **FAIL** — plante à la première commande, scénario non exécuté |
| money-lab, deps | non lancés ce soir | — | à faire au prochain passage |

## 4. Résultats mesurés

- `typecheck` et `build` passent sous Windows : le code TypeScript, les chemins et les imports ne posent aucun problème de portabilité.
- Suite `sonni` : **32 des 33 échecs sont une seule et même cause**, `EBUSY unlink …\state.db` dans le `afterEach` qui supprime le dossier temporaire (`fs.rmSync(dir, { recursive… })`, ex. `sources.test.ts:53/62`). Fichiers touchés : `curiosity.test.ts` (8), `readers.test.ts` (6), `soul.test.ts` (10), `sources.test.ts` (8). **Une seule `AssertionError` dans tout le journal** (85 Ko) : les assertions des tests eux-mêmes réussissent ; c'est le nettoyage qui échoue parce que la connexion `better-sqlite3` est encore ouverte quand le fichier est supprimé — Linux l'accepte, Windows verrouille.
- Le 33e échec, `pc-scripts.test.ts:52` : `expect(fs.statSync(copy).mode & 0o777).toBe(0o640)` reçoit `0o666` — Windows n'a pas de droits POSIX. Les 3 tests PowerShell de ce fichier sont **ignorés** faute de `pwsh` (PowerShell 7) ; le parse 5.1 fait à part passe.
- e2e : `spawnSync node ENOENT` dès `sonni/e2e.mjs:377` (`execFileSync("node", …, { env: { PATH, HOME, LANG } })`). L'environnement minimal passé à l'enfant ne contient ni `SystemRoot` ni `PATHEXT` ; sous Windows la résolution de `node` échoue. Le scénario (faux Kraken/Anthropic/Telegram, panne) n'a donc **pas tourné** sous Windows. Le contrôle de sécurité préalable était bon : aucun secret dans le clone, hôtes de l'e2e tous locaux ou réservés (`.example`).

## 5. Anomalies constatées

1. `src/__tests__/trader/{curiosity,readers,soul,sources}.test.ts` — `afterEach` supprime `state.db` sans fermer la base : `EBUSY` sous Windows (32 tests). Cause unique.
2. `src/__tests__/trader/pc-scripts.test.ts:52` — assertion de mode POSIX `0o640` non portable (Windows renvoie `0o666`).
3. `src/__tests__/trader/pc-scripts.test.ts` — les tests des `.ps1` ne s'exécutent qu'avec `pwsh` ; la cible réelle (PowerShell 5.1, seul présent sur le PC du propriétaire) n'est jamais testée par la suite.
4. `sonni/e2e.mjs:376-377` (et `:419`, `spawn("node", …)`) — lancement de `node` par son nom avec un environnement minimal : `ENOENT` sous Windows.
5. Mineur : `pnpm install` signale deux scripts de build ignorés (`bufferutil`, `utf-8-validate`) ; sans effet (dépendances optionnelles de `ws`).

## 6. Recommandations pour l'agent cloud

- Anomalie 1 : fermer la base dans les tests avant `rmSync` (`db.close()` dans `afterEach`, ou un helper commun qui ferme toutes les connexions ouvertes), ou `rmSync(..., { maxRetries: 5, retryDelay: 100 })` en secours. Cela rendrait 32 tests verts sous Windows sans toucher au code de production.
- Anomalie 2 : conditionner l'assertion de mode à `process.platform !== "win32"` (le `0o640` reste vérifié sur le VPS Linux, qui est la cible réelle de `export-backup.mjs`).
- Anomalie 3 : dans `pc-scripts.test.ts`, détecter aussi `powershell.exe` (5.1) et exécuter les scripts avec, puisque c'est l'interpréteur de la tâche planifiée du propriétaire ; au minimum un parse 5.1 (`[System.Management.Automation.Language.Parser]::ParseFile`) sur CI Windows.
- Anomalie 4 : `process.execPath` à la place de `"node"` dans `e2e.mjs`, et `env: { ...process.env, HOME, LANG }` (ou au moins `SystemRoot`, `PATHEXT`, `TEMP` sous Windows). Je peux alors relancer l'e2e complet ici (~10 min) et rapporter le scénario de panne sous Windows.
- Ces quatre points relèvent de fichiers suivis par git : l'agent local **ne les modifie pas** sans GO du propriétaire et sans accord sur les fichiers réservés. Si tu préfères que je prépare un patch, dis-le dans ton rapport `reports/cloud/`.

## 7. Fichiers concernés

- À relire par l'agent cloud : `src/__tests__/trader/curiosity.test.ts`, `readers.test.ts`, `soul.test.ts`, `sources.test.ts`, `pc-scripts.test.ts`, `sonni/e2e.mjs`.
- Réservés par local-win : aucun. Modifiés : aucun.

## 8. Actions nécessitant l'autorisation du propriétaire

- **GO-7-fix-windows-tests** : qui corrige les 4 anomalies (agent cloud sur sa branche, ou patch préparé par local-win) ; ce sont des changements de tests et du harnais e2e, pas du runtime.
- Prochain passage local sans GO supplémentaire : `money-lab` (`vitest run src/__tests__/money-lab`) et `deps` (`pnpm audit --prod --audit-level critical`), puis relance de l'e2e dès que l'anomalie 4 est corrigée.

---
Annexe — rappel des mesures du PC (rapport n°01) : second cerveau Qwen3.6-35B-A3B à ~27,6 tokens/s en génération
(109 réponses), 483 tokens/s en prompt ; aucune erreur dans les journaux llama ; les deux arrêts `code -1` du 2026-10-08
étaient externes (installation), sans événement Windows ni erreur GPU.
