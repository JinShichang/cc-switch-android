param([string]$Distribution='Ubuntu',[string]$User='cdx',[switch]$Offline)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskScript='/mnt/' + $taskProject.Substring(0,1).ToLowerInvariant() + $taskProject.Substring(2).Replace('\','/') + '/tools/test-core.sh'
$taskArgs=@('-d',$Distribution,'-u',$User,'--exec','bash',$taskScript)
if($Offline){$taskArgs+='--offline'}
& wsl.exe @taskArgs
if($LASTEXITCODE -ne 0){throw 'Upstream native integration tests failed'}
