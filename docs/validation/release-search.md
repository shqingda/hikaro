# 搜索与图片导出候选

候选源码：`30f1db586b71395ebd89aafebb0cd4b5fc93f8b2`。

2026-10-21 已触发 [干净 macOS arm64 / Node 24.21.0 分发流水线](https://github.com/shqingda/hikaro/actions/runs/39630625398)。当前运行中，尚未取得新包及安装结果，不替换已验收的 e0fb56a 分发草稿附件。

本候选包含 TUI 全文搜索、图片导出及前轮手机源码改动；CLI tarball 不包含移动原生安装包。源码定向验收见 message-search.md、export-images.md、mobile-search.md。取得新包后需核对来源与 SHA，再完成新增能力的包内检查；正式发布仍未执行。

移动原生验收环境核对：Metro 8081 和 serve-sim 3200 仍在运行；内置浏览器显示 App 处于未配对的连接页。前轮隔离环境目录已不存在，因此没有宣称新搜索的原生点击通过。
