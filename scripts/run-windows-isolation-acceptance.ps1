param([Parameter(Mandatory)][string]$EvidenceDirectory,[switch]$PermissionsOnly)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$root=Join-Path $project 'tmp\isolation-os-20261111'
$database=Join-Path $project 'tmp\isolation-os-db-20261111'
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
if(-not $EvidenceDirectory.StartsWith(($project+'\tmp\isolation-acceptance-'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid evidence directory'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Windows administrator approval is required'}
for($path=$EvidenceDirectory;$path -and -not(Test-Path -LiteralPath $path);$path=Split-Path -Parent $path){}
for($item=Get-Item -LiteralPath $path;$null -ne $item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Evidence reparse point refused'}}
if(Test-Path -LiteralPath (Join-Path $EvidenceDirectory 'status.json')){throw 'Use a fresh evidence directory'}
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$result=@{stage='install';passed=$false;cleanup=$false}
function Save-Status {$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'status.json')}
try {
  Save-Status
  if(Test-Path -LiteralPath $root){
    $previous=Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
    if($previous.root -ne $root -or $previous.complete){throw 'Existing installation must be completely uninstalled before retry'}
    foreach($account in $previous.accounts){if(Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue){throw 'Previous test account still exists'}}
    # Archive only this exact owned scratch tree; never overwrite old evidence.
    $backup=[IO.Path]::GetFullPath($root+'.'+[guid]::NewGuid().ToString('N')+'.bak')
    if(-not $backup.StartsWith(($project+'\tmp\'),[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $backup)){throw 'Unsafe backup target'}
    Move-Item -LiteralPath $root -Destination $backup
  }
  & (Join-Path $PSScriptRoot 'production-isolation.ps1') -Action Install -Root $root
  $result.stage='test';Save-Status
  & (Join-Path $PSScriptRoot 'test-windows-isolation.ps1') -Root $root -DatabaseState $database -PermissionsOnly:$PermissionsOnly
  $result.passed=$true
} catch {
  $result.error=$_.Exception.Message
  $result.errorLocation=$_.InvocationInfo.PositionMessage
} finally {
  # Only synthetic test reports are copied out. Keys, environment files,
  # credentials, database files and original ZIP files remain protected.
  try {
    foreach($name in @('acceptance-evidence.json','resource-evidence.json','main\temp\acceptance.json','game\temp\acceptance.json','validator\temp\acceptance.json','main\temp\business.log')){
      $path=Join-Path $root $name
      if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $EvidenceDirectory ($name.Replace('\','-')))}
    }
  } catch {$result.reportError=$_.Exception.Message;$result.passed=$false}
  try {
    if(Test-Path -LiteralPath (Join-Path $root 'installation.json')){
      & (Join-Path $PSScriptRoot 'production-isolation.ps1') -Action Uninstall -Root $root
    }
    $result.cleanup=$true
  } catch {$result.cleanupError=$_.Exception.Message}
  $result.stage='finished';Save-Status
}
if(-not $result.passed -or -not $result.cleanup){exit 1}
