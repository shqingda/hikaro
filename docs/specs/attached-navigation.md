# 附着 TUI：会话、登录、模型、设置与资源

独立分支 codex/tui-review-rollback；完成条件是从附着终端选择、提交、取消、查看结果及重开恢复，不以接口存在代替验收。

- `/sessions [query]`、无参数 `/resume`：复用会话搜索/分页/重命名/删除确认面板；切换前保存本视图草稿，删除当前会话后创建新会话。列表查询限定 host 工作区。
- `/model`、`/login`：复用普通 TUI 模型与 provider 登录面板。附着为同机本地 owner；登录在本机使用同一 home 和系统钥匙串，OAuth 浏览器/密钥输入与取消沿用现有流程。秘密不进入 RPC、回执、日志。登录后让 host 重新加载目录与凭据索引再选择模型。实际外部账号验收另列。
- `/context`、`/thinking`、`/speed`：复用能力感知面板；区分本会话与新会话默认值，不能为了保存默认而改变当前会话。host 再次校验能力、会话与权限。
- `/settings`：显示偏好按 workspace/client identity 保存，重开生效；启动选择遵守显式 --new/--session，然后本视图偏好。`/permissions` 修改 host 工作区权限，只允许本机 owner，运行中拒绝。
- `/resources`：可搜索的 host 资源目录和详情，显示已加载 Skill/指令文件/工具/插件入口及支持边界。目录不执行插件代码，不冒充安装或热加载功能。
- 后台计划/提问轮询让出配置面板；真正断线关闭面板，迟到请求不得跨会话操作。RPC 同 ID 不自动重放，模型/默认操作分别反馈成功与失败。

验证：新增 tests/attached-navigation.test.ts（host 端能力/权限/默认值边界、配置与登录面板）；tests/attached-navigation-pty.test.ts 是本轮唯一 E2E，独立 host＋附着 PTY，覆盖会话搜索/改名/删除、模型与设置持久化、资源详情和登录取消。成功认证使用现有 auth interaction 的隔离 fixture，从面板输入到保存与 host reload 验证，不写真实账号。相关普通选择器单元回归采用名称过滤排除其他 PTY。类型检查、构建；不跑全量或基准。

## 后续范围扩展（2026-10-19）

上述首切片的插件执行/导出排除项已由后续交付接入：`/plugins` 搜索、参数、确认与文本结果；直接 `/插件名 参数`；`!COMMAND` host 审批及取消；`/export` Markdown 文件。`/recovery` 提供本视图回执核对与原会话结果入口，不自动重发。详见 [扩展与恢复验收](../validation/attached-extensions.md)。插件取消协议、队列/未答问题崩溃恢复仍不在已交付范围。
