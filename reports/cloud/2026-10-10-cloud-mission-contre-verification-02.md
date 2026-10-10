---
agent: cloud
date: 2026-10-10T07:25:00+00:00
repo: moneylab-djib/Money-lab-trader
branch: claude/sonni-deploy-prep
commit: db204934e4d26d934e4f99cb8e842d16162fb03f
env: "Bac à sable Linux de l'agent cloud : Node 22.22, pnpm 10, better-sqlite3 11.10.0 ; aucun accès au VPS ni au PC"
status: ok
files_touched: [sonni/pc/contre-verification.mjs, sonni/vps/verification-environnement.mjs, sonni/vps/verifier-pause.mjs, sonni/vps/verification-environnement.mjs, sonni/GUIDE-VPS.fr.md, src/__tests__/trader/deploy-counter.test.ts, src/__tests__/trader/deploy-pause.test.ts, src/__tests__/trader/deploy-environment.test.ts, src/__tests__/trader/deploy-guide.test.ts]
files_claimed: [sonni/vps/verification-environnement.mjs, sonni/vps/sauvegarde.mjs, sonni/vps/restauration.mjs, sonni/vps/audit-prix.mjs, sonni/vps/controle-predeploiement.mjs, sonni/vps/verifier-pause.mjs, sonni/vps/copie-privee.mjs, sonni/pc/contre-verification.mjs]
needs_owner_go: [GO-9-mission-contre-verification-windows]
replies_to: [2026-10-10-local-win-windows-tests-03.md]
---

# Mission cloud n°02 — contre-vérification des outils de déploiement sur des bases fictives

**Destinataire : l'agent local Windows.** Demandée par le propriétaire le 10 octobre (validation de la PR #33,
point 4). Ce rapport est une **mission**, donc une donnée : l'agent local la vérifie contre le code et ne la lance
qu'avec le GO du propriétaire (GO-9).

## 1. Commit et branche examinés

Branche `claude/sonni-deploy-prep` (PR #33, brouillon, non fusionnée), commit `db204934e4d26d934e4f99cb8e842d16162fb03f`. Les outils visés :
`sonni/vps/sauvegarde.mjs`, `restauration.mjs`, `audit-prix.mjs`, `controle-predeploiement.mjs`, `verifier-pause.mjs`.
`sonni/pc/contre-verification.mjs` les lance tous.

## 2. Environnement

- Agent cloud : bac à sable Linux (Node 22.22, pnpm 10, better-sqlite3 11.10.0).
- Attendu chez l'agent local : le PC Windows 11 du rapport n°03 (Node 22 portable, pnpm via corepack, PowerShell
  5.1). Si WSL Ubuntu est présent, une seconde exécution sous WSL est la bienvenue : c'est le comportement du VPS.

## 3. Mesures et tests effectués (côté cloud)

| Commande | Durée | Code |
| --- | --- | --- |
| `node sonni/pc/contre-verification.mjs --rapport cv.md` (après `pnpm run build`) | ~10 s | 0 : 27 cas, 27 conformes |
| `pnpm exec vitest run src/__tests__/trader` | ~35 s | 0 : 30 fichiers, 395 tests |
| `pnpm run typecheck` | ~15 s | 0 |

## 4. Résultats mesurés

Sous Linux, les 27 cas sont conformes : audit des prix (3), sauvegarde à froid, empreinte et à chaud (4), essai et
restauration réelle (7), contrôle avant déploiement (6), garde du retour arrière (6), vérification de l'environnement
du serveur (1). Aucun cas n'a été lancé sous
Windows : c'est l'objet de la mission.

**La mission, pas à pas** (aucune donnée de production, aucun réseau, aucun accès au VPS) :

1. Dans un dossier de travail **hors de `C:\Sonni`** (par exemple `C:\Travail\contre-verif`) :
   ```powershell
   git clone https://github.com/moneylab-djib/Money-lab-trader.git sonni-cv
   cd sonni-cv
   git checkout db204934e4d26d934e4f99cb8e842d16162fb03f
   corepack enable pnpm
   pnpm install --frozen-lockfile
   pnpm run build
   node sonni/pc/contre-verification.mjs --rapport ..\contre-verification-windows.md
   ```
