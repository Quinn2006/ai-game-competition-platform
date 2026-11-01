param([Parameter(Mandatory=$true)][string]$State)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$resolved=[IO.Path]::GetFullPath($State)
$allowed=[IO.Path]::GetFullPath((Join-Path $project 'tmp\phase2-postgres'))+[IO.Path]::DirectorySeparatorChar
if (-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'State must be inside this project tmp\phase2-postgres directory' }
$localConfig=Get-Content -LiteralPath (Join-Path $resolved 'credentials.json') -Raw | ConvertFrom-Json
$url=[Uri]$localConfig.databaseDevelopment
if($url.Host -ne '127.0.0.1' -or $url.Port -ne 55432 -or $url.AbsolutePath -ne '/ai_games_development') {throw 'Only the local development database is allowed'}
$ctl=Join-Path $project 'tmp\phase2-postgres\runtime\pgsql\bin\pg_ctl.exe'
$data=Join-Path $resolved 'data'
& $ctl -D $data status
if($LASTEXITCODE -ne 0){
  $arguments='-D "'+$data+'" -l "'+(Join-Path $resolved 'postgres.log')+'" -o "-p 55432 -h 127.0.0.1" -w start'
  $started=Start-Process -FilePath $ctl -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if(-not $started.WaitForExit(30000) -or $started.ExitCode -ne 0){throw 'Local PostgreSQL start failed'}
}
$previous=@{}
foreach($name in @('APP_ENV','DATABASE_URL','SESSION_SECRET','LOCAL_MAIL_PREVIEW')){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
try{
  $env:APP_ENV='development';$env:DATABASE_URL=$localConfig.databaseDevelopment;$env:SESSION_SECRET=$localConfig.sessionSecret;$env:LOCAL_MAIL_PREVIEW='1'
  Push-Location $project
  try{
    node scripts\migrate.mjs up
    if($LASTEXITCODE -ne 0){throw 'Migration failed; server not started'}
    Write-Output 'Account page: http://127.0.0.1:4320/account'
    Write-Output 'Development mailbox: http://127.0.0.1:4320/dev/mail (synthetic data only)'
    node src\server.mjs
  }finally{Pop-Location}
}finally{foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}}
