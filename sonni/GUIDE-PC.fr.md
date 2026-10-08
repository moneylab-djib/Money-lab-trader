# Le second cerveau de Sonni sur ton PC — guide pas à pas

Guide pour le propriétaire, en français. Aucune étape ne doit être faite par Sonni lui-même.
Les menus des logiciels cités changent : si un intitulé diffère un peu, cherche le plus proche.
Recherches et versions vérifiées le 8 octobre 2026 (llama.cpp, Qwen3.6, Tailscale 1.104, pilote AMD
26.8.1).

**Ce que c'est.** Ton PC fait tourner un modèle d'IA local (Qwen3.6-35B-A3B) qui travaille pour Sonni
24 h/24, gratuitement : il lit l'actualité en premier et la trie, écrit une note de situation avant
chaque réveil de Claude, joue l'avocat du diable sur ses positions, prépare les faits de ses autopsies
et répond à tes `/question` sans réveiller Claude. En mode parallèle, il donne aussi sa propre
probabilité pour chaque pari de Claude, et le code note les deux.

**Ce qu'il ne fait jamais.** Il ne passe aucun ordre, ne change aucun réglage, n'écrit aucune
statistique. Tout ce qu'il écrit est montré à Claude comme une donnée « non fiable », à vérifier.
Claude décide, le code calcule.

**Comment c'est relié.** Ton PC et le serveur de Sonni (le VPS) se parlent par **Tailscale**, un réseau
privé chiffré entre tes appareils. Aucun port n'est ouvert sur ta box ni sur internet. Le serveur ne
peut joindre **qu'un seul port** de ton PC (celui du modèle), avec une clé. Ton PC ne reçoit jamais
la clé Anthropic ni le jeton Telegram.

**Si ton PC s'éteint.** Rien n'est perdu. Le serveur tient la liste des tâches. Une tâche coupée en
plein travail repart d'elle-même (3 essais), une tâche devenue inutile est abandonnée, et Claude
n'attend jamais le PC. Sonni continue avec les IA lectrices gratuites (Gemini, Groq), la veille du code
et Claude. Au retour du PC, le serveur le voit en une minute et reprend par les tâches les plus
fraîches. Au-delà de 2 heures d'absence, c'est noté dans `/technique`.

**Coût.** L'électricité de ton PC n'est pas comptée dans les 50 €/mois de Sonni (ta décision du
8 octobre). Ordre de grandeur à vérifier avec une prise wattmètre : 50 à 100 kWh par mois selon
l'usage, soit environ 10 à 20 € au tarif réglementé.

**Ce qu'il te faut :** ton PC (Ryzen 5 5500, 32 Go, Radeon RX 9070 XT 16 Go : il convient), **40 Go
libres** sur un SSD, idéalement un câble Ethernet plutôt que le Wi-Fi, ton accès au serveur de Sonni
(`ssh root@ADRESSE_IP`, comme dans `sonni/GUIDE-VPS.fr.md`), ton téléphone avec Telegram, environ
2 heures (dont le téléchargement du modèle).

> **Pour toutes les commandes Windows :** ouvre **Terminal (administrateur)** (clic droit sur le
> bouton Démarrer → *Terminal (administrateur)*, ou *Windows PowerShell (admin)* sous Windows 10), avec
> ton compte habituel. Colle une ligne (clic droit dans la fenêtre), appuie sur **Entrée**, attends la
> fin avant la suivante. Si une ligne affiche une erreur en rouge, arrête-toi et envoie-moi le message
> (sans clé ni mot de passe). Les commandes du serveur se tapent dans ta session `ssh`, comme dans le
> guide du VPS.

---

## Avant de commencer — Mettre Sonni à jour

Le second cerveau arrive avec l'étape 3 du plan du 8 octobre. Fusionne d'abord les demandes de fusion
dans l'ordre (étape 1 « décider pour de vrai », étape 2 « univers vivant », étape 3 « second
cerveau »), puis suis **« Mettre Sonni à jour »** dans `sonni/GUIDE-VPS.fr.md`. La ligne
`configure.mjs` ajoute à sa configuration le bloc du second cerveau (adresse `http://sonni-pc:8080/v1`).
Tant que tu ne lui donnes pas la clé (étape 19), Sonni ne l'appelle jamais : tu peux mettre à jour
maintenant et préparer le PC plus tard.

Vérifie sur le serveur :
```sh
grep -A2 '"secondBrain"' /home/sonni/.automaton/automaton.json
```
Tu dois voir `"baseUrl": "http://sonni-pc:8080/v1"`.

---

## Partie 1 — Préparer Windows (une seule fois)

### Étape 1 — Le pilote de la carte graphique

1. Installe **AMD Software: Adrenalin Edition 26.8.1** (WHQL) ou plus récent depuis
   https://www.amd.com/fr/support (choisis ta carte : Radeon RX 9070 XT). L'installation « par défaut »
   suffit.
2. Dans AMD Software : roue dentée (*Réglages*) → *Système* → désactive le téléchargement et
   l'installation automatiques des mises à jour (les intitulés varient selon la version). Un pilote
   qui s'installe tout seul relance la carte graphique en plein travail ; tu le mettras à jour
   toi-même une fois par mois (voir « Mettre à jour »).
