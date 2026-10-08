# Fetches the newest verified copy of Sonni's memory from its VPS over Tailscale and checks its SHA-256
# (sonni/GUIDE-PC.fr.md). Run each night by the "Sonni sauvegarde" scheduled task; keeps 30 days of
# copies in C:\Sonni\sauvegardes and writes what it did to C:\Sonni\logs\sauvegarde.log.
# The VPS side (sonni/vps/export-backup.mjs) exports one copy a night, read-only for this account.
# Only files named like the VPS's daily copies are ever fetched, whatever else the server lists.
# Windows PowerShell 5.1 compatible. ASCII only: 5.1 reads a script without a BOM as ANSI.
param(
  [string]$Root = 'C:\Sonni',
  [string]$Remote = 'sonni-backup@sonni-vps',
  [string]$Key = '',
  [int]$KeepDays = 30,
  # For tests only: the sftp program to run.
  [string]$Sftp = 'sftp.exe'
)

$ErrorActionPreference = 'Stop'
if (-not $Key) { $Key = Join-Path (Join-Path $env:USERPROFILE '.ssh') 'sonni-backup' }
$Dir = Join-Path $Root 'sauvegardes'
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Dir, $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'sauvegarde.log'
$Name = '^state\.db\.backup-(\d{4}-\d{2}-\d{2})$'
$Kept = '^state\.db\.backup-(\d{4}-\d{2}-\d{2})(\.sha256)?$'

function Write-Log([string]$Message) {
  Add-Content -Path $LogFile -Value ((Get-Date -Format 's') + ' ' + $Message)
}

# Runs sftp with a batch of commands in the backup folder; throws with its output when it fails.
function Invoke-Sftp([string[]]$Commands) {
  $batch = Join-Path $Dir 'sftp-batch.txt'
  # Plain LF lines: nothing for sftp to misread at the end of a file name.
  [IO.File]::WriteAllText($batch, (($Commands -join "`n") + "`n"))
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue' # sftp writes progress to stderr; only its exit code counts
  try {
    $out = & $Sftp -b $batch -o BatchMode=yes -o ConnectTimeout=30 -i $Key $Remote 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
    Remove-Item -LiteralPath $batch -Force -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { throw ('sftp a echoue (code ' + $code + ') : ' + (($out -join ' ') -replace '\s+', ' ').Trim()) }
  return $out
}

try {
  # Relative names in the sftp batch land in the backup folder.
  Set-Location -LiteralPath $Dir
  [Environment]::CurrentDirectory = (Get-Location).Path

  # 1. What the VPS offers today; only names like its daily copies count.
  $offered = @(Invoke-Sftp @('ls -1 files') | ForEach-Object { ($_ -split '/')[-1].Trim() } |
    Where-Object { $_ -match $Name } | Sort-Object)
  if ($offered.Count -eq 0) { throw 'le serveur ne propose encore aucune copie (la premiere arrive la nuit qui suit son installation)' }
  $file = $offered[-1]
  $day = ([regex]::Match($file, $Name)).Groups[1].Value

  if (Test-Path -LiteralPath (Join-Path $Dir $file)) {
    Write-Log "deja a jour : copie du $day"
  } else {
    # 2. The copy and its checksum under temporary names; kept only when the SHA-256 matches.
    Invoke-Sftp @("get files/$file $file.part", "get files/$file.sha256 $file.sha256.part") | Out-Null
    $part = Join-Path $Dir "$file.part"
    $sumPart = Join-Path $Dir "$file.sha256.part"
    $expected = ((Get-Content -LiteralPath $sumPart -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $expected -ne $actual) {
      Remove-Item -LiteralPath $part, $sumPart -Force -ErrorAction SilentlyContinue
      throw "la copie du $day est arrivee abimee (SHA-256 different) ; nouvel essai la nuit prochaine"
    }
    Move-Item -LiteralPath $part -Destination (Join-Path $Dir $file) -Force
    Move-Item -LiteralPath $sumPart -Destination (Join-Path $Dir "$file.sha256") -Force
    $mb = [math]::Round((Get-Item -LiteralPath (Join-Path $Dir $file)).Length / 1MB, 1)
    Write-Log "OK : copie du $day recuperee et verifiee (SHA-256 identique), $mb Mo"
  }

  # 3. A newest copy older than two days means the VPS stopped making them.
  $age = ((Get-Date).Date - [datetime]::ParseExact($day, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)).Days
  if ($age -gt 2) { Write-Log "ATTENTION : la copie la plus recente du serveur date du $day ($age jours) ; regarde /technique sur Telegram" }

  # 4. Keep KeepDays days of copies.
  $limit = (Get-Date).AddDays(-$KeepDays).ToString('yyyy-MM-dd')
  Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Name -match $Kept -and $Matches[1] -lt $limit } | Remove-Item -Force
  exit 0
} catch {
  Write-Log ('ECHEC : ' + $_.Exception.Message)
  exit 1
}
