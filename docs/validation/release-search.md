# 搜索与图片导出候选

候选源码：`30f1db586b71395ebd89aafebb0cd4b5fc93f8b2`。

2026-10-22 [干净 macOS arm64 / Node 24.21.0 分发流水线](https://github.com/shqingda/hikaro/actions/runs/39630625398)成功。源码类型、安全补丁、空缓存安装、草稿恢复、host 崩溃后 steering 恢复与包内差异阅读全部通过。

下载 tarball SHA-256：`d52dab095dc182fc49c50a6b706953b5b2adcb59b3626c37ac98bc96e7874a79`，与 manifest、校验文件及安装报告一致，来源 commit 匹配且 dirty=false。

另在本机临时目录安装同一 tarball，通过 `HIKARO_TEST_BIN` 指定安装后的 CLI，复用 `tests/message-search-pty.test.ts` 两种终端场景：搜索预览范围之外的正文、打开并读取第二段末尾、退出；附着 host 另导出 100,003 字节图片，Markdown 相对引用及每字节一致性通过。源码客户端/SQLite 仅用于创建合成 fixture 和观察，应用进程全部来自安装包。

本候选包含 TUI 全文搜索、图片导出及前轮手机源码改动；CLI tarball 不包含移动原生安装包。源码定向验收见 message-search.md、export-images.md、mobile-search.md。本轮未重复运行真实订阅/网络故障矩阵；e0fb56a 的订阅证据不能记为此 SHA 的订阅通过。分发草稿仍保持旧候选，正式发布尚未执行。

移动原生验收环境核对：Metro 8081 和 serve-sim 3200 仍在运行；内置浏览器显示 App 处于未配对的连接页。前轮隔离环境目录已不存在，因此没有宣称新搜索的原生点击通过。
