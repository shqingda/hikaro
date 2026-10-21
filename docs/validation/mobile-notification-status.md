# 移动通知缺口核查

最新进展：任务列表已增加用户主动开启/更新及关闭通知入口，接入 expo-notifications 58.1.5、系统权限、Android 默认通知渠道和 Expo token 获取。构建可通过 HIKARO_EXPO_PROJECT_ID 注入项目 UUID；缺失时不请求系统权限，旧安装包缺少原生模块时安全失败。token 不写入本地存储，异步获取期间连接身份变化会取消注册。修复 MobileController 传输白名单遗漏 messages.search、push.register 的问题。17 项控制器回归及根/移动类型检查通过，其中新增真实加密传输注册、关闭与旧配对身份拒绝用例。仍缺通知点击后的状态复核、推送项目与平台凭据、原生安装及后台实际收件验收；以下为各轮历史记录。

2026-10-22。relay 已有 Expo push token 保存、通用提醒队列与去重投递；加密 host bridge 已有 push.register 处理。原先远程 hello 直接转发本地 RPC 能力清单，漏掉 bridge 自己实现的 push.register，手机客户端无法通过能力探测发现注册支持。

本轮修复：只在加密远程 hello 响应增加 push.register，不改变本地 RPC 能力，也不修改共享的原始响应。类型检查、构建及 remote-host-control 四项检查通过，包括实际加密握手后的能力声明。

通知功能尚未完整交付：手机客户端还缺原生通知模块、用户明确启用/关闭、token 获取及注册、点击后重新核对任务状态；还需 Expo 项目/平台推送凭据，以及真机后台和撤销验收。不能把此协议修复或 relay 已有接口写成通知可用。此变更不包含在 v0.1.0 已发布包中。

关闭链路补充：加密 bridge 的 push.register 接受显式 token=null，经 host 身份清除 relay 中该设备的 push token。设备身份仍由加密连接注入，不能指定其他设备。relay Miniflare 集成验证注册成功、设备 bearer 直接清除被拒、host 清除成功、后续内部通知返回 skipped；不发送真实 Expo 通知。已在途的外部投递不承诺撤回。根/relay 类型检查及 CLI 构建通过，手机开关仍未接入。

客户端注册补充：增加 bridge-only 方法的客户端识别；本地 hello 明确不宣告 push.register。通知设置属于非任务操作，不进入持久 intent、任务回执查询或任务未知结果计数；断线不自动重发。MobileController.configurePush 校验 token、已协商能力、连接身份和成功回执。客户端六项检查通过，新增用例确认注册回执丢失后不重发、不持久化 token。根/移动类型检查及 CLI 构建通过；系统通知权限、token 获取和手机开关界面仍待完成。