3. Redémarre le PC.

### Étape 2 — Un PC qui ne dort jamais

Dans le terminal administrateur :
```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 10
powercfg /hibernate off
```
Le PC ne se met plus en veille ; seul l'écran s'éteint après 10 minutes. La dernière ligne coupe
aussi le « démarrage rapide », qui gêne les redémarrages propres.

### Étape 3 — Redémarrer tout seul après une coupure de courant (BIOS)

1. Redémarre et appuie plusieurs fois sur **F2** ou **Suppr** pendant le démarrage : l'écran du BIOS
   ASRock s'ouvre. S'il est en mode simplifié (*EZ Mode*), appuie sur **F6** pour le mode avancé.
2. Va dans **Advanced → Onboard Devices Configuration** → **Restore on AC/Power Loss** → choisis
   **Power On**.
3. **F10**, puis *Yes* pour enregistrer et redémarrer.

Après une coupure de courant, le PC se rallume seul.

### Étape 4 — Les mises à jour de Windows sans surprise

*Paramètres → Windows Update → Options avancées → Heures d'activité* : choisis *Manuellement*, de
**8 h à 2 h** (18 heures au plus). Windows ne redémarrera pour ses mises à jour qu'entre 2 h et 8 h ;
le second cerveau revient seul quelques minutes après (étapes 5 et 12), et Sonni continue sans lui
pendant ce temps.

### Étape 5 — Ouvrir ta session tout seul au démarrage

Le modèle utilise la carte graphique depuis ta session Windows : après un redémarrage, il ne repart
que quand ta session est ouverte. Pour un PC qui redémarre la nuit sans toi, Windows doit ouvrir ta
session tout seul.

1. Si tu te connectes avec un compte Microsoft : *Paramètres → Comptes → Options de connexion* →
   désactive « *Pour plus de sécurité, autoriser uniquement la connexion Windows Hello pour les
   comptes Microsoft sur cet appareil* ».
2. Télécharge **Autologon** de Microsoft (Sysinternals) :
   https://learn.microsoft.com/sysinternals/downloads/autologon → *Download Autologon*. Décompresse,
   lance `Autologon64.exe`, accepte la licence.
3. *Username* : ton nom d'utilisateur Windows (pour un compte Microsoft, ton adresse e-mail) ;
   *Domain* : laisse ce qui est proposé ; *Password* : ton mot de passe Windows (pas le code PIN).
   Clique **Enable**.
4. Pour que ta session ouverte toute seule se verrouille quand personne ne s'en sert (10 minutes) :
   ```powershell
   New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -PropertyType DWord -Value 600 -Force | Out-Null
   ```
5. Redémarre : ta session doit s'ouvrir sans rien taper, puis se verrouiller après 10 minutes.

**Bon à savoir.** Autologon garde ton mot de passe chiffré dans Windows ; quelqu'un qui a déjà les
droits administrateur sur ce PC pourrait le lire. Si tu changes ton mot de passe Windows, relance
Autologon. Si tu préfères ne pas l'activer, saute cette étape : après chaque redémarrage, le second
cerveau ne reviendra qu'à ta prochaine connexion, et Sonni continuera sans lui en attendant.

---

## Partie 2 — Le moteur et le modèle

### Étape 6 — Le dossier `C:\Sonni`, réservé à ton compte

```powershell
New-Item -ItemType Directory -Force C:\Sonni, C:\Sonni\modeles, C:\Sonni\logs | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls C:\Sonni /inheritance:r /grant:r "*${sid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```
La dernière ligne doit finir par « Successfully processed 1 files » (ou « 1 fichiers correctement
traités »). Seuls ton compte, Windows et les administrateurs peuvent lire ce dossier : il contiendra la
clé du second cerveau et les copies de la mémoire de Sonni.

### Étape 7 — Installer le moteur llama.cpp (version Vulkan, pour ta carte AMD)

1. Installe le **Visual C++ Redistributable x64** de Microsoft (souvent déjà présent) :
   https://aka.ms/vs/17/release/vc_redist.x64.exe → *Installer* (s'il dit « déjà installé »,
   ferme).
2. Télécharge la dernière version Windows Vulkan de llama.cpp et décompresse-la dans
   `C:\Sonni\llama` :
   ```powershell
   [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
   $releases = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20'
   $zip = foreach ($r in $releases) { foreach ($a in $r.assets) { if ($a.name -like 'llama-b*-bin-win-vulkan-x64.zip') { $a } } }
   $zip = $zip | Select-Object -First 1; $zip.name
   curl.exe -fL -o "C:\Sonni\$($zip.name)" $zip.browser_download_url
   Expand-Archive -Path "C:\Sonni\$($zip.name)" -DestinationPath C:\Sonni\llama -Force
   Remove-Item "C:\Sonni\$($zip.name)"
   Test-Path C:\Sonni\llama\llama-server.exe
   ```
   La ligne `$zip.name` affiche un nom comme `llama-b11494-bin-win-vulkan-x64.zip` ; la dernière doit
   répondre **True**. (À la main : sur https://github.com/ggml-org/llama.cpp/releases, la version
   marquée *Latest* n'a pas toujours de fichiers Windows : prends la plus récente nommée `bNNNNN`, et
   dans *Assets* le fichier `llama-bNNNNN-bin-win-vulkan-x64.zip`.)
