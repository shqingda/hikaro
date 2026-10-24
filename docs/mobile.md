# 移动端

已实现 M0 的扫码或粘贴配对码、核对主机身份、安全保存设备凭据、连接共享 host、分页查看获授权任务，以及恢复历史和当前输出。M1 现已接入工具审批、按运行停止、发送/排队、离线草稿与回执核对。消息图片可按需打开、切换和缩放；任务页可阅读记录的文件差异，旧主机不支持时明确提示升级。长消息可从预览打开“阅读全文”，按段阅读与复制；任务页支持搜索完整消息正文。手机按配对身份保存最近查看的一页消息，离线内容明确标为旧快照，不恢复控制权限。操作与边界见 [长消息阅读](specs/mobile-reading.md)、[图片/差异](specs/mobile-inspection.md)、[搜索](validation/mobile-search.md)及[离线历史缓存](validation/mobile-offline-history.md)。

状态核对：2026-10-23。这里区分已实现功能、已有模拟器证据和仍待完成的真机验收；完整缺口见 [两端完成度审计](validation/completion-audit-2026-10-23.md)。开发与自用安装入口见 [移动端安装](mobile-install.md)。

## 启动

**模拟器入口统一为 `pnpm dev:sim`**：复用原有 iPhone 18 Pro／iOS 27.0，启动后在 Codex 内置浏览器打开 `http://localhost:3200/`。默认不打开系统浏览器；需要时显式加 `--open-browser`。不启动 DeviceHub，不创建新设备、不安装测试 CA。配对与任务授权使用你配置的 relay；以下是完整步骤。

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
pnpm dev:sim          # 复用已有设备，在 Codex 内置浏览器打开打印的预览地址
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

检测到 DeviceHub 接管输入时，脚本调用 `serve-sim repair-input`，等待 SpringBoard 稳定后重建该设备的预览；运行中的 App 会短暂关闭，数据保留。macOS 的 Accessibility 控制权限不足时，键盘可能退回旧通道；macOS 27 的权限界面可能显示为 Device Control and Data Access（设备控制与数据访问），不是完全磁盘访问权限。授权对象是启动 serve-sim 的应用，以系统归属为准；本机当前归属 ChatGPT.app（bundle ID com.openai.codex）。不会自动修改系统权限。停止指定设备的预览：`pnpm exec serve-sim --kill <UDID>`。不要同时运行多份启动脚本。

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

