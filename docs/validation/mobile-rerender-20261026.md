# 移动端联动刷新 · 2026-10-26

## 问题

`useMobile()` 让组件订阅整个 `MobileState`。流式输出时控制器每 16 ms 合并一次更新，只替换 `stream` 字段，但所有订阅者都会重渲染：任务页整页、内联 `renderItem` 导致的全部可见消息行、编辑器、操作栏，以及页面栈里未卸载的首页和任务列表。

## 修改

- `src/selection.ts`：`selectionSnapshot` 在所选字段引用都未变化时返回上一次的结果，`useSyncExternalStore` 因此不触发重渲染。复用控制器已有的 16 ms 合并与字段级替换，没有新增状态框架。
- `useMobileSelector(select)`：组件只订阅用到的字段。编辑器、操作栏、任务页、任务列表、首页改用它。
- 任务页：流式文本拆为 `StreamPreview`，只有它订阅 `stream`；消息行改为 `memo` 的 `MessageRow`，`renderItem` 用 `useCallback`，只依赖在线状态、内容加载和图片能力。FlatList 虚拟列表与分页保持不变。

流式期间每次更新只重渲染 `StreamPreview`；编辑器输入不再随流式输出刷新，消息行只在联网、加载或图片能力变化时刷新。

## 验证

`tests/mobile-selection.test.ts` 2 项先因模块缺失失败后通过；移动端 14 个测试文件 102 项通过；移动端类型检查通过；`expo export` iOS/Android 双平台 Hermes 导出成功。

未在模拟器或真机上测渲染次数和帧率；未改其余较少刷新的页面（搜索、计划、后台、步骤等仍用 `useMobile`）。
