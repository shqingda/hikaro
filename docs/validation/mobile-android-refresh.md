# Android 自用包更新 · 2026-10-23

上一轮启动的构建已完成，未因等待期间无输出而重启。`assembleRelease` 成功，用时 16 分 12 秒，826 项任务：76 项执行，750 项复用。保留 Gradle/Kotlin 上游弃用提示，没有关闭 Lint 或放宽构建检查。

源码基线 `f7ef2aa`。构建 sourcemap 中 32 个第一方源码文件逐字与该 Git 基线相同；其中包含通知点击复核、inactive/background 生命周期和输入读屏标签。此包**不包含**随后开始的本机存储初始化重试、移除连接确认与扫码错误恢复修改。

- 产物：`artifacts/mobile-android-f7ef2aa/hikaro-mobile-0.1.0-preview-arm64.apk`。
- 大小：41,791,157 字节。
- SHA-256：`e9d17d1b6ceeb85d237903f5aa1dfa20ace1b20e467d13c9b15d4ae43b9cbddb`。
- `apksigner verify --print-certs` 通过，仍为 Android Debug 开发证书，SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。
- 包名 `dev.hikaro.mobile`，versionName `0.1.0`、versionCode `1`，minSdk 24、targetSdk 36。
- 同目录保存构建日志和 `source-verification.json`。本机 `adb devices -l` 无设备；尚未安装运行，不将 APK 构建或 JS 导出代替 Android 真机流程。

在连接并授权自己的 ARM64 Android 设备后，可用 `adb install -r` 安装此文件。若现有同包名应用使用不同证书，先处理数据保留与签名兼容，不直接卸载清空草稿。
