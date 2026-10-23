# iOS 原生搜索与历史缓存验收 · 2026-10-23

环境：原有 iPhone 18 Pro / iOS 27 模拟器，UDID `498E27B7-5192-48CE-9B13-F4A27F10F806`，hikaro 0.1.0 (1) 开发构建，当前 Metro 源码。浏览器预览仍为 localhost:3200，serve-sim 0.1.48。独立临时 home/workspace、demo host、真实 shared host RPC 和端到端加密连接；没有真实模型请求或用户生产任务。

## 已验证

1. 输入完整配对码，原生页面核对 relay、主机 ID 和公钥后保存；电脑确认设备并只授予测试任务 view 权限。任务列表与任务内容正常显示。
2. 通过正常 RPC 写入 24,029 UTF-16 单元的合成用户消息，`seq=14`。前 24,000 单元为重复正文，唯一尾部为 `nativeendmark20261023中文🌅搜索尾标`。回显取消后确认 host 不忙，不将合成运行记为模型完成。
3. 原生搜索 `mark` 命中唯一尾部结果。点击结果打开正文，顺序读取第 1、2、3 段；最后一段的下一段按钮禁用，滚至末尾看到完整英文、中文和 emoji。搜索 `zzzz` 明确显示没有匹配消息。
4. 在线读取后 SQLite 有 1 页历史快照。原生输入草稿 `note`，界面显示本机已保存，SQLite 草稿文本逐字匹配。该设备只有 view 权限，发送保持禁用。
5. 断开隔离主机后原生页面保留历史和草稿，明确标注离线；不自动发送。重新启动应用进程后仍可从“查看上次任务与草稿”进入，恢复缓存历史与同一草稿。
6. 离线点击清除缓存：成功提示出现、历史消失，SQLite 快照由 1 变 0，草稿仍为 1 条且 `note` 不变。再次重开进程，入口变为“继续编辑本机草稿”，无历史缓存，草稿仍在。
7. 重新联网并显式打开任务后，SQLite 再次出现 1 页历史缓存，草稿不变。再次断网并更换进程后，入口重新显示“查看上次任务与草稿”，历史与草稿均恢复；只读 SQLite 确认仍为 1 页缓存、1 条未变草稿。

## 本轮界面修正

- 搜索框显式设置 `autoCorrect={false}`、`autoCapitalize="none"`，保留默认键盘和原样输入回调，避免产品主动要求纠词或大写。配置语义见 [React Native TextInput](https://reactnative.dev/docs/textinput)。这不等于所有桥接输入问题已经修复。
- 离线无缓存时显示“本机没有缓存的消息。连接电脑后可重新读取。”在线空任务和未选任务保持原提示。缓存清除不应误称电脑上的任务没有消息。
- 两处小改经过独立只读审查，无阻断；移动类型检查和 iOS/Android Hermes 导出通过。无需为文案和两个原生属性增加复述实现的测试。

## 输入与测试设施边界

模拟相机显示合成二维码，但未触发扫码回调，因此不算扫码通过。浏览器粘贴没有可靠进入原生字段。逐键 `colon` 在本次桥接中产生分号；用临时、无凭据的长度/协议前缀诊断定位后，显式 `shift+semicolon`、`shift+3`、`shift+5` 等正确输入完整配对码。临时诊断已全部移除。

长串搜索词在可见中文输入候选状态下发生分词、改写及数字缺失；关闭自动更正后仍不能据此判定问题已解决。`mark` 和 `zzzz` 的实际搜索通过。没有更改系统输入法，不把此证据扩写为长串高速输入、完整中文 IME 或软件键盘验收。安全输入成功不能排除 React Native 控件、系统输入预测和桥接时序之间的差异。

原生进程重开使用 serve-sim 相机测试 UI 的重新启动应用行为；通过只读进程列表确认 PID 30341 → 60492 → 62839 → 65781。不是浏览器重载或仅切后台。测试 helper 回到 Ready，未留下活动模拟相机流。不同 PID 证明进程更替，不宣称系统崩溃、内存压力或真实设备强杀等价性。

临时 Cloudflare 通道仅连接隔离测试 host，origin 继续验证私有 CA，没有安装系统 CA 或关闭 TLS 校验。cloudflared 2026.10.1 来自官方 GitHub Release：下载包 SHA-256 `647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc` 与官方 API 资产 digest、19,807,806 字节一致；解压后的二进制 SHA-256 `35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9` 与发布说明摘要一致。初始把发布说明摘要用于压缩包校验时失败并停止，确认两个文件的摘要口径后才执行。

## 截图

- [长正文尾部搜索](../design/mobile-search-cache/tail-search.png)
- [最后一段的完整尾部](../design/mobile-search-cache/full-body-tail.png)
- [没有匹配消息](../design/mobile-search-cache/no-results.png)
- [离线草稿](../design/mobile-search-cache/offline-draft.png)
- [进程重开后的离线快照](../design/mobile-search-cache/offline-restored.png)
- [清理反馈](../design/mobile-search-cache/cache-cleared.png)
- [清理后重开，保留草稿且无缓存](../design/mobile-search-cache/cleared-after-reopen.png)
- [重新读取后再离线重开](../design/mobile-search-cache/recached-after-reopen.png)

## 清理

测试结束后主机撤销设备；手机再次连接时显示“配对已撤销或失效”，返回配对入口。本机 SQLite 历史快照和草稿均为 0 条。未读取 SecureStore 内容。隔离 host 正常退出，cloudflared 收到终止信号后报告 tunnel/metrics 已停止；私有测试目录及临时凭据、CA、下载文件已删除，测试剪贴板已清空。保留原模拟器、安装、Metro 和 localhost:3200 预览。没有创建模拟器或修改系统 CA。

[撤销后的原生页面](../design/mobile-search-cache/revoked-cleaned.png)。

## 仍待完成

Android/真机运行、真实相机、生产 relay 与通知、系统网络/锁屏、VoiceOver/TalkBack、大字、高速输入和 Release 性能窗口均不由本轮模拟器证据覆盖。最新 APK 是否包含本轮两处 UI 修改须单独记录，不能沿用旧候选的源码一致性声明。
