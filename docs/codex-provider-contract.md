# 给 Codex Android 宿主的对接契约

状态：2026-11-16，CC Switch Android 0.3.0 已实现 SAF 消费端。当前本地 Codex 源码已包含 CodexDocumentsProvider（com.ai.codex.documents），由原会话负责。本工程未修改 Codex 源码；尚未确认用户手机是否安装对应版本，也尚未完成实机联调。

## 暴露目录

用户在 `ACTION_OPEN_DOCUMENT_TREE` 中选择由 Codex 宿主提供的整个 `/home/codex/.codex` 目录。逻辑根应有清楚的 `.codex` 显示名称。

- 返回标准 `content://` tree URI 和持久读写授权；CC Switch 保存 URI，不转换为普通路径。
- 安装 UUID、Debian 实际私有路径、用户 UID/GID 都由提供方定位和处理。CC Switch 不枚举 Codex 私有目录、不探测 UUID。
- document ID 在同一次安装的应用重启、宿主重启、文件内容更新后应稳定。同一文件用临时文件替换后，逻辑 ID 也应继续可读。
- 如果重装/重置导致目录身份变化，旧授权应明确失效并要求重新授权，不能把旧 URI 静默映射到另一个用户目录。
- 宿主包名 com.ai.codex 及 com.ai.codex.documents authority 用于检测已安装提供方和标注目录来源；选中此提供方时检查根显示名称为 .codex，拒绝子目录。权限仍完全依赖用户选择的 URI grant；不是通过包名获得目录访问权。

## 必需文档操作

| 行为 | CC Switch 用法 | 提供方要求 |
| --- | --- | --- |
| 查询根 | `buildDocumentUriUsingTree` + `query` | 返回 `DISPLAY_NAME`、`MIME_TYPE_DIR`、`FLAGS` |
| 列出子项 | `buildChildDocumentsUriUsingTree` + `query` | 返回 `DOCUMENT_ID`、`DISPLAY_NAME`、`MIME_TYPE`、`FLAGS`；识别根目录的两个配置文件 |
| 读文件 | `ContentResolver.openInputStream` | UTF-8 原始字节，能够完整读到 EOF，错误不得返回伪造空内容 |
| 写现有配置 | `openOutputStream(uri, "rwt")` | 正确截断；支持短内容覆盖长内容；关闭后重新打开能读到新内容 |
| 创建缺失配置 | `DocumentsContract.createDocument` | 接受名称 `config.toml`、MIME `application/toml`；不添加扩展名或自动重命名 |
| 恢复到不存在 | `DocumentsContract.deleteDocument` | 支持删除由应用写出的 config.toml，返回真实结果 |
| 持久授权 | `takePersistableUriPermission` | 同时授予 read/write，并支持 persistable/prefix grant |

配置读取大小上限各 2 MB；方案导入导出上限 16 MB。这些是消费者资源界限，超限明确报错。

`config.toml` 应有 `FLAG_SUPPORTS_WRITE`；目录应有 `FLAG_DIR_SUPPORTS_CREATE`。删除能力用于恢复“原文件不存在”的状态。`auth.json` 可以是只读，首版不会写或删除它。

若无法满足 `rwt`，请返回清楚错误。CC Switch 不降级到截断语义不确定的 `w`，不使用 rename 模拟通用 SAF 原子替换。

## 文件范围

