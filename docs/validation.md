# 验证记录

## 0.4.3 供应商状态和图标

供应商按钮之前依据切换前的文件快照显示“已启用”，而卡片标记依据原生当前供应商 ID，导致同一屏出现两个当前状态。现在按钮、标记与背景统一使用上游返回的 `currentProviderId`。写入完成后立即更新，并使旧快照失效；连续切换不再要求手动刷新。打开当前配置或 MCP 页时再读取文件内容，没有新增写后比对或修改配置写入流程。“已启用”表示 CC Switch 当前选定方案，运行中的 Codex 仍需要重启后确认。

供应商列表之前固定显示 OpenAI / Server 图标，未使用保存的 `icon`。现在复用编辑页同一份原版 `ProviderIconBox` / `ProviderIcon`，显示用户选择的内置图标和 PNG，颜色、深色处理与未知图标回退均沿用原版组件。关于页面的版本从 package.json 读取。

本版 38 项 TypeScript 测试通过，生产 Web 界面在合成原生桥接中完成 11 项检查：初始保存状态、连续切换立即刷新、切换失败保留方案、打开当前配置重新读取、图标选择及保存、重新打开编辑页与列表一致、未知图标回退、自定义 PNG、横屏深色布局及路由切换。检查记录位于交付目录 `layout-validation-0.4.3.json`；合成桥接不在 APK 中，没有执行真实 SAF 或 Codex 写入。

本版仅修改界面，复用 0.4.2 原生库和已通过的原生集成记录，未重编译未变化的 Rust 核心，也未重复执行旧 Android 辅助单元测试。手机 WebView 的按钮刷新及实际保存图标仍待覆盖安装确认。

| 0.4.3 产物 | 结果 |
| --- | --- |
| APK | cc-switch-android-0.4.3.apk，25,299,917 字节 |
| 版本 | 0.4.3 / versionCode 9，ARM64，Android 11+，targetSdk 37 |
| SHA-256 | ca08016f3382f74b17191d49a89576e408d0adac0b5f58cb473489c999ad27e9 |
| 验证 | 类型检查、38 项测试、界面流程、Android lint、APK v2 签名、zipalign 和原生 ELF 16 KB 对齐通过 |
| 签名 | 沿用既有证书，可覆盖安装 |
| 构建日志 | ../builds/cc-switch-android/logs/build-20261125-123634.log（交付工作区） |

## 0.4.2 模式过滤与重复官方配置

上游仍为 CC Switch 4.0.40 / aaf6ee963927ea0173e53ac00c1919840948ab22。本版没有修改 Codex 工程。38 项 TypeScript 测试与原生集成流程已通过；界面检查使用生产 Web 资源和合成桥接数据，不能代替手机 SAF 和真实后台测试。

历史过滤从供应商配置页移到路由、聚合选项卡下方，改为两种模式共用设置。开关不再隐式启动代理或改变模式，不改写 Codex 文件。原生状态与界面区分已开启、等待进入模式、过滤生效中；直连暂停过滤。旧版任一供应商已开启的设置迁移一次，用户之后关闭不会被重新开启。供应商保存、导入与导出不携带这个公共开关。

首次连接使用上游 `should_import_default_config_on_startup`，有供应商记录时不再自动生成 default。旧版未经自定义的官方 default 在私有目录备份后并入 OpenAI Official，保留完整配置与当前指针，迁移不写 Codex TOML、auth 或登录暂存。第三方、已修改、聚合引用及恢复中的 default 保留。

本版新增验证：

- 原生模拟文档运输：默认卡片重复合并不触发客户端写入；第三方与已修改 default 保留；旧过滤迁移保持幂等；保存供应商不能控制过滤；直连开启过滤不启动代理。
- 真实本机 HTTP/SSE：路由过滤保留本轮推理强度、嵌套 ID 与工具 call_id；聚合成员关闭时历史推理及 ID 保留，开启后过滤，模式不变。独立图像请求不进入 Responses 历史过滤。
- 360×792、792×360 触屏视口：开关位于模式 tabs 下方，路由和聚合状态一致；直连不显示开关；后台提示显示完整，表单保留模型与 auth/TOML 字段且没有过滤选项。页面无横向溢出、无浏览器错误。记录位于交付目录 `layout-validation-0.4.2.json`，其状态数据为合成输入。

手机的最新用户截图已显示连接 `.codex`，证明 0.4.1 的连接问题已走通；截图不能确认配置应用或运行中的 Codex 已加载新配置。本版重复迁移、真实中转及后台限制仍待覆盖安装后实测。未重复执行未变化的 15 项旧 Android 辅助单元测试，保留上一版报告；本版 APK 单独执行 lint 与签名检查。

| 0.4.2 产物 | 结果 |
| --- | --- |
| APK | cc-switch-android-0.4.2.apk，25,301,897 字节 |
| 版本 | 0.4.2 / versionCode 8，ARM64，Android 11+，targetSdk 37 |
| SHA-256 | d6b37232f13123d118eaafddb797fb8e9be9c12d5d0a90dc1d6e63cf2b796a34 |
| 签名与对齐 | APK v2 签名、zipalign 16 KB、两份原生 ELF 的 PT_LOAD 16 KB 对齐通过 |
| 证书 SHA-256 | 8edf40669ceef43ac4098b74f37edf152226972644a2e2a86b05b337d9d3cca9，沿用现有安装 |
| Android lint | No issues found |
| 构建日志 | ../builds/cc-switch-android/logs/build-20261125-114526.log（交付工作区） |
| 集成日志 | ../builds/cc-switch-android/logs/native-core-integration-tests-0.4.2.log（交付工作区） |

交付检查确认 APK 包含最终原生库与已完成布局验证的 Web 资源，不含合成测试桥接。源码扫描没有 GitHub 凭据或签名私钥；依赖版权说明已保留。构建与检查缓存继续保留。

## 0.4.1 目录连接修复

ADB 诊断确认：手机安装的是 0.4.0 / versionCode 6，系统已授予来自 Codex 的持久目录读写权限（persisted=0x3）。这只能证明授权成功，不能证明 CC Switch 已保存目录或已完成配置切换。

首次连接会先调用 Android 适配层的 `suspendDocuments`。它无条件停止尚未启动的代理，原版 `ProxyService::stop` 返回“代理服务器未运行”，导致尚未保存目录 URI 就中断。退出路由后的二次停止也有同一问题。

0.4.1 保留上游停止逻辑，在 Android 适配层采用上游模式控制器同样的 `is_running` 判断。未启动或已停止时直接完成清理；实际运行中的停止错误继续报告。没有修改 Codex、SAF 写入方式或配置业务规则。

连接流程增加 `CCSwitchConnection` 阶段日志，只记录授权接受、保存、绑定、初始化与完成，以及失败阶段/异常类型，不记录 URI、配置内容或密钥。

原生集成测试先在旧代码上复现 `suspendDocuments: 代理服务器未运行`，修复后全流程通过，新增覆盖首次绑定前重复清理、直连启动不依赖代理、回到直连后再次停止。回归前后日志位于交付工作区 `../builds/cc-switch-android/logs/connection-regression-0.4.1-before.log` 和 `connection-regression-0.4.1-after.log`。

手机已结束诊断连接。用户随后提供的截图已显示 `.codex` 连接成功；实际配置切换与运行时状态仍需实测。此前失败发生在 URI 保存前，因此从失败状态升级时需要再次选择目录。

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
