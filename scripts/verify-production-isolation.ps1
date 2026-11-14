$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot;$root=Join-Path $project 'data\production';$runtime=Join-Path $root 'runtime'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Approved elevated acceptance required'}
$state=Get-Content -LiteralPath (Join-Path $runtime 'installation.json') -Raw | ConvertFrom-Json
if($state.root -ne $runtime -or -not $state.complete){throw 'Complete exact production installation required'}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-isolation.cs')
[AgpNetwork]::AssertInstalled([string[]]$state.filters)
foreach($area in @('private','serving','inbox','stage')){
  $path=Join-Path $runtime ($area+'\acceptance-canary')
  if(-not(Test-Path -LiteralPath $path)){[IO.File]::WriteAllText($path,'production isolation acceptance canary')}
}
$source=Join-Path $project 'tests\production-boundary-probe.mjs';$target=Join-Path $runtime 'code\tests\production-boundary-probe.mjs'
if(Test-Path -LiteralPath $target){if((Get-FileHash $source).Hash -ne (Get-FileHash $target).Hash){throw 'Installed probe differs'}}else{Copy-Item -LiteralPath $source -Destination $target}
$mainConfig=Get-Content -LiteralPath (Join-Path $runtime 'main\runtime.json') -Raw | ConvertFrom-Json
$results=@();$runId=[guid]::NewGuid().ToString('N')
try {
foreach($role in @('main','game','validator')){
  $dir=Join-Path $runtime $role;$credential=Import-Clixml -LiteralPath (Join-Path $runtime ($role+'.credential.xml'))
  $arguments='"'+$target+'" "'+$root+'" '+$role+' "'+$mainConfig.auth.pipe+'"'
  $job=$null
  try {
    $job=[AgpJob]::new((Join-Path $dir 'node.exe'),$arguments,(Join-Path $runtime 'code'),[string[]]@("SystemRoot=$env:SystemRoot","SystemDrive=$env:SystemDrive","TEMP=$dir\temp","TMP=$dir\temp"),$credential.UserName,$credential.GetNetworkCredential().Password,256,15,1)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while(-not $job.Exited -and $timer.Elapsed.TotalSeconds -lt 25){Start-Sleep -Milliseconds 100}
    if(-not $job.Exited -or $job.ExitCode -ne 0){throw 'Actual role probe failed'}
    $result=Get-Content -LiteralPath (Join-Path $dir 'temp\production-boundary.json') -Raw | ConvertFrom-Json
    $results+=$result
    if($result.secretEnvironment){throw 'Secrets inherited by probe'}
    foreach($name in @('database','maintenance','recovery')){if($result.files.$name.read -or $result.files.$name.write -or $result.files.$name.readError -notin @('EACCES','EPERM')){throw "Protected $name boundary failed"}}
    $expected=switch($role){
      'main'{@{mainConfig=@($true,$false);private=@($true,$true);serving=@($true,$true);inbox=@($true,$true);stage=@($true,$false)}}
      'game'{@{mainConfig=@($false,$false);private=@($false,$false);serving=@($true,$false);inbox=@($false,$false);stage=@($false,$false)}}
      'validator'{@{mainConfig=@($false,$false);private=@($false,$false);serving=@($false,$false);inbox=@($true,$false);stage=@($true,$true)}}
    }
    foreach($name in $expected.Keys){if($result.files.$name.read -ne $expected[$name][0] -or $result.files.$name.write -ne $expected[$name][1]){throw "$role $name ACL boundary failed"}}
    if($role -ne 'main'){foreach($name in @('database','main','scanner','ipv6','external')){$value=if($role -eq 'validator' -and $name -eq 'scanner'){'connected'}else{'EACCES'};if($result.network.$name -ne $value){throw "$role $name WFP boundary failed"}}}
    if($role -eq 'validator' -and $result.unauthorizedPipe -notin @('EACCES','EPERM')){throw 'Validator reached main authorization pipe'}
  } finally {if($job){$job.Dispose()}}
}
$source=Join-Path $project 'tests\windows-job-probe.mjs';$target=Join-Path $runtime 'code\tests\windows-job-probe.mjs'
if(Test-Path -LiteralPath $target){if((Get-FileHash $source).Hash -ne (Get-FileHash $target).Hash){throw 'Installed resource probe differs'}}else{Copy-Item -LiteralPath $source -Destination $target}
. (Join-Path $PSScriptRoot 'isolation-resource-acceptance.ps1')
$resourceReport=Join-Path $root ('evidence\resource-acceptance-'+$runId+'.json')
Test-AgpResourceContainment $runtime @{mainAddress=@{address='127.0.0.1';port=4320};mainHost=([uri]$mainConfig.mainOrigin).Authority} $resourceReport
@{passed=$true;at=[DateTimeOffset]::UtcNow.ToString('o');roles=$results;resources=$resourceReport} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root ('evidence\isolation-acceptance-'+$runId+'.json'))
Write-Output 'PASS: actual production ACL, WFP, pipe denial and Job memory/CPU containment.'
}catch{
  @{passed=$false;at=[DateTimeOffset]::UtcNow.ToString('o');role=$role;message=$_.Exception.Message;roles=$results} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root ('evidence\isolation-acceptance-'+$runId+'.json'))
  throw
}
