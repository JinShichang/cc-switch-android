# CC Switch Android

独立 Android APK，基于 CC Switch 4.0.33（MIT），只管理 Codex。直接运行于 Android，无需 PRoot、Root、ADB 或所有文件访问权限。默认简体中文、100% 缩放，使用 CC Switch 原始图标。

当前版本 **0.3.1**，ARM64，最低 Android 11 / API 30，目标 API 37。**本次已完成主机测试和手机尺寸浏览器验证；尚未在一加 13 实机验证 SAF、后台保活或接通 Codex。**

## 安装与连接

1. 安装交付目录的 cc-switch-android-0.3.1.apk，可用相同签名覆盖 0.3.0。保持已保存方案和 100% 默认缩放；升级清理已移除的 Android 登录选项，认证自动适配。
2. 点击“连接”，在系统 DocumentsUI 的位置侧栏选择 Codex，授权整个 .codex 目录。手机必须先安装包含 DocumentsProvider 的 Codex 版本。CC Switch 不猜测安装 UUID，也不将 content URI 当作路径。
3. 可先授权普通 SAF 测试目录。应用会区分普通目录与 Codex 文档提供方；普通目录测试不代表接通 Codex。
4. 保存供应商方案，再点击“启用”。写入前备份与版本检查，写后读回核验。完全重启 Codex，在新会话确认最终服务商与模型。

## 0.3.1 修正

- 移除自行添加的“保留官方登录界面”选择框；清理旧方案和导入数据中的对应设置。静态 Key/env_key 方案根据可读取的既有认证材料自动适配，不覆盖 Codex auth.json 或钥匙串。
- TOML 继续使用上游 CodeMirror 编辑器，适配真实 TOML 高亮/校验、手机自动换行和可纵向滚动的高度；修正透明行号区与字体度量。长配置可编辑、保存并重新读取。
- 保留上游模型列表全部控件，手机每个输入框上方显示“菜单显示名、实际请求模型、上下文窗口、思考等级”。
- 对照上游 session_usage_codex.rs 移植来源去重、原生响应/快照配对、续写识别、父历史重放和模型名称归一化。支持 .jsonl.zst，保留完整尾行及部分日志中的可确认记录，自动刷新整页数据。扫描为空或不完整时显示具体原因。

## 继承的完整页面

- 直接复用上游完整自定义供应商表单：名称/图标、备注、官网、API Key、地址/测速、模型列表及思考等级、子代理、自动审批、高级参数、auth.json/TOML 编辑器、远程压缩及 1M 设置。去掉云供应商预设入口，仅作手机排列调整。
- 直接复用上游完整会话管理与阅读器：搜索、按时间/项目分组、首末消息、复制、菜单、执行过程、查找和 Markdown 导出。
- 直接复用上游用量仪表板：日期/供应商/模型筛选、指标与趋势/热力图、请求/供应商/模型表格、详情、分页、列选择、定价和同步设置。
- 生成独立模型目录文件，核验后切换配置指针。保留无关 MCP、项目、工作目录、认证存储模式和用户字段。
- 新增“历史推理与ID过滤（解决不同源错误）”：真正的 Android 前台中转服务，常驻通知与状态计数；开启弹出后台/电池/通知设置提示。
- 默认 100%，缩放输入框左右按钮每次 ±10%。

## 历史过滤

Codex → 127.0.0.1:18181 的 CC Switch 中转 → 所选供应商。仅监听本机，独立随机路由凭据，上游密钥保存在设备绑定的加密存储；不记录请求正文或密钥。

开启后，应用方案时先确认服务就绪，再写配置。需要允许后台活动、解除电池优化并允许通知；一加厂商的额外后台限制需用户检查。系统仍可能终止进程。被强制停止或手机重启后，先打开 CC Switch，在设置中“恢复中转”。关闭过滤后重新应用方案恢复直连，并重启 Codex。

过滤历史 reasoning 项与可重建条目的顶层 id；保留正文、call_id、嵌套资源 ID、本轮 reasoning.effort。强制 store=false，移除 reasoning.encrypted_content 请求项。响应引用、加密压缩历史、/responses/compact 和 WebSocket 明确拒绝；需文本摘要新会话。支持 identity/gzip/deflate/br/zstd 请求，压缩前后均限制 64 MiB，SSE 原样流转，POST 不自动重试。

## 能力边界

表单与页面保持完整，但以下 Android 后端能力有明确边界：

- 当前仅支持原生 Responses；Chat/Anthropic 转换字段保留，应用不支持格式时明确报错。
- OAuth 登录、钥匙串、MCP OAuth 仍由 Codex 管理。auth.json 编辑器保存方案输入，应用 API Key 时写 provider bearer，不覆盖 Codex auth.json 或钥匙串。
- 会话启动、删除及打开私有项目路径需要宿主配合；保留菜单并说明。图片资源暂不读取，会话正文、工具调用和可见推理可读。
- 用量来自授权会话日志，HTTP 状态/精确耗时未知；金额按用户定价估算。无法核验的父历史和累计基线暂缓统计，完整响应记录可以显示；缺少 HTTP 状态时成功率显示“—”。目录最多 5000 节点/1000 日志；每文件最多 32 MiB、100000 行、2000 投影事件/2 MiB，界面显示边界与异常。
- 模型能力使用内置原生 Responses 模板；仅 gpt-5.5 有内置官方模板。其他模型的实际能力需用户填写或获取后核对。无法查询宿主捆绑模型目录。
- 桌面自动测速切换、完整技能包市场/安装、服务商余额、云同步尚未移植。MCP、用户 SKILL.md、提示词及各 10 份事务备份沿用已有实现。

## 构建

工具链：Node 24、JDK 21、Gradle 9.4.1、AGP 9.2.1、SDK 37、Build Tools 36.0.0，位于工作区 .tooling。

~~~powershell
cd C:\AI-Projects\codex-android\cc-switch-android
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Offline
~~~

构建保留 npm/Gradle 缓存和已有签名。新增依赖首次需去掉 Offline 下载。详见 [构建说明](docs/build.md)、[验证范围](docs/validation.md)、[实机清单](docs/device-test.md) 和 [Codex 对接要求](docs/codex-provider-contract.md)。

源码为独立 Git 仓库，没有修改 Codex 工程。保留 MIT 版权及第三方许可于 LICENSE、THIRD_PARTY_NOTICES.txt 和应用“关于”。用户提供的 agentrouter 只作为过滤行为参考，未发现许可证，不分发其源码。
