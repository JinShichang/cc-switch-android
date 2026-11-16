# 验证记录

日期：2026-11-16。版本：0.1.0，包名：`app.ccswitch.android`。

## 已验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `npm run typecheck` 和 `npm run build` |
| 配置保护/导入导出/认证规则 | 41 项通过，0 失败 | `tests/config.test.ts`；交付 `logs/build-20261116-132707.log` 包含测试结果 |
| 原生事务故障注入 | 16 项通过，0 失败 | `tests/TransactionEngineTest.java`；同上日志 |
| 前端正式资源打包 | 通过 | Vite 生产构建，主 JS 包含第三方许可原文 |
| Android release APK | 成功 | 交付 `logs/gradle-final.log` |
| Android 完整 Lint | No issues found | 交付 `logs/lint-results-release.txt` |
| APK 签名 | v2 签名验证通过 | 交付 `logs/apk-signature.txt` |
| 包名/SDK | min 30，target/compile 37 | 交付 `logs/apk-manifest.txt` |
| APK 权限 | 无 uses-permission | 交付 `logs/apk-permissions.txt` |
| APK 内容 | 无自定义 `.so`、无 keystore、无测试密钥；许可已内嵌 | ZIP entry 与前端资源检查 |
| 手机宽度浏览器预览 | 通过下述范围 | Chrome DevTools；真实生产静态资源 |

核心测试包含：缺失与空配置区分、CRLF/注释保留、多行字符串伪表头、inline/dotted 表、MCP/工作目录/项目保留、第三方 Key 不回退官方登录、keyring/auto 未知状态、可选字段恢复与外部修改保护、原始 TOML Key 编辑、中文输入引号、导入整批拒绝、脱敏 URL query/headers。

事务测试直接编译 APK 使用的 `TransactionEngine.java`，注入只读、中断、部分 UTF-8、关闭失败、读回不一致、并发修改、备份失败、恢复失败。它验证事务规则；测试中的 Port 是主机假对象，**不是 Android ContentResolver**。

## 浏览器预览范围

使用 360×792 CSS viewport、DPR 4、mobile/touch，近似用户给定 1440×3168、640 DPI 的设备。也检查 360×430 的缩短视口。

- 200% 默认缩放；点击加得到 210%，减回 200%。
- 输入 235%（有效整数字段），200/235/400% 时 viewport 与 document scroll width 都为 360，没有横向溢出。
- 表单填写、方案添加、显示/隐藏密钥控件、保存为预览内存草稿。
- 弹窗在 792/430 高度下底部保存区仍可见，内容独立滚动。
- 浅/深主题与底部导航布局。
- 浏览器预览没有假造文件写入成功；未授权时应用按钮不可用。

Chrome 截图在工具中实际查看过。截图工具无法将文件写入本任务目录，故不交付假造的本地截图文件。首轮 favicon 404 已通过内置 logo favicon 引用修正。

这不验证 Android WebView 的实际消息桥、系统输入法、SAF 权限、设备 Keystore、文件提供方或 Codex。

## 尚未验证

- APK 在一加 13 / Android 17 上安装、启动、系统返回手势、键盘和进程重建。
- 用户通过系统文件选择器授权普通目录后的真实 ContentResolver 读写、删除和持久权限。
- 用户手机 Android Keystore 的加密/解密和重启后恢复。
- Codex DocumentsProvider 的 URI、创建/截断、guest UID/权限和跨进程竞争行为。
- 真实 API 请求和模型可用性、钥匙串官方登录、切换后 Codex 的实际生效情况。

本次没有已连接 Android 设备，也没有安装或更改手机上的 Codex。没有宣称“普通 SAF 实机读写通过”或“已接通 Codex”。请按 [实机测试](device-test.md) 分两阶段确认。

## 已知限制

- 首版只支持原生 Responses 服务；需要上游代理的 Chat/Anthropic/OAuth 流程不在本次范围。
- SAF 没有通用 compare-and-swap，最后检查与写入间仍可能有竞争；宿主需在内部协调写入。当前失败时保留恢复点，不盲目覆盖外部修改。
- 恢复替换整个 config.toml，所以恢复前会保存当前版本；不恢复 auth.json/keyring。
- 默认 200% 是真实页面放大，在 360 CSS 像素宽度下密度较低，允许用户自行调整。
- Gradle 输出旧 API 和 Gradle 10 兼容性提示；当前工具链编译成功。为 API 30–32 保留的旧返回回调有明确局部 Lint 抑制，API 33+ 已注册平台返回回调。JavaScript 的局部抑制对应内置 React 页面，网络资源被阻止。

## 本次 APK

- 大小：3,114,673 bytes。
- SHA-256：`0a653d1e3d99908662bcfce4127f22a9071ab12a6258dada2fc218e7b49639de`。
- 签名证书 SHA-256：`8edf40669ceef43ac4098b74f37edf152226972644a2e2a86b05b337d9d3cca9`。
- APK 最终校验以交付目录 `.apk.sha256` 与签名日志为准；重新构建可能因签名或构建元数据改变散列。
