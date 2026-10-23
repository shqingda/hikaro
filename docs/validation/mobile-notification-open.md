# 移动通知点击复核

2026-10-23。此记录证明通知响应的应用侧实现与受控测试结果，不代表生产推送已经可用。

## 行为与边界

- 根布局挂载通知响应观察器；先检查 `ExpoNotificationsEmitter`，再加载 `expo-notifications`。旧安装包缺少原生模块或加载失败时，应用仍可启动。
- 使用 Expo 58.1.5 的 `addNotificationResponseReceivedListener` 和同步 `getLastNotificationResponse`，覆盖运行中点击和冷启动遗留响应。响应读取使用官方 API，不依赖通知正文。
- 只接受默认点击动作。通知内容仅提取 `data.hostId`；不使用通知中的 URL、sessionId、审批动作或消息正文。当前 relay 通知没有 sessionId，因此点击后的目标固定为任务列表。
- 冷启动等待已存配对恢复，后台点击等待同一配对重连。观察器本身不建立连接、不请求系统通知权限、不注册 token。
- 点击仅通过当前加密连接重新执行 `session.list`，读取当前设备有权查看的第一页任务。完成身份、连接代次和分页结果复核后，才进入任务列表；不自动选择任务、审批、发消息或重发操作。
- 配对身份包含 relay、hostId、hostKey、deviceId 及本次配对生命周期。解绑或撤销开始即作废；同一 host 重新配对也不能接收上一身份等待中的点击。原生模块延迟加载期间发生配对变化时，旧启动响应被丢弃。
- 使用 `clearLastNotificationResponse` 消费系统缓存响应，并按控制器保留最多 64 个已处理标识，避免相同响应或布局重新挂载触发重复跳转。仅在内存中去重；未写入凭据、token 或通知正文。
- 刷新失败、被更新的分页请求取代、解绑、后台切换或组件卸载后，不执行导航。读取错误仍由控制器提供给当前页面。

## 验证结果

`pnpm exec vitest run tests/mobile-controller.test.ts tests/mobile-notification-response.test.ts`：36 项通过，其中通知观察器 15 项，移动控制器 21 项。

覆盖冷启动等待、后台恢复、重复响应与重新挂载、错误 host、自定义动作、格式错误、未配对、解绑后同 host 重配对、在途刷新后的身份变化/后台/卸载/失败、可选原生模块加载失败、延迟加载期间身份变更。加密控制器用例确认只有 `session.list` 发出，旧身份不能刷新；真实在途读取被新分页或解绑取代后不会覆盖列表。

生命周期加密集成用例还确认：`inactive → active` 不重连，保留草稿及身份；`background → active` 清空敏感视图后重连恢复草稿，不发送 prompt。

红绿过程：新响应模块不存在时测试先失败；控制器缺少刷新方法时测试先失败；延迟加载期间重配对的旧响应误绑定新身份用例先失败，修复后通过。审查时临时移除 hostId 匹配，错误 host 用例确实失败，随后恢复源码。

根 `pnpm typecheck` 和 `pnpm mobile:typecheck` 均通过。新增文件已格式化。全库测试和构建由本轮集成统一记录。

本轮 iOS 原生运行检查：新增动态模块后 Fast Refresh 曾出现 `Requiring unknown module "1754"`，位置在 expo-notifications 导出。完整 Reload 后恢复正常连接页，无错误覆盖层。该结果只证明此次原生启动正常；当前安装没有配对，未验证生产推送收件、点击导航或系统后台投递。

## 仍需平台验收

- 配置真实 Expo 项目与 APNs/FCM 凭据，安装包含通知模块的目标构建。
- 在 iOS、Android 上分别验证系统授权、开启/更新/关闭通知、后台和终止进程后的实际收件与点击。
- 验证在线点击授权列表刷新、离线等待重连、撤销/重配对期间点击、关闭后不再产生新投递。
- 当前通知仅携带 hostId，无法从历史通知识别其原始配对身份；实现只按点击时已恢复的本地身份重新验证授权，绝不把通知当成任务权限。未承诺撤回平台已经在途的推送。

## 官方依据

[Expo Notifications API](https://docs.expo.dev/versions/latest/sdk/notifications/)：根布局响应监听、默认动作、最近响应获取与清除。另核对仓库实际安装的 `expo-notifications` 58.1.5 源码：`NotificationsEmitter.ts` 的同步获取/清除 API，以及 `NotificationsEmitterModule.native.ts` 的原生模块名称。未使用已弃用的 Async 包装接口。
