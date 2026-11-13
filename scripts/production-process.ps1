param([Parameter(Mandatory)][string]$Specification)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-isolation.cs')
$spec=Get-Content -LiteralPath $Specification -Raw | ConvertFrom-Json
function Arg([string]$value){
  if($value.Contains('"') -or $value.EndsWith('\')){throw 'Unsupported process argument'}
  return '"'+$value+'"'
}
$arguments=($spec.args | ForEach-Object {Arg $_}) -join ' '
# Only the controller environment is inherited here. Isolated child roles are
# still created by production-isolation.ps1 from their strict allowlists.
$environment=@("SystemRoot=$env:SystemRoot","WINDIR=$env:WINDIR","PATH=$env:PATH","TEMP=$env:TEMP","TMP=$env:TMP","USERPROFILE=$env:USERPROFILE")
$job=[AgpJob]::new($spec.exe,$arguments,$spec.cwd,[string[]]$environment,$null,$null,4096,90,32)
try{
  $inputStream=[Console]::OpenStandardInput()
  $inputBuffer=[byte[]]::new(1)
  $inputClosed=$inputStream.ReadAsync($inputBuffer,0,1)
  while(-not $job.Exited -and -not $inputClosed.IsCompleted){Start-Sleep -Milliseconds 100}
  if($job.Exited -and $job.ExitCode -ne 0){throw 'Managed child failed'}
}finally{$job.Dispose();if($inputStream){$inputStream.Dispose()}}
