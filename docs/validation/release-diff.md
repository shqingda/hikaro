# 新差异接口进入安装包 · 2026-10-21

现有 `check-release.mjs` 安装 E2E 增加差异验收；没有增加另一条 E2E。隔离数据目录写入前后快照 fixture，由安装后的 host 解析并分页读取，再由安装后的附着 TUI 打开同一记录并到达末页。源码仅提供 IPC 观察客户端，不导入源码 Runtime 或 diff 函数。验证 701 行中文/emoji、完整页游标、末尾无换行标记和阅读不改文件；原有草稿/steering 恢复与安全补丁验收继续运行。

- 旧 cf57c46 候选按预期失败：`Installed host must advertise changes.diff`。未修改旧报告。
- 本机 Node 26.12.0 新包第一次通过，SHA `c8a3d7ec39586c4fbe129f230fc75a394e5be8cddb658cb7283212857773a52f`；其 dirty 标记反映当时验收脚本尚未提交。
- [CI 39620050563](https://github.com/shqingda/hikaro/actions/runs/39620050563) 通过：干净 macOS arm64、最低 Node 24.21.0、空 pnpm store、生产安全检查、空 npm 缓存安装及同一安装 E2E。
- CI 来源 `e0fb56a958372703cd1ea72b78caeeeb1d594c2b`，manifest `dirty: false`。下载产物 SHA `01d0bd6c9fc45481bceb01a5db9e1472ad74a029436c347f1669fd8647dd7295`，与校验文件、manifest 和[安装报告](release-diff-install.json)全部一致。

新候选随后完成下列同包订阅复验。物理辅助技术与正式发布仍待完成。

## 同包订阅与草稿更新

对 CI 下载的同一 SHA 运行现有 `check-live-release.mjs`，正常订阅 OAuth 首次通过，无需 API Key。实际模型读文件、修改、执行测试与 diff 均成功；拒绝审批不产生目标文件，Ctrl+C 后真实 shell 退出且运行 cancelled；等待审批时 SIGKILL 后恢复为 unknown，未执行未批准命令，明确新请求能继续。

仅测试进程内注入断网、429、实际流中断和挂起取消，四类故障均可见终止、不自动重发，各自后续明确订阅请求成功。[同包报告](release-diff-subscription.json)的 SHA 与 CI 安装报告一致。没有重跑安装 E2E、全量测试或性能基准。

[分发草稿](https://github.com/shqingda/hikaro/releases/tag/untagged-21916d3e014efb690aca)更新到 e0fb56a，保持 draft。七份附件回下载后与已验证来源逐字节核对，tarball 校验和通过；旧候选和报告仍保留在本机原目录。完整成品待办没有随候选更新而关闭。
