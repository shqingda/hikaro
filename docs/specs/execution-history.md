# 最近执行历史首切片

普通及附着 `/tasks` 增加 Execution history。查询当前会话最近 200 条 run.start/run.end 事件，聚合最多 100 次运行，按最新事件排序。展示运行 ID、已记录状态、开始/结束时间、provider/model 或手动操作类型、错误及用量；不把事件窗口之外的内容冒充完整历史。

缺少 run.end 显示 unknown / no recorded end，不能凭此认定仍在运行或已经取消。详情明确为只读，无重放、恢复执行或停止按钮。输出正文继续从会话记录阅读。使用持久 SQLite 事件，host 重启后仍可查询，按当前会话授权读取。

本轮不实现无限历史搜索、每个 shell/子任务的完整历史索引或历史操作重试。验证采用 execution-history 存储/聚合测试、execution-panel 与 attached-workflows 定向测试，一个真实 host 重启/附着 PTY 历史阅读脚本，类型检查及构建。
