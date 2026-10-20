# Steering 队列管理

`/tasks` 增加 Steering messages 类别，显示尚未被模型轮次消费的补充要求。支持稳定 ID、全文阅读、编辑、提前及确认移除。管理器打开期间不消费 steering，正在进行的模型请求/工具继续；若当前轮已结束且仍有 steering，则等待管理器关闭再开始下一轮。取消运行会中止等待并清空队列；撤销来源身份清除其 steering。

沿用附着会话控制权限，过期 ID 明确报错。普通与附着共用面板。不改变待发 prompt 与 steering 的语义：steering 属于模型下一轮上下文，不是新任务。该队列仍在内存中，host 重启会丢失，界面明确提示；持久化另列待办。

验证：steering-queue 核心测试、execution-panel、attached-workflows 定向测试；唯一 steering-queue-pty 覆盖附着终端编辑/提前/移除与实际模型接收顺序；类型检查及构建。
