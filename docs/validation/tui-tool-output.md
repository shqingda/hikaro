# TUI 工具输出分段阅读 · 2026-10-23

## 已交付

普通与附着 TUI 的工具详情不再只显示前 3,000 字符。历史结果、实时工具结果和手动工具结果使用同一个纯文本阅读组件，保留工具名称、失败标记、代码符号和终端控制过滤。长结果显示消息编号及分段数，使用 `/read MESSAGE PART` 查看指定部分，每次渲染最多 16,000 字符正文。

附着历史的 `messages.read` 返回 20,000 字符预览和原始长度。现在按真实长度显示分段数，只在用户阅读时按原会话和事件序号请求 `messages.content` 的一个 16,000 字符片段；保留一个已读取片段，不预取整条历史。普通用户和助手消息也复用这一读取路径。会话或连接代次变化时拒绝迟到结果；连续选择多个片段时较早的响应不能覆盖后来选中的片段。读取失败保留当前可读内容并显示错误。

超长工具结果若已被执行层截断，界面保留截断说明及完整结果文件路径。附着实时事件单独携带的 artifact 路径也显示出来，避免结果文本预览丢掉末尾路径。没有把执行层截断的文本误称为完整原始输出。

## 验证

本切片共 43 项定向测试通过；类型检查、构建和差异空白检查通过。

- `tui-tool-output.test.ts`：7 项。历史、实时和手动工具的有界分页；失败标记与隐藏详情；原始纯文本；远程读取精确偏移和长度；较早响应迟到；读取失败保留原页；分离的完整结果文件路径。
- `tui-tool-output-pty.test.ts`：2 项。构建产物的普通 TUI 和独立 host＋附着 TUI，开启工具详情，从真实 `/read 1 2` 入口读到超过 20,000 字符之后的完整结果路径，再回到第一段，并正常退出。
- `tui-interactions.test.ts`、`tui-text.test.ts`、`model-settings.test.ts`：32 项既有交互、控制字符、消息样式回归。
- `message-search-pty.test.ts`：2 项既有普通与附着全文搜索、分段读取回归。

执行命令：

```sh
node node_modules/vitest/vitest.mjs run tests/tui-tool-output.test.ts tests/tui-interactions.test.ts tests/tui-text.test.ts tests/model-settings.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
node node_modules/vitest/vitest.mjs run tests/tui-tool-output-pty.test.ts tests/message-search-pty.test.ts
git diff --check
```

## 失败与修复证据

首轮 4 项新回归全部失败，分别暴露历史和实时输出没有分页、手动输出没有渲染上限、历史失败标记缺失；修改后通过。

首轮附着 PTY 没有开启附着视图独立保存的工具详情，修正测试为实际输入 `/tools`、`/latest`。随后 PTY 在第二段找不到完整结果路径，证实附着端把 20,000 字符预览当作全文。接入按需 `messages.content` 后，同一普通和附着脚本通过，没有放宽断言或超时。

完整结果路径单独来自事件 metadata 的新增用例也先失败，补全该路径展示后通过。

## 边界

PTY 使用预置 SQLite 工具结果和离线主机，证明构建产物的真实终端入口与消息读取协议，不代表真实模型、物理终端、中文 IME 或辅助技术验收。结果文件路径可见，但本切片没有增加文件浏览器。执行层原有截断与存储策略、完整后台执行历史、插件取消、大输出持续内存和性能门槛保持独立验收。
