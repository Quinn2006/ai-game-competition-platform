function Grant-AgpPipe($State,[string]$Root,[string]$Role) {
  $channel=switch($Role){'main'{'auth'};'game'{'control'};'validator'{'validator'};default{throw 'Unknown pipe role'}}
  $clientRole=if($Role -eq 'main'){'game'}else{'main'}
  $serverSid=($State.accounts | Where-Object role -eq $Role).sid
  $clientSid=($State.accounts | Where-Object role -eq $clientRole).sid
  $config=Get-Content -LiteralPath (Join-Path $Root ($Role+'\runtime.json')) -Raw | ConvertFrom-Json
  $timer=[Diagnostics.Stopwatch]::StartNew()
  while($true){
    try{[AgpPipe]::Grant($config.$channel.pipe,$serverSid,$clientSid);return}
    catch{
      $cause=$_.Exception.InnerException
      if($timer.Elapsed.TotalSeconds -ge 10 -or -not ($cause -is [ComponentModel.Win32Exception]) -or $cause.NativeErrorCode -notin @(2,231)){throw}
      Start-Sleep -Milliseconds 100
    }
  }
}
