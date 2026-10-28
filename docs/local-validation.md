# 本地预检与发版边界

2026-10-28 确认：日常开发、预构建及 Android 真机测试在本地完成。所有 GitHub Actions（包括自动测试）仅在用户明确确定发版时使用；普通 push、PR 与工作流文件改动不再触发运行。

## 命令

- `pnpm ci:check`：依次执行根目录 `pnpm check`（类型检查、CLI 构建、Vitest 与 scripts 测试）、移动端类型检查、relay 类型检查和 relay 本地 dry-run 构建。任何失败立即停止，不部署或发布。
- `pnpm build:android:release`：完整预检通过后运行本地签名 APK 构建。产物为 `artifacts/release/android/hikaro-release.apk`。由用户安装后再开展真机验收。
- `pnpm release:pack`：完整预检、macOS arm64 候选打包与审计、隔离安装和已有恢复检查。
- `pnpm release:cli`：同上，再复用已检查的候选生成独立 CLI 分发包；命令本身不发布。

底层 `scripts/build-android.sh` 和打包脚本供已完成同一源码预检的编排流程调用。正常交付使用上述公开入口；不要为了绕过失败而直接运行底层脚本。普通 `pnpm build` 保持快速编译功能，供 `pnpm check` 内部调用，避免循环预检。

## Actions

`checks` 和 `release candidate` 只保留手动触发，用于已确定的发版检查；正式 `release` 仍由明确推送的 `v*` tag 触发。release CLI job 调用公共预检，Android job 等待该 job 成功再构建同一 SHA，避免重复完整预检。未经用户明确发版指令，不触发手动工作流、不创建或推送发布 tag、不发布 Release。

## 证据范围

本地检查复用 CI 的检查内容，不模拟 GitHub runner 的操作系统。macOS 上通过不等于 Linux 原生行为已验证；原有 Linux 检查在发版时仍运行。原生界面、Android 中文 IME、真实 relay、真实模型账号与安装升级回退需要单独验收。长时间性能基准不在每次预检重复运行，有相关改动或退化证据时才重测。

每个交付包记录源码 SHA、未提交改动、SHA-256、预检结果与待测事项。源码未变且已有完整通过记录时，同一轮编排可直接继续底层打包，不重复检查；修改源码后重新验证受影响项并在下一次交付前完成完整预检。
