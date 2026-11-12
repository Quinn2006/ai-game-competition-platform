param()
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $PSScriptRoot 'windows-isolation.cs')
$root=Join-Path $project ('tmp\job-acceptance-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$node=(Get-Command node.exe).Source
$probe=Join-Path $project 'tests\windows-job-probe.mjs'
$results=@{}
foreach($mode in @('child','memory','cpu')){
  $output=Join-Path $root ($mode+'.json')
  $job=$null
  try {
    $cpu=if($mode -eq 'cpu'){1}else{20}
    $memory=if($mode -eq 'cpu'){512}else{128}
    $job=[AgpJob]::new($node,('"'+$probe+'" '+$mode+' "'+$output+'"'),$project,[string[]]@("SystemRoot=$env:SystemRoot","TEMP=$root","TMP=$root"),'','',$memory,$cpu,1)
    $started=[datetime]::UtcNow
    while(-not(Test-Path -LiteralPath $output) -and -not $job.Exited -and ([datetime]::UtcNow-$started).TotalSeconds -lt 15){Start-Sleep -Milliseconds 100}
    if(-not(Test-Path -LiteralPath $output)){throw "$mode did not initialize; exit $($job.ExitCode)"}
    if($mode -eq 'cpu'){
      $process=Get-Process -Id $job.Pid
      $initial=$process.TotalProcessorTime.TotalSeconds;$timer=[Diagnostics.Stopwatch]::StartNew()
      Start-Sleep -Seconds 5
      if($job.Exited){throw "CPU probe exited unexpectedly: $($job.ExitCode)"}
      $process.Refresh();$elapsed=$timer.Elapsed.TotalSeconds
      $fraction=($process.TotalProcessorTime.TotalSeconds-$initial)/$elapsed/[Environment]::ProcessorCount
      if($fraction -gt 0.03 -or $fraction -le 0){throw "CPU cap failed: $fraction"}
      $results.cpuFraction=$fraction
    } else {
      while(-not $job.Exited -and ([datetime]::UtcNow-$started).TotalSeconds -lt 15){Start-Sleep -Milliseconds 100}
      if(-not $job.Exited){throw "$mode did not finish"}
      $value=Get-Content -LiteralPath $output -Raw
      if($mode -eq 'child' -and -not ($value|ConvertFrom-Json).blocked){throw 'Child process escaped job'}
      if($mode -eq 'memory' -and $value -eq 'limit-escaped'){throw 'Memory limit escaped'}
      $results[$mode]=$value
    }
    $ownedPid=$job.Pid
  } finally {if($job){$job.Dispose()}}
  if(Get-Process -Id $ownedPid -ErrorAction SilentlyContinue){throw 'Owned process survived job disposal'}
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'evidence.json')
$results | ConvertTo-Json
Write-Output "PASS: real Windows Job Object CPU, memory, child process refusal and disposal; current user only. Evidence: $root"
