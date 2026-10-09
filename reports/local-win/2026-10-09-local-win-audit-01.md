---
agent: local-win
date: 2026-10-09T13:35:00+02:00
repo: moneylab-djib/Money-lab-trader
branch: main
commit: fd5916d2a0fcef6ac2142cc44b0c9c380e036a21
env: "Windows 11 Famille 26200, Ryzen 5 5500, 32 Go, Radeon RX 9070 XT 16 Go (pilote 32.0.31041.1004 du 2026-08-17), Windows PowerShell 5.1.26100 ; llama.cpp build 11500 Vulkan ; Tailscale actif ; Node/pnpm/git/pwsh/python ABSENTS du PATH"
status: issues
files_touched: []
files_claimed: []
needs_owner_go: [GO-3-nodejs-portable, GO-4-e2e]
---

# Rapport de vérification local-win n°01 — audit lecture seule du PC

Mesures réelles prises par `.likma/checks/local-win/audit-readonly.ps1 -ListDevices` (script lecture seule, dossier
ignoré par git), exécuté le 2026-10-09 à 13:34:53 depuis une session Claude Code locale, PowerShell 5.1.
Aucune modification du système, aucun processus arrêté, aucune clé lue (`cle.txt` : existence et taille seulement).

## 1. Commit et branche examinés

