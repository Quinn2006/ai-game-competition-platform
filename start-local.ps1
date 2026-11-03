#Requires -Version 7.0
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$project=$PSScriptRoot
$previous=@{}
$scanner=$null
$result=0
function Test-Scanner {
    $client=[Net.Sockets.TcpClient]::new()
    try {
        if(-not $client.ConnectAsync('127.0.0.1',3310).Wait(1000)){return $false}
        $stream=$client.GetStream();$stream.ReadTimeout=1000
        $bytes=[Text.Encoding]::ASCII.GetBytes("zPING`0");$stream.Write($bytes,0,$bytes.Length)
        $reply=[byte[]]::new(32);$count=$stream.Read($reply,0,$reply.Length)
        return [Text.Encoding]::ASCII.GetString($reply,0,$count).Trim([char]0) -eq 'PONG'
    } catch {return $false} finally {$client.Dispose()}
}
function Assert-FreePort([string]$Address,[int]$Port){
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Address),$Port)
    try {$listener.Start()} catch {throw "端口 ${Address}:$Port 已占用，请先关闭之前的网站。"} finally {$listener.Stop()}
}
Push-Location $project
try {
    if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw '未找到 Node.js。'}
    $major=& node -p 'process.versions.node.split(".")[0]'
    if($LASTEXITCODE -ne 0 -or [int]$major -lt 24){throw '需要 Node.js 24 或更新版本。'}
    & node --input-type=module -e 'await import("pg"); await import("qrcode");'
    if($LASTEXITCODE -ne 0){throw '依赖缺失，请先执行 npm ci --ignore-scripts。'}
    foreach($path in @('.env','data\credentials.json','data\postgres\PG_VERSION','backend\src\server.mjs')){
        if(-not(Test-Path -LiteralPath (Join-Path $project $path))){throw "缺少 $path；不会自动初始化或覆盖数据库。"}
    }
    $local=Get-Content -LiteralPath (Join-Path $project 'data\credentials.json') -Raw | ConvertFrom-Json
    $url=[Uri]$local.databaseDevelopment
    if($url.Scheme -ne 'postgres' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/ai_games_development' -or
        -not $url.UserInfo.StartsWith('app_development:') -or $url.Query -or $url.Fragment -or
        [Text.Encoding]::UTF8.GetByteCount([string]$local.sessionSecret) -lt 32){throw '新主库配置无效。'}
    Assert-FreePort '127.0.0.1' 4320
    Assert-FreePort '127.0.0.2' 4321
    $settings=@{
        APP_ENV='development';HOST='127.0.0.1';PORT='4320';MAIN_ORIGIN='http://127.0.0.1:4320';GAME_ORIGIN='http://127.0.0.2:4321'
        DATABASE_URL=$local.databaseDevelopment;DATABASE_TLS='disable';SESSION_SECRET=$local.sessionSecret
        LOCAL_GAMES='1';LOCAL_MAIL_PREVIEW='0';CLAMD_PORT='3310'
        SUBMISSIONS_ROOT=(Join-Path $project 'data\submissions');EXPORTS_ROOT=(Join-Path $project 'data\exports')
    }
    if($CheckOnly){Write-Host 'PASS: 新入口、依赖、固定主库配置与网站端口检查通过（未启动服务）。'}
    else {
        foreach($name in $settings.Keys){$previous[$name]=[Environment]::GetEnvironmentVariable($name);[Environment]::SetEnvironmentVariable($name,$settings[$name])}
        & node scripts\local-runtime.mjs start
        if($LASTEXITCODE -ne 0){throw '新主库启动失败。'}
        & node --env-file=.env scripts\migrate.mjs up
        if($LASTEXITCODE -ne 0){throw '迁移检查失败，网站未启动。'}
        if(-not(Test-Scanner)){
            & (Join-Path $project 'scripts\local-scanner.ps1') -Start -PassThru | ForEach-Object {
                if($_ -is [Diagnostics.Process]){$scanner=$_}else{Write-Host $_}
            }
        }
        if(-not(Test-Scanner)){throw '杀毒扫描器未就绪。'}
        Write-Host "`n网站：http://127.0.0.1:4320/discover"
        Write-Host '账号：http://127.0.0.1:4320/account'
        Write-Host ("主库："+(Join-Path $project 'data\postgres')+"；端口："+$url.Port)
        Write-Host '按 Ctrl+C 停止网站及本次启动的扫描器。数据库保持运行；停止数据库使用 npm run local:stop。'
        & node --env-file=.env backend\src\server.mjs
        if($LASTEXITCODE -ne 0){throw '网站进程已退出；如果刚按 Ctrl+C，这是手动停止。'}
    }
} catch {Write-Host ('启动未完成：'+$_.Exception.Message) -ForegroundColor Red;$result=1}
finally {
    if($scanner -and -not $scanner.HasExited){$scanner.Kill();$scanner.WaitForExit()}
    foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
    Pop-Location
}
exit $result
