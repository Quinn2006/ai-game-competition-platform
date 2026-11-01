param([Parameter(Mandatory=$true)][string]$Runtime,[int]$Port=55645,[switch]$Regression)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$state=Join-Path $project ('tmp\community-db-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
if(Test-Path -LiteralPath $state){throw 'Refusing existing state'}
New-Item -ItemType Directory -Path $state | Out-Null
$password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$pw=Join-Path $state 'password.tmp'
Set-Content -LiteralPath $pw -Value $password -NoNewline
& (Join-Path $Runtime 'initdb.exe') -D (Join-Path $state 'data') -U app_test --pwfile=$pw --auth=scram-sha-256 --encoding=UTF8 --locale=C
if($LASTEXITCODE -ne 0){throw 'initdb failed'}
$arguments='-D "'+(Join-Path $state 'data')+'" -l "'+(Join-Path $state 'postgres.log')+'" -o "-p '+$Port+' -h 127.0.0.1" -w start'
$process=Start-Process -FilePath (Join-Path $Runtime 'pg_ctl.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
if(-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0){throw 'Postgres start failed'}
$env:PGPASSWORD=$password
try{& (Join-Path $Runtime 'createdb.exe') -h 127.0.0.1 -p $Port -U app_test ai_games_test;if($LASTEXITCODE -ne 0){throw 'createdb failed'}}finally{Remove-Item Env:\PGPASSWORD}
@{database="postgres://app_test:${password}@127.0.0.1:${Port}/ai_games_test";state=$state} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'credentials.json')
$env:DATABASE_URL="postgres://app_test:${password}@127.0.0.1:${Port}/ai_games_test"
$env:CONFIRM_DISPOSABLE_DATABASE='ai_games_test'
try{if($Regression){$env:APP_ENV='test';node --test (Join-Path $project 'tests/integration/postgres.test.mjs')}else{node (Join-Path $PSScriptRoot 'check-community-db.mjs')};if($LASTEXITCODE -ne 0){throw 'Discovery database checks failed'}}finally{Remove-Item Env:\DATABASE_URL;Remove-Item Env:\CONFIRM_DISPOSABLE_DATABASE}
Write-Output ('Test state: '+$state)