3. Vérifie que llama.cpp voit ta carte :
   ```powershell
   C:\Sonni\llama\llama-server.exe --list-devices
   ```
   Tu dois voir une ligne **Vulkan0** avec *AMD Radeon RX 9070 XT* et environ 16 000 MiB. Sinon,
   réinstalle le pilote (étape 1) et redémarre.

### Étape 8 — Télécharger le modèle (environ 21 Go)

Le modèle choisi est **Qwen3.6-35B-A3B**, version `UD-Q4_K_M` d'Unsloth : 35 milliards de paramètres
dont 3 actifs à la fois, rapide sur ta carte, et le code de llama.cpp place lui-même ce qui ne tient
pas dans les 16 Go de la carte dans la mémoire du PC.
```powershell
curl.exe -fL -C - -o C:\Sonni\modeles\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf
```
Compte 10 minutes à 1 heure selon ta connexion. Si le téléchargement s'arrête, relance exactement la
même ligne : `-C -` reprend où il s'était arrêté. (Page du modèle :
https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF, fichier `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`.)

**Le modèle de secours** (plus petit, 12 Go, tient entièrement dans la carte : plus rapide, un peu
moins fin), à garder sous la main pour l'étape 22 :
```powershell
curl.exe -fL -C - -o C:\Sonni\modeles\gpt-oss-20b-MXFP4.gguf https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-MXFP4.gguf
```

### Étape 9 — La clé du second cerveau

Une clé aléatoire que seul le serveur de Sonni connaîtra :
```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
Set-Content -Path C:\Sonni\cle.txt -Value (-join ($bytes | ForEach-Object { $_.ToString('x2') })) -NoNewline -Encoding Ascii
(Get-Content C:\Sonni\cle.txt).Length
```
La dernière ligne doit afficher **64**. Ne colle jamais cette clé ailleurs que dans le fichier du
serveur (étape 19) : ni dans une discussion, ni dans un e-mail.

### Étape 10 — Premier essai, à la main

1. Lance le modèle dans le terminal :
   ```powershell
   C:\Sonni\llama\llama-server.exe -m C:\Sonni\modeles\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf --alias qwen3.6-35b-a3b --host 127.0.0.1 --port 8080 --api-key-file C:\Sonni\cle.txt -c 32768 --no-ui --no-slots --load-mode none
   ```
   Il charge le modèle (une à deux minutes). Repère dans le texte qui défile : une ligne qui cite
   **Vulkan0**, une ligne `offloaded … layers to GPU` (idéalement `41/41`), puis à la fin
   **`listening on http://127.0.0.1:8080`**. Les lignes violettes « W » sont des avis, pas des erreurs. Laisse cette fenêtre ouverte.
2. Ouvre un **deuxième** terminal (pas besoin d'administrateur) et teste :
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8080/health
   $k = Get-Content C:\Sonni\cle.txt
   $body = '{"messages":[{"role":"user","content":"Explique en une phrase a quoi sert une banque centrale."}],"max_tokens":120,"chat_template_kwargs":{"enable_thinking":false}}'
   (Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions -Method Post -Headers @{Authorization = "Bearer $k"} -ContentType 'application/json' -Body $body).choices[0].message.content
   ```
   La première commande affiche `ok` sous `status`, la dernière une phrase en français. Sans la clé, le
   modèle refuse :
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8080/v1/models
   ```
   doit afficher une erreur **401** (c'est voulu).
3. Dans la première fenêtre, la ligne `eval time = … tokens per second` donne la vitesse d'écriture :
   **au-dessus de 10 tokens par seconde**, c'est confortable pour Sonni (mesuré sur ton PC le 8 octobre :
   30 tokens par seconde ; `--load-mode none` charge le modèle en mémoire au démarrage, sans lui la toute
   première réponse est deux fois plus lente).
4. Arrête le modèle : **Ctrl+C** dans la première fenêtre.

**Si le modèle ne démarre pas** (« out of memory », « failed to allocate ») : ouvre le Bloc-notes,
écris `--n-cpu-moe 20` et enregistre-le sous `C:\Sonni\options.txt` (type : *Tous les fichiers*) ;
pour l'essai à la main, ajoute `--n-cpu-moe 20` à la fin de la ligne. Encore trop ? Mets 30.
Si une ligne dit `invalid argument`, envoie-la-moi.

---

## Partie 3 — Le faire tourner 24 h/24

### Étape 11 — Le script qui le garde en marche

```powershell
curl.exe -fsSL -o C:\Sonni\llm-main.ps1 https://raw.githubusercontent.com/moneylab-djib/Money-lab-trader/main/sonni/pc/llm-main.ps1
Get-Content C:\Sonni\llm-main.ps1 -TotalCount 3
```
La dernière ligne affiche le début du script (« Sonni's second brain on the owner's PC… »). Ce script
(lisible dans le dépôt : `sonni/pc/llm-main.ps1`) lance le modèle exactement comme à l'étape 10, le
relance 15 secondes après tout arrêt (plantage, pilote relancé), écrit son journal dans
`C:\Sonni\logs` (gardé 14 jours) et lit deux fichiers facultatifs : `C:\Sonni\options.txt` (options en
plus, étape 10) et `C:\Sonni\modele.txt` (changer de modèle, étape 22).

### Étape 12 — Le lancer à chaque ouverture de session

Toujours dans le terminal administrateur, colle ce bloc d'un coup :
```powershell
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Sonni\llm-main.ps1'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 4
Register-ScheduledTask -TaskName 'Sonni second cerveau' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Sonni second cerveau'
```
Ce que règle ce bloc : la tâche démarre à l'ouverture de ta session, **sans limite de durée** (Windows
arrête sinon une tâche au bout de 3 jours), avec une priorité normale (Windows met sinon les tâches en
priorité basse), et redémarre si le script lui-même s'arrête.

