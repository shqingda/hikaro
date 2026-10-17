# 双端交互草案

2026-10-18。本目录是无构建、无生产连接的 HTML/CSS/JavaScript 设计评审件。完整产品/协议/安全/性能/分期方案见 [client-reboot.md](../../client-reboot.md)。

## 打开

从仓库根目录运行：

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 <http://127.0.0.1:4173/docs/design/client-reboot/>，也可直接打开 `index.html`。不需要 npm 安装、CDN 或在线字体。

## 可以评审的交互

- 桌面、手机、连接方式三种视图；桌面会话/变更/设备；手机会话/待确认/设备。
- 允许一次/拒绝共用本地状态；模拟断线后禁用授权和发送，输入草稿保留。
- 深浅外观、⌘/Ctrl+K 命令菜单、Escape 关闭、配对流程说明、示例设备撤销。
- 桌面和手机输入只追加/显示模拟消息，不调用模型。重置恢复运行状态并保留输入草稿。
- 原方案与光学修订候选并列，原 `brand/identity` 不变。

模型选择只是本地表单示意；两条非当前会话点击后说明评审范围；“新建”定位到示例输入框。未实现真实会话创建、跨页面保存、host 连接、文件修改、系统权限、手势物理和推送。所有示例 code/diff/检查结果均不能作为真实实现证据。

## 设计决策

颜色使用用户确认的 Beam `#F2B500`、Ink `#12120F`、Paper `#F7F7F6`；辅助分隔 `#DFDFD8`、正文次级 `#66675F`。品牌使用沿用的 Literata 轮廓，产品正文用系统字体。黄色集中于当前决定，桌面三列为工作区/任务/证据，手机为单任务聚焦。

初稿截图显示授权按钮落到可视区下方，因此折叠默认文件活动、保留关键访问范围、扩大手机稿的有效画面。最终检查要求桌面与手机默认授权按钮无需滚动可见。深色稿发现 h 轮廓融入背景，改为真正的 paper 轮廓 SVG；不再用滤镜反转品牌颜色。

这是布局和状态交互草案，无手势驱动动画、无空闲 rAF。按下反馈及时，默认按钮焦点可见，减弱动态移除 transition；真机 Dynamic Type/VoiceOver/TalkBack 与复杂 IME 不由浏览器截图代替。

## 本轮浏览器检查

使用已有 Playwright 依赖和已安装 Chrome，隔离临时浏览器 profile。最初缺少 Playwright 配套 Chromium executable，未下载浏览器或改项目依赖，改用 `channel: 'chrome'` 后完成检查。

```sh
node docs/design/client-reboot/review.mjs
```

可用 `HIKARO_DRAFT_URL` 指定同一草案的本地地址。此脚本只检查草案，不加入核心测试或触发真实命令。运行环境：macOS arm64、Node 26.12.0、Chrome 155.0.8059.85。结构化结果见 [review.json](review.json)。

已通过：

- 390 / 600 / 768 / 1024 / 1440px × 三种视图，文档没有横向溢出。
- 断线禁用发送与授权，中文/emoji 草稿不丢；重连后一次允许在两种模拟客户端收敛。
- 手机导航、补充输入、拒绝状态；桌面 diff / 设备 / 配对流程。
- ⌘/Ctrl+K 命令菜单、Escape 关闭；所有按钮有文字或 accessible name。
- 减弱动态去掉 transition；桌面、宽屏手机、390px 窄屏手机首屏授权按钮可见。
- 浏览器 console/page error 为零；已实际查看桌面、手机、窄屏手机、深色截图。

截图： [desktop.png](desktop.png)、[desktop-dark.png](desktop-dark.png)、[mobile.png](mobile.png)、[mobile-narrow.png](mobile-narrow.png)、[architecture.png](architecture.png)、[overview.png](overview.png)。截图中的草稿可能包含验证时输入的示例文本。

未声称通过：真实原生客户端、权限加密、生产模型、原生读屏/IME、性能 p95/内存/能耗、16px 最终品牌适配。本次没有运行核心全量测试或性能基准。
