# TUI 源码安装与升级

当前支持源码安装，并提供本地 macOS arm64 npm tarball 候选包流程；尚未公开发布或完成签名/公证。需要 Node 24.21+、pnpm 12.11.2、rg 和 Xcode Command Line Tools。浏览器功能另需 Playwright Chromium；离线 demo 不验证真实模型凭据。

## 安装

在所选版本的源码目录运行：

```sh
pnpm install --frozen-lockfile --filter hikaro
pnpm build
pnpm start --demo
```

`--filter hikaro` 安装根目录 TUI 所需依赖，避免为 TUI 安装移动应用开发依赖。不要单独拷贝 `dist/hikaro.mjs`：运行还依赖同目录生成的 chunks、worker、原生助手及安装后的外部依赖。不要跨平台或架构复制原生构建产物。

退出后去掉 `--demo` 配置真实模型。共享 host 的启动、附着和数据目录规则见 [共享主机](shared-host.md)。

## 升级与回退

1. 记录当前 Git commit、Node/pnpm 版本及实际 `--home` 数据目录（默认 `~/.hikaro`）。先结束当前任务和后台终端，再关闭所有使用此目录的独立 TUI、host、桥接及客户端。
2. 在所有写入者退出后备份完整数据目录，包含 SQLite 数据库及其附属文件。运行中的数据库不能用普通文件复制当作一致性备份。凭据可能在系统 Keychain，数据目录副本不能代替凭据迁移。
3. 在另一目录检出待升级的明确 commit，按上面步骤重新安装和构建。先用独立临时 `--home` 做 demo 验证，再使用正式数据目录。
4. 验证会话历史、待恢复消息和未答问题；恢复需要明确确认，不应自动重放任务。
5. 若需回退，先停止新版本的全部写入者，再使用旧版本源码重新安装构建，并恢复升级前的数据目录备份。**不保证旧版本能直接读取新版本写入的数据。** 保留升级后的副本供排查；恢复旧备份不会保留升级后的新任务记录。

这是一套操作约束，不代表跨版本数据兼容、正式升级/回退或真实账号验证已经通过。

## 可重复的隔离验收

```sh
pnpm check:install
```

脚本将 Git 跟踪文件的当前工作区内容复制到系统临时目录，使用锁文件安装 TUI 依赖，运行类型检查与构建，再用该目录自己的 node-pty 启动构建后的离线 TUI，等待欢迎入口后 Ctrl+D 退出。成功或失败后清理临时目录。新文件需先纳入 Git；脚本不包含未跟踪文件，也不验证已推送远程内容。

它不复用原工作区 node_modules、dist、原生助手或个人数据目录，但可能复用本机 pnpm 包缓存和编译工具。它不是空缓存下载验收、性能基准、真实模型测试或完整升级测试。命令按需运行，不加入每次普通测试的默认流程。

## 指定旧版本的升级与备份回退验收

```sh
pnpm build
pnpm check:upgrade 3a7bc2b
```

脚本把指定 Git commit 导出到临时目录、按其锁文件安装并构建，用旧 CLI 离线执行生成历史，添加未发送草稿后关闭所有数据库连接并备份。当前构建读取旧数据并继续执行，核对历史、模型设置、草稿、恢复表及 SQLite 完整性；随后将备份复制到另一数据目录，用旧 CLI 继续执行，确认新版写入未进入回退数据。临时目录最终清理，不接触个人数据。

2026-10-20 已验证 `3a7bc2b` → 当前候选版本 → 升级前备份 + `3a7bc2b`。这不保证任意旧版、Keychain 迁移、运行中备份、直接用旧程序读取新库或用户最新任务无损回退。仍以停止所有写入者和恢复完整备份为回退前提。


## macOS arm64 候选分发包

维护者运行 `pnpm release:pack`，从当前源码重新构建，生成 `artifacts/release/hikaro-0.1.0-darwin-arm64.tgz`、SHA-256 文件及 manifest。包包含 CLI/chunks/workers、已编译文件操作 helper、生产依赖的 npm-shrinkwrap 锁文件，以及带安全回移补丁的 sandbox-runtime/node-forge 依赖树，不包含移动端、开发依赖或个人数据。依赖仍需联网下载，这不是内含 Node 的单文件离线程序。候选保留 private=true 防止误发布到 registry；只允许当前已验证的 darwin-arm64 构建目标。

用户在自己的安装目录安装：

```sh
shasum -a 256 -c hikaro-0.1.0-darwin-arm64.tgz.sha256
npm install --engine-strict --prefix "$HOME/.local/share/hikaro-app" ./hikaro-0.1.0-darwin-arm64.tgz
"$HOME/.local/share/hikaro-app/node_modules/.bin/hikaro" --demo
```

需要 Node 24.21+ 和 npm、rg；最低版本验收使用 Node 24.21.0。若 npm 提示安装脚本审批，检查并按其提示批准需要的原生依赖脚本。未覆盖的 Node 版本、无开发工具的全新机器、Gatekeeper 隔离属性及签名/公证尚需验收。SHA-256 用于检测内容变化，不提供发布者身份认证；只使用可信渠道获得的包与校验值。

运行 `pnpm check:release artifacts/release/hikaro-0.1.0-darwin-arm64.tgz` 验收实际 tarball：独立安装前缀、空 npm 缓存、校验和、实际 bin 离线任务、已打包原生 helper 读取、由安装目录自己的 node-pty 启动 TUI 并正常退出。输出同名 `.validation.json`，不复用工作区 node_modules，不接触用户 home。构建或 README 改变后需重新打包并验收对应 SHA，旧验证不能覆盖新包。

升级先停止所有写入者并备份数据，再将新包安装到另一个目录验证；回退切回保留的旧安装目录并恢复升级前数据备份。删除安装目录不会自动删除用户数据；切勿将数据 home 放在安装目录内。

## 候选包安全检查

`pnpm audit:release ARTIFACT.tgz` 检查包内生产锁及实际捆绑的 node-forge Node 实现，结果绑定 SHA；`release:pack` 在打包前和打包后均执行检查。无法取得有效审计结果、未修复的 high/critical、新公告或补丁哈希不符都会阻断。

node-forge 1.4.0 使用固定的上游 PR #1152 安全回移，版本号不变。源码通过 pnpm patchedDependencies 安装；候选包直接携带相同的 49 个 Node 源文件，安装时不需要再执行补丁。TUI 包不包含未修复的浏览器/Flash 预编译文件。原始 registry audit 仍显示该版本命中的 2 个 high 依赖节点（同一公告）；报告明确区分 `registryPassed: false` 与经过完整文件哈希核验的 `remediations`，没有忽略列表或降低审计级别。换版本或出现新公告必须重新评估。

安装验收还会从安装目录实际解析 forge，验证源码一致性并运行 8 组正常/畸形签名回归。该补丁只覆盖此公告的 Node 实现，不代表移动端、浏览器 bundle 或所有发布门槛通过。见 [安全回移验收](validation/forge-backport.md)。
