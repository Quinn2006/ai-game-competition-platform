#Requires -Version 7.0
[CmdletBinding()]
param([string]$State,[ValidateRange(1024,65535)][int]$DatabasePort=55438)
$ErrorActionPreference='Stop'
$project=$PSScriptRoot
$previous=@{}
$startedDatabase=$false
$startedScanner=$null

function Assert-FreePort([string]$Address,[int]$Port) {
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Address),$Port)
    try { $listener.Start() } catch { throw "端口 ${Address}:$Port 已被占用，请先关闭此前的服务。" }
    finally { $listener.Stop() }
}
function Test-Scanner {
    $client=[Net.Sockets.TcpClient]::new()
    try {
        if(-not $client.ConnectAsync('127.0.0.1',3310).Wait(1000)){return $false}
        $stream=$client.GetStream();$stream.ReadTimeout=1000
        $bytes=[Text.Encoding]::ASCII.GetBytes("zPING`0");$stream.Write($bytes,0,$bytes.Length)
        $reply=[byte[]]::new(32);$length=$stream.Read($reply,0,$reply.Length)
        return [Text.Encoding]::ASCII.GetString($reply,0,$length).Trim([char]0) -eq 'PONG'
    } catch { return $false } finally { $client.Dispose() }
}

Push-Location $project
try {
    if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw '未找到 Node.js，请安装 Node.js 24 或更新版本。'}
    $major=& node -p 'process.versions.node.split(".")[0]'
    if($LASTEXITCODE -ne 0 -or [int]$major -lt 24){throw '需要 Node.js 24 或更新版本。'}
    & node --input-type=module -e 'await import("pg"); await import("qrcode");'
    if($LASTEXITCODE -ne 0){throw "依赖不完整，请在 $project 执行 npm ci --ignore-scripts 后重试。"}

    # Reuse installed portable tools across worktrees, never implicitly select their databases.
    $common=& git rev-parse --path-format=absolute --git-common-dir 2>$null
    $toolRoots=@($project)
    if($LASTEXITCODE -eq 0){$toolRoots+=Split-Path -Parent $common}
    $runtime=$null;$scannerRoot=$null
    foreach($root in $toolRoots){
        $candidate=Join-Path $root 'tmp\phase2-postgres\runtime\pgsql\bin'
        if(-not $runtime -and (Test-Path -LiteralPath (Join-Path $candidate 'pg_ctl.exe'))){$runtime=$candidate}
        $candidate=Join-Path $root 'tmp\phase3-clamav'
        if(-not $scannerRoot -and (Test-Path -LiteralPath (Join-Path $candidate 'runtime\clamav-1.5.4.win.x64\clamd.exe'))){$scannerRoot=$candidate}
    }
    if(-not $runtime){throw '未找到 PostgreSQL 便携运行时：tmp\phase2-postgres\runtime\pgsql\bin。'}
    if(-not $scannerRoot){throw '未找到 ClamAV：tmp\phase3-clamav。请按阶段3手册配置。'}
    $signatures=@('daily.cvd','daily.cld') | Where-Object {Test-Path -LiteralPath (Join-Path $scannerRoot "database\$_")}
    if(-not $signatures){throw 'ClamAV 病毒库缺失，请先按阶段3手册更新病毒库。'}
    Assert-FreePort '127.0.0.1' 4320
    Assert-FreePort '127.0.0.2' 4321

    $explicitState=!!$State
    if(-not $State){$State=Join-Path $project 'tmp\phase2-postgres\platform'}
    $State=[IO.Path]::GetFullPath($State,$project)
    $credentialsPath=Join-Path $State 'credentials.json'
    $ctl=Join-Path $runtime 'pg_ctl.exe'
    if(-not (Test-Path -LiteralPath $credentialsPath)){
        if($explicitState -or (Test-Path -LiteralPath $State)){throw "所选目录没有 credentials.json，不自动覆盖或重建：$State"}
        Assert-FreePort '127.0.0.1' $DatabasePort
        Write-Host "首次启动，创建独立本地数据库：$State"
        $startedDatabase=$true
        & (Join-Path $project 'scripts\local-identity-db.ps1') -Port $DatabasePort -Runtime $runtime -State $State
    }
    $local=Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
    $url=[Uri]$local.databaseDevelopment
    if($url.Scheme -ne 'postgres' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/ai_games_development' -or
        -not $url.UserInfo.StartsWith('app_development:') -or $url.Query -or $url.Fragment -or
        [Text.Encoding]::UTF8.GetByteCount([string]$local.sessionSecret) -lt 32){throw '所选配置不是有效的本机开发账号库。'}
    $data=Join-Path $State 'data'
    & $ctl -D $data status | Out-Null
    if($LASTEXITCODE -ne 0){
        Assert-FreePort '127.0.0.1' $url.Port
        $arguments='-D "'+$data+'" -l "'+(Join-Path $State 'postgres.log')+'" -o "-p '+$url.Port+' -h 127.0.0.1" -w start'
        $startedDatabase=$true
        $process=Start-Process -FilePath $ctl -ArgumentList $arguments -WindowStyle Hidden -PassThru
        if(-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0){throw 'PostgreSQL 启动失败，请查看所选目录中的 postgres.log。'}
    }
    if(-not (Test-Scanner)){
        Assert-FreePort '127.0.0.1' 3310
        & (Join-Path $project 'scripts\local-scanner.ps1') -Root $scannerRoot -Start -PassThru | ForEach-Object {
            if($_ -is [Diagnostics.Process]){$startedScanner=$_}else{Write-Host $_}
        }
    }

    # Pin local origins instead of inheriting another project's environment.
    $settings=@{
        APP_ENV='development';HOST='127.0.0.1';PORT='4320';MAIN_ORIGIN='http://127.0.0.1:4320';GAME_ORIGIN='http://127.0.0.2:4321'
        DATABASE_URL=$local.databaseDevelopment;DATABASE_TLS='disable';SESSION_SECRET=$local.sessionSecret
        LOCAL_GAMES='1';LOCAL_MAIL_PREVIEW='0';CLAMD_PORT='3310';OBJECT_STORAGE_ENDPOINT=$null;OBJECT_STORAGE_BUCKET=$null
        SUBMISSION_DEADLINE=$null
    }
    foreach($name in $settings.Keys){$previous[$name]=[Environment]::GetEnvironmentVariable($name);[Environment]::SetEnvironmentVariable($name,$settings[$name])}
    & node scripts\migrate.mjs up
    if($LASTEXITCODE -ne 0){throw '数据库迁移失败，网站未启动。请查看上方脱敏错误。'}
    Write-Host "`n本地平台：http://127.0.0.1:4320/discover"
    Write-Host '账号：http://127.0.0.1:4320/account    创作台：http://127.0.0.1:4320/studio'
    Write-Host "数据库目录：$State"
    Write-Host '注册即可登录。AI服务尚未配置。按 Ctrl+C 停止；本次启动的数据库和扫描器随之停止，数据保留。'
    & node src\server.mjs
    if($LASTEXITCODE -ne 0){throw '网站进程已退出。若刚按下 Ctrl+C，这是手动停止；否则请检查上方日志。'}
} catch {
    Write-Host ("启动未完成："+$_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
    if($startedScanner -and -not $startedScanner.HasExited){$startedScanner.Kill();$startedScanner.WaitForExit()}
    if($startedDatabase -and (Test-Path -LiteralPath (Join-Path $State 'data\PG_VERSION'))){& $ctl -D (Join-Path $State 'data') -m fast -w stop}
    Pop-Location
}
