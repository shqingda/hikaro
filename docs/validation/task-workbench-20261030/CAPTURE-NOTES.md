这些材料记录改造期间的验证结果：24 个真实 PTY 捕获和 90 个生产组件场景。仓库仅保留 8 张代表图及对应文本，完整检查结果分别见 `pty/checks.json`、`pty/records.json` 和 `matrix/checks.json`。

图片捕获于最终提交 `90489d8` 之前。失焦输入区的假光标和中性凭证说明的红色样式随后已修复；代表图未为这两项纯外观修正重新录制。组件图明确标为 `COMPONENT FIXTURE`，不等同于真实终端截图；PTY 使用文本注入，不能证明原生中文 IME 候选窗口位置。

复现脚本：构建后运行 `node docs/validation/task-workbench-20261030/capture.mjs`；组件场景使用 `node --import tsx docs/validation/task-workbench-20261030/matrix.mts`；安装 pyte 和 Pillow 后运行 `render-pty.py` 渲染。复现会重新生成全部中间文件，交付只保留上述代表素材与摘要。

精简记录：保留复现脚本与全部检查摘要；从本次脚本生成物中移除其余 PNG、文本、ANSI 和含完整帧数据的 JSON。没有改动产品代码、手写说明或历史验证目录，没有重跑矩阵。
