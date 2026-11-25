# 构建

Android 11+ / ARM64 独立 APK。界面为上游 React，核心为 CC Switch 4.0.40 原生 Rust；不需要 PRoot。版本锁定在 native/upstream-manifest.json，许可证为 MIT。

Windows 已有环境：Node 24、JDK 21、Gradle 9.4.1、AGP 9.2.1、Android SDK 37、Build Tools 36.0.0；工具目录为 C:/AI-Projects/codex-android/.tooling。新版 WSL 使用 Ubuntu / cdx，Rust 与 NDK r29 缓存放在用户目录。

```powershell
cd C:\AI-Projects\codex-android\cc-switch-android
wsl.exe -d Ubuntu -u cdx --exec bash /mnt/c/AI-Projects/codex-android/cc-switch-android/tools/build-core.sh --offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Offline -SkipCoreBuild
```

首次构建需安装 Rust stable、aarch64-linux-android target、libclang-dev 和 Android NDK；主机原生测试还需 libdbus-1-dev 与 pkg-config。build-core.sh 支持 ANDROID_NDK_HOME；默认使用既有 .tooling/downloads/android-ndk-r29-linux.zip。取消 --offline 下载缺少的依赖。整个流程不运行 clean，保留 Cargo/npm/Gradle 缓存。

```bash
bash tools/test-core.sh --offline
bash tools/native-notices.sh
```

源码已包含生成的 native/vendor 和许可证，不需要先克隆上游。更新基线时才运行 tools/sync-upstream-core.py，读取 ../references/cc-switch 并记录来源 hash 与平台替换。native-notices.sh 从缓存的 Cargo 锁定依赖收集版权，缺失的 workspace 许可证由已提交的 licenses/native 补齐。

随后 npm run build 和 Android assembleRelease / lintRelease / testDebugUnitTest 生成 APK。build.ps1 自动运行这些步骤；核心已验证且未变化时可使用 -SkipCoreBuild。可用 -Tooling 指定 Windows 工具目录；其中需包含 jdk21/、android-sdk/、gradle/，Node/npm 需在 PATH。输出位于 ../builds/cc-switch-android/，日志位于 logs/。

签名沿用本地 .tooling/cc-switch-android-user/debug.keystore。CCSWITCH_SIGNING_KEYSTORE、CCSWITCH_SIGNING_STORE_PASSWORD、CCSWITCH_SIGNING_KEY_ALIAS、CCSWITCH_SIGNING_KEY_PASSWORD 可指定其他本地密钥。源码不包含签名私钥或用户密钥。未签名的 Gradle 产物不能覆盖安装。

浏览器预览：npm run dev。它不模拟真实 SAF 授权或文件写入成功。实机检查见 device-test.md。