Attends une à deux minutes, puis :
```powershell
Get-Content C:\Sonni\logs\superviseur.log -Tail 3
Invoke-RestMethod http://127.0.0.1:8080/health
```
Tu dois lire `demarrage de llama-server : Qwen3.6-35B-A3B-UD-Q4_K_M.gguf (qwen3.6-35b-a3b)` puis
`ok` sous `status`. Aucune fenêtre ne reste ouverte : le modèle tourne en arrière-plan (tu le vois dans le
Gestionnaire des tâches sous le nom `llama-server.exe`).

### Étape 13 — Vérifier après un redémarrage

Redémarre le PC sans rien toucher. Après deux à trois minutes, reconnecte-toi (ou attends l'ouverture
automatique) et refais les deux lignes de l'étape 12 : le modèle doit être revenu seul.

---

## Partie 4 — Le relier au serveur de Sonni avec Tailscale

### Étape 14 — Ton réseau privé Tailscale

1. **Crée ton compte** sur https://login.tailscale.com/start (avec ton compte Google, Microsoft ou
   GitHub). Choisis l'offre gratuite **Personal** (usage personnel, non commercial : c'est le cas de
   Sonni ; vérifie les conditions au moment de t'inscrire).
2. Installe Tailscale sur le PC : https://tailscale.com/download/windows, connecte-toi avec le même
   compte. Ferme puis rouvre ton terminal administrateur (pour qu'il trouve la commande `tailscale`).
3. Pour qu'il reste connecté même session fermée :
   ```powershell
   tailscale set --unattended=true
   ```
   (ou icône Tailscale près de l'horloge → *Preferences* → *Run unattended*).
4. Dans la console https://login.tailscale.com/admin/machines, sur la ligne de ton PC, menu **⋯** :
   - *Edit machine name…* → décoche le nom automatique → **`sonni-pc`** → *Update name* ;
   - *Disable key expiry* (sinon le PC se déconnecte au bout de 180 jours).
5. Note l'**adresse Tailscale** du PC (colonne *Addresses*, de la forme `100.x.y.z`). Dans le
   terminal, `tailscale ip -4` l'affiche aussi.

### Étape 15 — Les règles d'accès

Dans la console : **Access controls** → éditeur JSON. Remplace tout le contenu par ce qui suit, en
mettant **l'adresse de ton PC** (étape 14) à la place de `100.x.y.z` :
```json
{
  // Qui peut poser l'étiquette du serveur de Sonni : toi (administrateur).
  "tagOwners": {
    "tag:sonni-vps": ["autogroup:admin"]
  },
  // « sonni-pc » désigne ton PC.
  "hosts": {
    "sonni-pc": "100.x.y.z"
  },
  "grants": [
    // Tes appareils (connectés avec ton compte) : accès à tout ton réseau.
    {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
    // Le serveur de Sonni : uniquement le second cerveau, port 8080 de ton PC.
    {"src": ["tag:sonni-vps"], "dst": ["sonni-pc"], "ip": ["tcp:8080"]}
  ],
  // Vérifié à chaque enregistrement : le serveur atteint le second cerveau, et rien d'autre sur ton PC.
  "tests": [
    {"src": "tag:sonni-vps", "accept": ["sonni-pc:8080"], "deny": ["sonni-pc:22", "sonni-pc:445", "sonni-pc:3389", "sonni-pc:8081"]}
  ]
}
```
Clique **Save**. Si la console refuse en citant un test, vérifie l'adresse du PC. (Si tu utilisais
déjà Tailscale avec d'autres règles, envoie-moi ta configuration avant de la remplacer.)

### Étape 16 — Tailscale sur le serveur de Sonni

1. Dans la console : **Settings → Keys → Generate auth key…** Description `sonni-vps` ; *Reusable* :
   non ; *Expiration* : 1 jour (elle ne sert qu'une fois) ; *Ephemeral* : non ; *Tags* : oui,
   **`tag:sonni-vps`**. *Generate key*, puis copie la clé (elle ne se réaffiche pas).
2. Sur le serveur :
   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   nano /root/ts-authkey
   ```
   Colle la clé, enregistre (**Ctrl+O**, **Entrée**, **Ctrl+X**), puis :
   ```sh
   chmod 600 /root/ts-authkey
   tailscale up --auth-key=file:/root/ts-authkey --advertise-tags=tag:sonni-vps --hostname=sonni-vps
   shred -u /root/ts-authkey
   tailscale status
   ```
   La dernière ligne liste **sonni-vps** et **sonni-pc**. Le serveur porte l'étiquette
   `tag:sonni-vps` : ses droits sont ceux de l'étape 15, rien de plus, et sa clé n'expire pas.
   N'ajoute pas `--ssh` : ce n'est pas nécessaire.

### Étape 17 — Ouvrir le second cerveau au réseau privé seulement

Le modèle n'écoute que sur ton PC lui-même (`127.0.0.1`). Tailscale lui transmet les connexions du
réseau privé, et elles seules ; aucune règle de pare-feu à ouvrir. Sur le PC, terminal administrateur :
```powershell
tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080
tailscale serve status
```
La dernière ligne montre le port 8080 redirigé vers `127.0.0.1:8080`. Si la première affiche une
adresse pour autoriser *Serve* sur ton réseau, ouvre-la, accepte, puis relance la commande. Ce réglage
reste après un redémarrage.

### Étape 18 — Tester depuis le serveur

Sur le serveur :
```sh
tailscale ping sonni-pc
curl -sS http://sonni-pc:8080/health; echo
curl -sS -o /dev/null -w '%{http_code}\n' http://sonni-pc:8080/v1/models
```
Attendu : `pong from sonni-pc …`, puis `{"status":"ok"}`, puis **401** (sans la clé, refusé : c'est
voulu).

---

## Partie 5 — Brancher Sonni

### Étape 19 — Donner la clé à Sonni

1. Sur le PC, copie la clé dans le presse-papiers :
   ```powershell
   Get-Content C:\Sonni\cle.txt | Set-Clipboard
   ```
2. Sur le serveur : `nano /etc/sonni.env`. Trouve la ligne `SECOND_BRAIN_API_KEY=` (ajoute-la à la fin
   si elle n'y est pas) et colle la clé juste après le `=` (clic droit), sans espace. Enregistre
   (**Ctrl+O**, **Entrée**, **Ctrl+X**).
3. Teste avec la clé, lue dans le fichier (elle n'apparaît pas à l'écran) :
   ```sh
   KEY=$(sed -n 's/^SECOND_BRAIN_API_KEY=//p' /etc/sonni.env)
   curl -sS -H "Authorization: Bearer $KEY" http://sonni-pc:8080/v1/models; echo
   curl -sS http://sonni-pc:8080/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"En une phrase : à quoi sert une banque centrale ?"}],"max_tokens":120,"chat_template_kwargs":{"enable_thinking":false}}'; echo
   unset KEY
   ```
   La première réponse contient `"id":"qwen3.6-35b-a3b"`, la seconde une phrase en français
   (`"content":"…"`).
4. Redémarre Sonni : `systemctl restart sonni`.

### Étape 20 — Lui parler : `/cerveau` et `/question`

Sur Telegram :
- `/cerveau` répond « 🧠 Second cerveau — mode assistant (qwen3.6-35b-a3b sur sonni-pc:8080) » et
  « En ligne depuis … » (une minute après le redémarrage), puis ses tâches du jour, le tri de
  l'actualité, l'avis de Claude sur ses notes de situation et le compteur du modèle (étape 22).
- `/question Que sait Sonni sur le bitcoin en ce moment ?` répond « Question transmise au second
  cerveau » ; la réponse arrive en message à part, en général en une à trois minutes. Elle vient du
  modèle local, d'après des extraits de la mémoire de Sonni : à vérifier, ce n'est pas Claude, et
  Claude n'est pas réveillé (aucun coût).
- `/technique` montre une ligne « Second cerveau : en ligne… ».

### Étape 21 — Choisir le mode

| Commande | Ce que fait le second cerveau |
| --- | --- |
| `/cerveau assistant` | **Par défaut.** Il lit l'actualité en premier (avant Gemini et Groq), la trie, écrit une note de situation avant chaque réveil de Claude (Claude dit si elle l'a aidé), plaide contre chaque position ouverte, prépare les faits des autopsies, répond à `/question`. Son tri propose des réveils « à blanc » : comptés dans `/cerveau`, sans réveiller Claude. |
| `/cerveau parallele` | Tout cela, et en plus il donne sa propre probabilité pour chaque pari de Claude, sans voir la réponse de Claude. Le code note les deux à l'échéance ; `/cerveau` compare leurs scores (Brier : 0 = parfait). |
| `/cerveau delegue` | Verrouillé tant que les preuves manquent : au moins 100 paris parallèles notés, avec un score à moins de 0,01 de celui de Claude. Même alors, c'est ta décision ; on choisira ensemble quelles tâches lui confier. |
| `/cerveau arret` | Sonni ne l'appelle plus du tout (le PC peut rester allumé). |

Plus tard, quand `/cerveau` montre que ses réveils « à blanc » sont rares et justes, il pourra
réveiller Claude lui-même (4 fois par jour au plus, une heure d'écart) : dis-le-moi, c'est un réglage
de sa configuration (`triageWakes`).

### Étape 22 — Confirmer le modèle sur 50 vraies tâches

`/cerveau` affiche « Avec le modèle qwen3.6-35b-a3b depuis le début : tâches réussies N, échouées M »,
puis **« modèle confirmé »** quand il a réussi 50 vraies tâches avec moins d'un échec sur 10 (calculé
par le code). Compte quelques jours en mode assistant. Seules les mauvaises réponses du modèle comptent
comme échecs : un PC éteint, redémarré ou injoignable, ou une clé refusée, ne pèse pas contre lui.

S'il échoue trop souvent, s'il est trop lent, ou si Claude juge ses notes rarement utiles, essaie le
modèle de secours : avec le Bloc-notes, écris la ligne
```
gpt-oss-20b-MXFP4.gguf gpt-oss-20b
```
et enregistre-la sous `C:\Sonni\modele.txt` (type : *Tous les fichiers*). Puis relance le modèle :
```powershell
Stop-Process -Name llama-server -Force
```
Le script le relance avec le modèle de secours ; `/cerveau` affiche alors `gpt-oss-20b`, et ses
compteurs repartent de zéro (le code ne mélange jamais les preuves de deux modèles). Pour revenir à
Qwen, supprime `C:\Sonni\modele.txt` et refais `Stop-Process`.

---

## Partie 6 — Une copie de la mémoire de Sonni sur ton PC, chaque nuit

Le serveur fait déjà une copie vérifiée de la mémoire de Sonni chaque jour (il garde les 7 dernières).
Ici, ton PC en récupère une chaque nuit et en garde 30 jours : si le serveur est perdu, sa mémoire ne
l'est pas. Le PC n'a qu'un accès en **lecture seule**, à ce seul dossier, et seulement par Tailscale.

### Étape 23 — Sur le serveur : l'export de chaque nuit

```sh
useradd --system --user-group --home-dir /srv/sonni-backup --no-create-home --shell /usr/sbin/nologin sonni-backup
install -d -m 755 -o root -g root /srv/sonni-backup /srv/sonni-backup/.ssh
install -d -m 2750 -o sonni -g sonni-backup /srv/sonni-backup/files
cp /opt/sonni/sonni/vps/sonni-backup-export.service /opt/sonni/sonni/vps/sonni-backup-export.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sonni-backup-export.timer
systemctl start sonni-backup-export.service
journalctl -u sonni-backup-export -n 3 --no-pager
```
La dernière ligne dit « Exportée pour le PC : state.db.backup-AAAA-MM-JJ (… Mo, vérifiée, SHA-256 …) ».
(« Aucune copie quotidienne pour le moment » : Sonni fait la sienne dans l'heure qui suit minuit UTC ;
ce sera bon demain.) Chaque nuit à 2 h 30 UTC, le serveur rouvre la copie du jour, vérifie qu'elle est
saine et complète, et la dépose avec son empreinte SHA-256.

### Étape 24 — Sur le serveur : un accès en lecture seule pour ton PC

Une copie de sécurité de la configuration SSH, puis l'accès. Garde ta session ouverte jusqu'au bout, et
colle le bloc d'un coup :
```sh
cp /etc/ssh/sshd_config /root/sshd_config.avant-sonni
cat >> /etc/ssh/sshd_config <<'EOF'

# Sonni: the owner's PC fetches the nightly memory copy, read-only (sonni/GUIDE-PC.fr.md)
Match User sonni-backup
    ChrootDirectory /srv/sonni-backup
    ForceCommand internal-sftp -R
    PasswordAuthentication no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    AllowAgentForwarding no
EOF
mkdir -p /run/sshd && sshd -t && systemctl restart ssh && echo "SSH OK"
```
Tu dois voir **SSH OK**. Sinon, remets l'ancienne configuration avec
`cp /root/sshd_config.avant-sonni /etc/ssh/sshd_config` et envoie-moi le message. Ce compte ne peut
que lire le dossier des copies (`-R`), sans mot de passe, sans terminal et sans tunnel.

Note l'empreinte du serveur (pour l'étape 25) :
```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

### Étape 25 — Sur le PC : la clé SSH et la première connexion

1. Une clé SSH pour ce seul usage (appuie deux fois sur **Entrée** quand elle demande une phrase
   secrète : la tâche de nuit tourne sans toi) :
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
   ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\sonni-backup" -C sonni-pc-sauvegarde
   Get-Content "$env:USERPROFILE\.ssh\sonni-backup.pub" | Set-Clipboard
   ```
   La dernière ligne copie la **clé publique** (elle n'est pas secrète).
2. Sur le serveur, colle-la quand on te la demande :
   ```sh
   read -r -p "Colle la clé publique du PC, puis Entrée : " PUB
   case "$PUB" in ssh-ed25519\ *) printf 'restrict,from="100.64.0.0/10" %s\n' "$PUB" > /srv/sonni-backup/.ssh/authorized_keys; chmod 644 /srv/sonni-backup/.ssh/authorized_keys; echo "Clé enregistrée.";; *) echo "Ce n'est pas la bonne ligne : elle doit commencer par ssh-ed25519.";; esac
   ```
   `from="100.64.0.0/10"` : cette clé ne marche que depuis ton réseau Tailscale.
3. Première connexion depuis le PC (pour enregistrer l'empreinte du serveur) :
   ```powershell
   sftp -i "$env:USERPROFILE\.ssh\sonni-backup" sonni-backup@sonni-vps
   ```
   Il affiche une empreinte `SHA256:…` : vérifie qu'elle est identique à celle de l'étape 24, tape
   `yes`. Puis tape `ls files` (tu vois la copie de l'étape 23) et `bye`.

### Étape 26 — Sur le PC : la récupération de chaque nuit

```powershell
curl.exe -fsSL -o C:\Sonni\backup-pull.ps1 https://raw.githubusercontent.com/moneylab-djib/Money-lab-trader/main/sonni/pc/backup-pull.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Sonni\backup-pull.ps1
Get-Content C:\Sonni\logs\sauvegarde.log -Tail 2
```
Attendu : « OK : copie du AAAA-MM-JJ recuperee et verifiee (SHA-256 identique), … Mo ». Le script
(`sonni/pc/backup-pull.ps1`) ne récupère que des fichiers au nom attendu, vérifie l'empreinte après le
transfert, garde 30 jours dans `C:\Sonni\sauvegardes` et signale une copie de plus de 2 jours.

Puis la tâche de chaque nuit (5 h 15, ou dès que le PC est allumé s'il ne l'était pas) :
```powershell
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Sonni\backup-pull.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At '05:15'
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Sonni sauvegarde' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
```
Le lendemain matin, `Get-Content C:\Sonni\logs\sauvegarde.log -Tail 2` montre la nuit passée.

---

## Au quotidien

**Jouer, ou utiliser la carte graphique pour autre chose.** Le modèle occupe presque toute la mémoire
de la carte. Pour la libérer :
```powershell
New-Item C:\Sonni\PAUSE -ItemType File -Force | Out-Null; Stop-Process -Name llama-server -Force -ErrorAction SilentlyContinue
```
Pour le relancer : `Remove-Item C:\Sonni\PAUSE` (il revient en une à deux minutes). Pendant la
pause, Sonni continue sans lui. Pour une longue pause (plus de 2 heures), envoie aussi
`/cerveau arret` sur Telegram, puis `/cerveau assistant` au retour : pas d'incident « injoignable ».

**Si le PC s'éteint ou redémarre.** Rien à faire : le BIOS le rallume après une coupure, Windows ouvre
ta session, la tâche relance le modèle, et le serveur le retrouve en une minute. Les tâches coupées
repartent ; les tâches devenues inutiles sont abandonnées. `/cerveau` dit depuis quand il est en ligne
ou hors ligne.

**Ce que tu peux regarder.** `/cerveau` (état, modèle, tâches, scores), `C:\Sonni\logs\superviseur.log`
(démarrages et arrêts du modèle), `C:\Sonni\logs\llama-….log` (le détail du modèle),
`C:\Sonni\logs\sauvegarde.log` (les copies de chaque nuit).

## Mettre à jour

**llama.cpp** (une fois par mois, ou quand je te le dis) : refais le bloc de l'étape 7 en remplaçant
`C:\Sonni\llama` par `C:\Sonni\llama-nouveau` dans la ligne `Expand-Archive`, puis :
```powershell
New-Item C:\Sonni\PAUSE -ItemType File -Force | Out-Null; Stop-Process -Name llama-server -Force -ErrorAction SilentlyContinue
Remove-Item C:\Sonni\llama-ancien -Recurse -Force -ErrorAction SilentlyContinue
Rename-Item C:\Sonni\llama llama-ancien; Rename-Item C:\Sonni\llama-nouveau llama
Remove-Item C:\Sonni\PAUSE
```
Vérifie `/cerveau` cinq minutes après. En cas de problème, refais la pause et remets l'ancien dossier
(`Rename-Item C:\Sonni\llama llama-casse; Rename-Item C:\Sonni\llama-ancien llama`).

**Le pilote AMD** : une fois par mois, avec la pause ci-dessus, puis redémarre le PC.

**Les scripts** (quand je t'annonce une nouvelle version) : refais les lignes `curl.exe` des
étapes 11 et 26, puis relance la tâche :
`Stop-ScheduledTask 'Sonni second cerveau'; Start-ScheduledTask 'Sonni second cerveau'`.

## Dépannage

| Ce que tu vois | Ce que ça veut dire | Que faire |
| --- | --- | --- |
| `/cerveau` : « pas configuré » | Le bloc du second cerveau manque dans la configuration | Refais « Mettre Sonni à jour » (guide du VPS), surtout la ligne `configure.mjs` |
| `/cerveau` : « Clé SECOND_BRAIN_API_KEY absente » | La clé n'est pas dans `/etc/sonni.env`, ou Sonni n'a pas redémarré | Étape 19 |
| « Hors ligne … clé refusée » | Les deux clés diffèrent | Refais l'étape 19 (copie depuis `C:\Sonni\cle.txt`) |
| « Hors ligne … ENOTFOUND » ou « getaddrinfo » | Le serveur ne trouve pas le nom `sonni-pc` | Sur le serveur : `tailscale status` ; dans la console Tailscale, *DNS* → *MagicDNS* doit être activé ; le PC doit s'appeler `sonni-pc` |
| « Hors ligne … ECONNREFUSED », « timeout » ou « fetch failed » | Le PC est éteint, le modèle est arrêté, ou Tailscale ne le transmet pas | Sur le PC : `Invoke-RestMethod http://127.0.0.1:8080/health`, puis `Get-Content C:\Sonni\logs\superviseur.log -Tail 5`, puis `tailscale serve status` ; sur le serveur : `tailscale ping sonni-pc` |
| `superviseur.log` répète « llama-server arrete » | Le modèle s'arrête juste après son lancement | Lis le dernier `C:\Sonni\logs\llama-….log` : « out of memory » → `options.txt` (étape 10) ; « invalid argument » → envoie-moi la ligne |
| `superviseur.log` : « fichier manquant » | Un fichier n'est pas à sa place | Vérifie `C:\Sonni\llama\llama-server.exe`, le modèle dans `C:\Sonni\modeles`, `C:\Sonni\cle.txt` |
| Très lent (moins de 10 tokens/s) | La carte est occupée, ou trop de modèle reste dans la mémoire du PC | Ferme les jeux ; regarde la ligne `offloaded` ; essaie le modèle de secours (étape 22) |
| Pas de `Vulkan0` à l'étape 7 | Pilote absent ou trop ancien | Étape 1, puis redémarre |
| Après une mise à jour Windows, rien ne repart | La session ne s'ouvre plus seule (mot de passe changé ?) | Relance Autologon (étape 5) |
| Le PC devient injoignable au bout de quelques heures alors qu'il est allumé | La carte réseau s'endort | *Gestionnaire de périphériques* → *Cartes réseau* → ta carte → *Gestion de l'alimentation* → décoche « Autoriser l'ordinateur à éteindre ce périphérique » |
| `sauvegarde.log` : « ECHEC : sftp a echoue » | Le serveur est injoignable, ou son empreinte a changé (serveur réinstallé) | Lance la commande `sftp` de l'étape 25 à la main pour lire le message ; après une réinstallation : `ssh-keygen -R sonni-vps`, puis refais l'étape 25 |
| `sauvegarde.log` : « ATTENTION : la copie la plus recente du serveur date du … » | Le serveur ne fait plus ses copies | `/technique` sur Telegram, puis `journalctl -u sonni-backup-export -n 5` sur le serveur |

**Si `tailscale serve` ne transmet rien** (étape 18 sans réponse alors que le modèle répond sur le
PC) : écris-moi avec la sortie de `tailscale serve status`. Il existe un plan B (le modèle écoute sur
l'adresse Tailscale du PC, protégé par une règle du pare-feu Windows limitée à Tailscale), mais une
fausse manœuvre dans le pare-feu peut ouvrir le modèle à ton réseau local : on le fera ensemble.

## Si le serveur de Sonni est perdu

Ses copies sont dans `C:\Sonni\sauvegardes` (une par jour, 30 jours). Ne restaure rien seul :
écris-moi d'abord. En résumé : on installe un nouveau serveur avec `sonni/GUIDE-VPS.fr.md` sans le
démarrer, tu envoies la copie la plus récente depuis le PC
(`scp C:\Sonni\sauvegardes\state.db.backup-AAAA-MM-JJ root@NOUVELLE_IP:/root/`), on la met à la place
de sa mémoire (`/home/sonni/.automaton/state.db`), on vérifie, puis on démarre. Il reprend avec sa
mémoire de la veille.

## Arrêter le second cerveau

1. Telegram : `/cerveau arret`.
2. Serveur : enlève la clé de `/etc/sonni.env` (`nano`), puis `systemctl restart sonni`.
3. PC : `Unregister-ScheduledTask -TaskName 'Sonni second cerveau' -Confirm:$false`, puis
   `Stop-Process -Name llama-server -Force` et `tailscale serve reset`.
4. La copie de chaque nuit est indépendante : pour l'arrêter aussi,
   `Unregister-ScheduledTask -TaskName 'Sonni sauvegarde' -Confirm:$false` sur le PC et
   `systemctl disable --now sonni-backup-export.timer` sur le serveur.

## Limites à connaître

- Le second cerveau peut se tromper, ou être trompé par un article : c'est pour ça que ses textes sont
  des données non fiables, que le code vérifie leur forme, leur longueur et les tournures suspectes, et
  qu'il n'a aucun outil. Claude décide, le code calcule.
- Les modes, les plafonds et les vérifications sont appliqués dans le programme de Sonni : ce n'est pas
  une isolation de sécurité. La vraie barrière entre le serveur et ton PC est Tailscale (un seul port)
  et la clé.
- Ton PC voit des extraits de la mémoire de Sonni et l'actualité qu'il lit : rien de personnel, mais
  c'est sur ton PC. Il ne reçoit jamais de clé de Sonni (Anthropic, Telegram, sources de données).
- Autologon garde ton mot de passe Windows chiffré sur le PC (étape 5).
- L'offre gratuite de Tailscale est faite pour un usage personnel ; ses conditions peuvent changer.
- L'électricité du PC n'est pas comptée dans le budget de Sonni : à toi de la suivre si tu le souhaites.
