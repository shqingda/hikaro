# 新差异接口进入安装包 · 2026-10-21

现有 `check-release.mjs` 安装 E2E 增加差异验收；没有增加另一条 E2E。隔离数据目录写入前后快照 fixture，由安装后的 host 解析并分页读取，再由安装后的附着 TUI 打开同一记录并到达末页。源码仅提供 IPC 观察客户端，不导入源码 Runtime 或 diff 函数。验证 701 行中文/emoji、完整页游标、末尾无换行标记和阅读不改文件；原有草稿/steering 恢复与安全补丁验收继续运行。

- 旧 cf57c46 候选按预期失败：`Installed host must advertise changes.diff`。未修改旧报告。
- 本机 Node 26.12.0 新包第一次通过，SHA `c8a3d7ec39586c4fbe129f230fc75a394e5be8cddb658cb7283212857773a52f`；其 dirty 标记反映当时验收脚本尚未提交。
- [CI 39620050563](https://github.com/shqingda/hikaro/actions/runs/39620050563) 通过：干净 macOS arm64、最低 Node 24.21.0、空 pnpm store、生产安全检查、空 npm 缓存安装及同一安装 E2E。
- CI 来源 `e0fb56a958372703cd1ea72b78caeeeb1d594c2b`，manifest `dirty: false`。下载产物 SHA `01d0bd6c9fc45481bceb01a5db9e1472ad74a029436c347f1669fd8647dd7295`，与校验文件、manifest 和[安装报告](release-diff-install.json)全部一致。

新候选尚未完成同包真实订阅复验，分发草稿继续保留已验证的 cf57c46；不得用旧订阅报告冒充新包证据。物理辅助技术与正式发布也仍待完成。发布准备估算保持 TUI 98%、移动端 65%。

## 手机键盘环境

用户确认 macOS 27 权限项显示为 Device Control and Data Access，并为启动应用授权。系统 TCC 日志将当前 serve-sim PID 77858 的键盘请求归属 `com.openai.codex`，对应 `/Applications/ChatGPT.app`，不是根据进程名称猜测 Node/Terminal。授权后通过 Codex 预览向原生配对输入框发送单个 `a`，原生 AX 显示一个字符；随后用 BackSpace 清除。没有提交该测试字符。

新日志不再报缺少权限，改为 Device Hub 未运行并回退 legacy HID。这只能证明本次单键通路，不能认定软件键盘、回车、多行编辑或中文 IME 已通过。用户要求节省剩余额度，本轮未为此重建完整配对 fixture 或重跑原生全流程。
