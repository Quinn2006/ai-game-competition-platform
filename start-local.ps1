#Requires -Version 5.1
[CmdletBinding()]
param([switch]$CheckOnly,[ValidateSet('Local','Public')][string]$Mode)
$ErrorActionPreference='Stop'
$project=$PSScriptRoot
$previous=@{}
$scanner=$null
$browserJob=$null
$result=0
$tunnels=@()
function Start-Tunnel([string]$Target){
    $dir=Join-Path $project 'tmp\public-tunnels'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $log=Join-Path $dir ([Guid]::NewGuid().ToString('N')+'.log')
    $process=Start-Process -FilePath (Get-Command cloudflared).Source -ArgumentList @('tunnel','--url',$Target,'--no-autoupdate','--logfile',$log) -WindowStyle Hidden -PassThru
    $script:tunnels+=$process
    $deadline=(Get-Date).AddSeconds(60)
    while((Get-Date) -lt $deadline){
        if($process.HasExited){throw "隧道退出，请查看 $log"}
        if(Test-Path -LiteralPath $log){
            $content=Get-Content -LiteralPath $log -Raw
            $match=[regex]::Match([string]$content,'https://[a-z0-9-]+\.trycloudflare\.com')
            if($match.Success -and $content -match 'Registered tunnel connection'){return $match.Value}
        }
        Start-Sleep -Milliseconds 300
    }
    throw "隧道连接超时，网站未公开，请查看 $log"
}
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
    if(-not $Mode -and -not $CheckOnly){
        Write-Host '请选择启动方式：1 本地启动；2 公网模式'
        do {$choice=Read-Host '输入 1 或 2'} while($choice -notin @('1','2'))
        $Mode=if($choice -eq '2'){'Public'}else{'Local'}
    }
    if($Mode -eq 'Public' -and -not(Get-Command cloudflared -ErrorAction SilentlyContinue)){
        throw '没有找到隧道工具 cloudflared。请安装后重新启动：winget install --id Cloudflare.cloudflared --exact'
    }
    if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw '未找到 Node.js。'}
    $major='console.log(process.versions.node.split(".")[0])' | & node --input-type=module
    if($LASTEXITCODE -ne 0 -or [int]$major -lt 24){throw '需要 Node.js 24 或更新版本。'}
    'await import("pg"); await import("qrcode");' | & node --input-type=module
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
        LOCAL_GAMES='1';LOCAL_MAIL_PREVIEW='0';CLAMD_PORT='3310';GAME_LISTEN_ORIGIN='http://127.0.0.2:4321'
        SUBMISSIONS_ROOT=(Join-Path $project 'data\submissions');EXPORTS_ROOT=(Join-Path $project 'data\exports')
    }
    if($CheckOnly){Write-Host 'PASS: 新入口、依赖、固定主库配置与网站端口检查通过（未启动服务）。'}
    else {
        if($Mode -eq 'Public'){
            Write-Host '正在连接两个免费公网隧道，请稍候……'
            $settings.MAIN_ORIGIN=Start-Tunnel 'http://127.0.0.1:4320'
            $settings.GAME_ORIGIN=Start-Tunnel 'http://127.0.0.2:4321'
        }
        foreach($name in $settings.Keys){$previous[$name]=[Environment]::GetEnvironmentVariable($name);[Environment]::SetEnvironmentVariable($name,$settings[$name])}
        & node scripts\local-runtime.mjs start
        if($LASTEXITCODE -ne 0){throw '新主库启动失败。'}
        & node --env-file=.env scripts\migrate.mjs up
        if($LASTEXITCODE -ne 0){throw '迁移检查失败，网站未启动。'}
        & node --env-file=.env scripts\local-builtin-accounts.mjs
        if($LASTEXITCODE -ne 0){throw '内置账号初始化失败，网站未启动。'}
        if(-not(Test-Scanner)){
            & (Join-Path $project 'scripts\local-scanner.ps1') -Start -PassThru | ForEach-Object {
                if($_ -is [Diagnostics.Process]){$scanner=$_}else{Write-Host $_}
            }
        }
        if(-not(Test-Scanner)){throw '杀毒扫描器未就绪。'}
        Write-Host ("`n网站地址（就绪后可访问）："+$settings.MAIN_ORIGIN+'/discover')
        Write-Host ('试玩来源：'+$settings.GAME_ORIGIN)
        Write-Host ("主库："+(Join-Path $project 'data\postgres')+"；端口："+$url.Port)
        Write-Host '按 Ctrl+C 停止网站及本次启动的扫描器。数据库保持运行；停止数据库使用 npm run local:stop。'
        $browserJob=Start-Job -ArgumentList $settings.MAIN_ORIGIN -ScriptBlock {
            param($mainOrigin)
            $deadline=(Get-Date).AddSeconds(60)
            while((Get-Date) -lt $deadline){
                $ready=$false
                try {
                    $response=Invoke-WebRequest -Uri 'http://127.0.0.1:4320/health/ready' -UseBasicParsing -TimeoutSec 2
                    $ready=$response.StatusCode -eq 200
                } catch {}
                if($ready){
                    try { Start-Process ($mainOrigin+'/discover') }
                    catch { Write-Warning 'Open http://127.0.0.1:4320/discover manually.' }
                    return
                }
                Start-Sleep -Milliseconds 500
            }
        }
        & node --env-file=.env backend\src\server.mjs
        if($LASTEXITCODE -ne 0){throw '网站进程已退出；如果刚按 Ctrl+C，这是手动停止。'}
    }
} catch {Write-Host ('启动未完成：'+$_.Exception.Message) -ForegroundColor Red;$result=1}
finally {
    foreach($tunnel in $tunnels){if(-not $tunnel.HasExited){$tunnel.Kill();$tunnel.WaitForExit()}}
    if($browserJob){Stop-Job $browserJob; Receive-Job $browserJob; Remove-Job $browserJob}
    if($scanner -and -not $scanner.HasExited){$scanner.Kill();$scanner.WaitForExit()}
    foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
    Pop-Location
}
exit $result
