# CC Switch Android

独立运行的 Codex 配置管理 APK，基于 CC Switch 4.0.33。采用上游 React 界面和 Android 原生 SAF，不需要 PRoot、Root、ADB 或所有文件访问权限。默认简体中文、130% 缩放。

当前版本 **0.2.0**。已通过主机逻辑测试、浏览器手机布局检查及 APK 编译；**未在本次会话中验证真实 Android SAF 读写，也未确认已接通手机上的 Codex**。

## 安装与连接

1. 用交付目录中的 cc-switch-android-0.2.0.apk 直接覆盖安装上一版，保留原签名和本地方案。升级时默认缩放调整为130%，之后用户修改会持久保存。
2. 点击连接，打开系统 DocumentsUI。展开侧栏“位置”，选择 Codex，再选择整个 .codex 根目录并“使用此文件夹”。Codex 的安装 UUID 和 content URI 都不当作文件路径处理。
3. 设置 → 应用配置会显示系统文件组件与 Codex 文档提供方的检测结果。本地 Codex 源码已有 DocumentsProvider；手机需要安装包含该实现的 Codex 版本，且完成环境初始化。
4. 也可选择专用普通 SAF 测试目录；应用会标明普通目录，不把测试结果称作已接通 Codex。
5. 保存方案后点击启用。写入前备份、检查外部修改，写入后读回确认。完全重启 Codex，再用新会话确认模型、服务地址及 MCP。

## 页面与功能

| 页面 | 0.2.0 实现 |
| --- | --- |
| Codex 供应商 | 增删改、复制、导入导出、当前配置识别、保留无关字段的一键切换 |
| MCP | 从 config.toml 读取完整服务列表，添加、编辑、启停、删除、JSON 导入；保留其他 MCP 与用户设置 |
| Skills | 扫描 skills 下的 SKILL.md；浏览全部，编辑一级用户技能、导入单个 SKILL.md；内置 / 嵌套技能只读 |
| 提示词 | 本地提示库增删改、导入导出；备份后启用 / 停用 AGENTS.md；识别外部自定义文档 |
| 会话 | sessions 与 archived_sessions 的最近日志列表和对话阅读；只读 |
| 授权中心 | 展示文件中可观察的认证来源、本地 Key 方案数量；打开 Codex 处理官方和 MCP 登录 |
| 用量统计 | 有边界地扫描最近日志，展示 Token 快照；按会话 ID 去重、排除派生会话历史副本 |
| 设置 | 默认130%，输入框及左右±10%；主题；目录诊断；导入导出；配置和文档备份各10份 |

复用上游 Sidebar、AppPageHeader、PromptListItem、按钮、分段控件、菜单、中文资源、完整样式及原始图标。手机窄屏把侧栏折为抽屉，保留导航顺序和样式。Android 后端通过 ContentResolver 访问用户授权的文档树。

## 认证和功能边界

第三方原生 Responses Key 写入 config.toml 的 model_providers.custom.experimental_bearer_token；保留 auth.json、钥匙串、MCP、工作目录及用户字段。官方方案只切回官方路由，不能通过 SAF 读取或修改钥匙串、刷新 OAuth、管理账号。环境变量须由 Codex 宿主注入。

尚未实现桌面代理、Chat/Anthropic 转换、OAuth 多账号、MCP OAuth 操作、完整技能包安装/市场、会话续接/删除、服务商计费和余额、WebDAV、模型目录生成。上述页面已恢复，但不声称具有桌面端全部能力。用量是日志快照，复杂分段/压缩可能不完整；界面显示扫描范围及异常。

## 构建

已验证：Node24、JDK21、Gradle9.4.1、AGP9.2.1、SDK37、Build Tools36.0.0。最低API30，目标API37；APK 无自定义原生库，支持 ARM64。

```powershell
cd C:\AI-Projects\codex-android\cc-switch-android
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1 -Offline
```

工具链和缓存位于工作区 .tooling，保留已有签名文件，不执行 clean。其他电脑首次构建去掉 Offline，并用 Tooling 参数指定工具链。详见 [构建说明](docs/build.md)。

## 验证与对接

- [验证范围](docs/validation.md)
- [实机测试](docs/device-test.md)
- [Codex DocumentsProvider 合约](docs/codex-provider-contract.md)
- [移植评估](docs/porting-assessment.md)

本项目为独立 Git 仓库，没有修改 Codex 源码。

## 许可证

MIT，保留 CC Switch © 2025 Jason Young。原文见 LICENSE；第三方声明见 THIRD_PARTY_NOTICES.txt，并嵌入设置 → 关于 → 开源许可。此独立移植不代表上游官方发布。
