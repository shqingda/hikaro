# TUI 消息全文检索

2026-10-21。`/search [TEXT]` 在普通与附着 TUI 中搜索当前会话完整正文；省略关键词时打开输入框。匹配按字面子串处理（中文可用、ASCII 忽略大小写），不是正则或跨会话搜索。

SQLite 返回每页最多 20 个结果和每项 240 字符摘要，RPC 上限 50 项；不会返回 providerData。结果支持前后分页，打开原文后按 16,000 字符分段读取，Esc 返回。旧 host 不支持时明确要求升级。

验证：
- `pnpm typecheck`、`pnpm build` 通过。
- `tests/core.test.ts` 的全文搜索用例验证预览外命中、中文/字面通配符、分页、会话隔离及有界输出。
- `tests/rpc-library.test.ts` 通过，验证 RPC 搜索及正文分段读取。
- `tests/message-search-pty.test.ts` 两项通过：实际构建产物的普通/附着 TUI 搜索 20,000 字符预览之外的消息，打开原文、切到第二段并滚动到命中位置，Esc 返回，Ctrl+D 正常退出。
