# M0 原生验证截图

![iOS 原生只读任务恢复](readonly-task.png)

2026-10-18，本地 iOS 27.0 独立测试模拟器、Expo 58 开发构建，经 serve-sim 0.1.48 在 Codex 内置浏览器操作。画面使用临时 TLS relay、真实共享 Runtime/SQLite、加密远程桥接和合成 demo 任务；不是视觉稿，也不是外部模型任务。截图不含配对凭据。

![失效身份锁定与清理](invalid-pairing.png)

不据此宣称 iOS/Android 真机、发布版性能、真实相机扫码或商店分发已验收。启动见 [移动端指南](../../mobile.md)，完整证据见 [validation](../../validation.md)。

## 历史联调证据

以下截图来自已移除的专用测试设备，保留为配对、只读授权和持久恢复的历史验收证据。额外设备及其生成的测试数据已按用户要求删除；日常入口为 `pnpm dev:sim`，复用原来的 iPhone 18 Pro／iOS 27.0。

[离线状态](lab-offline.png) · [完整重启后恢复任务](lab-restored.png) · [当前启动步骤](../../mobile.md)
