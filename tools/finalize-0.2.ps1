$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskTooling = [IO.Path]::GetFullPath((Join-Path $taskProject '../.tooling'))
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskProject '../builds/cc-switch-android'))
$env:JAVA_HOME = Join-Path $taskTooling 'jdk21'
$env:ANDROID_HOME = Join-Path $taskTooling 'android-sdk'
$env:ANDROID_USER_HOME = Join-Path $taskTooling 'cc-switch-android-user'
$env:GRADLE_USER_HOME = Join-Path $taskTooling 'gradle-user-home'
$env:CCSWITCH_SIGNING_KEYSTORE = Join-Path $env:ANDROID_USER_HOME 'debug.keystore'
Push-Location (Join-Path $taskProject 'android')
try {
    & (Join-Path $taskTooling 'gradle/bin/gradle.bat') --offline --console=plain :app:assembleRelease :app:lintRelease 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'logs/final-gradle-0.2.0.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Final Gradle checks failed' }
} finally { Pop-Location }
$taskApk = Join-Path $taskOutput 'cc-switch-android-0.2.0.apk'
Copy-Item -LiteralPath (Join-Path $taskProject 'android/app/build/outputs/apk/release/app-release.apk') -Destination $taskApk -Force
Copy-Item -LiteralPath (Join-Path $taskProject 'android/app/build/reports/lint-results-release.txt') -Destination (Join-Path $taskOutput 'logs/lint-0.2.0.txt') -Force
& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat') verify --verbose --print-certs $taskApk 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'logs/signature-0.2.0.txt')
if ($LASTEXITCODE -ne 0) { throw 'Signature check failed' }
& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt.exe') dump badging $taskApk | Out-File -Encoding utf8 (Join-Path $taskOutput 'logs/manifest-0.2.0.txt')
if ($LASTEXITCODE -ne 0) { throw 'Manifest check failed' }
& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt.exe') dump permissions $taskApk | Out-File -Encoding utf8 (Join-Path $taskOutput 'logs/permissions-0.2.0.txt')
if ($LASTEXITCODE -ne 0) { throw 'Permissions check failed' }
$taskHash = (Get-FileHash -LiteralPath $taskApk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($taskApk + '.sha256', $taskHash + '  cc-switch-android-0.2.0.apk' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output ('SHA256: ' + $taskHash)
Write-Output ('Bytes: ' + (Get-Item -LiteralPath $taskApk).Length)
