param([ValidateSet('Stopped','DifferentDisk','PrivateDirectory')][string]$Action,[Parameter(Mandatory)][string]$Root,[string]$Target)
$ErrorActionPreference='Stop'
function Plain([string]$Path){
  $resolved=[IO.Path]::GetFullPath($Path)
  for($item=Get-Item -LiteralPath $resolved;$null -ne $item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'}}
  return $resolved
}
$Root=Plain $Root
if($Action -eq 'PrivateDirectory'){
  $trusted=@('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $acl=Get-Acl -LiteralPath $Root
  if(-not $acl.AreAccessRulesProtected){throw 'Private directory must disable inherited access'}
  if($acl.Owner -and ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Untrusted private directory owner'}
  foreach($entry in $acl.Access){if($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Untrusted private directory access'}}
  return
}
if($Action -eq 'Stopped'){
  $journal=Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw | ConvertFrom-Json
  if($journal.root -ne $Root){throw 'Installation mismatch'}
  if(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)}){throw 'Runtime writers still active'}
  return
}
$Target=Plain $Target
function Disk([string]$Path){
  $drive=[IO.Path]::GetPathRoot($Path)
  if($drive -notmatch '^[A-Za-z]:\\$'){throw 'A locally identified physical backup disk is required'}
  $partition=Get-Partition -DriveLetter $drive.Substring(0,1)
  $disk=$partition | Get-Disk
  if($disk.OperationalStatus -notcontains 'Online' -or $disk.BusType -in @('Virtual','File Backed Virtual','Spaces')){throw 'Physical disk identity not established'}
  return $disk.Number
}
if((Disk $Root) -eq (Disk $Target)){throw 'Same physical disk is not disaster recovery'}
Write-Output 'Distinct physical disk verified'
