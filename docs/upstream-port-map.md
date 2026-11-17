# 上游代码与 Android 适配边界

上游 CC Switch 4.0.33，提交 fc3eb797c72e054d554eea6a2e7a8b93933c6ac5，MIT（Jason Young）。本地参考源码为 C:/AI-Projects/codex-android/references/cc-switch。

| 能力 | 使用的上游代码 | Android 改动 |
| --- | --- | --- |
| 自定义供应商 | src/components/providers/forms/CodexFormFields.tsx、CodexConfigSections.tsx、BasicFormFields.tsx、useCodexConfigState.ts | src/vendor 保留完整控件与行为；仅手机标签、换行和排列，去掉云预设 |
| 编辑器完整配置与保存 | services/provider/codex_editor.rs、editor_toml.rs、forms/hooks/useDraftEditorProjection.ts | 复用现有字段投影生成完整 live 视图，三方比较只提交修改的全局设置；SAF 版本检查/备份/读回取代文件路径接口 |
| 首次初始化 | lib.rs、services/provider/live.rs、database/dao/providers_seed.rs | 首次成功读取 SAF 后：空库导入完整 default，再添加 OpenAI Official；初始化标记加密持久化，删除不复活 |
| config.toml 编辑 | src/components/JsonEditor.tsx | 保留 CodeMirror、差异同步和光标映射；真实 TOML 高亮/校验、触控滚动、字体/行号区 |
| 会话 | SessionManagerPage、reader 与相关组件 | 原页面、菜单和阅读器；SAF 供给会话内容，宿主动作显式提示尚不可用 |
| 用量界面 | UsageDashboard、UsageHero、UsageTrendChart、UsageHeatmap、请求/供应商/模型表格 | 原页面与筛选；扫描后刷新查询，未知成功率显示 — |
| 用量纯逻辑 | src-tauri/src/services/session_usage_codex.rs | 移植至 src/upstream/codexUsage.ts：原生 usage/last 配对、来源快照去重、累计高水位、续写识别、父历史重放、模型名归一化 |
| 压缩与流读取 | src-tauri/src/codex_rollout_file.rs、session_usage_codex.rs | SessionLogReader.java 从 ContentResolver 文档流读取，支持 .jsonl.zst、普通/压缩同名去重、完整末行和未完成尾行；保留明确大小上限 |
| 配置切换 | services/provider/codex_direct.rs、live/project/codex.rs | src/core/codex.ts 移植投影规则，TreeAccess/TransactionEngine 处理 SAF 版本比较、写后核验与恢复 |
| 认证 | codex_direct.rs 的 requires_openai_auth/认证投影规则 | 按可读认证材料自动兼容，不写 Codex auth.json/keyring；已移除自行增加的登录选项 |
| 历史过滤 | 用户指定的 agentrouter v2 行为 | Android 前台服务与本机中转；该独立功能由用户明确要求，参考源码无许可证，未分发参考源码 |

Tauri 桌面命令使用普通路径、桌面钥匙串、SQLite 和桌面生命周期，不能将 content URI 转成普通路径后照搬。本工程保留上游的页面与独立纯逻辑，在 Android 文档与服务边界适配。并未宣称整个桌面后端已原样运行。

统计仍是读取授权会话日志后的估算；父物理历史边界无法核验、累计基线缺失、损坏压缩数据或读取上限须明确报告。不会为了显示数字而计入复制的父历史，也不会改写 Codex 会话文件或数据库。旧版仅有 turn_token_usage 的累计记录不能冒充单次响应；需可靠基线。实际 HTTP 状态、精确耗时、钥匙串状态和正在运行的配置状态不由 SAF 提供。

0.3.2 统一遵循用户要求：能沿用桌面逻辑的直接沿用；新增平台行为先讨论。运行中的 Codex 不构成切换前置条件，只有文件冲突/权限/写入失败阻止落盘。不会主动旋转屏幕。首次导入是本地方案保存，不等同恢复备份。
