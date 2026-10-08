# Sonni's second brain on the owner's PC (sonni/GUIDE-PC.fr.md): keeps llama-server running.
# Started at logon by the "Sonni second cerveau" scheduled task. When llama-server stops (crash, graphics
# driver reset, update), it is started again 15 seconds later. While the file C:\Sonni\PAUSE exists it
# stays stopped (to free the graphics card); delete the file to resume. Logs: C:\Sonni\logs, 14 days.
# llama-server listens on 127.0.0.1 only: Tailscale ("tailscale serve") is the only way in, and every
# request needs the key in C:\Sonni\cle.txt.
# Read at each start, both optional, one line each:
#   C:\Sonni\modele.txt   "<file in C:\Sonni\modeles> <name shown to Sonni>", e.g. the fallback model:
#                         gpt-oss-20b-MXFP4.gguf gpt-oss-20b
#   C:\Sonni\options.txt  extra llama-server options, e.g. --n-cpu-moe 20
# Windows PowerShell 5.1 compatible. ASCII only: 5.1 reads a script without a BOM as ANSI.
param(
  [string]$Root = 'C:\Sonni',
  [int]$RestartSeconds = 15,
  # For tests only: stop after this many runs of llama-server (0: never stop).
  [int]$MaxRuns = 0
)

$DefaultModel = 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'
$DefaultAlias = 'qwen3.6-35b-a3b'
$Server  = Join-Path (Join-Path $Root 'llama') 'llama-server.exe'
$Models  = Join-Path $Root 'modeles'
$KeyFile = Join-Path $Root 'cle.txt'
$Pause   = Join-Path $Root 'PAUSE'
$Logs    = Join-Path $Root 'logs'

function Write-Log([string]$Message) {
  Add-Content -Path (Join-Path $Logs 'superviseur.log') -Value ((Get-Date -Format 's') + ' ' + $Message)
}

# The first line of an optional text file, split on spaces (nothing when the file is absent or empty).
function Read-Words([string]$Name) {
  $path = Join-Path $Root $Name
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  $line = Get-Content -LiteralPath $path -TotalCount 1
  if (-not $line) { return @() }
  return @(("$line".Trim()) -split '\s+' | Where-Object { $_ })
}

# Paths with spaces are quoted: Start-Process joins its arguments with spaces.
function Join-Arguments([string[]]$Items) {
  ($Items | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

New-Item -ItemType Directory -Force -Path $Logs | Out-Null
# A llama-server left by an earlier run (the task was stopped) would hold the port: stop it first.
Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Log 'superviseur demarre'

$runs = 0
while ($true) {
  if (Test-Path -LiteralPath $Pause) { Start-Sleep -Seconds 30; continue }
  $model = $DefaultModel
  $alias = $DefaultAlias
  $choice = @(Read-Words 'modele.txt')
  if ($choice.Count -ge 2 -and $choice[0] -match '^[\w.\-]+\.gguf$' -and $choice[1] -match '^[\w.\-]+$') {
    $model = $choice[0]
    $alias = $choice[1]
  } elseif ($choice.Count -gt 0) {
    Write-Log 'modele.txt ignore (attendu : <fichier.gguf> <nom>) ; modele par defaut'
  }
  $modelPath = Join-Path $Models $model
  $missing = @($Server, $modelPath, $KeyFile) | Where-Object { -not (Test-Path -LiteralPath $_) }
  if ($missing) {
    Write-Log ('fichier manquant : ' + ($missing -join ', ') + ' ; nouvel essai dans 60 s')
    Start-Sleep -Seconds 60
    continue
  }
  Get-ChildItem -LiteralPath $Logs -Filter 'llama-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $serverArgs = @('-m', $modelPath, '--alias', $alias, '--host', '127.0.0.1', '--port', '8080',
    '--api-key-file', $KeyFile, '-c', '32768', '--no-webui', '--no-slots') + @(Read-Words 'options.txt')
  Write-Log ('demarrage de llama-server : ' + $model + ' (' + $alias + ')')
  $proc = Start-Process -FilePath $Server -ArgumentList (Join-Arguments $serverArgs) -NoNewWindow -PassThru `
    -RedirectStandardError (Join-Path $Logs "llama-$stamp.log") -RedirectStandardOutput (Join-Path $Logs "llama-$stamp.out.log")
  $null = $proc.Handle # keeps the exit code readable once the process has ended
  $proc.WaitForExit()
  Write-Log ('llama-server arrete (code ' + $proc.ExitCode + '), relance dans ' + $RestartSeconds + ' s')
  $runs++
  if ($MaxRuns -gt 0 -and $runs -ge $MaxRuns) { break }
  Start-Sleep -Seconds $RestartSeconds
}
