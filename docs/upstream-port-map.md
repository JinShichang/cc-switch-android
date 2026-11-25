# 上游复用

基线：CC Switch 4.0.40，aaf6ee963927ea0173e53ac00c1919840948ab22，MIT / Jason Young。

| 模块 | Android 实现 |
| --- | --- |
| Codex 供应商、认证、编辑 | native/vendor/services/provider/* 与 codex_config.rs，原版 Rust |
| TOML 修改、发布、pending、恢复 | native/vendor/live/*、mode/operation.rs 与 state.rs，原版引擎 |
| 路由、聚合、故障转移、协议和流 | native/vendor/proxy/* 与 mode/*，原版代理 |
| 故障转移开关、队列和设置保存 | 原版 commands/failover.rs、commands/settings.rs，保留验证、回滚和事件 |
| MCP 与提示词写入 | 原版 mcp.rs、services/prompt.rs；SAF 负责文档传输 |
| 会话、内容引用、用量解析 | 原版 session_manager 与 session_usage_codex；输入通过只读 SAF 缓存 |
| 会话内容检索 | 原版持久 FTS 索引，按授权目录隔离 |
| 用量脚本、定价、统计 | 原版 QuickJS、SQLite 与 model_pricing |
| 自定义配置、会话、用量页面 | 上游 React 组件，保留字段，仅手机排列与触控适配 |
| Android 生命周期和文档权限 | MainActivity、NativeCore、TreeAccess、RouterService、platform.rs |
| 额外历史过滤 | history_filter.rs，按用户提供的 agentrouter 行为独立实现 |

tools/sync-upstream-core.py 可从指定参考仓库重新生成 native/vendor，共 422 个文件。upstream-manifest.json 记录原始文件 hash 和平台替换。平台差异：Tauri IPC/状态/事件替换为 JNI 与 Tokio；文档 I/O 使用 SAF；设备状态按目录 URI 隔离；模型目录指针使用已约定 guest 路径；只启用 Codex；无法探测其他应用进程时提示用户重启。其他 agent 的依赖模块可能仍被编译，但不提供选项或写入它们的文件。

生产配置、认证、MCP 和提示词写入走原版 Rust 引擎；旧 Java 过滤代理已删除。部分旧版 TypeScript 配置辅助函数和 Java 单文件事务辅助函数仍保留用于兼容和测试，生产切换不调用这些写入计划。Android 模式面板复用原版内部组件，并适配手机布局。

SAF 无法操作 Codex 宿主钥匙串、启动终端或安全迁移正在使用的 guest SQLite 历史数据库；这些操作没有伪装成成功。会话删除和桌面进程操作也未完成移植，需分别评估现有宿主接口。

共享上游模块中的 Gemini、agy OAuth 客户端常量不随源码分发，改为可选的本地构建环境变量 CCSWITCH_GEMINI_OAUTH_CLIENT_ID / CCSWITCH_GEMINI_OAUTH_CLIENT_SECRET、CCSWITCH_AGY_OAUTH_CLIENT_ID / CCSWITCH_AGY_OAUTH_CLIENT_SECRET；未设置时不执行对应的 token 交换或刷新。Android 不提供这些客户端功能，Codex 的认证、配置及用量逻辑不受影响。
