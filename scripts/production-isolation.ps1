param(
  [ValidateSet('Plan','Install','Start','Uninstall')][string]$Action='Plan',
  [Parameter(Mandatory)][string]$Root,
  [string]$MainEnvironmentFile,
  [string]$MainOrigin='https://main.example.com',
  [string]$GameOrigin='https://game.example.net',
  [ValidateRange(1024,65535)][int]$MainPort=4370,
  [ValidateRange(1024,65535)][int]$GamePort=4371,
  [ValidateRange(1024,65535)][int]$ScannerPort=3311
)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$Root=[IO.Path]::GetFullPath($Root)
if($Root -eq [IO.Path]::GetPathRoot($Root) -or $Root -eq $project -or -not ($Root.StartsWith(($project+'\tmp\'),[StringComparison]::OrdinalIgnoreCase) -or $Root.StartsWith(($project+'\data\submissions\'),[StringComparison]::OrdinalIgnoreCase))) {
  throw 'Use a fresh dedicated directory under project tmp (acceptance) or data/submissions (production). Never target existing user data.'
}
$installationId=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Substring(0,10).ToLowerInvariant()
function Assert-PlainPath([string]$Path) {
  for($item=Get-Item -LiteralPath $Path;$null -ne $item;$item=$item.Parent){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'}
  }
}
function Protect([string]$Path,[hashtable]$Access) {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $entries=@{'S-1-5-18'='FullControl';'S-1-5-32-544'='FullControl'}
  foreach($entry in $Access.GetEnumerator()){$entries[$entry.Key]=$entry.Value}
  foreach($entry in $entries.GetEnumerator()){
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($entry.Key),$entry.Value,'ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Json([string]$Path,$Value){$Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding utf8}
$journal=Join-Path $Root 'installation.json'
if($Action -eq 'Plan') {
  [pscustomobject]@{root=$Root;accounts="agp${installationId}m, agp${installationId}g, agp${installationId}v (new non-administrator accounts)";
    acl='Only this new tree; no existing directory, volume, database or secret ACL changes';
    network='Six persistent WFP ALE connect filters scoped to two dedicated node.exe copies; game: no outbound IP; validator: TCP 127.0.0.1 scanner port only';
    limits='Game 256 MiB/15% CPU/1 process; validator 768 MiB/25%/1; main 1024 MiB/50%/4';
    service='No registered service, scheduled task or public tunnel. Foreground supervisor owns kill-on-close jobs';
    rollback='Uninstall removes exactly journaled filters and newly created accounts; retains protected files for inspection';
    ports="$MainPort main, $GamePort game, $ScannerPort scanner (all loopback)"} | Format-List
  return
}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run the reviewed operation in elevated PowerShell after explicit approval.'}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-isolation.cs')
. (Join-Path $PSScriptRoot 'isolation-pipes.ps1')
if($Action -eq 'Install') {
  if(Test-Path -LiteralPath $Root){throw 'Refusing to reuse any existing installation directory'}
  Assert-PlainPath (Split-Path -Parent $Root)
  foreach($origin in @($MainOrigin,$GameOrigin)){if(([uri]$origin).Scheme -ne 'https'){throw 'HTTPS public origins required'}}
  New-Item -ItemType Directory -Path $Root | Out-Null
  Protect $Root @{}
  $id=$installationId
  $state=@{version=1;root=$Root;id=$id;complete=$false;accounts=@();filters=@();scannerPort=$ScannerPort}
  foreach($role in @('main','game','validator')){
    $name='agp'+$id+$role.Substring(0,1)
    if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Account name collision'}
    $state.accounts+=@{role=$role;name=$name;sid=$null}
  }
  $state.filters=@(1..6 | ForEach-Object {[guid]::NewGuid().ToString()})
  Json $journal $state
  try {
    foreach($account in $state.accounts){
      $password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
      $secure=ConvertTo-SecureString $password -AsPlainText -Force
      $user=New-LocalUser -Name $account.name -Password $secure -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description ('AGP isolated runtime '+$id)
      $account.sid=$user.SID.Value
      [pscredential]::new($account.name,$secure) | Export-Clixml -LiteralPath (Join-Path $Root ($account.role+'.credential.xml'))
      Json $journal $state
    }
    $main=$state.accounts[0].sid;$game=$state.accounts[1].sid;$validator=$state.accounts[2].sid
    # Inspect/traverse the root, without inheriting access to private descendants.
    $rootAcl=Get-Acl -LiteralPath $Root
    foreach($sid in @($main,$game,$validator)){$rootAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute','Allow'))}
    Set-Acl -LiteralPath $Root -AclObject $rootAcl
    foreach($dir in @('code','private','serving','inbox','stage','main','game','validator')){New-Item -ItemType Directory -Path (Join-Path $Root $dir) | Out-Null}
    Protect (Join-Path $Root 'code') @{$main='ReadAndExecute';$game='ReadAndExecute';$validator='ReadAndExecute'}
    Protect (Join-Path $Root 'private') @{$main='Modify'}
    Protect (Join-Path $Root 'serving') @{$main='Modify';$game='ReadAndExecute'}
    Protect (Join-Path $Root 'inbox') @{$main='Modify';$validator='ReadAndExecute'}
    Protect (Join-Path $Root 'stage') @{$main='ReadAndExecute';$validator='Modify'}
    foreach($account in $state.accounts){
      $dir=Join-Path $Root $account.role
      Protect $dir @{$account.sid='ReadAndExecute'}
      New-Item -ItemType Directory -Path (Join-Path $dir 'temp') | Out-Null
      Protect (Join-Path $dir 'temp') @{$account.sid='Modify'}
      Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $dir 'node.exe')
    }
    # Deliberate allowlist: never copy data, .env, repository metadata or backups.
    foreach($dir in @('backend','frontend','node_modules')){Copy-Item -LiteralPath (Join-Path $project $dir) -Destination (Join-Path $Root 'code') -Recurse}
    New-Item -ItemType Directory -Path (Join-Path $Root 'code\database') | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'database\migrations') -Destination (Join-Path $Root 'code\database') -Recurse
    Copy-Item -LiteralPath (Join-Path $project 'package.json') -Destination (Join-Path $Root 'code')
    New-Item -ItemType Directory -Path (Join-Path $Root 'code\tests') | Out-Null
    if($Root.StartsWith(($project+'\tmp\'),[StringComparison]::OrdinalIgnoreCase)){
      foreach($file in @('windows-isolation-probe.mjs','windows-job-probe.mjs','isolation-fixture.mjs','zip-fixture.mjs')){Copy-Item -LiteralPath (Join-Path $project ('tests\'+$file)) -Destination (Join-Path $Root 'code\tests')}
      New-Item -ItemType Directory -Path (Join-Path $Root 'code\tests\integration') | Out-Null
      Copy-Item -LiteralPath (Join-Path $project 'tests\integration\production-runtime.test.mjs') -Destination (Join-Path $Root 'code\tests\integration')
    }
    $keys=@{}
    foreach($role in @('auth','validator','control')){$keys[$role]=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()}
    $limits=@{compressed=100000000;expanded=300000000;files=500}
    foreach($account in $state.accounts){
      $dir=Join-Path $Root $account.role
      $config=@{version=1;role=$account.role;limits=$limits;mainOrigin=$MainOrigin;gameOrigin=$GameOrigin;gameListenOrigin="http://127.0.0.2:$GamePort";scannerPort=$ScannerPort}
      $channels=switch($account.role){'main'{@('auth','validator','control')};'game'{@('auth','control')};'validator'{@('validator')}}
      foreach($channel in $channels){
        $keyFile=Join-Path $dir ($channel+'.key');Set-Content -LiteralPath $keyFile -Value $keys[$channel] -NoNewline
        $config[$channel]=@{pipe="\\.\pipe\agp-$id-$channel";service=$channel;keyFile=$keyFile}
      }
      if($account.role -ne 'validator'){$config.servingRoot=Join-Path $Root 'serving'}
      if($account.role -ne 'game'){$config.inboxRoot=Join-Path $Root 'inbox';$config.stageRoot=Join-Path $Root 'stage'}
      Json (Join-Path $dir 'runtime.json') $config
    }
    if($MainEnvironmentFile){Copy-Item -LiteralPath $MainEnvironmentFile -Destination (Join-Path $Root 'main\main.env')}
    $mainConfig=@{APP_ENV='production';HOST='127.0.0.1';PORT="$MainPort";MAIN_ORIGIN=$MainOrigin;GAME_ORIGIN=$GameOrigin;
      PRIVATE_STORAGE_DRIVER='local';PRIVATE_STORAGE_ROOT=(Join-Path $Root 'private');PRIVATE_STORAGE_TRUST_ROOT=(Join-Path $Root 'private');
      PRIVATE_STORAGE_ACCOUNT=$main;PRIVATE_STORAGE_ACCOUNT_SID=$main;ISOLATION_CONFIG=(Join-Path $Root 'main\runtime.json')}
    Json (Join-Path $Root 'main\environment.json') $mainConfig
    [AgpNetwork]::Install((Join-Path $Root 'game\node.exe'),0,[string[]]$state.filters[0..1])
    [AgpNetwork]::Install((Join-Path $Root 'validator\node.exe'),$ScannerPort,[string[]]$state.filters[2..5])
    $state.complete=$true;Json $journal $state
    Write-Output 'Installed isolated tree, accounts and network filters. Nothing started.'
  } catch {
    Write-Warning 'Installation incomplete. Use Uninstall with this exact Root to remove journaled filters and accounts. Protected files are retained.'
    throw
  }
  return
}
Assert-PlainPath $Root
$state=Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
if($state.version -ne 1 -or $state.root -ne $Root){throw 'Installation journal mismatch'}
if($Action -eq 'Uninstall') {
  if(Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)}){throw 'Stop supervisor before uninstalling'}
  [AgpNetwork]::Remove([string[]]$state.filters)
  foreach($account in $state.accounts){
    $user=Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue
    if($user){if($user.Description -ne ('AGP isolated runtime '+$state.id) -or ($account.sid -and $user.SID.Value -ne $account.sid)){throw 'Account identity mismatch'};Remove-LocalUser -Name $account.name}
  }
  $state.complete=$false;Json $journal $state
  Write-Output 'Removed installation-owned WFP filters and accounts. Protected files retained; no database or user data deleted.'
  return
}
if(-not $state.complete){throw 'Incomplete installation'}
[AgpNetwork]::AssertInstalled([string[]]$state.filters)
if(-not(Test-Path -LiteralPath (Join-Path $Root 'main\main.env'))){throw 'Main environment file required; database/session credentials belong only in main/main.env'}
$jobs=@()
try {
  foreach($role in @('validator','main','game')){
    $dir=Join-Path $Root $role;$credential=Import-Clixml -LiteralPath (Join-Path $Root ($role+'.credential.xml'))
    $environment=@("SystemRoot=$env:SystemRoot","WINDIR=$env:WINDIR","PATH=$env:SystemRoot\System32","TEMP=$dir\temp","TMP=$dir\temp")
    if($role -eq 'main'){
      $values=Get-Content -LiteralPath (Join-Path $dir 'environment.json') -Raw | ConvertFrom-Json -AsHashtable
      foreach($item in $values.GetEnumerator()){$environment+=($item.Key+'='+$item.Value)}
      $arguments='--env-file="'+(Join-Path $dir 'main.env')+'" "'+(Join-Path $Root 'code\backend\src\server.mjs')+'"'
      $memory=1024;$cpu=50;$count=4
    } else {
      $entry=if($role -eq 'game'){'game-server.mjs'}else{'validator.mjs'}
      $arguments='"'+(Join-Path $Root ('code\backend\src\'+$entry))+'" "'+(Join-Path $dir 'runtime.json')+'"'
      $memory=if($role -eq 'game'){256}else{768};$cpu=if($role -eq 'game'){15}else{25};$count=1
    }
    $job=[AgpJob]::new((Join-Path $dir 'node.exe'),$arguments,(Join-Path $Root 'code'),[string[]]$environment,$credential.UserName,$credential.GetNetworkCredential().Password,$memory,$cpu,$count)
    $jobs+=@{role=$role;job=$job}
    Write-Output "$role PID $($job.Pid)"
    Grant-AgpPipe $state $Root $role
  }
  Write-Output 'Supervisor active. Ctrl+C stops all owned process trees; no public tunnel is started.'
  while($true){
    if($jobs[1].job.Exited){throw 'Main exited; stopping owned process trees'}
    # A worker crash is not propagated to main. Readiness reports 503; recovery
    # is an operator restart, never an unchecked respawn loop.
    Start-Sleep -Seconds 1
  }
} finally {foreach($entry in $jobs){$entry.job.Dispose()}}
