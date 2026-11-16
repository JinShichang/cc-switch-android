param([string]$Jdk = (Join-Path $PSScriptRoot '../../.tooling/jdk21'))
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskClasses = Join-Path $taskProject '.local/native-tests'
New-Item -ItemType Directory -Force -Path $taskClasses | Out-Null
& (Join-Path $Jdk 'bin/javac.exe') -encoding UTF-8 -d $taskClasses (Join-Path $taskProject 'android/app/src/main/java/app/ccswitch/android/TransactionEngine.java') (Join-Path $taskProject 'tests/TransactionEngineTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed' }
& (Join-Path $Jdk 'bin/java.exe') -cp $taskClasses TransactionEngineTest
if ($LASTEXITCODE -ne 0) { throw 'Native transaction tests failed' }
