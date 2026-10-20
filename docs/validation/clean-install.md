# TUI 隔离源码安装验收 · 2026-10-20

本轮运行 `node scripts/check-install.mjs` 成功：

- Git 跟踪的当前源码复制到 `/tmp` 对应的系统临时目录，不带原工作区依赖和构建产物。
- `pnpm install --frozen-lockfile --filter hikaro` 成功，262 个依赖使用本机 pnpm 缓存重新安装；原生安装脚本成功。
- 临时源码中的 `pnpm typecheck`、`pnpm build` 成功。
- 使用新安装的 node-pty 启动新构建的 `dist/hikaro.mjs --demo --new`，独立 home 下显示 `/help`，Ctrl+D 后退出码 0。
- 最后删除临时源目录、依赖、构建及 demo 数据。

本轮只运行这一条受影响 PTY 脚本，没有全量测试或性能基准。环境为现有 macOS 开发机，pnpm 12.11.2。仍待：空缓存网络下载、干净机器工具链安装、正式发布包、跨版本升级回退、真实模型及物理终端验收。测试通过不能将这些剩余项标为完成。
