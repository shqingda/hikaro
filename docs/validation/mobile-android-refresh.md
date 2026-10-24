# Android 自用包更新 · 2026-10-23

## 最新候选 · `f4c52a8`

本次 ARM64 增量构建包含任务列表返回当前离线任务的修复：断线、重连中或连接失败时，已加载且属于当前任务的本机草稿仍可打开；不会开放其他任务选择或发送。共享协议源码也按本轮完整提交核对。构建成功，用时 17 秒，826 项任务：27 项执行，799 项复用。保留上游 Gradle 弃用提示，没有改变检查或签名配置。

实际命令（工作目录 `apps/mobile/android`）：

```sh
ANDROID_HOME=/Users/shqingda/Library/Android/sdk ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
```

- 产物：`artifacts/mobile-android-f4c52a8/hikaro-mobile-0.1.0-preview-arm64.apk`。
- 大小：41,796,361 字节，架构仅 `arm64-v8a`。
- SHA-256：`9cba076837fef478cbbba9c2db841e6279cb2e5f727bdf0cf66643ff4d4ce5ee`。
- `apksigner verify --verbose --print-certs` 通过，APK Signature Scheme v2；开发证书 SHA-256 仍为 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。
- `aapt dump badging` 确认包名 `dev.hikaro.mobile`、versionName `0.1.0`、versionCode `1`、minSdk 24、targetSdk 36。
- sourcemap 的 34 个第一方源码逐字匹配固定提交 `f4c52a8f15eb37ca36495ea9f7d20d85d790b23d`；比前一候选多 `apps/mobile/src/task-continuation.ts`。依赖不计为第一方源码；Expo Router 生成的 `?ctx=` 路由上下文单独记录，不声称它对应 Git 源文件。
- APK 内 `assets/index.android.bundle` 与本次生成的 Hermes bundle 逐字相同：3,577,636 字节，SHA-256 `3cff8c07c7a0ff4e95f256b209c63c5c090503224ab34937ad611894c291eebb`。逐文件摘要、签名和包元数据见 [源码与包证据](mobile-android-f4c52a8.json)。

产物目录保留 `build.log`、`signature.txt`、`package-badging.txt`、`output-metadata.json`、实际 bundle、sourcemap、APK 摘要及 `verify.py` 核验脚本。此前代码验证及原生待验步骤见 [离线任务返回](mobile-offline-task-return-2026-10-23.md)。本轮只构建并核验 Android 产物，没有重复全量、移动类型检查或双平台导出；没有安装 APK、操作设备、创建或下载模拟器。

该包仍是开发签名的自用候选。Android 安装运行、真机核心流程、生产通知、签名分发与真机性能仍待验；旧 `7d3f1ab` 候选及全部证据保留，不将 iOS 或自动化结果扩写为本包 Android 原生验收。

## 前一候选 · `7d3f1ab`

原生搜索与缓存闭环验收后的 UI 修改已纳入本次 ARM64 增量构建：搜索输入关闭自动纠正和自动大写，离线缓存清空后显示明确状态。构建成功，用时 16 秒，826 项任务：27 项执行，799 项复用。保留上游 Gradle 弃用提示，没有改变检查或签名配置。

实际命令（工作目录 `apps/mobile/android`）：

```sh
ANDROID_HOME=/Users/shqingda/Library/Android/sdk ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
```

