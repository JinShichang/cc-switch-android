# CC Switch Android

独立运行的 Codex 服务商与配置管理 APK。基于 CC Switch 4.0.33，使用 React 界面和原生 Android SAF；无需 PRoot、Root、ADB 或“所有文件访问权限”。默认简体中文、200% 缩放。

**当前版本 0.1.0 是首个实机测试版。配置核心和文件事务的主机测试已通过；尚未在 Android 设备上验证 SAF，也未接通 Codex 的 DocumentsProvider。文件保存成功不代表运行中的 Codex 已使用新配置。**

## 开始测试

1. 安装交付目录中的 `cc-switch-android-0.1.0.apk`。
2. 点击“连接配置目录”，通过系统文件选择器授权一个专用普通目录。Codex 提供方尚未上线时，不需要选择或猜测 Debian 安装目录。
3. 添加服务商，填写完整 Responses API 地址、API Key、模型，保存后点击“应用”。
4. 应用会保存加密备份，写入 `config.toml` 并读回核对。在“当前”页查看脱敏后的文件和匹配状态。
5. Codex 的 DocumentsProvider 上线后，重新授权它提供的整个 `.codex` 目录，再进行真实 Codex 联调。应用后完全重启 Codex，建立新会话检查模型、请求地址与 MCP。

完整的普通目录测试步骤和两个无效测试密钥的导入文件见 [实机测试](docs/device-test.md)。

## 已实现

- 多套方案的添加、编辑、复制、删除；最多 200 项。
- 原生 Responses 的地址、API Key、模型、推理档位、请求头、重试及相关 TOML 参数。
- 读取授权目录中的配置，按实际地址、密钥、模型和参数判断文件匹配关系。
- 应用前语法及无关字段保护检查；配置和认证文件版本比较；写入后读回核对。
- 保留 MCP、工作目录、项目、用户设置、其他 provider 和外部模型目录指针。
- Android Keystore 加密本地方案和备份；最近 10 次配置备份、手动恢复及中断恢复。
- 方案 JSON 导入导出；导出默认不包含密钥，可明确选择包含明文 API Key。
- 缩放输入框（50–400%），左右减/加按钮每次 10%；浅色、深色、跟随系统。
- 授权失效、文件不存在、无效 UTF-8/TOML/JSON、写入失败及外部并发修改提示。

## 认证与首版范围

当前上游 Codex 自定义 provider 使用 `experimental_bearer_token` 或 `env_key`。首版将第三方 Key 写入 `config.toml` 的 `[model_providers.custom]`，保留 `auth.json` 和所有钥匙串材料。

“Codex 已有官方登录”方案只切回官方路由，不导入、刷新、注销或切换 ChatGPT 账号。`keyring/auto` 模式无法靠目录权限判断登录状态；需要时可在方案中选择“保留官方登录界面”，前提是在 Codex 中已经登录。环境变量方案只保存变量名，需要 Codex 宿主注入。

暂未移植本地代理、Chat Completions/Anthropic 协议转换、OAuth 多账号、模型目录生成、额度查询、WebDAV、会话管理及其他 agent。遇到依赖代理的配置会明确拒绝应用。支持上游 Codex 供应商 JSON 形态，不支持桌面整个 SQLite/SQL 备份。

## 构建

本地已验证工具链：Node 24.20.0、JDK 21、Gradle 9.4.1、AGP 9.2.1、Android SDK 37、Build Tools 36.0.0。最低 Android 11/API 30，目标 Android 17/API 37。APK 不包含自定义 native 库，支持 ARM64。

```powershell
cd C:\AI-Projects\codex-android\cc-switch-android
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Offline
```

工具链实际在工作区的 `.tooling` 内。首次在其他机器构建去掉 `-Offline`，提供等价目录或显式设置 `-Tooling`；脚本保留 Gradle 和 npm 缓存。不要运行 `clean`。

详细说明见 [构建与签名](docs/build.md)。

## 目录与文档

| 路径 | 内容 |
| --- | --- |
| `src/core/` | Codex 投影、TOML 局部修改、导入导出 |
| `src/upstream/` | 保留版权的上游模板、文本规范化函数和设计 token |
| `src/App.tsx` | 移动版界面与缩放控件 |
| `android/app/src/main/java/` | SAF、Keystore、事务及 WebView 宿主 |
| `tests/` | 配置保护和事务故障测试 |
| `docs/codex-provider-contract.md` | 给 Codex 原会话的对接要求 |
| `docs/porting-assessment.md` | 上游源码和认证研究、技术选择 |
| `docs/validation.md` | 已验证内容与未验证边界 |

本目录有独立 Git 仓库；没有修改或合并进 `codex-desktop-android` 源码。

## 许可证

本项目基于 MIT 许可的 CC Switch，保留 `Copyright (c) 2025 Jason Young`，详见 [LICENSE](LICENSE)。第三方库原文保存在 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)，并内嵌在 APK 的“设置 → 开源许可”中。此独立移植不代表上游官方发布或背书。
