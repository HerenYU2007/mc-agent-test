# NMO Bot 遥测

这个数据包适用于 Minecraft Java 26.1，默认监测 `NMO-TestAgent`。安装到新世界后，执行 `reload` 即可加载。

```powershell
.\scripts\Install-NmoTelemetry.ps1
```

观察者在游戏内输入 `/function nmo_telemetry:status`，会在聊天框收到一条快照。快照包含在线状态、坐标、血量、饥饿、手持物、背包里的重点物资，以及钻石、铁、煤、青金石各自的原版挖掘计数。普通矿石和深层矿石分别计数。服务器控制台可以执行以下两条命令读取相同信息。

```mcfunction
function nmo_telemetry:refresh
data get storage nmo_telemetry:state snapshot
```

原版计数从安装后开始累积，重载数据包会保留计数。采样只在查询时执行。Bot 离线时返回 `online:0b`。如果 Bot 改名，需要更新 `refresh.mcfunction` 的选择器和离线名称，再重新安装并重载。

模型指令、路径和 Token 用量由 Agent 记录。终端排查时，从项目目录运行精简查询。默认只输出一行 JSON，`-Events` 可选最近 1 至 5 条筛选后的事件，`-Usage` 可选当前 Agent 进程的 Token 用量。

```powershell
.\scripts\Get-NmoTelemetry.ps1
.\scripts\Get-NmoTelemetry.ps1 -Events 2 -Usage
```

核对采矿时，先读脚本的 `mine.requested`、`mine.target` 和 `mine.actual`，然后用数据包核对矿石实际挖掘计数的增量。`path-clearance` 表示执行器在清理挡路方块。

面板的 DeepSeek 开关需要单独打开。暂停 Bot 时，Agent 同时关闭 DeepSeek 并取消本地正在等待的请求。面板仍可在 Bot 断线后查询。CLI 实测可以通过 `DEEPSEEK_AUTO_START=1` 显式启用模型。
