param([Parameter(Mandatory)][string]$Root,[string]$DatabaseState)
$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath($Root)
$project=Split-Path -Parent $PSScriptRoot
if(-not $Root.StartsWith(($project+'\tmp\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Acceptance uses an installed scratch tree only'}
$state=Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw | ConvertFrom-Json
if($state.root -ne $Root -or -not $state.complete){throw 'Complete matching installation required'}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-isolation.cs')
[AgpNetwork]::AssertInstalled([string[]]$state.filters)
$databaseFile=$null
if($DatabaseState){
  $DatabaseState=[IO.Path]::GetFullPath($DatabaseState)
  if(-not $DatabaseState.StartsWith(($project+'\tmp\isolation-os-db-'),[StringComparison]::OrdinalIgnoreCase)){throw 'Use a newly created isolation-os-db disposable cluster'}
  for($item=Get-Item -LiteralPath $DatabaseState;$null -ne $item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Database state reparse point refused'}}
  $database=Get-Content -LiteralPath (Join-Path $DatabaseState 'credentials.json') -Raw | ConvertFrom-Json
  $databaseUrl=[uri]$database.databaseTest
  if($databaseUrl.Host -ne '127.0.0.1' -or $databaseUrl.AbsolutePath -ne '/ai_games_test'){throw 'Only ai_games_test on loopback is accepted'}
  (Get-Acl -LiteralPath $DatabaseState).Sddl | Set-Content -LiteralPath (Join-Path $Root 'disposable-database-acl.bak')
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  $operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($operatorSid)
  foreach($sid in @($operatorSid.Value,'S-1-5-18','S-1-5-32-544')){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  Set-Acl -LiteralPath $DatabaseState -AclObject $acl
  $databaseFile=Join-Path $DatabaseState 'data\global\pg_control'
  if(-not(Test-Path -LiteralPath $databaseFile)){throw 'Disposable PostgreSQL control file missing'}
}
foreach($name in @('private\probe-db','private\probe-review','private\probe-backup','main\probe-secret','serving\probe-readable')){
  New-Item -ItemType File -Path (Join-Path $Root $name) -Value 'synthetic isolation canary' | Out-Null
}
$listeners=@([Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,4372),[Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback,4373))
$jobs=@();$results=@()
try {
  foreach($listener in $listeners){$listener.Start()}
  foreach($role in @('main','game','validator')){
    $dir=Join-Path $Root $role;$credential=Import-Clixml -LiteralPath (Join-Path $Root ($role+'.credential.xml'))
    $environment=[string[]]@("SystemRoot=$env:SystemRoot","TEMP=$dir\temp","TMP=$dir\temp")
    $arguments='"'+(Join-Path $Root 'code\tests\windows-isolation-probe.mjs')+'" "'+$Root+'" '+$role
    if($databaseFile){$arguments+=' "'+$databaseFile+'"'}
    $job=[AgpJob]::new((Join-Path $dir 'node.exe'),$arguments,(Join-Path $Root 'code'),$environment,$credential.UserName,$credential.GetNetworkCredential().Password,256,20,1)
    $jobs+=$job;$output=Join-Path $dir 'temp\acceptance.json'
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while(-not(Test-Path -LiteralPath $output) -and -not $job.Exited -and $timer.Elapsed.TotalSeconds -lt 30){Start-Sleep -Milliseconds 100}
    if(-not(Test-Path -LiteralPath $output)){throw "$role probe failed; exit $($job.ExitCode)"}
    $result=Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    if($result.secretEnvironment){throw 'Inherited secret environment detected'}
    if($databaseFile -and ($result.files.'disposable-database'.read -or $result.files.'disposable-database'.write)){throw 'An application role accessed the actual disposable PostgreSQL control file'}
    foreach($name in @('private/probe-db','private/probe-review','private/probe-backup','main/probe-secret')){
      $access=$result.files.$name
      if($role -eq 'main'){if(-not $access.read){throw 'Main cannot read its canaries'}}
      elseif($access.read -or $access.write){throw "$role accessed a protected canary"}
    }
    if($role -eq 'game'){
      if(-not $result.files.'serving/probe-readable'.read -or $result.files.'serving/probe-readable'.write -or -not $result.authenticatedPipe){throw 'Game serving or cross-account pipe boundary failed'}
    }
    if($role -ne 'main'){
      foreach($name in @('database','unrelated','ipv6','external','scanner')){
        $expected=if($role -eq 'validator' -and $name -eq 'scanner'){'connected'}else{'EACCES'}
        if($result.network.$name -ne $expected){throw "$role $name network result $($result.network.$name); expected $expected (timeout/refused does not prove isolation)"}
      }
    }
    $results+=$result
  }
  $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Root 'acceptance-evidence.json')
  Write-Output 'PASS: dedicated accounts, NTFS canaries, serving read-only access, cross-account authenticated pipe and IPv4/IPv6 WFP restrictions.'
} finally {
  foreach($job in $jobs){$job.Dispose()}
  foreach($listener in $listeners){$listener.Stop()}
}
if($DatabaseState){
  # Explicitly supplied disposable state, never discover/read the main database.
  $envFile=Join-Path $Root 'main\test.env'
  New-Item -ItemType File -Path $envFile -Value ('DATABASE_URL='+$database.databaseTest) | Out-Null
  $jobs=@{}
  try {
    foreach($role in @('validator','game','main')){
      $dir=Join-Path $Root $role;$credential=Import-Clixml -LiteralPath (Join-Path $Root ($role+'.credential.xml'))
      $environment=@("SystemRoot=$env:SystemRoot","TEMP=$dir\temp","TMP=$dir\temp")
      if($role -eq 'main'){
        $sid=($state.accounts | Where-Object role -eq 'main').sid
        $environment+=@('CONFIRM_DISPOSABLE_DATABASE=ai_games_test','ISOLATED_RUNTIME=1',"CLAMD_PORT=$($state.scannerPort)","ISOLATION_EXTERNAL_CONFIG=$dir\runtime.json","ISOLATION_TEST_PRIVATE_ROOT=$Root\private","ISOLATION_TEST_SID=$sid")
        $arguments='--env-file="'+$envFile+'" --test --test-reporter=spec --test-reporter-destination="'+$dir+'\temp\business.log" "'+(Join-Path $Root 'code\tests\integration\production-runtime.test.mjs')+'"'
        $memory=1024;$cpu=50;$count=4
      }else{
        $entry=if($role -eq 'game'){'game-server.mjs'}else{'validator.mjs'}
        $arguments='"'+(Join-Path $Root ('code\backend\src\'+$entry))+'" "'+(Join-Path $dir 'runtime.json')+'"'
        $memory=if($role -eq 'game'){256}else{768};$cpu=if($role -eq 'game'){15}else{25};$count=1
      }
      $jobs[$role]=[AgpJob]::new((Join-Path $dir 'node.exe'),$arguments,(Join-Path $Root 'code'),[string[]]$environment,$credential.UserName,$credential.GetNetworkCredential().Password,$memory,$cpu,$count)
      if($role -ne 'main'){Start-Sleep -Seconds 2}
    }
    $timer=[Diagnostics.Stopwatch]::StartNew();$faultDone=$false
    while(-not $jobs.main.Exited -and $timer.Elapsed.TotalSeconds -lt 120){
      $checkpoint=Join-Path $Root 'private\fault-ready.json'
      if(-not $faultDone -and (Test-Path -LiteralPath $checkpoint)){
        $fault=Get-Content -LiteralPath $checkpoint -Raw | ConvertFrom-Json
        if($fault.phase -ne 'kill-game' -or $fault.gamePid -ne $jobs.game.Pid){throw 'Fault checkpoint does not match the owned game process'}
        $jobs.game.Dispose();$faultDone=$true
        New-Item -ItemType File -Path (Join-Path $Root 'private\fault-done') -Value 'owned game job closed' | Out-Null
      }
      Start-Sleep -Milliseconds 100
    }
    if(-not $jobs.main.Exited -or $jobs.main.ExitCode -ne 0 -or -not $faultDone){throw 'Dedicated-account business acceptance failed; inspect protected main/temp/business.log'}
    Write-Output 'PASS: dedicated main/game/validator accounts, actual private-store ACL, real PostgreSQL/ClamAV flow, game crash and main survival.'
  } finally {foreach($job in $jobs.Values){$job.Dispose()}}
}
