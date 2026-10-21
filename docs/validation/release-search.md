# 搜索与图片导出候选

候选源码：`30f1db586b71395ebd89aafebb0cd4b5fc93f8b2`。

2026-10-22 [干净 macOS arm64 / Node 24.21.0 分发流水线](https://github.com/shqingda/hikaro/actions/runs/39630625398)成功。源码类型、安全补丁、空缓存安装、草稿恢复、host 崩溃后 steering 恢复与包内差异阅读全部通过。

下载 tarball SHA-256：`d52dab095dc182fc49c50a6b706953b5b2adcb59b3626c37ac98bc96e7874a79`，与 manifest、校验文件及安装报告一致，来源 commit 匹配且 dirty=false。

另在本机临时目录安装同一 tarball，通过 `HIKARO_TEST_BIN` 指定安装后的 CLI，复用 `tests/message-search-pty.test.ts` 两种终端场景：搜索预览范围之外的正文、打开并读取第二段末尾、退出；附着 host 另导出 100,003 字节图片，Markdown 相对引用及每字节一致性通过。源码客户端/SQLite 仅用于创建合成 fixture 和观察，应用进程全部来自安装包。

本候选包含 TUI 全文搜索、图片导出及前轮手机源码改动；CLI tarball 不包含移动原生安装包。源码定向验收见 message-search.md、export-images.md、mobile-search.md。

同一安装包通过一次真实 xAI/grok-4.7 订阅请求：使用既有 OAuth，子进程删除 XAI_API_KEY，仅回复固定标记、不调用工具；返回精确标记、退出 0、stderr 为空。见 [结构化报告](release-search-subscription.json)。没有重复运行完整网络故障矩阵，也不将旧候选的结果记为此 SHA 通过。

移动原生验收环境核对：Metro 8081 和 serve-sim 3200 仍在运行；内置浏览器显示 App 处于未配对的连接页。前轮隔离环境目录已不存在，因此没有宣称新搜索的原生点击通过。

分发草稿现已更新到 30f1db5，仍为 draft。7 个附件回下载后与本机已验收文件逐字节一致；说明明确本次为最小订阅验证，未标称完整故障矩阵或移动原生发布。

2026-10-22 00:10（台北）发布为 [v0.1.0 自用预览版](https://github.com/shqingda/hikaro/releases/tag/v0.1.0)：isDraft=false、isPrerelease=true，远程 tag 确认为 30f1db5，7 个附件保留。此发布不关闭完整产品目标，也不代表移动端已发布。
