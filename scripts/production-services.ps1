param(
  [ValidateSet('Plan','Start','Stop','Backup','Run','Status','StartDatabase','StopDatabase')][string]$Action='Plan',
  [Parameter(Mandatory)][string]$ConfigFile,
  [long]$RequestedAt=0,
  [switch]$BackupOnly
)
$ErrorActionPreference='Stop'
$ConfigFile=[IO.Path]::GetFullPath($ConfigFile)
$config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
if(-not $RequestedAt){$RequestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
foreach($name in @('projectRoot','installationRoot','backupRoot','stagingRoot','evidenceRoot','pgBin','caFile','pwsh','maintenanceEnvironmentFile','databaseService')){
  if(-not $config.$name){throw "Missing reviewed configuration field: $name"}
}
if($config.databaseService -notmatch '^AGP-PostgreSQL-[a-zA-Z0-9-]+$'){throw 'Dedicated reviewed database service name required'}
if($Action -eq 'Plan'){
  [pscustomobject]@{identity='Installing administrator (DPAPI), manual invocation only';
    triggers='None: no task registration, startup trigger or time-of-day restriction';
    postgres=$config.databaseService;database='ai_games_production only; no development import';
    configuration=$ConfigFile;rollback='Manual Stop closes ingress, drains writers, verifies backup and stops database. All data and evidence retained';
    prerequisites='Reviewed PostgreSQL Windows service, trusted TLS, isolated installation, distinct physical backup disk, separate protected recovery material';
    shutdown='User-controlled start/stop only; never automatic Windows shutdown or power-on'} | Format-List
  return
}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Reviewed elevated operation required'}
if($Action -in @('StartDatabase','StopDatabase')){
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$config.databaseService+"'")
  if(-not $service -or -not $config.databaseControlRoot -or $service.PathName -notlike ('*'+$config.databaseControlRoot+'*') -or -not $config.databaseDirectory -or $service.PathName -notlike ('*'+$config.databaseDirectory+'*')){throw 'Database service executable/data directory differs from review'}
  $expectedPrefix='"'+(Join-Path $config.databaseControlRoot 'bin\pg_ctl.exe')+'" runservice '
  if(-not $service.PathName.StartsWith($expectedPrefix,[StringComparison]::OrdinalIgnoreCase) -or $service.Description -ne ('AGP PostgreSQL '+$config.databaseControlRoot)){throw 'Database service identity differs'}
  if($Action -eq 'StartDatabase'){Start-Service -Name $config.databaseService}
  else{Stop-Service -Name $config.databaseService}
  (Get-Service -Name $config.databaseService).WaitForStatus($(if($Action -eq 'StartDatabase'){'Running'}else{'Stopped'}),[TimeSpan]::FromSeconds(60))
  return
}
if($Action -in @('Start','Backup','Run')){
  foreach($p in @($ConfigFile,$config.maintenanceEnvironmentFile,$config.installationRoot,$config.evidenceRoot)){
    $acl=Get-Acl -LiteralPath $p
    foreach($entry in $acl.Access){
      $sid=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($entry.AccessControlType -eq 'Allow' -and $sid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545')){throw 'Broad access to controller secrets/configuration refused'}
    }
  }
}
$lockPath=Join-Path $config.evidenceRoot 'controller.lock'
if($Action -eq 'Backup'){
  $probe=$null
  try{$probe=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$Action='Start';$BackupOnly=$true}
  catch [IO.IOException]{$Action='Stop'}
  finally{if($probe){$probe.Dispose()}}
}
if($Action -eq 'Status'){
  $statePath=Join-Path $config.evidenceRoot 'controller-state.json'
  if(Test-Path -LiteralPath $statePath){Get-Content -LiteralPath $statePath}else{Write-Output 'Never started'}
  return
}
if($Action -eq 'Stop'){
  $path=Join-Path $config.evidenceRoot 'stop-request.json'
  $temporary=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  @{issuedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json | Set-Content -LiteralPath $temporary
  [IO.File]::Move($temporary,$path,$true)
  Write-Output 'Safe stop requested. Use Status and wait for writersStopped/databaseStopped; backupVerified is reported independently. Do not power off before confirmation.'
  return
}
if($Action -eq 'Start'){
  $probe=$null
  try{$probe=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  catch [IO.IOException]{Write-Output 'Controller already running; no duplicate start';return}
  finally{if($probe){$probe.Dispose()}}
  $arguments='-NoProfile -File "'+$PSCommandPath+'" -Action Run -ConfigFile "'+$ConfigFile+'" -RequestedAt '+$RequestedAt
  if($BackupOnly){$arguments+=' -BackupOnly'}
  $id=[guid]::NewGuid().ToString('N')
  $process=Start-Process -FilePath $config.pwsh -ArgumentList $arguments -WorkingDirectory $config.projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $config.evidenceRoot ($id+'.stdout.log')) -RedirectStandardError (Join-Path $config.evidenceRoot ($id+'.stderr.log'))
  Write-Output ('Manual startup requested; controller PID '+$process.Id+'. Readiness and startup evidence must pass before ingress opens.')
  return
}
$lock=$null
try{
  $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  & (Get-Command node.exe).Source ('--env-file='+$config.maintenanceEnvironmentFile) (Join-Path $PSScriptRoot 'production-controller.mjs') $ConfigFile $RequestedAt $(if($BackupOnly){'backup'}else{'start'})
  if($LASTEXITCODE -ne 0){throw 'Controller failed; ingress remains closed'}
}finally{if($lock){$lock.Dispose()}}
