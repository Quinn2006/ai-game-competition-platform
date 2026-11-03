#Requires -Version 5.1
[CmdletBinding()]
param([string]$PgBin=$env:PG_BIN,[string]$ClamAvBin=$env:CLAMAV_BIN)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$previousPg=$env:PG_BIN
$previousClam=$env:CLAMAV_BIN
$previous=@{}
$result=0
Push-Location $project
try {
    if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw 'Install Node.js 24+ first: https://nodejs.org/'}
    $major=& node -p 'process.versions.node.split(".")[0]'
    if($LASTEXITCODE -ne 0 -or [int]$major -lt 24){throw 'Node.js 24+ is required.'}
    if(-not(Get-Command npm.cmd -ErrorAction SilentlyContinue)){throw 'npm.cmd is required.'}
    $toolsPath=Join-Path $project 'data\local-tools.json'
    if(Test-Path -LiteralPath $toolsPath){
        $saved=Get-Content -LiteralPath $toolsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if(-not $PgBin){$PgBin=$saved.pgBin}
        if(-not $ClamAvBin){$ClamAvBin=$saved.clamAvBin}
    }
    if(-not $PgBin){$command=Get-Command initdb.exe -ErrorAction SilentlyContinue;if($command){$PgBin=Split-Path $command.Source}}
    if(-not $ClamAvBin){$command=Get-Command clamd.exe -ErrorAction SilentlyContinue;if($command){$ClamAvBin=Split-Path $command.Source}}
    if(-not $PgBin -or -not $ClamAvBin){throw 'Provide -PgBin and -ClamAvBin (directories containing initdb.exe and clamd.exe). See docs/first-run.md.'}
    $PgBin=(Resolve-Path -LiteralPath $PgBin).Path
    $ClamAvBin=(Resolve-Path -LiteralPath $ClamAvBin).Path
    foreach($name in @('initdb','pg_ctl','postgres','pg_dump','pg_restore')){
        if(-not(Test-Path -LiteralPath (Join-Path $PgBin ($name+'.exe')) -PathType Leaf)){throw "Missing PostgreSQL tool: $name.exe"}
    }
    foreach($name in @('clamd','freshclam')){
        if(-not(Test-Path -LiteralPath (Join-Path $ClamAvBin ($name+'.exe')) -PathType Leaf)){throw "Missing ClamAV tool: $name.exe"}
    }
    $markers=@('.env','data\credentials.json','data\postgres\PG_VERSION')
    $present=@($markers | Where-Object {Test-Path -LiteralPath (Join-Path $project $_)})
    if($present.Count -gt 0 -and $present.Count -ne $markers.Count){throw 'Incomplete local configuration. Existing files retained; inspect before retrying. Do not copy .env.example before setup.'}
    & npm.cmd ci --ignore-scripts
    if($LASTEXITCODE -ne 0){throw 'npm ci failed.'}
    $env:PG_BIN=$PgBin;$env:CLAMAV_BIN=$ClamAvBin
    if($present.Count -eq 0){
        & node scripts\local-runtime.mjs init
        if($LASTEXITCODE -ne 0){throw 'Database initialization failed; existing files retained.'}
    }else{
        & node scripts\local-runtime.mjs start
        if($LASTEXITCODE -ne 0){throw 'Existing database could not start. Check PostgreSQL major version.'}
    }
    # Save only tool locations; runtime credentials remain in their private files.
    if(Test-Path -LiteralPath $toolsPath){Copy-Item -LiteralPath $toolsPath -Destination ($toolsPath+'.'+[Guid]::NewGuid().ToString('N')+'.bak')}
    $json=@{pgBin=$PgBin;clamAvBin=$ClamAvBin} | ConvertTo-Json
    [IO.File]::WriteAllText($toolsPath,$json,[Text.UTF8Encoding]::new($false))
    # Pin migrations to this instance even if the parent shell has DATABASE_URL set.
    $local=Get-Content -LiteralPath (Join-Path $project 'data\credentials.json') -Raw | ConvertFrom-Json
    $url=[Uri]$local.databaseDevelopment
    if($url.Scheme -ne 'postgres' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/ai_games_development'){throw 'Invalid local database configuration.'}
    $settings=@{APP_ENV='development';DATABASE_URL=$local.databaseDevelopment;DATABASE_TLS='disable';SESSION_SECRET=$local.sessionSecret;LOCAL_GAMES='1';SUBMISSIONS_ROOT=(Join-Path $project 'data\submissions');EXPORTS_ROOT=(Join-Path $project 'data\exports')}
    foreach($name in $settings.Keys){$previous[$name]=[Environment]::GetEnvironmentVariable($name);[Environment]::SetEnvironmentVariable($name,$settings[$name])}
    & node --env-file=.env scripts\migrate.mjs up
    if($LASTEXITCODE -ne 0){throw 'Database migration failed.'}
    & node --env-file=.env scripts\local-builtin-accounts.mjs
    if($LASTEXITCODE -ne 0){throw 'Local account initialization failed.'}
    & (Join-Path $PSScriptRoot 'local-scanner.ps1') -Update
    Write-Host 'Setup complete. Run start-local.cmd. Data is stored in this project/data. PostgreSQL remains running.'
}catch{Write-Host ('Setup failed: '+$_.Exception.Message) -ForegroundColor Red;$result=1}
finally{
    foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
    $env:PG_BIN=$previousPg;$env:CLAMAV_BIN=$previousClam;Pop-Location
}
exit $result
