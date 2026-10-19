# M0：原有 iPhone 18 Pro 原生验收

日期：2026-10-18 夜间至 2026-10-19。设备始终为原有 iPhone 18 Pro／iOS 27.0，UDID `498E27B7-5192-48CE-9B13-F4A27F10F806`，应用为已安装的 `dev.hikaro.mobile` Development Build。使用现有 `pnpm dev:sim`、Metro 和 `localhost:3200` 预览；没有新建、克隆、抹除或重新安装设备，没有启动 DeviceHub，也没有往模拟器安装 CA。

## 环境和边界

本机没有自有 relay 配置，因此复用 `scripts/mobile-fixture.mjs` 的真实 relay、共享 host、SQLite、设备确认及查看授权，数据与用户的 `~/.hikaro` 和主机 Keychain 隔离。临时目录归当前用户所有、权限 0700，凭据文件 0600。对手机提供临时、证书有效的 HTTPS／WSS 地址；主机仍通过校验证书的本机 TLS 连接 relay，外层通道也校验该本机证书，没有关闭证书验证或认证。测试 URI 只替换 relay 地址，主机 ID 和公钥与 host 配置一致。

临时通道使用官方 `cloudflared` 2026.10.1，下载校验和已核对，只解压到本轮临时目录，不安装系统服务。方案参考 [Cloudflare 本地预览文档](https://developers.cloudflare.com/pages/how-to/preview-with-cloudflare-tunnel/)。这只是开发验收网络，不是生产 relay 部署或公网可用性验收。

长消息使用落盘的合成用户正文，共 23,409 个 UTF-16 单元，包含明确的段首标记和跨段 emoji。演示模型的该次请求被现有上下文预算拒绝，手机正确显示“运行失败”；没有修改预算、模型限制或其他质量阈值。阅读、复制和恢复验证针对这条真实保存的历史，不能据此声称原生模型执行或流式输出已通过。

## 已完成的原生场景

| 场景               | 观察与证据                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安全输入与身份核对 | 从 App 原生粘贴菜单导入配对 URI，核对主机、公钥和 relay；过期码显示错误，重新导入有效码后可进入核对页。URI 没有进入导航参数或验收记录。                                                                                                                               |
| 电脑确认           | 保存后手机保持待确认；电脑端明确 `allow` 后才连接。[待确认画面](design/mobile-m0/original-pairing-pending.png)。确认前授予任务权限被真实 host 拒绝。                                                                                                                  |
| 任务授权隔离       | 设备确认后先显示空列表；仅授予一个任务 `view` 后该任务出现，其他测试任务仍不可见。[未授权空列表](design/mobile-m0/original-ungranted.png)。                                                                                                                           |
| 完整阅读           | 从长预览打开正文，读取第 1、2、3 段，验证上一段、回到开头、首段禁用上一段、末段禁用下一段。[首段](design/mobile-m0/original-reading-first.png)、[第二段](design/mobile-m0/original-reading-second.png)、[末段](design/mobile-m0/original-reading-last.png)。          |
| 原生复制与 Unicode | 在末段长按复制，原生剪贴板的 7,029 个字符与主机 `messages.content` 经同一分页规则得到的正文逐字符相等；首字符为完整 `🦉`，末段游标为空。没有仅凭截图推断正文完整性。                                                                                                  |
| 后台／前台         | Home 切后台，再直接激活已有 App；原生 PID 不变，任务历史恢复。[同一进程恢复](design/mobile-m0/original-background-restored.png)。                                                                                                                                     |
| 杀进程／重开       | 终止 App，再用 `pnpm dev:sim` 重开；确认原生 PID 更换，无需重新输入配对码，列表保留“返回正在查看的任务”，进入后原历史可读。[重开恢复](design/mobile-m0/original-process-restored.png)。此时首次配对码已过期，已确认设备仍可恢复。                                     |
| 断线               | 关闭桥接后正文标为“离线快照”，保留当前旧段、禁用翻段；不把旧状态标为在线。[离线正文](design/mobile-m0/original-reading-offline.png)。                                                                                                                                 |
| relay／host 重启   | 手机断线期间电脑修改任务标题，然后关闭并重启 relay、host；核实 host incarnation 已变化。手机重连后清除旧详情并返回任务，同一任务 ID `8b8eb563-88f0-47e0-9989-594220db6775`、新标题和 23,409 字符历史均保留。[主机恢复](design/mobile-m0/original-host-restored.png)。 |
| 手机存储           | 只读检查原生 SQLite：只有 `installation`、`intents` 两个表，WAL 模式；本场景 1 个 scope、1 条 `session.resume` 意图，没有正文表。未读取或导出系统 Keychain 凭据。                                                                                                     |

## 本轮修正

- 长消息预览收为 12 行，让“阅读全文”入口在任务页可见。[修正前](design/mobile-m0/original-long-before.png)、[修正后](design/mobile-m0/original-long-preview.png)。服务端预览和正文的字数限制没有变化。
- 翻段栏移出正文滚动区域，保留底部安全区；回到开头始终占位，避免翻段时按钮位置跳动。
- 换段时重建有界正文滚动视图，让系统处理原生顶部 inset，避免 `scrollTo(0)` 把标题、段号滚出视野。仍只保留当前段，没有积累分页历史或磁盘正文缓存。
- 当前任务失去查看权限后返回任务列表，避免留在没有任务的“正在恢复”页面。原生复测已显示空列表和无正文。

## 撤权清理

在正文阅读流程后，从真实 host 撤销该设备对当前任务的 `view` 授权；原生详情与历史清空，并返回 [未授权空列表](design/mobile-m0/original-task-unshared.png)。随后撤销整个测试设备，App 返回 [配对已撤销状态](design/mobile-m0/original-device-revoked.png)。

再次终止并重开 App，保持 [未配对状态](design/mobile-m0/original-revoked-relaunch.png)，没有自动恢复旧连接。原生 SQLite 中意图记录为 0，安装标记仍为 1，验证的是同一个安装而不是重装后的空数据。没有读取 Keychain 内容来证明这一点。

验收结束后已停止自有 fixture、relay、host 和临时通道，确认进程退出后删除本轮私有测试目录、临时 CA 和通道二进制；只清除已识别的测试剪贴板内容。原有模拟器、App 安装、Metro 和 `localhost:3200` 预览保留，App 处于未配对状态。DeviceHub 始终未运行。

## 复测操作

1. 日常入口仍为 `pnpm dev:sim`，只复用原有设备、开发客户端和预览。真实任务按 [移动端指南](mobile.md) 配置自有 relay 与查看授权。
2. Xcode 27 下无 DeviceHub 的安全输入方式：将配对文件复制到指定模拟器剪贴板，再在 App 输入框内长按，选择 iOS 的 Paste。不要将配对 URI 填入浏览器地址栏或直接作为命令参数：

   ```sh
   xcrun simctl pbcopy 498E27B7-5192-48CE-9B13-F4A27F10F806 < /你的私有目录/pairing.txt
   ```

   本次预览的批量键盘输入及 Cmd+V 没有可靠导入原生安全框，原生粘贴可用；不以开启 DeviceHub 作为解决方法。

3. 获取 `view` 授权，选择任务。长预览下打开全文，检查三段、前后翻段、回到开头及复制；断线时翻段应禁用，重连后重新打开正文。
4. Home 后可用下列命令激活同一个原生进程，测试正常前后台恢复；杀进程测试则先终止，再用 `pnpm dev:sim` 重开：

   ```sh
   xcrun simctl launch 498E27B7-5192-48CE-9B13-F4A27F10F806 dev.hikaro.mobile
   xcrun simctl terminate 498E27B7-5192-48CE-9B13-F4A27F10F806 dev.hikaro.mobile
   pnpm dev:sim
   ```

## 检查范围

本轮仅修改移动端 UI 和验收文档。`pnpm mobile:typecheck` 与 iOS／Android 生产 Hermes JS 导出通过；没有为纯布局变化增加重复单测，也没有重跑不受影响的全量测试或 TUI 基准。此前分页／controller 的 7 项定向测试属于上一轮证据，见 [长消息规格](specs/mobile-reading.md)。

原有性能、harness、授权、持久化和不可自动重放规则均保留。iOS／Android 真机、真实相机扫码、Android 原生运行、签名发布性能、30 分钟内存增长及移动网络切换继续待验收；本次模拟器开发构建不替代这些门槛。
