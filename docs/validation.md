# 0.4.1 目录连接修复

ADB 诊断确认：手机安装的是 0.4.0 / versionCode 6，系统已授予来自 Codex 的持久目录读写权限（persisted=0x3）。这只能证明授权成功，不能证明 CC Switch 已保存目录或已完成配置切换。

首次连接会先调用 Android 适配层的 `suspendDocuments`。它无条件停止尚未启动的代理，原版 `ProxyService::stop` 返回“代理服务器未运行”，导致尚未保存目录 URI 就中断。退出路由后的二次停止也有同一问题。

0.4.1 保留上游停止逻辑，在 Android 适配层采用上游模式控制器同样的 `is_running` 判断。未启动或已停止时直接完成清理；实际运行中的停止错误继续报告。没有修改 Codex、SAF 写入方式或配置业务规则。

连接流程增加 `CCSwitchConnection` 阶段日志，只记录授权接受、保存、绑定、初始化与完成，以及失败阶段/异常类型，不记录 URI、配置内容或密钥。

原生集成测试先在旧代码上复现 `suspendDocuments: 代理服务器未运行`，修复后全流程通过，新增覆盖首次绑定前重复清理、直连启动不依赖代理、回到直连后再次停止。回归前后日志位于交付工作区 `../builds/cc-switch-android/logs/connection-regression-0.4.1-before.log` 和 `connection-regression-0.4.1-after.log`。

手机已结束诊断连接，修复版的实际目录连接仍需覆盖安装后重新选择 `.codex` 验证。此前失败发生在 URI 保存前，即使系统已保留权限也需要再次选择目录。

| 0.4.1 产物 | 结果 |
| --- | --- |
| APK | cc-switch-android-0.4.1.apk，25,286,329 字节 |
| 版本 | 0.4.1 / versionCode 7，ARM64，Android 11+，targetSdk 37 |
| SHA-256 | fae88ab2446f94a60a3362ac4c0d9ddc5dc663b94db09cd7938be60d882b0234 |
| 验证 | 原生集成回归通过；类型检查、lint、APK v2 签名、zipalign 和原生 ELF 的 16 KB 对齐通过 |
| 签名 | 沿用 0.4.0 证书，可覆盖安装 |
| 构建日志 | ../builds/cc-switch-android/logs/build-20261125-104421.log（交付工作区） |

本补丁重新运行有变化的原生集成测试；前端及旧 Java 解析辅助代码没有变化，未重复运行上一版的 38 项 TypeScript / 15 项 Android 单元测试。

## 0.4.0 验证记录

测试 APK 基于 CC Switch 4.0.40（aaf6ee963927ea0173e53ac00c1919840948ab22）。此次未修改 Codex 工程。主机集成测试使用实际上游代码和模拟文档提供方；浏览器使用合成数据，均不能代替手机 SAF 验证。

## 构建产物

| 项目 | 结果 |
| --- | --- |
| APK | cc-switch-android-0.4.0.apk，25,269,945 字节 |
| 版本 | 0.4.0 / versionCode 6，ARM64，Android 11+，targetSdk 37 |
| SHA-256 | f19f3a7b7664a9a9b0254ef3899e0a3dd0533d496a1f2b37d74d2c62831d14b3 |
| 签名 | APK v2 验证通过，沿用旧版签名 |
| 证书 SHA-256 | 8edf40669ceef43ac4098b74f37edf152226972644a2e2a86b05b337d9d3cca9 |
| 对齐 | APK zipalign 的 16 KB 检查通过；原生 ELF 的 PT_LOAD 均按 16 KB 对齐 |
| Android lint | No issues found |
| 构建日志 | ../builds/cc-switch-android/logs/build-20261125-095615.log（交付工作区） |

## 已验证

- 原生集成流程 `native/tests/saf_integration.rs` 通过：旧账号暂存、地址和定价迁移；无目录授权时保存供应商；首次 default/官方入口导入且不重复生成；原版路由和认证投影；MCP、cwd、项目字段保留；官方认证暂存与恢复；部分发布后的恢复与并发编辑保护；授权失效和 TOML 错误；原版三方编辑、MCP 转换和删除、提示词原内容备份及开关；设置写入失败回滚。
- 同一集成流程验证原版 Stack 成员、故障转移 P1 选择、官方账号队列限制；真实本机 HTTP/SSE 链路中的额外历史过滤；嵌套 ID 与 call_id 配对保留；原版会话解析、Token 去重、定价、统计、内容读取及持久 FTS 索引；不同授权目录的 pending 隔离。
- 38 项 TypeScript 测试和 15 项 Android 单元测试通过。Android 测试覆盖 SessionLogReader 9 项、旧 ProviderInitialization 6 项；部分 TypeScript 测试覆盖兼容辅助函数。生产配置写入的主要证据为上面的原生集成流程。
- 生产 Web 资源在 360×792 与 792×360 触屏视口核对：完整自定义表单和模型标签、历史过滤后台提示、缺少地址/Key 的原版软校验、会话按项目/时间排列、用量趋势和明细表。统计合成数据为 5 次请求、7,000 Tokens、$0.12、34.0% 缓存命中；宽表格单独滚动，页面无横向溢出。时间范围浮层及供应商汇总可操作。
- 当前 SAF 写入使用 `rwt`，关闭写入流后查询同一文档 ID，等待现有 Codex 提供方提交。没有新增写后整文件内容比对；不依赖新的 Codex 接口。

## 待手机验证与限制

- 一加 13 的真实 WebView、系统 DPI/缩放、键盘与手动旋转；真实 ContentResolver 持久授权、文件创建、截断、异步提交错误、目录授权失效和部分写入恢复。
- Codex 开着时切换，重启后确认实际供应商、模型和官方登录。目录权限不能确认宿主钥匙串或正在运行的 Codex 已加载配置。
- 真实路由、故障转移、聚合模型菜单、OAuth、历史过滤和息屏后台服务；Android/OEM 的后台限制、系统杀进程、强制停止与重启恢复。
- 会话缓存一次最多扫描 5,000 个节点、选取 1,000 个会话；达到限制会提示数据可能不完整。缓存占用尚未设置总容量上限。大目录和真实 Zstandard 日志需实测。
- 会话删除、打开 guest 终端和历史数据库迁移未完成；涉及宿主钥匙串的状态也不能通过 SAF 保证。

本次没有在手机上的普通 SAF 测试目录或用户 Codex 目录验证成功，不宣称已接通 Codex。文件提交成功与运行中的 Codex 已使用新配置是两个状态。
