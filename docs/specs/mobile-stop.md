# 移动端按运行停止

## 契约

新增 RPC `run.cancel`，必填 `sessionId` 与 `runId`，均为有界非空 ID。通过 hello.methods 协商；保留既有 `cancel` 语义，移动端不向旧 host 降级发送 `cancel`。

host 检查当前配对、当前任务控制权与选择归属，持久认领命令后再次核对选择、权限、busy、running 和运行 ID。核对当前运行与调用 cancel 之间不得出现 await。只取消目标任务的 agent（含该任务待发队列），不取消该控制端在其他任务上的工作。返回 `{accepted:true,runId}`，并把运行 ID 写入完成回执；这证明停止请求已处理，不代表进程已经退出或副作用已回滚。

手机先用系统确认框提示影响，确认时沿用打开框时捕获的任务/运行 ID；controller 和 host 均拒绝过期目标。等待响应时禁用重复操作。运行状态只由 host 的快照/事件改变，不能收到回执就显示“已停止”。断线、切后台、重启后仅查询原命令回执，不自动重发。

## 本轮计划与验证

- 修改 protocol、RPC control 通道、client-core 能力查询、mobile controller 和原生确认入口。
- `tests/rpc-control.test.ts`：持久认领期间目标换轮，旧停止不得作用于新运行；错任务、已结束拒绝；正确停止保留 runId 回执。
- `tests/mobile-controller.test.ts`：控制权、旧 host、确认目标过期、重复操作与真实 host 的取消终态/丢失回执恢复。作为本轮唯一受影响集成脚本，不运行其他 E2E。
- 受影响定向测试、根目录/移动类型检查、CLI 构建和移动双平台 JS 导出。原生点击、真实 relay、真机生命周期另记证据，不由 fixture 替代。
