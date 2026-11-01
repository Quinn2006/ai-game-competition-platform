$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $project 'tmp\phase2-postgres\runtime\pgsql\bin'
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'initdb.exe'))) { throw 'Download the reviewed PostgreSQL portable package first.' }
$state = Join-Path $project ('tmp\phase2-postgres\run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $state) { throw 'Refusing to reuse a database directory.' }
New-Item -ItemType Directory -Path $state | Out-Null
$password = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$sessionKey = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$pwFile = Join-Path $state 'init-password.tmp'
Set-Content -LiteralPath $pwFile -Value $password -NoNewline
& (Join-Path $runtime 'initdb.exe') -D (Join-Path $state 'data') -U app_test --pwfile=$pwFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
$logFile = Join-Path $state 'postgres.log'
$dataPath = Join-Path $state 'data'
$arguments = '-D "' + $dataPath + '" -l "' + $logFile + '" -o "-p 55432 -h 127.0.0.1" -w start'
$started = Start-Process -FilePath (Join-Path $runtime 'pg_ctl.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
if (-not $started.WaitForExit(30000)) { throw 'pg_ctl did not complete within 30 seconds' }
if ($started.ExitCode -ne 0) { throw 'pg_ctl failed; inspect the ignored postgres.log' }
$env:PGPASSWORD = $password
try {
  & (Join-Path $runtime 'createdb.exe') -h 127.0.0.1 -p 55432 -U app_test ai_games_test
  if ($LASTEXITCODE -ne 0) { throw 'createdb test failed' }
  & (Join-Path $runtime 'psql.exe') -h 127.0.0.1 -p 55432 -U app_test -d postgres -v ON_ERROR_STOP=1 -c 'CREATE ROLE app_development LOGIN'
  if ($LASTEXITCODE -ne 0) { throw 'create development role failed' }
  # Password is randomly generated hex; no user input or connection secret is printed.
  $roleSql = Join-Path $state 'role.tmp'
  Set-Content -LiteralPath $roleSql -Value ("ALTER ROLE app_development PASSWORD '" + $password + "';")
  & (Join-Path $runtime 'psql.exe') -h 127.0.0.1 -p 55432 -U app_test -d postgres -v ON_ERROR_STOP=1 -f $roleSql
  if ($LASTEXITCODE -ne 0) { throw 'set development password failed' }
  & (Join-Path $runtime 'createdb.exe') -h 127.0.0.1 -p 55432 -U app_test -O app_development ai_games_development
  if ($LASTEXITCODE -ne 0) { throw 'createdb development failed' }
} finally { Remove-Item Env:\PGPASSWORD }
$config = @{ state=$state; databaseTest="postgres://app_test:${password}@127.0.0.1:55432/ai_games_test"; databaseDevelopment="postgres://app_development:${password}@127.0.0.1:55432/ai_games_development"; sessionSecret=$sessionKey }
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'credentials.json')
Write-Output ('Local test state: ' + $state)
Write-Output 'Listening only on 127.0.0.1:55432. No system service installed. Credentials remain in ignored local state.'
