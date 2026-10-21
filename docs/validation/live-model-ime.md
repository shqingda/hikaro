# 真实模型与物理终端验收 · 2026-10-21

最新状态：源码 Runtime 基础闭环及[实际分发包订阅/恢复验收](live-release.md)通过。用户已确认第 1–4 项正常，并在 Ctrl+D 修复后确认第 5 项“草稿恢复正常”，见[五项物理终端记录](physical-terminal.md)。当前发布准备估算 TUI 98%、移动端 45%；本记录不构成 release 批准。文末的旧百分比属于当时记录。

## 当前证据

- 准备阶段类型检查和构建通过；本轮没有改动产品 TypeScript，两个验收脚本语法检查通过。
- 用户完成订阅登录后，正常 CredentialStore 成功读取 xAI OAuth 凭据，grok-4.7 实际执行任务。撤销此前错误的 API Key 前提，不把订阅令牌转成环境变量，不打印令牌。
- 桌面工具明确禁止控制 Ghostty。用户已同意在物理终端执行 IME 检查，当前等待结果。没有用 PTY 注入中文替代系统输入法候选状态验收。
- 不将仅有运行入口或配置记录计为验收通过。真实模型读取、编辑、执行测试、审阅 diff 及完成终态必须有实际事件证据。

## 物理终端 IME

```sh
cd /Users/shqingda/Projects/hikaro
node scripts/check-ime.mjs
```

脚本使用 artifacts 下独立目录、离线 demo 和新会话，不使用个人会话或模型凭据。退出后保留目录并打印恢复命令，以验证未发送草稿。

请记录 Ghostty 版本、输入法名称和每项通过/失败：

1. 打 `nihao`，输入法小框还列着汉字时，按回车结束选字：这一下不能同时发送消息。具体上屏的是汉字还是拼音由输入法决定；离开选字后，再按一次回车才发送。
2. 输入 `中文 abc 123 😀`，左右移动与退格删除，字符、光标和相邻字符均正常。
3. 粘贴两行文字，保留换行，不自动提交。
4. 缩窄窗口再恢复，输入内容、光标和界面正常。
5. 留下未发送的“草稿恢复测试”，Ctrl+D 退出，再执行脚本输出的恢复命令，草稿完整恢复。

## 真实模型

直接使用订阅登录，无需 API Key。先运行 `pnpm start`，输入 `/login`，选择 xAI 的 `Sign in with SuperGrok or X Premium`，按界面完成登录。已登录则直接执行验收命令。不要把登录令牌或授权回调发到聊天。

```sh
cd /Users/shqingda/Projects/hikaro
node --import tsx scripts/check-live-model.mjs
```

该命令通过已有订阅 OAuth 调用真实模型，不加入默认测试。复用正常 CredentialStore 的读取与刷新流程，不提取 OAuth access token 充当 API Key，不将令牌复制到环境变量或测试目录。本脚本验证源码 Runtime/provider 集成，不冒充已打包 CLI 验收。使用独立工作区和会话数据 home，要求模型修复小型加法 fixture，不修改测试，实际执行测试并查看 diff。脚本再次验证测试文件不变、测试结果正确、实际工具事件和 run.end=completed，报告保留在 artifacts/live-model-*/report.json。模型调用超时为 120 秒；失败不保存子进程错误原文，避免错误对象包含环境凭据。

即使此闭环通过，也不代表真实模型的拒绝、断网、限流、取消和 host 重启全部完成；这些需另有证据。IME 入口仅通过语法检查，不据此宣称物理终端验收通过。

## 本轮实测结果

正常路径记录：[订阅模型报告](live-model-subscription.json)。2026-10-21T10:08:17Z 至 10:08:25Z，xai/grok-4.7 通过现有 OAuth 登录完成 5 次工具调用：read_file ×2、edit_file、shell、git_diff。全部无错误，run.end=completed。模型实际执行 `node --test sum.test.cjs` 成功，验收脚本再次独立运行同一测试；测试源码和 package.json 保持原样，只有 sum.cjs 改动，没有额外未跟踪文件。

首次运行也完成闭环，但暴露了测试项目缺少 package.json 的问题：Node 向上查找父项目配置，被工作区沙箱正确拒绝。模型请求越权运行仍被拒绝，随后在测试目录补配置并成功执行测试。保留 [首次运行记录](live-model-recovery.json)，不将其包装为零错误路径。验收 fixture 现已包含自己的 package.json，并断言模型没有修改它；修正后再跑得到上述正常结果，没有放宽沙箱。

报告中的 usage.cost 来自 provider catalog 的估计值，不是订阅账单或实际扣款。本轮验证的是源码 Runtime、实际 provider OAuth 和工作区工具闭环；不声称已完成打包 CLI 的订阅登录、实际终端 IME、真实断网/限流/取消/重启全场景或正式分发验收。进度维持 TUI 94%、移动端 35%。
