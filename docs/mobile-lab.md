# 一键模拟器联调

在仓库根目录运行：

```sh
pnpm mobile:lab
```

打开 [Simulator Preview](http://localhost:3200/)。不需要启动 DeviceHub，不需要 Expo Go，也不需要 Cloudflare 账号或模型 API key。首次运行会创建 **Hikaro Mobile Lab** 专用模拟器并构建 Development Build；后续复用安装。原生配置或依赖变化后自动重新构建，也可用 `pnpm mobile:lab --build` 强制更新。JS／TS 修改由 Metro 更新。

这是本机联调环境：执行仓库真实 relay、加密桥接、共享 host 和 SQLite，使用演示模型与合成任务。relay 只监听 `wss://127.0.0.1:8443`，手机连接和授权仍使用正式校验；没有跳过 TLS、电脑确认或任务授权。它不部署公网服务，不能用于手机真机跨网络连接；公网部署见 [remote](remote.md)。

## 配对与授权

保持启动终端打开，后续命令直接在这个终端输入，无须加 `pnpm`。

1. 首次打开时，允许 iOS“在 hikaro 中打开”，在开发客户端提示中点 Continue，再关闭开发菜单；这些提示不属于 Expo Go。第一次启动会生成五分钟配对码，并放入专用模拟器的剪贴板。在 Hikaro 连接页长按配对码输入框，选择“粘贴”。点击“核对配对信息”，核对本地 relay 与主机信息，再保存连接。不要把配对码放进浏览器地址栏。
2. 终端出现待确认设备时，输入 `allow`。手机完成连接，此时任务列表应为空：确认设备不会自动授权任何任务。
3. 终端输入 `grant`，授予当前演示任务的查看权。在手机刷新列表，再选择 **M0 · 接续同一个任务**，查看历史和最新输出。
4. 终端输入 `update`，手机应看到新增结果。M0 仅支持查看，没有发送、审批或停止入口。

配对码过期后输入 `pair`。这会撤销本实验上一个手机身份，生成并复制新的配对码；已连接的手机需要重新导入。`copy` 只重新复制现有配对码，不延长有效期。配对凭据不会打印到日志，保存在私有的 `artifacts/mobile-lab/pairing.txt`；只在模拟器粘贴失败时才打开该文件手动复制。

## 恢复与撤权

| 在启动终端输入        | 手机应看到什么                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `offline`             | 与桥接断开，显示离线；电脑任务仍在                                                 |
| `update`，再 `online` | 恢复同一任务并补上断线期间的新结果                                                 |
| `reopen`              | 终止并重新打开专用模拟器里的 Hikaro，恢复保存的连接与所选任务                      |
| `restart`             | 真正关闭并重启本地 relay、host 和桥接，保留设备、授权、任务与历史                  |
| `unshare`             | 当前任务不再可访问；刷新后列表为空                                                 |
| `grant`               | 恢复该任务的查看权                                                                 |
| `revoke`              | 撤销整个测试设备，手机锁定视图并清除失效身份；需 `pair` 重配                       |
| `status`              | 查看测试任务 ID、设备 ID、确认与桥接状态，不显示 token 或私钥                      |
| `quit` 或 Ctrl+C      | 关闭本地 relay 和任务主机，保留联调数据；再次运行 `pnpm mobile:lab` 可继续恢复测试 |

也可以使用预览工具栏 Home 回到主屏幕，再点 Hikaro 图标，测试进入后台与返回。模拟器不能替代真机相机扫码、锁屏网络和发布版性能验收。

原生实测截图：[离线标记](design/mobile-m0/lab-offline.png)、[完整重启与 App 重开后的任务恢复](design/mobile-m0/lab-restored.png)。

## 数据、证书与服务

- 本地 CA 只装入脚本新建并记录的专用模拟器，不装到 macOS、日常 iPhone 模拟器或真机。TLS 验证始终开启，服务端证书自动续期；CA 有效期一年。
- 任务、relay Durable Object 状态和测试密钥保存在当前仓库忽略的私有目录 `artifacts/mobile-lab/`。不读写 `~/.hikaro`，不调用真实系统 Keychain，不将测试配置提交到 Git。手机端仍使用真实 SecureStore／SQLite。
- 不会抹掉、卸载或重置已有模拟器。退出不删除实验数据或专用模拟器，因此重启后才能验证持久恢复。
- 同一实验只允许一个启动终端。若正在运行，请使用该终端输入命令，或先退出它再重新启动。
- 预览使用 3200，Metro 使用 8081。脚本可切换本仓库自己的预览；如果 Kaku 或其他项目占着端口，会明确拒绝接管，请先停止另一项目的对应服务。后台 Metro 与预览可继续运行，不依赖 DeviceHub 窗口。
- 必要自动化验收：`pnpm mobile:lab:check`。包含真实 TLS／加密 relay、确认与只读授权边界、断线补回、relay／host 重启恢复，以及私有文件、单实例和跨项目预览保护。

Relay 本地运行与持久化机制参考 [Cloudflare 官方本地开发说明](https://developers.cloudflare.com/workers/local-development/)。当前仓库 Miniflare 5 使用 `resourcePersistencePath`，旧 `durableObjectsPersist` 参数不能保证重启后保留身份。
