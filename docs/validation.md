# 验证记录

日期：2026-11-16。版本0.2.0，包名 app.ccswitch.android。

## 已验证

| 检查 | 结果 |
| --- | --- |
| TypeScript / Vite | 类型检查及生产资源构建通过 |
| 配置、MCP、技能、会话用量 | 53 项通过，0失败；tests/config.test.ts 与 tests/workspace.test.ts |
| 原生事务故障注入 | 16 项通过；直接编译 APK 所用 TransactionEngine.java |
| Android release | SDK37 / min30 / versionCode2 编译成功 |
| 完整 Android Lint | No issues found（最终报告随交付提供） |
| APK 签名 | 与0.1.0相同本地证书，v2验证通过 |
| 上游原图 | mdpi/xhdpi/xxhdpi/xxxhdpi launcher PNG 保持上游字节；移除上游异常49px hdpi及重复round/未使用foreground资源，系统自动缩放正确密度图 |
| 许可证 | 上游MIT和59项运行依赖许可原文嵌入APK |
| 手机浏览器 | 360×792、DPR4、触控；另检查360×430及深色模式 |

新增12项测试包括：MCP的inline/dotted表修改、保留内置项与工作区、只删除目标项、无效输入拒绝、headers映射、技能YAML、会话索引损坏行、累计快照不重复累加、归档副本去重、响应/turn记录回退、派生线程排除、消息双格式去重和不完整标记。

事务测试覆盖：只读、部分写入、UTF-8中断、关闭失败、读回失败、并发修改、备份失败、恢复不存在状态。Port 是主机假对象；这不是 ContentResolver 实机测试。

## 界面检查

- 使用实际生产资源复核；不是原型截图。独立本地Chrome由Playwright运行。
- 默认130%，+得到140%，-回130%，输入150%生效；document宽度仍为360。
- 上游侧栏含 MCP、Skills、提示词、会话、授权中心、用量统计；均能打开正确页面。
- 保存供应商草稿、提示词草稿成功；逐字输入时焦点保持。浏览器草稿仅存内存。
- 供应商窄屏操作区换行，名称不再被挤窄。
- 360×430时保存按钮处于可见范围，内容独立滚动。
- 深色切换、原版图标、中文文字检查通过。截图位于交付目录screenshots。
- 浏览器不模拟SAF写入成功，未连接目录时启用按钮不可用。

## 未验证及边界

本次无Android设备联调，未宣称普通SAF真实读写已通过，也未宣称已接通Codex。待一加13 / Android17验证：系统DocumentsUI是否能展示Codex根，持久权限、输入法/返回手势、Keystore、应用重启、实际ContentResolver创建/截断/读回，以及Codex重启后新配置生效。

CodexDocumentsProvider已在本地宿主源码中实现，但不代表手机所装APK包含它。CC Switch显示已安装authority检测，并拒绝Codex子目录。没有修改宿主项目。

恢复六个页面不代表移植全部桌面能力：钥匙串/OAuth账号操作、完整技能包安装/市场、会话续接/删除、服务商计费额度及代理仍待宿主配合或后续实现。用量显示有边界的日志快照，复杂分段/压缩可能不足，不充当财务账单。

## 产物

APK及SHA-256文件位于交付目录；最终签名、包信息、权限和lint报告保存在logs。签名证书SHA-256：8edf40669ceef43ac4098b74f37edf152226972644a2e2a86b05b337d9d3cca9。
