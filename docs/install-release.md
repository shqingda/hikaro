# TUI 安装与升级

## 一行安装（macOS Apple Silicon）

```sh
curl -fsSL https://github.com/shqingda/hikaro/releases/latest/download/install.sh | sh
```

安装包自带 Node.js 26.12.1 运行时，不需要预装 Node、npm 或 sudo。程序装在 `~/.local/share/hikaro`，命令 `hikaro` 和简写 `hk` 链接到 `~/.local/bin`；如果该目录不在 PATH 中，安装脚本会在 shell 配置里补一行。下载会核对 SHA-256，校验失败不改动已装版本；同名命令若不是 Hikaro 安装的，安装会拒绝覆盖。

升级：`hikaro update` 或 `hk update`，重新运行最新安装脚本。新版本原子切换，保留上一个版本供回退，更早的版本删除。数据目录 `~/.hikaro` 不在安装目录内，升级不动数据。已在运行的 hikaro 进程继续使用旧版本，重启后生效。

可选环境变量：`HIKARO_INSTALL_DIR`、`HIKARO_BIN_DIR`、`HIKARO_NO_MODIFY_PATH=1`、`HIKARO_DOWNLOAD_BASE`（镜像地址）。

### 发版（维护者）

1.
2. 写 `docs/releases/vX.Y.Z.md`，第一行 `# 标题` 作为 Release 标题，其余为发版说明。
3. 提交并推送 `main`，再推送 `vX.Y.Z` 标签。`.github/workflows/release.yml` 在 macOS arm64 上打 CLI 包并实际安装一遍，成功后创建 Release 并上传 CLI 附件。

换密钥会导致已安装的 App 无法覆盖更新。

下文为源码安装与 npm tarball 候选流程。

## 安装

在所选版本的源码目录运行：

```sh
pnpm install --frozen-lockfile --filter hikaro
pnpm build
pnpm start --demo
```

不要单独拷贝 `dist/hikaro.mjs`：运行还依赖同目录生成的 chunks、worker、原生助手及安装后的外部依赖。不要跨平台或架构复制原生构建产物。

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

维护者运行 `pnpm release:pack`，从当前源码重新构建，生成 `artifacts/release/hikaro-0.1.0-darwin-arm64.tgz`、SHA-256 文件及 manifest。依赖仍需联网下载，这不是内含 Node 的单文件离线程序。候选保留 private=true 防止误发布到 registry；只允许当前已验证的 darwin-arm64 构建目标。

用户在自己的安装目录安装：

```sh
shasum -a 256 -c hikaro-0.1.0-darwin-arm64.tgz.sha256
npm install --engine-strict --prefix "$HOME/.local/share/hikaro-app" ./hikaro-0.1.0-darwin-arm64.tgz
"$HOME/.local/share/hikaro-app/node_modules/.bin/hikaro" --demo
```

需要 Node 26.12.1+ 和 npm、rg；最低版本验收使用 Node 26.12.1。若 npm 提示安装脚本审批，检查并按其提示批准需要的原生依赖脚本。未覆盖的 Node 版本、无开发工具的全新机器、Gatekeeper 隔离属性及签名/公证尚需验收。SHA-256 用于检测内容变化，不提供发布者身份认证；只使用可信渠道获得的包与校验值。

运行 `pnpm check:release artifacts/release/hikaro-0.1.0-darwin-arm64.tgz` 验收实际 tarball：独立安装前缀、空 npm 缓存、校验和、实际 bin 离线任务、已打包原生 helper 读取、由安装目录自己的 node-pty 启动 TUI 并正常退出。另验证立即 Ctrl+D 的多行草稿保存/重开，以及 SIGKILL host 后补充指令经原身份确认才在下一轮生效，未确认项保留。输出同名 `.validation.json`；应用及依赖全部来自安装包，源码 SharedHostClient 仅作为观察传输，通过现有 tsx 运行。不接触用户 home。构建或 README 改变后需重新打包并验收对应 SHA，旧验证不能覆盖新包。

升级先停止所有写入者并备份数据，再将新包安装到另一个目录验证；回退切回保留的旧安装目录并恢复升级前数据备份。删除安装目录不会自动删除用户数据；切勿将数据 home 放在安装目录内。

## 候选包安全检查

`pnpm audit:release ARTIFACT.tgz` 检查包内生产锁及实际捆绑的 node-forge Node 实现，结果绑定 SHA；`release:pack` 在打包前和打包后均执行检查。无法取得有效审计结果、high/critical 公告或发行文件哈希不符都会阻断，没有安全回补或公告放行例外。

node-forge 固定为官方 `1.4.2`，源码安装与 npm 候选包使用同一版本。原 `1.4.0` 回补及 `patches/` 已退役。官方 npm tarball 先核验 SHA-512，再记录 [发行文件证明](../scripts/security/node-forge-1.4.2.json)：49 个 Node 源文件、package.json、README 和许可证全部逐项校验。生产锁必须指向同一官方 tarball 和 integrity；额外副本、重复归档项、缺失或改写文件均会阻断。TUI 发行包只裁剪不用的 `dist/` 和 `flash/`，不修改 Node 源码，也不在 postinstall 打补丁。

安装验收从 sandbox-runtime 的实际依赖位置解析 forge，重复完整性校验；运行 8 组正常/额外嵌套字段签名回归、3 类非规范 DER 拒绝测试和 PEM Buffer 输入兼容测试。见 [官方版本迁移验收](validation/forge-official-20261030.md)。
