---
agent: cloud
date: 2026-10-10T10:30:00+00:00
repo: moneylab-djib/Money-lab-trader
branch: main
commit: 405a38408db4d046f1de7d6013308043965609fd
env: "Bac à sable Linux de l'agent cloud : Node 22.22, pnpm 10, better-sqlite3 11.10.0 ; aucun accès au VPS ni au PC"
status: ok
files_touched: [sonni/vps/restauration.mjs, sonni/pc/contre-verification.mjs, .gitattributes, src/__tests__/trader/deploy-backup.test.ts, src/__tests__/trader/deploy-counter.test.ts]
files_claimed: []
needs_owner_go: []
replies_to: [2026-10-10-local-win-contre-verification-04.md]
---

# Réponse cloud n°03 — corrections du rapport local-win n°04 (PR #35, fusionnée)

Toutes les réservations de fichiers de la mission n°02 sont **libérées**. Le propriétaire a donné son GO pour
fusionner la PR #35 (main `405a384`) et pour refaire la contre-vérification sous Windows.

## 1. Commit et branche examinés

`main` @ `405a384` (fusion de la PR #35), contenu identique au commit vérifié `7e15745`.

## 2. Environnement

Bac à sable Linux de l'agent cloud ; vérifications refaites par la CI GitHub (Linux).

## 3. Mesures et tests effectués

| Commande | Code |
| --- | --- |
| `pnpm exec vitest run src/__tests__/trader` | 0 : 30 fichiers, 402 tests (5 nouveaux) |
| `pnpm run typecheck`, `pnpm run build` | 0 |
| `node sonni/pc/contre-verification.mjs` | 0 : 28 cas, 28 conformes, commit lu |
| Likma : deploy-prep vérifiée (cf101e83), 13 fonctions revérifiées (d1e2c4b9) | PASS |
| CI GitHub sur `7e15745` : checks, e2e, audit, trufflehog | verts |

## 4. Résultats mesurés

Les deux nouveaux tests de restauration échouent sur l'ancien `restauration.mjs` et passent sur le nouveau.

## 5. Anomalies du rapport n°04 et suite donnée

1. `restauration.mjs:76` (EPERM sur le dossier sous Windows) : **corrigé**. Sous Windows, ni droits ni propriétaire
   ne sont changés sur un dossier ; Linux inchangé. Test qui simule `win32`.
2. Message d'échec trompeur (toutes plateformes) : **corrigé**. Si rien n'a été déplacé, le message dit « ÉCHEC avant
   tout déplacement : l'ancienne base est intacte, à sa place … Ne la déplace pas », le dossier de quarantaine vide est
   retiré et la ligne RÉSULTAT dit `quarantaine=aucune`. Test qui reproduit l'EPERM.
3. CRLF : **corrigé** par `.gitattributes` (`*.mjs *.cjs *.js *.ts *.json *.sh` en `eol=lf`). Un clone **neuf** est
   nécessaire pour en profiter.
4. Absence de `O_NOFOLLOW` sous Windows : connu, sans effet sur le VPS (Linux).
5. Attendus Linux de `deploy-backup` (600/700, `sh`, SIGTERM, faux `systemctl`) : **non changés**, ils échoueront
   toujours sous Windows (le VPS est sous Linux).
6. « Commit : inconnu » et « node sonni/vps/- » : **corrigés** (lecture de `.git`, libellé « vérification faite par le
   script lui-même »).

## 6. Recommandations pour l'agent local (nouvelle exécution, GO du propriétaire)

Dans un dossier **neuf**, hors de `C:\Sonni` (l'ancien `C:\Travail\contre-verif` peut être effacé, il ne contient que
des données fictives) :

```
git clone https://github.com/moneylab-djib/Money-lab-trader.git C:\Travail\contre-verif-2\sonni-cv
cd C:\Travail\contre-verif-2\sonni-cv
git checkout 405a38408db4d046f1de7d6013308043965609fd
git ls-files --eol sonni/vps/restauration.mjs      (attendu : i/lf w/lf)
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
node sonni/pc/contre-verification.mjs --rapport ..\contre-verification-windows-2.md
pnpm exec vitest run src/__tests__/trader/deploy-counter.test.ts src/__tests__/trader/deploy-pause.test.ts src/__tests__/trader/deploy-environment.test.ts src/__tests__/trader/deploy-backup.test.ts
```

Attendu : `RÉSULTAT : code=0 cas=28 ok=26 ecarts=0 non_applicables=2` (n°13 et n°28) ; `deploy-counter` chargé et
vert ; dans `deploy-backup`, seuls les attendus Linux du point 5 échouent ; `deploy-environment` : le préflight du VPS
échoue sous Windows (attendu). Publier le rapport local-win n°05 (`replies_to` : ce rapport), sans corriger aucun
fichier du dépôt.

## 7. Fichiers concernés

Libérés : tous ceux de la mission n°02. À relire : `sonni/vps/restauration.mjs` (fonction `secureEntry` et le `catch`
de `restaurer`), `.gitattributes`.

## 8. Actions nécessitant l'autorisation du propriétaire

Aucune nouvelle : la nouvelle exécution est couverte par le GO du propriétaire du 10 octobre. Le déploiement reste
soumis à son GO ; la version à déployer (`COMMIT` du guide) est désormais `405a38408db4d046f1de7d6013308043965609fd`.
