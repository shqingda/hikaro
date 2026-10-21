# 移动端发送与离线草稿 · 2026-10-21

任务页已接入原生多行编辑器与显式发送按钮。空闲时发送，运行中加入待发队列；编辑器配置为多行输入，回车行为仍待可靠的原生键盘路径验证。草稿连同最小任务信息按 relay、host ID/key、device ID、session ID 保存到本机 SQLite，离线重开可继续编辑，恢复连接不会发送草稿。当前轮实现普通 prompt 排队，下一模型轮 steering 仍单独待办。

发送前持久化原文和稳定命令 ID；ClientConnection 的可选第三参数接收 ID 和发送前校验，原有调用方式保持不变。校验在意图持久化之后再次检查当前连接、任务与控制权，host 仍校验 sessionId 和授权。确认接收后只清除匹配 ID 的草稿；失联、崩溃及清理失败保留原文。恢复只查询原 ID，持久 accepted 记录本身尚不足以证明入队成功；等待 completed 或原 RPC 接收响应，不自动重发。失败或未知项只能由用户核对电脑后明确恢复为可编辑草稿。

## 验证结果

- `tests/mobile-composer.test.ts`：6 项通过，覆盖离线重建、设备/任务隔离、晚到读取、写失败保留原文、先落盘后发送、任务切换、迟到回执不清除新任务、后台保存、撤销写入隔离、合并连续编辑、清理失败和明确恢复。
- `tests/client-connection.test.ts`：5 项通过，新增稳定 ID、等待 journal 期间失去权限时不发送、同 ID 不重放；保留原有连接恢复契约。
- `tests/mobile-controller.test.ts`：5 项受影响定向测试通过，其余 5 项未运行。包含离线探测失败后的草稿入口、后台隐藏/恢复、待完成保存与移除配对的顺序，以及现有审批/存储边界。
- 唯一 E2E 位于同一 mobile-controller 文件：实际 shared host 与 SQLite、加密 socket fixture。发送第一条要求；真实 shell 等待期间排队第二条并证明提前未进入历史，释放 shell 后执行；丢弃第三条 prompt 回复，重建手机 controller 后核对回执。三个原文各出现一次，prompt 帧总数为 3。撤销 control 后拒绝发送，原文保留。
- 根目录和移动端类型检查、CLI 构建通过；最终 iOS/Android Hermes 导出均成功，分别 1369/1582 个模块，bundle 均约 4.3 MB。
- `tests/dev-sim.test.ts` 另有 5 项通过：默认不启动系统浏览器，显式 `--open-browser` 才调用 macOS `open`；保留设备及其他项目进程保护。实际执行 `pnpm dev:sim` 和 `pnpm dev:sim --no-launch` 均复用现有服务，预览在 Codex 内置浏览器打开。
- 审查时暂时移除写入身份隔离条件，对应测试按预期失败；原文件已逐字节恢复。没有改变断言或放宽超时。

TDD 首次因模块尚不存在按预期失败。原生 SQLite 检查发现新建草稿携带了完整任务快照的多余字段，新增失败断言后通过 schema 提取最小任务信息，再运行 6 项 composer 测试通过。首次移动端类型检查发现 universal TextInput 的 style 不支持 minHeight，改用其支持的 height 后通过；模拟器脚本增加选项时补齐 `.d.mts` 签名后，根目录与移动端类型检查通过。没有运行全量测试、其他自动 E2E 或性能基准。

## 原生 iOS 验收

使用原有 iPhone 18 Pro／iOS 27.0 和 `dev.hikaro.mobile` 开发客户端，通过 `pnpm dev:sim` 在 Codex 内置浏览器的 `http://localhost:3200/` 预览实际原生 App。没有重建、重装或创建模拟器，也没有安装测试 CA。

隔离环境为实际 shared host／SQLite、Miniflare TLS relay 和 demo provider，经官方 cloudflared 2026.10.1 临时 HTTPS 隧道连接；origin CA 校验与配对授权保持启用。此环境验证真实网络上的开发流程，不代表生产 relay 可用性或真实模型验收。

1. 原生粘贴中文两行和 emoji，界面与 SQLite 文本一致；点击发送前，电脑历史没有该要求。点击原生发送按钮后，电脑历史仅出现一次对应原文，输入框及持久草稿均清空。
2. 停止测试桥接连接，输入离线两行草稿；SQLite 保存原文，发送按钮禁用。
3. 回到主屏再打开 App，进程 PID 相同，草稿保留；终止进程后重新运行 `pnpm dev:sim`，新 PID 下从“继续编辑本机草稿”恢复同一任务与原文。
4. 恢复连接后草稿仍在，电脑历史没有离线草稿，证明重连不自动发送。
5. 撤销隔离测试设备后 App 返回未配对状态；该身份的草稿和意图记录均为零。测试 host、relay 与隧道已停止，临时文件移入废纸篓；现有模拟器、Metro 和 Codex 预览保留供继续使用。

原生截图：[发送前](../design/mobile-composer/unsent-draft.png)、[发送后](../design/mobile-composer/sent.png)、[离线编辑](../design/mobile-composer/offline-draft.png)、[离线重开](../design/mobile-composer/reopened-offline.png)、[重连保留](../design/mobile-composer/reconnected-draft.png)。原生任务列表中遗留的“已连接 · 只读”提示已改为“已连接”。

## 待验收

预览 Return 事件未可靠送达原生编辑器，SQLite 没有出现新增换行；serve-sim 日志报告 Device Hub 键盘缺少 macOS 辅助功能权限并回退到 legacy HID，因此键盘回车、软件键盘和 IME 本轮未计通过。两行粘贴不能替代这些验证，AX 定位也不能替代 VoiceOver 验收。

原生 Android、物理手机、移动网络切换、真实相机、辅助技术、签名包及发布性能仍待验收；原生忙时排队本轮没有点击验证，仅有上述自动真实 host 用例。继续补齐 steering、图片/diff、通知与真机分发。当前原生截图仅作开发版本证据，离线无历史时的空态文案仍可改进。

发布准备工程估算：TUI **98%**，移动端 **50%**。完整产品目标继续保留。
