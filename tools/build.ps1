param(
    [string]$Tooling = (Join-Path $PSScriptRoot '../../.tooling'),
    [string]$Output = (Join-Path $PSScriptRoot '../../builds/cc-switch-android'),
    [switch]$Offline,
    [switch]$SkipTests,
    [switch]$SkipCoreBuild,
    [switch]$SkipWebBuild,
    [string]$WslDistribution = 'Ubuntu',
    [string]$WslUser = 'cdx'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTooling = [IO.Path]::GetFullPath($Tooling)
$taskOutput = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path (Join-Path $taskOutput 'logs') | Out-Null
$taskLog = Join-Path $taskOutput ('logs/build-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$env:JAVA_HOME = Join-Path $taskTooling 'jdk21'
$env:ANDROID_HOME = Join-Path $taskTooling 'android-sdk'
$env:ANDROID_USER_HOME = Join-Path $taskTooling 'cc-switch-android-user'
$env:GRADLE_USER_HOME = Join-Path $taskTooling 'gradle-user-home'
$taskGradle = Join-Path $taskTooling 'gradle/bin/gradle.bat'
foreach ($taskRequired in @($taskGradle, (Join-Path $env:JAVA_HOME 'bin/java.exe'), (Join-Path $env:ANDROID_HOME 'platforms/android-37/android.jar'))) {
    if (!(Test-Path -LiteralPath $taskRequired)) { throw "Missing toolchain input: $taskRequired" }
}
if (!$env:CCSWITCH_SIGNING_KEYSTORE) {
    $env:CCSWITCH_SIGNING_KEYSTORE = Join-Path $env:ANDROID_USER_HOME 'debug.keystore'
}
if (!(Test-Path -LiteralPath $env:CCSWITCH_SIGNING_KEYSTORE)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $env:CCSWITCH_SIGNING_KEYSTORE -Parent) | Out-Null
    & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore $env:CCSWITCH_SIGNING_KEYSTORE -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=CC Switch Android Local Build,O=Local Development,C=HK'
    if ($LASTEXITCODE -ne 0) { throw 'Local signing key creation failed' }
}
function Invoke-Logged([string]$Program, [string[]]$Arguments) {
    # Never print command arguments: a caller may supply a signing environment.
    # Windows PowerShell 5 treats native stderr (including javac notes) as an
    # ErrorRecord. Judge the native exit code, not the presence of stderr text.
    $taskPreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Program @Arguments 2>&1 | Tee-Object -FilePath $taskLog -Append
        $taskStepExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreviousPreference }
    if ($taskStepExit -ne 0) { throw "Build step failed: $Program (exit $taskStepExit). See $taskLog" }
}
Push-Location $taskRoot
try {
    if (!(Test-Path -LiteralPath 'node_modules/.package-lock.json')) {
        $taskNpmArgs = @('ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $taskTooling 'npm-cache'))
        if ($Offline) { $taskNpmArgs += '--offline' }
        Invoke-Logged 'npm.cmd' $taskNpmArgs
    }
    $taskCoreScript='/mnt/' + $taskRoot.Substring(0,1).ToLowerInvariant() + $taskRoot.Substring(2).Replace('\','/') + '/tools/build-core.sh'
    $taskNativeArgs=@('-d',$WslDistribution,'-u',$WslUser,'--exec','bash',$taskCoreScript)
    if($Offline){$taskNativeArgs+='--offline'}
    if(!$SkipCoreBuild){Invoke-Logged 'wsl.exe' $taskNativeArgs}
    if(!(Test-Path -LiteralPath 'native/THIRD_PARTY_NOTICES.txt')){throw 'Native dependency notices missing. Run tools/native-notices.sh once.'}
    Invoke-Logged 'node.exe' @('tools/generate-notices.mjs')
    if (!$SkipTests) {
        Invoke-Logged 'npm.cmd' @('test')
        $taskTestArgs=@('-d',$WslDistribution,'-u',$WslUser,'--exec','bash',($taskCoreScript -replace 'build-core.sh$','test-core.sh'))
        if($Offline){$taskTestArgs+='--offline'}
        Invoke-Logged 'wsl.exe' $taskTestArgs
    }
    if (!$SkipWebBuild) { Invoke-Logged 'npm.cmd' @('run', 'build') }
    Push-Location (Join-Path $taskRoot 'android')
    try {
        $taskGradleArgs = @('--console=plain', ':app:assembleRelease', ':app:lintRelease')
        if (!$SkipTests) { $taskGradleArgs += ':app:testDebugUnitTest' }
        if ($Offline) { $taskGradleArgs = @('--offline') + $taskGradleArgs }
        Invoke-Logged $taskGradle $taskGradleArgs
    } finally { Pop-Location }
    $taskVersion = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
    $taskApk = Join-Path $taskOutput "cc-switch-android-$taskVersion.apk"
    Copy-Item -LiteralPath 'android/app/build/outputs/apk/release/app-release.apk' -Destination $taskApk -Force
    Invoke-Logged (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat') @('verify', '--verbose', '--print-certs', $taskApk)
    $taskHash = (Get-FileHash -LiteralPath $taskApk -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$taskApk.sha256", "$taskHash  $([IO.Path]::GetFileName($taskApk))`n", [Text.UTF8Encoding]::new($false))
    Write-Output "APK: $taskApk"
    Write-Output "SHA-256: $taskHash"
    Write-Output "Build log: $taskLog"
} finally { Pop-Location }