`main` @ `fd5916d` (merge PR #29, 2026-10-08). Clone frais, `node_modules`/`dist`/`.env` absents. `git` n'est pas sur
le PATH de PowerShell : le clone a probablement été fait par GitHub Desktop (git embarqué). Branche distante en avance
sur `main` : `claude/sonni-ci-gate` (9 commits du 2026-10-09) — réservée à l'agent cloud, non touchée.

## 2. Environnement

| Élément | Mesure |
| --- | --- |
| OS | Windows 11 Famille 10.0.26200, démarré le 2026-10-08 16:46 (uptime 21 h) |
| CPU / RAM | Ryzen 5 5500 (6c/12t) ; 31,9 Go dont **4,9 Go libres** pendant l'audit |
| Disque C: | 193,7 Go libres |
| PowerShell | 5.1.26100.9444 (Desktop) ; `pwsh` (7.x) **absent** ; ExecutionPolicy `Undefined` (donc Restricted par défaut : les scripts exigent `-ExecutionPolicy Bypass`) |
| Outils dev | **node, npm, corepack, pnpm, git, python, likma : absents du PATH** ; Build Tools C++ : absents |
| OpenSSH | `ssh.exe` / `sftp.exe` présents (System32\OpenSSH) |
| Tailscale | `tailscale.exe` présent (Program Files), service `Tailscale` Running/Automatic |
| GPU | AMD Radeon RX 9070 XT, pilote 32.0.31041.1004 daté 2026-08-17 (cohérent avec Adrenalin 26.8.1 du guide), statut OK. `Win32_VideoController.AdapterRAM` = 4 Go : artefact WMI 32 bits connu, ignorer. `llama-server --list-devices` : **Vulkan0 : 16304 MiB** |

## 3. Tests effectués (tous en lecture seule)

1. Inventaire des fichiers `C:\Sonni` (existence/taille/noms uniquement).
2. Processus et tâches planifiées (`Get-Process`, `Get-ScheduledTask` + `Get-ScheduledTaskInfo`).
3. `GET http://127.0.0.1:8080/health` ; `GET /v1/models` sans clé ; `netstat -ano` port 8080.
4. `tailscale status`, `tailscale serve status`.
5. `Win32_VideoController`, compteurs GPU, journal System (Display 4101, Kernel-Power 41, EventLog 6008, 14 jours), `llama-server --version` et `--list-devices` (processus court, séparé du serveur en cours).
6. Extraits filtrés de `C:\Sonni\logs` (superviseur, dernier `llama-*.log`, sauvegarde).

## 4. Résultats mesurés

**Second cerveau (llama.cpp / Qwen)**
- `llama-server.exe` build **11500** (version 0.6.0-dev, commit 097f5b5, Clang 20.1.8), fichiers du 2026-10-08 12:28 ; `ggml-vulkan.dll` présent.
- Modèle : `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`, 20,61 Go. Modèle de secours gpt-oss-20b **non téléchargé**. `options.txt`, `modele.txt`, `PAUSE` absents (config par défaut, aucune option `--n-cpu-moe`).
- Processus `llama-server` PID 7368, démarré 2026-10-08 17:41:53 (**~20 h sans interruption**), working set 8,9 Go, 6610 s CPU cumulés.
- `/health` → `{"status":"ok"}` en 58 ms ; `/v1/models` sans clé → **401** (attendu). Écoute `127.0.0.1:8080` (PID 7368) et `100.x.y.z:8080` tenu par `tailscaled` (le relais `tailscale serve`), conforme au guide.
- Mémoire GPU dédiée utilisée : **~15,7 Go sur 16** (compteur `GPU Adapter Memory`) → le modèle est bien majoritairement sur la carte. (`--list-devices` annonçait 13 940 MiB « free » en parallèle : valeur Vulkan non fiable quand un autre processus occupe la carte ; se fier au compteur.)
- Vitesses (12 dernières requêtes du journal, 4 slots, contexte 32k) : **génération 25,6 – 27,3 tokens/s (≈ 26,7 en moyenne, ~37 ms/token)** ; **prompt 329 – 593 tokens/s**. Référence du guide (2026-10-08) : 30 tokens/s → cohérent, légèrement en dessous (charge réelle, plusieurs slots).
- Chargement du modèle : 22,6 s (`load_model` → `listening`).

**Tâches planifiées**
- `Sonni second cerveau` : **Running** (0x41301), déclencheur LogonTrigger, dernière exécution 2026-10-08 17:41:53.
- `Sonni sauvegarde` : Ready, dernière exécution **2026-10-09 05:15:02, résultat 0x0**, prochaine 2026-10-10 05:15, DailyTrigger.

**Sauvegarde de la mémoire**
- `sauvegarde.log` : `2026-10-09T05:15:05 OK : copie du 2026-10-09 recuperee et verifiee (SHA-256 identique), 3.3 Mo` (la veille : 1,9 Mo). 2 copies présentes dans `C:\Sonni\sauvegardes` (noms seulement).

**Tailscale**
- `sonni-pc` (windows) et `sonni-vps` (linux, tagged-devices) listés ; liaison **active, directe** (pas de relais DERP), ~2,5 Mo émis / 5,2 Mo reçus depuis le démarrage.
- `tailscale serve status` : `tcp://sonni-pc.<tailnet>.ts.net:8080` (tailnet only) → `tcp://127.0.0.1:8080`. Conforme à l'étape 17 du guide.

**Journaux**
- `superviseur.log` : 5 démarrages le 2026-10-08, dont 2 arrêts `code -1` (16:26:05 après 7 min ; 17:38:56 après 52 min) suivis d'une relance automatique à 15 s, puis « superviseur demarre » à 17:41:53 (redémarrage de la tâche, probablement manuel). Aucun redémarrage depuis.
- Journal System : **Kernel-Power 41 + EventLog 6008 le 2026-10-08 16:46** (arrêt brutal / perte d'alimentation la veille, au moment du boot actuel). Aucun reset de pilote graphique (4101) sur 14 jours.

## 5. Problèmes observés

1. **Aucun outil de développement sur ce PC** (Node, pnpm, corepack, git, pwsh, Build Tools) : les checks Likma (`types`, `sonni`, `money-lab`, `build`, `sonni-e2e`) ne peuvent pas tourner en l'état. Voir §7.
2. **Deux sorties `code -1` de llama-server le 2026-10-08** (16:26, 17:38) avant la session stable actuelle. Cause non déterminée dans cet audit : les journaux `llama-*.log` correspondants n'ont pas été lus (seul le dernier l'a été). À examiner au prochain passage (grep `out of memory` / `failed` dans les deux fichiers de 16:18 et 16:26-17:39).
3. **Arrêt brutal du PC le 2026-10-08 16:46** (Kernel-Power 41 / 6008) : à relier à l'historique du propriétaire (coupure, reset, plantage ?). Rappel : le guide prévoit « Restore on AC/Power Loss » dans le BIOS ; le PC est bien revenu et le second cerveau aussi.
4. **RAM libre faible (4,9 Go / 32)** avec `--load-mode none` (modèle lu en RAM) + working set llama 8,9 Go. Pas d'erreur observée, mais peu de marge si une autre application lourde est lancée (jeu, navigateur) : à surveiller ; `options.txt` reste disponible.
5. Taille du journal `llama-2026-10-08_17-41-53.log` affichée « 1 Ko » alors qu'il contient 20 h d'activité : NTFS ne met à jour la taille d'un fichier ouvert qu'à sa fermeture ; artefact, pas un problème.
6. Modèle de secours `gpt-oss-20b-MXFP4.gguf` absent de `C:\Sonni\modeles` : l'étape 22 du guide (bascule) ne serait pas possible immédiatement.
7. Script d'audit v1 : le filtre laissait passer une adresse IPv6 publique, le nom du tailnet et l'identifiant du compte Tailscale (retirés à la main de ce rapport) ; la statistique tokens/s et la lecture `powercfg` échouaient (regex). Corrigé en v2 du script (déposée dans le même dossier), à relancer.

## 6. Recommandations pour l'agent cloud

- `sonni/GUIDE-PC.fr.md` : la mesure réelle en production est **~27 tokens/s** (4 slots, 32k) plutôt que 30 ; la version llama.cpp installée est **b11500** (le guide cite b11494 en exemple). `pc-scripts.test.ts` : prévoir le cas « seul Windows PowerShell 5.1 est présent » (c'est la réalité de ce PC : pas de `pwsh`), au moins un parse 5.1 des deux `.ps1`.
- Documenter dans le guide que `Win32_VideoController.AdapterRAM` et `--list-devices … free` ne sont pas fiables pour juger la VRAM ; le compteur `GPU Adapter Memory\Dedicated Usage` l'est.
- Rien à changer côté code d'après ces mesures : le second cerveau, le relais Tailscale et la copie de nuit fonctionnent comme spécifié (§4).
- Fichiers que local-win pourrait proposer de modifier plus tard (après GO propriétaire) : `sonni/GUIDE-PC.fr.md`, `src/__tests__/trader/pc-scripts.test.ts`. Aucun réservé pour l'instant.

## 7. Vérifications nécessitant l'autorisation du propriétaire

- **GO-3-nodejs-portable** : pour exécuter `dev-checks.ps1` sans toucher au système, utiliser un **Node.js LTS portable** (archive zip officielle décompressée dans `.likma/checks/local-win/tools/node/`, PATH prépendé uniquement dans la session du script ; `corepack` fourni avec). `better-sqlite3` utilisera son binaire préconstruit pour cette version de Node (pas de Build Tools). Alternative : installation système `winget install OpenJS.NodeJS.LTS` (+ Git) — modification du PC.
- **GO-4-e2e** : `pnpm run build` + `node sonni/e2e.mjs` (~10 min CPU, aucun appel réel) — à lancer seulement hors des heures de charge du second cerveau.
- **GO-6** : lire les deux journaux `llama-*.log` du 2026-10-08 (16:18 et 16:26) pour expliquer les sorties `code -1` (lecture seule, filtrée).

## 8. Fichiers réservés / libérés

Aucun fichier du dépôt réservé ni modifié. Seul le dossier ignoré par git `.likma/checks/local-win/` contient les scripts
et ce rapport.
