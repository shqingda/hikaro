# 移动端 M0

M0 是 iOS／Android 原生只读客户端：扫码或粘贴配对码、核对主机身份、安全保存设备凭据、连接共享 host、分页查看获授权任务，以及恢复历史和当前输出。发送、审批、停止留到 M1。图片暂显示数量，长消息保留预览；不在手机缓存任务正文。

## 启动

**模拟器入口统一为 `pnpm dev:sim`**：复用原有 iPhone 18 Pro／iOS 27.0，自动打开 `http://localhost:3200/`，不启动 DeviceHub，不创建新设备、不安装测试 CA。配对与任务授权使用你配置的 relay；以下是完整步骤。

在仓库根目录：

```sh
pnpm install
pnpm build
pnpm start --host --demo
```

电脑的另一个终端启动 `pnpm start --attach`。真实模型可去掉 `--demo`，其他配置见 [共享 host](shared-host.md)。所有进程使用相同的 `--cwd`／`--home`。

移动端开发入口：

```sh
pnpm mobile:ios       # 首次构建并安装 iOS 开发客户端，需要 macOS / Xcode
pnpm mobile:android   # Android 原生开发构建，需要 Android SDK
pnpm dev:sim          # 复用已有设备，自动打开浏览器预览，不启动 DeviceHub
pnpm dev:mobile       # 单独启动 Metro，明确使用 --dev-client
pnpm mobile:typecheck
```

`pnpm dev`／`pnpm start` 仍启动 TUI。手机使用 **Expo Development Build（expo-dev-client）**，与 Kaku 的开发客户端方式相同，安装后是独立的 Hikaro App。`pnpm dev:mobile` 明确指定 `--dev-client`，`dev:sim` 也打开该客户端，不通过 Expo Go。

原生依赖、图标、权限或插件配置变化后，需要同步原生工程并重新构建。已有 `ios/` 工程时，单独热更新或重启 Metro 不会更新系统图标：

```sh
pnpm --filter @hikaro/mobile exec expo prebuild --platform ios --no-install
pnpm mobile:ios --device 498E27B7-5192-48CE-9B13-F4A27F10F806 --no-bundler
pnpm dev:sim
```

以上更新保留模拟器里的应用数据，不需要卸载 App 或抹掉设备。图标是非字母的地平线与太阳，资源来源见 [assets](../apps/mobile/assets/README.md)。开发客户端的加载页和最终发布版启动屏不同，不把它作为发布版启动屏验收。

[iOS 主屏幕图标实拍](design/mobile-m0/app-icon.png)：点击独立的 `hikaro` 图标进入 App。

