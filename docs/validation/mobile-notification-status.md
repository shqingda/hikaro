# 移动通知缺口核查

2026-10-22。relay 已有 Expo push token 保存、通用提醒队列与去重投递；加密 host bridge 已有 push.register 处理。原先远程 hello 直接转发本地 RPC 能力清单，漏掉 bridge 自己实现的 push.register，手机客户端无法通过能力探测发现注册支持。

本轮修复：只在加密远程 hello 响应增加 push.register，不改变本地 RPC 能力，也不修改共享的原始响应。类型检查、构建及 remote-host-control 四项检查通过，包括实际加密握手后的能力声明。

通知功能尚未完整交付：手机客户端还缺原生通知模块、用户明确启用/关闭、token 获取及注册、点击后重新核对任务状态；还需 Expo 项目/平台推送凭据，以及真机后台和撤销验收。不能把此协议修复或 relay 已有接口写成通知可用。此变更不包含在 v0.1.0 已发布包中。

关闭链路补充：加密 bridge 的 push.register 接受显式 token=null，经 host 身份清除 relay 中该设备的 push token。设备身份仍由加密连接注入，不能指定其他设备。relay Miniflare 集成验证注册成功、设备 bearer 直接清除被拒、host 清除成功、后续内部通知返回 skipped；不发送真实 Expo 通知。已在途的外部投递不承诺撤回。根/relay 类型检查及 CLI 构建通过，手机开关仍未接入。
