# 附着导航与设置验收 · 2026-10-19

独立分支 `codex/tui-review-rollback`，工作区 `/Users/shqingda/.codex/worktrees/tui-review-rollback/hikaro`。未修改移动端工作目录；未合并、推送或改变主目录分支。

## 已交付的用户路径

- 会话选择：复用普通 TUI 搜索/分页/改名/删除确认界面，从 `/sessions` 或无参数 `/resume` 进入。当前会话删除后创建新会话。RPC 完成后先完成历史刷新，再呈现操作结果，防止确认提示被旧历史加载覆盖。
- 登录与模型：复用已有 provider/API-key/OAuth 选择器与秘密输入处理。附着进程使用同一 home 的本机系统钥匙串；秘密不成为 RPC 参数或持久回执内容。登录后通知 host 失效凭据索引和目录缓存，再选模型。模型选择失败会显示错误，不假称成功。
- 设置：active/default 明确区分，host 校验能力；修改默认值不会先切换当前会话。显示与启动偏好按 workspace/client identity 保存在私有目录，重开恢复；非法偏好会明确报错并关闭连接。全工作区权限由 host 修改，保留运行中拒绝和本机 owner 限制。
- 资源：搜索/分页并查看已加载 Skill 描述/路径、指令路径、工具描述及插件入口支持状态。分页受条数和字节量约束；前后页使用真实偏移记录。目录不执行第三方代码，不伪称支持插件安装、热加载或 MCP 连接管理。
- 配置面板打开时后台计划轮询让出焦点；同步快照不再误关配置面板，真正断线会关闭；迟到回复按连接代次丢弃。

## 定向证据

共 51 项不同测试分别通过。只运行本轮的一个 PTY 脚本，未运行其他 PTY、全量测试、性能基准。

| 文件 / 过滤器                   | 数量 | 验证                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attached-navigation-pty.test.ts |    1 | 独立 host＋真实附着终端。53 个预建会话中搜索旧会话；改名、切换；模型选择；active 16k/default 32k 分别持久化；thinking/speed；权限修改；显示偏好重开恢复；当前会话标记证明恢复；再切换为“新会话启动”并重开核对新增会话；资源详情；真实秘密输入取消不回显；取消删除保留、确认删除生效。 |
| attached-navigation.test.ts     |    3 | 默认设置不改当前会话，超限值拒绝，新会话继承默认；host 资源/权限/目录刷新；真实 ModelPanel＋ProviderCatalog SDK API-key 登录保存至 InMemoryCredentialStore（仅屏蔽网络模型刷新），取消替换保留旧凭据；记录 RPC 帧确认无密钥；不同视图偏好隔离；断线迟到回复不打开面板。               |
| session-settings.test.ts        |   19 | 普通 TUI 的会话/设置/默认值/启动选择/删除/导出回归。                                                                                                                                                                                                                                  |
| session-search.test.ts          |    4 | 跨页、Unicode 搜索、查询期间禁用过期选择。                                                                                                                                                                                                                                            |
| client-core.test.ts             |   15 | 快照、同步代次、回执、版本协商与断线不重放。                                                                                                                                                                                                                                          |
| attached-workflows.test.ts      |    3 | 上轮核心工作流的快照/问题/暂停、版本与回执、迟到回复边界。                                                                                                                                                                                                                            |
| rpc-library.test.ts             |    1 | 原有库请求分页、内容、工件和端点边界。                                                                                                                                                                                                                                                |
| model-picker.test.ts 名称过滤   |    4 | 无秘密浏览、秘密输入隐藏、支持的认证方式、按键事件；排除该文件内旧 PTY。                                                                                                                                                                                                              |
| shared-host.test.ts 首场景      |    1 | 真实 IPC＋加密 adapter 的授权、审批与撤销；新增 owner-only 配置请求的远程拒绝。                                                                                                                                                                                                       |
| 类型检查 / 构建 / diff 空白检查 |    — | 通过。                                                                                                                                                                                                                                                                                |

命令使用已安装依赖：

```sh
node node_modules/vitest/vitest.mjs run tests/attached-navigation.test.ts tests/attached-navigation-pty.test.ts
node node_modules/vitest/vitest.mjs run tests/session-settings.test.ts tests/session-search.test.ts tests/client-core.test.ts tests/rpc-library.test.ts tests/attached-workflows.test.ts
node node_modules/vitest/vitest.mjs run tests/model-picker.test.ts -t 'browses models|renders picker|uses supported|moves one row'
node node_modules/vitest/vitest.mjs run tests/shared-host.test.ts -t 'shares one run and explicitly owned approvals'
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
```

## 排查记录

初始新增测试因缺少配置方法按预期失败，再接通实现。首次 PTY 卡在会话切换确认：实际选择已改变，但异步历史刷新清除了提示。修复为等待刷新后显示结果，同一脚本通过。

后续审阅中资源分页的修改误进入模型分页，类型检查和 PTY 同时捕获未定义变量；已定点修复。扩展启动恢复断言最初依赖已被用户设置隐藏的页脚，改为打开会话选择器核对当前行标记；仍检查持久偏好、实际选中会话及新会话数量，没有删去验收目标或延长超时。

普通选择器新增加载反馈后，两处旧测试替身缺少 progress 方法；补齐替身能力，原删除确认/分页断言保留。授权回归按不同拒绝层分别断言明确错误：会话级拒绝与 host 本机 owner 限制，不放宽为任意错误。类型检查同时促使快照契约显式保留可选模型标识，旧快照仍可解析。

## 限制

真实外部账号登录、OAuth 回调、原生钥匙串授权提示未验收；认证成功的测试使用 SDK 流程及隔离内存存储，没有写真实账号。网络模型调用及多进程长时间竞争、真实输入法、性能未测。

资源目录只提供已加载元信息，不读取完整 Skill 正文；插件命令/视图执行、手动 `!`、附着导出、资源安装/热加载和 MCP 管理继续待办。模型设置菜单依据已有目录能力，自定义 provider 未提供能力时会显示错误；附着数值快捷语法尚未实现。显示偏好属于单个附着身份，模型默认和权限属于 host，不是跨设备配置同步。
