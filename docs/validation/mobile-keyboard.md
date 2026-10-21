# 移动端原生回车验收

2026-10-21，基线 4378c46；iPhone 18 Pro / iOS 27 模拟器，经 Codex 内置浏览器连接 serve-sim 0.1.48。隔离 host 使用 demo/offline，没有调用真实模型。

## 问题与修改

Expo UI 58.0.20 的 universal TextInput 在 iOS 包装 SwiftUI TextField。原组件接收普通字符，但 Return 没有保留换行，随后字符未进入草稿，前一个字符还出现回退。任务输入框及 steering 编辑框改用 React Native 原生多行 TextInput，明确 submitBehavior="newline"，直接使用 controller 的受控文本；发送和保存仍由独立按钮执行。

## 通过的检查

- 逐键验收 Return、后续字符、BackSpace；独立读取手机 SQLite，换行与草稿一致。
- Return 不发送；点击发送前 host 只有初始用户消息，点击后恰好新增一条 `probe\n2x4\n6`，与本机草稿逐字相同。
- steering 原生输入 `s`、Return、`7`，点击保存后重开仍为两行。
- mobile typecheck、iOS/Android Hermes export、既有 composer/steering 两个测试文件共 12 项通过。

![队列编辑框中的原生换行](../design/mobile-keyboard-newline.png)

## 仍需验收

软件键盘、中文候选输入、Android 与真机没有在本轮验收。快速连续桥接按键曾得到与预期不符的结果，尚未区分桥接事件顺序与应用问题；逐键落盘核对通过不替代高速输入验收。完整键盘门槛保持未完成。结构化记录见 [mobile-keyboard.json](mobile-keyboard.json)。
