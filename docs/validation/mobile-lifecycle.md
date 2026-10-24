# 移动生命周期与输入标签 · 2026-10-23

本轮接续工作区已有的 `mobileLifecycle` 修改：iOS 临时进入 inactive（例如系统权限面板）仍遮蔽页面，但不关闭连接；只有进入 background 才释放连接，回到 active 才恢复。重复状态通知不会重复恢复。移动类型检查发现 `AppState.currentState` 还可能是 undefined，已补齐类型与启动用例。

验证：

- `tests/mobile-lifecycle.test.ts` 两项通过，覆盖 active/inactive/background、重复通知和 null/undefined 初始状态。
- `tests/mobile-controller.test.ts` 新增真实加密客户端链路回归：临时 inactive 保留连接身份、草稿和任务；后台清除正文，前台恢复草稿且不自动发送。计数见该文件与本轮总验收记录。
- 根目录、移动端类型检查通过。
- 为任务要求与补充指令编辑器增加独立读屏标签和提交语义提示；不依赖占位文字表达输入用途。

复用 iPhone 18 Pro / iOS 27 模拟器，通过 `pnpm dev:sim` 和 Codex 内置浏览器预览：完整重载后原生连接页正常显示，进入扫码页并返回成功。新增通知动态模块的 Fast Refresh 曾显示 unknown module，完整重载后消失。当前设备未配对，没有用这次启动检查替代配对任务、系统权限弹窗、相机扫码、VoiceOver 或真机生命周期验收。

本地原生启动截图：`artifacts/mobile-startup-20261023.png`。截图为本机验收产物，不纳入源码分发。
