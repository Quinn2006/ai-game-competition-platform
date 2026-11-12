function Test-AgpResourceContainment($Root,$Checkpoint) {
  if($Checkpoint.mainAddress.address -ne '127.0.0.1' -or $Checkpoint.mainHost -notmatch '^[a-zA-Z0-9.:-]+$'){throw 'Invalid main probe endpoint'}
  $uri='http://127.0.0.1:'+$Checkpoint.mainAddress.port+'/health/live'
  $dir=Join-Path $Root 'game';$credential=Import-Clixml -LiteralPath (Join-Path $Root 'game.credential.xml')
  $report=@{mainResponses=@()}
  foreach($mode in @('memory','cpu')){
    $job=$null;$output=Join-Path $dir ('temp\resource-'+$mode+'.json')
    try {
      $cpu=if($mode -eq 'cpu'){1}else{15}
      $arguments='"'+(Join-Path $Root 'code\tests\windows-job-probe.mjs')+'" '+$mode+' "'+$output+'"'
      $job=[AgpJob]::new((Join-Path $dir 'node.exe'),$arguments,(Join-Path $Root 'code'),[string[]]@("SystemRoot=$env:SystemRoot","TEMP=$dir\temp","TMP=$dir\temp"),$credential.UserName,$credential.GetNetworkCredential().Password,256,$cpu,1)
      $timer=[Diagnostics.Stopwatch]::StartNew()
      while(-not(Test-Path -LiteralPath $output) -and -not $job.Exited -and $timer.Elapsed.TotalSeconds -lt 10){Start-Sleep -Milliseconds 50}
      if(-not(Test-Path -LiteralPath $output)){throw 'Resource probe did not initialize'}
      if($mode -eq 'cpu'){
        $process=Get-Process -Id $job.Pid;$initial=$process.TotalProcessorTime.TotalSeconds;$measurement=[Diagnostics.Stopwatch]::StartNew()
        for($i=0;$i -lt 5;$i++){
          Start-Sleep -Seconds 1
          $watch=[Diagnostics.Stopwatch]::StartNew();$response=Invoke-WebRequest -Uri $uri -Headers @{Host=$Checkpoint.mainHost} -TimeoutSec 3
          if($response.StatusCode -ne 200){throw 'Main became unavailable under worker CPU load'}
          $report.mainResponses+=@{status=$response.StatusCode;milliseconds=$watch.ElapsedMilliseconds}
        }
        if($job.Exited){throw 'CPU probe exited unexpectedly'}
        $process.Refresh();$fraction=($process.TotalProcessorTime.TotalSeconds-$initial)/$measurement.Elapsed.TotalSeconds/[Environment]::ProcessorCount
        if($fraction -le 0 -or $fraction -gt 0.03){throw 'CPU hard cap failed'}
        $report.cpuFraction=$fraction
      }else{
        while(-not $job.Exited -and $timer.Elapsed.TotalSeconds -lt 10){Start-Sleep -Milliseconds 100}
        $value=Get-Content -LiteralPath $output -Raw
        if(-not $job.Exited -or $value -eq 'limit-escaped'){throw 'Worker escaped memory cap'}
        $report.memory=$value
        $response=Invoke-WebRequest -Uri $uri -Headers @{Host=$Checkpoint.mainHost} -TimeoutSec 3
        if($response.StatusCode -ne 200){throw 'Main became unavailable after worker allocation failure'}
        $report.mainAfterMemory=$response.StatusCode
      }
      $ownedPid=$job.Pid
    }finally{if($job){$job.Dispose()}}
    if(Get-Process -Id $ownedPid -ErrorAction SilentlyContinue){throw 'Resource probe survived job disposal'}
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Root 'resource-evidence.json')
}
