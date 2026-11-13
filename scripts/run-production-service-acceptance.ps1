param([ValidateSet('Plan','Run')][string]$Action='Plan')
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
if($Action -eq 'Plan'){
  [pscustomobject]@{service='AGP-PostgreSQL-Acceptance (fresh virtual service identity)';
    directory=(Join-Path $project 'tmp\production-recovery-<new UUID>');
    database='New disposable PostgreSQL cluster, loopback 55680, independent ai_games_production and restore/rollback databases';
    scanner='Owned ClamAV process, loopback 3311';
    permissions='Only the newly created test cluster and its service-control tree; original SDDL journaled';
    cleanup='Normal database stop, unregister exactly the new stopped service, restore test ACLs; retain protected evidence';
    exclusions='No existing data/postgres changes, real users, scheduled task, tunnel, internet opening or existing credentials'} | Format-List
  return
}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Explicitly approved elevated disposable service acceptance required'}
if(Get-Service -Name 'AGP-PostgreSQL-Acceptance' -ErrorAction SilentlyContinue){throw 'Existing acceptance service refused; inspect previous cleanup'}
if(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in @(55680,3311)){throw 'Acceptance ports occupied'}
$previousRun=$env:RUN_PRODUCTION_RECOVERY;$previousService=$env:RUN_PRODUCTION_RECOVERY_SERVICE
try{
  $env:RUN_PRODUCTION_RECOVERY='1';$env:RUN_PRODUCTION_RECOVERY_SERVICE='1'
  Push-Location $project
  & node --test tests\integration\production-recovery.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Disposable service acceptance failed; inspect the reported protected evidence directory'}
}finally{
  Pop-Location
  $env:RUN_PRODUCTION_RECOVERY=$previousRun;$env:RUN_PRODUCTION_RECOVERY_SERVICE=$previousService
}
