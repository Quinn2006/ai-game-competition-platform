function Read-AgpSharedJson([string]$Path) {
  # The controller atomically replaces this file. Default Get-Content sharing
  # can deny that rename on Windows while a health/lease reader is active.
  $stream=$null;$reader=$null
  try {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader=[IO.StreamReader]::new($stream)
    $json=$reader.ReadToEnd()
  } finally {
    if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}
  }
  return ($json | ConvertFrom-Json)
}
