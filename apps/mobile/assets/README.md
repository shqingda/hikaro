# 应用图标

`icon.png` 来自 [`brand/explorations/2026-10-horizon/app-icon.svg`](../../../brand/explorations/2026-10-horizon/app-icon.svg)：非字母的地平线图案、太阳圆点，沿用墨黑 `#12120F`、纸白 `#F7F7F6`、黄色 `#F2B500`。

原 SVG 按 1024 × 1024 输出，并以墨黑铺满透明区域、移除 alpha 通道。保留全尺寸方形背景，由系统裁切圆角；不把 SVG 中的圆角和外部留白作为原生图标的边界。

图标由 `app.json` 的 `expo.icon` 引用。更换后需要同步原生工程并重新安装开发构建，Metro 热更新不会更新系统图标；步骤见 [移动端指南](../../../docs/mobile.md)。
