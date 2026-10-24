# iOS 模拟器原生安装 · 2026-10-22

源码基线 1178fbe（随后 6372501 仅补安装文档）。复用现有 iPhone 18 Pro / iOS 27 模拟器 498E27B7-5192-48CE-9B13-F4A27F10F806，未创建新设备。加入 expo-notifications 后更新原生工程与 Pods，并实际编译安装，未选择真机签名团队。

在 apps/mobile 执行：

```sh
pnpm exec expo prebuild --platform ios --no-install
pnpm exec expo run:ios --device 498E27B7-5192-48CE-9B13-F4A27F10F806 --no-bundler
```

结果：Build Succeeded，0 errors、2 warnings；其中包含 Expo Dev Launcher 构建脚本依赖分析提示。ExpoNotifications 原生库参与构建。Debug-iphonesimulator/hikaro.app 安装成功并启动，复用现有 Metro。在 Codex 内置浏览器 localhost:3200 确认原生连接页显示 hikaro、扫描配对码、配对输入框和核对按钮，无错误覆盖层。

这次证据覆盖原生编译、安装与启动，不代表完成配对后的搜索/通知点击或后台真实推送验收。当前模拟器未配对。Android SDK 已存在，但 adb devices 未列出连接设备；Android 原生安装仍未验收。没有以 JS 导出代替以上未完成项。
