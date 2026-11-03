param([switch]$Update,[switch]$Start,[string]$Root,[switch]$PassThru)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
if(-not $Root){$Root=Join-Path $project 'tmp\phase3-clamav'}
$runtime=Join-Path $root 'runtime\clamav-1.5.4.win.x64'
if(-not(Test-Path -LiteralPath (Join-Path $runtime 'clamd.exe'))){throw 'Verified ClamAV 1.5.4 portable runtime is required; see phase 3 documentation.'}
$database=Join-Path $root 'database'
New-Item -ItemType Directory -Path $database -Force | Out-Null
# Generate only a new configuration directory; existing configuration is never overwritten.
$configuration=Join-Path $root ('config-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $configuration | Out-Null
$fresh=Join-Path $configuration 'freshclam.conf'
@("DatabaseDirectory $database",'DatabaseMirror database.clamav.net','MaxAttempts 1') | Set-Content -LiteralPath $fresh
$clamd=Join-Path $configuration 'clamd.conf'
@("DatabaseDirectory $database",'TCPSocket 3310','TCPAddr 127.0.0.1','Foreground yes',
  'StreamMaxLength 300000000','MaxScanSize 400000000','MaxFileSize 300000000','MaxFiles 1000',
  'MaxRecursion 20','AlertExceedsMax yes','MaxThreads 2','MaxQueue 4') | Set-Content -LiteralPath $clamd
if($Update){& (Join-Path $runtime 'freshclam.exe') "--config-file=$fresh" --quiet; if($LASTEXITCODE -ne 0){throw 'Official signature update failed; scanner not started.'};Write-Output 'Official signature database updated.'}
if($Start){
  $probe=[Net.Sockets.TcpClient]::new();$occupied=$false
  try{$probe.Connect('127.0.0.1',3310);$occupied=$true}catch{}finally{$probe.Dispose()}
  if($occupied){throw 'Port 3310 is already in use; reuse the existing verified scanner or stop it before starting another.'}
  if(-not(Test-Path -LiteralPath (Join-Path $database 'daily.cvd')) -and -not(Test-Path -LiteralPath (Join-Path $database 'daily.cld'))){throw 'Official signature database missing; run -Update first.'}
  $process=Start-Process -FilePath (Join-Path $runtime 'clamd.exe') -ArgumentList ('--config-file="'+$clamd+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $configuration 'clamd.stdout.log') -RedirectStandardError (Join-Path $configuration 'clamd.stderr.log')
  $ready=$false
  for($attempt=0;$attempt -lt 60;$attempt++){
    if($process.HasExited){throw "Scanner exited; inspect logs in $configuration"}
    $client=[Net.Sockets.TcpClient]::new()
    try{
      $client.Connect('127.0.0.1',3310)
      $stream=$client.GetStream();$stream.ReadTimeout=500
      $request=[Text.Encoding]::ASCII.GetBytes("zPING`0");$stream.Write($request,0,$request.Length)
      $reply=[byte[]]::new(32);$count=$stream.Read($reply,0,$reply.Length)
      if([Text.Encoding]::ASCII.GetString($reply,0,$count).Trim([char]0) -eq 'PONG'){$ready=$true;break}
    }catch{}finally{$client.Dispose()}
    Start-Sleep -Milliseconds 250
  }
  if(-not $ready){if(-not $process.HasExited){$process.Kill();$process.WaitForExit()};throw "Scanner did not become ready; inspect logs in $configuration"}
  Write-Output "Local scanner ready on 127.0.0.1:3310; PID: $($process.Id); configuration: $configuration"
  if($PassThru){Write-Output $process}
}