当前版本读取 config.toml、auth.json、AGENTS.md、skills/**/SKILL.md、session_index.jsonl、sessions/**.jsonl、archived_sessions/**.jsonl。配置切换写 config.toml，配置了模型列表时创建内容寻址的 cc-switch-model-catalog-*.json；用户在 MCP 页可显式修改选定 mcp_servers 项；提示词和用户技能页可写 AGENTS.md、skills/<一级用户目录>/SKILL.md。恢复可删除原本不存在的这些文件。不会修改 auth.json、钥匙串、会话日志、数据库或内置技能。

子目录按每级 DISPLAY_NAME 查到 DOCUMENT_ID 后访问；不拼接 content URI 或私有文件路径。新增技能需要创建 skills 和用户子目录，目录 MIME 使用 DocumentsContract.Document.MIME_TYPE_DIR；Markdown 使用 text/plain MIME 并保持完整名称。列表使用 SIZE、LAST_MODIFIED 排序。文档备份和配置备份各最多10份，未确认 journal 独立保留。

会话目录扫描最多5000项、显示最多1000份日志（使用已扫描集合按修改时间排序），用量扫描这些文件并缓存未修改文件。每份日志最多读取32MB / 100000行；单行512KB，返回最多2000事件 / 2MB；达到限制会显示不完整。名称索引上限2MB。

配置投影拥有以下字段：

- 选路：`model_provider`、旧式 `openai_base_url/base_url/wire_api`、顶层错误位置的 `experimental_bearer_token`、`[model_providers.custom]`。
- 模型：`model`、`review_model`、`model_reasoning_effort`、`plan_mode_reasoning_effort`。
- 方案显式提供时：`web_search`、`model_context_window`、`model_auto_compact_token_limit`、`model_supports_reasoning_summaries`、`model_verbosity`、指定的 agents/memories 模型字段。
- 上游已废弃的 `disable_response_storage` 在应用时移除。

切换供应商时 MCP、项目、信任、工作目录、认证存储模式、其他 provider 及不相关字段保持不变；无自定义模型列表时保留非本应用管理的模型目录指针。可选字段有写入前值和所有权记录；切走时只恢复未被外部修改过的值。

新 provider 统一写到 `[model_providers.custom]`，与当前上游一致。其他自定义表保留。当前 Codex 不接受的保留名称表会阻止应用并提示迁移，不被静默删除。

## 新配置与运行状态

首版流程：校验 → 生成局部补丁 → 验证无关字段 → 校验原版本 → 本机持久加密备份 → 再次读版本 → 写入/关闭 → 重新读取并逐字节核对 → 提交本地元数据。

SAF 不提供跨进程 compare-and-swap 或通用文件锁。版本摘要可以阻止已观察到的外部改动，但不能消除“最后一次检查与实际写入之间”的竞争窗口。建议 Codex 端：

1. `openDocument("rwt")` 使用临时写入并在可靠关闭后原子提交，失败保留原文件；不要把半截 TOML 暴露给运行中的读取者。
2. 写入/创建时保持 Debian 文件拥有者、0600 等权限正确，让 Codex 的 guest UID 可以读取；这些权限无法由 SAF 消费方设置。
3. 如后台自动保存 config.toml，提供协调机制，或要求用户切换前完全停止 Codex。消费者不能锁住宿主内部写入线程。
4. 应用关闭、guest 未初始化、目录暂时不可用等情况返回真实错误，不伪造“无文件”。

首版只确认文件读回一致，始终返回 `runtimeConfirmed=false`。要显示“运行中的 Codex 已生效”，需要另行设计经过授权的运行状态/重载接口，返回实际 provider、模型、配置版本及进程代次。不能仅靠修改时间、URI 授权或文件匹配推断。

用户暂时完全重启 Codex，然后建立新会话检查配置；旧会话、启动参数、选定 profile 和项目层配置可能覆盖全局值。

## 钥匙串及认证限制

已检查 Codex Android 的 `KeyringVault.java` 和 `runtime/guest/codex_keyring.py`：Android Keystore 封装的是 Linux GNOME keyring 的解锁材料，guest 通过 Secret Service 解锁并使用加密登录信息。它们不等同于 `.codex/auth.json`。

CC Switch 上游当前 `live/project/codex.rs` 明确使用 provider 表中的 `experimental_bearer_token` 或 `env_key`；第三方 Key 不能再只写 auth.json。

| 功能 | 仅 `.codex` 目录权限是否足够 | 当前行为/所需配合 |
| --- | --- | --- |
| 第三方静态 API Key | 足以写原生配置 | Key 写到 provider 表，不触碰官方登录 |
| 读取官方账号已登录与否 | 不一定 | `file` 有线索，`keyring/auto` 无法确认；文件令牌存在也不等于有效 |
| 账号切换、刷新 token、登出 | 不足 | 由 Codex 端在原有凭据管理边界完成，不要求导出整个钥匙串 |
| 环境变量 Key | 不足以注入进程 | 消费者可写 env_key 名称，宿主负责注入和确认 |
| 应用运行中热加载 | 不足 | 需要宿主重载及版本确认接口 |
| OAuth 供应商及协议转换代理 | 不足 | 后续版本单独实现上游账号/代理模块，不伪装成文件切换 |

方案“保留官方登录界面”控制 `requires_openai_auth`：静态 Key/env_key 存在时，默认按 auth.json 中的登录材料判断；钥匙串用户可在确认 Codex 已登录后手动选择保留。无认证服务始终不启用官方认证回退。

## 对接验收清单

- 在无 ADB/Root/全盘权限情况下，从系统选择器获得目录并持久读取。
- 应用/系统重启后 URI 可用，撤销权限后有明确提示。
- 创建、长短内容覆盖、读回、删除、空间不足、关闭错误行为正确。
- 更改服务商后 MCP、工作目录及自定义字段不丢失，guest UID 仍可读取配置。
- auth.json 和实际钥匙串材料保持不变。
- 重启 Codex 后，实际新请求使用目标地址、Key、模型；记录与文件匹配测试分开。

以上全部是待双方实机验证的要求，不是本次已经接通 Codex 的声明。

## 0.3.0 补充（取代上文旧版数量与模型目录边界）

- 会话目录最多显示扫描集合中的 1000 个日志，节点上限仍 5000。用量扫描这些文件并缓存未变化文件；不再仅最近 50 份。单文件读取边界保持不变，继承/不完整日志暂缓统计。
- 生成 cc-switch-model-catalog-<内容指纹>.json，通过 SAF 创建并读回核验后写入 model_catalog_json 相对路径。宿主需按 config.toml 所在 .codex 目录解析相对路径，并允许此普通 JSON 文档。不同内容使用新文件，旧备份指针可继续引用；不清理用户自定义目录文件。
- Android 原生 HTTP 中转仅监听 127.0.0.1:18181。guest 需能连接同一 loopback；这属于运行期联调要求，未实机验证。supports_websockets=false，须使用 HTTP Responses/SSE。
- 开启过滤时，model_providers.custom.base_url 指向随机本机路由，experimental_bearer_token 为本机随机凭据；真正供应商密钥由 CC Switch 加密存储并在中转时注入。不得把该本机凭据误当远程 API Key。
- 文件保存始终不等于运行中配置已生效。SAF 无法调用宿主重启、钥匙串或会话 SQLite 索引更新，仍需 Codex 端提供受授权接口。
