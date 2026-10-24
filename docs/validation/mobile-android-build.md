# Android 自用 APK 构建 · 2026-10-22

源码基线 69b9a59，移动版本 0.1.0。补齐 expo-system-ui 58.0.6 后，Expo Android 预构建不再报告系统主题依赖缺失。移动类型检查通过。

实际命令（apps/mobile/android）：

```sh
ANDROID_HOME=/Users/shqingda/Library/Android/sdk ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
```

Gradle 9.4.1 / JDK 17，首次构建安装已获许可的 SDK Build-Tools 37 和 Platform 37.0。BUILD SUCCESSFUL，11m43s，826 项任务；保留上游 Gradle 弃用提示，没有修改或绕过检查。

产物：`artifacts/mobile-android-69b9a59/hikaro-mobile-0.1.0-preview-arm64.apk`，约 40 MiB。SHA-256：`fbb7995f71fc7202e3716d26337bce8668108eb294d04a226371a4a967577772`。

apksigner verify 通过，签名为模板 Android Debug 证书；这是开发签名的个人预览包，不是商店签名包。aapt 核对包名 dev.hikaro.mobile、versionName 0.1.0、versionCode 1、minSdk 24、targetSdk 36；压缩包包含 ARM64 Hermes 库及 assets/index.android.bundle，因此代码已打入包内。

当前 adb 未列出物理设备，本机也没有 Android emulator 可执行文件。尚未安装运行，不能把构建成功算成核心流程真机验收。连接自己的 ARM64 Android 手机并允许 USB 调试后，可执行：

```sh
adb install -r artifacts/mobile-android-69b9a59/hikaro-mobile-0.1.0-preview-arm64.apk
```

安装后需核验配对、查看/发送、审批/停止、后台返回、断网不重发及草稿恢复。若已有不同签名的同包名应用，不应直接卸载清数据来强行安装；先确认保留原数据的方案。
