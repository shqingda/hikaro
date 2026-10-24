# 移动端后台任务（只读）· 2026-10-24

## 结果

任务页新增“查看后台任务”，打开只读的“后台任务”页，分别列出子 agent（含缩进的嵌套孙任务）和后台终端的标题与状态，包括电脑重启后恢复的“interrupted”或“unknown after host restart”记录。数据来自既有的只读 `execution.read`（`kind` 为 `children` 与 `terminals`）：不带队列租约 token，不调用 `execution.hold` 或 `execution.action`。host 返回的操作项会在手机端解析时丢弃，页面不提供停止或输入，并提示到电脑端 `/tasks` 操作。关闭页面、断开或切换任务后，迟到的响应会被丢弃。

## 验证证据

- `tests/mobile-controller.test.ts` 新增 1 项（先确认缺少实现时失败）：经加密通道读取两类记录，保留嵌套标题与恢复状态，不携带 token，不发送 hold/action/prompt，关闭后清空。该文件 36 项全部通过。
- `pnpm check` 退出码 0：117 个应用测试文件、621 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-mobile-background.log`。移动类型检查与 iOS/Android Hermes 导出通过，日志 `/tmp/hikaro-mobile-export-20261024-background.log`。

## 未覆盖

原生界面渲染、读屏与大字体（需要在线配对），真实 host 的“仅查看”设备端到端读取（host 侧按既有只读方法规则放行，本轮未单独跑），Android 与真机。