- 产物：`artifacts/mobile-android-7d3f1ab/hikaro-mobile-0.1.0-preview-arm64.apk`。
- 大小：41,795,641 字节，架构仅 `arm64-v8a`。
- SHA-256：`38b2644289f6252f4b8b161520fce8e53cd3bac86a55b0751ba69c9e7bfa9be1`。
- `apksigner verify --verbose --print-certs` 通过，APK Signature Scheme v2；Android Debug 开发证书 SHA-256 为 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`，与前一候选一致。
- `aapt dump badging` 确认包名 `dev.hikaro.mobile`、versionName `0.1.0`、versionCode `1`、minSdk 24、targetSdk 36。
- sourcemap 的 33 个第一方源码逐字匹配固定提交 `7d3f1ab7aefe38ba802fc61235757924f7c01b52`，数量未变化。依赖目录不计为第一方源码；Expo Router 生成的 `?ctx=` 路由上下文单独列出，不伪称对应 Git 源文件。
- APK 内 `assets/index.android.bundle` 与本次生成的 Hermes bundle 逐字相同：3,576,916 字节，SHA-256 `753e21ba1296f529a6d079e7579a444a2344f216df9b4c9bc45694f2b6a0491f`。完整文件清单、逐文件摘要、签名和包元数据见 [源码与包证据](mobile-android-7d3f1ab.json)。

产物目录保留 `build.log`、`signature.txt`、`package-badging.txt`、`output-metadata.json`、实际 bundle 和 sourcemap、APK 摘要及 `verify.py` 核验脚本。本轮只执行 Android 构建和产物核验；没有重复类型检查、双平台导出、集成或隔离安装验收，也没有安装 APK、创建或下载模拟器。此前同源码的 iOS 原生证据见 [搜索与缓存闭环](mobile-search-cache-native-20261023.md)，不能据此声明 Android 原生操作通过。

该包仍是开发签名的自用候选。Android 安装运行、真机核心流程、生产通知、签名分发及真机性能继续待验收；旧候选与证据保留。

## 历史候选 · `a087594`

最终缓存清理反馈之后再次增量构建成功，用时 20 秒，826 项任务：27 项执行，799 项复用。该包包含存储初始化重试、连接移除确认与后台恢复、扫码错误恢复和标题对比度、缓存清理反馈，以及前轮通知点击与生命周期修改。

- 产物：`artifacts/mobile-android-a087594/hikaro-mobile-0.1.0-preview-arm64.apk`。
- 大小：41,795,549 字节，架构仅 `arm64-v8a`。
- SHA-256：`9b236e2fe2db326338971e4afda16e4430bff8473bfaee6ca56f33f58960cd67`。
- `apksigner verify --print-certs` 通过，开发证书 SHA-256 与下方旧候选相同。包名、versionName/versionCode、minSdk/targetSdk 也未变化。
- sourcemap 的 33 个第一方源码逐字匹配 `a087594`。APK 内 `assets/index.android.bundle` 又与该次构建生成的 Hermes bundle 逐字相同：3,576,824 字节，SHA-256 `d2f0f048166a1e6e02167eb9f1b70bf9f8f4037ed8ed44ca02248c1b11383d2a`。完整核验清单见 [源码与包证据](mobile-android-a087594.json)。
- 同版本 `pnpm check` 的 100 个应用测试文件、504 项测试与 14 项脚本检查通过；根/移动类型检查、CLI 构建及双平台 Hermes 导出通过。`pnpm check:install` 从已跟踪源码复制到隔离目录，冻结依赖安装、类型检查、构建及实际 TUI 启动/干净退出通过，不复用开发目录的 node_modules 或构建产物。

构建、集成、导出和隔离安装日志保存在产物同目录。最终再次检查 `adb devices -l` 仍没有设备；该包尚未安装运行。它是开发签名的自用候选，不是商店签名或真机性能证据。旧候选与其验证记录继续保留，避免把新源码证据写回旧包。

## 历史候选 · `f7ef2aa`

上一轮启动的构建已完成，未因等待期间无输出而重启。`assembleRelease` 成功，用时 16 分 12 秒，826 项任务：76 项执行，750 项复用。保留 Gradle/Kotlin 上游弃用提示，没有关闭 Lint 或放宽构建检查。

源码基线 `f7ef2aa`。构建 sourcemap 中 32 个第一方源码文件逐字与该 Git 基线相同；其中包含通知点击复核、inactive/background 生命周期和输入读屏标签。此包**不包含**随后开始的本机存储初始化重试、移除连接确认与扫码错误恢复修改。

- 产物：`artifacts/mobile-android-f7ef2aa/hikaro-mobile-0.1.0-preview-arm64.apk`。
- 大小：41,791,157 字节。
- SHA-256：`e9d17d1b6ceeb85d237903f5aa1dfa20ace1b20e467d13c9b15d4ae43b9cbddb`。
- `apksigner verify --print-certs` 通过，仍为 Android Debug 开发证书，SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。
- 包名 `dev.hikaro.mobile`，versionName `0.1.0`、versionCode `1`，minSdk 24、targetSdk 36。
- 同目录保存构建日志和 `source-verification.json`。本机 `adb devices -l` 无设备；尚未安装运行，不将 APK 构建或 JS 导出代替 Android 真机流程。

在连接并授权自己的 ARM64 Android 设备后，可用 `adb install -r` 安装此文件。若现有同包名应用使用不同证书，先处理数据保留与签名兼容，不直接卸载清空草稿。
