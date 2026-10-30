# 附着扩展与恢复首切片 · 2026-10-19

分支 `codex/tui-review-rollback`，独立工作目录 `/Users/shqingda/.codex/worktrees/tui-review-rollback/hikaro`。

## 界面验收

只扩展并运行 `attached-navigation-pty.test.ts` 这一条 PTY 脚本，保留之前导航、设置、登录取消、启动恢复及删除断言。

新增真实独立 host + 附着终端路径：直接插件命令、插件选择器搜索视图/确认/分页结果；手动 shell 批准后完成、拒绝后文件不存在、取消后 host busy=false；导出文件实际包含手动工具及插件结果；恢复面板查 completed 并打开原会话；重开加载持久未决 ID，查不到回执时保持 unknown，不自动发送原命令。

`attached-extensions.test.ts` 使用真实 host/IPC/SQLite 和隔离可信插件：调用命令/视图；导出实际内容；手动操作期间同客户端执行管理读取不阻塞；取消后终态；同一身份同一命令 ID 在执行后及 host 重启后均只产生一次文件副作用；插件结果重启后仍可导出；Plan 拒绝插件、手动写入未产生文件。

## 定向检查

- attached-extensions：1 项。
- attached-navigation-pty：1 项（本轮唯一 PTY 脚本）。
- attached-navigation：3 项。
- execution-queue：1 项。
- rpc-receipts：2 项。
- lease-fencing：只选 `attaches its lease`、`stops before a tool side effect`，2 项。
- core：只选 `resumes prompts queued during a manual tool operation`，1 项。

合计 12 项不同测试；类型检查、构建及 diff 空白检查。未执行全量测试、其他 PTY 或性能基准。

## 排查与边界

新增接口测试先因方法未定义失败。首次类型检查捕获面板 prompt 参数类型、可选命令名和 RuntimeOptions 字段拼写，定点修正。

扩展重启测试最初未指定 clientId，重连得到新身份，与按身份隔离回执的契约不符；修正为同一显式身份，保持同 ID 不重复副作用断言。取消测试最初使用默认 1 秒等待，而现有进程树回收固定包含 1 秒升级窗口；改用同一 PTY 已有的 8 秒状态等待，保留真实退出断言，未改变产品回收策略、原脚本 45 秒总超时或既有验收断言。

插件命令和视图沿用已有可信代码接口。它们没有取消信号协议；Esc 只关闭面板，超时不意味着停止。调用期间续期会话租约，结果写入会话历史后返回；显示预览最多 60k 字符，完整文本在历史/导出中。极大插件结果及恶意可信插件不是本轮验收范围，目录超过 256 KB 会明确拒绝而不是撑破 RPC 帧。

恢复本轮交付是“回执核对＋结果留存”，不是自动恢复执行。未决 ID 可跨视图重开保存；已完成回执不是完整跨重启历史索引。待发消息、未答问题跨 host 崩溃恢复、图片附件打包导出、真实第三方插件长期兼容仍待办。恢复 PTY 的缺失回执由隔离持久意图 fixture 构造；host 重启防重放是实际重启测试，不宣称完成断电或任意崩溃时点证明。

## 合并前 CI 修复 · 2026-10-19

首次跨平台 CI 捕获 Linux 不支持 macOS 沙箱，以及普通 `/changes` 在 run.end 到达界面后、租约清理尚未完成时的竞态。为普通/附着 `!` 增加显式 `--unrestricted` 标志，默认仍使用沙箱，所有无限制调用继续走原审批。RPC 对应字段严格布尔校验。

附着 PTY 的三条命令显式请求 unrestricted，保留批准/拒绝/取消、文件不存在与实际终态的原断言。隔离 host 集成 fixture 明确配置 Full Access，避免等待不存在的交互审批；Plan 仍必须阻止手动写入。未跳过 Linux 测试，也未放宽权限默认值或测试超时。

普通 `/changes` 仅对已结束运行等待清理 promise，仍拒绝进行中的运行；原 PTY 增加等待实际可输入页脚，保留全文差异、取消确认和真实回退断言。本次本地只运行该受影响 PTY；附着 PTY 由现有 CI 验证。手动命令标志解析、host 集成与变更审阅 PTY 各 1 项定向检查通过，原有测试数量不受影响。

排查中一次入口 import 放在 shebang 之前被类型检查拦截并修正；一次集成测试因无限制命令等待人工审批超时，改为上述显式权限 fixture 后通过，原 5 秒超时保持不变。
