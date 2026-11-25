# 技术选择

CC Switch 4.0.40 使用 React / TypeScript / Vite + Tauri / Rust / SQLite，许可证为 MIT。React 页面和 Rust 业务可以复用；桌面 Tauri 窗口、托盘、普通路径与进程操作不能直接用于另一 Android 应用的私有目录。

Android APK 使用 WebView 承载上游页面，JNI 加载 ARM64 原生 Rust 核心，Tokio 运行上游路由与网络服务。配置、认证和切换保留原版引擎；SAF 只是文件 transport。CC Switch 私有目录存 SQLite、登录账号、pending 与备份；Android Keystore 继续保护旧版迁移数据与便携备份。上游数据库和 OAuth 存储采用原版格式，处于禁止系统备份的应用沙箱内。

直接运行在 Android，不依赖 Debian、PRoot、Root 或全盘权限。目标设备为 ARM64 / Android 17；最低版本 Android 11。原生库使用 16 KB ELF 对齐，最终 APK 由 zipalign/apksigner 验证。
