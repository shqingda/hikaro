# iPhone 自用安装

先将 iPhone 接到 Mac、解锁并信任电脑，在手机上开启开发者模式，并在 Xcode 登录有该设备签名权限的 Apple 开发账号。

在仓库根目录运行，将团队 ID 替换为自己选择的值：

```sh
HIKARO_APPLE_TEAM_ID=YOURTEAMID pnpm --filter @hikaro/mobile ios:release
```

命令先更新 iOS 原生工程的签名团队，再选择设备、构建并安装 Release 应用。Release 会打包 JavaScript，不依赖 Metro 常驻。已知设备标识也可追加在命令末尾；不要选择模拟器来代替真机验收。Apple 账号仍需具备可用证书、描述文件与设备授权，命令不会绕过这些要求。

与 `pnpm mobile:ios` 的开发构建不同，此入口用于真机自用 Release 安装，不上传 TestFlight 或 App Store，也不生成已验证的商店分发包。没有团队变量时提前停止，不自动选择另一个团队。普通开发与双平台导出继续使用原有配置。

安装后最低检查：打开应用、配对自己的电脑、发送并收到回复、后台再返回、断网重连不重发、未发送草稿退出后恢复。搜索/图片阅读及系统输入法应在同一设备验证。当前这些真机结果尚未记录，不能由构建脚本存在推断已完成。
