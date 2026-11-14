param(
  [ValidateSet('Plan','Install')][string]$Action='Plan',
  [switch]$AcceptLocalBackupOnly,
  [switch]$ConfirmInstallation,
  [switch]$ResumePrepared
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$root=Join-Path $project 'data\production'
$runtime=Join-Path $root 'runtime'
$pgSource=Join-Path $project 'tmp\phase2-postgres\runtime\pgsql\bin'
$clamSource=Join-Path $project 'tmp\phase3-clamav\runtime\clamav-1.5.4.win.x64'
$clamDatabase=Join-Path $project 'tmp\phase3-clamav\database'
$openssl='C:\Program Files\Git\usr\bin\openssl.exe'
$pwsh='C:\Users\wkq17\AppData\Local\Programs\PowerShell7\pwsh.exe'
$node=(Get-Command node.exe).Source
$mainOrigin='https://wsyz-aigames.de5.net';$gameOrigin='https://wsyz-play.us.ci'
$service='AGP-PostgreSQL-Production'
$id=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($runtime.ToLowerInvariant()))).Substring(0,10).ToLowerInvariant()
$ports=@(4320,4321,55441,3310)
foreach($file in @((Join-Path $pgSource 'initdb.exe'),(Join-Path $clamSource 'clamd.exe'),$openssl,$pwsh,$node)){
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Required existing runtime is unavailable'}
}
$free=(Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($root).Substring(0,1))).SizeRemaining
$occupied=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in $ports | Select-Object LocalAddress,LocalPort)
$plan=[ordered]@{
  root=$root;databaseDirectory=(Join-Path $root 'postgres');database='New empty ai_games_production, loopback 55441';
  databaseService=$service;accounts=@("agp${id}m","agp${id}g","agp${id}v");
  origins=@($mainOrigin,$gameOrigin);ports=$ports;occupiedPorts=$occupied;freeGiB=[math]::Round($free/1GB,2);
  existingRoot=(Test-Path -LiteralPath $root);existingService=[bool](Get-Service -Name $service -ErrorAction SilentlyContinue);
  administrator='admin@wsyz-aigames.de5.net (login identifier; no email sent), fresh random password, mandatory MFA';
  acl='Only the new project data/production tree. Three non-admin runtime accounts; separate PostgreSQL virtual service identity.';
  network='Six WFP filters scoped to the two copied worker executables. All four listeners are loopback.';
  backup='Explicit local-only exception: encrypted local backup verified; off-disk disaster recovery remains unverified.';
  tls='Dedicated CA (3650 days) and server certificate (397 days), SAN localhost/127.0.0.1, explicit per-client CA trust; no OS-wide trust change';
  installEnd='Closed: initial encrypted backup and normal database stop. No tunnel or scheduled task is started by Install.';
  preservation='No development database or works imported, modified, started or stopped. No existing configuration or Tunnel files read.';
  rollback='Stop/drain and preserve backup; unregister exact stopped service and journaled ACL; uninstall recorded WFP/accounts. Retain all data. Removed account SIDs cannot be recreated.'
}
if($Action -eq 'Plan'){$plan | ConvertTo-Json -Depth 5;return}
if(-not $ConfirmInstallation -or -not $AcceptLocalBackupOnly){throw 'Reviewed installation confirmation and explicit local-only backup acceptance required'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Approved elevated installation required'}
if(($plan.existingRoot -and -not $ResumePrepared) -or $plan.existingService -or $occupied.Count){throw 'Existing installation/service or occupied ports; refusing reuse'}
if($ResumePrepared){
  $original=Get-Content -LiteralPath (Join-Path $root 'evidence\approved-installation.json') -Raw | ConvertFrom-Json
  if($original.root -ne $root -or $original.databaseService -ne $service -or (Test-Path -LiteralPath (Join-Path $root 'postgres')) -or (Test-Path -LiteralPath $runtime)){throw 'Prepared-only resume refused: target differs or database/runtime already exists'}
  foreach($file in @('configuration\bootstrap.env','configuration\main.env','configuration\maintenance.env','configuration\init-password.key','certificates\server.crt','certificates\server.key','certificates\ca.crt')){if(-not(Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)){throw 'Prepared installation incomplete'}}
}
if($free -lt 5GB){throw 'At least 5 GiB free installation space required'}
foreach($account in $plan.accounts){if(Get-LocalUser -Name $account -ErrorAction SilentlyContinue){throw 'Existing runtime account refused'}}
for($item=Get-Item -LiteralPath (Split-Path -Parent $root);$null -ne $item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse installation parent refused'}}
function Protect([string]$path){
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath $path -AclObject $acl
}
function Json([string]$path,$value){$value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8NoBOM}
function RandomHex {return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()}
function Run([string]$exe,[string[]]$arguments){
  # Output can include provider/connection errors: keep it in the protected tree.
  & $exe @arguments >> (Join-Path $root 'evidence\install-tools.log') 2>&1
  if($LASTEXITCODE -ne 0){throw 'Installation tool failed; protected evidence retained'}
}
if(-not $ResumePrepared){New-Item -ItemType Directory -Path $root | Out-Null};Protect $root
foreach($name in @('configuration','certificates','recovery','backups','staging','evidence','scanner')){if(-not $ResumePrepared){New-Item -ItemType Directory -Path (Join-Path $root $name) | Out-Null};Protect (Join-Path $root $name)}
if(-not $ResumePrepared){Json (Join-Path $root 'evidence\approved-installation.json') $plan}
$configFile=Join-Path $root 'configuration\controller.json'
$config=[ordered]@{projectRoot=$project;installationRoot=$runtime;backupRoot=(Join-Path $root 'backups');stagingRoot=(Join-Path $root 'staging');evidenceRoot=(Join-Path $root 'evidence');
  recoveryMaterialFile=(Join-Path $root 'recovery\material.json');pgBin=(Join-Path $root 'postgres-control\bin');caFile=(Join-Path $root 'certificates\ca.crt');pwsh=$pwsh;
  maintenanceEnvironmentFile=(Join-Path $root 'configuration\maintenance.env');databaseService=$service;databaseDirectory=(Join-Path $root 'postgres');databaseControlRoot=(Join-Path $root 'postgres-control');
  databasePort=55441;serverCertificate=(Join-Path $root 'certificates\server.crt');serverPrivateKey=(Join-Path $root 'certificates\server.key');
  scannerExe=(Join-Path $root 'scanner\runtime\clamd.exe');scannerConfig=(Join-Path $root 'scanner\clamd.conf');healthUrl='http://127.0.0.1:4320/health/ready';
  tunnelAdapter=(Join-Path $project 'start-local.ps1');backupPolicy='local-only';localOnlyAcknowledged=$true}
$registered=$false;$databaseStarted=$false
Push-Location $project
try {
  $mainEnv=Join-Path $root 'configuration\main.env';$bootstrap=Join-Path $root 'configuration\bootstrap.env';$pwFile=Join-Path $root 'configuration\init-password.key'
  if(-not $ResumePrepared){
  $session=RandomHex;$admin=RandomHex;$migrate=RandomHex;$app=RandomHex;$backup=RandomHex
  $mainEnv=Join-Path $root 'configuration\main.env'
  @("DATABASE_URL=postgres://app_production:${app}@127.0.0.1:55441/ai_games_production",'DATABASE_TLS=verify-full',"SESSION_SECRET=$session",'CLAMD_PORT=3310') | Set-Content -LiteralPath $mainEnv -Encoding utf8NoBOM
  @("PRODUCTION_MIGRATION_URL=postgres://migrate_production:${migrate}@127.0.0.1:55441/ai_games_production","PRODUCTION_BACKUP_URL=postgres://backup_production:${backup}@127.0.0.1:55441/ai_games_production") | Set-Content -LiteralPath $config.maintenanceEnvironmentFile -Encoding utf8NoBOM
  $bootstrap=Join-Path $root 'configuration\bootstrap.env'
  @("PRODUCTION_MIGRATION_URL=postgres://migrate_production:${migrate}@127.0.0.1:55441/ai_games_production","PRODUCTION_ADMIN_URL=postgres://bootstrap_admin:${admin}@127.0.0.1:55441/postgres",
    "PRODUCTION_APP_PASSWORD=$app","PRODUCTION_BACKUP_PASSWORD=$backup","DATABASE_CA_FILE=$($config.caFile)","PRODUCTION_INSTALLATION_ROOT=$runtime",'CONFIRM_EMPTY_PRODUCTION_ADMIN=ai_games_production',"SESSION_SECRET=$session") | Set-Content -LiteralPath $bootstrap -Encoding utf8NoBOM
  $pwFile=Join-Path $root 'configuration\init-password.key';Set-Content -LiteralPath $pwFile -Value $admin -NoNewline
  Run $openssl @('req','-x509','-newkey','rsa:3072','-nodes','-keyout',(Join-Path $root 'certificates\ca.key'),'-out',$config.caFile,'-days','3650','-subj','/CN=AI Games Production Database CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
  Run $openssl @('req','-newkey','rsa:3072','-nodes','-keyout',$config.serverPrivateKey,'-out',(Join-Path $root 'certificates\server.csr'),'-subj','/CN=localhost')
  @('subjectAltName=DNS:localhost,IP:127.0.0.1','basicConstraints=critical,CA:FALSE','keyUsage=critical,digitalSignature,keyEncipherment','extendedKeyUsage=serverAuth') | Set-Content -LiteralPath (Join-Path $root 'certificates\server.ext')
  Run $openssl @('x509','-req','-in',(Join-Path $root 'certificates\server.csr'),'-CA',$config.caFile,'-CAkey',(Join-Path $root 'certificates\ca.key'),'-CAcreateserial','-out',$config.serverCertificate,'-days','397','-extfile',(Join-Path $root 'certificates\server.ext'))
  }
  Run $openssl @('verify','-CAfile',$config.caFile,'-verify_ip','127.0.0.1',$config.serverCertificate)
  Run (Join-Path $pgSource 'initdb.exe') @('-D',$config.databaseDirectory,'-U','bootstrap_admin',('--pwfile='+$pwFile),'--auth=scram-sha-256','--encoding=UTF8','--locale=C')
  Protect $config.databaseDirectory
  # Prepare copies the existing runtime, then the final controller uses that copy.
  $prepare=@{};foreach($entry in $config.GetEnumerator()){$prepare[$entry.Key]=$entry.Value};$prepare.pgBin=$pgSource
  $prepareFile=Join-Path $root 'configuration\postgres-prepare.json';Json $prepareFile $prepare
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-postgres.ps1'),'-Action','Prepare','-ConfigFile',$prepareFile)
  Json $configFile $config
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-isolation.ps1'),'-Action','Install','-Root',$runtime,'-MainEnvironmentFile',$mainEnv,'-DatabaseCaFile',$config.caFile,'-MainOrigin',$mainOrigin,'-GameOrigin',$gameOrigin,'-MainPort','4320','-GamePort','4321','-ScannerPort','3310')
  # Node resolves ancestor directories before loading modules. Permit inspection
  # of this parent only; all configuration, backup and recovery subtrees remain
  # protected and do not inherit these runtime-account grants.
  $rootAcl=Get-Acl -LiteralPath $root
  $runtimeState=Get-Content -LiteralPath (Join-Path $runtime 'installation.json') -Raw | ConvertFrom-Json
  foreach($account in $runtimeState.accounts){$rootAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($account.sid),'ReadAndExecute','Allow'))}
  Set-Acl -LiteralPath $root -AclObject $rootAcl
  Copy-Item -LiteralPath $clamSource -Destination (Join-Path $root 'scanner\runtime') -Recurse
  Copy-Item -LiteralPath $clamDatabase -Destination (Join-Path $root 'scanner\database') -Recurse
  @("DatabaseDirectory $(Join-Path $root 'scanner\database')",'TCPSocket 3310','TCPAddr 127.0.0.1','Foreground yes','StreamMaxLength 300000000','MaxThreads 2','MaxQueue 4') | Set-Content -LiteralPath $config.scannerConfig
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-postgres.ps1'),'-Action','Register','-ConfigFile',$configFile);$registered=$true
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-services.ps1'),'-Action','StartDatabase','-ConfigFile',$configFile);$databaseStarted=$true
  $release=Join-Path $root 'configuration\release.json'
  Run $node @(('--env-file='+$bootstrap),'scripts/production-database.mjs','plan',$release)
  # Match JS JSON.stringify exactly by calculating the digest in Node.
  $digest=& $node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(JSON.stringify(JSON.parse(readFileSync(process.argv[1],"utf8")))).digest("hex"))' $release
  if($LASTEXITCODE -ne 0 -or $digest -notmatch '^[a-f0-9]{64}$'){throw 'Release digest failed'}
  Add-Content -LiteralPath $bootstrap -Value "APPROVED_RELEASE_SHA256=$digest"
  Run $node @(('--env-file='+$bootstrap),'scripts/production-database.mjs','initialize',$release)
  Run $node @(('--env-file='+$bootstrap),'scripts/production-database.mjs','migrate',$release)
  Run $node @(('--env-file='+$bootstrap),'scripts/production-first-admin.mjs','admin@wsyz-aigames.de5.net',(Join-Path $root 'recovery\first-administrator.json'))
  Run $node @(('--env-file='+$bootstrap),'scripts/production-backup.mjs','keys',$configFile)
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-services.ps1'),'-Action','StopDatabase','-ConfigFile',$configFile);$databaseStarted=$false
  Run $pwsh @('-NoProfile','-File',(Join-Path $PSScriptRoot 'production-services.ps1'),'-Action','Run','-BackupOnly','-ConfigFile',$configFile)
  $state=Get-Content -LiteralPath (Join-Path $root 'evidence\controller-state.json') -Raw | ConvertFrom-Json
  if(-not $state.clean -or -not $state.localBackupVerified -or -not $state.databaseStopped -or $state.offDiskVerified){throw 'Initial local backup/closed-state verification failed'}
  foreach($actionName in @('Start','Stop','Backup','Status')){
    $line='& "'+$pwsh+'" -NoProfile -File "'+(Join-Path $PSScriptRoot 'production-services.ps1')+'" -Action '+$actionName+' -ConfigFile "'+$configFile+'"'
    Set-Content -LiteralPath (Join-Path $root ($actionName+'.ps1')) -Value $line
  }
  Json (Join-Path $root 'evidence\installation-result.json') @{installed=$true;closed=$true;localBackupVerified=$true;offDiskVerified=$false;disasterRecoveryVerified=$false;publicAcceptance=$false;at=[DateTimeOffset]::UtcNow.ToString('o')}
  Write-Output 'Production installed and closed with verified local encrypted backup. Public, identity and browser acceptance still required; no off-disk verification.'
} catch {
  Json (Join-Path $root ('evidence\installation-failure-'+[guid]::NewGuid().ToString('N')+'.json')) @{failed=$true;serviceRegistered=$registered;message='Inspect protected install-tools.log; do not retry into the existing tree';at=[DateTimeOffset]::UtcNow.ToString('o')}
  throw 'Installation incomplete; protected data/evidence retained. No public opening requested.'
} finally {
  if($databaseStarted -and $registered){
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'production-services.ps1') -Action StopDatabase -ConfigFile $configFile >> (Join-Path $root 'evidence\install-tools.log') 2>&1
  }
  Pop-Location
}
