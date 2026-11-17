# 构建与签名

## 本地构建

工作区工具链是 `C:\AI-Projects\codex-android\.tooling`，不是相邻的 `codex-android.tooling`。

```powershell
cd C:\AI-Projects\codex-android\cc-switch-android
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Offline
```

脚本会增量运行配置测试、Java 事务测试、TypeScript 编译、Vite 打包、Android 过滤单元测试及 `:app:assembleRelease :app:lintRelease`，随后验证 APK 签名并写出 SHA-256。不会清理构建缓存。

| 项目 | 已验证版本/位置 |
| --- | --- |
| Node/npm | 24.20.0 / 11.19.0 |
| JDK | `.tooling/jdk21`，Temurin 21 |
| Gradle | `.tooling/gradle`，9.4.1 |
| Android Gradle Plugin | 9.2.1，与现有 Gradle 缓存匹配 |
| SDK | Compile/target 37；最低 30 |
| Build tools | 36.0.0 |
| AndroidX WebKit | 1.17.1 |
| 产物目录 | `builds/cc-switch-android/` |

首次在无缓存环境构建：先安装以上工具链，去掉 `-Offline`。本仓库提交了 `package-lock.json`；依赖树有变化时运行 `npm ci --ignore-scripts`。已有依赖不会在每次构建时重装。Gradle 配置是普通 Android 工程，也可以用 Android Studio 打开 `android/`；先在仓库根目录执行 `npm ci` 和 `npm run build`。

```powershell
# 指定其他本地工具链及输出目录
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Tooling C:\AndroidTooling -Output C:\Builds\CCSwitch
```

## 签名材料

测试 APK 使用本机独立生成的 RSA 签名证书；密钥位于 `.tooling/cc-switch-android-user/debug.keystore`，不在源码、ZIP 或 APK 内。发布构建未开启调试模式。它与 Codex 应用的签名密钥无关。

同一安装的后续更新应使用同一密钥，保留本地文件。也可显式设置 `CCSWITCH_SIGNING_KEYSTORE`、`CCSWITCH_SIGNING_STORE_PASSWORD`、`CCSWITCH_SIGNING_KEY_ALIAS`、`CCSWITCH_SIGNING_KEY_PASSWORD`；没有显式密钥时，脚本创建 Android 标准密码的本地开发密钥。直接执行 `assembleRelease` 且不提供环境变量会得到未签名包。

用户 API Key 只在手机运行时输入。主机测试使用 `DUMMY_`/`TEST_ONLY_` 无效值，没有真实用户密钥或 OAuth token。

## 单独检查

```powershell
npm run typecheck
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-native.ps1
npm run build
```

界面预览：

```powershell
npm run preview -- --port 4179
```

浏览器中的方案只保存在内存。浏览器不模拟 SAF 写入成功，原生桥接、Keystore 和真实目录权限必须通过 APK 验证。

## APK 内容

应用包名 `app.ccswitch.android`。声明 INTERNET、前台服务 specialUse、通知和 WAKE_LOCK，用于用户启用的本机中转；无外部存储、全盘访问或 Root 权限。只加载内置 WebView 资源，通过有来源和主框架限制的 WebMessage 接口访问原生功能。没有 PRoot、Debian 或 Rust runtime。zstd-jni 官方 Android AAR 带 ARM64 解压 .so，APK 仅打包 arm64-v8a；其他界面/SAF 部分使用 ART 与 WebView。

0.3.1 的额外检查包含 SessionLogReader 主机测试（完整尾行、部分尾行、异常行、压缩日志、字段投影），可用相同缓存增量构建。源码导出使用 git archive，不包含用户密钥、签名文件或 node_modules。

0.3.2 新增 ProviderInitializationTest（6 项主机测试），覆盖首次导入、升级只补官方入口、删除后不重建及列表并发冲突。仍使用相同签名与缓存，无须 clean。
