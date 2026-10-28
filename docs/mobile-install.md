# 移动端本地安装

当前用户只有 Android 真机，iOS 先用现有模拟器。下面区分开发安装与真机 Release 安装；有命令不等于已经完成该设备的验收。

## Android 真机验证约定（2026-10-28）

日常 Android 真机测试、问题复现和功能验收，默认在本地编译独立运行的 Release APK，以减少 GitHub Actions 用量。操作顺序如下：

1. 在仓库根目录执行 `pnpm build:android:release`（先跑完整本地预检，再调用签名构建脚本），使用现有 Hikaro Release 签名构建 ARM64 APK；该包包含 JavaScript，不依赖 Metro。
2. 构建成功后，把 APK 交给用户，或提供可点击的绝对文件路径。默认产物为 `artifacts/release/android/hikaro-release.apk`（当前工作区绝对路径：`/Users/shqingda/Projects/hikaro/artifacts/release/android/hikaro-release.apk`）。同时说明对应源码提交、是否包含未提交改动和本次待验证内容，避免混用旧包。
3. 由用户安装；用户确认安装完成后，再配合开展真机测试并记录结果。构建成功、签名检查通过或文件已交付，都不表示真机验收通过。

所有 GitHub Actions（包括自动测试）仅在用户明确确定要发版时才执行；不为日常真机验证触发远端构建、推送发版 tag 或发布 Release。本地构建失败时先排查本地问题，不自动转用 Actions。开发构建命令保留供明确需要 Metro/原生调试的场景使用，不作为日常真机验收的默认交付方式。

推送通知配置与真实收件/点击验收暂缓，待用户明确恢复后再推进，不作为本轮真机验证的前置条件。

完整本地预检与候选包验证入口见[本地验证流程](local-validation.md)。

## iOS 模拟器

在仓库根目录执行 `pnpm mobile:ios`，选择已有模拟器；不需要 Apple 签名团队。更新原生依赖后必须重新构建安装，仅刷新 Metro 不会加入原生模块。安装后执行 `pnpm dev:sim`，在 Codex 内置浏览器打开 `http://localhost:3200/`。

## Android 开发安装

连接 Android 手机，在手机开发者选项中启用 USB 调试并确认自己的 Mac。先用 Android SDK 的 `adb devices` 确认设备为 `device`（不能是 `unauthorized`），然后在仓库根目录运行：

```sh
pnpm --filter @hikaro/mobile exec expo run:android --device
```

这是开发构建，使用 Metro；不等于独立运行的 Release APK。保持 USB 连接，必要时用 `adb reverse tcp:8081 tcp:8081` 连接本机开发服务。手机与电脑仍通过已配对的 relay 通信，Metro 只提供开发代码。

当前交付使用带 JS 的 ARM64 Release APK，并验证现有 Hikaro Release 证书；路径、校验值及待测清单见[本轮交付记录](validation/mobile-refresh-20261028.md)。[早期 Android 构建记录](validation/mobile-android-build.md)中的开发签名包仅为历史证据。当前尚未完成 Android 原生安装与任务流程验收，不将编译成功视为手机可用性验收。

## iPhone 真机 Release 安装

先将 iPhone 接到 Mac、解锁并信任电脑，在手机上开启开发者模式，并在 Xcode 登录有该设备签名权限的 Apple 开发账号。

在仓库根目录运行，将团队 ID 替换为自己选择的值：

```sh
HIKARO_APPLE_TEAM_ID=YOURTEAMID pnpm --filter @hikaro/mobile ios:release
```

命令先更新 iOS 原生工程的签名团队，再选择设备、构建并安装 Release 应用。Release 会打包 JavaScript，不依赖 Metro 常驻。已知设备标识也可追加在命令末尾；不要选择模拟器来代替真机验收。Apple 账号仍需具备可用证书、描述文件与设备授权，命令不会绕过这些要求。

与 `pnpm mobile:ios` 的开发构建不同，此入口用于真机自用 Release 安装，不上传 TestFlight 或 App Store，也不生成已验证的商店分发包。没有团队变量时提前停止，不自动选择另一个团队。普通开发与双平台导出继续使用原有配置。

安装后最低检查：打开应用、配对自己的电脑、发送并收到回复、后台再返回、断网重连不重发、未发送草稿退出后恢复。搜索/图片阅读及系统输入法应在同一设备验证。当前这些真机结果尚未记录，不能由构建脚本存在推断已完成。
