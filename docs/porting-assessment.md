# 上游研究与移植选择

研究基线：本地 `references/cc-switch`，提交 `fc3eb797c72e054d554eea6a2e7a8b93933c6ac5`，提交日期 2026-11-15，版本 4.0.33，MIT，Copyright (c) 2025 Jason Young。

本轮尝试通过 Web 工具核对 GitHub，但没有返回可用内容。实现以用户提供路径中的实际 Git checkout 为准，没有声称它是当前线上最新提交。

## 技术选择

上游前端是 React 18、TypeScript、Vite；原生后端是 Tauri 2/Rust。Tauri 的移动端能力不代表这份桌面工程可以直接 Android 打包：当前 Cargo 只产出 `rlib`，启用了托盘、桌面窗口、窗口状态、更新器、进程和大量平台专用模块，文件操作依赖普通路径。

首版选择原生 Java Android 宿主 + React/WebView：沿用上游前端技术、图标、颜色 token、Codex 模板和方案数据形态，将纯配置投影规则移植成 TypeScript，原生层负责 SAF、Keystore 与备份。无需 Android Rust NDK 交叉构建，也不依赖 PRoot。

这不是直接复制整个桌面 App.tsx：多 agent 路由、桌面窗口和远程代理状态与本任务无关。界面保留上游服务商卡片、直连状态色、橙色主操作、表单和浅深色样式，手机上调整布局及控件尺寸。缩放改为实际 CSS 页面缩放，默认 200%，50–400% 整数输入，左右各 10% 步进；不会将 200% 标签伪装成 100% 页面。

## 关键源码证据

路径均相对于上述上游 checkout，或用户当前 Codex Android 工程。

| 证据 | 结论 | 移植实现 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | 桌面构建包含 tray/window/process；当前 `crate-type=[rlib]` | 使用现有 Android 工具链和 Java SAF 宿主 |
| `src-tauri/src/live/project/codex.rs` | `{auth, config}` 投影、统一 custom 路由；Key 写 provider bearer；不投影 MCP/projects | `src/core/codex.ts` |
| `src-tauri/src/live/floor.rs` | 关键字段、独有字段、agents/memories 模型字段分开拥有 | `planApply` 的字段范围与写入前值恢复 |
| `src-tauri/src/services/provider/codex_direct.rs` | 准备、计划、提交分离，局部修改 live 文件 | TypeScript 校验/计划 + native 事务 |
| `src-tauri/src/services/provider/codex_login.rs` | auth.json 只留给官方登录，桌面支持本机登录暂存 | Android 首版保留整个 auth.json，不移植 OAuth 暂存/账号操作 |
| `src/lib/interfacePrefs.ts` | 上游缩放只有 0.9/1/1.1/1.25 | 数值输入及 ±10%，默认 200% |
| `src/config/codexTemplates.ts` | 默认 Responses 模板 | 保留原文件及版权；用户可改模型 |
| `src/utils/textNormalization.ts` | 语法位置中文引号归一化，合法字符串内容保留 | 只用于方案输入，不修写用户 live 原文件 |
| `src/index.css`、`src/assets/icons/` | 上游设计 token 和 logo | `src/upstream/tokens.css`、`public/` |
| Codex `recovery/engine/manifest.json` | 当前恢复清单指向 `rust-v0.169.0` | 认证规则按新式 provider bearer；不依赖旧式 auth.json Key |
| Codex `android/app/src/main/java/com/ai/codex/KeyringVault.java` | Android Keystore 管理解锁材料 | 消费方不尝试读私有 vault |
| Codex `runtime/guest/codex_keyring.py` | Linux GNOME Secret Service 的实际解锁路径 | 在 UI 和契约中明确目录授权不能覆盖钥匙串 |

## 保留与变化

采用 smol-toml 1.9.1 做权威语法解析，词法扫描只寻找需要改动的源文本位置。补丁生成后再解析，对去掉所拥有字段的前后 AST 进行比较，防止误改多行字符串、注释中伪造的表名、MCP 或项目配置。普通文本保留原字节；inline table 需要重建其值时，保留无关成员的语义。

方案数据在 CC Switch 私有目录中用 Android Keystore AES-256-GCM 加密。外部 `config.toml` 的 bearer 按 Codex 要求为文本，由 DocumentsProvider 负责 guest 文件权限。备份是 config.toml 原始字节，未复制 auth.json 或 keyring。私有 journal 保留不确定写入的恢复点。

上游本地代理、Stack/聚合、模型目录生成、账号管理及客户端控制依赖更多后端状态，首版没有伪造这些能力。依赖 Chat/Anthropic 转换或外部 auth 命令的方案明确报错。后续先完成 DocumentsProvider 实机联调，再根据真实需求评估代理与模型目录。
