$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'read-shared-json.ps1')
$project=Split-Path -Parent $PSScriptRoot;$root=Join-Path $project 'data\production'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Approved elevated acceptance required'}
$evidence=Join-Path $root 'evidence';$journal=Join-Path $evidence 'controller-state.json'
$report=@{startedAt=[DateTimeOffset]::UtcNow.ToString('o');passed=$false}
function Wait-Closed([DateTimeOffset]$Since){
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(210)
  do{
    $state=Read-AgpSharedJson $journal
    if($state.at -and [DateTimeOffset]$state.at -ge $Since -and $state.clean -eq $true){
      if(-not $state.ingressClosed -or -not $state.writersStopped -or -not $state.databaseStopped -or -not $state.localBackupVerified -or $state.writerOutcome.forcedAbort){throw 'Manual close evidence failed'}
      if((Get-Service AGP-PostgreSQL-Production).Status -ne 'Stopped'){throw 'Database service still running'}
      if(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in @(4320,4321,55441,3310)){throw 'Production listener remains after close'}
      # Wait for the owning host to release the lock before testing Backup.
      $lock=$null
      try{$lock=[IO.File]::Open((Join-Path $evidence 'controller.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);return $state}
      catch [IO.IOException]{}
      finally{if($lock){$lock.Dispose()}}
    }
    Start-Sleep -Seconds 1
  }while([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'Manual close did not complete; installation left closed or draining for inspection'
}
try{
  $state=Read-AgpSharedJson $journal
  if($state.phase -ne 'active'){throw 'Running reviewed production required before manual cycle'}
  $since=[DateTimeOffset]::UtcNow
  & (Join-Path $root 'Stop.ps1');if($LASTEXITCODE -ne 0){throw 'Stop entry failed'}
  $report.stop=Wait-Closed $since
  Write-Output 'PASS: manual Stop drained, verified backup and released all production listeners.'
  $since=[DateTimeOffset]::UtcNow
  & (Join-Path $root 'Backup.ps1');if($LASTEXITCODE -ne 0){throw 'Backup entry failed'}
  $report.backup=Wait-Closed $since
  Write-Output 'PASS: manual Backup from stopped state verified a new backup and remained closed.'
  & (Join-Path $root 'Start.ps1');if($LASTEXITCODE -ne 0){throw 'Start entry failed'}
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(150)
  do{
    $state=Read-AgpSharedJson $journal
    if($state.phase -eq 'active' -and [DateTimeOffset]$state.startedAt -ge $since){
      $response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4320/health/ready' -TimeoutSec 5
      if($response.StatusCode -ne 200){throw 'Restart readiness failed'}
      $report.restart=$state;$report.passed=$true;break
    }
    Start-Sleep -Seconds 1
  }while([DateTimeOffset]::UtcNow -lt $deadline)
  if(-not $report.passed){throw 'Restart did not become active; inspect protected evidence'}
  Write-Output 'PASS: manual Stop / Backup / Start cycle; production is active again.'
}catch{$report.error=$_.Exception.Message;throw}
finally{
  $report.finishedAt=[DateTimeOffset]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence ('manual-cycle-'+[guid]::NewGuid().ToString('N')+'.json'))
}
