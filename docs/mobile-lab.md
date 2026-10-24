# 模拟器入口

```sh
pnpm dev:sim
```

复用原有 **iPhone 18 Pro／iOS 27.0**（`498E27B7-5192-48CE-9B13-F4A27F10F806`），自动启动／复用 Metro 和 serve-sim。就绪后在 Codex 内置浏览器打开 [localhost:3200](http://localhost:3200/)，脚本默认不打开系统浏览器。需要系统默认浏览器时显式运行 `pnpm dev:sim --open-browser`。不启动 DeviceHub 窗口，不创建或克隆设备，不下载 iOS runtime，不安装测试证书。模拟器或原生 App 缺失时明确报错，不创建替代设备。

日常只需这一个命令。服务在后台运行，终端退出后浏览器预览仍可用；不需要一直开着 DeviceHub。如果它之前已接管输入，脚本会恢复 serve-sim 输入通道，App 数据保留。

原生 App 图标、依赖或权限变更后的构建步骤，以及使用自有 relay 测试配对、授权、任务恢复的操作，见 [移动端指南](mobile.md)。

此前的 `mobile:lab` 专用设备启动入口已移除，额外的 Hikaro Mobile Lab 设备及生成的测试 CA／任务数据也已删除。原来的 iPhone 18 Pro 与 iOS 27.0 runtime 保留。

`pnpm mobile:lab:check` 仅运行无界面的必要工具测试：既有设备复用／浏览器打开／跨项目保护，以及隔离临时目录中的真实 TLS relay、确认、只读授权和任务恢复。它不会创建、删除或修改模拟器。

隔离 fixture 通过 `HIKARO_MOBILE_FIXTURE_CA` 显式加载自己的私有 CA，并追加到该进程已有的信任来源；人工启动时也接受原有 `NODE_EXTRA_CA_CERTS` 路径。这样不依赖测试运行器对子进程启动环境的处理，也不覆盖原有 CA。证书链及主机名校验保持开启，不写入系统或模拟器证书库。HTTP 失败只记录目标 origin 与错误码，不记录路径、请求头或凭据。

TLS 测试使用显式 OpenSSL 配置生成独立 CA 和 `CA:FALSE` 的服务器证书，限定服务器认证用途、localhost／127.0.0.1 和密钥标识，不再把 CA 证书直接当服务器证书。fixture 在发送配对凭据前，先验证真实服务的证书链、主机名和服务器证书指纹；不接受错误证书来取得后续测试结果。2026-10-19 本机该条真实 TLS 确认／授权／重启恢复测试通过，远端结果以 PR 检查为准。