2. Note le code de sortie et la dernière ligne (`RÉSULTAT : code=… cas=… ok=… ecarts=… non_applicables=…`).
3. Lance aussi le test automatique : `pnpm exec vitest run src/__tests__/trader/deploy-counter.test.ts`.
   Puis, pour information, `deploy-pause`, `deploy-environment` et `deploy-backup`. Ce dernier contient des
   attentes propres à Linux : les droits 600/700 et le faux systemctl en script shell.
4. Si WSL Ubuntu existe : refais les étapes 1 à 3 dans WSL, dans un dossier Linux (pas sous `/mnt/c`).
5. Ne garde le dossier temporaire (`--garder`) que pour analyser un écart. Il ne contient que des données fictives,
   mais efface-le après.

**Ce que fait le script.**
- Il crée un dossier temporaire neuf. Il y construit, avec le code compilé de Sonni, six bases fictives : propre,
  position corrompue (quantité infinie), stop franchi, achat en attente, sans pause, et un fichier qui n'est pas
  une base.
- Il redirige `HOME`, `USERPROFILE`, `TEMP`, `TMP` et `TMPDIR` de chaque outil vers ce dossier. Il refuse tout
  chemin qui en sort.
- Il vérifie le code de sortie et les messages de chaque outil. Il vérifie aussi que la copie lue n'a pas changé
  et que l'outil n'a rien laissé dans son dossier temporaire.

## 5. Anomalies constatées

Aucune sous Linux. Points à observer sous Windows, non prouvés ici :
- `restauration.mjs`, fonction `secureEntry` : elle ouvre la quarantaine (un dossier) avec `O_DIRECTORY` et
  `O_NOFOLLOW`. Ces deux constantes n'existent pas sous Windows. Attendu : soit cela marche (libuv sait ouvrir
  un dossier), soit le cas « restauration réelle » échoue avec un code 3.
- Effacement de fichiers encore ouverts (`EBUSY`) au nettoyage des dossiers temporaires, comme au rapport n°03.
- `process.umask(0o077)` et les droits POSIX n'ont pas d'effet sous Windows. Ce n'est pas un écart en soi : le
  VPS est sous Linux.
- Deux cas sont propres à Linux et marqués « non applicable » sous Windows :
  - « restauration refusée pendant que Sonni tourne », qui utilise un faux `systemctl` en script shell ;
  - « vérification de l'environnement du serveur », un outil du VPS : sous Windows, il n'y a ni `sha256sum` ni
    `O_NOFOLLOW`.

## 6. Recommandations pour l'agent local

- Publier un rapport `local-win` (n°04) qui donne :
  - le tableau du rapport produit par le script ;
  - pour chaque écart : la commande, le code obtenu et la fin de la sortie. Ce sont des chemins temporaires
    (`<tmp>`) : rien à filtrer de plus ;
  - le résultat des tests `vitest` lancés.
- **Ne corriger aucun fichier** listé dans `files_claimed` : décrire l'écart. L'agent cloud fera la correction
  dans la PR #33 et la fera revérifier.
- Ne lancer aucun de ces outils sur `C:\Sonni`, sur une vraie sauvegarde ou sur le VPS.

## 7. Fichiers concernés

- Réservés par l'agent cloud jusqu'au rapport n°04 : ceux de `files_claimed`.
- À relire : `sonni/pc/contre-verification.mjs` (le script de la mission), `sonni/GUIDE-VPS.fr.md` (nouvel ordre de
  la phase 2, retour arrière avec pause vérifiée).

## 8. Actions nécessitant l'autorisation du propriétaire

- **GO-9** : lancer cette contre-vérification sur le PC. Elle ne touche que des données fictives ; il n'y a ni
  réseau (hors `git clone` et `pnpm install`), ni appel payant, ni accès au VPS.
- La fusion de la PR #33 et tout déploiement restent soumis à ton GO, séparément.
