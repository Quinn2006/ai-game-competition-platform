param([Parameter(Mandatory=$true)][string]$State,[ValidateSet('reset-password','cancel-deletion')][string]$Action='reset-password')
$ErrorActionPreference='Stop'
$statePath=(Resolve-Path -LiteralPath $State).Path
$credentials=Get-Content -LiteralPath (Join-Path $statePath 'credentials.json') -Raw | ConvertFrom-Json
$accountName=Read-Host '账号名（邮箱或内置账号名）'
$payload=@{action=$Action;email=$accountName}
if($Action -eq 'reset-password'){
 $securePassword=Read-Host '新密码（15—128字符，输入不显示）' -AsSecureString
 $payload.password=[System.Net.NetworkCredential]::new('', $securePassword).Password
}
$previousDatabase=$env:DATABASE_URL;$previousEnvironment=$env:APP_ENV
try{
 $env:DATABASE_URL=$credentials.databaseDevelopment;$env:APP_ENV='development'
 $payload | ConvertTo-Json -Compress | node (Join-Path $PSScriptRoot 'local-account.mjs')
 if($LASTEXITCODE -ne 0){throw 'Local account update failed'}
}finally{$payload.Clear();$securePassword=$null;$env:DATABASE_URL=$previousDatabase;$env:APP_ENV=$previousEnvironment}