4. 模拟器里使用配对码输入框（提示为 `hikaro://pair#…`），输入终端 C 生成的完整配对 URI，再点“核对配对信息”，核对主机并“保存并连接”。模拟器不用于真实相机扫码验收。无 DeviceHub 的原生粘贴步骤见 [原有 iPhone 验收记录](mobile-m0-acceptance.md#复测操作)；不要把配对 URI 放进浏览器地址栏。
5. 在终端 C 按提示确认设备。在终端 B 当前任务内执行 `/share <手机显示的设备ID> view`，然后在手机刷新并选择任务。没有该授权时，空列表是预期行为。
6. 在 TUI 继续对话，检查手机显示同一任务的最新输出；点预览下方 Home，再打开 Hikaro，检查恢复。停止终端 C 的桥接后手机应显示离线；重新执行 `pnpm start --serve` 后应恢复。电脑任务不会因手机离开而停止。
7. 在 TUI 执行 `/share <设备ID> off`，手机应失去该任务访问权。手机发送、审批和停止需要另行授予 `control`，流程见下文。

## 审批与回执

在电脑当前任务执行 `/share <设备ID> control` 后，手机可打开完整审批详情，查看原因、工具参数和文件访问范围，再选择“允许这一次”或“拒绝”。默认 `view` 仍只允许查看，手机不能自行取得控制权限。每次操作都会由 host 再次检查任务归属和当前授权；请求已过期、已被另一设备处理或控制权已撤销时拒绝操作。

等待回执时禁用重复提交和任务切换。电脑收到决定只表示审批已处理，工具是否成功仍以任务记录为准。“本设备操作回执”展示当前设备最近的审批和停止操作；结果未知不会自动重发。重连会查询持久回执，也可以手动选择“核对未确认的操作”。切入后台清除审批正文，恢复后重新获取电脑状态。

已有证据覆盖 controller、加密连接和实际共享 host，包括双端竞争与丢失回执恢复；iOS 模拟器已验证完整详情、拒绝与允许操作，并核对实际文件结果。Android、真机和生产 relay 网络仍待验收，详见 [审批验收](validation/mobile-approvals.md)及[原生控制验收](validation/mobile-native-controls.md)。

## 停止运行

运行中选择“停止这次运行”，系统确认框会说明：停止当前任务并清除该任务待发消息，已经完成的文件修改不会撤销。确认始终绑定打开确认框时的任务和运行；如果任务切换、运行结束或已进入下一轮，原确认会失效，需要重新查看状态。

只有当前任务的控制端可停止。旧版电脑未声明支持按运行停止时，手机提示更新，不发送范围更大的旧取消请求。收到停止回执只表示请求已处理；任务页等待 host 返回实际终态才显示“已停止”。断线后只核对原回执，不自动再次停止。iOS 模拟器已检查取消/确认分支、实际进程退出及 cancelled 终态；Android 和真机仍待验收。契约见 [停止规格](specs/mobile-stop.md)，实际 shell 与回执恢复证据见 [停止验收](validation/mobile-stop.md)及[原生控制验收](validation/mobile-native-controls.md)。

## 发送与离线草稿

在任务页输入要求，回车换行，点击“发送”才提交。运行中按钮显示“加入待发队列”，将在当前运行结束后执行；这与下一模型轮 steering 不同。离线时可继续编辑本机草稿，重开应用后可从连接页进入“继续编辑本机草稿”。离线信息不代表当前任务授权，发送仍须在线核对 control 权限。

显示“草稿已保存在本机”后可以退出；保存失败时原文保留在输入框，请重试保存。发送中的原文保留到电脑确认接收，丢失回执时点击“核对发送结果”。如要“恢复为可编辑草稿”，先核对电脑任务记录，避免再次发送导致重复执行。重连和切回前台不会自动发送。证据和真机待验边界见[发送与草稿验收](validation/mobile-composer.md)。

## 补充指令与队列

任务运行中可选择“补充到下一模型轮”。这条指令用于下一次模型推理，本身不会启动新任务。“补充指令队列”可查看、编辑、置顶和删除；管理期间暂停待发消息与补充指令处理，关闭后继续。中断后恢复的指令需要最初提交的设备身份明确确认，不会因重连自动执行。编辑尚未自动保存，需要点击“保存修改”。

iOS 模拟器的补充、置顶、删除、编辑/保存/放弃、原身份恢复确认及后台释放已有验收；Android、真机、软件键盘与中文候选输入仍待完成。见 [steering 验收](validation/mobile-steering.md)、[原生控制验收](validation/mobile-native-controls.md)及[键盘验收](validation/mobile-keyboard.md)。

## 通知

任务列表提供“开启或更新任务通知”和“关闭任务通知”。开启需要安装包包含原生通知模块、有效的 Expo 项目配置和平台推送凭据，并取得系统通知权限；构建时可通过 `HIKARO_EXPO_PROJECT_ID` 配置项目 UUID。缺少这些条件时，入口不能代表通知可用。关闭操作清除这台电脑在 relay 中保存的设备推送 token，已经在途的外部通知不保证撤回。

已有注册/关闭的加密传输与身份边界测试，iOS 模拟器也已编译安装原生通知模块。生产推送收件、通知点击后状态复核、撤销后的收件边界和真机后台验收仍需单独记录；不把原生模块安装或注册回执当作后台投递成功。最新证据见 [通知状态](validation/mobile-notification-status.md)及[原生安装](validation/mobile-native-install.md)。

## 恢复边界

设备凭据进入系统 SecureStore，不提供明文降级；iOS 使用仅本设备、解锁后可访问的 Keychain 项。SQLite 每个设备身份保存最多 60 条 ID／方法意图元数据，以及按任务隔离的未发送草稿、最小任务信息和一份历史快照（WAL／FULL），按 relay、主机、公钥和设备隔离。历史快照最多 20 条消息，单条预览最多 20,000 字符，序列化总长最多 2,000,000 字符；图片和完整附件不缓存。撤销或移除配对也清理本机草稿与历史缓存。任务页“清除本机历史缓存”保留未发送草稿和电脑记录。Android 禁用应用备份；新的本机安装不静默重用卸载后遗留的 Keychain 身份。

切到后台会隐藏正文并释放连接，不停止电脑上的任务。前台／重新启动时先握手、获取主机快照、查询持久回执，再恢复任务；未知结果不会自动重发。短暂断线时旧内容明确标为离线；重新连接后以主机为准。撤销、身份验证失败或替代连接分别锁定视图；失效身份会移除凭据与意图状态。历史每页最多 20 条、列表每页 50 项、实时输出最多 100k 字符，不累积无限历史。

## 验证与后续

已有 iOS 模拟器证据包括配对与恢复、审批/停止、发送与离线草稿、steering、图片/diff，以及任务与队列编辑框逐键回车换行。相应版本和边界见 [M0 原生验收](mobile-m0-acceptance.md)、[原生控制验收](validation/mobile-native-controls.md)、[发送与草稿](validation/mobile-composer.md)、[图片/diff](validation/mobile-inspection.md)和[键盘验收](validation/mobile-keyboard.md)。这些记录属于当时源码/安装包的验收，不是对后续每次修改的自动复验。

当前优先完成搜索原生点击、离线历史缓存原生重开、高速输入/软件键盘/中文 IME、大字体和辅助技术。Android 已有带 JS 的 ARM64 自用 Release APK，但安装运行尚未验收，见 [构建记录](validation/mobile-android-build.md)。用户当前只有 Android 真机，iOS 继续使用现有模拟器；iOS 真机项目仍保留为未验，不据此改写双平台完成条件。

真实 relay 网络、设备撤销、网络切换/断网/锁屏/杀进程、真实相机扫码、生产通知、Release 性能与 30 分钟内存/耗电仍需实际设备证据。开发构建、模拟器、加密 fixture 和生产 JS 导出不能替代这些验收。个人自用与未来公开分发的签名门槛分别见 [安装说明](mobile-install.md)及[发布准备](release-readiness.md)。
