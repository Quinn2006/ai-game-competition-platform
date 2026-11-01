$ErrorActionPreference='Stop'
$session='phase3-finish-'+(Get-Date -Format 'yyyyMMddHHmmssfff')
function Browser { & agent-browser --session $session @args; if($LASTEXITCODE -ne 0){throw 'Browser command failed'} }
function Evaluate([string]$script){$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script));Browser eval -b $encoded}
function Check([string]$script){$result=Evaluate $script;if(($result -join '').Trim() -ne 'true'){throw "Browser assertion failed: $script ($result)"}}
function WaitNotice([string]$message){Write-Host "Checking notice: $message";Browser wait --fn "document.querySelector('#notice').textContent.includes('$message')" | Out-Null}
function ClickGame([string]$name){$snapshot=(Browser snapshot -i)-join "`n";$pattern='button "'+[regex]::Escape($name)+'" \[ref=(e\d+)\]';$match=[regex]::Match($snapshot,$pattern);if(-not $match.Success){throw "Game button missing: $name"};Browser click ('@'+$match.Groups[1].Value) | Out-Null}
function Scenario([string]$name){Evaluate "fetch('/__fixture?scenario=$name',{method:'POST'}).then(r=>r.ok)" | Out-Null;ClickGame '重试'}
$url='http://127.0.0.1:4330/play?work=11111111-1111-4111-8111-111111111111'
Browser open 'http://127.0.0.1:4330/studio' | Out-Null
Evaluate "fetch('/__fixture?scenario=normal',{method:'POST'}).then(()=>{localStorage.removeItem('game-save:11111111-1111-4111-8111-111111111111:v2');return true})" | Out-Null
Browser open $url | Out-Null
WaitNotice '游戏已加载'
ClickGame '保存进度 42'
Check "JSON.parse(localStorage.getItem('game-save:11111111-1111-4111-8111-111111111111:v1')).score===42"
ClickGame '伪造窗口消息'
Check "!localStorage.getItem('game-save:11111111-1111-4111-8111-111111111111:v1').includes('forged')"
ClickGame '超大存档'
WaitNotice '存档过大'
Scenario 'save2';WaitNotice '游戏已加载'
Check "localStorage.getItem('game-save:11111111-1111-4111-8111-111111111111:v2')===null"
Scenario 'normal';WaitNotice '游戏已加载'
Check "JSON.parse(localStorage.getItem('game-save:11111111-1111-4111-8111-111111111111:v1')).score===42"
ClickGame '触发运行错误'
WaitNotice '游戏报告运行错误'
Check "document.querySelector('#game').src==='about:blank'&&document.querySelector('#loading').hidden"
Scenario 'missing';WaitNotice '作品未发布'
Check "document.querySelector('#loading').hidden"
Scenario 'stall';WaitNotice '加载超时'
Check "document.querySelector('#game').src==='about:blank'"
Scenario 'heartbeat';WaitNotice '游戏已加载'
WaitNotice '游戏响应中断'
Scenario 'normal';WaitNotice '游戏已加载'
Browser network route 'https://allowed.example.test/probe' --body '{}' | Out-Null
Scenario 'network';WaitNotice '游戏已加载'
$networkSnapshot=(Browser snapshot)-join "`n"
if($networkSnapshot.Contains('CSP阻止：https://allowed.example.test')){throw 'Allowed domain was blocked by CSP'}
if(-not $networkSnapshot.Contains('CSP阻止：https://example.com')){throw 'Unapproved domain was not blocked by CSP'}
Scenario 'delay'
Evaluate "(()=>{const saved=window.confirm;window.confirm=()=>true;document.querySelector('#exit').click();window.confirm=saved;return true})()" | Out-Null
WaitNotice '已退出试玩'
# Wait until the delayed response has arrived, then ensure it did not resurrect the game.
Evaluate 'new Promise(resolve=>setTimeout(()=>resolve(true),1800))' | Out-Null
Check "document.querySelector('#game').src==='about:blank'&&document.querySelector('#notice').textContent==='已退出试玩。'&&document.querySelector('#loading').hidden"
Scenario 'normal';WaitNotice '游戏已加载'
ClickGame '全屏'
Check "document.fullscreenElement?.id==='stage'"
Evaluate 'document.exitFullscreen().then(()=>true)' | Out-Null
Browser set viewport 390 844 | Out-Null
Check 'document.documentElement.scrollWidth<=innerWidth'
Browser screenshot --full 'preview\phase3-extended-mobile.png' | Out-Null
Browser close | Out-Null
Write-Output 'PASS: browser save schemas, forged messages, quota, runtime error, missing work, load timeout, heartbeat gap, CSP allow/deny, exit race, fullscreen and mobile layout'
