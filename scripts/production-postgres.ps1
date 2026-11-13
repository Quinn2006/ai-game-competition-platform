param(
  [ValidateSet('Plan','Prepare','Register','Unregister')][string]$Action='Plan',
  [Parameter(Mandatory)][string]$ConfigFile
)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
foreach($name in @('databaseDirectory','databaseService','pgBin','databaseControlRoot','databasePort','serverCertificate','serverPrivateKey')){if(-not $config.$name){throw "Missing database deployment field: $name"}}
if($config.databaseService -notmatch '^AGP-PostgreSQL-[a-zA-Z0-9-]+$'){throw 'Dedicated service name required'}
$cluster=[IO.Path]::GetFullPath($config.databaseDirectory)
$control=[IO.Path]::GetFullPath($config.databaseControlRoot)
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if($cluster -ne (Join-Path $project 'data\postgres') -and -not $cluster.StartsWith($project+'\tmp\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unreviewed cluster location'}
if(-not $control.StartsWith($project+'\data\',[StringComparison]::OrdinalIgnoreCase) -and -not $control.StartsWith($project+'\tmp\',[StringComparison]::OrdinalIgnoreCase)){throw 'Dedicated control directory must be under project data or tmp'}
if($control -eq $cluster -or $control.StartsWith($cluster+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Control files cannot be placed inside the existing cluster'}
function Plain([string]$Path){for($item=Get-Item -LiteralPath $Path;$null -ne $item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'}}}
Plain $cluster
if($Action -eq 'Plan'){
  [pscustomobject]@{cluster=$cluster;control=$control;service=$config.databaseService;identity=('NT SERVICE\'+$config.databaseService);
    operations='Prepare external TLS/hba configuration and dedicated PostgreSQL executable copy. Register manual-start service. Grant its virtual SID access only to reviewed cluster/control trees.';
    impact='Existing cluster is kept in place; all databases share its stop/start. No import, initialization, migration or public opening.';
    rollback='Stop only after all clients exit; unregister exact service; restore journaled original SDDL. Original postgresql.conf and pg_hba.conf remain unchanged.'} | Format-List
  return
}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Reviewed elevated operation required'}
function Protect([string]$Path){
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath $Path -AclObject $acl
}
if($Action -eq 'Prepare'){
  if(Test-Path -LiteralPath $control){throw 'Existing control directory refused'}
  Plain (Split-Path -Parent $control)
  New-Item -ItemType Directory -Path $control | Out-Null;Protect $control
  foreach($name in @('bin','lib','share')){Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $config.pgBin) $name) -Destination (Join-Path $control $name) -Recurse}
  Copy-Item -LiteralPath $config.serverCertificate -Destination (Join-Path $control 'server.crt')
  Copy-Item -LiteralPath $config.serverPrivateKey -Destination (Join-Path $control 'server.key')
  $clusterSql=$cluster.Replace('\','/').Replace("'","''");$controlSql=$control.Replace('\','/').Replace("'","''")
  @("include='$clusterSql/postgresql.conf'","data_directory='$clusterSql'","hba_file='$controlSql/pg_hba.conf'","port=$($config.databasePort)","listen_addresses='127.0.0.1'",'ssl=on',"ssl_cert_file='$controlSql/server.crt'","ssl_key_file='$controlSql/server.key'","ssl_min_protocol_version='TLSv1.2'") | Set-Content -LiteralPath (Join-Path $control 'postgresql.conf')
  @('hostnossl ai_games_production all 127.0.0.1/32 reject','hostssl ai_games_production app_production,migrate_production,backup_production 127.0.0.1/32 scram-sha-256',
    'host ai_games_production all 0.0.0.0/0 reject','host ai_games_production all ::0/0 reject',('include "'+$cluster.Replace('\','/')+'/pg_hba.conf"')) | Set-Content -LiteralPath (Join-Path $control 'pg_hba.conf')
  @{cluster=$cluster;service=$config.databaseService;control=$control;prepared=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $control 'deployment.json')
  Write-Output 'Prepared external configuration; existing cluster untouched and no service registered.';return
}
Plain $control
$journal=Get-Content -LiteralPath (Join-Path $control 'deployment.json') -Raw | ConvertFrom-Json
if($journal.cluster -ne $cluster -or $journal.service -ne $config.databaseService -or $journal.control -ne $control){throw 'Deployment journal mismatch'}
$aclBackup=Join-Path $control 'cluster-acl.bak'
if($Action -eq 'Register'){
  if(Get-Service -Name $config.databaseService -ErrorAction SilentlyContinue){throw 'Existing service refused'}
  & (Join-Path $config.pgBin 'pg_ctl.exe') -D $cluster status *> $null
  if($LASTEXITCODE -eq 0){throw 'Existing cluster running; first arrange reviewed safe stop'}
  if(Test-Path -LiteralPath $aclBackup){throw 'Existing ACL journal; inspect partial installation before retry'}
  $paths=@((Get-Item -LiteralPath $cluster)) + @(Get-ChildItem -LiteralPath $cluster -Recurse -Force)
  $saved=@($paths | ForEach-Object {Plain $_.FullName;@{path=$_.FullName;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}})
  $saved | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $aclBackup
  $binary='"'+(Join-Path $control 'bin\pg_ctl.exe')+'" runservice -N "'+$config.databaseService+'" -D "'+$cluster+'" -w -o "-c config_file='+($control.Replace('\','/')+'/postgresql.conf')+'"'
  # CreateService requires a NULL password for a virtual account. New-Service
  # with an empty PSCredential supplies an empty string instead (error 1057).
  & (Join-Path $env:SystemRoot 'System32\sc.exe') create $config.databaseService binPath= $binary start= demand obj= ('NT SERVICE\'+$config.databaseService) | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Virtual service registration failed'}
  & (Join-Path $env:SystemRoot 'System32\sc.exe') description $config.databaseService ('AGP PostgreSQL '+$control) | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Service description registration failed'}
  $sid=([Security.Principal.NTAccount]::new('NT SERVICE',$config.databaseService)).Translate([Security.Principal.SecurityIdentifier])
  $journal | Add-Member -NotePropertyName serviceSid -NotePropertyValue $sid.Value -Force
  $journal | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $control 'deployment.json')
  foreach($item in $paths){
    $acl=Get-Acl -LiteralPath $item.FullName
    $rule=if($item.PSIsContainer){[Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')}else{[Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','Allow')}
    $acl.AddAccessRule($rule);Set-Acl -LiteralPath $item.FullName -AclObject $acl
  }
  $acl=Get-Acl -LiteralPath $control;$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $control -AclObject $acl
  Write-Output 'Registered manual-start PostgreSQL service and journaled ACL changes. Service not started.';return
}
$service=Get-CimInstance Win32_Service -Filter ("Name='"+$config.databaseService+"'")
if($service -and ($service.Description -ne ('AGP PostgreSQL '+$control) -or $service.State -ne 'Stopped')){throw 'Service differs or is running'}
if($service){Remove-Service -Name $config.databaseService}
$records=@(Get-Content -LiteralPath $aclBackup -Raw | ConvertFrom-Json)
$savedPaths=@{}
foreach($saved in $records){
  $path=[IO.Path]::GetFullPath($saved.path)
  if($path -ne $cluster -and -not $path.StartsWith($cluster+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL rollback path escaped'}
  $savedPaths[$path]=$true
  # PostgreSQL can recycle WAL and relation files while it runs. Restore ACLs
  # for surviving paths, never recreate or edit vanished database files.
  if(-not(Test-Path -LiteralPath $path)){continue}
  Plain $path;$acl=Get-Acl -LiteralPath $path;$acl.SetSecurityDescriptorSddlForm($saved.sddl);Set-Acl -LiteralPath $path -AclObject $acl
}
$rootRecord=$records | Where-Object path -eq $cluster
$originalOwner=[Security.AccessControl.RawSecurityDescriptor]::new($rootRecord.sddl).Owner
$serviceSid=$journal.serviceSid
if(-not $serviceSid){$sidText=& (Join-Path $env:SystemRoot 'System32\sc.exe') showsid $config.databaseService;$serviceSid=[regex]::Match(($sidText -join ' '),'S-1-5-80-(?:\d+-){4}\d+').Value}
if(-not $serviceSid){throw 'Service SID unavailable for ACL cleanup verification'}
$identity=[Security.Principal.SecurityIdentifier]::new($serviceSid)
foreach($item in (Get-ChildItem -LiteralPath $cluster -Recurse -Force | Sort-Object {$_.FullName.Length})){
  if($savedPaths.ContainsKey($item.FullName)){continue}
  Plain $item.FullName
  $acl=Get-Acl -LiteralPath $item.FullName
  $acl.PurgeAccessRules($identity);$acl.SetOwner($originalOwner)
  $acl.SetAccessRuleProtection($false,$false)
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
}
foreach($item in @((Get-Item -LiteralPath $cluster)) + @(Get-ChildItem -LiteralPath $cluster -Recurse -Force)){
  foreach($entry in (Get-Acl -LiteralPath $item.FullName).Access){if($entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $serviceSid){throw 'Residual database service ACL after rollback'}}
}
Write-Output 'Unregistered exact stopped service and restored existing cluster ACLs; all database files and deployment evidence retained.'
