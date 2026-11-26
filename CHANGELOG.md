# Changelog

## 1.4.0 · 2026-11-26

You can now continue the same work on your phone and desktop, ask Asterhelm to follow up on a schedule or an event, and check the coordinator’s token usage. When Asterhelm finds unfinished work in a session you chose to follow, it can check the evidence once and ask whether to take it on.

### 新功能

- **在原会话接续工作。** 手机上的要求变更和其他 Agent 的进展可以汇总到已关联的 Codex 桌面会话。启用回执连接器后，桌面只确认收悉，等你说“继续”再执行。桌面的后续结果会回到手机主聊天，各端沿用同一工作编号。
- **中途调整分工。** 在主聊天说“暂停电子版，纸本继续”，星舵会更新原工作的验收条件。任务卡区分“已请求停止”和“执行端已确认”，最终交付按最新要求核对。
- **主动发现，由你立项。** 已授权关注的会话出现可核对的缺项时，星舵可让来源设备的 Agent 做一次隔离只读查证，在主聊天提供依据。你可以忽略、要求再查一次，或同意建立或关联正式工作。
- **按时、按事件或持续跟进。** 可以按本地时区登记日历规则，或在任务完成、失败、Agent 上线及关联会话更新时触发。持续工作会根据新回执提前复查，证据无变化时逐步延长间隔。规则和触发记录持久保存，重启后可补读任务回执并去重。
- **查看总控 Token 用量。** 在看板展开“Token 用量”，或直接问“星舵今天用了多少 token？”。可查看今日及累计输入、输出和合计，以及对话规划、交付汇总、工作唤醒和定时复查的用量。统计从升级启用时开始，缺报会明确标出。查询账本本身不消耗 token。

### 从 v1.3.0 升级

先备份个人服务和任务队列的 SQLite 数据库，再更新总控和 Worker。新版 Worker 会登记隔离只读能力。已有配对、聊天记录及原提醒的触发次数会保留。Android 用户请用原服务地址和同一签名重新构建、覆盖安装客户端。本次发布提供源码归档。[自托管指南](https://github.com/whw2808/asterhelm/blob/v1.4.0/docs/self-hosting.md) · [Android 构建指南](https://github.com/whw2808/asterhelm/blob/v1.4.0/android/README.md)

[项目主页与功能演示](https://whw2808.github.io/asterhelm/) · [v1.3.0 至 v1.4.0 的完整变更](https://github.com/whw2808/asterhelm/compare/v1.3.0...v1.4.0)

## 1.3.0 · 2026-11-24

First public source release of Asterhelm.

- Register devices and agent capabilities at runtime. Route tasks to registered workers and follow assignment, elapsed time and results in the conversation.
- Keep preferences, unfinished work and opt-in Codex Desktop session context available to the coordinator.
- Use the shared chat and device dashboard from a browser or a paired Android client. Android can surface reminders through its foreground connection.
- Bootstrap a local hub and worker, enroll a remote worker using mutual TLS, and test the queue with an offline byte-counting worker.
- Build the Android client for your own HTTPS origin. The repository includes a standalone project showcase with fictional examples.
