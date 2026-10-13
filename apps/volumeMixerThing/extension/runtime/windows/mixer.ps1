# answers one json line per stdin line: list | set<TAB>pid<TAB>0-100 | mute<TAB>pid<TAB>0|1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Path (Join-Path $PSScriptRoot 'CoreAudio.cs')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  [Console]::Out.WriteLine([BridgeMixer.Mixer]::Handle($line))
  [Console]::Out.Flush()
}