`dev:sim` 使用固定开发依赖 `serve-sim@0.1.48`，在 [Simulator Preview](http://localhost:3200/) 显示原生模拟器，并传递触控、拖动和键盘输入。默认复用本机 iPhone 18 Pro（`498E27B7-5192-48CE-9B13-F4A27F10F806`），可用 `HIKARO_SIM_DEVICE=<UDID> pnpm dev:sim` 指定已有设备；不会创建、抹掉或覆盖安装。它检查 Metro 所属仓库、预览 PID 和设备，遇到未知端口占用会报错。Metro 使用 LAN 模式避免 IPv4／IPv6 不匹配，预览固定绑定回环地址；不要将预览暴露到公网。重复执行会复用服务，日志位于系统临时目录 `hikaro-dev-sim/`。

检测到 DeviceHub 接管输入时，脚本调用 `serve-sim repair-input`，等待 SpringBoard 稳定后重建该设备的预览；运行中的 App 会短暂关闭，数据保留。macOS 辅助功能权限不足时，键盘可能退回旧通道；不会自动修改系统权限。停止指定设备的预览：`pnpm exec serve-sim --kill <UDID>`。不要同时运行多份启动脚本。

## 配对与授权

先更新并配置 [relay](remote.md)。M0 需要带设备认证的 `GET /hosts/:hostId/device-status/:deviceId`，用于识别手机离线期间发生的撤销。使用有效 TLS 证书；不降级到明文 WebSocket，也不跳过证书校验。

```sh
HIKARO_RELAY_BOOTSTRAP=… pnpm start --pair --relay wss://your-relay.example
pnpm start --serve
```

1. 手机扫描或粘贴电脑生成的五分钟配对码，核对 relay、主机 ID 和主机公钥，再保存连接。配对码含私钥和设备 token，不要转发或写入日志。
2. 在电脑的 `--serve` 终端确认该设备。确认设备身份不会自动给它任何任务权限。
3. 在附着 TUI 中选择任务，执行 `/share <手机设备ID> view`。手机连接页会显示设备 ID；具体授权操作见 [共享 host](shared-host.md)。
4. 手机刷新列表，选择获授权任务。选择仅改变本设备视图，不接管任务或审批。没有授权时显示空列表。

M0 不注册携带凭据的 `hikaro://pair#…` 系统深链接；配对只从 App 内扫码或安全输入框进入，避免凭据进入路由历史。换电脑前先移除当前连接。二维码过期限制首次导入，不会使已经保存的设备身份五分钟后失效。

## 在 iOS 模拟器上逐步测试

1. 在仓库根目录执行 `pnpm dev:sim`，打开 [Simulator Preview](http://localhost:3200/)。当前电脑已安装开发客户端，日常修改 TS／TSX 后直接在这里检查。首次安装或原生配置变化，先执行上面的原生构建步骤。
2. 只看界面时，可以检查连接页、无效配对码提示、设置和返回。此时没有任务是正常的；Metro 只提供手机界面，不是任务 host 或 relay。
3. 测试真实连接前，按 [relay 部署指南](remote.md#deploy-your-relay) 配置有效的 `wss://` 地址和 bootstrap secret。没有 relay 时不能完成端到端配对；不要改成明文连接或跳过证书检查。以下命令均在同一仓库目录运行，使用默认 `~/.hikaro`：

   ```sh
   pnpm build
   # 终端 A：启动任务主机（--demo 不需要模型 API key）
   pnpm start --host --demo
   # 终端 B：打开同一主机的 TUI，输入一句话产生任务记录
   pnpm start --attach
   # 终端 C：生成配对码；将地址和 secret 替换为自己 relay 的配置
   HIKARO_RELAY_BOOTSTRAP='你的-bootstrap-secret' pnpm start --pair --relay wss://你的-relay.workers.dev
   pnpm start --serve
   ```

4. 模拟器里使用配对码输入框（提示为 `hikaro://pair#…`），输入终端 C 生成的完整配对 URI，再点“核对配对信息”，核对主机并“保存并连接”。模拟器不用于真实相机扫码验收。浏览器预览若不能粘贴，使用 Xcode Simulator 的键盘／粘贴功能；不要把配对 URI 放进浏览器地址栏。
5. 在终端 C 按提示确认设备。在终端 B 当前任务内执行 `/share <手机显示的设备ID> view`，然后在手机刷新并选择任务。没有该授权时，空列表是预期行为。
6. 在 TUI 继续对话，检查手机显示同一任务的最新输出；点预览下方 Home，再打开 Hikaro，检查恢复。停止终端 C 的桥接后手机应显示离线；重新执行 `pnpm start --serve` 后应恢复。电脑任务不会因手机离开而停止。
7. 在 TUI 执行 `/share <设备ID> off`，手机应失去该任务访问权。M0 当前仅支持查看，手机发送、审批和停止属于 M1，尚未开放。

## 恢复边界

设备凭据进入系统 SecureStore，不提供明文降级；iOS 使用仅本设备、解锁后可访问的 Keychain 项。SQLite 每个设备身份只保存最多 60 条 ID／方法意图元数据（WAL／FULL），按 relay、主机、公钥和设备隔离。Android 禁用应用备份；新的本机安装不静默重用卸载后遗留的 Keychain 身份。

切到后台会隐藏正文并释放连接，不停止电脑上的任务。前台／重新启动时先握手、获取主机快照、查询持久回执，再恢复任务；未知结果不会自动重发。短暂断线时旧内容明确标为离线；重新连接后以主机为准。撤销、身份验证失败或替代连接分别锁定视图；失效身份会移除凭据与意图状态。历史每页最多 20 条、列表每页 50 项、实时输出最多 100k 字符，不累积无限历史。

## 验证与后续

验收证据见 [validation](validation.md) 和 [M0 规格](specs/mobile-m0.md)。开发构建、模拟器和生产 JS 导出不是签名分发或真机性能验收。下一阶段补充 iOS／Android 真机网络、锁屏／杀进程、真实相机扫描、发布版性能与 30 分钟内存验收，再推进 M1 的审批、补充和停止。
