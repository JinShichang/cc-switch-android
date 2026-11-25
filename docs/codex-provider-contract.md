# Codex 目录连接

CC Switch 通过 ACTION_OPEN_DOCUMENT_TREE 选择 Codex DocumentsProvider 的整个 .codex 目录，保存持久读写 URI。ContentResolver 负责读取、创建、删除和写入；content:// 从不作为普通文件路径。无需 Root、ADB 或所有文件访问权限，也不查找安装 UUID。

当前适配使用 Codex 已有接口，不要求继续修改 Codex：读取使用 r；写入使用 rwt 请求截断；关闭后查询同一文档 COLUMN_DOCUMENT_ID，等待现有提供方的异步提交结果。此查询没有读取文件内容，应用没有额外的写后整文件相等校验。

上游先计算修改并暂存、记录 pending、检查发布前是否有外部修改，然后依次发布 auth.json、config.toml、cc-switch-model-catalog.json 和本地登录状态。CC Switch 将暂存、首次写入备份、pending 和登录暂存放在自己的私有目录，按授权 URI 隔离。最终替换由 Codex 现有提供方完成：同目录临时文件、原子替换、保留已有权限，新建文件 0600。SAF 消费方不设置 POSIX 权限。

生成的模型目录指针使用已约定的 Debian 逻辑路径 /home/codex/.codex/cc-switch-model-catalog.json，避免相对路径在 Codex 不同工作目录下解析失效。这不是 Android 私有目录或安装 UUID。普通 SAF 测试目录只验证文件流程，不代表已接通运行中的 Codex。

会话从 sessions/ 与 archived_sessions/ 通过 SAF 缓存到 CC Switch 私有目录，交给原版解析器、去重和 SQLite 用量查询。缓存不写回 Codex。已授权目录需能列出子目录、读取 session_index.jsonl、JSONL 与 .jsonl.zst 文件。

目录权限无法访问 Codex 宿主钥匙串、启动私有环境进程或确认运行中的账号/模型。文件切换与上游一致，不要求先关闭 Codex，切完再重启即可。界面区分文件提交成功和运行时确认。授权失效时重新选择目录；写入失败保留上游 pending，后续按原版规则恢复。

路由 / 聚合 / 历史过滤使用同一前台服务和上游代理，默认 127.0.0.1:15721。手机需要允许持续后台运行。强制停止应用或系统杀进程后，请重新打开 CC Switch；旧 Codex 进程可能仍缓存路由地址，需重启加载当前配置。
