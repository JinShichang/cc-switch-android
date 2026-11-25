# CC Switch Android

<table>
  <tr>
    <td width="33%"><a href="img/1.jpg"><img src="img/1.jpg" alt="CC Switch 与 Codex Android" width="100%"></a></td>
    <td width="33%"><a href="img/2.jpg"><img src="img/2.jpg" alt="Codex 供应商列表" width="100%"></a></td>
    <td width="33%"><a href="img/3.jpg"><img src="img/3.jpg" alt="添加自定义供应商" width="100%"></a></td>
  </tr>
  <tr>
    <td><a href="img/4.jpg"><img src="img/4.jpg" alt="模型与思考等级配置" width="100%"></a></td>
    <td><a href="img/5.jpg"><img src="img/5.jpg" alt="auth.json 与 config.toml 编辑" width="100%"></a></td>
    <td><a href="img/6.jpg"><img src="img/6.jpg" alt="MCP、Skills、提示词及其他功能入口" width="100%"></a></td>
  </tr>
  <tr>
    <td><a href="img/7.jpg"><img src="img/7.jpg" alt="Codex Android 会话" width="100%"></a></td>
    <td><a href="img/8.jpg"><img src="img/8.jpg" alt="用量统计与趋势" width="100%"></a></td>
    <td><a href="img/9.jpg"><img src="img/9.jpg" alt="用量统计请求日志" width="100%"></a></td>
  </tr>
</table>

[**codex-desktop-android**](https://github.com/JinShichang/codex-desktop-android) 的**专属配套工具**，用于在手机上管理、切换 Codex 服务商与配置。

基于 [CC Switch 4.0.40](https://github.com/farion1231/cc-switch) 的独立 Android APK，复用原版界面与 Rust 配置、认证、切换、路由、聚合和用量逻辑。支持 Android 11+ / ARM64。默认简体中文、100% 缩放，适配触控和用户手动横屏。

## 使用

1. 从 [Releases](../../releases) 下载 APK，并安装支持目录授权的 Codex Android 版本。
2. 点击「连接」，在系统文件选择器侧栏选择 Codex，授权整个 `.codex` 目录。
3. 添加供应商并点击「启用」，写入完成后重启 Codex 生效。切换前无需关闭 Codex。

「历史推理与ID过滤（解决不同源错误）」位于路由、聚合选项卡下方，两种模式共用开关；直连时暂停过滤。启用时按提示解除后台限制。

构建方法见 [构建说明](docs/build.md)，对接要求见 [Codex 目录授权说明](docs/codex-provider-contract.md)。

## 致谢与许可

基于 [CC Switch](https://github.com/farion1231/cc-switch) 开发，遵循 [MIT 许可证](LICENSE)。上游版权及第三方许可见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
